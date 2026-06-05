package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/model"
)

func uuidV4() string { return uuid.NewString() }

// registerSessionWriteRoutes registers create + lifecycle endpoints on the
// sessions router. Mirrors the write handlers of app/api/sessions.py.
func registerSessionWriteRoutes(r chi.Router, d Deps) {
	r.Post("/", func(w http.ResponseWriter, r *http.Request) { createSession(d, w, r) })
	r.Post("/{id}/attach", func(w http.ResponseWriter, r *http.Request) { attachSession(d, w, r) })
	r.Post("/{id}/detach", func(w http.ResponseWriter, r *http.Request) { detachSession(d, w, r) })
	r.Post("/{id}/terminate", func(w http.ResponseWriter, r *http.Request) { terminateSession(d, w, r) })
	r.Post("/{id}/resume", func(w http.ResponseWriter, r *http.Request) { resumeSession(d, w, r) })
	r.Patch("/{id}/name", func(w http.ResponseWriter, r *http.Request) { renameSession(d, w, r) })
	r.Patch("/{id}/model", func(w http.ResponseWriter, r *http.Request) { setSessionModel(d, w, r) })
	r.Delete("/{id}", func(w http.ResponseWriter, r *http.Request) { deleteSession(d, w, r) })
	r.Post("/{id}/tasks", func(w http.ResponseWriter, r *http.Request) { createTask(d, w, r) })
	r.Delete("/{id}/tasks/{taskID}", func(w http.ResponseWriter, r *http.Request) { cancelTask(d, w, r) })
}

type createSessionReq struct {
	Project         string            `json:"project"`
	Cwd             *string           `json:"cwd"`
	Env             map[string]string `json:"env"`
	Model           *string           `json:"model"`
	ResumeSessionID *string           `json:"resume_session_id"`
	GitRepoURL      *string           `json:"git_repo_url"`
	Tool            string            `json:"tool"`
	CodexTransport  string            `json:"codex_transport"`
	Transport       string            `json:"transport"`
}

func createSession(d Deps, w http.ResponseWriter, r *http.Request) {
	who := auth.FromContext(r.Context())
	var body createSessionReq
	if !readJSON(w, r, &body) {
		return
	}
	if body.Tool == "" {
		body.Tool = "claude"
	}
	if body.Env == nil {
		body.Env = map[string]string{}
	}
	ts := time.Now().Unix()
	tmuxName := "claude-" + who.Username + "-" + body.Project + "-" + itoa(ts)

	cwd := ""
	if body.Cwd != nil && *body.Cwd != "" {
		cwd = *body.Cwd
	} else {
		cwd = filepath.Join(d.Cfg.DefaultWorkspace(), who.Username, body.Project)
	}
	cwdExists := isDir(cwd)

	if body.GitRepoURL != nil && *body.GitRepoURL != "" && !cwdExists {
		if res := d.Git.Clone(r.Context(), *body.GitRepoURL, cwd); !res.OK {
			writeErr(w, http.StatusBadRequest, "git clone failed: "+res.Output)
			return
		}
	} else {
		_ = os.MkdirAll(cwd, 0o755)
		if !d.Git.IsRepo(cwd) {
			_ = d.Git.Init(r.Context(), cwd)
		}
	}

	codexTransport := "tui"
	if body.Tool == "codex" && body.CodexTransport == "app_server" {
		codexTransport = "app_server"
	}

	// Codex app-server transport is Phase 3.
	if body.Tool == "codex" && codexTransport == "app_server" {
		writeErr(w, http.StatusNotImplemented, "codex app_server transport not yet supported")
		return
	}

	// SDK transport is claude-only and requires the claude-structured binary
	// to actually exist — never create a session that can't spawn.
	transport := "tmux"
	if body.Tool == "claude" && body.Transport == "sdk" {
		if !d.Cfg.SDKAvailable() {
			writeErr(w, http.StatusConflict,
				"sdk transport unavailable: claude-structured binary not found at "+d.Cfg.StructuredBinResolved())
			return
		}
		transport = "sdk"
	}

	now := model.NowUTC()
	s := &model.Session{
		ID:              uuidV4(),
		OwnerID:         who.Username,
		Name:            tmuxName,
		Project:         body.Project,
		Cwd:             cwd,
		Env:             body.Env,
		Model:           body.Model,
		Tool:            body.Tool,
		Status:          model.StatusCreating,
		CreatedAt:       now,
		UpdatedAt:       now,
		TmuxSessionName: tmuxName,
		ResumeSessionID: body.ResumeSessionID,
		CodexTransport:  codexTransport,
		Transport:       transport,
	}
	if body.GitRepoURL != nil && *body.GitRepoURL != "" && !cwdExists {
		s.GitRepoURL = body.GitRepoURL
	}
	if err := d.Store.CreateSession(s); err != nil {
		writeErr(w, http.StatusInternalServerError, "create failed")
		return
	}

	isNew := body.ResumeSessionID == nil || *body.ResumeSessionID == ""
	resume := ""
	if body.ResumeSessionID != nil {
		resume = *body.ResumeSessionID
	}
	innerID := ""
	if isNew && body.Tool == "claude" {
		innerID = s.ID
	}
	model_ := ""
	if body.Model != nil {
		model_ = *body.Model
	}
	if transport == "sdk" {
		// SDK transport: fresh channels (truncated json-out), spawn the
		// claude-structured wrapper in the tmux pane, start the event pump.
		// agent_session_id arrives via the pump's session_start event — no
		// inner-id pid file, no JSONL scanning goroutine.
		jsonIn, jsonOut, err := d.SDK.ResetChannels(s.ID)
		if err != nil {
			_, _ = d.Store.Transition(s.ID, model.StatusTerminated)
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := d.Tmux.CreateSDKSession(tmuxName, cwd, body.Env,
			d.Cfg.StructuredBinResolved(), model_, resume, jsonIn, jsonOut); err != nil {
			_, _ = d.Store.Transition(s.ID, model.StatusTerminated)
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		_, _ = d.Store.Transition(s.ID, model.StatusRunning)
		d.SDK.Start(s.ID)
		out, _ := d.Store.GetSession(s.ID)
		writeJSONStatus(w, http.StatusCreated, out)
		return
	}
	if err := d.Tmux.CreateSession(tmuxName, cwd, body.Env, model_, resume, innerID, body.Tool); err != nil {
		_, _ = d.Store.Transition(s.ID, model.StatusTerminated)
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_, _ = d.Store.Transition(s.ID, model.StatusRunning)

	if (body.Tool == "cursor" || body.Tool == "codex") && resume != "" {
		_ = d.Store.UpdateAgentSessionID(s.ID, resume)
	}

	// Background resolve of the agent session id + pid.
	if body.Tool == "claude" {
		go func(sid, name, inner, scwd string, fresh bool) {
			var asid string
			var pid int
			var ok bool
			if fresh {
				asid, pid, ok = d.Tmux.ResolveAgentSessionIDByInnerID(inner, scwd, 15*time.Second)
			} else {
				asid, pid, ok = d.Tmux.ResolveAgentSessionID(name, scwd, 15*time.Second)
			}
			if ok {
				if pid > 0 {
					p := pid
					_ = d.Store.UpdateClaudeProcPID(sid, &p)
				}
				if asid != "" {
					_ = d.Store.UpdateAgentSessionID(sid, asid)
				}
			}
		}(s.ID, tmuxName, innerID, cwd, isNew)
	}

	// Return the freshly-created session (now RUNNING).
	out, _ := d.Store.GetSession(s.ID)
	writeJSONStatus(w, http.StatusCreated, out)
}

func attachSession(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if s.Status == model.StatusTerminated {
		writeErr(w, http.StatusConflict, "session terminated")
		return
	}
	if s.Status == model.StatusDetached {
		_, _ = d.Store.Transition(s.ID, model.StatusRunning)
	}
	token, err := d.Store.IssueWsToken(s.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	_, _ = d.Store.UpdateAttachedClients(s.ID, +1)
	_ = d.Store.MarkViewed(s.ID, s.OwnerID)
	fresh, _ := d.Store.GetSession(s.ID)
	writeJSON(w, http.StatusOK, model.AttachResponse{
		SessionID: s.ID,
		WsToken:   token,
		WsURL:     d.Env.PublicPath("/ws/sessions/" + s.ID + "?token=" + token),
		Status:    fresh.Status,
	})
}

func detachSession(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	_, _ = d.Store.UpdateAttachedClients(s.ID, -1)
	updated, _ := d.Store.GetSession(s.ID)
	if updated != nil && updated.AttachedClients <= 0 && updated.Status == model.StatusRunning {
		_, _ = d.Store.Transition(s.ID, model.StatusDetached)
	}
	w.WriteHeader(http.StatusNoContent)
}

func terminateSession(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if s.Status == model.StatusTerminated {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// SDK transport: stop the event pump first (the wrapper itself dies with
	// the pane; the runtime dir is left on disk for a later resume).
	if s.Transport == "sdk" {
		d.SDK.Stop(s.ID)
	}
	// Best-effort resolve of agent session id before killing (so history is linkable).
	if s.Transport != "sdk" &&
		(s.AgentSessionID == nil || *s.AgentSessionID == "") && d.Tmux.HasSession(s.TmuxSessionName) {
		if asid, pid, ok := d.Tmux.ResolveAgentSessionID(s.TmuxSessionName, s.Cwd, 2*time.Second); ok {
			if pid > 0 {
				p := pid
				_ = d.Store.UpdateClaudeProcPID(s.ID, &p)
			}
			if asid != "" {
				_ = d.Store.UpdateAgentSessionID(s.ID, asid)
			}
		}
	}
	_ = d.Tmux.Terminate(s.TmuxSessionName)
	_ = d.Store.UpdateClaudeProcPID(s.ID, nil)
	_, _ = d.Store.Transition(s.ID, model.StatusTerminated)
	w.WriteHeader(http.StatusNoContent)
}

func resumeSession(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if s.Status != model.StatusTerminated {
		writeErr(w, http.StatusConflict, "only terminated sessions can be resumed")
		return
	}
	if s.Tool == "codex" && s.CodexTransport == "app_server" {
		writeErr(w, http.StatusNotImplemented, "codex app_server resume not yet supported")
		return
	}
	_ = os.MkdirAll(s.Cwd, 0o755)
	ts := time.Now().Unix()
	tmuxName := "claude-" + s.OwnerID + "-" + s.Project + "-" + itoa(ts)
	// Resume targets the session's OWN captured agent_session_id and never
	// reassigns it: the link established at create time is authoritative and must
	// stay pinned across resume. We pass the stored id as-is — we do NOT borrow
	// the newest transcript in the cwd, which in a shared directory would belong
	// to a sibling session and corrupt this session's linkage.
	resume := agentSessionID(s)
	model_ := ""
	if s.Model != nil {
		model_ = *s.Model
	}
	if s.Transport == "sdk" {
		// Same availability gate as create: never spawn a broken session.
		if !d.Cfg.SDKAvailable() {
			writeErr(w, http.StatusConflict,
				"sdk transport unavailable: claude-structured binary not found at "+d.Cfg.StructuredBinResolved())
			return
		}
		jsonIn, jsonOut, err := d.SDK.ResetChannels(s.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := d.Tmux.CreateSDKSession(tmuxName, s.Cwd, s.Env,
			d.Cfg.StructuredBinResolved(), model_, resume, jsonIn, jsonOut); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		_ = d.Store.UpdateTmuxSessionName(s.ID, tmuxName)
		_, _ = d.Store.Transition(s.ID, model.StatusRunning)
		_ = d.Store.ResetAttachedClients(s.ID)
		// session_start from the new wrapper re-pins agent_session_id (the SDK
		// forks --resume to a fresh id, and the pump's view is authoritative).
		d.SDK.Start(s.ID)
		out, _ := d.Store.GetSession(s.ID)
		writeJSON(w, http.StatusOK, out)
		return
	}
	if err := d.Tmux.CreateSession(tmuxName, s.Cwd, s.Env, model_, resume, "", s.Tool); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = d.Store.UpdateTmuxSessionName(s.ID, tmuxName)
	_, _ = d.Store.Transition(s.ID, model.StatusRunning)
	_ = d.Store.ResetAttachedClients(s.ID)
	if s.Tool != "cursor" {
		_ = d.Store.UpdateClaudeProcPID(s.ID, nil)
		// Re-resolve only the live PID for process monitoring. The
		// agent_session_id is intentionally NOT updated on resume — the
		// create-time link is authoritative and stays pinned.
		go func(sid, name, scwd string) {
			if _, pid, ok := d.Tmux.ResolveAgentSessionID(name, scwd, 15*time.Second); ok && pid > 0 {
				p := pid
				_ = d.Store.UpdateClaudeProcPID(sid, &p)
			}
		}(s.ID, tmuxName, s.Cwd)
	}
	out, _ := d.Store.GetSession(s.ID)
	writeJSON(w, http.StatusOK, out)
}

type sessionRenameReq struct {
	Name string `json:"name"`
}

func renameSession(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body sessionRenameReq
	if !readJSON(w, r, &body) {
		return
	}
	_ = d.Store.UpdateProject(s.ID, strings.TrimSpace(body.Name))
	out, _ := d.Store.GetSession(s.ID)
	writeJSON(w, http.StatusOK, out)
}

type setModelReq struct {
	Model *string `json:"model"`
}

func setSessionModel(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body setModelReq
	if !readJSON(w, r, &body) {
		return
	}
	if (s.Status == model.StatusRunning || s.Status == model.StatusDetached) && body.Model != nil && *body.Model != "" {
		if s.Transport == "sdk" {
			_ = d.SDK.Control(s.ID, "set_model", map[string]any{"model": *body.Model})
		} else {
			_ = d.Tmux.SendKeys(s.TmuxSessionName, "/model "+*body.Model)
		}
	}
	_ = d.Store.UpdateModel(s.ID, body.Model)
	out, _ := d.Store.GetSession(s.ID)
	writeJSON(w, http.StatusOK, out)
}

func deleteSession(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if s.Status != model.StatusTerminated {
		writeErr(w, http.StatusConflict, "only terminated sessions can be deleted")
		return
	}
	_ = d.Store.DeleteTasksForSession(s.ID)
	_, _ = d.Store.DeleteSession(s.ID)
	w.WriteHeader(http.StatusNoContent)
}

type taskCreateReq struct {
	Command      string `json:"command"`
	DelaySeconds int    `json:"delay_seconds"`
	LoopSeconds  *int   `json:"loop_seconds"`
}

func createTask(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if s.Status == model.StatusTerminated {
		writeErr(w, http.StatusConflict, "session is terminated")
		return
	}
	var body taskCreateReq
	if !readJSON(w, r, &body) {
		return
	}
	runAt := model.ISOTime{Time: time.Now().UTC().Add(time.Duration(body.DelaySeconds) * time.Second)}
	t := &model.ScheduledTask{
		ID:          uuidV4(),
		SessionID:   s.ID,
		OwnerID:     s.OwnerID,
		Command:     body.Command,
		RunAt:       runAt,
		Status:      "pending",
		CreatedAt:   model.NowUTC(),
		LoopSeconds: body.LoopSeconds,
	}
	if err := d.Store.CreateTask(t); err != nil {
		writeErr(w, http.StatusInternalServerError, "create task failed")
		return
	}
	writeJSONStatus(w, http.StatusCreated, model.TaskView{
		ID: t.ID, Command: t.Command, RunAt: t.RunAt.String(),
		Status: t.Status, CreatedAt: t.CreatedAt.String(), LoopSeconds: t.LoopSeconds,
	})
}

func cancelTask(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	ok, _ := d.Store.CancelTask(chi.URLParam(r, "taskID"))
	if !ok {
		writeErr(w, http.StatusNotFound, "task not found or already completed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- small helpers --------------------------------------------------------

func isDir(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
