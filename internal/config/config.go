// Package config mirrors the Python backend's two-layer configuration:
//
//   - Process/env settings (ROOT_PATH, host/port, FRONTEND_DIST) read from the
//     environment, matching the existing CLAUDEMANAGER_* / ROOT_PATH conventions
//     so deployments (nginx, systemd) need no changes.
//   - Mutable runtime settings (proxy, default_workspace, jwt_secret, …) stored
//     in the `configs` key/value table in data.db, identical to app/config.py.
package config

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// Defaults that match app/config.py and claudemanager_cli.py.
const (
	DefaultPort = 19099
	DefaultHost = "0.0.0.0"
)

// Env holds process-level configuration sourced from environment variables.
// Resolved once at startup; switching modes is done via env, same binary.
type Env struct {
	Host string
	Port int
	// RootPath is the public sub-path prefix (ROOT_PATH), e.g. "/rosaccm".
	// Empty for root-mounted deployments. Trailing slash stripped.
	RootPath string
	// FrontendDist, when set and pointing at a real directory, makes the server
	// serve the SPA from disk instead of the embedded bundle (dev / hot rebuild).
	FrontendDist string
	// DataDir is CLAUDEMANAGER_DATA_DIR (may be empty → dev ./data layout).
	DataDir string
}

// LoadEnv reads the process environment into an Env.
func LoadEnv() Env {
	port := DefaultPort
	if v := os.Getenv("PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			port = n
		}
	}
	host := DefaultHost
	if v := os.Getenv("HOST"); v != "" {
		host = v
	}
	return Env{
		Host:         host,
		Port:         port,
		RootPath:     strings.TrimRight(os.Getenv("ROOT_PATH"), "/"),
		FrontendDist: os.Getenv("FRONTEND_DIST"),
		DataDir:      os.Getenv("CLAUDEMANAGER_DATA_DIR"),
	}
}

// PublicPath prepends RootPath to an absolute app path (mirrors
// url_prefix.public_path). Returns path unchanged when RootPath is empty.
func (e Env) PublicPath(path string) string {
	if e.RootPath == "" {
		return path
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return e.RootPath + path
}

// ---- Runtime config stored in the `configs` table -------------------------

// Config provides typed access to the configs key/value table.
type Config struct {
	db *sql.DB
	mu sync.Mutex
}

// New wraps a database handle for config access.
func New(db *sql.DB) *Config { return &Config{db: db} }

func (c *Config) get(key, def string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var v string
	err := c.db.QueryRow(`SELECT value FROM configs WHERE key = ?`, key).Scan(&v)
	if err != nil {
		return def
	}
	return v
}

func (c *Config) set(key, value string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.db.Exec(
		`INSERT OR REPLACE INTO configs (key, value) VALUES (?, ?)`, key, value,
	)
	return err
}

// Proxy returns the configured outbound proxy URL ("" if unset).
func (c *Config) Proxy() string { return c.get("proxy", "") }

// SetProxy persists the outbound proxy URL.
func (c *Config) SetProxy(v string) error { return c.set("proxy", v) }

// Proxy mode constants (mirror config.PROXY_MODE_*).
const (
	ProxyModeTapUpstream = "tap_upstream"
	ProxyModeReal        = "real"
)

// ProxyMode returns the proxy mode (default tap_upstream).
func (c *Config) ProxyMode() string {
	v := c.get("proxy_mode", ProxyModeTapUpstream)
	if v != ProxyModeTapUpstream && v != ProxyModeReal {
		return ProxyModeTapUpstream
	}
	return v
}

// SetProxyMode persists the proxy mode (mirrors config.set_proxy_mode), rejecting
// unknown values with an error.
func (c *Config) SetProxyMode(v string) error {
	if v != ProxyModeTapUpstream && v != ProxyModeReal {
		return fmt.Errorf("proxy_mode must be one of [%s %s]", ProxyModeTapUpstream, ProxyModeReal)
	}
	return c.set("proxy_mode", v)
}

// ProxyEnv returns the proxy as an env-var map for subprocess injection
// (mirrors config.get_proxy_env).
func (c *Config) ProxyEnv() map[string]string {
	p := c.Proxy()
	if p == "" {
		return map[string]string{}
	}
	return map[string]string{
		"http_proxy": p, "HTTP_PROXY": p,
		"https_proxy": p, "HTTPS_PROXY": p,
	}
}

// ClaudeShell returns the configured login shell for claude sessions ("" default).
func (c *Config) ClaudeShell() string { return c.get("claude_shell", "") }

// SkipDirs returns the directory-name blacklist (default node_modules/venv/.venv).
func (c *Config) SkipDirs() []string {
	raw := c.get("skip_dirs", "")
	def := []string{"node_modules", "venv", ".venv"}
	if raw == "" {
		return def
	}
	var vals []string
	if err := json.Unmarshal([]byte(raw), &vals); err != nil {
		return def
	}
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// SetSkipDirs persists the directory-name blacklist (mirrors set_skip_dirs):
// entries are bare names matched anywhere in the tree, so any value containing a
// path separator or a traversal component is rejected; duplicates are dropped.
// An empty list is allowed (disables the blacklist entirely).
func (c *Config) SetSkipDirs(dirs []string) error {
	cleaned := make([]string, 0, len(dirs))
	seen := map[string]struct{}{}
	for _, d := range dirs {
		name := strings.TrimSpace(d)
		if name == "" || name == "." || name == ".." ||
			strings.Contains(name, "/") || strings.Contains(name, "\\") {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		cleaned = append(cleaned, name)
	}
	b, err := json.Marshal(cleaned)
	if err != nil {
		return err
	}
	return c.set("skip_dirs", string(b))
}

// File-viewer truncation settings (mirror config.get_file_viewer_*).
func (c *Config) FileViewerMode() string {
	v := c.get("file_viewer_mode", "lines")
	switch v {
	case "unlimited", "lines", "bytes":
		return v
	default:
		return "lines"
	}
}

func (c *Config) FileViewerMaxLines() int {
	if n, err := strconv.Atoi(c.get("file_viewer_max_lines", "")); err == nil && n >= 100 {
		return n
	}
	return 3000
}

func (c *Config) FileViewerMaxBytes() int {
	if n, err := strconv.Atoi(c.get("file_viewer_max_bytes", "")); err == nil && n >= 4096 {
		return n
	}
	return 1024 * 1024
}

// SetFileViewerMode persists the file-viewer truncation mode (mirrors
// set_file_viewer_mode): unknown values fall back to "lines".
func (c *Config) SetFileViewerMode(v string) error {
	switch v {
	case "unlimited", "lines", "bytes":
	default:
		v = "lines"
	}
	return c.set("file_viewer_mode", v)
}

// SetFileViewerMaxLines persists the max-lines cap, clamped to a 100 floor
// (mirrors set_file_viewer_max_lines).
func (c *Config) SetFileViewerMaxLines(n int) error {
	if n < 100 {
		n = 100
	}
	return c.set("file_viewer_max_lines", strconv.Itoa(n))
}

// SetFileViewerMaxBytes persists the max-bytes cap, clamped to a 4096 floor
// (mirrors set_file_viewer_max_bytes).
func (c *Config) SetFileViewerMaxBytes(n int) error {
	if n < 4096 {
		n = 4096
	}
	return c.set("file_viewer_max_bytes", strconv.Itoa(n))
}

// SetFileViewer persists all three file-viewer settings together, matching the
// PUT /api/config/file-viewer handler in config_api.py (mode validated first).
func (c *Config) SetFileViewer(mode string, maxLines, maxBytes int) error {
	if err := c.SetFileViewerMode(mode); err != nil {
		return err
	}
	if err := c.SetFileViewerMaxLines(maxLines); err != nil {
		return err
	}
	return c.SetFileViewerMaxBytes(maxBytes)
}

// DefaultTerminalFont mirrors config._DEFAULT_TERMINAL_FONT.
const DefaultTerminalFont = `"Ubuntu Sans Mono", "WenQuanYi Micro Hei Mono", "WenQuanYi Zen Hei Mono", monospace`

// TerminalFont returns the configured terminal font-family CSS string.
func (c *Config) TerminalFont() string { return c.get("terminal_font", DefaultTerminalFont) }

// SetTerminalFont persists the terminal font-family CSS string.
func (c *Config) SetTerminalFont(v string) error { return c.set("terminal_font", v) }

// Bash terminal lifecycle tuning (mirror config._DEFAULT_TERM_*_GRACE_S).
const (
	DefaultTermIdleGraceSeconds    = 600
	DefaultTermStandbyGraceSeconds = 30
)

// TermIdleGraceSeconds returns how long an ephemeral terminal sits idle (no
// holder) before standby, clamped to a 10s floor (mirrors get_term_idle_grace_seconds).
func (c *Config) TermIdleGraceSeconds() int {
	n, err := strconv.Atoi(c.get("term_idle_grace_seconds", ""))
	if err != nil {
		n = DefaultTermIdleGraceSeconds
	}
	if n < 10 {
		n = 10
	}
	return n
}

// SetTermIdleGraceSeconds persists the idle grace, clamped to a 10s floor.
func (c *Config) SetTermIdleGraceSeconds(n int) error {
	if n < 10 {
		n = 10
	}
	return c.set("term_idle_grace_seconds", strconv.Itoa(n))
}

// TermStandbyGraceSeconds returns the grace after standby before tmux kill,
// clamped to a 5s floor (mirrors get_term_standby_grace_seconds).
func (c *Config) TermStandbyGraceSeconds() int {
	n, err := strconv.Atoi(c.get("term_standby_grace_seconds", ""))
	if err != nil {
		n = DefaultTermStandbyGraceSeconds
	}
	if n < 5 {
		n = 5
	}
	return n
}

// SetTermStandbyGraceSeconds persists the standby grace, clamped to a 5s floor.
func (c *Config) SetTermStandbyGraceSeconds(n int) error {
	if n < 5 {
		n = 5
	}
	return c.set("term_standby_grace_seconds", strconv.Itoa(n))
}

// DefaultWorkspace returns the workspace root, defaulting to ~/Projs and
// persisting that default on first read (matches Python behavior).
func (c *Config) DefaultWorkspace() string {
	v := c.get("default_workspace", "")
	if v == "" {
		home, _ := os.UserHomeDir()
		v = home + "/Projs"
		_ = c.set("default_workspace", v)
	}
	_ = os.MkdirAll(v, 0o755)
	return v
}

// SetDefaultWorkspace persists the workspace root (mirrors set_default_workspace;
// the API layer is responsible for trailing-slash trimming, matching Python).
func (c *Config) SetDefaultWorkspace(v string) error { return c.set("default_workspace", v) }

// JWTSecret returns the persisted JWT signing secret, generating a 32-byte
// hex secret on first use (matches Python config.get_jwt_secret).
func (c *Config) JWTSecret() string {
	v := c.get("jwt_secret", "")
	if v == "" {
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		v = hex.EncodeToString(b)
		_ = c.set("jwt_secret", v)
	}
	return v
}

// ClaudeBin returns the configured claude binary path, defaulting to
// ~/.local/bin/claude.
func (c *Config) ClaudeBin() string {
	v := c.get("claude_bin", "")
	if v == "" {
		home, _ := os.UserHomeDir()
		v = home + "/.local/bin/claude"
	}
	return v
}

// SetClaudeBin persists the claude binary path (mirrors set_claude_bin).
func (c *Config) SetClaudeBin(v string) error { return c.set("claude_bin", v) }

// StructuredBin returns the admin-configured claude-structured wrapper path
// ("" = unset, fall back to the default next to the server binary). Used by
// the SDK session transport.
func (c *Config) StructuredBin() string { return c.get("structured_bin", "") }

// SetStructuredBin persists the claude-structured wrapper path ("" reverts to
// the default).
func (c *Config) SetStructuredBin(v string) error { return c.set("structured_bin", v) }

// StructuredBinResolved resolves the wrapper path actually used: the
// configured value when set, else "claude-structured" in the same directory
// as the running server binary (scripts/build-structured.sh installs it there).
func (c *Config) StructuredBinResolved() string {
	if v := c.StructuredBin(); v != "" {
		return v
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(exe), "claude-structured")
}

// SDKAvailable reports whether the SDK session transport can spawn sessions:
// the resolved wrapper path must exist, be a regular file, and be executable.
// When false, session creation with transport=sdk is rejected and the UI
// disables the option.
func (c *Config) SDKAvailable() bool {
	p := c.StructuredBinResolved()
	if p == "" {
		return false
	}
	fi, err := os.Stat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}
	return fi.Mode().Perm()&0o111 != 0
}

// CursorBin returns the configured cursor/agent binary (default "agent").
func (c *Config) CursorBin() string { return c.get("cursor_bin", "agent") }

// SetCursorBin persists the cursor/agent binary path (mirrors set_cursor_bin).
func (c *Config) SetCursorBin(v string) error { return c.set("cursor_bin", v) }

var defaultEnabledTools = []string{"claude"}

var validTools = map[string]bool{"claude": true, "codex": true, "cursor": true}

// EnabledTools returns the admin allow-list of coding tools (default ["claude"]).
func (c *Config) EnabledTools() []string {
	raw := c.get("enabled_tools", "")
	if raw == "" {
		return append([]string(nil), defaultEnabledTools...)
	}
	var vals []string
	if err := json.Unmarshal([]byte(raw), &vals); err != nil {
		return append([]string(nil), defaultEnabledTools...)
	}
	out := vals[:0]
	for _, v := range vals {
		if validTools[v] {
			out = append(out, v)
		}
	}
	if len(out) == 0 {
		return append([]string(nil), defaultEnabledTools...)
	}
	return out
}

// SetEnabledTools persists the admin tool allow-list (mirrors set_enabled_tools):
// invalid entries are dropped and an empty result falls back to the default.
func (c *Config) SetEnabledTools(tools []string) error {
	cleaned := make([]string, 0, len(tools))
	for _, t := range tools {
		if validTools[t] {
			cleaned = append(cleaned, t)
		}
	}
	if len(cleaned) == 0 {
		cleaned = append([]string(nil), defaultEnabledTools...)
	}
	b, err := json.Marshal(cleaned)
	if err != nil {
		return err
	}
	return c.set("enabled_tools", string(b))
}

// defaultClaudeModels is the built-in Claude model picker list. They are CLI
// aliases (accepted by both `claude --model <x>` and the `/model` command) that
// always resolve to the latest model of each tier, so the default never goes
// stale when Anthropic ships a new version. Admins can override this list.
var defaultClaudeModels = []string{"default", "sonnet", "haiku", "opus"}

// ClaudeModels returns the admin-configured Claude model picker list, falling
// back to defaultClaudeModels when unset, empty, or unparseable.
func (c *Config) ClaudeModels() []string {
	raw := c.get("claude_models", "")
	if raw == "" {
		return append([]string(nil), defaultClaudeModels...)
	}
	var vals []string
	if err := json.Unmarshal([]byte(raw), &vals); err != nil {
		return append([]string(nil), defaultClaudeModels...)
	}
	out := cleanModelList(vals)
	if len(out) == 0 {
		return append([]string(nil), defaultClaudeModels...)
	}
	return out
}

// SetClaudeModels persists the admin Claude model list. Entries are trimmed and
// de-duplicated; an empty result falls back to the default.
func (c *Config) SetClaudeModels(models []string) error {
	cleaned := cleanModelList(models)
	if len(cleaned) == 0 {
		cleaned = append([]string(nil), defaultClaudeModels...)
	}
	b, err := json.Marshal(cleaned)
	if err != nil {
		return err
	}
	return c.set("claude_models", string(b))
}

// cleanModelList trims, drops empties, and de-duplicates (preserving order).
func cleanModelList(vals []string) []string {
	out := make([]string, 0, len(vals))
	seen := make(map[string]bool, len(vals))
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// GoogleClientID returns the OAuth client id (config table, falling back to the
// GOOGLE_CLIENT_ID env var).
func (c *Config) GoogleClientID() string {
	return c.get("google_client_id", os.Getenv("GOOGLE_CLIENT_ID"))
}

// DefaultAdmin returns the seed admin (username, password). Mirrors
// config.get_default_admin (default {"admin","admin123"}); stored as JSON.
func (c *Config) DefaultAdmin() (string, string) {
	raw := c.get("default_admin", "")
	username, password := "admin", "admin123"
	if raw != "" {
		var m struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := json.Unmarshal([]byte(raw), &m); err == nil {
			if m.Username != "" {
				username = m.Username
			}
			if m.Password != "" {
				password = m.Password
			}
		}
	}
	return username, password
}
