package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/jsonl"
	"github.com/loki/goclaudemanager/internal/model"
)

// streamingThresholdSecs mirrors sessions._STREAMING_THRESHOLD_SECS.
const streamingThresholdSecs = 8

// sessionsRouter mirrors the read endpoints of app/api/sessions.py
// (mounted at /api/sessions). Write/lifecycle endpoints land in Phase 2.
func sessionsRouter(d Deps) http.Handler {
	r := chi.NewRouter()

	// Served outside the RequireUser group: <img> tags cannot send an
	// Authorization header, so the handler authenticates the query `token`
	// param itself (VerifyToken + session-ownership check inside).
	r.Get("/{id}/uploaded-image/{filename}", func(w http.ResponseWriter, req *http.Request) { fsServeUploadedImage(d, w, req) })
	// Likewise for inline audio/video playback: <video>/<audio> tags can't send
	// an Authorization header, so fsServeMedia authenticates the query token.
	r.Get("/{id}/fs/media", func(w http.ResponseWriter, req *http.Request) { fsServeMedia(d, w, req) })

	r.Group(func(r chi.Router) {
		r.Use(d.Auth.RequireUser)

		r.Get("/", func(w http.ResponseWriter, r *http.Request) { listSessions(d, w, r) })
		r.With(d.Auth.RequireAdmin).Get("/all", func(w http.ResponseWriter, r *http.Request) { listAllSessions(d, w, r) })
		r.With(d.Auth.RequireAdmin).Patch("/{id}/identity", func(w http.ResponseWriter, r *http.Request) { adminUpdateIdentity(d, w, r) })
		r.Get("/status", func(w http.ResponseWriter, r *http.Request) { listSessionsStatus(d, w, r) })

		r.Get("/{id}", func(w http.ResponseWriter, r *http.Request) { getSession(d, w, r) })
		r.Get("/{id}/prompt-history", func(w http.ResponseWriter, r *http.Request) { getPromptHistory(d, w, r) })
		r.Delete("/{id}/prompt-history/{entryID}", func(w http.ResponseWriter, r *http.Request) { deletePromptHistoryEntry(d, w, r) })
		r.Get("/{id}/goals", func(w http.ResponseWriter, r *http.Request) { listGoals(d, w, r) })
		r.Get("/{id}/todos", func(w http.ResponseWriter, r *http.Request) { listTodos(d, w, r) })
		r.Get("/{id}/status-bar", func(w http.ResponseWriter, r *http.Request) { statusBar(d, w, r) })
		r.Get("/{id}/processes", func(w http.ResponseWriter, r *http.Request) { listProcesses(d, w, r) })
		r.Get("/{id}/auqs", func(w http.ResponseWriter, r *http.Request) { listAUQs(d, w, r) })
		r.Get("/{id}/tasks", func(w http.ResponseWriter, r *http.Request) { listTasks(d, w, r) })
		r.Get("/{id}/conversation", func(w http.ResponseWriter, r *http.Request) { getConversation(d, w, r) })

		// Session-scoped code, git, and filesystem routes (ported in parallel).
		registerCodeRoutes(r, d)
		registerGitRoutes(r, d)
		registerFilesRoutes(r, d)
		// Lifecycle write routes (create/attach/detach/terminate/resume/...).
		registerSessionWriteRoutes(r, d)
		// Conversation shares + bash terminals.
		registerShareRoutes(r, d)
		registerLostMessageRoutes(r, d)
		registerTerminalRoutes(r, d, d.Term)
		// Interactive TUI actions, per-project memory, extra read endpoints, and
		// external session browsing (ported in parallel).
		registerTUIActionRoutes(r, d)
		registerMemoryRoutes(r, d)
		registerReadExtraRoutes(r, d)
		registerExternalRoutes(r, d)
	})

	return r
}

// resolveOwned returns the session if it exists and is owned by the caller,
// else writes a 404 and returns nil.
func resolveOwned(d Deps, w http.ResponseWriter, r *http.Request) *model.Session {
	id := chi.URLParam(r, "id")
	s, err := d.Store.GetSession(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return nil
	}
	who := auth.FromContext(r.Context())
	if s == nil || who == nil || s.OwnerID != who.Username {
		writeErr(w, http.StatusNotFound, "session not found")
		return nil
	}
	return s
}

// adminUpdateIdentity (admin-only) overrides a session's transcript-resolution
// keys: resume_session_id and/or agent_session_id. Only fields present in the
// body are written; an empty string clears the field (NULL). These ids drive
// chat-history resolution (resolveChatSID), so this is a manual override for
// when the stored id has gone stale. No uniqueness is enforced (mirrors the
// rest of the codebase), but every change is logged by the store.
func adminUpdateIdentity(d Deps, w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s, err := d.Store.GetSession(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	if s == nil {
		writeErr(w, http.StatusNotFound, "session not found")
		return
	}
	var body struct {
		ResumeSessionID *string `json:"resume_session_id"`
		AgentSessionID  *string `json:"agent_session_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	// Trim; an empty (or whitespace-only) value means "clear to NULL".
	norm := func(p *string) *string {
		if p == nil {
			return nil
		}
		if v := strings.TrimSpace(*p); v != "" {
			return &v
		}
		return nil
	}
	if body.ResumeSessionID != nil {
		if err := d.Store.SetResumeSessionID(id, norm(body.ResumeSessionID)); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if body.AgentSessionID != nil {
		if err := d.Store.SetAgentSessionID(id, norm(body.AgentSessionID)); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	updated, err := d.Store.GetSession(id)
	if err != nil || updated == nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func listSessions(d Deps, w http.ResponseWriter, r *http.Request) {
	who := auth.FromContext(r.Context())
	items, err := d.Store.ListForOwner(who.Username)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	items, convOnly := filterSessions(d, items, r.URL.Query().Get("q"))
	ids := sessionIDs(items)
	newOut, _ := d.Store.GetHasNewOutputBulk(ids, who.Username)
	taskMap, _ := d.Store.ListPendingTasksForSessions(ids)
	views := make([]model.SessionView, 0, len(items))
	for _, s := range items {
		v := d.enrich(s, newOut[s.ID], taskViews(taskMap[s.ID]))
		v.ConversationMatch = convOnly[s.ID]
		views = append(views, v)
	}
	writeJSON(w, http.StatusOK, model.SessionListResponse{Items: views, Total: len(views)})
}

func listAllSessions(d Deps, w http.ResponseWriter, r *http.Request) {
	items, err := d.Store.All()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	items, convOnly := filterSessions(d, items, r.URL.Query().Get("q"))
	views := make([]model.SessionView, 0, len(items))
	for _, s := range items {
		v := d.enrich(s, false, nil)
		v.ConversationMatch = convOnly[s.ID]
		views = append(views, v)
	}
	writeJSON(w, http.StatusOK, model.SessionListResponse{Items: views, Total: len(views)})
}

func listSessionsStatus(d Deps, w http.ResponseWriter, r *http.Request) {
	who := auth.FromContext(r.Context())
	items, err := d.Store.ListForOwner(who.Username)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	if r.URL.Query().Get("scope") == "active" {
		var active []*model.Session
		for _, s := range items {
			if s.Status == model.StatusRunning || s.Status == model.StatusDetached {
				active = append(active, s)
			}
		}
		items = active
	}
	ids := sessionIDs(items)
	newOut, _ := d.Store.GetHasNewOutputBulk(ids, who.Username)
	taskMap, _ := d.Store.ListPendingTasksForSessions(ids)
	views := make([]model.SessionStatusView, 0, len(items))
	for _, s := range items {
		comp, ok := d.Snapshot.Get(s.ID)
		if !ok {
			comp = d.Snapshot.Compute(s)
		}
		views = append(views, model.SessionStatusView{
			ID:                 s.ID,
			Status:             s.Status,
			AttachedClients:    s.AttachedClients,
			HasNewOutput:       newOut[s.ID],
			IsStreaming:        false, // streaming detected via WS, not REST
			ScheduledTasks:     taskViews(taskMap[s.ID]),
			IsCompacting:       comp.IsCompacting,
			CompactingProgress: comp.CompactingProgress,
			TuiHint:            comp.TuiHint,
			TuiAuqData:         comp.TuiAuqData,
			TuiApproveData:     comp.TuiApproveData,
			TuiPlanPending:     comp.TuiPlanPending,
			TuiPlanData:        comp.TuiPlanData,
			LostMessages:       d.Store.ListLostMessages(s.ID),
		})
	}
	writeJSON(w, http.StatusOK, model.SessionStatusListResponse{Items: views, Total: len(views)})
}

func getSession(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	writeJSON(w, http.StatusOK, d.enrich(s, false, nil))
}

func getPromptHistory(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	limit := queryInt(r, "limit", 20)
	offset := queryInt(r, "offset", 0)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	entries, _ := d.Store.ListPromptHistory(s.ID, limit, offset, q)
	total, _ := d.Store.CountPromptHistory(s.ID, q)
	writeJSON(w, http.StatusOK, map[string]any{"entries": nonNilEntries(entries), "total": total})
}

func deletePromptHistoryEntry(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	entryID, _ := strconv.ParseInt(chi.URLParam(r, "entryID"), 10, 64)
	_, _ = d.Store.DeletePromptHistoryEntry(s.ID, entryID)
	w.WriteHeader(http.StatusNoContent)
}

func listGoals(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	chatSID := resolveChatSID(d, s)
	if chatSID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"active": nil, "history": []any{}})
		return
	}
	res, _ := jsonl.ReadGoals(chatSID, s.Cwd)
	writeJSON(w, http.StatusOK, res)
}

func listTodos(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	chatSID := resolveChatSID(d, s)
	if chatSID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"active": []any{}, "history": []any{}})
		return
	}
	res, _ := jsonl.GetTodoPlans(chatSID, s.Cwd)
	writeJSON(w, http.StatusOK, res)
}

func statusBar(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	chatSID := resolveChatSID(d, s)
	if chatSID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"todos_active": []any{}, "goal_active": nil})
		return
	}
	plans, _ := jsonl.GetTodoPlans(chatSID, s.Cwd)
	goals, _ := jsonl.ReadGoals(chatSID, s.Cwd)
	writeJSON(w, http.StatusOK, map[string]any{"todos_active": plans.Active, "goal_active": goals.Active})
}

func listAUQs(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	chatSID := resolveChatSID(d, s)
	if chatSID == "" {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	auqs, _ := jsonl.ListAUQs(chatSID, s.Cwd)
	if auqs == nil {
		auqs = []jsonl.AUQ{}
	}
	writeJSON(w, http.StatusOK, auqs)
}

func listTasks(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	tasks, _ := d.Store.ListTasksForSession(s.ID)
	writeJSON(w, http.StatusOK, taskViews(tasks))
}

func getConversation(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	fromTs := queryFloat(r, "from_ts", 0)
	chatSID := resolveChatSID(d, s)
	if chatSID == "" {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	var turns []jsonl.ConversationTurn
	if s.Tool == "cursor" {
		turns, _ = jsonl.GetCursorConversation(chatSID, s.Cwd, fromTs)
	} else {
		turns, _ = jsonl.GetConversation(chatSID, s.Cwd, fromTs)
	}
	if turns == nil {
		turns = []jsonl.ConversationTurn{}
	}
	// tail=N (with from_ts=0): keep last N confirmed + any streaming.
	if tail := queryInt(r, "tail", 0); tail > 0 && fromTs == 0 {
		var confirmed, rest []jsonl.ConversationTurn
		for _, t := range turns {
			if t.Streaming {
				rest = append(rest, t)
			} else {
				confirmed = append(confirmed, t)
			}
		}
		if len(confirmed) > tail {
			confirmed = confirmed[len(confirmed)-tail:]
		}
		turns = append(confirmed, rest...)
	}
	writeJSON(w, http.StatusOK, turns)
}

// ---- enrich + helpers -----------------------------------------------------

func (d Deps) enrich(s *model.Session, hasNew bool, tasks []model.TaskView) model.SessionView {
	v := model.SessionView{Session: *s, Prompts: []string{}, ScheduledTasks: tasks, HasNewOutput: hasNew}
	if tasks == nil {
		v.ScheduledTasks = []model.TaskView{}
	}
	if s.AgentSessionID != nil && *s.AgentSessionID != "" {
		switch s.Tool {
		case "cursor":
			if res, err := jsonl.EnrichCursorSession(*s.AgentSessionID, s.Cwd); err == nil {
				v.ClaudeTitle = res.Title
				if res.Prompts != nil {
					v.Prompts = res.Prompts
				}
			}
		default:
			if path := jsonl.FindSessionJSONL(*s.AgentSessionID, s.Cwd); path != "" {
				res := d.JSONL.Enrich(path)
				v.ClaudeTitle = res.Title
				if res.Prompts != nil {
					v.Prompts = res.Prompts
				}
				v.LastUserInputAt = res.LastUserInputAt
			}
		}
	}
	v.IsStreaming = computeStreaming(s)
	return v
}

// computeStreaming mirrors the is_streaming logic in _enrich.
func computeStreaming(s *model.Session) bool {
	if s.Status == model.StatusTerminated || s.Status == model.StatusArchived || s.LastActivityAt == nil {
		return false
	}
	elapsed := time.Since(s.LastActivityAt.Time).Seconds()
	if elapsed >= streamingThresholdSecs {
		return false
	}
	if s.LastTurnAt == nil {
		return true
	}
	return s.LastActivityAt.Time.After(s.LastTurnAt.Time)
}

func taskViews(tasks []*model.ScheduledTask) []model.TaskView {
	out := make([]model.TaskView, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, model.TaskView{
			ID:          t.ID,
			Command:     t.Command,
			RunAt:       t.RunAt.String(),
			Status:      t.Status,
			CreatedAt:   t.CreatedAt.String(),
			LoopSeconds: t.LoopSeconds,
		})
	}
	return out
}

func sessionIDs(items []*model.Session) []string {
	ids := make([]string, len(items))
	for i, s := range items {
		ids[i] = s.ID
	}
	return ids
}

// filterSessions mirrors _filter_sessions (metadata + conversation text search).
// filterSessions keeps the sessions matching the search query q. q is split
// into whitespace-separated terms; every term must match (case-insensitive
// substring) either a session field — project, tmux name, id, cwd, agent
// session id, model, or the Claude/Cursor title shown on the card — or, for
// claude/codex sessions, the conversation text. convOnly reports the ids that
// matched only through the conversation (some term was found nowhere else),
// so the UI can flag them. Status and owner are deliberately not searched:
// "run" or the username would match nearly every session.
func filterSessions(d Deps, items []*model.Session, q string) (out []*model.Session, convOnly map[string]bool) {
	terms := strings.Fields(strings.ToLower(q))
	if len(terms) == 0 {
		return items, nil
	}
	convOnly = map[string]bool{}
	for _, s := range items {
		model_, agent := "", ""
		if s.Model != nil {
			model_ = *s.Model
		}
		if s.AgentSessionID != nil {
			agent = *s.AgentSessionID
		}
		meta := strings.ToLower(strings.Join([]string{s.Project, s.Name, s.ID, s.Cwd, agent, model_}, "\n"))

		// Title and conversation text need the (cached) transcript; load it
		// only when some term is not already in the plain fields.
		var title string
		var texts []string
		loaded := false
		load := func() {
			if loaded || agent == "" {
				return
			}
			loaded = true
			if s.Tool == "cursor" {
				if res, err := jsonl.EnrichCursorSession(agent, s.Cwd); err == nil && res.Title != nil {
					title = strings.ToLower(*res.Title)
				}
				return
			}
			if path := jsonl.FindSessionJSONL(agent, s.Cwd); path != "" {
				res := d.JSONL.Enrich(path)
				if res.Title != nil {
					title = strings.ToLower(*res.Title)
				}
				texts = res.SearchText
			}
		}

		ok, viaConv := true, false
		for _, t := range terms {
			if strings.Contains(meta, t) {
				continue
			}
			load()
			if strings.Contains(title, t) {
				continue
			}
			found := false
			for _, x := range texts {
				if strings.Contains(strings.ToLower(x), t) {
					found = true
					break
				}
			}
			if !found {
				ok = false
				break
			}
			viaConv = true
		}
		if ok {
			out = append(out, s)
			if viaConv {
				convOnly[s.ID] = true
			}
		}
	}
	return out, convOnly
}

func queryInt(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func queryFloat(r *http.Request, key string, def float64) float64 {
	if v := r.URL.Query().Get(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

// nonNilEntries guarantees a JSON array (not null) for prompt-history entries.
func nonNilEntries[T any](v []T) []T {
	if v == nil {
		return []T{}
	}
	return v
}
