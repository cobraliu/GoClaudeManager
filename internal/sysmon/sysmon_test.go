package sysmon

import "testing"

func TestParseProcStatLine(t *testing.T) {
	tests := []struct {
		name           string
		line           string
		wantPID        int
		wantUtimeStime uint64
		wantRSSPages   uint64
		wantOK         bool
	}{
		{
			// Fields after comm: state=S(3) ... utime(14) stime(15) ... rss(24).
			// We build a line with index 0=state and put 100 at field14, 50 at
			// field15, 2048 at field24.
			name:           "simple bash",
			line:           buildStat(1234, "bash"),
			wantPID:        1234,
			wantUtimeStime: 150,
			wantRSSPages:   2048,
			wantOK:         true,
		},
		{
			name:           "comm with spaces and nested parens",
			line:           buildStat(4321, "my (weird) proc"),
			wantPID:        4321,
			wantUtimeStime: 150,
			wantRSSPages:   2048,
			wantOK:         true,
		},
		{
			name:           "comm with spaces",
			line:           buildStat(7, "a b c"),
			wantPID:        7,
			wantUtimeStime: 150,
			wantRSSPages:   2048,
			wantOK:         true,
		},
		{name: "no parens", line: "1234 bash S 1 2 3", wantOK: false},
		{name: "too few fields", line: "1234 (bash) S 1 2 3", wantOK: false},
		{name: "empty", line: "", wantOK: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pid, us, rss, ok := parseProcStatLine([]byte(tt.line))
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if !ok {
				return
			}
			if pid != tt.wantPID {
				t.Errorf("pid = %d, want %d", pid, tt.wantPID)
			}
			if us != tt.wantUtimeStime {
				t.Errorf("utime+stime = %d, want %d", us, tt.wantUtimeStime)
			}
			if rss != tt.wantRSSPages {
				t.Errorf("rss pages = %d, want %d", rss, tt.wantRSSPages)
			}
		})
	}
}

// buildStat constructs a /proc/<pid>/stat line with field14=100, field15=50,
// field24=2048 and the rest filler, so parseProcStatLine has ≥22 trailing
// fields to index into.
func buildStat(pid int, comm string) string {
	// fields 3..52 (index 0..49 after the comm). state at 0, then we need
	// index 11 (=100), index 12 (=50), index 21 (=2048).
	rest := make([]string, 30)
	for i := range rest {
		rest[i] = "0"
	}
	rest[0] = "S"   // field 3 state
	rest[11] = "100" // field 14 utime
	rest[12] = "50"  // field 15 stime
	rest[21] = "2048" // field 24 rss pages
	line := itoa(pid) + " (" + comm + ")"
	for _, r := range rest {
		line += " " + r
	}
	return line
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf []byte
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	if neg {
		buf = append([]byte{'-'}, buf...)
	}
	return string(buf)
}

func TestCommFromStat(t *testing.T) {
	if got := commFromStat([]byte(buildStat(1, "bash"))); got != "bash" {
		t.Errorf("commFromStat = %q, want bash", got)
	}
	if got := commFromStat([]byte(buildStat(1, "my (weird) proc"))); got != "my (weird) proc" {
		t.Errorf("commFromStat = %q, want 'my (weird) proc'", got)
	}
}

func TestParseCmdline(t *testing.T) {
	tests := []struct {
		name string
		in   []byte
		comm string
		want string
	}{
		{"normal argv", []byte("python3\x00-m\x00http.server\x008080\x00"), "python3", "python3 -m http.server 8080"},
		{"single arg trailing nul", []byte("nginx\x00"), "nginx", "nginx"},
		{"no trailing nul", []byte("bash"), "bash", "bash"},
		{"empty → kernel thread", []byte(""), "kthreadd", "[kthreadd]"},
		{"only nuls → kernel thread", []byte("\x00\x00"), "ksoftirqd", "[ksoftirqd]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseCmdline(tt.in, tt.comm); got != tt.want {
				t.Errorf("parseCmdline = %q, want %q", got, tt.want)
			}
		})
	}
	// length cap
	long := make([]byte, cmdlineMaxLen+500)
	for i := range long {
		long[i] = 'x'
	}
	got := parseCmdline(long, "big")
	if len([]rune(got)) != cmdlineMaxLen+1 { // +1 for the ellipsis rune
		t.Errorf("capped length = %d runes, want %d", len([]rune(got)), cmdlineMaxLen+1)
	}
}

func TestTop(t *testing.T) {
	procs := []ProcInfo{
		{PID: 1, CPUPercent: 10, RSSBytes: 500, NetRxBytesPerSec: 5, NetTxBytesPerSec: 5},
		{PID: 2, CPUPercent: 90, RSSBytes: 100, NetRxBytesPerSec: 0, NetTxBytesPerSec: 0},
		{PID: 3, CPUPercent: 50, RSSBytes: 900, NetRxBytesPerSec: 100, NetTxBytesPerSec: 200},
	}
	// by CPU desc
	byCPU := Top(procs, "cpu", 10)
	if byCPU[0].PID != 2 || byCPU[1].PID != 3 || byCPU[2].PID != 1 {
		t.Errorf("by-cpu order = %d,%d,%d, want 2,3,1", byCPU[0].PID, byCPU[1].PID, byCPU[2].PID)
	}
	// by mem (RSS) desc
	byMem := Top(procs, "mem", 10)
	if byMem[0].PID != 3 || byMem[1].PID != 1 || byMem[2].PID != 2 {
		t.Errorf("by-mem order = %d,%d,%d, want 3,1,2", byMem[0].PID, byMem[1].PID, byMem[2].PID)
	}
	// by net (in+out) desc: 3 (300) > 1 (10) > 2 (0)
	byNet := Top(procs, "net", 10)
	if byNet[0].PID != 3 || byNet[1].PID != 1 || byNet[2].PID != 2 {
		t.Errorf("by-net order = %d,%d,%d, want 3,1,2", byNet[0].PID, byNet[1].PID, byNet[2].PID)
	}
	// unknown/empty sort defaults to CPU
	if got := Top(procs, "", 10); got[0].PID != 2 {
		t.Errorf("empty sort should default to cpu, got first PID %d", got[0].PID)
	}
	// limit truncation
	if got := Top(procs, "cpu", 2); len(got) != 2 {
		t.Errorf("limit=2 → %d rows, want 2", len(got))
	}
	// limit clamping
	if got := Top(procs, "cpu", 0); len(got) != 1 {
		t.Errorf("limit=0 clamps to 1 → %d rows, want 1", len(got))
	}
	if got := Top(procs, "cpu", 9999); len(got) != 3 {
		t.Errorf("limit>len → %d rows, want 3 (all)", len(got))
	}
	// input not mutated
	if procs[0].PID != 1 {
		t.Error("Top mutated the input slice order")
	}
}

func TestParseAggCPULine(t *testing.T) {
	ct, ok := parseAggCPULine("cpu  100 0 50 1000 20 0 5 0")
	if !ok {
		t.Fatal("ok = false, want true")
	}
	// total = 100+0+50+1000+20+0+5+0 = 1175; idle = 1000(idle)+20(iowait) = 1020
	if ct.total != 1175 {
		t.Errorf("total = %d, want 1175", ct.total)
	}
	if ct.idle != 1020 {
		t.Errorf("idle = %d, want 1020", ct.idle)
	}
	if _, ok := parseAggCPULine("cpu0 1 2 3 4"); ok {
		t.Error("per-core 'cpu0' line should not parse as aggregate")
	}
	if _, ok := parseAggCPULine("intr 1 2 3"); ok {
		t.Error("non-cpu line should not parse")
	}
}

func TestOverallCPUPercent(t *testing.T) {
	// busy 100→300 (Δ200), total 1000→2000 (Δ1000) → 20%.
	prev := cpuTimes{idle: 900, total: 1000}  // busy = 100
	cur := cpuTimes{idle: 1700, total: 2000}  // busy = 300
	if got := overallCPUPercent(prev, cur); got != 20 {
		t.Errorf("overallCPUPercent = %v, want 20", got)
	}
	// zero interval → 0
	if got := overallCPUPercent(prev, prev); got != 0 {
		t.Errorf("zero interval = %v, want 0", got)
	}
}

func TestProcCPUPercent(t *testing.T) {
	// dProc=100, dTotal=1000, numCPU=4 → 100/1000*100*4 = 40.0
	if got := procCPUPercent(100, 1000, 4); got != 40 {
		t.Errorf("procCPUPercent = %v, want 40", got)
	}
	// dTotal==0 → 0
	if got := procCPUPercent(100, 0, 4); got != 0 {
		t.Errorf("dTotal=0 → %v, want 0", got)
	}
	// clamp at 100*numCPU
	if got := procCPUPercent(100000, 1000, 4); got != 400 {
		t.Errorf("clamp = %v, want 400", got)
	}
}

func TestPct(t *testing.T) {
	if got := pct(512, 1024); got != 50 {
		t.Errorf("pct(512,1024) = %v, want 50", got)
	}
	if got := pct(5, 0); got != 0 {
		t.Errorf("pct(_,0) = %v, want 0", got)
	}
}

func TestParseMeminfo(t *testing.T) {
	s := "MemTotal:       16384 kB\nMemFree:         1000 kB\nMemAvailable:    8192 kB\n"
	total, avail, ok := parseMeminfo(s)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if total != 16384*1024 {
		t.Errorf("total = %d, want %d", total, 16384*1024)
	}
	if avail != 8192*1024 {
		t.Errorf("available = %d, want %d", avail, 8192*1024)
	}
}

func TestParseLoadavg(t *testing.T) {
	l1, l5, l15, ok := parseLoadavg("0.52 0.58 0.59 1/823 12345\n")
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if l1 != 0.52 || l5 != 0.58 || l15 != 0.59 {
		t.Errorf("loadavg = %v %v %v, want 0.52 0.58 0.59", l1, l5, l15)
	}
	if _, _, _, ok := parseLoadavg("bad"); ok {
		t.Error("malformed loadavg should report ok=false")
	}
	if _, _, _, ok := parseLoadavg("x y z 1/2 3"); ok {
		t.Error("non-numeric loadavg should report ok=false")
	}
}

func TestIsAllDigits(t *testing.T) {
	for _, s := range []string{"1", "1234", "0"} {
		if !isAllDigits(s) {
			t.Errorf("isAllDigits(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "abc", "12a", "self"} {
		if isAllDigits(s) {
			t.Errorf("isAllDigits(%q) = true, want false", s)
		}
	}
}
