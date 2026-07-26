// Package procmon samples the live process tree rooted at a session's Claude
// process (pane PID) — every descendant, including subagent-spawned children —
// reporting CPU%, memory, uptime, the full launch command, and (when stdout or
// stderr is redirected to a regular file) a tail of that log.
//
// It is deliberately decoupled from internal/sysmon: sysmon is a system-wide,
// lazy-idle sampler that is only warm while the admin monitor tab polls, and we
// would only filter its data down to one session's descendants anyway. procmon
// is on-demand (driven synchronously by the HTTP handler) and scoped to a
// single root PID.
//
// Cross-platform: process enumeration goes through gopsutil (Linux, macOS,
// Windows, BSD). CPU% is computed as a windowed delta of each process's
// cumulative CPU time across the ~3s gap between endpoint polls, so it reflects
// recent activity rather than a lifetime average. The redirected-stdout/stderr
// log tail is a Linux-only enhancement (it requires walking /proc/<pid>/fd);
// the process tree itself is reported on every platform.
package procmon

import (
	"runtime"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

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

// procData holds the per-pid fields captured for one process in the tree.
type procData struct {
	ppid       int
	cpuSeconds float64 // cumulative user+system CPU time, seconds
	rssBytes   uint64
	memPercent float64
	uptime     int64
	comm       string
	cmdline    string
}

type sessionPrev struct {
	at    time.Time
	procs map[int]float64 // pid -> cumulative CPU seconds at last sample
}

// Sampler keeps the previous CPU-time snapshot per session so CPU% can be
// computed as a delta across the gap between endpoint polls.
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
// number of log lines to return per redirected stream (clamped to [1,200]);
// log tails are only populated on Linux.
func (s *Sampler) Sample(sessionID string, rootPID, tailLines int) Snapshot {
	now := time.Now()
	root := rootPID
	snap := Snapshot{RootPID: &root, Processes: []ProcessInfo{}, Timestamp: now}

	if rootPID <= 0 {
		return snap
	}
	if tailLines < 1 {
		tailLines = 1
	} else if tailLines > 200 {
		tailLines = 200
	}

	byPID, children, ok := processTable()
	if !ok {
		return snap
	}
	if _, ok := byPID[rootPID]; !ok {
		// Root already gone — nothing to report, but still age out the cache.
		s.storePrev(sessionID, now, nil)
		return snap
	}
	pids := descendants(rootPID, children)
	nowMillis := now.UnixMilli()

	s.mu.Lock()
	prev := s.prev[sessionID]
	elapsed := 0.0
	if prev != nil {
		elapsed = now.Sub(prev.at).Seconds()
	}
	s.mu.Unlock()

	curCPU := make(map[int]float64, len(pids))
	for _, pid := range pids {
		p, ok := byPID[pid]
		if !ok {
			continue
		}
		d := readDetail(p, nowMillis)
		curCPU[pid] = d.cpuSeconds

		cpu := 0.0
		if prev != nil && elapsed > 0 {
			if pc, ok := prev.procs[pid]; ok && d.cpuSeconds > pc {
				cpu = cpuPercent(d.cpuSeconds-pc, elapsed, s.numCPU)
			}
		}

		info := ProcessInfo{
			PID:           pid,
			PPID:          d.ppid,
			Comm:          d.comm,
			Cmdline:       d.cmdline,
			CPUPercent:    cpu,
			MemPercent:    d.memPercent,
			RSSBytes:      d.rssBytes,
			UptimeSeconds: d.uptime,
			IsRoot:        pid == rootPID,
		}
		// Redirected-log tails come from /proc/<pid>/fd, which only exists on
		// Linux; other platforms report the tree without them.
		if runtime.GOOS == "linux" {
			attachLogs(&info, pid, tailLines)
		}
		snap.Processes = append(snap.Processes, info)
	}

	s.storePrev(sessionID, now, curCPU)
	return snap
}

// processTable enumerates every process via gopsutil and returns a pid→handle
// map plus the parent→children map. Only Ppid() is read here (one cheap call
// per process); the fuller per-process detail is fetched lazily in readDetail,
// so only the session's descendants pay that cost — not every process on the
// host. Returns ok=false if the process list can't be read at all.
func processTable() (map[int]*process.Process, map[int][]int, bool) {
	all, err := process.Processes()
	if err != nil {
		return nil, nil, false
	}
	byPID := make(map[int]*process.Process, len(all))
	children := map[int][]int{}
	for _, p := range all {
		ppid, err := p.Ppid()
		if err != nil {
			continue // process vanished mid-walk (normal churn)
		}
		pid := int(p.Pid)
		byPID[pid] = p
		children[int(ppid)] = append(children[int(ppid)], pid)
	}
	return byPID, children, true
}

// readDetail gathers the resource fields for a single process. Each accessor is
// best-effort: a process that exits between enumeration and here yields partial
// data rather than dropping the whole row.
func readDetail(p *process.Process, nowMillis int64) procData {
	var d procData
	if ppid, err := p.Ppid(); err == nil {
		d.ppid = int(ppid)
	}
	if t, err := p.Times(); err == nil {
		d.cpuSeconds = t.User + t.System
	}
	if m, err := p.MemoryInfo(); err == nil && m != nil {
		d.rssBytes = m.RSS
	}
	if mp, err := p.MemoryPercent(); err == nil {
		d.memPercent = float64(mp)
	}
	if ct, err := p.CreateTime(); err == nil && ct > 0 {
		if up := (nowMillis - ct) / 1000; up > 0 {
			d.uptime = up
		}
	}
	d.comm, _ = p.Name()
	// Cmdline is the full launch command; kernel threads / zombies have none,
	// so fall back to "[comm]" the way top does.
	if cmd, err := p.Cmdline(); err == nil && cmd != "" {
		d.cmdline = cmd
	} else {
		d.cmdline = bracket(d.comm)
	}
	if len(d.cmdline) > cmdlineMaxLen {
		d.cmdline = d.cmdline[:cmdlineMaxLen] + "…"
	}
	return d
}

// storePrev replaces the session's cached CPU-time snapshot and prunes stale
// entries (panels that have since closed).
func (s *Sampler) storePrev(sessionID string, now time.Time, cpu map[int]float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, p := range s.prev {
		if now.Sub(p.at) > prevTTL {
			delete(s.prev, id)
		}
	}
	if cpu != nil {
		s.prev[sessionID] = &sessionPrev{at: now, procs: cpu}
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

// cpuPercent converts a CPU-second delta over an elapsed wall-clock window to a
// per-core percentage (100 == one full core).
func cpuPercent(dCPUSeconds, elapsedSec float64, numCPU int) float64 {
	if elapsedSec <= 0 {
		return 0
	}
	return clamp(dCPUSeconds/elapsedSec*100, 0, 100*float64(numCPU))
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

func bracket(comm string) string {
	if comm == "" {
		return ""
	}
	return "[" + comm + "]"
}
