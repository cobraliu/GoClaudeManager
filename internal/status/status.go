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
	"github.com/loki/goclaudemanager/internal/sdktransport"
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

	// SDK exposes the sdk-transport pump state; sessions with transport=="sdk"
	// are computed from it instead of pane captures. Set after construction.
	SDK *sdktransport.Manager

	mu   sync.RWMutex
	snap map[string]Computed

	// lastAutoConfirm rate-limits the model-switch dialog auto-confirm per
	// session: Compute also runs inline on snapshot misses, so two concurrent
	// calls could otherwise both press Enter — and the second Enter would land
	// on whatever the TUI renders next.
	autoMu          sync.Mutex
	lastAutoConfirm map[string]time.Time
}

// sessionLister is the subset of the store this package needs.
type sessionLister interface {
	All() ([]*model.Session, error)
}

// NewManager builds a status Manager.
func NewManager(store sessionLister, tx *tmux.Client, jc *jsonl.Cache) *Manager {
	return &Manager{store: store, tmux: tx, jsonl: jc, snap: map[string]Computed{},
		lastAutoConfirm: map[string]time.Time{}}
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

	// SDK transport: everything comes from the wrapper's json-out pump — no
	// pane captures, PID files or hook scans (those target the TUI flow).
	if s.Transport == "sdk" {
		return m.computeSDK(s)
	}

	eligible := s.Status == model.StatusRunning || s.Status == model.StatusDetached
	agentID := ""
	if s.AgentSessionID != nil {
		agentID = *s.AgentSessionID
	}

	var auq, approve, planData map[string]any
	planViaScreen := false
	dialogAutoConfirmed := false

	var waitingFor, hintType string
	pidWaiting := false
	pidKnown := false
	if eligible && s.ClaudeProcPID != nil {
		waitingFor, hintType, pidWaiting = claudestat.GetPIDWaitingState(*s.ClaudeProcPID)
		pidKnown = pidWaiting || claudestat.PIDStateKnown(*s.ClaudeProcPID)
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
				if claudestat.IsModelSwitchDialog(screen) {
					// The "Switch model?" / "Set model to…" confirmation dialog
					// (waitingFor "dialog open" also lands here). It blocks the
					// session after the manager sends "/model X" or at startup,
					// and nothing in the web UI can answer it — so press Enter
					// to accept the highlighted default (Yes / this-session-only)
					// and surface no card or hint for this poll.
					m.autoConfirmModelDialog(s)
					dialogAutoConfirmed = true
					break
				}
				// Recognize a plan-approval menu structurally (ParsePlanMenu —
				// the same robust matcher the submit path uses), NOT via a
				// brittle header string like "Claude has written up a plan"
				// that breaks across Claude Code versions. ParsePlanMenu needs
				// ≥2 numbered options plus plan-specific phrasing
				// (bypass permissions / auto-accept edits / manually approve
				// edits) or "Would you like to proceed", none of which appear
				// in a tool-use approval prompt — so it won't misclassify.
				if opts, hi, ok := claudestat.ParsePlanMenu(screen); ok {
					planViaScreen = true
					// Surface the real menu options so the UI can render them
					// like AUQ (instead of a fixed Approve/Reject pair).
					os := make([]map[string]any, len(opts))
					for i, o := range opts {
						os[i] = map[string]any{"index": o.Index, "label": o.Label, "highlighted": o.Highlighted}
					}
					planData = map[string]any{"options": os, "highlighted": hi}
				} else if strings.Contains(screen, "Claude wants to use") ||
					(strings.Contains(screen, "Esc to cancel") && reYesOption.MatchString(screen)) {
					approve = hookApprove
				} else if a, ok := claudestat.ParseAUQFromScreen(screen); ok {
					// Newer Claude Code (≥2.1.x) reports an AskUserQuestion menu in
					// the PID waiting file as a generic "permission prompt", so
					// hintType is "approve" even though the screen shows an AUQ.
					// The plan/permission checks above already claimed genuine
					// approval prompts; ParseAUQFromScreen only matches a real AUQ
					// widget (☐ header + numbered options + Type something/Chat
					// about this), so reaching here means it's a misclassified AUQ.
					// Prefer the hook-recorded payload when it matches the screen:
					// the hook carries the exact original question text, while the
					// screen parse holds only the first rendered line — and the
					// frontend dedups answered questions by text, so all sources
					// must agree or an already-answered AUQ re-pops after submit.
					if hookAuq != nil && claudestat.AUQScreenMatchesHook(a, hookAuq) {
						auq = hookAuq
					} else {
						auq = a
					}
					hintType = "auq"
				}
			}
		}
	}

	// Fallback AUQ from hooks when the screen path didn't resolve one. Skip it
	// when the screen already showed a genuine approval/plan prompt: the process
	// is then blocked on THAT, not an AUQ, so an older (already-answered) AUQ
	// from the hook file must not be resurrected on top of it.
	if auq == nil && approve == nil && !planViaScreen && eligible && agentID != "" {
		if pending, ok := claudestat.PendingAUQFromHooks(agentID, s.Cwd, pidKnown, pidWaiting); ok {
			auq = pending
		}
	}

	// TUI hint.
	var hint *string
	if auq != nil && !pidWaiting {
		h := "Claude is asking a question — answer in Chat or switch to TUI"
		hint = &h
	} else if pidWaiting && !dialogAutoConfirmed {
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

// autoConfirmModelDialog presses Enter in the session's pane to accept the
// highlighted default option of a model-switch dialog. Rate-limited per
// session: the dialog needs ~1s to clear after Enter and Compute can run
// concurrently (refresh loop + inline snapshot misses), so without the
// limiter a second Enter could fire and land on whatever renders next.
func (m *Manager) autoConfirmModelDialog(s *model.Session) {
	now := time.Now()
	m.autoMu.Lock()
	if now.Sub(m.lastAutoConfirm[s.ID]) < 5*time.Second {
		m.autoMu.Unlock()
		return
	}
	m.lastAutoConfirm[s.ID] = now
	m.autoMu.Unlock()
	if _, err := m.tmux.Run("send-keys", "-t", s.TmuxSessionName, "Enter"); err != nil {
		slog.Warn("status: model dialog auto-confirm failed",
			"session", s.ID, "tmux", s.TmuxSessionName, "err", err)
		return
	}
	slog.Info("status: auto-confirmed model-switch dialog",
		"session", s.ID, "tmux", s.TmuxSessionName)
}

// computeSDK builds Computed for an sdk-transport session from the pump state.
func (m *Manager) computeSDK(s *model.Session) Computed {
	if m.SDK == nil {
		return Computed{}
	}
	st, ok := m.SDK.State(s.ID)
	if !ok {
		return Computed{}
	}
	var c Computed
	if st.PendingAUQ != nil {
		c.TuiAuqData = st.PendingAUQ.Data
		h := "Claude is asking a question — answer in Chat or switch to TUI"
		c.TuiHint = &h
	}
	if st.PendingPlan != nil {
		c.TuiPlanPending = true
		c.TuiPlanData = st.PendingPlan.Data
		if c.TuiHint == nil {
			h := "Claude proposed a plan — review in Chat or switch to TUI"
			c.TuiHint = &h
		}
	}
	return c
}
