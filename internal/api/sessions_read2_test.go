package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/loki/goclaudemanager/internal/model"
)

// writeJSONL creates ~/.claude/projects/<encoded-cwd>/<sid>.jsonl with the
// given mtime, under the test's temp HOME.
func writeJSONL(t *testing.T, home, cwd, sid string, mtime time.Time) {
	t.Helper()
	encoded := strings.ReplaceAll(strings.ReplaceAll(strings.TrimRight(cwd, "/"), "/", "-"), "_", "-")
	dir := filepath.Join(home, ".claude", "projects", encoded)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, sid+".jsonl")
	if err := os.WriteFile(p, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func ptr(s string) *string { return &s }

func isoPtr(tm time.Time) *model.ISOTime { v := model.ISOTime{Time: tm}; return &v }

// TestResolveChatSID_NeverTalkedDoesNotBorrowSibling pins the reported bug:
// session B (created after A, never typed) must NOT show A's transcript even
// though B's agent_session_id is captured but B has no transcript of its own.
func TestResolveChatSID_NeverTalkedDoesNotBorrowSibling(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/tmp/cm-test-proj"

	// A typed → A's transcript exists. B never typed → no B transcript on disk.
	writeJSONL(t, home, cwd, "A-sid", time.Now())

	b := &model.Session{
		Tool:           "claude",
		Cwd:            cwd,
		AgentSessionID: ptr("B-sid"), // captured from pid, but no file written yet
		// LastTurnAt nil → never talked
	}
	if got := resolveChatSIDCore(b); got != "" {
		t.Fatalf("never-talked session must show empty, got %q", got)
	}
}

// TestResolveChatSID_OwnFileWins: once a session has its own transcript on disk,
// that is returned regardless of siblings.
func TestResolveChatSID_OwnFileWins(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/tmp/cm-test-proj2"

	now := time.Now()
	writeJSONL(t, home, cwd, "own-sid", now)
	writeJSONL(t, home, cwd, "sibling-sid", now.Add(time.Hour)) // newer sibling

	s := &model.Session{
		Tool:           "claude",
		Cwd:            cwd,
		AgentSessionID: ptr("own-sid"),
		LastTurnAt:     isoPtr(now),
	}
	if got := resolveChatSIDCore(s); got != "own-sid" {
		t.Fatalf("own existing transcript should win, got %q", got)
	}
}

// TestResolveChatSID_StoredFileGoneNeverBorrows: a session that conversed but
// whose stored id no longer resolves (rotated away / deleted) must NOT borrow
// any other transcript in the cwd — not a sibling's, and not even a plausibly
// "own" rotated file we cannot prove ownership of. The link is authoritative;
// when it does not resolve, Chat shows empty.
func TestResolveChatSID_StoredFileGoneNeverBorrows(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/tmp/cm-test-proj3"

	base := time.Now()
	// Other transcripts exist in the cwd, but none is this session's stored id.
	writeJSONL(t, home, cwd, "sibling-sid", base.Add(2*time.Hour))
	writeJSONL(t, home, cwd, "another-sid", base.Add(1*time.Hour))

	s := &model.Session{
		Tool:           "claude",
		Cwd:            cwd,
		AgentSessionID: ptr("ghost-stale-id"), // no file on disk
		LastTurnAt:     isoPtr(base),
	}
	if got := resolveChatSIDCore(s); got != "" {
		t.Fatalf("stored id with no file must not borrow another transcript, got %q", got)
	}
}

// TestResolveChatSID_NoTranscriptAtAll: never-talked, nothing on disk → empty.
func TestResolveChatSID_NoTranscriptAtAll(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/tmp/cm-test-proj4"

	s := &model.Session{Tool: "claude", Cwd: cwd, AgentSessionID: ptr("B-sid")}
	if got := resolveChatSIDCore(s); got != "" {
		t.Fatalf("no transcript + never talked → empty, got %q", got)
	}
}
