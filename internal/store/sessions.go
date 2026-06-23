package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/loki/goclaudemanager/internal/model"
)

// logWrite records every meaningful sessions-table mutation (which session,
// which field, new value) so identity/lifecycle changes — agent_session_id
// cross-links especially — are traceable from the server log alone.
// High-frequency heartbeat fields (last_activity_at, last_output_offset, …)
// log at Debug instead via logWriteDebug to keep Info readable.
func logWrite(id, field string, value any) {
	slog.Info("sessions write", "session", id, "field", field, "value", value)
}

func logWriteDebug(id, field string, value any) {
	slog.Debug("sessions write", "session", id, "field", field, "value", value)
}

// ptrVal unwraps a nullable column value for logging (nil stays nil).
func ptrVal[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

// epochToUTC converts fractional epoch seconds to a UTC time.Time.
func epochToUTC(epoch float64) time.Time {
	sec := int64(epoch)
	nsec := int64((epoch - float64(sec)) * 1e9)
	return time.Unix(sec, nsec).UTC()
}

// ErrNotFound is returned when a session/task/share does not exist.
var ErrNotFound = errors.New("not found")

// sessionCols is the explicit column list for sessions (order matters for scan).
const sessionCols = `id, owner_id, name, project, cwd, env, model, status,
	created_at, updated_at, attached_clients, last_output_offset, last_activity_at,
	ws_token, tmux_session_name, resume_session_id, agent_session_id,
	claude_proc_pid, git_auto_commit, git_commit_msg_count, git_repo_url,
	last_turn_at, tool, codex_transport, codex_appserver_pid, codex_appserver_port,
	transport`

// orderBySQL mirrors the status-priority ordering used by list_for_owner/all.
const orderBySQL = `ORDER BY CASE status
		WHEN 'running' THEN 0 WHEN 'creating' THEN 1 WHEN 'detached' THEN 2
		WHEN 'archived' THEN 3 WHEN 'terminated' THEN 4 END, updated_at DESC`

func nowISO() string { return model.NowUTC().String() }

// scanSession maps a row (selected with sessionCols) to a model.Session.
func scanSession(sc interface{ Scan(...any) error }) (*model.Session, error) {
	var (
		s            model.Session
		envJSON      string
		modelV       sql.NullString
		createdAt    string
		updatedAt    string
		lastActivity sql.NullString
		wsToken      sql.NullString
		resumeID     sql.NullString
		agentID      sql.NullString
		claudePID    sql.NullInt64
		gitAuto      int64
		gitMsgCount  int64
		gitRepoURL   sql.NullString
		lastTurnAt   sql.NullString
		tool         sql.NullString
		codexTransp  sql.NullString
		codexPID     sql.NullInt64
		codexPort    sql.NullInt64
		transport    sql.NullString
	)
	if err := sc.Scan(
		&s.ID, &s.OwnerID, &s.Name, &s.Project, &s.Cwd, &envJSON, &modelV, &s.Status,
		&createdAt, &updatedAt, &s.AttachedClients, &s.LastOutputOffset, &lastActivity,
		&wsToken, &s.TmuxSessionName, &resumeID, &agentID,
		&claudePID, &gitAuto, &gitMsgCount, &gitRepoURL,
		&lastTurnAt, &tool, &codexTransp, &codexPID, &codexPort,
		&transport,
	); err != nil {
		return nil, err
	}

	s.Env = map[string]string{}
	if envJSON != "" {
		_ = json.Unmarshal([]byte(envJSON), &s.Env)
	}
	s.Model = nsToPtr(modelV)
	if t, err := model.ParseISO(createdAt); err == nil {
		s.CreatedAt = t
	}
	if t, err := model.ParseISO(updatedAt); err == nil {
		s.UpdatedAt = t
	}
	s.LastActivityAt = nsToISOPtr(lastActivity)
	s.LastTurnAt = nsToISOPtr(lastTurnAt)
	s.WsToken = nsToPtr(wsToken)
	s.ResumeSessionID = nsToPtr(resumeID)
	s.AgentSessionID = nsToPtr(agentID)
	s.ClaudeProcPID = niToIntPtr(claudePID)
	s.GitAutoCommit = gitAuto != 0
	s.GitCommitMsgCount = int(gitMsgCount)
	s.GitRepoURL = nsToPtr(gitRepoURL)
	s.Tool = "claude"
	if tool.Valid && tool.String != "" {
		s.Tool = tool.String
	}
	s.CodexTransport = "tui"
	if codexTransp.Valid && codexTransp.String != "" {
		s.CodexTransport = codexTransp.String
	}
	s.CodexAppserverPID = niToIntPtr(codexPID)
	s.CodexAppserverPort = niToIntPtr(codexPort)
	s.Transport = "tmux"
	if transport.Valid && transport.String != "" {
		s.Transport = transport.String
	}
	return &s, nil
}

// ---- Session CRUD ---------------------------------------------------------

// CreateSession inserts a new session (mirrors SessionStore.create).
func (s *Store) CreateSession(m *model.Session) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	envJSON, _ := json.Marshal(m.Env)
	_, err := s.DB.Exec(
		`INSERT INTO sessions
		   (id, owner_id, name, project, cwd, env, model, status,
		    created_at, updated_at, attached_clients, last_output_offset,
		    last_activity_at, ws_token, tmux_session_name, resume_session_id,
		    agent_session_id, git_repo_url, tool, codex_transport,
		    codex_appserver_pid, codex_appserver_port, transport)
		   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		m.ID, m.OwnerID, m.Name, m.Project, m.Cwd, string(envJSON), m.Model, m.Status,
		m.CreatedAt.String(), m.UpdatedAt.String(), m.AttachedClients, m.LastOutputOffset,
		isoPtr(m.LastActivityAt), m.WsToken, m.TmuxSessionName, m.ResumeSessionID,
		m.AgentSessionID, m.GitRepoURL, m.Tool, m.CodexTransport,
		m.CodexAppserverPID, m.CodexAppserverPort, m.Transport,
	)
	if err == nil {
		slog.Info("sessions write", "session", m.ID, "field", "INSERT",
			"name", m.Name, "project", m.Project, "tool", m.Tool,
			"transport", m.Transport, "model", ptrVal(m.Model),
			"agent_session_id", ptrVal(m.AgentSessionID))
	}
	return err
}

// GetSession returns a session by id, or (nil, nil) if absent.
func (s *Store) GetSession(id string) (*model.Session, error) {
	row := s.DB.QueryRow(`SELECT `+sessionCols+` FROM sessions WHERE id = ?`, id)
	m, err := scanSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return m, err
}

// ListForOwner returns an owner's sessions, status-priority ordered.
func (s *Store) ListForOwner(ownerID string) ([]*model.Session, error) {
	rows, err := s.DB.Query(`SELECT `+sessionCols+` FROM sessions WHERE owner_id = ? `+orderBySQL, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSessions(rows)
}

// All returns every session, status-priority ordered (mirrors SessionStore.all).
func (s *Store) All() ([]*model.Session, error) {
	rows, err := s.DB.Query(`SELECT ` + sessionCols + ` FROM sessions ` + orderBySQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSessions(rows)
}

func scanSessions(rows *sql.Rows) ([]*model.Session, error) {
	var out []*model.Session
	for rows.Next() {
		m, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Transition validates and applies a status change (mirrors SessionStore.transition).
func (s *Store) Transition(id string, newState model.SessionStatus) (*model.Session, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	cur, err := s.GetSession(id)
	if err != nil {
		return nil, err
	}
	if cur == nil {
		return nil, ErrNotFound
	}
	if cur.Status == newState {
		return cur, nil
	}
	if !model.AllowedTransitions[cur.Status][newState] {
		return nil, fmt.Errorf("invalid transition: %s -> %s", cur.Status, newState)
	}
	extra := ""
	if newState == model.StatusTerminated {
		extra = ", ws_token = NULL"
	}
	if _, err := s.DB.Exec(
		`UPDATE sessions SET status = ?, updated_at = ?`+extra+` WHERE id = ?`,
		newState, nowISO(), id,
	); err != nil {
		return nil, err
	}
	slog.Info("sessions write", "session", id, "field", "status", "value", newState, "old", cur.Status)
	return s.GetSession(id)
}

// ForceStatus sets status without transition validation (startup sync).
func (s *Store) ForceStatus(id string, newState model.SessionStatus) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	extra := ""
	if newState == model.StatusTerminated {
		extra = ", ws_token = NULL"
	}
	_, err := s.DB.Exec(`UPDATE sessions SET status = ?, updated_at = ?`+extra+` WHERE id = ?`,
		newState, nowISO(), id)
	if err == nil {
		slog.Info("sessions write", "session", id, "field", "status", "value", newState, "forced", true)
	}
	return err
}

// UpdateAttachedClients adds delta (clamped at 0) and returns the row.
func (s *Store) UpdateAttachedClients(id string, delta int) (*model.Session, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if _, err := s.DB.Exec(
		`UPDATE sessions SET attached_clients = MAX(0, attached_clients + ?), updated_at = ? WHERE id = ?`,
		delta, nowISO(), id,
	); err != nil {
		return nil, err
	}
	logWriteDebug(id, "attached_clients", fmt.Sprintf("delta %+d", delta))
	return s.GetSession(id)
}

// ResetAttachedClients zeroes the attach count.
func (s *Store) ResetAttachedClients(id string) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(`UPDATE sessions SET attached_clients = 0, updated_at = ? WHERE id = ?`, nowISO(), id)
	if err == nil {
		logWrite(id, "attached_clients", 0)
	}
	return err
}

// IssueWsToken returns the existing ws_token or mints a new one.
func (s *Store) IssueWsToken(id string) (string, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	var existing sql.NullString
	err := s.DB.QueryRow(`SELECT ws_token FROM sessions WHERE id = ?`, id).Scan(&existing)
	if err != nil {
		return "", err
	}
	if existing.Valid && existing.String != "" {
		return existing.String, nil
	}
	tok := tokenURLSafe(24)
	if _, err := s.DB.Exec(`UPDATE sessions SET ws_token = ?, updated_at = ? WHERE id = ?`, tok, nowISO(), id); err != nil {
		return "", err
	}
	logWrite(id, "ws_token", "minted") // token value itself is a credential — not logged
	return tok, nil
}

// Setter helpers (each a single UPDATE, mirroring the Python one-liners).

func (s *Store) UpdateTmuxSessionName(id, name string) error {
	err := s.execTouch(`UPDATE sessions SET tmux_session_name = ?, updated_at = ? WHERE id = ?`, name, id)
	if err == nil {
		logWrite(id, "tmux_session_name", name)
	}
	return err
}
func (s *Store) UpdateClaudeProcPID(id string, pid *int) error {
	err := s.execTouch(`UPDATE sessions SET claude_proc_pid = ?, updated_at = ? WHERE id = ?`, pid, id)
	if err == nil {
		logWrite(id, "claude_proc_pid", ptrVal(pid))
	}
	return err
}
func (s *Store) UpdateAgentSessionID(id, agentID string) error {
	err := s.execTouch(`UPDATE sessions SET agent_session_id = ?, updated_at = ? WHERE id = ?`, agentID, id)
	if err == nil {
		logWrite(id, "agent_session_id", agentID)
	}
	return err
}
func (s *Store) ClearAgentSessionID(id string) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(`UPDATE sessions SET agent_session_id = NULL, updated_at = ? WHERE id = ?`, nowISO(), id)
	if err == nil {
		logWrite(id, "agent_session_id", nil)
	}
	return err
}
// SetAgentSessionID sets agent_session_id to a nullable value (nil → NULL).
// Unlike UpdateAgentSessionID (which only sets a concrete value), this supports
// admin edits and clears in one call.
func (s *Store) SetAgentSessionID(id string, v *string) error {
	err := s.execTouch(`UPDATE sessions SET agent_session_id = ?, updated_at = ? WHERE id = ?`, v, id)
	if err == nil {
		logWrite(id, "agent_session_id", ptrVal(v))
	}
	return err
}

// SetResumeSessionID sets resume_session_id to a nullable value (nil → NULL).
func (s *Store) SetResumeSessionID(id string, v *string) error {
	err := s.execTouch(`UPDATE sessions SET resume_session_id = ?, updated_at = ? WHERE id = ?`, v, id)
	if err == nil {
		logWrite(id, "resume_session_id", ptrVal(v))
	}
	return err
}

func (s *Store) UpdateProject(id, project string) error {
	err := s.execTouch(`UPDATE sessions SET project = ?, updated_at = ? WHERE id = ?`, project, id)
	if err == nil {
		logWrite(id, "project", project)
	}
	return err
}
func (s *Store) UpdateModel(id string, m *string) error {
	err := s.execTouch(`UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?`, m, id)
	if err == nil {
		logWrite(id, "model", ptrVal(m))
	}
	return err
}
func (s *Store) UpdateCodexAppserverEndpoint(id string, pid, port *int) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(`UPDATE sessions SET codex_appserver_pid = ?, codex_appserver_port = ?, updated_at = ? WHERE id = ?`,
		pid, port, nowISO(), id)
	if err == nil {
		slog.Info("sessions write", "session", id, "field", "codex_appserver_pid+port",
			"pid", ptrVal(pid), "port", ptrVal(port))
	}
	return err
}
func (s *Store) UpdateGitMsgCount(id string, count int) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(`UPDATE sessions SET git_commit_msg_count = ? WHERE id = ?`, count, id)
	if err == nil {
		logWriteDebug(id, "git_commit_msg_count", count)
	}
	return err
}

// execTouch runs an UPDATE that also bumps updated_at (arg order: value, id).
func (s *Store) execTouch(query string, value any, id string) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(query, value, nowISO(), id)
	return err
}

// GetAllAgentSessionIDs returns the set of non-null agent_session_id values,
// optionally excluding one session.
func (s *Store) GetAllAgentSessionIDs(excludeSessionID string) (map[string]bool, error) {
	rows, err := s.DB.Query(
		`SELECT agent_session_id FROM sessions WHERE agent_session_id IS NOT NULL AND id != ?`,
		excludeSessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out[v] = true
	}
	return out, rows.Err()
}

// SyncOutputOffset sets last_output_offset without touching last_activity_at.
func (s *Store) SyncOutputOffset(id string, offset int64) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(`UPDATE sessions SET last_output_offset = ? WHERE id = ?`, offset, id)
	if err == nil {
		logWriteDebug(id, "last_output_offset", offset)
	}
	return err
}

// UpdateActivity records that a session produced output.
func (s *Store) UpdateActivity(id string) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(`UPDATE sessions SET last_activity_at = ? WHERE id = ?`, nowISO(), id)
	if err == nil {
		logWriteDebug(id, "last_activity_at", "now")
	}
	return err
}

// UpdateLastTurnAt records the latest completed turn timestamp (epoch seconds),
// only advancing it forward.
func (s *Store) UpdateLastTurnAt(id string, turnEpoch float64) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	iso := model.ISOTime{Time: epochToUTC(turnEpoch)}.String()
	_, err := s.DB.Exec(
		`UPDATE sessions SET last_turn_at = ? WHERE id = ? AND (last_turn_at IS NULL OR last_turn_at < ?)`,
		iso, id, iso)
	if err == nil {
		logWriteDebug(id, "last_turn_at", iso)
	}
	return err
}

// UpdateActivityIfOffsetChanged updates last_activity_at only when new output
// appeared (mirrors the Python read-modify-write; done in a transaction).
func (s *Store) UpdateActivityIfOffsetChanged(id string, newOffset int64) (bool, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var stored int64
	if err := tx.QueryRow(`SELECT last_output_offset FROM sessions WHERE id = ?`, id).Scan(&stored); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	switch {
	case newOffset < stored:
		if _, err := tx.Exec(`UPDATE sessions SET last_output_offset = ? WHERE id = ?`, newOffset, id); err != nil {
			return false, err
		}
		return false, tx.Commit()
	case newOffset == stored:
		return false, tx.Rollback()
	default:
		if _, err := tx.Exec(`UPDATE sessions SET last_activity_at = ?, last_output_offset = ? WHERE id = ?`,
			nowISO(), newOffset, id); err != nil {
			return false, err
		}
		logWriteDebug(id, "last_output_offset+activity", newOffset)
		return true, tx.Commit()
	}
}

// MarkViewed records that user_id viewed the session (clears new-output flag).
func (s *Store) MarkViewed(sessionID, userID string) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(
		`INSERT INTO session_views (session_id, user_id, last_viewed_at) VALUES (?, ?, ?)
		 ON CONFLICT(session_id, user_id) DO UPDATE SET last_viewed_at = excluded.last_viewed_at`,
		sessionID, userID, nowISO())
	return err
}

// GetHasNewOutputBulk returns {session_id: has_new_output} (mirrors Python).
func (s *Store) GetHasNewOutputBulk(sessionIDs []string, userID string) (map[string]bool, error) {
	result := map[string]bool{}
	if len(sessionIDs) == 0 {
		return result, nil
	}
	ph, args := placeholders(sessionIDs)
	rows, err := s.DB.Query(
		`SELECT id, tool, last_turn_at, last_activity_at, status, attached_clients FROM sessions WHERE id IN (`+ph+`)`,
		args...)
	if err != nil {
		return nil, err
	}
	type rowT struct {
		id, status                 string
		tool, lastTurn, lastAct    sql.NullString
		attached                   int
	}
	var srows []rowT
	for rows.Next() {
		var r rowT
		if err := rows.Scan(&r.id, &r.tool, &r.lastTurn, &r.lastAct, &r.status, &r.attached); err != nil {
			rows.Close()
			return nil, err
		}
		srows = append(srows, r)
	}
	rows.Close()

	vArgs := append(append([]any{}, args...), userID)
	vrows, err := s.DB.Query(
		`SELECT session_id, last_viewed_at FROM session_views WHERE session_id IN (`+ph+`) AND user_id = ?`,
		vArgs...)
	if err != nil {
		return nil, err
	}
	viewedAt := map[string]string{}
	for vrows.Next() {
		var sid, va string
		if err := vrows.Scan(&sid, &va); err != nil {
			vrows.Close()
			return nil, err
		}
		viewedAt[sid] = va
	}
	vrows.Close()

	for _, r := range srows {
		tool := "claude"
		if r.tool.Valid && r.tool.String != "" {
			tool = r.tool.String
		}
		turnAt := r.lastTurn
		if tool == "cursor" {
			turnAt = r.lastAct
		}
		if !turnAt.Valid || turnAt.String == "" ||
			r.status == model.StatusTerminated || r.status == model.StatusCreating ||
			r.attached > 0 {
			result[r.id] = false
			continue
		}
		lv, ok := viewedAt[r.id]
		if !ok {
			result[r.id] = true
		} else {
			result[r.id] = turnAt.String > lv
		}
	}
	return result, nil
}

// DeleteSession removes a session and its dependent rows.
func (s *Store) DeleteSession(id string) (bool, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	res, err := s.DB.Exec(`DELETE FROM sessions WHERE id = ?`, id)
	if err != nil {
		return false, err
	}
	for _, q := range []string{
		`DELETE FROM session_views WHERE session_id = ?`,
		`DELETE FROM prompt_history WHERE session_id = ?`,
		`DELETE FROM prompt_history_backfill WHERE session_id = ?`,
		`DELETE FROM shares WHERE session_id = ?`,
	} {
		if _, err := s.DB.Exec(q, id); err != nil {
			return false, err
		}
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		logWrite(id, "DELETE", nil)
	}
	return n > 0, nil
}

// ---- small helpers --------------------------------------------------------

func nsToPtr(n sql.NullString) *string {
	if !n.Valid {
		return nil
	}
	v := n.String
	return &v
}

func nsToISOPtr(n sql.NullString) *model.ISOTime {
	if !n.Valid || n.String == "" {
		return nil
	}
	t, err := model.ParseISO(n.String)
	if err != nil {
		return nil
	}
	return &t
}

func niToIntPtr(n sql.NullInt64) *int {
	if !n.Valid {
		return nil
	}
	v := int(n.Int64)
	return &v
}

func isoPtr(t *model.ISOTime) any {
	if t == nil {
		return nil
	}
	return t.String()
}

func tokenURLSafe(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func placeholders(items []string) (string, []any) {
	ph := make([]byte, 0, len(items)*2)
	args := make([]any, len(items))
	for i, it := range items {
		if i > 0 {
			ph = append(ph, ',')
		}
		ph = append(ph, '?')
		args[i] = it
	}
	return string(ph), args
}
