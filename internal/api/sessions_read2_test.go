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
// given mtime, under the test's temp HOME. Returns nothing; the file presence +
// mtime is what the resolver keys off.
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

// TestResolveChatSID_BrandNewSessionDoesNotBorrowOlderTranscript pins the bug
// fix: a freshly created session (no agent_session_id yet) that shares its cwd
// with an older session must NOT surface that older session's transcript.
func TestResolveChatSID_BrandNewSessionDoesNotBorrowOlderTranscript(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/tmp/cm-test-proj"

	created := time.Now()
	// An OLDER session's transcript, written before our session was created.
	writeJSONL(t, home, cwd, "old-other-session", created.Add(-1*time.Hour))

	fresh := &model.Session{
		Tool:      "claude",
		Cwd:       cwd,
		CreatedAt: model.ISOTime{Time: created},
		// AgentSessionID nil → stored == ""
	}
	if got := resolveChatSID("claude", cwd, fresh); got != "" {
		t.Fatalf("brand-new session should not adopt an older foreign transcript, got %q", got)
	}
	// resume path, by contrast, intentionally grabs the newest as a fallback.
	if got := resolveResumeSID("claude", cwd, fresh); got != "old-other-session" {
		t.Fatalf("resume should fall back to newest transcript, got %q", got)
	}
}

// TestResolveChatSID_AdoptsOwnFreshTranscript: once this session writes its own
// transcript (mtime at/after creation), the Chat view should pick it up even
// before agent_session_id is captured.
func TestResolveChatSID_AdoptsOwnFreshTranscript(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/tmp/cm-test-proj2"

	created := time.Now().Add(-1 * time.Minute)
	writeJSONL(t, home, cwd, "my-own-session", created.Add(10*time.Second))

	s := &model.Session{Tool: "claude", Cwd: cwd, CreatedAt: model.ISOTime{Time: created}}
	if got := resolveChatSID("claude", cwd, s); got != "my-own-session" {
		t.Fatalf("should adopt own fresh transcript, got %q", got)
	}
}

// TestResolveChatSID_StaleStoredIDFallsBack: stored id whose file is gone still
// repairs to the newest transcript (the original documented behavior).
func TestResolveChatSID_StaleStoredIDFallsBack(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/tmp/cm-test-proj3"

	created := time.Now()
	writeJSONL(t, home, cwd, "live-transcript", created.Add(-2*time.Hour))

	s := &model.Session{
		Tool:           "claude",
		Cwd:            cwd,
		CreatedAt:      model.ISOTime{Time: created},
		AgentSessionID: ptr("ghost-id-no-file"),
	}
	if got := resolveChatSID("claude", cwd, s); got != "live-transcript" {
		t.Fatalf("stale stored id should repair to newest transcript, got %q", got)
	}
}

// TestResolveChatSID_StoredIDWithFileWins: the happy path is unchanged.
func TestResolveChatSID_StoredIDWithFileWins(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/tmp/cm-test-proj4"

	now := time.Now()
	writeJSONL(t, home, cwd, "stored-sid", now)
	writeJSONL(t, home, cwd, "newer-other", now.Add(1*time.Hour))

	s := &model.Session{
		Tool:           "claude",
		Cwd:            cwd,
		CreatedAt:      model.ISOTime{Time: now.Add(-1 * time.Hour)},
		AgentSessionID: ptr("stored-sid"),
	}
	if got := resolveChatSID("claude", cwd, s); got != "stored-sid" {
		t.Fatalf("stored id with existing file should win, got %q", got)
	}
}
