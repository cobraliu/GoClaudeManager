package jsonl

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"time"
)

func strPtr(s string) *string { return &s }

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Byte truncation matches the Python slice semantics closely enough for
	// these display fields; guard against splitting a UTF-8 rune.
	for n > 0 && !utf8Start(s[n]) {
		n--
	}
	return s[:n]
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

// EnrichSession is the one-shot port of enrich_session: a single-pass reader
// returning {title, prompts, search_text, last_user_input_at}. Title is the
// first user prompt (≤80 chars); prompts is [first, last] (≤200 chars each).
func EnrichSession(claudeSessionID, cwd string) (EnrichResult, error) {
	jsonlPath := FindSessionJSONL(claudeSessionID, cwd)
	if jsonlPath == "" {
		return EnrichResult{Prompts: []string{}, SearchText: []string{}}, nil
	}
	return enrichFromFile(jsonlPath)
}

func enrichFromFile(jsonlPath string) (EnrichResult, error) {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return EnrichResult{Prompts: []string{}, SearchText: []string{}}, err
	}
	defer f.Close()

	var userMsgs []string
	var userTimestamps []string
	var allTexts []string

	sc := newScanner(f)
	for sc.Scan() {
		d, ok := decodeLine(sc.Bytes())
		if !ok {
			continue
		}
		switch {
		case isUserMessage(&d):
			text := extractText(d.Message)
			if text == "" || isCompactMessage(text) {
				continue
			}
			allTexts = append(allTexts, truncate(text, 500))
			userMsgs = append(userMsgs, text)
			if d.Timestamp != "" {
				userTimestamps = append(userTimestamps, d.Timestamp)
			}
		case d.Type == "queue-operation" && d.Operation == "enqueue":
			content := d.queueContentString()
			if content != "" && !isCompactMessage(content) {
				allTexts = append(allTexts, truncate(content, 500))
				userMsgs = append(userMsgs, content)
			}
		case d.Type == "assistant":
			text := extractText(d.Message)
			if text != "" {
				allTexts = append(allTexts, truncate(text, 500))
			}
		}
	}

	res := EnrichResult{Prompts: []string{}, SearchText: allTexts}
	if res.SearchText == nil {
		res.SearchText = []string{}
	}
	if len(userMsgs) > 0 {
		res.Title = strPtr(truncate(userMsgs[0], 80))
		res.Prompts = append(res.Prompts, truncate(userMsgs[0], 200))
		if len(userMsgs) >= 2 {
			res.Prompts = append(res.Prompts, truncate(userMsgs[len(userMsgs)-1], 200))
		}
	}
	if len(userTimestamps) > 0 {
		res.LastUserInputAt = strPtr(userTimestamps[len(userTimestamps)-1])
	}
	return res, sc.Err()
}

// GetLatestTurnInfo ports get_latest_turn_info: scans turn_duration system
// entries, returning the max turn timestamp, the assistant text from the latest
// turn, and the prompts for every turn whose ts > sinceTs. Always reads from
// disk (no cache) for real-time watchdog use.
func GetLatestTurnInfo(claudeSessionID, cwd string, sinceTs float64) (TurnInfo, error) {
	jsonlPath := FindSessionJSONL(claudeSessionID, cwd)
	if jsonlPath == "" {
		return TurnInfo{PromptsSince: []PromptSince{}}, nil
	}
	return getLatestTurnInfoPath(jsonlPath, sinceTs)
}

func getLatestTurnInfoPath(jsonlPath string, sinceTs float64) (TurnInfo, error) {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return TurnInfo{PromptsSince: []PromptSince{}}, err
	}
	defer f.Close()

	var maxTs float64
	lastText := ""
	promptsSince := []PromptSince{}
	pendingUserPrompt := ""
	var pendingQueued []string
	pendingAssistant := ""

	sc := newScanner(f)
	for sc.Scan() {
		d, ok := decodeLine(sc.Bytes())
		if !ok {
			continue
		}
		switch {
		case isUserMessage(&d):
			t := extractText(d.Message)
			if t != "" && !isCompactMessage(t) {
				pendingUserPrompt = t
			}
		case d.Type == "queue-operation" && d.Operation == "enqueue":
			content := d.queueContentString()
			if content != "" && !isCompactMessage(content) {
				pendingQueued = append(pendingQueued, content)
			}
		case d.Type == "assistant":
			text := extractText(d.Message)
			if text != "" {
				pendingAssistant = text
			}
		case isTurnComplete(&d):
			ts := parseISOTs(d.Timestamp)
			if ts > maxTs {
				maxTs = ts
				if pendingAssistant != "" {
					lastText = pendingAssistant
				}
			}
			if ts > sinceTs {
				timeStr := ""
				if ts != 0 {
					timeStr = time.Unix(int64(ts), 0).Format("060102 15:04:05")
				}
				var all []string
				if pendingUserPrompt != "" {
					all = append(all, pendingUserPrompt)
				}
				all = append(all, pendingQueued...)
				for _, pt := range all {
					promptsSince = append(promptsSince, PromptSince{Text: pt, Ts: ts, TimeStr: timeStr})
				}
			}
			pendingAssistant = ""
			pendingUserPrompt = ""
			pendingQueued = nil
		}
	}
	return TurnInfo{TurnTs: maxTs, LastSummary: lastText, PromptsSince: promptsSince}, sc.Err()
}

// ── Goals ────────────────────────────────────────────────────────────────────

// ReadGoals ports read_goals (full scan). Returns {active, history}.
func ReadGoals(claudeSessionID, cwd string) (GoalsResult, error) {
	jsonlPath := FindSessionJSONL(claudeSessionID, cwd)
	if jsonlPath == "" {
		return GoalsResult{History: []Goal{}}, nil
	}
	return readGoalsPath(jsonlPath)
}

func readGoalsPath(jsonlPath string) (GoalsResult, error) {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return GoalsResult{History: []Goal{}}, err
	}
	defer f.Close()

	st := newGoalState()
	sc := newScanner(f)
	for sc.Scan() {
		line := sc.Bytes()
		if !containsBytes(line, "goal_status") {
			continue
		}
		d, ok := decodeLine(line)
		if !ok {
			continue
		}
		st.feed(&d)
	}
	return st.result(), sc.Err()
}

// goalState accumulates goal records; reused by the incremental cache.
type goalState struct {
	goals   []Goal
	current *Goal
}

func newGoalState() *goalState { return &goalState{goals: []Goal{}} }

func (s *goalState) closeCurrent(replaced bool) {
	if s.current != nil {
		if replaced && !s.current.Met {
			s.current.Replaced = true
		}
		s.goals = append(s.goals, *s.current)
		s.current = nil
	}
}

func (s *goalState) feed(d *rawEntry) {
	if d.Type != "attachment" || d.Attachment == nil || d.Attachment.Type != "goal_status" {
		return
	}
	att := d.Attachment
	ts := parseISOTs(d.Timestamp)

	if att.Sentinel {
		s.closeCurrent(true)
		s.current = &Goal{Condition: att.Condition}
		s.current.SetAt = ts
		return
	}
	// Per-turn evaluation: must belong to the active goal.
	if s.current == nil || s.current.Condition != att.Condition {
		// Defensive orphan eval → standalone closed goal.
		g := Goal{Condition: att.Condition, SetAt: ts, Met: att.Met, Checks: 1}
		if att.Met {
			t := ts
			g.MetAt = &t
		}
		if att.Reason != "" {
			r := att.Reason
			g.LastReason = &r
		}
		s.goals = append(s.goals, g)
		return
	}
	s.current.Checks++
	if att.Reason != "" {
		r := att.Reason
		s.current.LastReason = &r
	}
	if att.Met {
		s.current.Met = true
		t := ts
		s.current.MetAt = &t
		s.closeCurrent(false)
	}
}

func (s *goalState) result() GoalsResult {
	hist := s.goals
	if hist == nil {
		hist = []Goal{}
	}
	var active *Goal
	if s.current != nil {
		c := *s.current
		active = &c
	}
	return GoalsResult{Active: active, History: hist}
}

func (s *goalState) clone() *goalState {
	cp := &goalState{goals: append([]Goal(nil), s.goals...)}
	if s.current != nil {
		c := *s.current
		cp.current = &c
	}
	return cp
}

// ── AUQs ─────────────────────────────────────────────────────────────────────

// ListAUQs ports list_auqs: all AskUserQuestion rounds in chronological order.
func ListAUQs(claudeSessionID, cwd string) ([]AUQ, error) {
	jsonlPath := FindSessionJSONL(claudeSessionID, cwd)
	if jsonlPath == "" {
		return []AUQ{}, nil
	}
	return listAUQsPath(jsonlPath)
}

func listAUQsPath(jsonlPath string) ([]AUQ, error) {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return []AUQ{}, err
	}
	defer f.Close()

	asks := map[string]*AUQ{}
	var order []string

	sc := newScanner(f)
	for sc.Scan() {
		d, ok := decodeLine(sc.Bytes())
		if !ok {
			continue
		}
		switch d.Type {
		case "assistant":
			if d.Message == nil {
				continue
			}
			for _, b := range d.Message.blocks() {
				if b.Type != "tool_use" || b.Name != "AskUserQuestion" {
					continue
				}
				tuid := b.ID
				if tuid == "" {
					continue
				}
				if _, seen := asks[tuid]; seen {
					continue
				}
				questions := decodeQuestions(b.Input)
				asks[tuid] = &AUQ{ToolUseID: tuid, Ts: parseISOTs(d.Timestamp), Questions: questions}
				order = append(order, tuid)
			}
		case "user":
			if d.Message == nil {
				continue
			}
			matched := ""
			for _, b := range d.Message.blocks() {
				if b.Type == "tool_result" && b.ToolUseID != "" {
					if _, ok := asks[b.ToolUseID]; ok {
						matched = b.ToolUseID
						break
					}
				}
			}
			if matched == "" {
				continue
			}
			ts := parseISOTs(d.Timestamp)
			asks[matched].AnsweredTs = &ts
			if d.ToolUseResult != nil && d.ToolUseResult.Answers != nil {
				asks[matched].Answers = d.ToolUseResult.Answers
			}
		}
	}

	out := make([]AUQ, 0, len(order))
	for _, tuid := range order {
		out = append(out, *asks[tuid])
	}
	return out, sc.Err()
}

// decodeQuestions decodes input.questions, which may be a list or a
// JSON-encoded string. Each question is preserved as a free-form map so all
// option metadata (header, multiSelect, options, free-text flags) survives.
func decodeQuestions(input rawJSON) []Question {
	if len(input) == 0 {
		return []Question{}
	}
	var wrapper struct {
		Questions json.RawMessage `json:"questions"`
	}
	if err := json.Unmarshal(input, &wrapper); err != nil || len(wrapper.Questions) == 0 {
		return []Question{}
	}
	raw := wrapper.Questions
	// Sometimes a JSON-encoded string.
	var asStr string
	if err := json.Unmarshal(raw, &asStr); err == nil {
		raw = json.RawMessage(asStr)
	}
	var qs []Question
	if err := json.Unmarshal(raw, &qs); err != nil {
		return []Question{}
	}
	if qs == nil {
		return []Question{}
	}
	return qs
}

// ── Plan pending ───────────────────────────────────────────────────────────

// PlanPending ports _pending_plan_from_jsonl (full scan): True iff there is an
// ExitPlanMode tool_use whose id has neither a matching tool_result nor a
// subsequent plan_mode_exit attachment.
func PlanPending(claudeSessionID, cwd string) (bool, error) {
	jsonlPath := FindSessionJSONL(claudeSessionID, cwd)
	if jsonlPath == "" {
		return false, nil
	}
	f, err := os.Open(jsonlPath)
	if err != nil {
		return false, err
	}
	defer f.Close()

	outstanding := map[string]struct{}{}
	sc := newScanner(f)
	for sc.Scan() {
		feedPlanLine(sc.Bytes(), outstanding)
	}
	return len(outstanding) > 0, sc.Err()
}

// feedPlanLine updates the outstanding ExitPlanMode-id set from one line.
func feedPlanLine(line []byte, outstanding map[string]struct{}) {
	if !containsBytes(line, "ExitPlanMode") &&
		!containsBytes(line, `"tool_result"`) &&
		!containsBytes(line, "plan_mode") {
		return
	}
	d, ok := decodeLine(line)
	if !ok {
		return
	}
	if d.Type == "attachment" && d.Attachment != nil && d.Attachment.Type == "plan_mode_exit" {
		for k := range outstanding {
			delete(outstanding, k)
		}
		return
	}
	if d.Message == nil {
		return
	}
	for _, b := range d.Message.blocks() {
		switch {
		case b.Type == "tool_use" && b.Name == "ExitPlanMode":
			if b.ID != "" {
				outstanding[b.ID] = struct{}{}
			}
		case b.Type == "tool_result":
			if b.ToolUseID != "" {
				delete(outstanding, b.ToolUseID)
			}
		}
	}
}

func containsBytes(b []byte, sub string) bool {
	return strings.Contains(byteString(b), sub)
}

// byteString is an unsafe-free helper kept simple; strings.Contains over a
// converted slice is fine here since lines are bounded at 16MB and pre-filtered.
func byteString(b []byte) string { return string(b) }

// parseID coerces an id field to a comparable string ("" for nil).
func parseID(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return ""
	}
}
