package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/claudestat"
	"github.com/loki/goclaudemanager/internal/jsonl"
	"github.com/loki/goclaudemanager/internal/model"
)

// registerTUIActionRoutes registers the interactive Ink-TUI answering endpoints
// plus rewind, ported from app/api/sessions.py. These drive Claude Code's Ink
// TUI by sending raw tmux keystrokes with time.Sleep delays; the key names and
// sleep timings below are matched byte-for-byte against the Python source.
//
// Paths are relative to the sessions mount (which already applies RequireUser).
func registerTUIActionRoutes(r chi.Router, d Deps) {
	r.Post("/{id}/answer-auq", func(w http.ResponseWriter, r *http.Request) { answerAUQ(d, w, r) })
	r.Post("/{id}/auq/submit", func(w http.ResponseWriter, r *http.Request) { auqSubmit(d, w, r) })
	r.Post("/{id}/tool-approve", func(w http.ResponseWriter, r *http.Request) { toolApprove(d, w, r) })
	r.Post("/{id}/plan-approve", func(w http.ResponseWriter, r *http.Request) { planApprove(d, w, r) })
	r.Post("/{id}/rewind", func(w http.ResponseWriter, r *http.Request) { rewindSession(d, w, r) })
}

// downArrow is the literal escape sequence Ink interprets as Down ("\x1b[B").
const downArrow = "\x1b[B"

// ── POST /{id}/answer-auq ──────────────────────────────────────────────────

type auqAnswerItem struct {
	OptionIdx     *int    `json:"option_idx"`
	OptionIndices []int   `json:"option_indices"`
	NOptions      int     `json:"n_options"`
	CustomText    *string `json:"custom_text"`
	IsMulti       bool    `json:"is_multi"`
}

type auqAnswerRequest struct {
	Answers          []auqAnswerItem `json:"answers"`
	SubmitConfirmIdx *int            `json:"submit_confirm_idx"`
}

// answerAUQ submits structured answers to a Claude Code AskUserQuestion Ink TUI.
func answerAUQ(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body auqAnswerRequest
	if !readJSON(w, r, &body) {
		return
	}

	pane := s.TmuxSessionName + ":0.0"

	for i, answer := range body.Answers {
		if i > 0 {
			time.Sleep(1200 * time.Millisecond) // wait for Ink TUI to render next question
		}

		switch {
		case answer.CustomText != nil:
			// Navigate to "Type something" first, wait for Ink to re-render and
			// activate the text input, THEN send the text. Sending nav+text
			// atomically causes the text to arrive before Ink activates the
			// field and the characters get lost.
			nav := strings.Repeat(downArrow, answer.NOptions)
			text := strings.TrimSpace(*answer.CustomText)
			if nav != "" {
				d.Tmux.Run("send-keys", "-t", pane, "-l", nav)
			}
			time.Sleep(200 * time.Millisecond) // wait for Ink to render text input
			if text != "" {
				d.Tmux.Run("send-keys", "-t", pane, "-l", "--", text)
			}
			if answer.IsMulti {
				// Multi-select: navigate from "Type something" (n_options) to
				// Submit/Next (n_options+1) so the generic final Enter hits Submit.
				time.Sleep(100 * time.Millisecond)
				d.Tmux.Run("send-keys", "-t", pane, "-l", downArrow)
			}
		case len(answer.OptionIndices) > 0:
			// Multi-select: navigate to each option, Enter to select it (cursor
			// stays), then navigate to the Submit/Next button and leave final
			// Enter to the generic step. Separate send-keys calls with a short
			// pause so Ink processes each selection.
			indices := append([]int(nil), answer.OptionIndices...)
			sort.Ints(indices)
			curPos := 0
			for _, idx := range indices {
				downCount := idx - curPos
				if downCount > 0 {
					d.Tmux.Run("send-keys", "-t", pane, "-l", strings.Repeat(downArrow, downCount))
				}
				d.Tmux.Run("send-keys", "-t", pane, "Enter") // select this option
				time.Sleep(150 * time.Millisecond)           // let Ink register the selection
				curPos = idx
			}
			// Navigate from last selected position to Submit/Next button (n_options+1).
			submitPos := answer.NOptions + 1
			downToSubmit := submitPos - curPos
			if downToSubmit > 0 {
				d.Tmux.Run("send-keys", "-t", pane, "-l", strings.Repeat(downArrow, downToSubmit))
			}
		case answer.OptionIdx != nil && *answer.OptionIdx > 0:
			// Single-select: navigate Down × N.
			nav := strings.Repeat(downArrow, *answer.OptionIdx)
			d.Tmux.Run("send-keys", "-t", pane, "-l", nav)
		}

		// Confirm with Enter.
		d.Tmux.Run("send-keys", "-t", pane, "Enter")
	}

	// Final "Submit Answers" confirmation question (multi-question only).
	// Claude Code shows an extra Q after all questions asking whether to submit;
	// "Submit Answers" is typically at option index 1.
	if body.SubmitConfirmIdx != nil {
		time.Sleep(1200 * time.Millisecond)
		nav := strings.Repeat(downArrow, *body.SubmitConfirmIdx)
		if nav != "" {
			d.Tmux.Run("send-keys", "-t", pane, "-l", nav)
		}
		d.Tmux.Run("send-keys", "-t", pane, "Enter")
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── POST /{id}/auq/submit ──────────────────────────────────────────────────

type auqSubmitBody struct {
	// Answers is heterogeneous: each entry is either a string (single/custom),
	// or a list of action objects (multi-select). Decoded as json.RawMessage and
	// dispatched on type at runtime, mirroring Python's isinstance checks.
	Answers    []json.RawMessage `json:"answers"`
	Questions  []map[string]any  `json:"questions"`
	SingleShot bool              `json:"single_shot"`
}

// auqSubmit drives an AUQ via tmux send-keys; the frontend may submit either a
// per-question single/custom string answer, or an explicit multi-select action
// list, one entry per TUI row in order.
func auqSubmit(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body auqSubmitBody
	if !readJSON(w, r, &body) {
		return
	}

	pane := s.TmuxSessionName + ":0.0"
	questions := body.Questions

	for i, raw := range body.Answers {
		if i > 0 {
			time.Sleep(1200 * time.Millisecond)
		}

		var qDef map[string]any
		if i < len(questions) {
			qDef = questions[i]
		}
		optionLabels := auqOptionLabels(qDef)
		nOpts := len(optionLabels)
		isMulti := asBool(qDef["multiSelect"])

		// Determine the runtime shape of this answer.
		var actions []map[string]any
		var strAnswer string
		isList := json.Unmarshal(raw, &actions) == nil
		if !isList {
			_ = json.Unmarshal(raw, &strAnswer)
		}

		if isList {
			// Multi-select: explicit action list, one entry per TUI row in order.
			//   {"type": "option", "click": bool}
			//   {"type": "type_something", "value": str}
			//   {"type": "submit"}
			slog.Warn("[AUQ] answer", "answer", string(raw))
			for ai, action := range actions {
				atype, _ := action["type"].(string)
				switch atype {
				case "option":
					if asBool(action["click"]) {
						slog.Warn("[AUQ] option→Enter", "ai", ai)
						d.Tmux.Run("send-keys", "-t", pane, "Enter")
						time.Sleep(300 * time.Millisecond)
					}
				case "type_something":
					value := strings.TrimSpace(asString(action["value"]))
					if value != "" {
						slog.Warn("[AUQ] type_something→Enter+type", "ai", ai, "value", value)
						d.Tmux.Run("send-keys", "-t", pane, "Enter") // activate text input
						time.Sleep(200 * time.Millisecond)
						d.Tmux.Run("send-keys", "-t", pane, "-l", value)
						time.Sleep(300 * time.Millisecond)
					}
				case "submit":
					slog.Warn("[AUQ] submit→Enter", "ai", ai)
					d.Tmux.Run("send-keys", "-t", pane, "Enter")
					goto innerDone
				}
				if ai < len(actions)-1 {
					slog.Warn("[AUQ] →Down", "ai", ai)
					d.Tmux.Run("send-keys", "-t", pane, "Down")
					time.Sleep(150 * time.Millisecond)
				}
			}
		innerDone:
			slog.Warn("[AUQ] inner loop done, continue outer")
			continue // Submit Enter already sent above; skip common per-answer Enter
		} else if !containsString(optionLabels, strAnswer) {
			// Custom text.
			nav := strings.Repeat(downArrow, nOpts)
			if nav != "" {
				d.Tmux.Run("send-keys", "-t", pane, "-l", nav)
				time.Sleep(200 * time.Millisecond)
			}
			if strings.TrimSpace(strAnswer) != "" {
				d.Tmux.Run("send-keys", "-t", pane, "-l", strings.TrimSpace(strAnswer))
				time.Sleep(100 * time.Millisecond)
			}
			if isMulti {
				d.Tmux.Run("send-keys", "-t", pane, "-l", downArrow)
				time.Sleep(100 * time.Millisecond)
			}
		} else {
			// Single-select.
			idx := 0
			if strAnswer != "" {
				if pos := indexOfString(optionLabels, strAnswer); pos >= 0 {
					idx = pos
				}
			}
			for j := 0; j < idx; j++ {
				d.Tmux.Run("send-keys", "-t", pane, "Down")
				time.Sleep(150 * time.Millisecond)
			}
			if idx > 0 {
				time.Sleep(100 * time.Millisecond)
			}
		}

		d.Tmux.Run("send-keys", "-t", pane, "Enter")
	}

	if body.SingleShot {
		// single_shot mode (pending AUQ: one question at a time).
		// After answering, check what the TUI shows:
		//   "Submit Answers" → last question of a multi-question AUQ → confirm.
		//   A new question (☐ header) → more questions follow → no Enter.
		time.Sleep(1000 * time.Millisecond)
		screen, err := d.Tmux.Run("capture-pane", "-p", "-t", s.TmuxSessionName)
		if err == nil && screen != "" && strings.Contains(screen, "Submit Answers") && !strings.Contains(screen, "☐") {
			d.Tmux.Run("send-keys", "-t", pane, "Enter")
		}
	} else {
		// Batch mode: final Enter confirms "Submit Answers" for multi-question AUQs.
		time.Sleep(1200 * time.Millisecond)
		d.Tmux.Run("send-keys", "-t", pane, "Enter")
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "via": "send-keys"})
}

// ── POST /{id}/tool-approve ────────────────────────────────────────────────

type toolApproveBody struct {
	Decision string `json:"decision"` // "allow" | "deny"
}

var (
	reYesArrow = regexp.MustCompile(`❯\s*1\.\s*Yes`)
	reNoOption = regexp.MustCompile(`(?m)^\s*(\d+)\.\s+No\b`)
)

// toolApprove approves or denies a pending tool permission request, dispatching
// on the on-screen modal fingerprint. Legacy "Claude wants to use" modals take
// y/n shortcuts; numbered-option modals ("Esc to cancel" + "❯ 1. Yes") take
// arrow navigation. If neither matches we refuse (409) rather than risk a
// default-Yes.
func toolApprove(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body toolApproveBody
	if !readJSON(w, r, &body) {
		return
	}

	pane := s.TmuxSessionName + ":0.0"
	screen := d.Tmux.CaptureVisibleScreen(s.TmuxSessionName)

	switch {
	case strings.Contains(screen, "Claude wants to use"):
		// Legacy modal: y/n shortcuts.
		key := "y"
		if body.Decision != "allow" {
			key = "n"
		}
		d.Tmux.Run("send-keys", "-t", pane, key)
		time.Sleep(50 * time.Millisecond)
		d.Tmux.Run("send-keys", "-t", pane, "Enter")
	case strings.Contains(screen, "Esc to cancel") && reYesArrow.MatchString(screen):
		if body.Decision == "allow" {
			d.Tmux.Run("send-keys", "-t", pane, "Enter")
		} else {
			// Locate the "No" line — index 2 (2-option) or 3 (3-option).
			m := reNoOption.FindStringSubmatch(screen)
			if m == nil {
				writeErr(w, http.StatusConflict, "numbered modal detected but 'No' option not found")
				return
			}
			noIdx, _ := strconv.Atoi(m[1])
			for j := 0; j < noIdx-1; j++ {
				d.Tmux.Run("send-keys", "-t", pane, "Down")
				time.Sleep(50 * time.Millisecond)
			}
			d.Tmux.Run("send-keys", "-t", pane, "Enter")
		}
	default:
		writeErr(w, http.StatusConflict, "no recognized tool-approval modal is currently displayed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── POST /{id}/plan-approve ────────────────────────────────────────────────

type planApproveBody struct {
	// Explicit selection (preferred): the frontend renders the real menu options
	// parsed from the live screen (status.tui_plan_data) and sends back the exact
	// option the user picked. Label is matched against the re-read screen; Index
	// is the 0-based fallback when Label is empty.
	Label string `json:"label"`
	Index *int   `json:"index"`
	// Legacy intent (fallback when no explicit option is sent): "approve" keeps
	// the most-permissive auto mode; "reject" tells Claude to change.
	Decision string `json:"decision"`
	// Feedback is the text typed into the "Tell Claude what to change" freeform
	// field before submitting. Ignored for any other option. Empty → submit blank
	// (declines without guidance, the legacy behavior).
	Feedback string `json:"feedback"`
}

var (
	// Approve-intent matchers, in priority order. "bypass permissions" keeps
	// --dangerously-skip-permissions; "auto-accept edits" is its non-bypass-mode
	// equivalent; a bare leading "Yes" is the most-permissive fallback.
	rePlanBypass     = regexp.MustCompile(`(?i)bypass permissions`)
	rePlanAutoAccept = regexp.MustCompile(`(?i)auto-?accept edits`)
	rePlanYes        = regexp.MustCompile(`(?i)^yes\b`)
	// Reject-intent matchers, in priority order. "tell claude" opens a freeform
	// text field (needs an empty follow-up Enter); the others just decline.
	rePlanTellClaude   = regexp.MustCompile(`(?i)tell claude`)
	rePlanKeepPlanning = regexp.MustCompile(`(?i)keep planning`)
	rePlanNo           = regexp.MustCompile(`(?i)^no\b`)
)

// planSelection is the outcome of resolving a request against the on-screen menu.
type planSelection struct {
	downDelta     int    // rows to move from the highlighted row to the target (signed)
	label         string // the matched option's label
	needsFollowup bool   // target opens a text field → send an extra empty Enter
}

// firstPlanMatch returns the index of the first option whose label matches re, or -1.
func firstPlanMatch(opts []claudestat.PlanMenuOption, re *regexp.Regexp) int {
	for _, o := range opts {
		if re.MatchString(o.Label) {
			return o.Index
		}
	}
	return -1
}

// resolvePlanTarget picks the target option index from a parsed menu. An explicit
// label (exact, then substring) or index wins; otherwise the legacy approve/reject
// intent is matched against the option labels. Returns -1 when nothing matches.
func resolvePlanTarget(opts []claudestat.PlanMenuOption, label string, index *int, decision string) int {
	if label != "" {
		for _, o := range opts { // exact first
			if o.Label == label {
				return o.Index
			}
		}
		for _, o := range opts { // then substring (tolerate trailing hints)
			if strings.Contains(o.Label, label) || strings.Contains(label, o.Label) {
				return o.Index
			}
		}
		return -1
	}
	if index != nil {
		if *index >= 0 && *index < len(opts) {
			return *index
		}
		return -1
	}
	switch decision {
	case "approve":
		for _, re := range []*regexp.Regexp{rePlanBypass, rePlanAutoAccept, rePlanYes} {
			if t := firstPlanMatch(opts, re); t >= 0 {
				return t
			}
		}
	case "reject":
		if t := firstPlanMatch(opts, rePlanTellClaude); t >= 0 {
			return t
		}
		if t := firstPlanMatch(opts, rePlanKeepPlanning); t >= 0 {
			return t
		}
		return firstPlanMatch(opts, rePlanNo)
	}
	return -1
}

// selectPlanOption resolves an approve/reject decision against the on-screen menu,
// returning how far to move from the highlighted row and which option was matched.
// Pure (no tmux/IO) so it is unit-testable. ok=false means the screen is not a
// recognized plan menu, or no option matched the decision.
func selectPlanOption(screen, decision string) (planSelection, bool) {
	return planSelectionFor(screen, "", nil, decision)
}

// planSelectionFor resolves any plan request (explicit label/index, or legacy
// decision intent) against the on-screen menu into a navigation plan.
func planSelectionFor(screen, label string, index *int, decision string) (planSelection, bool) {
	opts, highlightedIdx, ok := claudestat.ParsePlanMenu(screen)
	if !ok {
		return planSelection{}, false
	}
	target := resolvePlanTarget(opts, label, index, decision)
	if target < 0 {
		return planSelection{}, false
	}
	return planSelection{
		downDelta: target - highlightedIdx,
		label:     opts[target].Label,
		// "Tell Claude what to change" opens a freeform input → submit empty.
		needsFollowup: rePlanTellClaude.MatchString(opts[target].Label),
	}, true
}

// planApprove resolves a pending ExitPlanMode modal by reading the on-screen menu
// and navigating to the exact option the user picked (by label/index), or — when
// no explicit option is sent — by legacy approve/reject intent. Navigation is by
// delta from the live highlight, never a fixed keystroke count, mirroring
// toolApprove. If no plan menu is on screen, or nothing matches, we refuse (409)
// instead of pressing a key that could land on the wrong option.
func planApprove(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body planApproveBody
	if !readJSON(w, r, &body) {
		return
	}
	if body.Label == "" && body.Index == nil &&
		body.Decision != "approve" && body.Decision != "reject" {
		writeErr(w, http.StatusBadRequest, "provide a 'label'/'index' option, or decision 'approve'|'reject'")
		return
	}

	pane := s.TmuxSessionName + ":0.0"
	screen := d.Tmux.CaptureVisibleScreen(s.TmuxSessionName)
	sel, ok := planSelectionFor(screen, body.Label, body.Index, body.Decision)
	if !ok {
		writeErr(w, http.StatusConflict, "no recognized ExitPlanMode menu is currently displayed (or no matching option)")
		return
	}

	// Navigate from the highlighted row to the target row, one row per press.
	switch {
	case sel.downDelta > 0:
		for j := 0; j < sel.downDelta; j++ {
			d.Tmux.Run("send-keys", "-t", pane, "Down")
			time.Sleep(100 * time.Millisecond)
		}
	case sel.downDelta < 0:
		for j := 0; j < -sel.downDelta; j++ {
			d.Tmux.Run("send-keys", "-t", pane, "Up")
			time.Sleep(100 * time.Millisecond)
		}
	}
	d.Tmux.Run("send-keys", "-t", pane, "Enter") // select option (opens text field when needsFollowup)
	if sel.needsFollowup {
		// "Tell Claude what to change" opens a freeform input. Type the user's
		// feedback into it (mirroring the AUQ type_something path), then submit.
		// Empty feedback just submits blank — declines without guidance.
		time.Sleep(300 * time.Millisecond)
		if fb := strings.TrimSpace(body.Feedback); fb != "" {
			d.Tmux.Run("send-keys", "-t", pane, "-l", fb)
			time.Sleep(200 * time.Millisecond)
		}
		d.Tmux.Run("send-keys", "-t", pane, "Enter")
	}

	slog.Info("[plan] resolved", "decision", body.Decision, "chosen", sel.label, "hasFeedback", strings.TrimSpace(body.Feedback) != "", "downDelta", sel.downDelta)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "chosen": sel.label})
}

// ── POST /{id}/rewind ──────────────────────────────────────────────────────

type rewindBody struct {
	MessageUUID string `json:"message_uuid"`
}

// rewindSession rewinds the conversation to a specific user message, restoring
// file snapshots from Claude's file-history, truncating the JSONL, and
// restarting the tmux session with --resume so Claude reads the truncated log.
func rewindSession(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body rewindBody
	if !readJSON(w, r, &body) {
		return
	}
	if s.AgentSessionID == nil || *s.AgentSessionID == "" {
		writeErr(w, http.StatusBadRequest, "no claude session attached")
		return
	}
	agentSID := *s.AgentSessionID

	jsonlPath := jsonl.FindSessionJSONL(agentSID, s.Cwd)
	if jsonlPath == "" {
		writeErr(w, http.StatusNotFound, "session JSONL not found")
		return
	}

	data, err := os.ReadFile(jsonlPath)
	if err != nil {
		writeErr(w, http.StatusNotFound, "session JSONL not found")
		return
	}
	// splitlines(): drop a single trailing newline's empty element.
	content := strings.TrimRight(string(data), "\n")
	var lines []string
	if content != "" {
		lines = strings.Split(content, "\n")
	}
	target := body.MessageUUID

	// Find the keep boundary: the file-history-snapshot whose messageId matches
	// the target user message (it records file state at that turn, comes right
	// after the user message line). Keep up to and including it; if no snapshot
	// exists, keep up to and including the user message itself.
	keepUntil := -1
	var snapshotBackups map[string]any

	for idx, raw := range lines {
		var dd map[string]any
		if json.Unmarshal([]byte(raw), &dd) != nil {
			continue
		}
		if asString(dd["uuid"]) == target {
			keepUntil = idx
		}
		if asString(dd["type"]) == "file-history-snapshot" && asString(dd["messageId"]) == target {
			if snap, ok := dd["snapshot"].(map[string]any); ok {
				if tfb, ok := snap["trackedFileBackups"].(map[string]any); ok {
					snapshotBackups = tfb
				}
			}
			keepUntil = idx // snapshot line comes after user message; update boundary
		}
	}

	if keepUntil < 0 {
		writeErr(w, http.StatusNotFound, "message UUID not found in JSONL")
		return
	}

	// Restore files from snapshot.
	home, _ := os.UserHomeDir()
	fileHistoryDir := filepath.Join(home, ".claude", "file-history", agentSID)
	restored := []string{}
	for relPath, infoRaw := range snapshotBackups {
		info, ok := infoRaw.(map[string]any)
		if !ok {
			continue
		}
		backupName := asString(info["backupFileName"])
		if backupName == "" {
			continue
		}
		src := filepath.Join(fileHistoryDir, backupName)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		dst := filepath.Join(s.Cwd, relPath)
		_ = os.MkdirAll(filepath.Dir(dst), 0o755)
		if err := copyFile(src, dst); err != nil {
			continue
		}
		restored = append(restored, relPath)
	}

	// Truncate JSONL.
	truncated := lines[:keepUntil+1]
	if err := os.WriteFile(jsonlPath, []byte(strings.Join(truncated, "\n")+"\n"), 0o644); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Kill running session.
	if s.Status == model.StatusRunning {
		_ = d.Tmux.Terminate(s.TmuxSessionName)
		_, _ = d.Store.Transition(s.ID, model.StatusTerminated)
	}

	// Restart with same agent_session_id so Claude reads the truncated JSONL.
	ts := time.Now().Unix()
	tmuxName := "claude-" + s.OwnerID + "-" + s.Project + "-" + strconv.FormatInt(ts, 10)
	_ = os.MkdirAll(s.Cwd, 0o755)
	model_ := ""
	if s.Model != nil {
		model_ = *s.Model
	}
	if err := d.Tmux.CreateSession(tmuxName, s.Cwd, s.Env, model_, agentSID, "", s.Tool); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	_ = d.Store.UpdateTmuxSessionName(s.ID, tmuxName)
	_, _ = d.Store.Transition(s.ID, model.StatusRunning)
	_ = d.Store.ResetAttachedClients(s.ID)
	// audit_event(user_id, "rewind", session_id) — no Go audit helper yet; omitted.

	// Resolve new inner claude_session_id asynchronously (--resume gives a new ID).
	_ = d.Store.ClearAgentSessionID(s.ID)
	go func(sid, name, scwd string) {
		asid, pid, ok := d.Tmux.ResolveAgentSessionID(name, scwd, 20*time.Second)
		if !ok {
			return
		}
		if pid > 0 {
			p := pid
			_ = d.Store.UpdateClaudeProcPID(sid, &p)
		}
		if asid != "" {
			_ = d.Store.UpdateAgentSessionID(sid, asid)
		}
	}(s.ID, tmuxName, s.Cwd)

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"restored_files": restored,
		"kept_lines":     len(truncated),
	})
}

// ── helpers ────────────────────────────────────────────────────────────────

// auqOptionLabels extracts string labels from a question's "options" list,
// mirroring `opt["label"] if isinstance(opt, dict) else str(opt)`.
func auqOptionLabels(qDef map[string]any) []string {
	if qDef == nil {
		return nil
	}
	raw, ok := qDef["options"].([]any)
	if !ok {
		return nil
	}
	labels := make([]string, 0, len(raw))
	for _, opt := range raw {
		if m, ok := opt.(map[string]any); ok {
			labels = append(labels, asString(m["label"]))
		} else {
			labels = append(labels, asString(opt))
		}
	}
	return labels
}

func containsString(xs []string, s string) bool { return indexOfString(xs, s) >= 0 }

func indexOfString(xs []string, s string) int {
	for i, x := range xs {
		if x == s {
			return i
		}
	}
	return -1
}

func asBool(v any) bool {
	b, _ := v.(bool)
	return b
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func copyFile(src, dst string) error {
	in, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, in, 0o644)
}
