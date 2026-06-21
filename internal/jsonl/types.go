// Package jsonl ports the Claude/Cursor JSONL conversation readers from the
// Python ClaudeManager service. It locates a session's JSONL file under
// ~/.claude/projects (or ~/.cursor/projects), and extracts derived state used
// by the frontend: titles, recent prompts, latest completed-turn info, goals,
// AskUserQuestion (AUQ) history, TodoWrite/Task plans, plan-pending detection,
// and the full conversation bubble list.
//
// The headline feature over the Python original is an incremental parser
// (see cache.go): an in-memory cache keyed by file path, invalidated by
// (size, mtime). On a cache hit with unchanged size it returns cached derived
// state; when the file grew it parses only the appended bytes from the last
// byte offset. This replaces the Python full-file re-parse + 30s TTL.
package jsonl

import "encoding/json"

// rawEntry is a single decoded JSONL line. JSONL records are heterogeneous, so
// fields that vary by entry type are decoded lazily via the message/attachment
// helpers below.
type rawEntry struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	Timestamp string          `json:"timestamp"`
	UUID      string          `json:"uuid"`
	Cwd       string          `json:"cwd"`
	Operation string          `json:"operation"` // queue-operation
	Content   rawJSON         `json:"content"`   // queue-operation enqueue content (string)
	Message   *rawMessage     `json:"message"`
	Attachment *rawAttachment `json:"attachment"`
	// toolUseResult lives at the top level on user tool_result entries (AUQ
	// answers). It is POLYMORPHIC: an object ({answers}/{plan,...}) on success
	// but a plain STRING ("Error: ...") when the tool errored. Decode it lazily
	// (rawJSON) so a string value can't fail the whole line — a rigid struct
	// type here made decodeLine reject every errored tool_result entry, which
	// silently dropped it from all derivations (e.g. an unclosed ExitPlanMode →
	// phantom pending plan). See answers().
	ToolUseResult rawJSON `json:"toolUseResult"`
	// Cursor entries use a top-level role rather than message.role.
	Role string `json:"role"`
}

// rawJSON defers decoding so a field that is sometimes a string and sometimes
// a list/object does not break the whole line.
type rawJSON = json.RawMessage

type rawMessage struct {
	Role       string       `json:"role"`
	StopReason *string      `json:"stop_reason"`
	Content    rawJSON      `json:"content"` // string OR []contentBlock
	// Model and Usage appear on assistant lines; both zero-value-safe and unused
	// by existing derivations. Consumed by subagentState (token accounting).
	Model string    `json:"model"`
	Usage *rawUsage `json:"usage"`
}

// rawUsage is the per-message token accounting carried on assistant lines.
type rawUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
}

type contentBlock struct {
	Type      string  `json:"type"` // text, tool_use, tool_result
	Text      string  `json:"text"`
	Name      string  `json:"name"`       // tool_use name
	ID        string  `json:"id"`         // tool_use id
	ToolUseID string  `json:"tool_use_id"` // tool_result link
	Input     rawJSON `json:"input"`      // tool_use input
	IsError   bool    `json:"is_error"`   // tool_result error flag (→ subagent failed)
}

type rawAttachment struct {
	Type string `json:"type"`
	// goal_status fields
	Condition string `json:"condition"`
	Met       bool   `json:"met"`
	Reason    string `json:"reason"`
	Sentinel  bool   `json:"sentinel"`
	// task_reminder content: []taskItem
	Content rawJSON `json:"content"`
}

type rawToolUseResult struct {
	Answers map[string]string `json:"answers"`
}

// toolUseResultAnswers decodes the (polymorphic) top-level toolUseResult and
// returns its AUQ answers, or nil when it is absent, a string (errored tool), or
// otherwise has no answers. Never fails the caller.
func (d *rawEntry) toolUseResultAnswers() map[string]string {
	if len(d.ToolUseResult) == 0 {
		return nil
	}
	var r rawToolUseResult
	if err := json.Unmarshal(d.ToolUseResult, &r); err != nil {
		return nil
	}
	return r.Answers
}

// ── Public result types ─────────────────────────────────────────────────────

// EnrichResult mirrors enrich_session: {title, prompts, search_text, last_user_input_at}.
type EnrichResult struct {
	Title           *string  `json:"title"`
	Prompts         []string `json:"prompts"`
	SearchText      []string `json:"search_text"`
	LastUserInputAt *string  `json:"last_user_input_at"`
}

// PromptSince is one entry of get_latest_turn_info.prompts_since.
type PromptSince struct {
	Text    string  `json:"text"`
	Ts      float64 `json:"ts"`
	TimeStr string  `json:"time_str"`
}

// TurnInfo mirrors get_latest_turn_info.
type TurnInfo struct {
	TurnTs       float64       `json:"turn_ts"`
	LastSummary  string        `json:"last_summary"`
	PromptsSince []PromptSince `json:"prompts_since"`
}

// Goal mirrors a claude_goals.py Goal record.
type Goal struct {
	Condition  string   `json:"condition"`
	SetAt      float64  `json:"set_at"`
	Met        bool     `json:"met"`
	MetAt      *float64 `json:"met_at"`
	LastReason *string  `json:"last_reason"`
	Checks     int      `json:"checks"`
	Replaced   bool     `json:"replaced"`
}

// GoalsResult mirrors read_goals: {active, history}.
type GoalsResult struct {
	Active  *Goal  `json:"active"`
	History []Goal `json:"history"`
}

// Question is one AUQ question (input.questions[*]). Options/extra fields are
// preserved verbatim so the frontend sees the same shape as the Python dict.
type Question map[string]any

// AUQ mirrors a list_auqs item.
type AUQ struct {
	ToolUseID  string            `json:"tool_use_id"`
	Ts         float64           `json:"ts"`
	AnsweredTs *float64          `json:"answered_ts"`
	Questions  []Question        `json:"questions"`
	Answers    map[string]string `json:"answers"`
}

// Todo mirrors a single normalized todo/task item.
type Todo struct {
	ID         any     `json:"id,omitempty"`
	Content    string  `json:"content"`
	Description *string `json:"description,omitempty"`
	ActiveForm  *string `json:"activeForm,omitempty"`
	Status      string  `json:"status"`
	Priority    *string `json:"priority,omitempty"`
}

// TodoPlan is one historical plan group.
type TodoPlan struct {
	Todos       []Todo  `json:"todos"`
	CreatedTs   float64 `json:"created_ts"`
	CompletedTs float64 `json:"completed_ts"`
}

// TodoPlansResult mirrors get_todo_plans: {active, history}.
type TodoPlansResult struct {
	Active  []Todo     `json:"active"`
	History []TodoPlan `json:"history"`
}

// ConversationTurn is one chat bubble. JSON field names match the Python dicts
// built in get_conversation so the API/frontend shape is unchanged.
type ConversationTurn struct {
	Role      string  `json:"role"`
	Text      string  `json:"text"`
	Streaming bool    `json:"streaming"`
	Ts        float64 `json:"ts"`
	// Compacting is only set on compaction-phase bubbles.
	Compacting bool `json:"compacting,omitempty"`
}
