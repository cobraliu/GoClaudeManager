// Package term manages named + ephemeral bash terminals as tmux sessions.
//
// It is a Go port of ClaudeManager/app/services/bash_term_service.py. Each
// terminal is a tmux session named "cmterm-<term_id>" running `bash -l`. The
// same tmux session can be attached by multiple PTYs (one per WebSocket
// client), which gives the user "open this terminal from multiple places" out
// of the box.
//
// Lifecycle:
//   - Named terminals (Name != "") survive disconnects. Only an explicit
//     Delete() kills them.
//   - Ephemeral terminals (Name == "") follow a four-state machine that avoids
//     killing them just because the browser refreshed:
//   - attached: AttachCount > 0. Always visible. Heartbeats no-op.
//   - idle:     AttachCount == 0, last holder seen within idleGrace. Still
//     visible in the list so cached term_ids can reattach. Heartbeats
//     refresh the "last holder" timestamp.
//   - standby:  no holder for longer than idleGrace. Hidden from the list
//     (a fresh client won't see it), but a client that already cached the
//     term_id can still call the token / heartbeat endpoints. Standby
//     lasts standbyGrace then the tmux session is killed.
//   - kept:     promoted from standby when a heartbeat or attach revives it.
//     Kept terminals are no longer subject to auto-close (behaves like a
//     named one).
//
// Unlike the Python version, on-disk persistence (and reap_orphan_tmux_sessions)
// is NOT replicated — see the deliverable notes. The sweeper still prunes
// records whose tmux session has died on its own.
package term

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/loki/goclaudemanager/internal/tmux"
)

// TmuxPrefix is the tmux session-name prefix for bash terminals.
const TmuxPrefix = "cmterm-"

// Grace timings. The Python production wiring read these from app.config so the
// user could tune them via the API; here we hardcode the Python defaults as the
// task instructs (internal/config does not yet expose getters for these).
const (
	idleGrace    = 600 * time.Second // ephemeral idle → standby
	standbyGrace = 30 * time.Second  // standby → kill
	sweeperTick  = 5 * time.Second   // how often the sweeper checks
)

// Record is one bash-terminal record. (Port of TermRecord.)
type Record struct {
	TermID    string
	TmuxName  string
	SessionID string
	UserID    string
	Cwd       string
	Name      string // "" means ephemeral
	CreatedAt time.Time

	AttachCount int
	// LastHolderAt is refreshed on attach, detach-to-zero, and heartbeat. The
	// sweeper uses it to decide when to enter standby.
	LastHolderAt time.Time
	// StandbyAt is the wall time when the record entered standby; zero otherwise.
	StandbyAt time.Time
	// Kept is true once promoted from standby (heartbeat or reattach revived it).
	Kept bool
}

// IsNamed reports whether the terminal has a non-empty name.
func (r *Record) IsNamed() bool { return r.Name != "" }

// IsImmortal reports whether the sweeper should leave the terminal alone.
func (r *Record) IsImmortal() bool { return r.IsNamed() || r.Kept }

// IsStandby reports whether the record is in the standby window.
func (r *Record) IsStandby() bool { return !r.StandbyAt.IsZero() }

// Public is the JSON-facing view of a record (mirrors TermRecord.public()).
func (r *Record) Public() map[string]any {
	return map[string]any{
		"term_id":      r.TermID,
		"session_id":   r.SessionID,
		"name":         nameOrNil(r.Name),
		"cwd":          r.Cwd,
		"is_named":     r.IsNamed(),
		"attach_count": r.AttachCount,
		"created_at":   float64(r.CreatedAt.UnixNano()) / 1e9,
		"kept":         r.Kept,
	}
}

func nameOrNil(name string) any {
	if name == "" {
		return nil
	}
	return name
}

// Service holds bash-terminal records and tokens. Thread-safe via a single mutex.
// (Port of TerminalManager.)
type Service struct {
	tmux *tmux.Client

	mu     sync.Mutex
	terms  map[string]*Record
	tokens map[string]string // token → term_id

	// persistPath, when non-empty, is the terms.json file the registry is
	// mirrored to so terminals survive a server restart. See persist.go.
	persistPath string
}

// New constructs a Service over the given tmux client.
func New(tx *tmux.Client) *Service {
	return &Service{
		tmux:   tx,
		terms:  make(map[string]*Record),
		tokens: make(map[string]string),
	}
}

// ── lifecycle ──────────────────────────────────────────────────────────────

// Create starts a detached tmux session running `bash -l` in cwd and records it.
// A non-empty name makes the terminal named (immortal). Returns an error whose
// kind callers can test with IsConflict / IsTmuxFailure.
func (s *Service) Create(sessionID, userID, cwd, name string) (*Record, error) {
	name = strings.TrimSpace(name)

	s.mu.Lock()
	if name != "" && s.findNamedLocked(sessionID, userID, name) != nil {
		s.mu.Unlock()
		return nil, &ConflictError{Name: name}
	}
	s.mu.Unlock()

	termID := newTermID()
	tmuxName := TmuxPrefix + termID

	// Start a detached tmux session running bash in login mode so PATH from
	// .profile is set up (matches the Claude tmux session). Best-effort options
	// mirror the Python create().
	if _, err := s.tmux.Run("new-session", "-d", "-s", tmuxName, "-c", cwd, "bash -l"); err != nil {
		return nil, &TmuxError{err: err}
	}
	_, _ = s.tmux.Run("set-option", "-t", tmuxName, "history-limit", "50000")
	_, _ = s.tmux.Run("set-option", "-t", tmuxName, "mouse", "off")
	_, _ = s.tmux.Run("set-option", "-t", tmuxName, "mode-keys", "vi")

	now := time.Now()
	rec := &Record{
		TermID:       termID,
		TmuxName:     tmuxName,
		SessionID:    sessionID,
		UserID:       userID,
		Cwd:          cwd,
		Name:         name,
		CreatedAt:    now,
		LastHolderAt: now, // start the idle clock from creation
	}
	s.mu.Lock()
	s.terms[termID] = rec
	s.mu.Unlock()

	slog.Info("term.create", "id", termID, "name", name, "ephemeral", name == "")
	s.persist()
	return rec, nil
}

// Rename changes a terminal's name (or clears it when name is empty). Returns
// ErrNotFound if the terminal is gone, or *ConflictError on a name clash.
func (s *Service) Rename(termID, name string) (*Record, error) {
	name = strings.TrimSpace(name)
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.terms[termID]
	if rec == nil {
		return nil, ErrNotFound
	}
	if name != "" {
		if other := s.findNamedLocked(rec.SessionID, rec.UserID, name); other != nil && other.TermID != termID {
			return nil, &ConflictError{Name: name}
		}
	}
	rec.Name = name
	go s.persist()
	return rec, nil
}

// Delete kills the terminal's tmux session and drops its record + tokens.
// Returns false if there was no such record.
func (s *Service) Delete(termID string) bool {
	s.mu.Lock()
	rec := s.terms[termID]
	if rec == nil {
		s.mu.Unlock()
		return false
	}
	delete(s.terms, termID)
	s.dropTokensLocked(termID)
	s.mu.Unlock()

	if err := s.tmux.Terminate(rec.TmuxName); err != nil {
		slog.Warn("term.delete tmux kill failed", "id", termID, "err", err)
	}
	slog.Info("term.delete", "id", termID)
	s.persist()
	return true
}

// Get returns the record for termID, or nil.
func (s *Service) Get(termID string) *Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.terms[termID]
}

// ListFor returns the visible terminals for a session/user (standby items are
// hidden), sorted with named terminals first, then by creation time.
func (s *Service) ListFor(sessionID, userID string, isAdmin bool) []*Record {
	s.mu.Lock()
	var out []*Record
	for _, r := range s.terms {
		if r.SessionID != sessionID {
			continue
		}
		if !isAdmin && r.UserID != userID {
			continue
		}
		if r.IsStandby() {
			continue
		}
		out = append(out, r)
	}
	s.mu.Unlock()

	sort.SliceStable(out, func(i, j int) bool {
		ni, nj := out[i].Name == "", out[j].Name == ""
		if ni != nj {
			return !ni // named (Name != "") sorts first
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out
}

// ── tokens ───────────────────────────────────────────────────────────────

// IssueToken mints a one-shot WS token bound to termID. Returns ErrNotFound if
// the terminal is gone.
func (s *Service) IssueToken(termID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.terms[termID] == nil {
		return "", ErrNotFound
	}
	token := randToken()
	s.tokens[token] = termID
	return token, nil
}

// ConsumeToken pops a token and returns the bound term_id, or "" if invalid.
func (s *Service) ConsumeToken(token string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	termID, ok := s.tokens[token]
	if !ok {
		return ""
	}
	delete(s.tokens, token)
	return termID
}

// ── attach refcount (driven by the WS handler) ─────────────────────────────

// OnAttach increments the attach count and refreshes the holder timestamp.
// An attach during standby revives + promotes the terminal to kept. Returns the
// new attach count.
func (s *Service) OnAttach(termID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.terms[termID]
	if rec == nil {
		return 0
	}
	if rec.IsStandby() {
		rec.StandbyAt = time.Time{}
		rec.Kept = true
		slog.Info("term.revive", "id", termID, "via", "attach")
		go s.persist() // kept flag changed — mirror it
	}
	rec.AttachCount++
	rec.LastHolderAt = time.Now()
	return rec.AttachCount
}

// OnDetach decrements the attach count. When it reaches zero the idle clock
// restarts. Ephemerals are not killed here — the sweeper handles
// idle→standby→kill so a quick refresh can reattach.
func (s *Service) OnDetach(termID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.terms[termID]
	if rec == nil {
		return 0
	}
	if rec.AttachCount > 0 {
		rec.AttachCount--
	}
	if rec.AttachCount == 0 {
		rec.LastHolderAt = time.Now()
	}
	return rec.AttachCount
}

// Heartbeat refreshes the holder timestamp; a heartbeat during standby revives +
// promotes the terminal to kept. Returns nil if the terminal is gone.
func (s *Service) Heartbeat(termID string) *Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.terms[termID]
	if rec == nil {
		return nil
	}
	if rec.IsStandby() {
		rec.StandbyAt = time.Time{}
		rec.Kept = true
		slog.Info("term.revive", "id", termID, "via", "heartbeat")
		go s.persist() // kept flag changed — mirror it
	}
	rec.LastHolderAt = time.Now()
	return rec
}

// ── ephemeral lifecycle sweeper ────────────────────────────────────────────

// Sweeper drives the ephemeral lifecycle on a ticker until ctx is cancelled.
func (s *Service) Sweeper(ctx context.Context) {
	t := time.NewTicker(sweeperTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.sweepOnce()
		}
	}
}

// sweepOnce performs one sweeper tick: prune dead tmux sessions, then drive
// idle→standby and standby→kill transitions. Terminals whose pane shell still
// has descendant processes are spared at both transitions.
func (s *Service) sweepOnce() {
	now := time.Now()

	// Pass 0: prune records whose tmux session has died on its own. Probe
	// outside the lock (tmux has-session is IPC), then drop under the lock.
	s.mu.Lock()
	all := make([]*Record, 0, len(s.terms))
	for _, r := range s.terms {
		all = append(all, r)
	}
	s.mu.Unlock()

	var dead []string
	for _, r := range all {
		if !s.tmux.HasSession(r.TmuxName) {
			dead = append(dead, r.TermID)
		}
	}
	if len(dead) > 0 {
		s.mu.Lock()
		for _, tid := range dead {
			if rec := s.terms[tid]; rec != nil {
				delete(s.terms, tid)
				s.dropTokensLocked(tid)
				slog.Info("term.dead-reap", "id", tid, "tmux", rec.TmuxName)
			}
		}
		s.mu.Unlock()
	}

	// Pass 1: collect candidates under the lock (cheap).
	var idleCandidates, killCandidates []*Record
	s.mu.Lock()
	for _, rec := range s.terms {
		if rec.IsImmortal() || rec.AttachCount > 0 {
			continue
		}
		if rec.StandbyAt.IsZero() {
			if now.Sub(rec.LastHolderAt) > idleGrace {
				idleCandidates = append(idleCandidates, rec)
			}
		} else {
			if now.Sub(rec.StandbyAt) > standbyGrace {
				killCandidates = append(killCandidates, rec)
			}
		}
	}
	s.mu.Unlock()

	// Pass 2: probe tmux/proc outside the lock (potentially slow).
	idleBusy := make(map[string]bool, len(idleCandidates))
	for _, r := range idleCandidates {
		idleBusy[r.TermID] = s.tmux.HasActiveChildren(r.TmuxName)
	}
	killBusy := make(map[string]bool, len(killCandidates))
	for _, r := range killCandidates {
		killBusy[r.TermID] = s.tmux.HasActiveChildren(r.TmuxName)
	}

	// Pass 3: apply transitions under the lock.
	var toKill []*Record
	s.mu.Lock()
	for _, rec := range idleCandidates {
		if s.terms[rec.TermID] == nil {
			continue
		}
		if idleBusy[rec.TermID] {
			// Active command running — refresh the idle clock so we don't churn.
			rec.LastHolderAt = now
			continue
		}
		rec.StandbyAt = now
		slog.Info("term.standby", "id", rec.TermID, "idle_for_s", now.Sub(rec.LastHolderAt).Seconds())
	}
	for _, rec := range killCandidates {
		if s.terms[rec.TermID] == nil {
			continue
		}
		if killBusy[rec.TermID] {
			// Revive: pull out of standby, restart the idle clock. No promotion
			// to kept — once the command finishes, normal lifecycle resumes.
			rec.StandbyAt = time.Time{}
			rec.LastHolderAt = now
			slog.Info("term.busy-revive", "id", rec.TermID)
			continue
		}
		toKill = append(toKill, rec)
		delete(s.terms, rec.TermID)
		s.dropTokensLocked(rec.TermID)
	}
	s.mu.Unlock()

	for _, rec := range toKill {
		if err := s.tmux.Terminate(rec.TmuxName); err != nil {
			slog.Warn("term auto-close kill failed", "id", rec.TermID, "err", err)
		}
		slog.Info("term.auto-close", "id", rec.TermID)
	}
	if len(toKill) > 0 {
		s.persist() // records were removed — mirror the new set
	}
}

// ── internal ──────────────────────────────────────────────────────────────

func (s *Service) findNamedLocked(sessionID, userID, name string) *Record {
	for _, r := range s.terms {
		if r.SessionID == sessionID && r.UserID == userID && r.Name == name {
			return r
		}
	}
	return nil
}

func (s *Service) dropTokensLocked(termID string) {
	for t, tid := range s.tokens {
		if tid == termID {
			delete(s.tokens, t)
		}
	}
}

// newTermID mirrors secrets.token_urlsafe(8) with '-'/'=' scrubbed.
func newTermID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	s := base64.RawURLEncoding.EncodeToString(b)
	s = strings.ReplaceAll(s, "-", "_")
	s = strings.ReplaceAll(s, "=", "")
	return s
}

// randToken mirrors secrets.token_urlsafe(32).
func randToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// ── error kinds (so the REST layer can map to HTTP statuses) ────────────────

// ErrNotFound is returned when a term_id is unknown.
var ErrNotFound = fmt.Errorf("terminal not found")

// ConflictError signals a duplicate named terminal in the same session (→ 409).
type ConflictError struct{ Name string }

func (e *ConflictError) Error() string {
	return fmt.Sprintf("a named terminal '%s' already exists in this session", e.Name)
}

// TmuxError wraps a failure to create the tmux session (→ 500).
type TmuxError struct{ err error }

func (e *TmuxError) Error() string { return "failed to create tmux session: " + e.err.Error() }
func (e *TmuxError) Unwrap() error { return e.err }
