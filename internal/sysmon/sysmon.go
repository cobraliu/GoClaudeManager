// Package sysmon is a dependency-free, read-only "top-like" system sampler for
// the admin monitoring panel. It reads /proc directly (Linux) — no gopsutil or
// cgo — mirroring the /proc access already done in internal/claudestat.
//
// CPU usage (overall and per-process) is a RATE: it needs two /proc reads
// spaced in time, then a delta. Rather than double-sampling on every HTTP
// request (per-request sleep latency; concurrent admin pollers corrupting each
// other's baseline), a single background goroutine owns the previous snapshot,
// recomputes deltas on a fixed ~2s cadence, and atomically publishes an
// immutable Sample. The HTTP handler returns the cached Sample instantly. This
// mirrors status.Manager.Run.
package sysmon

import (
	"context"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ── Public JSON shapes ─────────────────────────────────────────────────────

// ProcInfo is one process row. CPUPercent uses the per-core scale (top's
// default): 100 == one full core, so an 8-core box can show up to 800.
type ProcInfo struct {
	PID        int     `json:"pid"`
	Comm       string  `json:"comm"`
	Cmdline    string  `json:"cmdline"` // full argv, space-joined; "[comm]" for kernel threads
	CPUPercent float64 `json:"cpu_percent"`
	MemPercent float64 `json:"mem_percent"`
	RSSBytes   uint64  `json:"rss_bytes"`
}

// Overall is the machine-wide summary. CPUPercent here is whole-machine 0..100
// (idle-based), distinct from the per-core ProcInfo scale.
type Overall struct {
	CPUPercent float64 `json:"cpu_percent"`
	MemTotal   uint64  `json:"mem_total"`
	MemUsed    uint64  `json:"mem_used"`
	MemPercent float64 `json:"mem_percent"`
	Load1      float64 `json:"load1"`
	Load5      float64 `json:"load5"`
	Load15     float64 `json:"load15"`
	NumCPU     int     `json:"num_cpu"`
}

// Sample is one published snapshot. Ready is false on the very first tick
// (mem/load are valid but CPU% needs a second sample to have a delta).
type Sample struct {
	Overall   Overall    `json:"overall"`
	Processes []ProcInfo `json:"processes"`
	Timestamp time.Time  `json:"timestamp"`
	Ready     bool       `json:"ready"`
}

// ── Internal prev-state (never serialized) ─────────────────────────────────

// cpuTimes holds the aggregate /proc/stat counters. idle = idle + iowait;
// total = sum of all fields; busy = total - idle.
type cpuTimes struct {
	idle  uint64
	total uint64
}

// procTime is the per-pid carry between samples.
type procTime struct {
	utimeStime uint64 // /proc/<pid>/stat field 14 + 15, in clock ticks
	comm       string
	cmdline    string
	rssBytes   uint64
}

// pageSize is captured once; RSS in /proc/<pid>/stat is in pages.
var pageSize = uint64(os.Getpagesize())

// memSnap / loadSnap carry the last good mem and load readings so a transient
// /proc/meminfo or /proc/loadavg read failure doesn't blank the cards.
type memSnap struct {
	total, used uint64
	pct         float64
	ok          bool
}
type loadSnap struct {
	l1, l5, l15 float64
	ok          bool
}

// Sampler owns the previous snapshot and publishes the latest Sample.
type Sampler struct {
	mu     sync.RWMutex
	latest Sample

	// lastReqNano is the UnixNano of the most recent Latest() call (set by the
	// HTTP handler goroutine, read by Run) — drives lazy sampling.
	lastReqNano atomic.Int64

	// prev* and last* are touched only by the Run goroutine (no lock needed).
	prevCPU   cpuTimes
	prevProcs map[int]procTime
	havePrev  bool
	lastMem   memSnap
	lastLoad  loadSnap

	numCPU int
	period time.Duration
}

// NewSampler builds a Sampler with sane defaults (2s cadence).
func NewSampler() *Sampler {
	return &Sampler{
		prevProcs: map[int]procTime{},
		numCPU:    runtime.NumCPU(),
		period:    2 * time.Second,
	}
}

// Run samples /proc on a bounded cadence (≥500ms between starts) until ctx is
// cancelled. Mirrors status.Manager.Run.
func (s *Sampler) Run(ctx context.Context) {
	for {
		start := time.Now()
		s.refresh()
		wait := s.period - time.Since(start)
		if wait < 500*time.Millisecond {
			wait = 500 * time.Millisecond
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// Latest returns the most recent published Sample (or the zero Sample with
// Ready=false before the first tick completes). It also records the access
// time so the Run loop knows someone is watching (see idle()).
func (s *Sampler) Latest() Sample {
	s.lastReqNano.Store(time.Now().UnixNano())
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.latest
}

// idleAfter: if no Latest() call arrives within this window, Run stops walking
// /proc. The panel polls every ~2.5s, so this keeps the sampler warm while the
// Monitor tab is open and quiet (near-zero cost) otherwise.
const idleAfter = 12 * time.Second

// idle reports whether nobody has polled recently (never, or longer ago than
// idleAfter). The zero value (0) means "no request yet" → idle.
func (s *Sampler) idle() bool {
	last := s.lastReqNano.Load()
	return last == 0 || time.Since(time.Unix(0, last)) > idleAfter
}

func (s *Sampler) publish(sample Sample) {
	s.mu.Lock()
	s.latest = sample
	s.mu.Unlock()
}

// refresh reads /proc once and publishes a new Sample, computing CPU% deltas
// against the previous read. It builds a fresh Processes slice every tick and
// never mutates a published one, so concurrent Latest() readers are safe.
func (s *Sampler) refresh() {
	// Lazy: when nobody has polled recently, skip the /proc walk entirely. On
	// the transition into idle, drop the carried baseline and publish one
	// not-ready snapshot so a later reopen warms up cleanly instead of flashing
	// stale CPU numbers from before the gap.
	if s.idle() {
		if s.havePrev {
			s.havePrev = false
			s.prevProcs = nil
			s.publish(Sample{Overall: s.lastKnownBase(), Processes: []ProcInfo{}, Timestamp: time.Now(), Ready: false})
		}
		return
	}

	curCPU, cpuOK := readAggCPU()
	base := s.readMemLoad()

	// Transient /proc/stat read failure: once we have a baseline, keep serving
	// the last good Sample rather than regress the live panel to "warming up".
	// With no baseline yet, publish mem/load only (still not-ready).
	if !cpuOK {
		if s.havePrev {
			return
		}
		s.publish(Sample{Overall: base, Processes: []ProcInfo{}, Timestamp: time.Now(), Ready: false})
		return
	}

	curProcs := readAllProcs()

	// First good tick: store the baseline, no delta to report yet.
	if !s.havePrev {
		s.prevCPU = curCPU
		s.prevProcs = curProcs
		s.havePrev = true
		s.publish(Sample{Overall: base, Processes: []ProcInfo{}, Timestamp: time.Now(), Ready: false})
		return
	}

	dTotal := float64(curCPU.total - s.prevCPU.total)
	base.CPUPercent = overallCPUPercent(s.prevCPU, curCPU)

	procs := make([]ProcInfo, 0, len(curProcs))
	for pid, cur := range curProcs {
		cpu := 0.0
		if prev, ok := s.prevProcs[pid]; ok {
			// dProc>0 also guards against pid-reuse / counter rewind underflow
			// (cur < prev would wrap as unsigned).
			if cur.utimeStime > prev.utimeStime {
				cpu = procCPUPercent(cur.utimeStime-prev.utimeStime, dTotal, s.numCPU)
			}
		}
		procs = append(procs, ProcInfo{
			PID:        pid,
			Comm:       cur.comm,
			Cmdline:    cur.cmdline,
			CPUPercent: cpu,
			MemPercent: pct(cur.rssBytes, base.MemTotal),
			RSSBytes:   cur.rssBytes,
		})
	}
	// Store the full set sorted by CPU (a sensible default order). The HTTP
	// handler re-sorts by the requested key and truncates to the requested N,
	// so the published slice keeps every process for either ranking.
	sortProcs(procs, false)

	s.prevCPU = curCPU
	s.prevProcs = curProcs
	s.publish(Sample{Overall: base, Processes: procs, Timestamp: time.Now(), Ready: true})
}

// readMemLoad reads mem + load for this tick, carrying forward the last good
// values when a read fails (so a transient blip doesn't zero the cards). It
// updates the cached snapshots on every successful read.
func (s *Sampler) readMemLoad() Overall {
	o := Overall{NumCPU: s.numCPU}

	if memTotal, memAvail, ok := readMeminfo(); ok && memTotal > 0 {
		used := uint64(0)
		if memTotal > memAvail {
			used = memTotal - memAvail
		}
		o.MemTotal, o.MemUsed, o.MemPercent = memTotal, used, pct(used, memTotal)
		s.lastMem = memSnap{total: memTotal, used: used, pct: o.MemPercent, ok: true}
	} else if s.lastMem.ok {
		o.MemTotal, o.MemUsed, o.MemPercent = s.lastMem.total, s.lastMem.used, s.lastMem.pct
	}

	if l1, l5, l15, ok := readLoadavg(); ok {
		o.Load1, o.Load5, o.Load15 = l1, l5, l15
		s.lastLoad = loadSnap{l1: l1, l5: l5, l15: l15, ok: true}
	} else if s.lastLoad.ok {
		o.Load1, o.Load5, o.Load15 = s.lastLoad.l1, s.lastLoad.l5, s.lastLoad.l15
	}
	return o
}

// lastKnownBase builds an Overall from the cached mem/load snapshots (no /proc
// read), used to publish a clean not-ready snapshot when going idle.
func (s *Sampler) lastKnownBase() Overall {
	o := Overall{NumCPU: s.numCPU}
	if s.lastMem.ok {
		o.MemTotal, o.MemUsed, o.MemPercent = s.lastMem.total, s.lastMem.used, s.lastMem.pct
	}
	if s.lastLoad.ok {
		o.Load1, o.Load5, o.Load15 = s.lastLoad.l1, s.lastLoad.l5, s.lastLoad.l15
	}
	return o
}

// ── sorting / ranking ──────────────────────────────────────────────────────

// MaxTopN bounds the per-request process count, keeping the JSON payload sane
// even if a caller asks for an absurd limit.
const MaxTopN = 200

// sortProcs orders in place: by memory (RSS) when byMem, else by CPU; ties
// broken by the other metric so the order is stable and meaningful.
func sortProcs(procs []ProcInfo, byMem bool) {
	sort.Slice(procs, func(i, j int) bool {
		a, b := procs[i], procs[j]
		if byMem {
			if a.RSSBytes != b.RSSBytes {
				return a.RSSBytes > b.RSSBytes
			}
			return a.CPUPercent > b.CPUPercent
		}
		if a.CPUPercent != b.CPUPercent {
			return a.CPUPercent > b.CPUPercent
		}
		return a.RSSBytes > b.RSSBytes
	})
}

// Top returns a freshly-sorted, truncated copy of procs (never mutating the
// input — important because the caller passes the sampler's shared slice). The
// limit is clamped to [1, MaxTopN].
func Top(procs []ProcInfo, byMem bool, limit int) []ProcInfo {
	if limit < 1 {
		limit = 1
	}
	if limit > MaxTopN {
		limit = MaxTopN
	}
	out := make([]ProcInfo, len(procs))
	copy(out, procs)
	sortProcs(out, byMem)
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// ── CPU% math (pure, unit-tested) ──────────────────────────────────────────

// overallCPUPercent returns whole-machine busy% over the interval [prev, cur].
func overallCPUPercent(prev, cur cpuTimes) float64 {
	dTotal := float64(cur.total - prev.total)
	if dTotal <= 0 {
		return 0
	}
	dBusy := float64((cur.total - cur.idle) - (prev.total - prev.idle))
	return clamp(dBusy/dTotal*100, 0, 100)
}

// procCPUPercent returns a process's per-core CPU% given its jiffy delta, the
// machine's total jiffy delta over the same interval, and the core count.
// dProc and dTotal share the same USER_HZ jiffy unit, so the ratio is
// unit-free — no _SC_CLK_TCK constant is needed.
func procCPUPercent(dProc uint64, dTotal float64, numCPU int) float64 {
	if dTotal <= 0 {
		return 0
	}
	return clamp(float64(dProc)/dTotal*100*float64(numCPU), 0, 100*float64(numCPU))
}

func pct(part, whole uint64) float64 {
	if whole == 0 {
		return 0
	}
	return clamp(float64(part)/float64(whole)*100, 0, 100)
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ── /proc readers ──────────────────────────────────────────────────────────

// readAggCPU reads the aggregate "cpu " line of /proc/stat.
func readAggCPU() (cpuTimes, bool) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuTimes{}, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "cpu ") {
			return parseAggCPULine(line)
		}
	}
	return cpuTimes{}, false
}

// parseAggCPULine parses the aggregate cpu line. total is the sum of every
// numeric field present (tolerating kernels with fewer columns); idle is
// field 4 (idle) + field 5 (iowait).
func parseAggCPULine(line string) (cpuTimes, bool) {
	f := strings.Fields(line)
	if len(f) < 5 || f[0] != "cpu" {
		return cpuTimes{}, false
	}
	var total, idle uint64
	for i := 1; i < len(f); i++ {
		v, err := strconv.ParseUint(f[i], 10, 64)
		if err != nil {
			continue
		}
		total += v
		if i == 4 || i == 5 { // idle, iowait
			idle += v
		}
	}
	return cpuTimes{idle: idle, total: total}, true
}

// readMeminfo returns (total, available) in bytes. "used" is computed by the
// caller as total-available (MemAvailable is the kernel's accurate free
// estimate — more meaningful than MemFree which excludes reclaimable cache).
func readMeminfo() (total, available uint64, ok bool) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, false
	}
	return parseMeminfo(string(b))
}

func parseMeminfo(s string) (total, available uint64, ok bool) {
	var haveTotal, haveAvail bool
	for _, line := range strings.Split(s, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			total = kb * 1024
			haveTotal = true
		case "MemAvailable:":
			available = kb * 1024
			haveAvail = true
		}
		if haveTotal && haveAvail {
			break
		}
	}
	return total, available, haveTotal
}

// readLoadavg returns the 1/5/15-minute load averages; ok is false if the file
// can't be read or parsed.
func readLoadavg() (l1, l5, l15 float64, ok bool) {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, false
	}
	return parseLoadavg(string(b))
}

func parseLoadavg(s string) (l1, l5, l15 float64, ok bool) {
	f := strings.Fields(s)
	if len(f) < 3 {
		return 0, 0, 0, false
	}
	l1, e1 := strconv.ParseFloat(f[0], 64)
	l5, e2 := strconv.ParseFloat(f[1], 64)
	l15, e3 := strconv.ParseFloat(f[2], 64)
	if e1 != nil || e2 != nil || e3 != nil {
		return 0, 0, 0, false
	}
	return l1, l5, l15, true
}

// readAllProcs walks /proc and reads each numeric pid's stat + comm. Pids that
// vanish between readdir and read (normal churn) are silently skipped.
func readAllProcs() map[int]procTime {
	out := map[int]procTime{}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return out
	}
	for _, e := range entries {
		name := e.Name()
		if !isAllDigits(name) {
			continue
		}
		b, err := os.ReadFile("/proc/" + name + "/stat")
		if err != nil {
			continue
		}
		pid, utimeStime, rssPages, ok := parseProcStatLine(b)
		if !ok {
			continue
		}
		comm := readComm(name)
		if comm == "" {
			comm = commFromStat(b)
		}
		out[pid] = procTime{
			utimeStime: utimeStime,
			comm:       comm,
			cmdline:    readCmdline(name, comm),
			rssBytes:   rssPages * pageSize,
		}
	}
	return out
}

// readComm reads the clean process name from /proc/<pid>/comm.
func readComm(pidName string) string {
	b, err := os.ReadFile("/proc/" + pidName + "/comm")
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(b), "\n")
}

// cmdlineMaxLen caps the joined command line so a pathological argv can't bloat
// the JSON payload. 4 KiB is far more than any real command needs to be useful.
const cmdlineMaxLen = 4096

// readCmdline returns the full launch command from /proc/<pid>/cmdline. The
// file is NUL-separated argv; we join with spaces. Kernel threads (and zombies)
// have an empty cmdline — fall back to "[comm]" the way top does.
func readCmdline(pidName, comm string) string {
	b, err := os.ReadFile("/proc/" + pidName + "/cmdline")
	if err != nil {
		return bracket(comm)
	}
	return parseCmdline(b, comm)
}

func parseCmdline(b []byte, comm string) string {
	// Drop a trailing NUL (cmdline usually ends with one) before splitting.
	for len(b) > 0 && b[len(b)-1] == 0 {
		b = b[:len(b)-1]
	}
	if len(b) == 0 {
		return bracket(comm)
	}
	s := strings.ReplaceAll(string(b), "\x00", " ")
	s = strings.TrimSpace(s)
	if s == "" {
		return bracket(comm)
	}
	if len(s) > cmdlineMaxLen {
		s = s[:cmdlineMaxLen] + "…"
	}
	return s
}

func bracket(comm string) string {
	if comm == "" {
		return ""
	}
	return "[" + comm + "]"
}

// parseProcStatLine extracts pid, utime+stime (field 14+15) and rss pages
// (field 24) from a /proc/<pid>/stat line.
//
// Field 2 (comm) is paren-wrapped and may itself contain spaces and parens
// (e.g. "(my (weird) proc)"), so a naive Fields() split misaligns everything.
// We split on the FIRST '(' and LAST ')': the pid precedes the first '(', and
// the fields after the last ')' start at field 3 (state) at index 0.
func parseProcStatLine(b []byte) (pid int, utimeStime, rssPages uint64, ok bool) {
	s := string(b)
	open := strings.IndexByte(s, '(')
	closeP := strings.LastIndexByte(s, ')')
	if open < 0 || closeP < 0 || closeP < open {
		return 0, 0, 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(s[:open]))
	if err != nil {
		return 0, 0, 0, false
	}
	rest := strings.Fields(s[closeP+1:]) // rest[0] == field 3 (state)
	if len(rest) < 22 {
		return 0, 0, 0, false
	}
	ut, _ := strconv.ParseUint(rest[11], 10, 64)  // field 14 (utime)
	st, _ := strconv.ParseUint(rest[12], 10, 64)  // field 15 (stime)
	rp, _ := strconv.ParseUint(rest[21], 10, 64)  // field 24 (rss, pages)
	return pid, ut + st, rp, true
}

// commFromStat extracts the comm (between first '(' and last ')') as a fallback
// when /proc/<pid>/comm is unreadable.
func commFromStat(b []byte) string {
	s := string(b)
	open := strings.IndexByte(s, '(')
	closeP := strings.LastIndexByte(s, ')')
	if open < 0 || closeP < 0 || closeP <= open {
		return ""
	}
	return s[open+1 : closeP]
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
