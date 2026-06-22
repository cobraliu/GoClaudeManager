package procmon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseStat(t *testing.T) {
	// pid 1234, comm "(weird) proc" with spaces+parens, ppid 1000.
	// Layout after the last ')': state(3) ppid(4) pgrp(5) ... so we craft fields
	// 3..24. utime(14)=50 stime(15)=20 starttime(22)=777 rss(24)=42.
	rest := []string{
		"S",    // 3 state
		"1000", // 4 ppid
		"1",    // 5 pgrp
		"1",    // 6 session
		"0",    // 7 tty_nr
		"-1",   // 8 tpgid
		"0",    // 9 flags
		"0",    // 10 minflt
		"0",    // 11 cminflt
		"0",    // 12 majflt
		"0",    // 13 cmajflt
		"50",   // 14 utime
		"20",   // 15 stime
		"0",    // 16 cutime
		"0",    // 17 cstime
		"20",   // 18 priority
		"0",    // 19 nice
		"1",    // 20 num_threads
		"0",    // 21 itrealvalue
		"777",  // 22 starttime
		"0",    // 23 vsize
		"42",   // 24 rss (pages)
	}
	line := []byte("1234 ((weird) proc) " + strings.Join(rest, " ") + "\n")

	pid, ppid, utimeStime, starttime, rss, ok := parseStat(line)
	if !ok {
		t.Fatal("parseStat returned ok=false")
	}
	if pid != 1234 || ppid != 1000 {
		t.Errorf("pid/ppid = %d/%d, want 1234/1000", pid, ppid)
	}
	if utimeStime != 70 {
		t.Errorf("utimeStime = %d, want 70", utimeStime)
	}
	if starttime != 777 {
		t.Errorf("starttime = %d, want 777", starttime)
	}
	if rss != 42 {
		t.Errorf("rss pages = %d, want 42", rss)
	}
}

func TestParseStatTooShort(t *testing.T) {
	if _, _, _, _, _, ok := parseStat([]byte("1 (init) S 0 0")); ok {
		t.Error("expected ok=false for a truncated stat line")
	}
}

func TestCPUPercent(t *testing.T) {
	// 200 jiffies over 2s with clkTck=100 => 1.0 CPU-second/s => 100% (one core).
	if got := cpuPercent(200, 2.0, 8); got != 100 {
		t.Errorf("cpuPercent = %v, want 100", got)
	}
	// Clamped to 100*numCPU.
	if got := cpuPercent(1_000_000, 0.001, 2); got != 200 {
		t.Errorf("cpuPercent clamp = %v, want 200", got)
	}
	if got := cpuPercent(100, 0, 4); got != 0 {
		t.Errorf("cpuPercent with zero elapsed = %v, want 0", got)
	}
}

func TestUptimeSeconds(t *testing.T) {
	now := time.Unix(1_000_900, 0)
	// btime=1_000_000, starttime=10000 jiffies => start at 1_000_100 => 800s ago.
	if got := uptimeSeconds(10000, 1_000_000, now); got != 800 {
		t.Errorf("uptimeSeconds = %d, want 800", got)
	}
	// Future starttime (clock skew) clamps to 0.
	if got := uptimeSeconds(100_000_000, 1_000_000, now); got != 0 {
		t.Errorf("uptimeSeconds clamp = %d, want 0", got)
	}
	if got := uptimeSeconds(123, 0, now); got != 0 {
		t.Errorf("uptimeSeconds with no btime = %d, want 0", got)
	}
}

func TestDescendants(t *testing.T) {
	// 1 -> 2,3 ; 2 -> 4 ; 4 -> 5 ; 3 has no children.
	children := map[int][]int{1: {2, 3}, 2: {4}, 4: {5}}
	got := descendants(1, children)
	want := map[int]bool{1: true, 2: true, 3: true, 4: true, 5: true}
	if len(got) != len(want) {
		t.Fatalf("descendants = %v, want 5 entries", got)
	}
	for _, p := range got {
		if !want[p] {
			t.Errorf("unexpected pid %d in descendants", p)
		}
	}
	if got[0] != 1 {
		t.Errorf("root should be first, got %d", got[0])
	}
}

func TestDescendantsCycleSafe(t *testing.T) {
	// A pathological self/cyclic parent map must terminate.
	children := map[int][]int{1: {2}, 2: {1, 3}}
	got := descendants(1, children)
	if len(got) != 3 {
		t.Errorf("descendants cycle = %v, want 3 unique", got)
	}
}

func writeTmp(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestTailFile(t *testing.T) {
	cases := []struct {
		name    string
		content string
		n       int
		want    []string
	}{
		{"basic", "a\nb\nc\nd\ne\n", 3, []string{"c", "d", "e"}},
		{"no-trailing-newline", "a\nb\nc", 2, []string{"b", "c"}},
		{"fewer-than-n", "only\n", 5, []string{"only"}},
		{"single-line", "justone", 3, []string{"justone"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tailFile(writeTmp(t, "log", tc.content), tc.n)
			if strings.Join(got, "\n") != strings.Join(tc.want, "\n") {
				t.Errorf("tailFile = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestTailFileEmpty(t *testing.T) {
	if got := tailFile(writeTmp(t, "empty", ""), 10); got != nil {
		t.Errorf("tailFile empty = %v, want nil", got)
	}
	if got := tailFile(filepath.Join(t.TempDir(), "missing"), 10); got != nil {
		t.Errorf("tailFile missing = %v, want nil", got)
	}
}

func TestTailFileHugeSingleLine(t *testing.T) {
	// One line far larger than the byte cap must not OOM and must still return
	// a single (capped) line without crashing.
	big := strings.Repeat("x", tailByteCap*2)
	got := tailFile(writeTmp(t, "big", big+"\n"), 5)
	if len(got) != 1 {
		t.Fatalf("tailFile huge = %d lines, want 1", len(got))
	}
}

func TestSampleNonLinuxOrBadPID(t *testing.T) {
	s := NewSampler()
	snap := s.Sample("sess", 0, 30)
	if len(snap.Processes) != 0 {
		t.Errorf("Sample(pid=0) returned %d procs, want 0", len(snap.Processes))
	}
	if snap.Processes == nil {
		t.Error("Processes must never be nil")
	}
}
