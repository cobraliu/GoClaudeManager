package store

import (
	"database/sql"
	"strings"
)

// PromptHistoryEntry is one row of prompt_history as returned to the API.
type PromptHistoryEntry struct {
	ID     int64   `json:"id"`
	Text   string  `json:"text"`
	SentAt float64 `json:"sent_at"`
	Pane   *string `json:"pane"`
}

// AppendPromptHistory inserts a prompt and returns the new row id.
func (s *Store) AppendPromptHistory(sessionID, text string, sentAt float64, pane *string) (int64, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	res, err := s.DB.Exec(`INSERT INTO prompt_history (session_id, text, sent_at, pane) VALUES (?, ?, ?, ?)`,
		sessionID, text, sentAt, pane)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func escapeLike(q string) string {
	q = strings.ReplaceAll(q, `\`, `\\`)
	q = strings.ReplaceAll(q, `%`, `\%`)
	q = strings.ReplaceAll(q, `_`, `\_`)
	return q
}

// ListPromptHistory returns prompt history, most recent first, with optional
// case-insensitive substring filter and pagination.
func (s *Store) ListPromptHistory(sessionID string, limit, offset int, query string) ([]PromptHistoryEntry, error) {
	if limit < 1 {
		limit = 1
	}
	if limit > 500 {
		limit = 500
	}
	if offset < 0 {
		offset = 0
	}
	where := "session_id = ?"
	args := []any{sessionID}
	if query != "" {
		where += ` AND text LIKE ? ESCAPE '\'`
		args = append(args, "%"+escapeLike(query)+"%")
	}
	args = append(args, limit, offset)
	rows, err := s.DB.Query(
		`SELECT id, text, sent_at, pane FROM prompt_history WHERE `+where+` ORDER BY sent_at DESC, id DESC LIMIT ? OFFSET ?`,
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PromptHistoryEntry
	for rows.Next() {
		var e PromptHistoryEntry
		var pane sql.NullString
		if err := rows.Scan(&e.ID, &e.Text, &e.SentAt, &pane); err != nil {
			return nil, err
		}
		e.Pane = nsToPtr(pane)
		out = append(out, e)
	}
	return out, rows.Err()
}

// CountPromptHistory counts prompt history rows for a session (with filter).
func (s *Store) CountPromptHistory(sessionID, query string) (int, error) {
	where := "session_id = ?"
	args := []any{sessionID}
	if query != "" {
		where += ` AND text LIKE ? ESCAPE '\'`
		args = append(args, "%"+escapeLike(query)+"%")
	}
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM prompt_history WHERE `+where, args...).Scan(&n)
	return n, err
}

// DeletePromptHistoryEntry removes one entry; returns whether a row changed.
func (s *Store) DeletePromptHistoryEntry(sessionID string, entryID int64) (bool, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	res, err := s.DB.Exec(`DELETE FROM prompt_history WHERE session_id = ? AND id = ?`, sessionID, entryID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// BulkInsertPromptHistory inserts many entries; returns the count inserted.
func (s *Store) BulkInsertPromptHistory(sessionID string, texts []string, sentAts []float64, panes []*string) (int, error) {
	if len(texts) == 0 {
		return 0, nil
	}
	s.wmu.Lock()
	defer s.wmu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`INSERT INTO prompt_history (session_id, text, sent_at, pane) VALUES (?, ?, ?, ?)`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	for i := range texts {
		if _, err := stmt.Exec(sessionID, texts[i], sentAts[i], panes[i]); err != nil {
			return 0, err
		}
	}
	return len(texts), tx.Commit()
}

// IsPromptHistoryBackfilled reports whether a session has been backfilled.
func (s *Store) IsPromptHistoryBackfilled(sessionID string) (bool, error) {
	var one int
	err := s.DB.QueryRow(`SELECT 1 FROM prompt_history_backfill WHERE session_id = ?`, sessionID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// MarkPromptHistoryBackfilled records that a session was backfilled.
func (s *Store) MarkPromptHistoryBackfilled(sessionID string, completedAt float64) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(`INSERT OR REPLACE INTO prompt_history_backfill (session_id, completed_at) VALUES (?, ?)`,
		sessionID, completedAt)
	return err
}
