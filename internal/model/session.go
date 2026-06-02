package model

// SessionStatus enumerates the session lifecycle states (matches Python
// SessionStatus enum values).
type SessionStatus = string

const (
	StatusCreating   SessionStatus = "creating"
	StatusRunning    SessionStatus = "running"
	StatusDetached   SessionStatus = "detached"
	StatusArchived   SessionStatus = "archived"
	StatusTerminated SessionStatus = "terminated"
)

// AllowedTransitions mirrors session_store._ALLOWED_TRANSITIONS.
var AllowedTransitions = map[SessionStatus]map[SessionStatus]bool{
	StatusCreating: {StatusRunning: true, StatusTerminated: true},
	StatusRunning:  {StatusDetached: true, StatusArchived: true, StatusTerminated: true},
	StatusDetached: {StatusRunning: true, StatusArchived: true, StatusTerminated: true},
	StatusArchived: {StatusRunning: true, StatusTerminated: true},
	StatusTerminated: {StatusRunning: true}, // resume
}

// Session mirrors pydantic SessionMetadata. Pointers model Python's
// Optional[...] (serialized as JSON null, matching pydantic's default output).
type Session struct {
	ID               string            `json:"id"`
	OwnerID          string            `json:"owner_id"`
	Name             string            `json:"name"`
	Project          string            `json:"project"`
	Cwd              string            `json:"cwd"`
	Env              map[string]string `json:"env"`
	Model            *string           `json:"model"`
	Tool             string            `json:"tool"`
	Status           SessionStatus     `json:"status"`
	CreatedAt        ISOTime           `json:"created_at"`
	UpdatedAt        ISOTime           `json:"updated_at"`
	AttachedClients  int               `json:"attached_clients"`
	LastOutputOffset int64             `json:"last_output_offset"`
	LastActivityAt   *ISOTime          `json:"last_activity_at"`
	LastTurnAt       *ISOTime          `json:"last_turn_at"`
	WsToken          *string           `json:"ws_token"`
	TmuxSessionName  string            `json:"tmux_session_name"`
	ResumeSessionID  *string           `json:"resume_session_id"`
	AgentSessionID   *string           `json:"agent_session_id"`
	ClaudeProcPID    *int              `json:"claude_proc_pid"`
	CodexTransport   string            `json:"codex_transport"`
	CodexAppserverPID  *int            `json:"codex_appserver_pid"`
	CodexAppserverPort *int            `json:"codex_appserver_port"`
	GitAutoCommit    bool              `json:"git_auto_commit"`
	GitCommitMsgCount int              `json:"git_commit_msg_count"`
	GitRepoURL       *string           `json:"git_repo_url"`
}

// TaskView mirrors pydantic TaskView (scheduled task as returned to the UI).
type TaskView struct {
	ID          string `json:"id"`
	Command     string `json:"command"`
	RunAt       string `json:"run_at"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at"`
	LoopSeconds *int   `json:"loop_seconds"`
}

// ScheduledTask mirrors pydantic ScheduledTask (persisted form).
type ScheduledTask struct {
	ID          string   `json:"id"`
	SessionID   string   `json:"session_id"`
	OwnerID     string   `json:"owner_id"`
	Command     string   `json:"command"`
	RunAt       ISOTime  `json:"run_at"`
	Status      string   `json:"status"`
	CreatedAt   ISOTime  `json:"created_at"`
	SentAt      *ISOTime `json:"sent_at"`
	Error       *string  `json:"error"`
	LoopSeconds *int     `json:"loop_seconds"`
}

// SessionView mirrors pydantic SessionView (SessionMetadata + display fields).
type SessionView struct {
	Session
	ClaudeTitle     *string    `json:"claude_title"`
	Prompts         []string   `json:"prompts"`
	LastUserInputAt *string    `json:"last_user_input_at"`
	HasNewOutput    bool       `json:"has_new_output"`
	IsStreaming     bool       `json:"is_streaming"`
	ScheduledTasks  []TaskView `json:"scheduled_tasks"`
}

// SessionListResponse mirrors pydantic SessionListResponse.
type SessionListResponse struct {
	Items []SessionView `json:"items"`
	Total int           `json:"total"`
}

// SessionStatusView mirrors pydantic SessionStatusView (high-frequency polling).
type SessionStatusView struct {
	ID                 string         `json:"id"`
	Status             SessionStatus  `json:"status"`
	AttachedClients    int            `json:"attached_clients"`
	HasNewOutput       bool           `json:"has_new_output"`
	IsStreaming        bool           `json:"is_streaming"`
	IsCompacting       bool           `json:"is_compacting"`
	CompactingProgress *string        `json:"compacting_progress"`
	ScheduledTasks     []TaskView     `json:"scheduled_tasks"`
	TuiHint            *string        `json:"tui_hint"`
	TuiAuqData         map[string]any `json:"tui_auq_data"`
	TuiApproveData     map[string]any `json:"tui_approve_data"`
	TuiPlanPending     bool           `json:"tui_plan_pending"`
	TuiPlanData        map[string]any `json:"tui_plan_data"`
	LostMessages       []LostMessage  `json:"lost_messages"`
}

// LostMessage is a prompt the client detected as never having reached the agent
// (eaten by auto-compact, or a send timeout). It is registered server-side so
// the "send failed" indicator is visible on — and dismissable from — every
// connected client, not just the tab that sent it.
type LostMessage struct {
	ID        string  `json:"id"`
	Text      string  `json:"text"`
	SentAt    float64 `json:"sent_at"`
	CreatedAt float64 `json:"created_at"`
}

// SessionStatusListResponse mirrors pydantic SessionStatusListResponse.
type SessionStatusListResponse struct {
	Items []SessionStatusView `json:"items"`
	Total int                 `json:"total"`
}

// AttachResponse mirrors pydantic AttachResponse.
type AttachResponse struct {
	SessionID string        `json:"session_id"`
	WsToken   string        `json:"ws_token"`
	WsURL     string        `json:"ws_url"`
	Status    SessionStatus `json:"status"`
}
