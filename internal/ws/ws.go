// Package ws hosts the WebSocket endpoints. The primary one is the terminal
// stream (/ws/sessions/{id}) — a faithful port of app/ws/terminal_ws.py:
// it attaches a PTY to the session's tmux pane and pumps raw output to the
// browser (xterm.js), accepting input / resize / scroll (copy-mode) / search /
// ping messages back.
package ws

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/config"
	"github.com/loki/goclaudemanager/internal/sdktransport"
	"github.com/loki/goclaudemanager/internal/store"
	"github.com/loki/goclaudemanager/internal/term"
	"github.com/loki/goclaudemanager/internal/tmux"
)

// Deps bundles what the WebSocket handlers need.
type Deps struct {
	Store *store.Store
	Tmux  *tmux.Client
	Auth  *auth.Auth
	Env   config.Env
	Term  *term.Service
	SDK   *sdktransport.Manager
}

// Router builds the /ws sub-router.
func Router(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Get("/sessions/{id}", func(w http.ResponseWriter, r *http.Request) { terminalWS(d, w, r) })
	RegisterTermRoutes(r, d, d.Term)
	return r
}
