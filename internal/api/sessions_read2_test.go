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
	// exclude = sibling A's claimed id.
	if got := resolveChatSIDCore(b, map[string]bool{"A-sid": true}); got != "" {
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
	if got := resolveChatSIDCore(s, map[string]bool{"sibling-sid": true}); got != "own-sid" {
		t.Fatalf("own existing transcript should win, got %q", got)
	}
}

// TestResolveChatSID_RotatedIDRecoversOwnNotSibling: a session that conversed
// but whose stored id was rotated away (file gone) recovers the newest UNCLAIMED
// transcript in the cwd, never a sibling's claimed transcript.
func TestResolveChatSID_RotatedIDRecoversOwnNotSibling(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/tmp/cm-test-proj3"

	base := time.Now()
	// Sibling's transcript is the newest overall, but it is claimed.
	writeJSONL(t, home, cwd, "sibling-sid", base.Add(2*time.Hour))
	// This session's rotated transcript (unclaimed), older than the sibling's.
	writeJSONL(t, home, cwd, "rotated-own", base.Add(1*time.Hour))

	s := &model.Session{
		Tool:           "claude",
		Cwd:            cwd,
		AgentSessionID: ptr("ghost-stale-id"), // no file on disk
		LastTurnAt:     isoPtr(base),
	}
	if got := resolveChatSIDCore(s, map[string]bool{"sibling-sid": true}); got != "rotated-own" {
		t.Fatalf("should recover own rotated transcript, not the claimed sibling, got %q", got)
	}
}

// TestResolveChatSID_NoTranscriptAtAll: never-talked, nothing on disk → empty.
func TestResolveChatSID_NoTranscriptAtAll(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/tmp/cm-test-proj4"

	s := &model.Session{Tool: "claude", Cwd: cwd, AgentSessionID: ptr("B-sid")}
	if got := resolveChatSIDCore(s, nil); got != "" {
		t.Fatalf("no transcript + never talked → empty, got %q", got)
	}
}
