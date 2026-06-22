package store

import (
	"database/sql"
	"time"

	"github.com/loki/goclaudemanager/internal/model"
)

const taskCols = `id, session_id, owner_id, command, run_at, status, created_at, sent_at, error, loop_seconds`

func scanTask(sc interface{ Scan(...any) error }) (*model.ScheduledTask, error) {
	var (
		t         model.ScheduledTask
		runAt     string
		createdAt string
		sentAt    sql.NullString
		errStr    sql.NullString
		loopSecs  sql.NullInt64
	)
	if err := sc.Scan(&t.ID, &t.SessionID, &t.OwnerID, &t.Command, &runAt, &t.Status,
		&createdAt, &sentAt, &errStr, &loopSecs); err != nil {
		return nil, err
	}
	if v, err := model.ParseISO(runAt); err == nil {
		t.RunAt = v
	}
	if v, err := model.ParseISO(createdAt); err == nil {
		t.CreatedAt = v
	}
	t.SentAt = nsToISOPtr(sentAt)
	t.Error = nsToPtr(errStr)
	t.LoopSeconds = niToIntPtr(loopSecs)
	return &t, nil
}

// CreateTask inserts a scheduled task.
func (s *Store) CreateTask(t *model.ScheduledTask) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(
		`INSERT INTO scheduled_tasks
		   (id, session_id, owner_id, command, run_at, status, created_at, sent_at, error, loop_seconds)
		   VALUES (?,?,?,?,?,?,?,?,?,?)`,
		t.ID, t.SessionID, t.OwnerID, t.Command, t.RunAt.String(), t.Status,
		t.CreatedAt.String(), nil, nil, t.LoopSeconds)
	return err
}

// ListTasksForSession returns all tasks for a session (run_at ascending).
func (s *Store) ListTasksForSession(sessionID string) ([]*model.ScheduledTask, error) {
	rows, err := s.DB.Query(`SELECT `+taskCols+` FROM scheduled_tasks WHERE session_id = ? ORDER BY run_at ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTasks(rows)
}

// ListPendingTasksForSessions returns active tasks (pending + recently-sent
// within 10 minutes) grouped by session id.
func (s *Store) ListPendingTasksForSessions(sessionIDs []string) (map[string][]*model.ScheduledTask, error) {
	result := map[string][]*model.ScheduledTask{}
	for _, sid := range sessionIDs {
		result[sid] = nil
	}
	if len(sessionIDs) == 0 {
		return result, nil
	}
	cutoff := model.ISOTime{Time: model.NowUTC().Add(-10 * time.Minute)}.String() // now-10min
	ph, args := placeholders(sessionIDs)
	args = append(args, cutoff)
	rows, err := s.DB.Query(
		`SELECT `+taskCols+` FROM scheduled_tasks
		 WHERE session_id IN (`+ph+`) AND (status = 'pending' OR (status = 'sent' AND sent_at > ?))
		 ORDER BY run_at ASC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		result[t.SessionID] = append(result[t.SessionID], t)
	}
	return result, rows.Err()
}

// ListDueTasks returns pending tasks whose run_at is in the past.
func (s *Store) ListDueTasks() ([]*model.ScheduledTask, error) {
	rows, err := s.DB.Query(
		`SELECT `+taskCols+` FROM scheduled_tasks WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC`,
		nowISO())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTasks(rows)
}

// UpdateTaskStatus updates a task's status (and sent_at when status == "sent").
func (s *Store) UpdateTaskStatus(taskID, status string, errMsg *string) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if status == "sent" {
		_, err := s.DB.Exec(`UPDATE scheduled_tasks SET status = ?, sent_at = ?, error = ? WHERE id = ?`,
			status, nowISO(), errMsg, taskID)
		return err
	}
	_, err := s.DB.Exec(`UPDATE scheduled_tasks SET status = ?, error = ? WHERE id = ?`, status, errMsg, taskID)
	return err
}

// UpdateTaskCommand rewrites a still-pending task's command; returns whether a
// row changed (false if the task already fired/cancelled or doesn't exist).
// For a loop task this edits the next queued iteration — fireDueTasks copies
// the command forward, so every subsequent fire uses the new text too.
func (s *Store) UpdateTaskCommand(taskID, command string) (bool, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	res, err := s.DB.Exec(`UPDATE scheduled_tasks SET command = ? WHERE id = ? AND status = 'pending'`, command, taskID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// CancelTask marks a pending task cancelled; returns whether a row changed.
func (s *Store) CancelTask(taskID string) (bool, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	res, err := s.DB.Exec(`UPDATE scheduled_tasks SET status = 'cancelled' WHERE id = ? AND status = 'pending'`, taskID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// DeleteTasksForSession removes all of a session's tasks.
func (s *Store) DeleteTasksForSession(sessionID string) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(`DELETE FROM scheduled_tasks WHERE session_id = ?`, sessionID)
	return err
}

func scanTasks(rows *sql.Rows) ([]*model.ScheduledTask, error) {
	var out []*model.ScheduledTask
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
