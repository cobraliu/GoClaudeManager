package procmon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCPUPercent(t *testing.T) {
	// 2.0 CPU-seconds over 2s => 1.0 CPU-second/s => 100% (one core).
	if got := cpuPercent(2.0, 2.0, 8); got != 100 {
		t.Errorf("cpuPercent = %v, want 100", got)
	}
	// Clamped to 100*numCPU.
	if got := cpuPercent(1_000_000, 0.001, 2); got != 200 {
		t.Errorf("cpuPercent clamp = %v, want 200", got)
	}
	if got := cpuPercent(1.0, 0, 4); got != 0 {
		t.Errorf("cpuPercent with zero elapsed = %v, want 0", got)
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

func TestSampleBadPID(t *testing.T) {
	s := NewSampler()
	snap := s.Sample("sess", 0, 30)
	if len(snap.Processes) != 0 {
		t.Errorf("Sample(pid=0) returned %d procs, want 0", len(snap.Processes))
	}
	if snap.Processes == nil {
		t.Error("Processes must never be nil")
	}
}

// TestSampleLiveTree exercises the real gopsutil path against this test
// process's own tree on whatever platform the tests run on. The test process
// always has a parent (the `go test` runner), so rooting at the parent must
// surface at least the parent and this process.
func TestSampleLiveTree(t *testing.T) {
	root := os.Getppid()
	s := NewSampler()
	snap := s.Sample("live", root, 30)
	if len(snap.Processes) == 0 {
		t.Fatalf("Sample(ppid=%d) returned no processes", root)
	}
	var sawRoot, sawSelf bool
	self := os.Getpid()
	for _, p := range snap.Processes {
		if p.IsRoot {
			if p.PID != root {
				t.Errorf("root marked on pid %d, want %d", p.PID, root)
			}
			sawRoot = true
		}
		if p.PID == self {
			sawSelf = true
			if p.Cmdline == "" {
				t.Error("self process has empty cmdline")
			}
		}
	}
	if !sawRoot {
		t.Error("root process not present / not marked")
	}
	if !sawSelf {
		t.Errorf("this process (pid %d) not found under root %d", self, root)
	}
}
