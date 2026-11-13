package jsonl

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A cold transcript over coldTailThreshold is answered from its tail at once,
// then completed by the background full parse.
func TestColdTailThenFill(t *testing.T) {
	path := filepath.Join(t.TempDir(), "big.jsonl")
	var b strings.Builder
	b.WriteString(`{"type":"user","timestamp":"2024-01-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"the title prompt"}]}}` + "\n")
	// An early plan outside the tail window: only the full parse sees it.
	b.WriteString(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"ExitPlanMode","id":"toolu_old","input":{"plan":"p"}}]}}` + "\n")
	pad := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"` + strings.Repeat("x", 4000) + `"}]}}` + "\n"
	for i := 0; b.Len() < coldTailThreshold+coldTailBytes; i++ {
		if i == 10 {
			b.WriteString(`{"type":"user","timestamp":"2024-01-01T10:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"middle prompt"}]}}` + "\n")
		}
		b.WriteString(pad)
	}
	// Tail: a pending plan and the last prompt.
	b.WriteString(`{"type":"user","timestamp":"2024-01-01T11:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"last prompt"}]}}` + "\n")
	b.WriteString(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"ExitPlanMode","id":"toolu_new","input":{"plan":"q"}}]}}` + "\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	c := NewCache()
	if !c.PlanPending(path) {
		t.Fatal("tail parse: expected pending plan")
	}
	e := c.acquire(path)
	if !e.partial {
		t.Fatal("expected partial entry after cold tail parse")
	}
	r := e.enrichLocked()
	e.mu.Unlock()
	if r.Title == nil || *r.Title != "the title prompt" {
		t.Fatalf("title from head = %v", r.Title)
	}
	if got := r.Prompts[len(r.Prompts)-1]; got != "last prompt" {
		t.Fatalf("last prompt = %q", got)
	}

	// Append while the fill may be running; the swap must include it.
	fh, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	fmt.Fprintln(fh, `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_new","content":"ok"}]}}`)
	fh.Close()

	deadline := time.Now().Add(30 * time.Second)
	for {
		e := c.acquire(path)
		done := !e.partial
		n := len(e.userMsgs)
		pending := len(e.planOutstanding)
		e.mu.Unlock()
		if done {
			if n != 3 {
				t.Fatalf("after fill: userMsgs=%d, want 3", n)
			}
			if pending != 1 { // toolu_old was never answered; toolu_new now is
				t.Fatalf("after fill: outstanding=%d, want 1", pending)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fill never completed")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Ready never parses inline: a cold large transcript reports not-ready and
// warms in the background; a small or missing one is ready at once.
func TestReadyWarmsInBackground(t *testing.T) {
	dir := t.TempDir()
	small := filepath.Join(dir, "small.jsonl")
	os.WriteFile(small, []byte(`{"type":"user","message":{"role":"user","content":"hi"}}`+"\n"), 0o644)
	big := filepath.Join(dir, "big.jsonl")
	line := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"` + strings.Repeat("y", 4000) + `"}]}}` + "\n"
	os.WriteFile(big, []byte(strings.Repeat(line, (enrichSyncLimit/len(line))+10)), 0o644)

	c := NewCache()
	if !c.Ready(small) || !c.Ready(filepath.Join(dir, "missing.jsonl")) || !c.Ready("") {
		t.Fatal("small/missing/empty path should be ready")
	}
	start := time.Now()
	if c.Ready(big) {
		t.Fatal("cold large transcript should not be ready")
	}
	if d := time.Since(start); d > 200*time.Millisecond {
		t.Fatalf("Ready blocked for %s", d)
	}
	deadline := time.Now().Add(30 * time.Second)
	for !c.Ready(big) {
		if time.Now().After(deadline) {
			t.Fatal("never became ready")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
