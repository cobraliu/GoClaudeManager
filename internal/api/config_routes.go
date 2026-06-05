// Top-level (non-session-scoped) REST endpoints ported from the Python
// app/api/config_api.py, app/api/usage_api.py, app/api/fs.py and the
// /api/models router in app/api/sessions.py. JSON request/response shapes mirror
// the FastAPI handlers exactly so the React frontend needs no changes.
//
// registerTopLevelRoutes mounts these on the /api root router (the same router
// that carries /ping, /meta, /auth, /sessions). The lead wires the call in
// api.Router; this file owns only the handlers + route table.
package api

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/bzip2"
	"compress/gzip"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/config"
)

// registerTopLevelRoutes registers the config / models / usage / fs endpoints on
// the /api root router. Read endpoints require a logged-in user; mutating config
// endpoints require admin, matching the CurrentUser / AdminUser dependencies in
// the Python routers.
func registerTopLevelRoutes(r chi.Router, d Deps) {
	// ── /api/config (app/api/config_api.py) ──────────────────────────────
	r.Group(func(rr chi.Router) {
		rr.Use(d.Auth.RequireUser)
		rr.Get("/config", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
		})
		rr.Get("/config/available-tools", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]bool{
				"claude": binInstalled(d.Cfg.ClaudeBin()),
				"cursor": binInstalled(d.Cfg.CursorBin()),
				// SDK transport for claude sessions: requires the
				// claude-structured wrapper binary on disk (admin-configurable
				// path; default = next to the server binary).
				"claude_sdk": d.Cfg.SDKAvailable(),
			})
		})
		rr.Get("/config/fonts", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, listSystemFonts())
		})
	})

	r.Group(func(rr chi.Router) {
		rr.Use(d.Auth.RequireAdmin)
		rr.Put("/config/proxy", func(w http.ResponseWriter, r *http.Request) { updateProxy(d, w, r) })
		rr.Put("/config/workspace", func(w http.ResponseWriter, r *http.Request) { updateWorkspace(d, w, r) })
		rr.Put("/config/claude-bin", func(w http.ResponseWriter, r *http.Request) { updateClaudeBin(d, w, r) })
		rr.Put("/config/structured-bin", func(w http.ResponseWriter, r *http.Request) { updateStructuredBin(d, w, r) })
		rr.Put("/config/cursor-bin", func(w http.ResponseWriter, r *http.Request) { updateCursorBin(d, w, r) })
		rr.Put("/config/enabled-tools", func(w http.ResponseWriter, r *http.Request) { updateEnabledTools(d, w, r) })
		rr.Put("/config/claude-models", func(w http.ResponseWriter, r *http.Request) { updateClaudeModels(d, w, r) })
		rr.Put("/config/file-viewer", func(w http.ResponseWriter, r *http.Request) { updateFileViewer(d, w, r) })
		rr.Put("/config/skip-dirs", func(w http.ResponseWriter, r *http.Request) { updateSkipDirs(d, w, r) })
		rr.Put("/config/term-lifecycle", func(w http.ResponseWriter, r *http.Request) { updateTermLifecycle(d, w, r) })
		rr.Put("/config/terminal-font", func(w http.ResponseWriter, r *http.Request) { updateTerminalFont(d, w, r) })
		rr.Post("/config/restart", func(w http.ResponseWriter, r *http.Request) { restartServer(d, w, r) })
	})

	// ── /api/models (app/api/sessions.py models_router) ──────────────────
	r.With(d.Auth.RequireUser).Get("/models", func(w http.ResponseWriter, r *http.Request) {
		tool := r.URL.Query().Get("tool")
		if tool == "" {
			tool = "claude"
		}
		writeJSON(w, http.StatusOK, listModels(d.Cfg, tool))
	})

	// ── /api/usage (app/api/usage_api.py) ────────────────────────────────
	r.With(d.Auth.RequireUser).Get("/usage", func(w http.ResponseWriter, r *http.Request) { getUsage(d, w, r) })

	// ── /api/fs (app/api/fs.py) ──────────────────────────────────────────
	r.Group(func(rr chi.Router) {
		rr.Use(d.Auth.RequireUser)
		rr.Get("/fs/dirs", func(w http.ResponseWriter, r *http.Request) { listDirs(w, r) })
		rr.Post("/fs/extract-to", func(w http.ResponseWriter, r *http.Request) { extractToDir(w, r) })
	})
}

// ── ConfigView (mirrors config_api.ConfigView) ───────────────────────────────

type configView struct {
	Workspace               string   `json:"workspace"`
	ClaudeBin               string   `json:"claude_bin"`
	StructuredBin           string   `json:"structured_bin"`          // raw configured value ("" = default)
	StructuredBinResolved   string   `json:"structured_bin_resolved"` // path actually used
	SDKAvailable            bool     `json:"sdk_available"`           // wrapper exists + executable
	CursorBin               string   `json:"cursor_bin"`
	Proxy                   string   `json:"proxy"`
	ProxyMode               string   `json:"proxy_mode"`
	TapUpstream             string   `json:"tap_upstream"`
	TerminalFont            string   `json:"terminal_font"`
	TermIdleGraceSeconds    int      `json:"term_idle_grace_seconds"`
	TermStandbyGraceSeconds int      `json:"term_standby_grace_seconds"`
	FileViewerMode          string   `json:"file_viewer_mode"`
	FileViewerMaxLines      int      `json:"file_viewer_max_lines"`
	FileViewerMaxBytes      int      `json:"file_viewer_max_bytes"`
	EnabledTools            []string `json:"enabled_tools"`
	SkipDirs                []string `json:"skip_dirs"`
	ClaudeModels            []string `json:"claude_models"`
}

func fullConfig(c *config.Config) configView {
	return configView{
		Workspace:               c.DefaultWorkspace(),
		ClaudeBin:               c.ClaudeBin(),
		StructuredBin:           c.StructuredBin(),
		StructuredBinResolved:   c.StructuredBinResolved(),
		SDKAvailable:            c.SDKAvailable(),
		CursorBin:               c.CursorBin(),
		Proxy:                   c.Proxy(),
		ProxyMode:               c.ProxyMode(),
		// TapUpstream is read-only and ops-level: it reflects how the standalone
		// tap proxy (bin/proxy) was launched, surfaced here so the Admin UI can
		// show it without the proxy binary needing any DB access. Empty = direct
		// to api.anthropic.com. Set via PROXY_UPSTREAM (restart.sh) /
		// --upstream-proxy / ANTHROPIC_PROXY_UPSTREAM at proxy startup.
		TapUpstream:             os.Getenv("ANTHROPIC_PROXY_UPSTREAM"),
		TerminalFont:            c.TerminalFont(),
		TermIdleGraceSeconds:    c.TermIdleGraceSeconds(),
		TermStandbyGraceSeconds: c.TermStandbyGraceSeconds(),
		FileViewerMode:          c.FileViewerMode(),
		FileViewerMaxLines:      c.FileViewerMaxLines(),
		FileViewerMaxBytes:      c.FileViewerMaxBytes(),
		EnabledTools:            c.EnabledTools(),
		SkipDirs:                c.SkipDirs(),
		ClaudeModels:            c.ClaudeModels(),
	}
}

// ── PUT handlers (each returns the full config, like config_api.py) ──────────

func updateProxy(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Proxy     string `json:"proxy"`
		ProxyMode string `json:"proxy_mode"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	mode := strings.TrimSpace(body.ProxyMode)
	if mode == "" {
		mode = config.ProxyModeTapUpstream
	}
	if mode != config.ProxyModeTapUpstream && mode != config.ProxyModeReal {
		writeErr(w, http.StatusBadRequest, "invalid proxy_mode: "+mode)
		return
	}
	if err := d.Cfg.SetProxy(strings.TrimSpace(body.Proxy)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := d.Cfg.SetProxyMode(mode); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
}

func updateWorkspace(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Workspace string `json:"workspace"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := d.Cfg.SetDefaultWorkspace(strings.TrimRight(body.Workspace, "/")); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
}

func updateClaudeBin(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClaudeBin string `json:"claude_bin"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := d.Cfg.SetClaudeBin(strings.TrimSpace(body.ClaudeBin)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
}

// updateStructuredBin saves the claude-structured wrapper path. An empty value
// reverts to the default (next to the server binary). A missing/non-executable
// file is still saved — it just makes the SDK transport unavailable, which the
// response's sdk_available reflects (the requirement: missing file ⇒ mode
// unavailable, not a config error).
func updateStructuredBin(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		StructuredBin string `json:"structured_bin"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := d.Cfg.SetStructuredBin(strings.TrimSpace(body.StructuredBin)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
}

func updateCursorBin(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		CursorBin string `json:"cursor_bin"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := d.Cfg.SetCursorBin(strings.TrimSpace(body.CursorBin)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
}

func updateEnabledTools(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Tools []string `json:"tools"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	valid := map[string]bool{"claude": true, "codex": true, "cursor": true}
	var bad []string
	for _, t := range body.Tools {
		if !valid[t] {
			bad = append(bad, t)
		}
	}
	if len(bad) > 0 {
		writeErr(w, http.StatusBadRequest, "invalid tools: ["+strings.Join(bad, " ")+"]")
		return
	}
	if err := d.Cfg.SetEnabledTools(body.Tools); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
}

func updateClaudeModels(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Models []string `json:"models"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := d.Cfg.SetClaudeModels(body.Models); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
}

func updateFileViewer(d Deps, w http.ResponseWriter, r *http.Request) {
	// Defaults mirror FileViewerRequest field defaults so an omitted field
	// behaves like FastAPI's pydantic defaults.
	body := struct {
		Mode     string `json:"mode"`
		MaxLines int    `json:"max_lines"`
		MaxBytes int    `json:"max_bytes"`
	}{MaxLines: 3000, MaxBytes: 1024 * 1024}
	if !readJSON(w, r, &body) {
		return
	}
	mode := strings.TrimSpace(body.Mode)
	switch mode {
	case "unlimited", "lines", "bytes":
	default:
		writeErr(w, http.StatusBadRequest, "invalid file_viewer mode: "+mode)
		return
	}
	if err := d.Cfg.SetFileViewer(mode, body.MaxLines, body.MaxBytes); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
}

func updateSkipDirs(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		SkipDirs []string `json:"skip_dirs"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := d.Cfg.SetSkipDirs(body.SkipDirs); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
}

func updateTermLifecycle(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		IdleGraceSeconds    int `json:"idle_grace_seconds"`
		StandbyGraceSeconds int `json:"standby_grace_seconds"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	// Mirror TermLifecycleRequest field bounds (idle 10..86400, standby 5..3600).
	if body.IdleGraceSeconds < 10 || body.IdleGraceSeconds > 86400 ||
		body.StandbyGraceSeconds < 5 || body.StandbyGraceSeconds > 3600 {
		writeErr(w, http.StatusUnprocessableEntity, "grace seconds out of range")
		return
	}
	if err := d.Cfg.SetTermIdleGraceSeconds(body.IdleGraceSeconds); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := d.Cfg.SetTermStandbyGraceSeconds(body.StandbyGraceSeconds); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
}

func updateTerminalFont(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Font string `json:"font"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := d.Cfg.SetTerminalFont(strings.TrimSpace(body.Font)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fullConfig(d.Cfg))
}

// restartServer mirrors config_api.restart_server: the Python handler spawns
// `nohup bash restart.sh` in the project root and returns 204. We run restart.sh
// detached the same way; the script is expected to re-exec the server. If the
// script can't be located/started we fall back to a graceful self-exit so an
// external supervisor (systemd) brings the process back. Returns 204 either way,
// matching the Python status_code=204 contract.
func restartServer(_ Deps, w http.ResponseWriter, _ *http.Request) {
	root := projectRoot()
	script := filepath.Join(root, "restart.sh")
	if _, err := os.Stat(script); err == nil {
		cmd := exec.Command("nohup", "bash", "restart.sh")
		cmd.Dir = root
		cmd.Stdout = nil
		cmd.Stderr = nil
		// Detach into its own session so it survives this process exiting.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if startErr := cmd.Start(); startErr != nil {
			slog.Error("config.restart: failed to start restart.sh", "err", startErr)
		} else {
			slog.Info("config.restart: spawned restart.sh", "root", root)
			w.WriteHeader(http.StatusNoContent)
			return
		}
	} else {
		slog.Warn("config.restart: restart.sh not found, falling back to self-exit", "path", script)
	}
	// Fallback: graceful self-exit after the response flushes; a supervisor
	// (systemd Restart=always) is expected to relaunch.
	w.WriteHeader(http.StatusNoContent)
	go func() {
		time.Sleep(300 * time.Millisecond)
		slog.Info("config.restart: exiting for supervisor restart")
		os.Exit(0)
	}()
}

// projectRoot resolves the directory holding restart.sh. The server binary lives
// under the project tree (bin/), so the executable's grandparent is the root;
// fall back to the current working directory.
func projectRoot() string {
	if exe, err := os.Executable(); err == nil {
		// bin/<exe> → project root is the parent of bin/.
		dir := filepath.Dir(exe)
		if filepath.Base(dir) == "bin" {
			return filepath.Dir(dir)
		}
		return dir
	}
	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}
	return "."
}

// ── /api/models ──────────────────────────────────────────────────────────────

type modelInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// claudeModelList builds the Claude model picker from the admin-configured list
// (config.ClaudeModels(), default aliases default/sonnet/haiku/opus). The IDs
// are passed verbatim to `claude --model` / the `/model` command.
func claudeModelList(c *config.Config) []modelInfo {
	ids := c.ClaudeModels()
	out := make([]modelInfo, 0, len(ids))
	for _, id := range ids {
		out = append(out, modelInfo{ID: id, Name: prettyModelName(id)})
	}
	return out
}

// prettyModelName gives the well-known CLI aliases a friendly display label and
// leaves any other id (e.g. a pinned full model name) unchanged.
func prettyModelName(id string) string {
	switch id {
	case "default":
		return "Default"
	case "opus":
		return "Opus"
	case "sonnet":
		return "Sonnet"
	case "haiku":
		return "Haiku"
	case "opusplan":
		return "Opus Plan Mode"
	}
	return id
}

// codexModels mirrors CODEX_MODELS in app/agents/codex.py.
var codexModels = []modelInfo{
	{ID: "gpt-5", Name: "GPT-5"},
	{ID: "gpt-5-codex", Name: "GPT-5 Codex"},
	{ID: "o3", Name: "OpenAI o3"},
	{ID: "o4-mini", Name: "OpenAI o4-mini"},
}

// listModels dispatches by tool name, matching agents.get_adapter().list_models().
// Unknown tools fall back to claude (the historical default).
func listModels(c *config.Config, tool string) []modelInfo {
	switch tool {
	case "codex":
		return codexModels
	case "cursor":
		return fetchCursorModels(c.CursorBin())
	default:
		return claudeModelList(c)
	}
}

// fetchCursorModels mirrors cursor._fetch_cursor_models: parse `agent --list-models`
// lines of the form "<id> - <name>". Returns an empty (non-nil) list on any
// failure so the JSON shape stays [].
func fetchCursorModels(cursorBin string) []modelInfo {
	out := []modelInfo{}
	path, err := exec.LookPath(cursorBin)
	if err != nil {
		return out
	}
	cmd := exec.Command(path, "--list-models")
	var buf bytes.Buffer
	cmd.Stdout = &buf
	if runErr := runWithTimeout(cmd, 10*time.Second); runErr != nil {
		return out
	}
	for _, line := range strings.Split(buf.String(), "\n") {
		line = strings.TrimSpace(line)
		idPart, namePart, found := strings.Cut(line, " - ")
		if !found {
			continue
		}
		id := strings.TrimSpace(idPart)
		name := strings.TrimSpace(namePart)
		if id != "" && name != "" {
			out = append(out, modelInfo{ID: id, Name: name})
		}
	}
	return out
}

func runWithTimeout(cmd *exec.Cmd, d time.Duration) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(d):
		_ = cmd.Process.Kill()
		<-done
		return os.ErrDeadlineExceeded
	}
}

// ── /api/config/fonts ────────────────────────────────────────────────────────

type fontInfo struct {
	Family      string `json:"family"`
	Recommended bool   `json:"recommended"`
}

var recommendedFonts = []string{
	"Ubuntu Sans Mono", "Ubuntu Mono",
	"WenQuanYi Micro Hei Mono", "WenQuanYi Zen Hei Mono",
	"Noto Sans Mono CJK SC", "Noto Sans Mono",
	"JetBrains Mono", "Fira Code", "Cascadia Code",
	"Source Code Pro", "Hack", "Inconsolata",
	"DejaVu Sans Mono", "Liberation Mono", "Courier New",
}

// listSystemFonts mirrors config_api.list_system_fonts: query fc-list for
// monospace families, dedupe, and sort recommended ones first.
func listSystemFonts() []fontInfo {
	rank := map[string]int{}
	for i, f := range recommendedFonts {
		rank[strings.ToLower(f)] = i
	}

	var fonts []string
	cmd := exec.Command("fc-list", ":spacing=mono", "family")
	var buf bytes.Buffer
	cmd.Stdout = &buf
	if err := runWithTimeout(cmd, 5*time.Second); err == nil {
		for _, line := range strings.Split(buf.String(), "\n") {
			for _, part := range strings.Split(line, ",") {
				name := strings.TrimRight(strings.Trim(strings.TrimSpace(part), `"`), ":")
				if name != "" && !strings.HasPrefix(name, ".") {
					fonts = append(fonts, name)
				}
			}
		}
	}

	seen := map[string]struct{}{}
	var unique []string
	for _, f := range fonts {
		key := strings.ToLower(f)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, f)
	}

	sort.SliceStable(unique, func(i, j int) bool {
		ri, ok := rank[strings.ToLower(unique[i])]
		if !ok {
			ri = len(recommendedFonts)
		}
		rj, ok := rank[strings.ToLower(unique[j])]
		if !ok {
			rj = len(recommendedFonts)
		}
		if ri != rj {
			return ri < rj
		}
		return strings.ToLower(unique[i]) < strings.ToLower(unique[j])
	})

	out := make([]fontInfo, 0, len(unique))
	for _, f := range unique {
		_, rec := rank[strings.ToLower(f)]
		out = append(out, fontInfo{Family: f, Recommended: rec})
	}
	return out
}

// binInstalled mirrors shutil.which(): true when the binary resolves on PATH or
// is an executable absolute/relative path.
func binInstalled(bin string) bool {
	if bin == "" {
		return false
	}
	_, err := exec.LookPath(bin)
	return err == nil
}

// ── /api/usage (app/api/usage_api.py) ────────────────────────────────────────

type usageWindow struct {
	Utilization float64 `json:"utilization"`
	ResetsAt    *string `json:"resets_at"`
}

var (
	usageCacheMu sync.Mutex
	usageCache   map[string]usageWindow
	usageCacheTS time.Time
)

const usageCacheTTL = 5 * time.Minute

const (
	usageMessagesURL   = "https://api.anthropic.com/v1/messages"
	usageAnthropicVer  = "2023-06-01"
	usageAnthropicBeta = "oauth-2025-04-20"
	usageProbeModel    = "claude-haiku-4-5-20251001"
)

// usageWindows maps result-key → header abbreviation, mirroring _WINDOWS.
var usageWindows = []struct{ key, abbrev string }{
	{"five_hour", "5h"},
	{"seven_day", "7d"},
}

func getUsage(d Deps, w http.ResponseWriter, _ *http.Request) {
	usageCacheMu.Lock()
	if usageCache != nil && time.Since(usageCacheTS) < usageCacheTTL {
		cached := usageCache
		usageCacheMu.Unlock()
		writeJSON(w, http.StatusOK, cached)
		return
	}
	usageCacheMu.Unlock()

	data, err := fetchRateLimits(d.Cfg.Proxy())
	if err != nil {
		usageCacheMu.Lock()
		stale := usageCache
		usageCacheMu.Unlock()
		if stale != nil {
			writeJSON(w, http.StatusOK, stale) // return stale cache on error
			return
		}
		writeErr(w, http.StatusBadGateway, "Failed to fetch usage: "+err.Error())
		return
	}

	usageCacheMu.Lock()
	usageCache = data
	usageCacheTS = time.Now()
	usageCacheMu.Unlock()
	writeJSON(w, http.StatusOK, data)
}

func anthropicAccessToken() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil {
		return ""
	}
	var creds struct {
		ClaudeAiOauth struct {
			AccessToken string `json:"accessToken"`
		} `json:"claudeAiOauth"`
	}
	if json.Unmarshal(raw, &creds) != nil {
		return ""
	}
	return creds.ClaudeAiOauth.AccessToken
}

// fetchRateLimits mirrors usage_api._fetch_rate_limits: send a 1-token probe
// message and read the anthropic-ratelimit-unified-* response headers. Routes
// through the admin-configured proxy, like Claude processes.
func fetchRateLimits(proxy string) (map[string]usageWindow, error) {
	token := anthropicAccessToken()
	if token == "" {
		return map[string]usageWindow{}, nil
	}

	payload, _ := json.Marshal(map[string]any{
		"model":      usageProbeModel,
		"max_tokens": 1,
		"messages":   []map[string]string{{"role": "user", "content": "."}},
	})

	req, err := http.NewRequest(http.MethodPost, usageMessagesURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", usageAnthropicBeta)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", usageAnthropicVer)

	transport := &http.Transport{}
	if proxy != "" {
		pu, perr := url.Parse(proxy)
		if perr != nil {
			return nil, perr
		}
		transport.Proxy = http.ProxyURL(pu)
	}
	client := &http.Client{Timeout: 15 * time.Second, Transport: transport}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	result := map[string]usageWindow{}
	for _, win := range usageWindows {
		util := resp.Header.Get("anthropic-ratelimit-unified-" + win.abbrev + "-utilization")
		if util == "" {
			continue
		}
		u, perr := strconv.ParseFloat(util, 64)
		if perr != nil {
			continue
		}
		var resetsAt *string
		if rs := resp.Header.Get("anthropic-ratelimit-unified-" + win.abbrev + "-reset"); rs != "" {
			if sec, cerr := strconv.ParseInt(rs, 10, 64); cerr == nil {
				iso := time.Unix(sec, 0).UTC().Format(time.RFC3339)
				resetsAt = &iso
			}
		}
		result[win.key] = usageWindow{Utilization: u, ResetsAt: resetsAt}
	}
	return result, nil
}

// ── /api/fs (app/api/fs.py) ──────────────────────────────────────────────────

// listDirs mirrors fs.list_dirs: immediate subdirectories under a path prefix.
// If path ends with '/', list all subdirs inside; otherwise split into
// parent + partial name and return prefix matches. Max 30, dotfiles excluded.
func listDirs(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		writeJSON(w, http.StatusOK, []string{})
		return
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		writeJSON(w, http.StatusOK, []string{})
		return
	}
	abs = filepath.Clean(abs)

	var parent, prefix string
	if strings.HasSuffix(path, "/") {
		parent = abs
		prefix = ""
	} else {
		parent = filepath.Dir(abs)
		prefix = strings.ToLower(filepath.Base(abs))
	}

	info, err := os.Stat(parent)
	if err != nil || !info.IsDir() {
		writeJSON(w, http.StatusOK, []string{})
		return
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		writeJSON(w, http.StatusOK, []string{})
		return
	}
	var dirs []string
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if prefix != "" && !strings.HasPrefix(strings.ToLower(e.Name()), prefix) {
			continue
		}
		dirs = append(dirs, filepath.Join(parent, e.Name()))
	}
	sort.Strings(dirs)
	if len(dirs) > 30 {
		dirs = dirs[:30]
	}
	if dirs == nil {
		dirs = []string{}
	}
	writeJSON(w, http.StatusOK, dirs)
}

const initArchiveMaxSize = 100 * 1024 * 1024 // INIT_ARCHIVE_MAX_SIZE — 100 MB

// fsExtractToSuffixes mirrors fs._ARCHIVE_SUFFIXES (the accepted upload formats).
var fsExtractToSuffixes = []string{
	".zip", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz",
	".tar", ".gz", ".bz2", ".xz",
}

// extractToDir mirrors fs.extract_to_dir: upload an archive (multipart fields
// `target_dir` + `file`) and extract it into target_dir, which must not already
// exist. A single top-level directory in the archive is stripped so its contents
// land directly in target_dir.
func extractToDir(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(initArchiveMaxSize + 1<<20); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	targetDir := strings.TrimSpace(r.FormValue("target_dir"))
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file required")
		return
	}
	defer file.Close()
	if hdr.Filename == "" {
		writeErr(w, http.StatusBadRequest, "filename required")
		return
	}
	fname := strings.ToLower(hdr.Filename)
	supported := false
	for _, s := range fsExtractToSuffixes {
		if strings.HasSuffix(fname, s) {
			supported = true
			break
		}
	}
	if !supported {
		writeErr(w, http.StatusUnsupportedMediaType, "unsupported archive format")
		return
	}

	content, err := io.ReadAll(io.LimitReader(file, initArchiveMaxSize+1))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(content) > initArchiveMaxSize {
		writeErr(w, http.StatusRequestEntityTooLarge,
			"archive too large ("+strconv.Itoa(len(content)/1024/1024)+"MB > "+
				strconv.Itoa(initArchiveMaxSize/1024/1024)+"MB limit)")
		return
	}

	if targetDir == "" {
		writeErr(w, http.StatusBadRequest, "target_dir required")
		return
	}
	target := filepath.Clean(targetDir)
	if _, statErr := os.Stat(target); statErr == nil {
		writeErr(w, http.StatusConflict, "target directory already exists")
		return
	}

	if err := safeExtractTo(content, hdr.Filename, target); err != nil {
		_ = os.RemoveAll(target)
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": target})
}

// safeExtractTo mirrors fs._safe_extract: extract archive bytes into dest,
// stripping a single common top-level directory prefix when present. Members
// with absolute paths or ".." components are skipped (path-traversal guard).
func safeExtractTo(data []byte, filename, dest string) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	n := strings.ToLower(filename)
	switch {
	case strings.HasSuffix(n, ".zip"):
		return extractToZip(data, dest)
	case strings.HasSuffix(n, ".tar.gz"), strings.HasSuffix(n, ".tgz"),
		strings.HasSuffix(n, ".tar.bz2"), strings.HasSuffix(n, ".tbz2"),
		strings.HasSuffix(n, ".tar.xz"), strings.HasSuffix(n, ".txz"),
		strings.HasSuffix(n, ".tar"):
		return extractToTar(data, n, dest)
	case strings.HasSuffix(n, ".gz"):
		return extractToSingle(data, filepath.Join(dest, filename[:len(filename)-3]),
			func(rd io.Reader) (io.Reader, error) { return gzip.NewReader(rd) })
	case strings.HasSuffix(n, ".bz2"):
		return extractToSingle(data, filepath.Join(dest, filename[:len(filename)-4]),
			func(rd io.Reader) (io.Reader, error) { return bzip2.NewReader(rd), nil })
	case strings.HasSuffix(n, ".xz"):
		return errUnsupportedXZ
	default:
		return &extractError{"unsupported archive: " + filename}
	}
}

type extractError struct{ msg string }

func (e *extractError) Error() string { return e.msg }

var errUnsupportedXZ = &extractError{"xz-compressed archives are not supported"}

// safeMember rejects absolute paths and traversal, and confirms the resolved
// path stays under dest (defense-in-depth beyond the "." check).
func safeMember(dest, name string) (string, bool) {
	if name == "" || filepath.IsAbs(name) || strings.Contains(name, "..") {
		return "", false
	}
	out := filepath.Join(dest, name)
	if out != dest && !strings.HasPrefix(out, dest+string(os.PathSeparator)) {
		return "", false
	}
	return out, true
}

func extractToZip(data []byte, dest string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	names := make([]string, 0, len(zr.File))
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	prefix := singleTopPrefix(names)
	for _, f := range zr.File {
		mname := f.Name
		if prefix != "" {
			if mname == strings.TrimSuffix(prefix, "/") || mname == prefix {
				continue
			}
			if !strings.HasPrefix(mname, prefix) {
				continue
			}
			mname = mname[len(prefix):]
		}
		out, ok := safeMember(dest, mname)
		if !ok {
			continue
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.Create(out)
		if err != nil {
			rc.Close()
			return err
		}
		if _, err := io.Copy(w, rc); err != nil {
			w.Close()
			rc.Close()
			return err
		}
		w.Close()
		rc.Close()
	}
	return nil
}

func extractToTar(data []byte, lowerName, dest string) error {
	var src io.Reader = bytes.NewReader(data)
	switch {
	case strings.HasSuffix(lowerName, ".tar.gz"), strings.HasSuffix(lowerName, ".tgz"):
		gz, err := gzip.NewReader(src)
		if err != nil {
			return err
		}
		defer gz.Close()
		src = gz
	case strings.HasSuffix(lowerName, ".tar.bz2"), strings.HasSuffix(lowerName, ".tbz2"):
		src = bzip2.NewReader(src)
	case strings.HasSuffix(lowerName, ".tar.xz"), strings.HasSuffix(lowerName, ".txz"):
		return errUnsupportedXZ
	}

	// First pass: collect member names that pass the traversal filter so we can
	// compute the single-top-level-dir prefix (matches the Python two-step).
	tr := tar.NewReader(src)
	var members []*tar.Header
	var raw [][]byte
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if filepath.IsAbs(hdr.Name) || strings.Contains(hdr.Name, "..") {
			continue
		}
		members = append(members, hdr)
		if hdr.Typeflag == tar.TypeReg || hdr.Typeflag == tar.TypeRegA {
			b, err := io.ReadAll(tr)
			if err != nil {
				return err
			}
			raw = append(raw, b)
		} else {
			raw = append(raw, nil)
		}
	}
	names := make([]string, len(members))
	for i, m := range members {
		names[i] = m.Name
	}
	prefix := singleTopPrefix(names)

	for i, m := range members {
		mname := m.Name
		if prefix != "" {
			if mname == strings.TrimSuffix(prefix, "/") || !strings.HasPrefix(mname, prefix) {
				continue
			}
			mname = mname[len(prefix):]
		}
		out, ok := safeMember(dest, mname)
		if !ok {
			continue
		}
		switch m.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(out, raw[i], 0o644); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				return err
			}
			_ = os.Symlink(m.Linkname, out)
		}
	}
	return nil
}

func extractToSingle(data []byte, outPath string, wrap func(io.Reader) (io.Reader, error)) error {
	rd, err := wrap(bytes.NewReader(data))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return err
	}
	w, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer w.Close()
	_, err = io.Copy(w, rd)
	return err
}

// singleTopPrefix mirrors fs._zip_strip_prefix / _tar_strip_prefix: returns
// "<top>/" when every entry shares a single top-level directory, else "".
func singleTopPrefix(names []string) string {
	tops := map[string]struct{}{}
	for _, n := range names {
		if n == "" {
			continue
		}
		top := n
		if idx := strings.IndexByte(n, '/'); idx >= 0 {
			top = n[:idx]
		}
		tops[top] = struct{}{}
	}
	if len(tops) != 1 {
		return ""
	}
	var top string
	for t := range tops {
		top = t
	}
	prefix := top + "/"
	for _, n := range names {
		if n == "" {
			continue
		}
		if n != top && !strings.HasPrefix(n, prefix) {
			return ""
		}
	}
	return prefix
}
