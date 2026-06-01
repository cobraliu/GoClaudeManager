package api

import (
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/term"
	"github.com/loki/goclaudemanager/internal/ws"
)

// registerTerminalRoutes wires the bash-terminal REST endpoints onto the
// sessions sub-router (mounted at /api/sessions), plus the ephemeral /{id}/shell
// token endpoint and /{id}/pane-history. Paths + JSON shapes mirror the Python
// app/api/terminals.py and the sessions.py shell/pane-history endpoints.
func registerTerminalRoutes(r chi.Router, d Deps, ts *term.Service) {
	r.Get("/{id}/terminals", func(w http.ResponseWriter, r *http.Request) { listTerminals(d, ts, w, r) })
	r.Post("/{id}/terminals", func(w http.ResponseWriter, r *http.Request) { createTerminal(d, ts, w, r) })
	r.Post("/{id}/terminals/{term_id}/token", func(w http.ResponseWriter, r *http.Request) { issueTermToken(d, ts, w, r) })
	r.Post("/{id}/terminals/{term_id}/rename", func(w http.ResponseWriter, r *http.Request) { renameTerminal(d, ts, w, r) })
	r.Post("/{id}/terminals/{term_id}/heartbeat", func(w http.ResponseWriter, r *http.Request) { heartbeatTerminal(d, ts, w, r) })
	r.Delete("/{id}/terminals/{term_id}", func(w http.ResponseWriter, r *http.Request) { deleteTerminal(d, ts, w, r) })

	r.Post("/{id}/shell", func(w http.ResponseWriter, r *http.Request) { openShell(d, w, r) })
	r.Get("/{id}/pane-history", func(w http.ResponseWriter, r *http.Request) { getPaneHistory(d, w, r) })
}

// resolveSessionAccess returns the session if it exists and the caller may see
// it (owner or admin), else writes a 404 and returns nil. Mirrors
// _check_session_access (admins bypass ownership; the owned helper does not).
func resolveSessionAccess(d Deps, w http.ResponseWriter, r *http.Request) (*sessionAccess, bool) {
	id := chi.URLParam(r, "id")
	s, err := d.Store.GetSession(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return nil, false
	}
	who := auth.FromContext(r.Context())
	if s == nil || who == nil || (!who.IsAdmin && s.OwnerID != who.Username) {
		writeErr(w, http.StatusNotFound, "session not found")
		return nil, false
	}
	return &sessionAccess{sessionID: id, cwd: s.Cwd, tmuxName: s.TmuxSessionName, username: who.Username, isAdmin: who.IsAdmin}, true
}

type sessionAccess struct {
	sessionID string
	cwd       string
	tmuxName  string
	username  string
	isAdmin   bool
}

// resolveTermForSession fetches a record and enforces session + ownership
// scoping, writing the right status on failure.
func resolveTermForSession(ts *term.Service, acc *sessionAccess, w http.ResponseWriter, r *http.Request) (*term.Record, bool) {
	termID := chi.URLParam(r, "term_id")
	rec := ts.Get(termID)
	if rec == nil || rec.SessionID != acc.sessionID {
		writeErr(w, http.StatusNotFound, "terminal not found")
		return nil, false
	}
	if !acc.isAdmin && rec.UserID != acc.username {
		writeErr(w, http.StatusNotFound, "terminal not found")
		return nil, false
	}
	return rec, true
}

func listTerminals(d Deps, ts *term.Service, w http.ResponseWriter, r *http.Request) {
	acc, ok := resolveSessionAccess(d, w, r)
	if !ok {
		return
	}
	recs := ts.ListFor(acc.sessionID, acc.username, acc.isAdmin)
	items := make([]map[string]any, 0, len(recs))
	for _, rec := range recs {
		items = append(items, rec.Public())
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func createTerminal(d Deps, ts *term.Service, w http.ResponseWriter, r *http.Request) {
	acc, ok := resolveSessionAccess(d, w, r)
	if !ok {
		return
	}
	var body struct {
		Name string  `json:"name"`
		Cwd  *string `json:"cwd"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	cwd := acc.cwd
	if body.Cwd != nil && *body.Cwd != "" {
		cwd = *body.Cwd
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "Directory not found: "+cwd)
		return
	}
	rec, err := ts.Create(acc.sessionID, acc.username, cwd, body.Name)
	if err != nil {
		var conflict *term.ConflictError
		switch {
		case asConflict(err, &conflict):
			writeErr(w, http.StatusConflict, conflict.Error())
		default:
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	token, _ := ts.IssueToken(rec.TermID)
	writeJSON(w, http.StatusOK, map[string]any{
		"term_id":  rec.TermID,
		"name":     nameOrNil(rec.Name),
		"is_named": rec.IsNamed(),
		"ws_token": token,
		"ws_url":   d.Env.PublicPath("/ws/terminals/" + rec.TermID + "?token=" + token),
	})
}

func issueTermToken(d Deps, ts *term.Service, w http.ResponseWriter, r *http.Request) {
	acc, ok := resolveSessionAccess(d, w, r)
	if !ok {
		return
	}
	rec, ok := resolveTermForSession(ts, acc, w, r)
	if !ok {
		return
	}
	token, err := ts.IssueToken(rec.TermID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "terminal not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"term_id":  rec.TermID,
		"ws_token": token,
		"ws_url":   d.Env.PublicPath("/ws/terminals/" + rec.TermID + "?token=" + token),
		"name":     nameOrNil(rec.Name),
		"is_named": rec.IsNamed(),
		"kept":     rec.Kept,
	})
}

func renameTerminal(d Deps, ts *term.Service, w http.ResponseWriter, r *http.Request) {
	acc, ok := resolveSessionAccess(d, w, r)
	if !ok {
		return
	}
	rec, ok := resolveTermForSession(ts, acc, w, r)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	updated, err := ts.Rename(rec.TermID, body.Name)
	if err != nil {
		var conflict *term.ConflictError
		if asConflict(err, &conflict) {
			writeErr(w, http.StatusConflict, conflict.Error())
			return
		}
		writeErr(w, http.StatusNotFound, "terminal not found")
		return
	}
	writeJSON(w, http.StatusOK, updated.Public())
}

func heartbeatTerminal(d Deps, ts *term.Service, w http.ResponseWriter, r *http.Request) {
	acc, ok := resolveSessionAccess(d, w, r)
	if !ok {
		return
	}
	// 410 when the cached term_id has already been swept; 404 on session/owner
	// mismatch. Match the Python status discrimination.
	termID := chi.URLParam(r, "term_id")
	rec := ts.Get(termID)
	if rec == nil {
		writeErr(w, http.StatusGone, "terminal gone")
		return
	}
	if rec.SessionID != acc.sessionID || (!acc.isAdmin && rec.UserID != acc.username) {
		writeErr(w, http.StatusNotFound, "terminal not found")
		return
	}
	updated := ts.Heartbeat(termID)
	if updated == nil {
		writeErr(w, http.StatusGone, "terminal gone")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"term_id":      updated.TermID,
		"is_named":     updated.IsNamed(),
		"kept":         updated.Kept,
		"attach_count": updated.AttachCount,
	})
}

func deleteTerminal(d Deps, ts *term.Service, w http.ResponseWriter, r *http.Request) {
	acc, ok := resolveSessionAccess(d, w, r)
	if !ok {
		return
	}
	rec, ok := resolveTermForSession(ts, acc, w, r)
	if !ok {
		return
	}
	ts.Delete(rec.TermID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// openShell issues a one-shot token for opening a direct bash PTY in the
// session's cwd. (Port of sessions.open_shell.) Admins get an unrestricted shell.
func openShell(d Deps, w http.ResponseWriter, r *http.Request) {
	acc, ok := resolveSessionAccess(d, w, r)
	if !ok {
		return
	}
	if info, err := os.Stat(acc.cwd); err != nil || !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "Directory not found: "+acc.cwd)
		return
	}
	token := randomSecret()
	ws.PutShellToken(token, acc.cwd, acc.isAdmin)
	writeJSON(w, http.StatusOK, map[string]any{
		"session_id": token,
		"ws_token":   token,
		"ws_url":     d.Env.PublicPath("/ws/shell?token=" + token),
		"status":     "running",
	})
}

// sgrRe matches SGR color/style sequences (\x1b[...m).
var sgrRe = regexp.MustCompile("\x1b\\[[\\d;]*m")

// escRe matches the broader set of escape sequences to strip (cursor movement,
// clears, alt-screen, charset, OSC). Mirrors the Python esc_re.
var escRe = regexp.MustCompile("\x1b(?:[@-Z\\\\-_]|\\[[0-9;]*[A-Za-z]|\\][^\x07\x1b]*(?:\x07|\x1b\\\\))")

// getPaneHistory returns recent pane output from tmux capture-pane, keeping only
// SGR color/style sequences and stripping everything else so writing it to a
// fresh xterm.js doesn't garble layout. (Port of sessions.get_pane_history.)
func getPaneHistory(d Deps, w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s, err := d.Store.GetSession(id)
	if err != nil || s == nil {
		writeErr(w, http.StatusNotFound, "session not found")
		return
	}
	lines := queryInt(r, "lines", 20000)
	if lines < 50 {
		lines = 50
	}
	if lines > 20000 {
		lines = 20000
	}
	if s.TmuxSessionName == "" {
		writeJSON(w, http.StatusOK, map[string]any{"content": ""})
		return
	}
	out, err := d.Tmux.Run("capture-pane", "-p", "-e", "-t", s.TmuxSessionName, "-S", "-"+strconv.Itoa(lines))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"content": ""})
		return
	}
	var cleaned []string
	for _, ln := range strings.Split(out, "\n") {
		cleaned = append(cleaned, cleanLine(ln))
	}
	writeJSON(w, http.StatusOK, map[string]any{"content": strings.Join(cleaned, "\r\n")})
}

// cleanLine strips non-SGR escape sequences while preserving SGR color tokens in
// their original positions. (Port of get_pane_history.clean_line.)
func cleanLine(line string) string {
	var b strings.Builder
	pos := 0
	for _, m := range sgrRe.FindAllStringIndex(line, -1) {
		b.WriteString(escRe.ReplaceAllString(line[pos:m[0]], ""))
		b.WriteString(line[m[0]:m[1]])
		pos = m[1]
	}
	b.WriteString(escRe.ReplaceAllString(line[pos:], ""))
	return b.String()
}

// ── small helpers ───────────────────────────────────────────────────────

func nameOrNil(name string) any {
	if name == "" {
		return nil
	}
	return name
}

func asConflict(err error, target **term.ConflictError) bool {
	if ce, ok := err.(*term.ConflictError); ok {
		*target = ce
		return true
	}
	return false
}
