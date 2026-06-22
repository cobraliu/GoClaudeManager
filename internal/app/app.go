// Package app wires the dependencies together and builds the HTTP server.
package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/loki/goclaudemanager/internal/api"
	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/config"
	"github.com/loki/goclaudemanager/internal/git"
	"github.com/loki/goclaudemanager/internal/jsonl"
	"github.com/loki/goclaudemanager/internal/model"
	"github.com/loki/goclaudemanager/internal/sdktransport"
	"github.com/loki/goclaudemanager/internal/status"
	"github.com/loki/goclaudemanager/internal/store"
	"github.com/loki/goclaudemanager/internal/procmon"
	"github.com/loki/goclaudemanager/internal/sysmon"
	"github.com/loki/goclaudemanager/internal/term"
	"github.com/loki/goclaudemanager/internal/tmux"
	"github.com/loki/goclaudemanager/internal/web"
	"github.com/loki/goclaudemanager/internal/ws"
)

// App holds long-lived dependencies.
type App struct {
	Env      config.Env
	Store    *store.Store
	Cfg      *config.Config
	Auth     *auth.Auth
	Tmux     *tmux.Client
	Git      *git.Service
	JSONL    *jsonl.Cache
	Snapshot *status.Manager
	Term     *term.Service
	SDK      *sdktransport.Manager
	Sysmon   *sysmon.Sampler
	Procmon  *procmon.Sampler
}

// New opens the store and assembles the application.
func New() (*App, error) {
	env := config.LoadEnv()
	st, err := store.Open()
	if err != nil {
		return nil, err
	}
	cfg := config.New(st.DB)

	// Seed the default admin on an empty users table (mirrors claudemanager.py
	// startup: admin/admin123 from the default_admin config).
	if empty, err := st.UsersEmpty(); err == nil && empty {
		username, password := cfg.DefaultAdmin()
		if _, err := st.CreateUser(username, password, model.RoleAdmin); err == nil {
			_, _ = st.SetIsAdmin(username, true)
			slog.Info("seeded default admin", "username", username)
		}
	}

	// tmux client — same socket name ("claude-web") and proxy port as the
	// Python backend so both talk to the same tmux server during migration.
	// CM_TMUX_SOCKET overrides the socket (useful for isolated tests).
	socket := os.Getenv("CM_TMUX_SOCKET")
	if socket == "" {
		socket = "claude-web"
	}
	tmuxClient := tmux.New(socket)
	tmuxClient.ClaudeBin = cfg.ClaudeBin
	tmuxClient.CursorBin = cfg.CursorBin
	tmuxClient.ClaudeShell = cfg.ClaudeShell
	tmuxClient.ProxyEnv = cfg.ProxyEnv
	tmuxClient.ProxyMode = cfg.ProxyMode
	tmuxClient.AnthropicProxyPort = proxyPort()

	gitSvc := git.New(cfg.ProxyEnv, slog.Default())
	jsonlCache := jsonl.NewCache()
	termSvc := term.New(tmuxClient)
	// Mirror the registry to terms.json and re-adopt terminals from a previous
	// run whose tmux sessions are still alive (matches the Python backend).
	termSvc.SetPersistPath(termsPath(env.DataDir))
	termSvc.Restore()

	a := &App{
		Env:   env,
		Store: st,
		Cfg:   cfg,
		Auth:  auth.New(cfg.JWTSecret()),
		Tmux:  tmuxClient,
		Git:   gitSvc,
		JSONL: jsonlCache,
		Term:  termSvc,
	}
	a.SDK = sdktransport.New(st, env.DataDir)
	a.Snapshot = status.NewManager(st, tmuxClient, jsonlCache)
	a.Snapshot.SDK = a.SDK
	a.Sysmon = sysmon.NewSampler()
	// procmon is on-demand (driven synchronously by the /processes endpoint),
	// so — unlike Sysmon — it gets no background goroutine in Start.
	a.Procmon = procmon.NewSampler()
	return a, nil
}

// termsPath resolves the terminal-registry file, mirroring resolveDBPath:
// <CLAUDEMANAGER_DATA_DIR>/terms.json, or ./data/terms.json in dev.
func termsPath(dataDir string) string {
	if dataDir != "" {
		return filepath.Join(dataDir, "terms.json")
	}
	return filepath.Join("data", "terms.json")
}

// proxyPort returns the anthropic-proxy port (CLAUDE_PROXY_PORT, default 19098).
func proxyPort() int {
	if v := os.Getenv("CLAUDE_PROXY_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return 19098
}

// Handler builds the root HTTP handler.
//
// Routes match the Python backend so the frontend and nginx are unchanged:
//
//	/health        liveness probe
//	/api/*         REST surface
//	/ws/*          WebSocket streams
//	/* (catch-all) React SPA (assets + index.html fallback)
//
// ROOT_PATH note: nginx strips the public prefix before proxying, so handlers
// always match bare paths here (same contract as url_prefix.py).
func (a *App) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(requestLogger)

	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	r.Mount("/api", api.Router(api.Deps{
		Store:    a.Store,
		Cfg:      a.Cfg,
		Env:      a.Env,
		Auth:     a.Auth,
		Tmux:     a.Tmux,
		Git:      a.Git,
		JSONL:    a.JSONL,
		Snapshot: a.Snapshot,
		Term:     a.Term,
		SDK:      a.SDK,
		Sysmon:   a.Sysmon,
		Procmon:  a.Procmon,
	}))
	r.Mount("/ws", ws.Router(ws.Deps{Store: a.Store, Tmux: a.Tmux, Auth: a.Auth, Env: a.Env, Term: a.Term, SDK: a.SDK}))

	// Catch-all: serve the SPA. Must be mounted last. Wrap in gzip so the large
	// Vite bundle (the main index-*.js is ~2.5MB → ~760KB gzipped) and CSS ship
	// compressed on first load. Compress is content-type aware, so hashed images
	// and already-compressed assets are passed through untouched. Not applied to
	// /ws (WebSocket upgrade must not be wrapped).
	r.NotFound(middleware.Compress(5)(web.Handler(a.Env.FrontendDist)).ServeHTTP)

	return r
}

// Server returns a configured *http.Server bound to the env host/port.
func (a *App) Server() *http.Server {
	addr := fmt.Sprintf("%s:%d", a.Env.Host, a.Env.Port)
	return &http.Server{
		Addr:              addr,
		Handler:           a.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		// No write timeout: WebSocket and SSE-style responses are long-lived.
	}
}

// Start launches background loops (status snapshot, task runner, reconciler,
// bash-terminal sweeper, proxy-tap snapshot cleanup). Stops when ctx is cancelled.
func (a *App) Start(ctx context.Context) {
	a.reconcileOnStartup()
	go a.Snapshot.Run(ctx)
	go a.Sysmon.Run(ctx)
	go a.Term.Sweeper(ctx)
	go a.runTaskScheduler(ctx)
	go a.runProxyTapCleanup(ctx)
	go a.runShadowBackup(ctx)
}

// Close releases resources.
func (a *App) Close() error {
	return a.Store.Close()
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		slog.Debug("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", ww.Status(),
			"bytes", ww.BytesWritten(),
			"dur", time.Since(start).String(),
		)
	})
}
