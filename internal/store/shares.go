package store

import (
	"database/sql"
	"encoding/json"

	"github.com/loki/goclaudemanager/internal/model"
)

const shareCols = `hash, session_id, owner_id, share_type, cutoff_ts, cutoff_msg_uuid,
	cutoff_msg_text, created_at, expires_at, default_theme, file_access`

func scanShare(sc interface{ Scan(...any) error }) (*model.ShareRecord, error) {
	var (
		r           model.ShareRecord
		cutoffTs    sql.NullFloat64
		cutoffUUID  sql.NullString
		cutoffText  sql.NullString
		theme       sql.NullString
		fileAccess  sql.NullString
	)
	if err := sc.Scan(&r.Hash, &r.SessionID, &r.OwnerID, &r.ShareType, &cutoffTs,
		&cutoffUUID, &cutoffText, &r.CreatedAt, &r.ExpiresAt, &theme, &fileAccess); err != nil {
		return nil, err
	}
	if cutoffTs.Valid {
		v := cutoffTs.Float64
		r.CutoffTs = &v
	}
	r.CutoffMsgUUID = nsToPtr(cutoffUUID)
	r.CutoffMsgText = nsToPtr(cutoffText)
	r.DefaultTheme = "light"
	if theme.Valid && theme.String != "" {
		r.DefaultTheme = theme.String
	}
	if fileAccess.Valid && fileAccess.String != "" {
		var fa model.FileAccessSpec
		if err := json.Unmarshal([]byte(fileAccess.String), &fa); err == nil {
			r.FileAccess = &fa
		}
	}
	return &r, nil
}

// CreateShare inserts or replaces a share.
func (s *Store) CreateShare(r *model.ShareRecord) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	var faJSON any
	if r.FileAccess != nil {
		b, _ := json.Marshal(r.FileAccess)
		faJSON = string(b)
	}
	_, err := s.DB.Exec(
		`INSERT OR REPLACE INTO shares
		   (hash, session_id, owner_id, share_type, cutoff_ts, cutoff_msg_uuid,
		    cutoff_msg_text, created_at, expires_at, default_theme, file_access)
		   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		r.Hash, r.SessionID, r.OwnerID, r.ShareType, r.CutoffTs, r.CutoffMsgUUID,
		r.CutoffMsgText, r.CreatedAt, r.ExpiresAt, r.DefaultTheme, faJSON)
	return err
}

// GetShare returns a share by hash, or (nil, nil) if absent.
func (s *Store) GetShare(hash string) (*model.ShareRecord, error) {
	row := s.DB.QueryRow(`SELECT `+shareCols+` FROM shares WHERE hash = ?`, hash)
	r, err := scanShare(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return r, err
}

// ListShares returns a session's shares for an owner (created_at descending).
func (s *Store) ListShares(sessionID, ownerID string) ([]*model.ShareRecord, error) {
	rows, err := s.DB.Query(`SELECT `+shareCols+` FROM shares WHERE session_id = ? AND owner_id = ? ORDER BY created_at DESC`,
		sessionID, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanShares(rows)
}

// DeleteShare removes a share owned by ownerID; returns whether a row changed.
func (s *Store) DeleteShare(hash, ownerID string) (bool, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	res, err := s.DB.Exec(`DELETE FROM shares WHERE hash = ? AND owner_id = ?`, hash, ownerID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ListActiveShares returns all non-expired shares.
func (s *Store) ListActiveShares(now float64) ([]*model.ShareRecord, error) {
	rows, err := s.DB.Query(`SELECT `+shareCols+` FROM shares WHERE expires_at > ?`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanShares(rows)
}

// DeleteExpiredShares deletes shares past expiry and returns their hashes.
func (s *Store) DeleteExpiredShares(now float64) ([]string, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	rows, err := s.DB.Query(`SELECT hash FROM shares WHERE expires_at <= ?`, now)
	if err != nil {
		return nil, err
	}
	var hashes []string
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			rows.Close()
			return nil, err
		}
		hashes = append(hashes, h)
	}
	rows.Close()
	if len(hashes) > 0 {
		if _, err := s.DB.Exec(`DELETE FROM shares WHERE expires_at <= ?`, now); err != nil {
			return nil, err
		}
	}
	return hashes, nil
}

func scanShares(rows *sql.Rows) ([]*model.ShareRecord, error) {
	var out []*model.ShareRecord
	for rows.Next() {
		r, err := scanShare(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
