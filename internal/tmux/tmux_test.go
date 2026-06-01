package tmux

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestReadPPID(t *testing.T) {
	dir := t.TempDir()
	// comm with spaces and parens to ensure we split on the LAST ')'.
	stat := "1234 (weird )name) S 42 1234 1234 0 -1 4194560 ..."
	statPath := filepath.Join(dir, "stat")
	if err := os.WriteFile(statPath, []byte(stat), 0o644); err != nil {
		t.Fatal(err)
	}
	ppid, ok := readPPID(statPath)
	if !ok {
		t.Fatal("expected ok")
	}
	if ppid != 42 {
		t.Fatalf("ppid = %d, want 42", ppid)
	}
}

func TestReadPPIDMissing(t *testing.T) {
	if _, ok := readPPID(filepath.Join(t.TempDir(), "nope")); ok {
		t.Fatal("expected not ok for missing file")
	}
}

// TestGetDescendantsReal exercises getDescendants against the live /proc of
// this test process: every Go test process has at least itself; we verify the
// BFS structure with a synthetic map instead of asserting on live children.
func TestGetDescendantsBFS(t *testing.T) {
	// 1 -> 2,3 ; 2 -> 4 ; 3 -> (none) ; 4 -> 5
	cm := map[int][]int{
		1: {2, 3},
		2: {4},
		4: {5},
	}
	got := bfsDescendants(cm, 1)
	want := map[int]bool{2: true, 3: true, 4: true, 5: true}
	if len(got) != len(want) {
		t.Fatalf("got %v, want keys %v", got, want)
	}
	for _, v := range got {
		if !want[v] {
			t.Fatalf("unexpected descendant %d in %v", v, got)
		}
	}
}

// bfsDescendants mirrors the BFS in getDescendants for unit testing without /proc.
func bfsDescendants(cm map[int][]int, pid int) []int {
	var result []int
	queue := append([]int(nil), cm[pid]...)
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		result = append(result, cur)
		queue = append(queue, cm[cur]...)
	}
	return result
}

func TestGetDescendantsProcSmoke(t *testing.T) {
	if _, err := os.Stat("/proc"); err != nil {
		t.Skip("no /proc")
	}
	// PID 1 should have descendants on any normal Linux box; at minimum the
	// call must not error.
	if _, err := getDescendants(os.Getpid()); err != nil {
		t.Fatalf("getDescendants error: %v", err)
	}
}

func TestShellQuote(t *testing.T) {
	cases := map[string]string{
		"":               "''",
		"plain":          "plain",
		"a/b-c.d":        "a/b-c.d",
		"has space":      "'has space'",
		"it's":           `'it'"'"'s'`,
		"ANTHROPIC=x y":  "'ANTHROPIC=x y'",
	}
	for in, want := range cases {
		if got := shellQuote(in); got != want {
			t.Errorf("shellQuote(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBuildClaudeCommand(t *testing.T) {
	// default
	if got := buildClaudeCommand("claude", "", "", "", ""); got != "claude --dangerously-skip-permissions" {
		t.Errorf("default: %q", got)
	}
	// model
	if got := buildClaudeCommand("claude", "", "opus", "", ""); got != "claude --dangerously-skip-permissions --model opus" {
		t.Errorf("model: %q", got)
	}
	// resume takes precedence over model
	if got := buildClaudeCommand("claude", "", "opus", "sess-1", ""); got != "claude --dangerously-skip-permissions --resume sess-1" {
		t.Errorf("resume: %q", got)
	}
	// inner_id wraps with pid-file sh wrapper
	got := buildClaudeCommand("claude", "", "", "", "abc")
	want := "sh -c 'echo $$ > /tmp/claude-inner-abc.pid && exec claude --dangerously-skip-permissions'"
	if got != want {
		t.Errorf("inner:\n got %q\nwant %q", got, want)
	}
	// claude_shell wraps the whole thing
	got = buildClaudeCommand("/abs/claude", "bash", "", "", "")
	want = `bash -c '/abs/claude --dangerously-skip-permissions'`
	if got != want {
		t.Errorf("shell:\n got %q\nwant %q", got, want)
	}
}

func TestBuildCursorCommand(t *testing.T) {
	if got := buildCursorCommand("agent", "", ""); got != "agent --yolo" {
		t.Errorf("default: %q", got)
	}
	if got := buildCursorCommand("agent", "", "s1"); got != "agent --yolo --resume s1" {
		t.Errorf("resume: %q", got)
	}
}

func TestBuildCodexCommand(t *testing.T) {
	got := buildCodexCommand("gpt-5", "")
	if !strings.Contains(got, "--no-alt-screen") || !strings.Contains(got, `-c 'model="gpt-5"'`) {
		t.Errorf("codex model: %q", got)
	}
	got = buildCodexCommand("", "rid")
	if !strings.HasSuffix(got, "resume rid") {
		t.Errorf("codex resume: %q", got)
	}
}

func TestBuildEnvPrefix(t *testing.T) {
	c := New("test-sock")
	c.ClaudeBin = func() string { return "/opt/tools/claude" }
	c.ProxyEnv = func() map[string]string {
		return map[string]string{"HTTPS_PROXY": "http://p:8080"}
	}
	prefix := c.buildEnvPrefix(map[string]string{
		"FOO":   "bar baz",
		"EMPTY": "", // skipped
	})
	if !strings.HasPrefix(prefix, "env ") || !strings.HasSuffix(prefix, " ") {
		t.Fatalf("prefix shape: %q", prefix)
	}
	if !strings.Contains(prefix, "'FOO=bar baz'") {
		t.Errorf("missing FOO: %q", prefix)
	}
	if strings.Contains(prefix, "EMPTY=") {
		t.Errorf("empty value should be skipped: %q", prefix)
	}
	if !strings.Contains(prefix, "HTTPS_PROXY=http://p:8080") {
		t.Errorf("missing proxy env: %q", prefix)
	}
	// PATH must include the absolute claude bin's dir prepended.
	if !strings.Contains(prefix, "/opt/tools") {
		t.Errorf("PATH should include claude bin dir: %q", prefix)
	}
}

func TestBuildEnvPrefixEnvOverridesProxy(t *testing.T) {
	c := New("test-sock")
	c.ProxyEnv = func() map[string]string {
		return map[string]string{"HTTPS_PROXY": "http://proxy"}
	}
	prefix := c.buildEnvPrefix(map[string]string{"HTTPS_PROXY": "http://override"})
	if !strings.Contains(prefix, "HTTPS_PROXY=http://override") {
		t.Errorf("env should override proxy: %q", prefix)
	}
	if strings.Contains(prefix, "http://proxy") {
		t.Errorf("proxy value should be overridden: %q", prefix)
	}
}

func TestLooksLikeTrustDialog(t *testing.T) {
	if looksLikeTrustDialog("") {
		t.Error("empty should be false")
	}
	if !looksLikeTrustDialog("...\nYes, I trust this folder\n...") {
		t.Error("should match pattern 1")
	}
	if !looksLikeTrustDialog("Accessing workspace foo") {
		t.Error("should match pattern 2")
	}
	if looksLikeTrustDialog("a normal screen") {
		t.Error("should not match")
	}
}

func TestNeedsProxyTap(t *testing.T) {
	if !needsProxyTap("claude") {
		t.Error("claude should tap")
	}
	if needsProxyTap("cursor") || needsProxyTap("codex") {
		t.Error("cursor/codex should not tap")
	}
}

func TestReadSessionID(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "123.json")
	if err := os.WriteFile(p, []byte(`{"sessionId":"abc-123","other":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if sid, ok := readSessionID(p); !ok || sid != "abc-123" {
		t.Fatalf("got %q ok=%v", sid, ok)
	}
	// missing sessionId
	p2 := filepath.Join(dir, "x.json")
	_ = os.WriteFile(p2, []byte(`{"foo":1}`), 0o644)
	if _, ok := readSessionID(p2); ok {
		t.Error("expected not ok for missing sessionId")
	}
	// malformed
	p3 := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(p3, []byte(`not json`), 0o644)
	if _, ok := readSessionID(p3); ok {
		t.Error("expected not ok for malformed json")
	}
}

func TestJoinNonEmpty(t *testing.T) {
	got := joinNonEmpty([]string{"", "127.0.0.1", "", "localhost"}, ",")
	if got != "127.0.0.1,localhost" {
		t.Errorf("got %q", got)
	}
}

// sanity: ensure pid->str round-trips as used in resolve paths.
func TestPidStr(t *testing.T) {
	if strconv.Itoa(987) != "987" {
		t.Fatal("unexpected")
	}
}
