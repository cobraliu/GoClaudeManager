package status

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/loki/goclaudemanager/internal/jsonl"
	"github.com/loki/goclaudemanager/internal/model"
)

// The transcript's tool_result is what marks an sdk AUQ answered when the
// wrapper's interaction_resolved event never arrived.
func TestSDKAUQAnswered(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/work/proj"
	dir := filepath.Join(home, ".claude", "projects", strings.ReplaceAll(cwd, "/", "-"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	lines := []string{
		`{"type":"assistant","timestamp":"2026-10-28T10:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_done","name":"AskUserQuestion","input":{"questions":[{"question":"Q1?","header":"H","options":[{"label":"a"}]}]}}]}}`,
		`{"type":"user","timestamp":"2026-10-28T10:00:05Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_done","content":"<tool_use_error>rejected</tool_use_error>","is_error":true}]}}`,
		`{"type":"assistant","timestamp":"2026-10-28T10:01:00Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_open","name":"AskUserQuestion","input":{"questions":[{"question":"Q2?","header":"H","options":[{"label":"a"}]}]}}]}}`,
	}
	if err := os.WriteFile(filepath.Join(dir, "agent-1.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	m := &Manager{jsonl: jsonl.NewCache()}
	s := &model.Session{ID: "s", Cwd: cwd}
	for _, c := range []struct {
		agent, id string
		want      bool
	}{
		{"agent-1", "toolu_done", true},
		{"agent-1", "toolu_open", false},
		{"agent-1", "toolu_unknown", false},
		{"", "toolu_done", false}, // no agent id anywhere
	} {
		if got := m.sdkAUQAnswered(s, c.agent, c.id); got != c.want {
			t.Errorf("sdkAUQAnswered(%q, %q) = %v, want %v", c.agent, c.id, got, c.want)
		}
	}
	// Falls back to the session's stored agent id.
	agent := "agent-1"
	s.AgentSessionID = &agent
	if !m.sdkAUQAnswered(s, "", "toolu_done") {
		t.Error("want fallback to Session.AgentSessionID")
	}
}

func TestClearPrompt(t *testing.T) {
	h := "hint"
	m := &Manager{snap: map[string]Computed{"s": {
		TuiAuqData: map[string]any{"question": "Q?"}, TuiHint: &h,
		TuiPlanPending: true, TuiPlanData: map[string]any{"options": nil},
	}}}
	m.ClearPrompt("s", false)
	c := m.snap["s"]
	if c.TuiAuqData != nil || c.TuiHint != nil || !c.TuiPlanPending {
		t.Fatalf("AUQ clear: got %+v", c)
	}
	m.ClearPrompt("s", true)
	if c := m.snap["s"]; c.TuiPlanPending || c.TuiPlanData != nil {
		t.Fatalf("plan clear: got %+v", c)
	}
	m.ClearPrompt("missing", false) // no snapshot: no-op
}
