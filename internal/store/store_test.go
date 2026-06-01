package store

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/loki/goclaudemanager/internal/model"
)

func freshStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CLAUDEMANAGER_DATA_DIR", dir)
	st, err := Open()
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := os.Stat(filepath.Join(dir, "data.db")); err != nil {
		t.Fatalf("data.db not created: %v", err)
	}
	return st
}

func ptr[T any](v T) *T { return &v }

func TestSessionRoundTrip(t *testing.T) {
	st := freshStore(t)

	s := &model.Session{
		ID:              "sess-1",
		OwnerID:         "alice",
		Name:            "demo",
		Project:         "proj",
		Cwd:             "/tmp/proj",
		Env:             map[string]string{"FOO": "bar"},
		Model:           ptr("opus"),
		Tool:            "claude",
		Status:          model.StatusCreating,
		CreatedAt:       model.NowUTC(),
		UpdatedAt:       model.NowUTC(),
		TmuxSessionName: "cm-sess-1",
		CodexTransport:  "tui",
	}
	if err := st.CreateSession(s); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	got, err := st.GetSession("sess-1")
	if err != nil || got == nil {
		t.Fatalf("GetSession: %v (got=%v)", err, got)
	}
	if got.OwnerID != "alice" || got.Name != "demo" || got.Env["FOO"] != "bar" {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
	if got.Model == nil || *got.Model != "opus" {
		t.Fatalf("model not preserved: %+v", got.Model)
	}

	// transition creating -> running
	if _, err := st.Transition("sess-1", model.StatusRunning); err != nil {
		t.Fatalf("Transition: %v", err)
	}
	// invalid transition running -> creating
	if _, err := st.Transition("sess-1", model.StatusCreating); err == nil {
		t.Fatalf("expected invalid transition error")
	}

	// list for owner
	list, err := st.ListForOwner("alice")
	if err != nil || len(list) != 1 {
		t.Fatalf("ListForOwner: %v len=%d", err, len(list))
	}

	// ws token idempotent
	tok1, _ := st.IssueWsToken("sess-1")
	tok2, _ := st.IssueWsToken("sess-1")
	if tok1 == "" || tok1 != tok2 {
		t.Fatalf("ws token not stable: %q %q", tok1, tok2)
	}

	// delete
	ok, err := st.DeleteSession("sess-1")
	if err != nil || !ok {
		t.Fatalf("DeleteSession: %v ok=%v", err, ok)
	}
}

func TestTaskAndPromptHistory(t *testing.T) {
	st := freshStore(t)
	task := &model.ScheduledTask{
		ID: "t1", SessionID: "s1", OwnerID: "alice", Command: "echo hi",
		RunAt: model.NowUTC(), Status: "pending", CreatedAt: model.NowUTC(),
	}
	if err := st.CreateTask(task); err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	due, err := st.ListDueTasks()
	if err != nil {
		t.Fatalf("ListDueTasks: %v", err)
	}
	if len(due) != 1 {
		t.Fatalf("expected 1 due task, got %d", len(due))
	}

	if _, err := st.AppendPromptHistory("s1", "hello world", 1000.0, nil); err != nil {
		t.Fatalf("AppendPromptHistory: %v", err)
	}
	if _, err := st.AppendPromptHistory("s1", "goodbye", 1001.0, ptr("main")); err != nil {
		t.Fatalf("AppendPromptHistory: %v", err)
	}
	n, _ := st.CountPromptHistory("s1", "")
	if n != 2 {
		t.Fatalf("count = %d, want 2", n)
	}
	hits, _ := st.ListPromptHistory("s1", 50, 0, "hello")
	if len(hits) != 1 || hits[0].Text != "hello world" {
		t.Fatalf("filter mismatch: %+v", hits)
	}
}
