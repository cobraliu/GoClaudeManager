package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// registerLostMessageRoutes registers the session-scoped "send failed" (lost
// message) endpoints. The registry lives in memory on the Store; these let any
// client register a detected loss and dismiss it, with the result synced to all
// clients via the lost_messages field on the status poll.
func registerLostMessageRoutes(r chi.Router, d Deps) {
	r.Post("/{id}/lost-messages", func(w http.ResponseWriter, req *http.Request) { registerLostMessage(d, w, req) })
	r.Delete("/{id}/lost-messages/{lostId}", func(w http.ResponseWriter, req *http.Request) { dismissLostMessage(d, w, req) })
}

type lostMessageCreateReq struct {
	Text   string  `json:"text"`
	SentAt float64 `json:"sent_at"`
}

func registerLostMessage(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body lostMessageCreateReq
	if !readJSON(w, r, &body) {
		return
	}
	if body.Text == "" {
		writeErr(w, http.StatusUnprocessableEntity, "text required")
		return
	}
	lm := d.Store.RegisterLostMessage(s.ID, body.Text, body.SentAt)
	writeJSON(w, http.StatusOK, lm)
}

func dismissLostMessage(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	d.Store.DismissLostMessage(s.ID, chi.URLParam(r, "lostId"))
	w.WriteHeader(http.StatusNoContent)
}
