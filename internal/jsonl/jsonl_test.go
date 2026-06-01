package jsonl

import (
	"os"
	"path/filepath"
	"testing"
)

// writeJSONL writes lines (each already a JSON object) joined by newlines.
func writeJSONL(t *testing.T, lines []string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "session.jsonl")
	writeLines(t, p, lines)
	return p
}

func writeLines(t *testing.T, p string, lines []string) {
	t.Helper()
	var buf []byte
	for _, l := range lines {
		buf = append(buf, l...)
		buf = append(buf, '\n')
	}
	if err := os.WriteFile(p, buf, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func appendLine(t *testing.T, p, line string) {
	t.Helper()
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open append: %v", err)
	}
	defer f.Close()
	if _, err := f.WriteString(line + "\n"); err != nil {
		t.Fatalf("append: %v", err)
	}
}

const userLine = `{"type":"user","timestamp":"2024-01-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"first prompt"}]}}`
const asstToolLine = `{"type":"assistant","timestamp":"2024-01-01T10:00:01.000Z","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"the answer"}]}}`
const turnLine = `{"type":"system","subtype":"turn_duration","timestamp":"2024-01-01T10:00:02.000Z"}`

func TestTurnTimestampExtraction(t *testing.T) {
	p := writeJSONL(t, []string{userLine, asstToolLine, turnLine})
	st := scanFile(t, p)
	info := st.conv // not used; we test via direct full reader below

	_ = info
	// Use the full-file reader via a state replay helper.
	got := turnInfoFromFile(t, p, 0)
	if got.TurnTs == 0 {
		t.Fatalf("expected non-zero turn_ts")
	}
	// 2024-01-01T10:00:02Z = 1704103202
	if int64(got.TurnTs) != 1704103202 {
		t.Fatalf("turn_ts = %v, want 1704103202", got.TurnTs)
	}
	if got.LastSummary != "the answer" {
		t.Fatalf("last_summary = %q, want %q", got.LastSummary, "the answer")
	}
	if len(got.PromptsSince) != 1 || got.PromptsSince[0].Text != "first prompt" {
		t.Fatalf("prompts_since = %+v", got.PromptsSince)
	}
}

func TestPromptExtraction(t *testing.T) {
	second := `{"type":"user","timestamp":"2024-01-01T10:05:00.000Z","message":{"role":"user","content":[{"type":"text","text":"second prompt"}]}}`
	toolResult := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ignored"}]}}`
	p := writeJSONL(t, []string{userLine, toolResult, asstToolLine, second})

	res := enrichFile(t, p)
	if res.Title == nil || *res.Title != "first prompt" {
		t.Fatalf("title = %v", res.Title)
	}
	if len(res.Prompts) != 2 || res.Prompts[0] != "first prompt" || res.Prompts[1] != "second prompt" {
		t.Fatalf("prompts = %v", res.Prompts)
	}
	if res.LastUserInputAt == nil || *res.LastUserInputAt != "2024-01-01T10:05:00.000Z" {
		t.Fatalf("last_user_input_at = %v", res.LastUserInputAt)
	}
}

func TestAUQParse(t *testing.T) {
	ask := `{"type":"assistant","timestamp":"2024-01-01T11:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"auq-1","name":"AskUserQuestion","input":{"questions":[{"question":"Pick one","header":"Choice","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}]}}]}}`
	answer := `{"type":"user","timestamp":"2024-01-01T11:01:00.000Z","toolUseResult":{"answers":{"Pick one":"A"}},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"auq-1","content":"ok"}]}}`
	p := writeJSONL(t, []string{ask, answer})

	auqs := auqsFromFile(t, p)
	if len(auqs) != 1 {
		t.Fatalf("expected 1 auq, got %d", len(auqs))
	}
	a := auqs[0]
	if a.ToolUseID != "auq-1" {
		t.Fatalf("tool_use_id = %q", a.ToolUseID)
	}
	if a.AnsweredTs == nil {
		t.Fatalf("expected answered_ts set")
	}
	if a.Answers["Pick one"] != "A" {
		t.Fatalf("answers = %v", a.Answers)
	}
	if len(a.Questions) != 1 || a.Questions[0]["question"] != "Pick one" {
		t.Fatalf("questions = %+v", a.Questions)
	}
}

func TestPlanPendingDetection(t *testing.T) {
	exitPlan := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"plan-1","name":"ExitPlanMode","input":{"plan":"do stuff"}}]}}`
	// Pending: no tool_result yet.
	p := writeJSONL(t, []string{userLine, exitPlan})
	if !planPendingFromFile(t, p) {
		t.Fatalf("expected plan pending")
	}
	// Resolved: tool_result matches.
	resolve := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"plan-1","content":"User has approved your plan"}]}}`
	p2 := writeJSONL(t, []string{userLine, exitPlan, resolve})
	if planPendingFromFile(t, p2) {
		t.Fatalf("expected plan NOT pending after tool_result")
	}
}

func TestGoalsExtraction(t *testing.T) {
	sentinel := `{"type":"attachment","timestamp":"2024-01-01T12:00:00.000Z","attachment":{"type":"goal_status","condition":"tests pass","sentinel":true,"met":false}}`
	evalNotMet := `{"type":"attachment","timestamp":"2024-01-01T12:01:00.000Z","attachment":{"type":"goal_status","condition":"tests pass","met":false,"reason":"still failing"}}`
	p := writeJSONL(t, []string{sentinel, evalNotMet})

	res := goalsFromFile(t, p)
	if res.Active == nil {
		t.Fatalf("expected active goal")
	}
	if res.Active.Condition != "tests pass" || res.Active.Checks != 1 {
		t.Fatalf("active = %+v", res.Active)
	}
	if res.Active.LastReason == nil || *res.Active.LastReason != "still failing" {
		t.Fatalf("last_reason = %v", res.Active.LastReason)
	}

	// Met → moves to history.
	evalMet := `{"type":"attachment","timestamp":"2024-01-01T12:02:00.000Z","attachment":{"type":"goal_status","condition":"tests pass","met":true,"reason":"all green"}}`
	p2 := writeJSONL(t, []string{sentinel, evalNotMet, evalMet})
	res2 := goalsFromFile(t, p2)
	if res2.Active != nil {
		t.Fatalf("expected no active goal after met")
	}
	if len(res2.History) != 1 || !res2.History[0].Met {
		t.Fatalf("history = %+v", res2.History)
	}
}

func TestTodosExtraction(t *testing.T) {
	todoWrite := `{"type":"assistant","timestamp":"2024-01-01T13:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"TodoWrite","input":{"todos":[{"content":"task one","status":"in_progress"},{"content":"task two","status":"pending"}]}}]}}`
	p := writeJSONL(t, []string{todoWrite})
	res := todosFromFile(t, p)
	if len(res.Active) != 2 {
		t.Fatalf("active = %+v", res.Active)
	}
	if res.Active[0].Content != "task one" || res.Active[0].Status != "in_progress" {
		t.Fatalf("active[0] = %+v", res.Active[0])
	}

	// All completed → not active, goes to history.
	done := `{"type":"assistant","timestamp":"2024-01-01T13:01:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"TodoWrite","input":{"todos":[{"content":"task one","status":"completed"},{"content":"task two","status":"completed"}]}}]}}`
	p2 := writeJSONL(t, []string{todoWrite, done})
	res2 := todosFromFile(t, p2)
	if len(res2.Active) != 0 {
		t.Fatalf("expected no active, got %+v", res2.Active)
	}
	if len(res2.History) != 1 || len(res2.History[0].Todos) != 2 {
		t.Fatalf("history = %+v", res2.History)
	}
}

func TestConversationParse(t *testing.T) {
	p := writeJSONL(t, []string{userLine, asstToolLine, turnLine})
	turns := convFromFile(t, p, 0)
	if len(turns) != 2 {
		t.Fatalf("expected 2 turns, got %d: %+v", len(turns), turns)
	}
	if turns[0].Role != "user" || turns[0].Text != "first prompt" {
		t.Fatalf("turn0 = %+v", turns[0])
	}
	if turns[1].Role != "assistant" || turns[1].Text != "the answer" {
		t.Fatalf("turn1 = %+v", turns[1])
	}
	// Confirmed turns carry the turn_duration ts.
	if int64(turns[0].Ts) != 1704103202 {
		t.Fatalf("turn0 ts = %v", turns[0].Ts)
	}
}

// TestIncrementalAppend asserts that after appending a line, the cache returns
// updated derived state, and that only the appended bytes are parsed (the
// byte offset advances, not resetting to 0).
func TestIncrementalAppend(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "session.jsonl")

	// 2-line file: user prompt + assistant + turn marker.
	writeLines(t, p, []string{userLine, asstToolLine, turnLine})

	c := NewCache()
	turns := c.Conversation(p, 0)
	if len(turns) != 2 {
		t.Fatalf("initial: expected 2 turns, got %d", len(turns))
	}

	c.mu.Lock()
	e := c.entries[p]
	offsetAfterFirst := e.offset
	confirmedAfterFirst := len(e.conv.confirmed)
	c.mu.Unlock()
	if offsetAfterFirst == 0 {
		t.Fatalf("expected non-zero offset after first parse")
	}

	// Append a second exchange.
	secondUser := `{"type":"user","timestamp":"2024-01-01T10:10:00.000Z","message":{"role":"user","content":[{"type":"text","text":"second prompt"}]}}`
	secondAsst := `{"type":"assistant","timestamp":"2024-01-01T10:10:01.000Z","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"second answer"}]}}`
	secondTurn := `{"type":"system","subtype":"turn_duration","timestamp":"2024-01-01T10:10:02.000Z"}`
	appendLine(t, p, secondUser)
	appendLine(t, p, secondAsst)
	appendLine(t, p, secondTurn)

	turns2 := c.Conversation(p, 0)
	if len(turns2) != 4 {
		t.Fatalf("after append: expected 4 turns, got %d: %+v", len(turns2), turns2)
	}
	if turns2[3].Text != "second answer" {
		t.Fatalf("turn3 = %+v", turns2[3])
	}

	c.mu.Lock()
	e2 := c.entries[p]
	c.mu.Unlock()
	// Offset must have advanced past the first parse (incremental, not reset).
	if e2.offset <= offsetAfterFirst {
		t.Fatalf("offset did not advance: before=%d after=%d", offsetAfterFirst, e2.offset)
	}
	// The first two confirmed turns were retained, not re-parsed from scratch
	// (count grew by exactly the new confirmed turns).
	if len(e2.conv.confirmed) != confirmedAfterFirst+2 {
		t.Fatalf("confirmed grew unexpectedly: before=%d after=%d", confirmedAfterFirst, len(e2.conv.confirmed))
	}

	// Cache hit on unchanged file: offset stable, same result.
	turns3 := c.Conversation(p, 0)
	c.mu.Lock()
	e3 := c.entries[p]
	c.mu.Unlock()
	if e3.offset != e2.offset {
		t.Fatalf("offset changed on cache hit: %d -> %d", e2.offset, e3.offset)
	}
	if len(turns3) != 4 {
		t.Fatalf("cache hit returned %d turns", len(turns3))
	}
}

// TestIncrementalMatchesOneShot verifies the cache derives the same goals/todos
// as the one-shot readers after an append.
func TestIncrementalMatchesOneShot(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "session.jsonl")
	sentinel := `{"type":"attachment","timestamp":"2024-01-01T12:00:00.000Z","attachment":{"type":"goal_status","condition":"ship it","sentinel":true,"met":false}}`
	writeLines(t, p, []string{sentinel})

	c := NewCache()
	g1 := c.Goals(p)
	if g1.Active == nil || g1.Active.Condition != "ship it" {
		t.Fatalf("g1 = %+v", g1)
	}

	met := `{"type":"attachment","timestamp":"2024-01-01T12:05:00.000Z","attachment":{"type":"goal_status","condition":"ship it","met":true,"reason":"done"}}`
	appendLine(t, p, met)

	gCache := c.Goals(p)
	gFull := goalsFromFile(t, p)
	if (gCache.Active == nil) != (gFull.Active == nil) {
		t.Fatalf("active mismatch: cache=%+v full=%+v", gCache.Active, gFull.Active)
	}
	if len(gCache.History) != len(gFull.History) || len(gCache.History) != 1 {
		t.Fatalf("history mismatch: cache=%d full=%d", len(gCache.History), len(gFull.History))
	}
	if !gCache.History[0].Met {
		t.Fatalf("cache goal not met: %+v", gCache.History[0])
	}
}

// ── test helpers wrapping the one-shot readers without path resolution ──────

func scanFile(t *testing.T, p string) *cacheEntry {
	t.Helper()
	c := NewCache()
	c.mu.Lock()
	e := c.sync(p)
	c.mu.Unlock()
	if e == nil {
		t.Fatalf("sync returned nil for %s", p)
	}
	return e
}

func enrichFile(t *testing.T, p string) EnrichResult {
	t.Helper()
	res, err := enrichFromFile(p)
	if err != nil {
		t.Fatalf("enrich: %v", err)
	}
	return res
}

func turnInfoFromFile(t *testing.T, p string, since float64) TurnInfo {
	t.Helper()
	// GetLatestTurnInfo needs path resolution; replay via cache conv is not
	// equivalent, so parse directly with a local scan mirroring the reader.
	info, err := getLatestTurnInfoPath(p, since)
	if err != nil {
		t.Fatalf("turninfo: %v", err)
	}
	return info
}

func auqsFromFile(t *testing.T, p string) []AUQ {
	t.Helper()
	auqs, err := listAUQsPath(p)
	if err != nil {
		t.Fatalf("auqs: %v", err)
	}
	return auqs
}

func planPendingFromFile(t *testing.T, p string) bool {
	t.Helper()
	c := NewCache()
	return c.PlanPending(p)
}

func goalsFromFile(t *testing.T, p string) GoalsResult {
	t.Helper()
	res, err := readGoalsPath(p)
	if err != nil {
		t.Fatalf("goals: %v", err)
	}
	return res
}

func todosFromFile(t *testing.T, p string) TodoPlansResult {
	t.Helper()
	res, err := getTodoPlansPath(p)
	if err != nil {
		t.Fatalf("todos: %v", err)
	}
	return res
}

func convFromFile(t *testing.T, p string, from float64) []ConversationTurn {
	t.Helper()
	c := NewCache()
	return c.Conversation(p, from)
}

// TestReadRawMessagesTail checks the reverse-scan reader matches the forward
// ReadRawMessagesPage window and total, across newline edge cases and large lines.
func TestReadRawMessagesTail(t *testing.T) {
	// Monotonically increasing timestamps (real transcripts never repeat a ts on
	// the scale that would reorder the window): mm:ss derived from i.
	mk := func(i int) string {
		mm := i / 60
		ss := i % 60
		ts := "2024-01-01T10:" +
			string(rune('0'+mm/10)) + string(rune('0'+mm%10)) + ":" +
			string(rune('0'+ss/10)) + string(rune('0'+ss%10)) + ".000Z"
		return `{"type":"user","timestamp":"` + ts +
			`","message":{"role":"user","content":[{"type":"text","text":"m` +
			string(rune('a'+i%26)) + `"}]}}`
	}
	var lines []string
	for i := 0; i < 500; i++ {
		lines = append(lines, mk(i))
	}

	cases := []struct {
		name    string
		trailNL bool
		tail    int
	}{
		{"trailing-newline-tail-100", true, 100},
		{"no-trailing-newline-tail-100", false, 100},
		{"tail-larger-than-file", true, 1000},
		{"tail-1", true, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, "s.jsonl")
			var buf []byte
			for i, l := range lines {
				buf = append(buf, l...)
				if c.trailNL || i < len(lines)-1 {
					buf = append(buf, '\n')
				}
			}
			if err := os.WriteFile(p, buf, 0o644); err != nil {
				t.Fatal(err)
			}
			win, total, err := ReadRawMessagesTail(p, c.tail)
			if err != nil {
				t.Fatal(err)
			}
			page := ReadRawMessagesPage(p, c.tail)
			if total != len(lines) {
				t.Errorf("total=%d want %d", total, len(lines))
			}
			if len(win) != len(page.Messages) {
				t.Fatalf("window len rev=%d fwd=%d", len(win), len(page.Messages))
			}
			for i := range win {
				if string(win[i]) != string(page.Messages[i]) {
					t.Fatalf("entry %d differs:\n rev=%s\n fwd=%s", i, win[i], page.Messages[i])
				}
			}
		})
	}
}

// TestReadRawMessagesTailLargeLines ensures lines bigger than the reverse-read
// chunk (64KB) are recovered whole.
func TestReadRawMessagesTailLargeLines(t *testing.T) {
	big := make([]byte, 200*1024)
	for i := range big {
		big[i] = 'x'
	}
	lines := []string{
		`{"type":"user","timestamp":"2024-01-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"small"}]}}`,
		`{"type":"assistant","timestamp":"2024-01-01T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"` + string(big) + `"}]}}`,
		`{"type":"user","timestamp":"2024-01-01T10:00:02.000Z","message":{"role":"user","content":[{"type":"text","text":"last"}]}}`,
	}
	p := writeJSONL(t, lines)
	win, total, err := ReadRawMessagesTail(p, 2)
	if err != nil {
		t.Fatal(err)
	}
	if total != 3 {
		t.Errorf("total=%d want 3", total)
	}
	if len(win) != 2 {
		t.Fatalf("window len=%d want 2", len(win))
	}
	if len(win[0]) < 200*1024 {
		t.Errorf("large line truncated: %d bytes", len(win[0]))
	}
}
