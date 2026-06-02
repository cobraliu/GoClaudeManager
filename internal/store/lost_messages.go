package store

import (
	"fmt"
	"strings"
	"time"

	"github.com/loki/goclaudemanager/internal/model"
)

// The "send failed" (lost message) registry.
//
// A lost message is a prompt a client detected as never having reached the
// agent — eaten by auto-compact, or a plain send timeout. We register it
// server-side (in memory, keyed by session id) so the indicator shows on, and
// can be dismissed from, EVERY connected client rather than only the tab that
// sent it. Entries are intentionally not persisted: they are ephemeral
// attention items and safe to drop on restart.
//
// Dedup is by exact (trimmed) text within a small time window of SentAt, so a
// client that re-registers the same loss (or a second client polling) does not
// produce duplicate bubbles.

// lostDedupWindow is how close two SentAt values must be (in seconds) for the
// same text to be treated as the same lost message rather than a new one.
const lostDedupWindow = 5.0

func nowEpoch() float64 { return float64(time.Now().UnixNano()) / 1e9 }

// RegisterLostMessage records (or returns the existing) lost message for a
// session and returns it. Dedup: same trimmed text and a SentAt within
// lostDedupWindow seconds of an existing entry returns that entry unchanged.
func (s *Store) RegisterLostMessage(sessionID, text string, sentAt float64) model.LostMessage {
	trimmed := strings.TrimSpace(text)
	s.lostMu.Lock()
	defer s.lostMu.Unlock()
	if s.lost == nil {
		s.lost = make(map[string][]model.LostMessage)
	}
	for _, lm := range s.lost[sessionID] {
		if strings.TrimSpace(lm.Text) == trimmed && abs(lm.SentAt-sentAt) <= lostDedupWindow {
			return lm
		}
	}
	s.lostN++
	lm := model.LostMessage{
		ID:        fmt.Sprintf("lost-%d-%d", time.Now().UnixNano(), s.lostN),
		Text:      text,
		SentAt:    sentAt,
		CreatedAt: nowEpoch(),
	}
	s.lost[sessionID] = append(s.lost[sessionID], lm)
	return lm
}

// ListLostMessages returns the lost messages for a session (oldest first), or
// nil if none. The returned slice is a copy safe for the caller to keep.
func (s *Store) ListLostMessages(sessionID string) []model.LostMessage {
	s.lostMu.Lock()
	defer s.lostMu.Unlock()
	src := s.lost[sessionID]
	if len(src) == 0 {
		return nil
	}
	out := make([]model.LostMessage, len(src))
	copy(out, src)
	return out
}

// DismissLostMessage removes a single lost message by id (manual dismiss).
func (s *Store) DismissLostMessage(sessionID, lostID string) {
	s.lostMu.Lock()
	defer s.lostMu.Unlock()
	src := s.lost[sessionID]
	if len(src) == 0 {
		return
	}
	out := src[:0:0]
	for _, lm := range src {
		if lm.ID != lostID {
			out = append(out, lm)
		}
	}
	s.setLostLocked(sessionID, out)
}

// ClearLostMessagesByText removes every lost message for a session whose
// trimmed text matches — called when the same prompt is later delivered
// successfully (rule: a successful resubmit of the same message clears it on
// all clients).
func (s *Store) ClearLostMessagesByText(sessionID, text string) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return
	}
	s.lostMu.Lock()
	defer s.lostMu.Unlock()
	src := s.lost[sessionID]
	if len(src) == 0 {
		return
	}
	out := src[:0:0]
	for _, lm := range src {
		if strings.TrimSpace(lm.Text) != trimmed {
			out = append(out, lm)
		}
	}
	s.setLostLocked(sessionID, out)
}

// setLostLocked stores the slice for a session, deleting the key when empty.
// Caller must hold lostMu.
func (s *Store) setLostLocked(sessionID string, v []model.LostMessage) {
	if len(v) == 0 {
		delete(s.lost, sessionID)
		return
	}
	s.lost[sessionID] = v
}

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}
