// Package procmon samples the live process tree rooted at a session's Claude
// process (pane PID) — every descendant, including subagent-spawned children —
// reporting CPU%, memory, uptime, the full launch command, and (when stdout or
// stderr is redirected to a regular file) a tail of that log.
//
// It is deliberately decoupled from internal/sysmon: sysmon is a system-wide,
// lazy-idle sampler that is only warm while the admin monitor tab polls, and we
// would only filter its data down to one session's descendants anyway. procmon
// is on-demand (driven synchronously by the HTTP handler) and scoped to a
// single root PID, so it owns its own /proc walk and CPU-delta bookkeeping.
//
// Linux-only: everything reads /proc. On other platforms Sample returns an
// empty snapshot.
package procmon

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// clkTck is the kernel's clock-tick rate (jiffies/second), i.e. _SC_CLK_TCK.
// 100 is the default on every mainstream Linux distro; reading it precisely
// would require cgo, which this project avoids.
const clkTck = 100

// pageSize is captured once; RSS in /proc/<pid>/stat is reported in pages.
var pageSize = uint64(os.Getpagesize())

// cmdlineMaxLen caps the joined command line so a pathological argv can't bloat
// the JSON payload.
const cmdlineMaxLen = 4096

// prevTTL bounds the per-session previous-sample cache: entries not refreshed
// within this window are pruned (the session's panel was closed).
const prevTTL = 30 * time.Second

// ProcessInfo is one process in the session's tree.
type ProcessInfo struct {
	PID           int      `json:"pid"`
	PPID          int      `json:"ppid"`
	Comm          string   `json:"comm"`
	Cmdline       string   `json:"cmdline"`
	CPUPercent    float64  `json:"cpu_percent"` // per-core scale (100 == one full core)
	MemPercent    float64  `json:"mem_percent"`
	RSSBytes      uint64   `json:"rss_bytes"`
	UptimeSeconds int64    `json:"uptime_seconds"`
	IsRoot        bool     `json:"is_root"`
	StdoutFile    string   `json:"stdout_file,omitempty"`
	StderrFile    string   `json:"stderr_file,omitempty"`
	StdoutTail    []string `json:"stdout_tail,omitempty"`
	StderrTail    []string `json:"stderr_tail,omitempty"` // empty when stderr == stdout
}

// Snapshot is the full response for one Sample call.
type Snapshot struct {
	RootPID   *int          `json:"root_pid"`
	Processes []ProcessInfo `json:"processes"` // never nil
	Timestamp time.Time     `json:"timestamp"`
}

// rawProc holds the per-PID fields captured in the single /proc walk.
type rawProc struct {
	pid        int
	ppid       int
	utimeStime uint64 // jiffies
	starttime  uint64 // jiffies since boot
	rssBytes   uint64
	comm       string
	cmdline    string
}

type sessionPrev struct {
	at    time.Time
	procs map[int]uint64 // pid -> utime+stime jiffies
}

// Sampler keeps the previous jiffy snapshot per session so CPU% can be computed
// as a delta across the ~3s gap between endpoint polls.
type Sampler struct {
	mu     sync.Mutex
	prev   map[string]*sessionPrev
	numCPU int
}

func NewSampler() *Sampler {
	return &Sampler{prev: map[string]*sessionPrev{}, numCPU: runtime.NumCPU()}
}

// Sample enumerates rootPID and all its descendants and returns their current
// resource usage. CPU% is 0 on the first call for a session (no prior sample to
// diff against) and meaningful from the second poll onward. tailLines is the
// number of log lines to return per redirected stream (clamped to [1,200]).
func (s *Sampler) Sample(sessionID string, rootPID, tailLines int) Snapshot {
	now := time.Now()
	root := rootPID
	snap := Snapshot{RootPID: &root, Processes: []ProcessInfo{}, Timestamp: now}

	if runtime.GOOS != "linux" || rootPID <= 0 {
		return snap
	}
	if tailLines < 1 {
		tailLines = 1
	} else if tailLines > 200 {
		tailLines = 200
	}

	procs, children := walkProc()
	if _, ok := procs[rootPID]; !ok {
		// Root already gone — nothing to report, but still age out the cache.
		s.storePrev(sessionID, now, nil)
		return snap
	}

	pids := descendants(rootPID, children)
	btime := readBtime()
	memTotal, _, _ := readMeminfo()

	s.mu.Lock()
	prev := s.prev[sessionID]
	curJiffies := make(map[int]uint64, len(pids))
	elapsed := 0.0
	if prev != nil {
		elapsed = now.Sub(prev.at).Seconds()
	}
	s.mu.Unlock()

	for _, pid := range pids {
		rp, ok := procs[pid]
		if !ok {
			continue
		}
		curJiffies[pid] = rp.utimeStime

		cpu := 0.0
		if prev != nil && elapsed > 0 {
			if pj, ok := prev.procs[pid]; ok && rp.utimeStime > pj {
				cpu = cpuPercent(rp.utimeStime-pj, elapsed, s.numCPU)
			}
		}

		info := ProcessInfo{
			PID:           pid,
			PPID:          rp.ppid,
			Comm:          rp.comm,
			Cmdline:       rp.cmdline,
			CPUPercent:    cpu,
			RSSBytes:      rp.rssBytes,
			UptimeSeconds: uptimeSeconds(rp.starttime, btime, now),
			IsRoot:        pid == rootPID,
		}
		if memTotal > 0 {
			info.MemPercent = pct(rp.rssBytes, memTotal)
		}
		attachLogs(&info, pid, tailLines)
		snap.Processes = append(snap.Processes, info)
	}

	s.storePrev(sessionID, now, curJiffies)
	return snap
}

// storePrev replaces the session's cached jiffy snapshot and prunes stale
// entries (panels that have since closed).
func (s *Sampler) storePrev(sessionID string, now time.Time, jiffies map[int]uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, p := range s.prev {
		if now.Sub(p.at) > prevTTL {
			delete(s.prev, id)
		}
	}
	if jiffies != nil {
		s.prev[sessionID] = &sessionPrev{at: now, procs: jiffies}
	}
}

// descendants returns rootPID plus every transitive child via BFS over the
// parent→children map.
func descendants(root int, children map[int][]int) []int {
	out := []int{root}
	queue := []int{root}
	seen := map[int]bool{root: true}
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		for _, c := range children[p] {
			if seen[c] {
				continue
			}
			seen[c] = true
			out = append(out, c)
			queue = append(queue, c)
		}
	}
	return out
}

// walkProc does one /proc readdir pass, parsing each numeric pid's stat (for
// ppid, cpu jiffies, starttime, rss) and reading comm + cmdline. It returns the
// per-pid data and the parent→children map. Pids that vanish mid-walk (normal
// churn) are skipped.
func walkProc() (map[int]rawProc, map[int][]int) {
	procs := map[int]rawProc{}
	children := map[int][]int{}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return procs, children
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
		pid, ppid, utimeStime, starttime, rssPages, ok := parseStat(b)
		if !ok {
			continue
		}
		comm := readComm(name)
		if comm == "" {
			comm = commFromStat(b)
		}
		procs[pid] = rawProc{
			pid:        pid,
			ppid:       ppid,
			utimeStime: utimeStime,
			starttime:  starttime,
			rssBytes:   rssPages * pageSize,
			comm:       comm,
			cmdline:    readCmdline(name, comm),
		}
		children[ppid] = append(children[ppid], pid)
	}
	return procs, children
}

// parseStat extracts pid, ppid, utime+stime, starttime and rss pages from a
// /proc/<pid>/stat line. Field 2 (comm) is paren-wrapped and may itself contain
// spaces and parens, so we split on the FIRST '(' (pid precedes it) and the
// LAST ')' (fields after it start at field 3 / state at rest[0]); thus field N
// is rest[N-3]: ppid=rest[1], utime=rest[11], stime=rest[12],
// starttime=rest[19], rss=rest[21].
func parseStat(b []byte) (pid, ppid int, utimeStime, starttime, rssPages uint64, ok bool) {
	s := string(b)
	open := strings.IndexByte(s, '(')
	closeP := strings.LastIndexByte(s, ')')
	if open < 0 || closeP < 0 || closeP < open {
		return 0, 0, 0, 0, 0, false
	}
	p, err := strconv.Atoi(strings.TrimSpace(s[:open]))
	if err != nil {
		return 0, 0, 0, 0, 0, false
	}
	rest := strings.Fields(s[closeP+1:]) // rest[0] == field 3 (state)
	if len(rest) < 22 {
		return 0, 0, 0, 0, 0, false
	}
	pp, _ := strconv.Atoi(rest[1])                  // field 4 (ppid)
	ut, _ := strconv.ParseUint(rest[11], 10, 64)    // field 14 (utime)
	st, _ := strconv.ParseUint(rest[12], 10, 64)    // field 15 (stime)
	start, _ := strconv.ParseUint(rest[19], 10, 64) // field 22 (starttime)
	rp, _ := strconv.ParseUint(rest[21], 10, 64)    // field 24 (rss, pages)
	return p, pp, ut + st, start, rp, true
}

// cpuPercent converts a jiffy delta over an elapsed wall-clock window to a
// per-core percentage (100 == one full core).
func cpuPercent(dJiffies uint64, elapsedSec float64, numCPU int) float64 {
	if elapsedSec <= 0 {
		return 0
	}
	cpuSec := float64(dJiffies) / clkTck
	return clamp(cpuSec/elapsedSec*100, 0, 100*float64(numCPU))
}

// uptimeSeconds derives a process's age from its starttime (jiffies since boot)
// and the system boot time (epoch seconds).
func uptimeSeconds(starttime, btime uint64, now time.Time) int64 {
	if btime == 0 {
		return 0
	}
	startEpoch := int64(btime) + int64(starttime/clkTck)
	up := now.Unix() - startEpoch
	if up < 0 {
		return 0
	}
	return up
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

func pct(part, whole uint64) float64 {
	if whole == 0 {
		return 0
	}
	return float64(part) / float64(whole) * 100
}

// readBtime reads the system boot time (epoch seconds) from /proc/stat's
// "btime" line; 0 if unavailable.
func readBtime() uint64 {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "btime ") {
			v, _ := strconv.ParseUint(strings.TrimSpace(line[len("btime "):]), 10, 64)
			return v
		}
	}
	return 0
}

func readMeminfo() (total, available uint64, ok bool) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, false
	}
	var haveTotal, haveAvail bool
	for _, line := range strings.Split(string(b), "\n") {
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

func readComm(pidName string) string {
	b, err := os.ReadFile("/proc/" + pidName + "/comm")
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(b), "\n")
}

func commFromStat(b []byte) string {
	s := string(b)
	open := strings.IndexByte(s, '(')
	closeP := strings.LastIndexByte(s, ')')
	if open < 0 || closeP < 0 || closeP < open {
		return ""
	}
	return s[open+1 : closeP]
}

// readCmdline returns the full launch command from /proc/<pid>/cmdline (NUL
// separated argv joined with spaces). Kernel threads / zombies have an empty
// cmdline — fall back to "[comm]" the way top does.
func readCmdline(pidName, comm string) string {
	b, err := os.ReadFile("/proc/" + pidName + "/cmdline")
	if err != nil {
		return bracket(comm)
	}
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
