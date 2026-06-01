// Package status computes and caches the owner-independent live-status fields
// for sessions (AUQ / approval / plan-pending / compacting / TUI hint).
//
// This is the perf-critical part of the status poll. The Python version
// (sessions.compute_session_status + refresh_status_snapshot) ran per-session
// JSONL scans + tmux pane captures on a thread pool every ~2s and cached the
// result. We do the same: a background loop recomputes active sessions and
// swaps a snapshot map atomically; the /status endpoint reads the snapshot.
package status

import (
	"context"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/loki/goclaudemanager/internal/claudestat"
	"github.com/loki/goclaudemanager/internal/jsonl"
	"github.com/loki/goclaudemanager/internal/model"
	"github.com/loki/goclaudemanager/internal/tmux"
)

// Computed holds the per-session live-status fields (mirrors the dict returned
// by compute_session_status — excludes the cheap per-request fields).
type Computed struct {
	IsCompacting       bool           `json:"is_compacting"`
	CompactingProgress *string        `json:"compacting_progress"`
	TuiHint            *string        `json:"tui_hint"`
	TuiAuqData         map[string]any `json:"tui_auq_data"`
	TuiApproveData     map[string]any `json:"tui_approve_data"`
	TuiPlanPending     bool           `json:"tui_plan_pending"`
	TuiPlanData        map[string]any `json:"tui_plan_data"`
}

var reYesOption = regexp.MustCompile(`❯\s*1\.\s*Yes`)

// Manager owns the status snapshot and its refresh loop.
type Manager struct {
	store sessionLister
	tmux  *tmux.Client
	jsonl *jsonl.Cache

	mu   sync.RWMutex
	snap map[string]Computed
}

// sessionLister is the subset of the store this package needs.
type sessionLister interface {
	All() ([]*model.Session, error)
}

// NewManager builds a status Manager.
func NewManager(store sessionLister, tx *tmux.Client, jc *jsonl.Cache) *Manager {
	return &Manager{store: store, tmux: tx, jsonl: jc, snap: map[string]Computed{}}
}

// Get returns the cached status for a session, if present.
func (m *Manager) Get(sessionID string) (Computed, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.snap[sessionID]
	return c, ok
}

// Run refreshes the snapshot for active sessions at a bounded cadence (≥2s
// between starts) until ctx is cancelled.
func (m *Manager) Run(ctx context.Context) {
	const period = 2 * time.Second
	for {
		start := time.Now()
		m.refresh()
		wait := period - time.Since(start)
		if wait < 500*time.Millisecond {
			wait = 500 * time.Millisecond
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (m *Manager) refresh() {
	all, err := m.store.All()
	if err != nil {
		slog.Warn("status refresh: store.All failed", "err", err)
		return
	}
	next := make(map[string]Computed)
	for _, s := range all {
		if s.Status != model.StatusRunning && s.Status != model.StatusDetached {
			continue
		}
		next[s.ID] = m.Compute(s)
	}
	m.mu.Lock()
	m.snap = next
	m.mu.Unlock()
}

// Compute calculates the live status for one session (port of
// compute_session_status). Safe to call inline on a snapshot miss.
func (m *Manager) Compute(s *model.Session) Computed {
	// Codex app-server transport is handled by the codex manager (Phase 3).
	if s.Tool == "codex" && s.CodexTransport == "app_server" {
		return Computed{}
	}

	eligible := s.Status == model.StatusRunning || s.Status == model.StatusDetached
	agentID := ""
	if s.AgentSessionID != nil {
		agentID = *s.AgentSessionID
	}

	var auq, approve, planData map[string]any
	planViaScreen := false

	var waitingFor, hintType string
	pidWaiting := false
	if eligible && s.ClaudeProcPID != nil {
		waitingFor, hintType, pidWaiting = claudestat.GetPIDWaitingState(*s.ClaudeProcPID)
	}

	if pidWaiting {
		var hookAuq, hookApprove map[string]any
		if agentID != "" {
			hookAuq, hookApprove = claudestat.ReadSessionHooks(agentID)
		}
		switch hintType {
		case "auq":
			auq = hookAuq
			if auq == nil {
				if screen := m.tmux.CaptureVisibleScreen(s.TmuxSessionName); screen != "" {
					if a, ok := claudestat.ParseAUQFromScreen(screen); ok {
						auq = a
					}
				}
			}
		case "approve":
			if screen := m.tmux.CaptureVisibleScreen(s.TmuxSessionName); screen != "" {
				switch {
				case strings.Contains(screen, "Claude has written up a plan"):
					planViaScreen = true
					// Surface the real menu options so the UI can render them
					// like AUQ (instead of a fixed Approve/Reject pair).
					if opts, hi, ok := claudestat.ParsePlanMenu(screen); ok {
						os := make([]map[string]any, len(opts))
						for i, o := range opts {
							os[i] = map[string]any{"index": o.Index, "label": o.Label, "highlighted": o.Highlighted}
						}
						planData = map[string]any{"options": os, "highlighted": hi}
					}
				case strings.Contains(screen, "Claude wants to use"),
					strings.Contains(screen, "Esc to cancel") && reYesOption.MatchString(screen):
					approve = hookApprove
				}
			}
		}
	}

	// Fallback AUQ from hooks when the PID file didn't flag waiting.
	if auq == nil && eligible && agentID != "" {
		if pending, ok := claudestat.PendingAUQFromHooks(agentID, s.Cwd); ok {
			auq = pending
		}
	}

	// TUI hint.
	var hint *string
	if auq != nil && !pidWaiting {
		h := "Claude is asking a question — answer in Chat or switch to TUI"
		hint = &h
	} else if pidWaiting {
		h := claudestat.FormatTUIHint(waitingFor, hintType)
		hint = &h
	}

	// Compaction detection.
	isCompacting := false
	var progress *string
	screenForHook := ""
	if eligible && auq == nil && approve == nil && s.LastActivityAt != nil {
		if time.Since(s.LastActivityAt.Time) < 60*time.Second {
			screenForHook = m.tmux.CaptureVisibleScreen(s.TmuxSessionName)
		}
	}
	if eligible && agentID != "" {
		if claudestat.IsCompactingViaHook(agentID, s.Cwd, screenForHook) {
			isCompacting = true
		}
	}
	if screenForHook != "" {
		if prog, comp := claudestat.CompactingFromScreen(screenForHook); comp {
			isCompacting = true
			if prog != "" {
				p := prog
				progress = &p
			}
		}
	}

	// Plan-approval attention: screen signal OR JSONL ExitPlanMode-without-result.
	planPending := planViaScreen
	if !planPending && eligible && agentID != "" {
		path := jsonl.FindSessionJSONL(agentID, s.Cwd)
		if path != "" {
			planPending = m.jsonl.PlanPending(path)
		}
	}

	return Computed{
		IsCompacting:       isCompacting,
		CompactingProgress: progress,
		TuiHint:            hint,
		TuiAuqData:         auq,
		TuiApproveData:     approve,
		TuiPlanPending:     planPending,
		TuiPlanData:        planData,
	}
}
