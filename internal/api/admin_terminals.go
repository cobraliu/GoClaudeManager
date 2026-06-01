// Port of app/api/admin_terminals.py (prefix /api/admin/terminals).
//
// Admin-scoped bash terminals (tmux-backed). These reuse the same term.Service
// as session-scoped terminals — same lifecycle (idle/standby/kept), same
// heartbeat protocol, same active-child detection. The differences:
//
//   - mounted at /api/admin/terminals/... (no session_id in the path)
//   - require admin auth instead of session ownership
//   - grouped under a sentinel session_id "__admin__" so the sweeper and
//     ListFor queries behave just like for a real session
//
// JSON shapes match the Python Pydantic models so the frontend's
// EmbeddedTerminalPanel can attach by swapping the API adapter.
package api

import (
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/term"
)

// adminSessionID is the sentinel session under which admin terminals live.
const adminSessionID = "__admin__"

// AdminTerminalsRouter builds the /api/admin/terminals sub-router (mounted by
// the lead). All routes are admin-only.
func AdminTerminalsRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(d.Auth.RequireAdmin)

	r.Get("/", func(w http.ResponseWriter, r *http.Request) { adminTermList(d, w, r) })
	r.Post("/", func(w http.ResponseWriter, r *http.Request) { adminTermCreate(d, w, r) })
	r.Delete("/{term_id}", func(w http.ResponseWriter, r *http.Request) { adminTermDelete(d, w, r) })
	r.Post("/{term_id}/heartbeat", func(w http.ResponseWriter, r *http.Request) { adminTermHeartbeat(d, w, r) })
	r.Post("/{term_id}/rename", func(w http.ResponseWriter, r *http.Request) { adminTermRename(d, w, r) })
	r.Post("/{term_id}/token", func(w http.ResponseWriter, r *http.Request) { adminTermToken(d, w, r) })

	return r
}

// adminUsername returns the calling admin's username (for the term UserID).
func adminUsername(r *http.Request) string {
	if id := auth.FromContext(r.Context()); id != nil {
		return id.Username
	}
	return ""
}

// resolveAdminTerm fetches a record scoped to the admin sentinel session,
// writing a 404 on miss. Mirrors _require_admin_term.
func resolveAdminTerm(ts *term.Service, w http.ResponseWriter, r *http.Request) (*term.Record, bool) {
	termID := chi.URLParam(r, "term_id")
	rec := ts.Get(termID)
	if rec == nil || rec.SessionID != adminSessionID {
		writeErr(w, http.StatusNotFound, "terminal not found")
		return nil, false
	}
	return rec, true
}

func adminTermList(d Deps, w http.ResponseWriter, r *http.Request) {
	recs := d.Term.ListFor(adminSessionID, adminUsername(r), true)
	items := make([]map[string]any, 0, len(recs))
	for _, rec := range recs {
		items = append(items, rec.Public())
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func adminTermCreate(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		Cwd  string `json:"cwd"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if info, err := os.Stat(body.Cwd); err != nil || !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "Directory not found: "+body.Cwd)
		return
	}
	rec, err := d.Term.Create(adminSessionID, adminUsername(r), body.Cwd, body.Name)
	if err != nil {
		var conflict *term.ConflictError
		if asConflict(err, &conflict) {
			writeErr(w, http.StatusConflict, conflict.Error())
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	token, _ := d.Term.IssueToken(rec.TermID)
	writeJSON(w, http.StatusOK, map[string]any{
		"term_id":  rec.TermID,
		"name":     nameOrNil(rec.Name),
		"is_named": rec.IsNamed(),
		"ws_token": token,
		"ws_url":   d.Env.PublicPath("/ws/terminals/" + rec.TermID + "?token=" + token),
	})
}

func adminTermToken(d Deps, w http.ResponseWriter, r *http.Request) {
	rec, ok := resolveAdminTerm(d.Term, w, r)
	if !ok {
		return
	}
	token, err := d.Term.IssueToken(rec.TermID)
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

func adminTermRename(d Deps, w http.ResponseWriter, r *http.Request) {
	rec, ok := resolveAdminTerm(d.Term, w, r)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	updated, err := d.Term.Rename(rec.TermID, body.Name)
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

func adminTermHeartbeat(d Deps, w http.ResponseWriter, r *http.Request) {
	// 410 when the cached term_id has already been swept; 404 on session
	// mismatch. Matches the Python status discrimination.
	termID := chi.URLParam(r, "term_id")
	rec := d.Term.Get(termID)
	if rec == nil {
		writeErr(w, http.StatusGone, "terminal gone")
		return
	}
	if rec.SessionID != adminSessionID {
		writeErr(w, http.StatusNotFound, "terminal not found")
		return
	}
	updated := d.Term.Heartbeat(termID)
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

func adminTermDelete(d Deps, w http.ResponseWriter, r *http.Request) {
	rec, ok := resolveAdminTerm(d.Term, w, r)
	if !ok {
		return
	}
	d.Term.Delete(rec.TermID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
