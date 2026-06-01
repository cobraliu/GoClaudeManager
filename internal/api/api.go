// Package api hosts the REST surface. During the migration each Python router
// (sessions, auth, files, code, …) lands here as a sub-router under /api,
// keeping the exact URL/JSON contract so the React frontend needs no changes.
//
// This is the Phase-0 scaffold: only infrastructure endpoints exist yet.
package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/config"
	"github.com/loki/goclaudemanager/internal/git"
	"github.com/loki/goclaudemanager/internal/jsonl"
	"github.com/loki/goclaudemanager/internal/status"
	"github.com/loki/goclaudemanager/internal/store"
	"github.com/loki/goclaudemanager/internal/term"
	"github.com/loki/goclaudemanager/internal/tmux"
)

// Deps bundles what the API handlers need.
type Deps struct {
	Store    *store.Store
	Cfg      *config.Config
	Env      config.Env
	Auth     *auth.Auth
	Tmux     *tmux.Client
	Git      *git.Service
	JSONL    *jsonl.Cache
	Snapshot *status.Manager
	Term     *term.Service
}

// Router builds the /api sub-router.
func Router(d Deps) http.Handler {
	r := chi.NewRouter()

	// gzip every JSON response. The raw-messages poll, raw-messages/all (full
	// transcript), conversation/jsonl pages, file reads, git log/graph and the
	// public share payloads are all large, repetitive JSON — gzip cuts them ~4-5×
	// on the wire (a 147KB raw-messages window → ~34KB) at negligible CPU. The
	// middleware only kicks in when the client sends Accept-Encoding: gzip and the
	// Content-Type is compressible, so it is transparent to every handler.
	r.Use(middleware.Compress(5))

	// Liveness for the API layer specifically.
	r.Get("/ping", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	})

	// Surfaces a few non-secret runtime settings the frontend may read.
	r.Get("/meta", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"backend":       "go",
			"root_path":     d.Env.RootPath,
			"enabled_tools": d.Cfg.EnabledTools(),
		})
	})

	// Top-level config / models / usage / fs endpoints (config_routes.go).
	registerTopLevelRoutes(r, d)

	r.Mount("/auth", authRouter(d))
	r.Mount("/sessions", sessionsRouter(d))
	r.Mount("/public/share", PublicShareRouter(d))
	r.Mount("/claude-caps", ClaudeCapsRouter(d))
	r.Mount("/admin/terminals", AdminTerminalsRouter(d))
	r.Mount("/admin/claude-login", ClaudeLoginRouter(d))

	return r
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeJSONStatus is an alias for writeJSON with an explicit status (readability).
func writeJSONStatus(w http.ResponseWriter, status int, v any) { writeJSON(w, status, v) }

// writeErr emits a FastAPI-style {"detail": ...} error body.
func writeErr(w http.ResponseWriter, status int, detail string) {
	writeJSON(w, status, map[string]string{"detail": detail})
}

// readJSON decodes the request body into v; on failure it writes a 422 and
// returns false (matching FastAPI's unprocessable-entity behavior loosely).
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "invalid request body")
		return false
	}
	return true
}

// randomSecret returns a URL-safe random string (for placeholder passwords).
func randomSecret() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
