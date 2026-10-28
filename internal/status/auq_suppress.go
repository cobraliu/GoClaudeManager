package status

import (
	"strings"
	"time"
)

// AUQ submit suppression.
//
// The tmux transport answers an AskUserQuestion by typing into the Ink TUI one
// question at a time (≈1.2s apart), then confirming "Submit answers". While
// that runs — and for a moment after, until the TUI repaints — the screen
// parser and hook fallback keep reporting the questions being answered: first
// the next unanswered question of the same batch, then the review/confirm
// screen. The frontend treated those as a brand-new AUQ, so an answered card
// popped back up and then vanished on its own a few seconds later.
//
// While a submit is in flight every AUQ signal is suppressed; for a short
// window after it, only signals matching one of the submitted questions are.
// A genuinely new AUQ (different text) still surfaces immediately after.

const (
	auqSubmitInFlightGrace = 2 * time.Second  // after End: still treat as in flight
	auqSubmitMatchWindow   = 12 * time.Second // after End: suppress same-text AUQs
	auqSubmitMaxInFlight   = 30 * time.Second // Begin without End (handler died)
)

type auqSubmitState struct {
	questions []string // normalized question texts of the submitted batch
	begun     time.Time
	ended     time.Time // zero while keystrokes are still being sent
}

// BeginAUQSubmit marks a send-keys AUQ submit as in flight for the session.
// questions are the texts of the batch being answered; when empty the
// currently surfaced AUQ (from the cached snapshot) is used.
func (m *Manager) BeginAUQSubmit(sessionID string, questions []string) {
	if len(questions) == 0 {
		m.mu.RLock()
		c, ok := m.snap[sessionID]
		m.mu.RUnlock()
		if ok {
			questions = auqQuestionTexts(c.TuiAuqData)
		}
	}
	norm := make([]string, 0, len(questions))
	for _, q := range questions {
		if n := normAUQText(q); n != "" {
			norm = append(norm, n)
		}
	}
	m.autoMu.Lock()
	m.auqSubmits[sessionID] = &auqSubmitState{questions: norm, begun: time.Now()}
	m.autoMu.Unlock()
}

// endAUQSubmit records that the submit's keystrokes have all been sent.
func (m *Manager) endAUQSubmit(sessionID string) {
	m.autoMu.Lock()
	if st := m.auqSubmits[sessionID]; st != nil {
		st.ended = time.Now()
	}
	m.autoMu.Unlock()
}

// auqSuppression reports whether the session has a submit in flight
// (suppress all AUQ signals) and the submitted texts still in the match
// window (suppress AUQ signals with those texts).
func (m *Manager) auqSuppression(sessionID string) (inFlight bool, recent []string) {
	m.autoMu.Lock()
	defer m.autoMu.Unlock()
	st := m.auqSubmits[sessionID]
	if st == nil {
		return false, nil
	}
	now := time.Now()
	if st.ended.IsZero() {
		if now.Sub(st.begun) > auqSubmitMaxInFlight {
			delete(m.auqSubmits, sessionID)
			return false, nil
		}
		return true, st.questions
	}
	age := now.Sub(st.ended)
	if age > auqSubmitMatchWindow {
		delete(m.auqSubmits, sessionID)
		return false, nil
	}
	return age < auqSubmitInFlightGrace, st.questions
}

// auqMatchesSubmitted reports whether any question in auq data is one of the
// submitted texts (prefix-tolerant: the screen parse holds only the first
// rendered line of a question).
func auqMatchesSubmitted(auq map[string]any, submitted []string) bool {
	for _, q := range auqQuestionTexts(auq) {
		n := normAUQText(q)
		if n == "" {
			continue
		}
		for _, s := range submitted {
			if strings.HasPrefix(s, n) || strings.HasPrefix(n, s) {
				return true
			}
		}
	}
	return false
}

// auqQuestionTexts extracts question texts from tui_auq_data, which is either
// {questions:[{question,...}]} (hooks/JSONL/sdk) or a flat {question,...}
// (screen parse).
func auqQuestionTexts(auq map[string]any) []string {
	if auq == nil {
		return nil
	}
	var out []string
	switch qs := auq["questions"].(type) {
	case []any:
		for _, q := range qs {
			if m, ok := q.(map[string]any); ok {
				if t, _ := m["question"].(string); t != "" {
					out = append(out, t)
				}
			}
		}
	case []map[string]any:
		for _, m := range qs {
			if t, _ := m["question"].(string); t != "" {
				out = append(out, t)
			}
		}
	}
	if t, _ := auq["question"].(string); t != "" {
		out = append(out, t)
	}
	return out
}

// normAUQText mirrors the frontend's _auqNormText: drop markdown markers
// (Ink strips them on screen) and collapse whitespace.
func normAUQText(s string) string {
	s = strings.Map(func(r rune) rune {
		switch r {
		case '*', '`', '_', '#':
			return -1
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}
