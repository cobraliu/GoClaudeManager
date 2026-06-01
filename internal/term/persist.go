package term

// On-disk persistence for terminal records, restoring the behaviour the Python
// backend had: the registry survives a server restart so previously-created
// tmux terminals are re-adopted instead of orphaned.
//
// The file is a JSON array (Python-compatible: same field names as the old
// terms.json) living at <DataDir>/terms.json (or ./data/terms.json in dev).
// We only ever adopt records whose tmux session is still alive — dead entries
// are dropped on Restore so the file self-heals.

import (
	"encoding/json"
	"log/slog"
	"os"
	"sort"
	"time"
)

// persistRecord is the on-disk shape of a terminal record. Field names match
// the Python TermRecord persistence so an existing terms.json loads unchanged.
type persistRecord struct {
	TermID    string  `json:"term_id"`
	TmuxName  string  `json:"tmux_name"`
	SessionID string  `json:"session_id"`
	UserID    string  `json:"user_id"`
	Cwd       string  `json:"cwd"`
	Name      *string `json:"name"` // null for ephemeral terminals
	CreatedAt float64 `json:"created_at"`
	Kept      bool    `json:"kept"`
}

// SetPersistPath enables on-disk persistence at the given path. Pass "" (the
// default) to disable it — tests construct the Service with New(nil) and never
// touch disk.
func (s *Service) SetPersistPath(path string) { s.persistPath = path }

// Restore loads terms.json and re-adopts every record whose tmux session is
// still alive, then rewrites the file with the reconciled set (dropping dead
// entries). A missing or unreadable file is a no-op. Adopted records get a
// fresh idle clock so a quick reattach revives them and the sweeper does not
// kill them out from under a returning user.
func (s *Service) Restore() {
	if s.persistPath == "" {
		return
	}
	raw, err := os.ReadFile(s.persistPath)
	if err != nil {
		return // no file yet — nothing to adopt
	}
	var recs []persistRecord
	if err := json.Unmarshal(raw, &recs); err != nil {
		slog.Warn("term.restore: parse terms.json failed", "err", err)
		return
	}

	liveNames, _ := s.tmux.ListSessions()
	live := make(map[string]bool, len(liveNames))
	for _, n := range liveNames {
		live[n] = true
	}

	now := time.Now()
	adopted := 0
	s.mu.Lock()
	for _, pr := range recs {
		if pr.TermID == "" || pr.TmuxName == "" {
			continue
		}
		if !live[pr.TmuxName] {
			continue // tmux session is gone — drop the stale record
		}
		if s.terms[pr.TermID] != nil {
			continue
		}
		name := ""
		if pr.Name != nil {
			name = *pr.Name
		}
		created := now
		if pr.CreatedAt > 0 {
			created = time.Unix(0, int64(pr.CreatedAt*float64(time.Second)))
		}
		s.terms[pr.TermID] = &Record{
			TermID:       pr.TermID,
			TmuxName:     pr.TmuxName,
			SessionID:    pr.SessionID,
			UserID:       pr.UserID,
			Cwd:          pr.Cwd,
			Name:         name,
			CreatedAt:    created,
			LastHolderAt: now, // restart the idle clock from adoption
			Kept:         pr.Kept,
		}
		adopted++
	}
	s.mu.Unlock()

	if adopted > 0 {
		slog.Info("term.restore", "adopted", adopted, "in_file", len(recs))
	}
	s.persist() // rewrite the file with only the live records
}

// persist atomically writes the current registry to terms.json. It is a no-op
// when persistence is disabled. Safe to call without holding s.mu (it takes the
// lock to snapshot, then writes outside it).
func (s *Service) persist() {
	if s.persistPath == "" {
		return
	}
	s.mu.Lock()
	recs := make([]persistRecord, 0, len(s.terms))
	for _, r := range s.terms {
		var name *string
		if r.Name != "" {
			n := r.Name
			name = &n
		}
		recs = append(recs, persistRecord{
			TermID:    r.TermID,
			TmuxName:  r.TmuxName,
			SessionID: r.SessionID,
			UserID:    r.UserID,
			Cwd:       r.Cwd,
			Name:      name,
			CreatedAt: float64(r.CreatedAt.UnixNano()) / float64(time.Second),
			Kept:      r.Kept,
		})
	}
	s.mu.Unlock()

	sort.Slice(recs, func(i, j int) bool { return recs[i].CreatedAt < recs[j].CreatedAt })
	data, err := json.MarshalIndent(recs, "", "  ")
	if err != nil {
		slog.Warn("term.persist: marshal failed", "err", err)
		return
	}
	tmp := s.persistPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		slog.Warn("term.persist: write failed", "err", err)
		return
	}
	if err := os.Rename(tmp, s.persistPath); err != nil {
		slog.Warn("term.persist: rename failed", "err", err)
	}
}
