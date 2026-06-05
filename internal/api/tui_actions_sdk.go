package api

// SDK-transport implementations of the interactive answering endpoints. Where
// tui_actions.go drives Claude Code's Ink TUI with raw tmux keystrokes, these
// resolve the wrapper's pending interaction over the json-in FIFO: the web
// submission is mapped to the SDK callback's typed answer (QuestionAnswer[] for
// AskUserQuestion, PlanDecision for ExitPlanMode) and sent as a
// {type:"respond"} line; the pump clears the pending state when the wrapper
// echoes interaction_resolved.

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/loki/goclaudemanager/internal/claudestat"
	"github.com/loki/goclaudemanager/internal/model"
	"github.com/loki/goclaudemanager/internal/sdktransport"
)

// sdkPendingAUQ returns the pump's pending AskUserQuestion, or writes a 409.
func sdkPendingAUQ(d Deps, w http.ResponseWriter, sessionID string) *sdktransport.Pending {
	st, ok := d.SDK.State(sessionID)
	if !ok || st.PendingAUQ == nil {
		writeErr(w, http.StatusConflict, "no pending question for this session")
		return nil
	}
	return st.PendingAUQ
}

// sdkPendingQuestionDefs extracts the question definitions from a pending
// AUQ's tui_auq_data ({"questions": [...]}; see sdktransport.buildAUQData).
func sdkPendingQuestionDefs(data map[string]any) []map[string]any {
	switch v := data["questions"].(type) {
	case []map[string]any:
		return v
	case []any:
		out := make([]map[string]any, 0, len(v))
		for _, q := range v {
			if m, ok := q.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}

// sdkQuestionAnswer builds one wrapper QuestionAnswer ({header, selected}).
// selected is a string for single-select/custom answers and a []string for
// multi-select, matching the wrapper's ask-broker payload type.
func sdkQuestionAnswer(qDef map[string]any, selected any) map[string]any {
	return map[string]any{"header": asString(qDef["header"]), "selected": selected}
}

// sdkAnswerAUQ maps the structured answer-auq body (option indexes against the
// pending question's option list) to QuestionAnswer[] and resolves the broker.
func sdkAnswerAUQ(d Deps, w http.ResponseWriter, s *model.Session, body auqAnswerRequest) {
	pending := sdkPendingAUQ(d, w, s.ID)
	if pending == nil {
		return
	}
	qDefs := sdkPendingQuestionDefs(pending.Data)

	answers := make([]map[string]any, 0, len(body.Answers))
	for i, a := range body.Answers {
		var qDef map[string]any
		if i < len(qDefs) {
			qDef = qDefs[i]
		}
		labels := auqOptionLabels(qDef)
		switch {
		case a.CustomText != nil:
			text := strings.TrimSpace(*a.CustomText)
			if a.IsMulti {
				answers = append(answers, sdkQuestionAnswer(qDef, []string{text}))
			} else {
				answers = append(answers, sdkQuestionAnswer(qDef, text))
			}
		case len(a.OptionIndices) > 0:
			sel := make([]string, 0, len(a.OptionIndices))
			for _, idx := range a.OptionIndices {
				if idx >= 0 && idx < len(labels) {
					sel = append(sel, labels[idx])
				}
			}
			answers = append(answers, sdkQuestionAnswer(qDef, sel))
		default:
			idx := 0
			if a.OptionIdx != nil {
				idx = *a.OptionIdx
			}
			if idx < 0 || idx >= len(labels) {
				writeErr(w, http.StatusUnprocessableEntity, "option index out of range for pending question")
				return
			}
			answers = append(answers, sdkQuestionAnswer(qDef, labels[idx]))
		}
	}

	if err := d.SDK.Respond(s.ID, pending.ToolUseID, answers); err != nil {
		writeErr(w, http.StatusInternalServerError, "respond failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "via": "sdk"})
}

// sdkAuqSubmit maps the auq/submit body (per-question string answers or
// multi-select TUI action lists) to QuestionAnswer[] and resolves the broker.
// The questions come from the request body — the frontend echoes the same
// definitions it rendered from tui_auq_data.
func sdkAuqSubmit(d Deps, w http.ResponseWriter, s *model.Session, body auqSubmitBody) {
	pending := sdkPendingAUQ(d, w, s.ID)
	if pending == nil {
		return
	}
	questions := body.Questions
	if len(questions) == 0 {
		questions = sdkPendingQuestionDefs(pending.Data)
	}

	answers := make([]map[string]any, 0, len(body.Answers))
	for i, raw := range body.Answers {
		var qDef map[string]any
		if i < len(questions) {
			qDef = questions[i]
		}
		labels := auqOptionLabels(qDef)

		var actions []map[string]any
		if json.Unmarshal(raw, &actions) == nil {
			// Multi-select action list, one entry per TUI row in order: rows
			// 0..n-1 are the options ("click" = selected), row n is the "Type
			// something" freeform field, row n+1 is Submit (a TUI-only gesture).
			sel := make([]string, 0, len(actions))
			for ai, action := range actions {
				switch action["type"] {
				case "option":
					if asBool(action["click"]) && ai < len(labels) {
						sel = append(sel, labels[ai])
					}
				case "type_something":
					if v := strings.TrimSpace(asString(action["value"])); v != "" {
						sel = append(sel, v)
					}
				}
			}
			answers = append(answers, sdkQuestionAnswer(qDef, sel))
			continue
		}

		// String answer: an option label (single-select) or custom text —
		// the wrapper passes either through as-is.
		var strAnswer string
		_ = json.Unmarshal(raw, &strAnswer)
		strAnswer = strings.TrimSpace(strAnswer)
		if asBool(qDef["multiSelect"]) {
			answers = append(answers, sdkQuestionAnswer(qDef, []string{strAnswer}))
		} else {
			answers = append(answers, sdkQuestionAnswer(qDef, strAnswer))
		}
	}

	if err := d.SDK.Respond(s.ID, pending.ToolUseID, answers); err != nil {
		writeErr(w, http.StatusInternalServerError, "respond failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "via": "sdk"})
}

// sdkPlanApprove resolves a plan-approve request against the synthetic option
// list the pump surfaced in tui_plan_data and answers the wrapper's plan-review
// broker with a PlanDecision.
func sdkPlanApprove(d Deps, w http.ResponseWriter, s *model.Session, body planApproveBody) {
	st, ok := d.SDK.State(s.ID)
	if !ok || st.PendingPlan == nil {
		writeErr(w, http.StatusConflict, "no pending plan review for this session")
		return
	}

	// Reuse the tmux path's resolution (explicit label/index, else legacy
	// approve/reject intent) over the synthetic menu.
	opts := make([]claudestat.PlanMenuOption, len(sdktransport.PlanOptionLabels))
	for i, label := range sdktransport.PlanOptionLabels {
		opts[i] = claudestat.PlanMenuOption{Index: i, Label: label, Highlighted: i == 0}
	}
	target := resolvePlanTarget(opts, body.Label, body.Index, body.Decision)
	if target < 0 {
		writeErr(w, http.StatusConflict, "no matching plan option")
		return
	}

	// Map the chosen option to the wrapper's PlanDecision.
	var payload map[string]any
	switch target {
	case 0: // Yes, and auto-accept edits
		payload = map[string]any{"approve": true, "permissionMode": "acceptEdits"}
	case 1: // Yes, and manually approve edits — also leave plan mode, like the
		// real TUI menu does (otherwise the next turn would re-plan).
		payload = map[string]any{"approve": true, "permissionMode": "default"}
	case 2: // No, keep planning
		payload = map[string]any{"approve": false}
	default: // Tell Claude what to change
		payload = map[string]any{"approve": false}
		if fb := strings.TrimSpace(body.Feedback); fb != "" {
			payload["reason"] = fb
		}
	}

	if err := d.SDK.Respond(s.ID, st.PendingPlan.ToolUseID, payload); err != nil {
		writeErr(w, http.StatusInternalServerError, "respond failed: "+err.Error())
		return
	}
	chosen := opts[target].Label
	slog.Info("[plan] resolved via sdk", "decision", body.Decision, "chosen", chosen,
		"hasFeedback", strings.TrimSpace(body.Feedback) != "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "chosen": chosen, "via": "sdk"})
}
