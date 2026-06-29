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

	// lastAUQSubmit records when the web/mobile API last drove an AUQ submit via
	// send-keys for a session. The status loop uses it to detect the occasional
	// "stuck on the Submit answers confirm" case (a missed confirming Enter) and
	// press Enter once more. Guarded by autoMu.
	lastAUQSubmit map[string]time.Time
}

// sessionLister is the subset of the store this package needs.
type sessionLister interface {
	All() ([]*model.Session, error)
}

// NewManager builds a status Manager.
func NewManager(store sessionLister, tx *tmux.Client, jc *jsonl.Cache) *Manager {
	return &Manager{store: store, tmux: tx, jsonl: jc, snap: map[string]Computed{},
		lastAutoConfirm: map[string]time.Time{},
		lastAUQSubmit:   map[string]time.Time{}}
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

// computeConcurrency bounds how many sessions are Compute'd in parallel per
// refresh. Each Compute spawns tmux subprocesses + reads files; a small pool
// keeps a 30-session machine from forking 30 tmux captures at once while still
// collapsing the wall-clock from sum-of-sessions to ceil(n/pool).
const computeConcurrency = 8

// refreshDeadline caps how long one refresh waits for stragglers. tmux.run has
// no timeout, so a wedged pane capture would otherwise stall the whole loop;
// past the deadline we stop waiting and carry the previous snapshot value
// forward for any session that hasn't reported yet.
const refreshDeadline = 10 * time.Second

func (m *Manager) refresh() {
	all, err := m.store.All()
	if err != nil {
		slog.Warn("status refresh: store.All failed", "err", err)
		return
	}
	active := make([]*model.Session, 0, len(all))
	for _, s := range all {
		if s.Status != model.StatusRunning && s.Status != model.StatusDetached {
			continue
		}
		active = append(active, s)
	}

	next := make(map[string]Computed, len(active))
	if len(active) == 0 {
		m.mu.Lock()
		m.snap = next
		m.mu.Unlock()
		return
	}

	// Previous snapshot is the carry-forward source for sessions that miss the
	// deadline (a wedged tmux capture must not drop a session from /status).
	m.mu.RLock()
	prev := m.snap
	m.mu.RUnlock()

	type result struct {
		id string
		c  Computed
	}
	// Buffered to len(active) so a straggler goroutine can always complete its
	// send and exit even after we've stopped collecting — no goroutine leak
	// beyond the hung syscall itself.
	results := make(chan result, len(active))
	sem := make(chan struct{}, computeConcurrency)
	for _, s := range active {
		s := s
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()
			results <- result{s.ID, m.Compute(s)}
		}()
	}

	got := make(map[string]bool, len(active))
	timeout := time.After(refreshDeadline)
collect:
	for i := 0; i < len(active); i++ {
		select {
		case r := <-results:
			next[r.id] = r.c
			got[r.id] = true
		case <-timeout:
			slog.Warn("status refresh: deadline hit, carrying forward stragglers",
				"reported", len(got), "active", len(active))
			break collect
		}
	}
	// Carry forward any session that didn't report in time.
	for _, s := range active {
		if !got[s.ID] {
			if c, ok := prev[s.ID]; ok {
				next[s.ID] = c
			}
		}
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
		// Single read of ~/.claude/sessions/{pid}.json yields both the waiting
		// state and whether the file is parseable (pidKnown) — avoids two reads
		// of the same small file per session per poll.
		waitingFor, hintType, pidWaiting, pidKnown = claudestat.GetPIDState(*s.ClaudeProcPID)
	}

	// captureScreen lazily captures the pane's visible screen at most once per
	// Compute and memoizes the result. Several branches below (AUQ / approve /
	// model-dialog, then compaction) inspect the same screen; without memoization
	// each would fork its own `tmux capture-pane` subprocess for the same pane in
	// a single 2s poll — wasted process spawns multiplied by every active session.
	var screenCache string
	var screenCaptured bool
	captureScreen := func() string {
		if !screenCaptured {
			screenCache = m.tmux.CaptureVisibleScreen(s.TmuxSessionName)
			screenCaptured = true
		}
		return screenCache
	}

	// Occasionally a web/mobile AUQ submit's confirming Enter doesn't land and the
	// session is stranded on the "Ready to submit your answers?" menu. If we just
	// submitted for this session and that menu is still up, press Enter once more.
	// Cheap on the common path: it only captures the screen when a submit was
	// recently recorded for this session.
	if eligible {
		m.maybeRetryAUQSubmit(s, captureScreen)
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
				if screen := captureScreen(); screen != "" {
					if a, ok := claudestat.ParseAUQFromScreen(screen); ok {
						auq = a
					}
				}
			}
		case "approve":
			if screen := captureScreen(); screen != "" {
				// Claim a real AskUserQuestion FIRST. Newer Claude Code (≥2.1.x)
				// reports an AUQ in the PID file as a generic "permission prompt",
				// so AUQs land in this approve branch too. The model-switch check
				// must NOT run before it: IsModelSwitchDialog fires on a model
				// header substring within 12 lines above a "❯ 1." row, and an AUQ's
				// first option renders as exactly "❯ 1. …" — so a model-themed
				// question (or residual "Set model to…" text from the manager's own
				// /model switch just above the menu) would make autoConfirm press
				// Enter and pre-answer the AUQ with option 1, destroying the user's
				// custom answer. ParseAUQFromScreen only matches a real AUQ widget
				// (☐ header + options + Type something/Chat about this); model/plan/
				// permission screens have no ☐, so claiming AUQ first never steals a
				// genuine one. Prefer the hook payload when it matches the screen:
				// the hook carries the exact original question text, while the screen
				// parse holds only the first rendered line — and the frontend dedups
				// answered questions by text, so the sources must agree or an
				// already-answered AUQ re-pops after submit.
				if a, ok := claudestat.ParseAUQFromScreen(screen); ok {
					if hookAuq != nil && claudestat.AUQScreenMatchesHook(a, hookAuq) {
						auq = hookAuq
					} else {
						auq = a
					}
					hintType = "auq"
				} else if claudestat.IsModelSwitchDialog(screen) {
					// The "Switch model?" / "Set model to…" confirmation dialog
					// (waitingFor "dialog open" also lands here). It blocks the
					// session after the manager sends "/model X" or at startup,
					// and nothing in the web UI can answer it — so press Enter
					// to accept the highlighted default (Yes / this-session-only)
					// and surface no card or hint for this poll.
					m.autoConfirmModelDialog(s)
					dialogAutoConfirmed = true
				} else if opts, hi, ok := claudestat.ParsePlanMenu(screen); ok {
					// Recognize a plan-approval menu structurally (ParsePlanMenu —
					// the same robust matcher the submit path uses), NOT via a
					// brittle header string like "Claude has written up a plan"
					// that breaks across Claude Code versions. ParsePlanMenu needs
					// ≥2 numbered options plus plan-specific phrasing
					// (bypass permissions / auto-accept edits / manually approve
					// edits) or "Would you like to proceed", none of which appear
					// in a tool-use approval prompt — so it won't misclassify.
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
			// Reuses the memoized capture when the pidWaiting branch above already
			// grabbed this pane's screen this poll.
			screenForHook = captureScreen()
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

// auqRetryMinAge / auqRetryMaxAge bound when the stuck-confirm auto-retry may
// fire after an AUQ submit: not before the submit handler's own confirming Enter
// has had time to land and the TUI to render (min), and not so long after that
// it's no longer plausibly our missed-Enter case (max).
const (
	auqRetryMinAge = 2 * time.Second
	auqRetryMaxAge = 12 * time.Second
)

// NoteAUQSubmitted records that an AUQ answer was just submitted via send-keys
// for the session, arming the stuck-confirm auto-retry. Called by the AUQ submit
// API handlers immediately after they finish sending keystrokes.
func (m *Manager) NoteAUQSubmitted(sessionID string) {
	m.autoMu.Lock()
	m.lastAUQSubmit[sessionID] = time.Now()
	m.autoMu.Unlock()
}

// maybeRetryAUQSubmit handles the occasional case where a web/mobile AUQ submit's
// confirming Enter doesn't take and the session is left on the "Ready to submit
// your answers?" menu. If we recently submitted for this session AND that confirm
// menu is still on screen, press Enter once more, then disarm so it fires at most
// once per submit.
func (m *Manager) maybeRetryAUQSubmit(s *model.Session, captureScreen func() string) {
	m.autoMu.Lock()
	submittedAt, armed := m.lastAUQSubmit[s.ID]
	m.autoMu.Unlock()
	if !armed {
		return
	}
	age := time.Since(submittedAt)
	if age < auqRetryMinAge || age > auqRetryMaxAge {
		// Outside the window. Reap a stale stamp so the map can't grow unbounded
		// for sessions that submitted but never got stuck.
		if age > auqRetryMaxAge {
			m.autoMu.Lock()
			delete(m.lastAUQSubmit, s.ID)
			m.autoMu.Unlock()
		}
		return
	}
	screen := captureScreen()
	if screen == "" || !claudestat.IsAUQSubmitConfirm(screen) {
		return
	}
	// Disarm before sending so a concurrent inline Compute can't double-press.
	m.autoMu.Lock()
	delete(m.lastAUQSubmit, s.ID)
	m.autoMu.Unlock()
	if _, err := m.tmux.Run("send-keys", "-t", s.TmuxSessionName+":0.0", "Enter"); err != nil {
		slog.Warn("status: AUQ submit auto-retry failed",
			"session", s.ID, "tmux", s.TmuxSessionName, "err", err)
		return
	}
	slog.Info("status: auto-retried stuck AUQ submit confirm",
		"session", s.ID, "tmux", s.TmuxSessionName, "ageMs", age.Milliseconds())
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
