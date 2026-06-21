// Package tmux is a Go port of the Python TmuxService
// (ClaudeManager/app/services/tmux_service.py).
//
// It provides a thin wrapper over the tmux CLI with a strict command surface:
// creating detached sessions running an agent CLI (claude/cursor/codex),
// attaching to them via a PTY for raw terminal I/O, capturing pane content,
// resolving agent session ids, and copy-mode scroll/search helpers.
//
// Backend design: the current implementation is exec-based — every tmux
// operation shells out to the `tmux` binary via os/exec, faithfully mirroring
// the Python `subprocess.run(["tmux", "-L", socket, ...])` behavior. This is
// the correctness-first backend. The public Client type is intentionally
// shaped so a future tmux control-mode backend (a single long-lived
// `tmux -CC` process multiplexing commands over one pipe) can replace the
// internals of (*Client).run without changing any caller-facing method.
// Control mode is the planned optimization; it is not implemented yet.
package tmux

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// TrustDialogPatterns are substrings that uniquely identify Claude CLI's
// workspace-trust dialog. Multiple candidates are kept for version-drift
// tolerance — any one match is enough. (Port of _TRUST_DIALOG_PATTERNS.)
var TrustDialogPatterns = []string{
	"Yes, I trust this folder",
	"Accessing workspace",
}

// looksLikeTrustDialog reports whether the captured screen contains the
// Claude workspace-trust dialog. (Port of _looks_like_trust_dialog.)
func looksLikeTrustDialog(screen string) bool {
	if screen == "" {
		return false
	}
	for _, p := range TrustDialogPatterns {
		if strings.Contains(screen, p) {
			return true
		}
	}
	return false
}

// Proxy mode constants (port of app/config.py).
const (
	ProxyModeTapUpstream = "tap_upstream"
	ProxyModeReal        = "real"
)

// ErrTmux is the sentinel returned when a tmux command fails. Errors wrapping
// it carry the quoted command and tmux's stderr in their message. (Port of the
// Python TmuxError.)
var ErrTmux = errors.New("tmux failed")

// Client is a thin tmux wrapper with a strict command surface. The zero value
// is not usable; construct one with New.
//
// All configuration that the Python service hot-reloaded on each create/resume
// (claude_bin, cursor_bin, claude_shell) and the proxy state (get_proxy_env,
// get_proxy_mode) are modeled as function fields so the caller can supply
// live-reloading closures, matching the Python getters.
type Client struct {
	// SocketName is the tmux server socket (the `-L <socket>` arg).
	SocketName string
	// TmuxBin is the tmux binary path. Defaults to $TMUX_BIN or "tmux".
	TmuxBin string
	// AnthropicProxyPort is the local Anthropic tap proxy port (0 = disabled).
	AnthropicProxyPort int

	// ClaudeBin returns the configured claude binary (default "claude").
	ClaudeBin func() string
	// CursorBin returns the configured cursor `agent` binary (default "agent").
	CursorBin func() string
	// ClaudeShell returns an optional wrapper shell for claude (default "").
	ClaudeShell func() string
	// ProxyEnv returns proxy vars to inject (port of config.get_proxy_env).
	ProxyEnv func() map[string]string
	// ProxyMode returns the current proxy mode (port of config.get_proxy_mode).
	ProxyMode func() string
}

// New constructs a Client with sensible defaults matching the Python
// TmuxService.__init__ defaults. The socket name defaults to "claude-web".
// It also issues a best-effort `set-option -g window-size latest` like the
// Python constructor (ignoring failure when the server is not yet started).
func New(socketName string) *Client {
	if socketName == "" {
		socketName = "claude-web"
	}
	tmuxBin := os.Getenv("TMUX_BIN")
	if tmuxBin == "" {
		tmuxBin = "tmux"
	}
	c := &Client{
		SocketName:  socketName,
		TmuxBin:     tmuxBin,
		ClaudeBin:   func() string { return "claude" },
		CursorBin:   func() string { return "agent" },
		ClaudeShell: func() string { return "" },
		ProxyEnv:    func() map[string]string { return nil },
		ProxyMode:   func() string { return ProxyModeTapUpstream },
	}
	// Ensure the tmux server uses latest-client window sizing. Ignore failure
	// (server may not be started yet) — same as the Python constructor.
	_, _ = c.run("set-option", "-g", "window-size", "latest")
	return c
}

// run executes `tmux -L <socket> <args...>` and returns trimmed stdout.
// On non-zero exit it returns an error wrapping ErrTmux with the quoted
// command and tmux's stderr. (Port of TmuxService._run.)
//
// This is the single chokepoint a future control-mode backend would replace.
// DeliverToPane pastes text into a tmux pane and optionally submits it
// (port of chat_delivery.deliver_to_pane). set-buffer + paste-buffer (-p
// bracketed paste, -r to skip LF→CR translation) keeps a multi-line prompt as
// one input; an explicit send-keys Enter submits it. A prompt containing "@"
// needs a second Enter.
func (c *Client) DeliverToPane(paneTarget, text string, sendEnter bool) error {
	bufName := fmt.Sprintf("cm-%d", time.Now().UnixMilli())
	if text != "" {
		if _, err := c.run("set-buffer", "-b", bufName, "--", text); err != nil {
			return err
		}
		if _, err := c.run("paste-buffer", "-d", "-p", "-r", "-b", bufName, "-t", paneTarget); err != nil {
			return err
		}
	}
	if sendEnter {
		needsDouble := strings.Contains(text, "@")
		if text != "" {
			time.Sleep(100 * time.Millisecond)
		}
		if _, err := c.run("send-keys", "-t", paneTarget, "Enter"); err != nil {
			return err
		}
		if needsDouble {
			time.Sleep(100 * time.Millisecond)
			_, _ = c.run("send-keys", "-t", paneTarget, "Enter")
		}
	}
	return nil
}

// Run executes an arbitrary tmux command on this client's socket and returns
// its stdout. Exposed for callers (e.g. the terminal WebSocket) that need
// commands not wrapped by a dedicated method — copy-mode, refresh-client,
// send-keys -X, resize-window, etc. (mirrors the Python tmux._run usage).
func (c *Client) Run(args ...string) (string, error) { return c.run(args...) }

func (c *Client) run(args ...string) (string, error) {
	full := append([]string{c.TmuxBin, "-L", c.SocketName}, args...)
	cmd := exec.Command(full[0], full[1:]...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%w: %s (%s)", ErrTmux,
			shellQuoteJoin(full), strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(stdout.String()), nil
}

// RunTimeout is Run with a hard deadline: the tmux process is killed if it
// hasn't finished within timeout. Plain Run has no bound, so a wedged tmux
// server would hang the caller (and leak its goroutine) forever — this variant
// is for fire-and-forget control commands (resize-window, refresh-client) whose
// result the caller does not block on. Returns context.DeadlineExceeded on kill.
func (c *Client) RunTimeout(timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	full := append([]string{c.TmuxBin, "-L", c.SocketName}, args...)
	cmd := exec.CommandContext(ctx, full[0], full[1:]...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("%w: %s timed out: %v", ErrTmux, shellQuoteJoin(full), ctx.Err())
		}
		return "", fmt.Errorf("%w: %s (%s)", ErrTmux,
			shellQuoteJoin(full), strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(stdout.String()), nil
}

// buildEnvPrefix builds a shell `env K=V K=V ` prefix to inject vars at exec
// time. (Port of _build_env_prefix.)
//
// Preferred over `tmux new-session -e ...`: tmux's -e writes into the new
// session's env on top of the server's long-lived global env, which can leak
// stale variables (e.g. a previously-captured ANTHROPIC_BASE_URL) into every
// new-session forever. Injecting via the env(1) binary at exec time bypasses
// tmux's environment machinery entirely.
func (c *Client) buildEnvPrefix(env map[string]string) string {
	merged := map[string]string{}
	for k, v := range c.proxyEnv() {
		merged[k] = v
	}
	for k, v := range env {
		merged[k] = v
	}
	// Always forward the current process PATH so the tmux session can find
	// binaries installed via nvm/pyenv/etc even when the server was started
	// without a login shell (common in WSL).
	if _, ok := merged["PATH"]; !ok {
		merged["PATH"] = os.Getenv("PATH")
	}
	// If claude_bin is an absolute path, prepend its directory to PATH.
	claudeBin := c.claudeBin()
	if filepath.IsAbs(claudeBin) {
		binDir := filepath.Dir(claudeBin)
		if !pathContains(merged["PATH"], binDir) {
			if merged["PATH"] == "" {
				merged["PATH"] = binDir
			} else {
				merged["PATH"] = binDir + string(os.PathListSeparator) + merged["PATH"]
			}
		}
	}
	parts := []string{"env"}
	// Iterate deterministically (Go map order is random) so the produced
	// command is stable and testable. The Python dict preserved insertion
	// order; here we sort keys, which is behaviorally equivalent for env(1).
	for _, k := range sortedKeys(merged) {
		v := merged[k]
		if v != "" { // skip empty values — empty proxy strings confuse some tools
			parts = append(parts, shellQuote(k+"="+v))
		}
	}
	return strings.Join(parts, " ") + " "
}

// CreateSession creates a detached tmux session running the given agent tool.
// (Port of create_session.)
//
// tool is one of "claude", "cursor", "codex"; unknown values fall back to
// claude semantics. For claude, a background goroutine auto-accepts the
// workspace-trust dialog (port of the daemon thread).
func (c *Client) CreateSession(sessionName, cwd string, env map[string]string,
	claudeModel, resumeSessionID, innerID, tool string) error {

	if tool == "" {
		tool = "claude"
	}

	// Adapters that need the Anthropic API tap (Claude) get BASE_URL + NO_PROXY
	// injected, but only when proxy_mode == tap_upstream and a tap port is set.
	tapActive := needsProxyTap(tool) && c.AnthropicProxyPort != 0 &&
		c.proxyMode() == ProxyModeTapUpstream
	if tapActive {
		tapURL := fmt.Sprintf("http://127.0.0.1:%d", c.AnthropicProxyPort)
		existingNo := env["NO_PROXY"]
		if existingNo == "" {
			existingNo = env["no_proxy"]
		}
		noProxy := joinNonEmpty([]string{existingNo, "127.0.0.1", "localhost"}, ",")
		merged := map[string]string{}
		for k, v := range env {
			merged[k] = v
		}
		if merged["ANTHROPIC_BASE_URL"] == "" {
			merged["ANTHROPIC_BASE_URL"] = tapURL
		}
		merged["NO_PROXY"] = noProxy
		merged["no_proxy"] = noProxy
		env = merged
	}

	envPrefix := c.buildEnvPrefix(env)
	command := c.buildCommand(tool, cwd, env, claudeModel, resumeSessionID, innerID)

	// Prefix `env K=V ...` so the spawned process gets exactly the env we
	// specify, bypassing the tmux server's (potentially stale) global env.
	command = envPrefix + command

	if _, err := c.run("new-session", "-d", "-s", sessionName, "-c", cwd, command); err != nil {
		return err
	}
	// Best-effort session options; ignore failure like the Python try/except.
	_, _ = c.run("set-option", "-t", sessionName, "mouse", "off")
	_, _ = c.run("set-option", "-t", sessionName, "history-limit", "50000")
	_, _ = c.run("set-option", "-t", sessionName, "mode-keys", "vi")

	if tool == "claude" {
		go c.autoAcceptTrustDialog(sessionName, 8*time.Second)
	}
	return nil
}

// CreateSDKSession creates a detached tmux session running the claude-structured
// wrapper (SDK transport). The wrapper's Ink TUI lives in the pane (restart
// survival + xterm attach work exactly like tmux-transport sessions) while the
// Go server drives it over --json-in/--json-out NDJSON.
//
// Differences from CreateSession on purpose:
//   - No Anthropic tap proxy: streaming preview comes from json-out partial
//     events, so ANTHROPIC_BASE_URL is never injected — and explicitly unset
//     (env -u) in case the tmux server's global env captured a stale tap URL.
//     General outbound proxy vars (ProxyEnv) still apply via buildEnvPrefix.
//   - No --claude-path / CLAUDE_CLI_PATH: the compiled wrapper resolves its
//     sibling `claude` binary (installed next to it by build-structured.sh),
//     which is version-matched with its embedded agent SDK.
//   - No trust-dialog auto-accepter and no inner-id pid file: the SDK flow has
//     no workspace-trust TUI dialog, and agent_session_id comes from the
//     wrapper's session_start event instead of JSONL scanning.
func (c *Client) CreateSDKSession(sessionName, cwd string, env map[string]string,
	structuredBin, claudeModel, resumeSessionID, jsonIn, jsonOut string) error {

	parts := []string{
		shellQuote(structuredBin),
		"--backend", "claude",
		"--auto-allow",
		"--cwd", shellQuote(cwd),
		"--json-in", shellQuote(jsonIn),
		"--json-out", shellQuote(jsonOut),
	}
	if claudeModel != "" {
		parts = append(parts, "--model", shellQuote(claudeModel))
	}
	if resumeSessionID != "" {
		parts = append(parts, "--resume", shellQuote(resumeSessionID))
	}
	// Nested env: the outer `env -u` strips any stale tap URL leaked from the
	// tmux server env; the inner prefix (from buildEnvPrefix) re-sets whatever
	// the caller asked for, so an explicit user-provided value still wins.
	command := "env -u ANTHROPIC_BASE_URL " + c.buildEnvPrefix(env) + strings.Join(parts, " ")

	if _, err := c.run("new-session", "-d", "-s", sessionName, "-c", cwd, command); err != nil {
		return err
	}
	// Best-effort session options, same set as CreateSession.
	_, _ = c.run("set-option", "-t", sessionName, "mouse", "off")
	_, _ = c.run("set-option", "-t", sessionName, "history-limit", "50000")
	_, _ = c.run("set-option", "-t", sessionName, "mode-keys", "vi")
	return nil
}

// buildCommand returns the full shell command string to spawn the agent,
// dispatching on tool. This ports app/agents/{claude,cursor,codex}.build_command.
// The `env` parameter is accepted for parity but, as in Python, the env is
// injected via the prefix rather than embedded in the command.
func (c *Client) buildCommand(tool, cwd string, env map[string]string,
	model, resumeSessionID, innerID string) string {

	switch tool {
	case "cursor":
		return buildCursorCommand(c.cursorBin(), model, resumeSessionID)
	case "codex":
		return buildCodexCommand(model, resumeSessionID)
	default: // "claude" and unknown fall back to claude
		return buildClaudeCommand(c.claudeBin(), c.claudeShell(), model, resumeSessionID, innerID)
	}
}

// buildClaudeCommand ports ClaudeAdapter.build_command.
func buildClaudeCommand(claudeBin, claudeShell, model, resumeSessionID, innerID string) string {
	binQ := shellQuote(claudeBin)
	var cmd string
	switch {
	case resumeSessionID != "":
		cmd = binQ + " --dangerously-skip-permissions --resume " + shellQuote(resumeSessionID)
	case model != "":
		cmd = binQ + " --dangerously-skip-permissions --model " + shellQuote(model)
	default:
		cmd = binQ + " --dangerously-skip-permissions"
	}
	if innerID != "" {
		pidFile := "/tmp/claude-inner-" + innerID + ".pid"
		cmd = fmt.Sprintf("sh -c 'echo $$ > %s && exec %s'", pidFile, cmd)
	}
	if claudeShell != "" {
		cmd = claudeShell + " -c " + shellQuote(cmd)
	}
	return cmd
}

// buildCursorCommand ports CursorAdapter.build_command.
func buildCursorCommand(cursorBin, model, resumeSessionID string) string {
	binQ := shellQuote(cursorBin)
	if resumeSessionID != "" {
		return binQ + " --yolo --resume " + shellQuote(resumeSessionID)
	}
	return binQ + " --yolo"
}

// buildCodexCommand ports CodexAdapter.build_command. The codex binary is
// resolved from PATH (matching the Python shutil.which("codex") fallback).
func buildCodexCommand(model, resumeSessionID string) string {
	codexBin, err := exec.LookPath("codex")
	if err != nil || codexBin == "" {
		codexBin = "codex"
	}
	parts := []string{shellQuote(codexBin), "--no-alt-screen"}
	if model != "" {
		parts = append(parts, "-c", shellQuote(fmt.Sprintf("model=%q", model)))
	}
	if resumeSessionID != "" {
		parts = append(parts, "resume", shellQuote(resumeSessionID))
	}
	return strings.Join(parts, " ")
}

// needsProxyTap ports the adapters' needs_proxy_tap: only Claude taps.
func needsProxyTap(tool string) bool {
	return tool == "claude" || tool == ""
}

// HasSession reports whether the named tmux session exists.
// (Port of has_session.)
func (c *Client) HasSession(sessionName string) bool {
	_, err := c.run("has-session", "-t", sessionName)
	return err == nil
}

// ListSessions returns the names of all sessions on this socket.
// (Port of list_sessions.)
func (c *Client) ListSessions() ([]string, error) {
	out, err := c.run("list-sessions", "-F", "#{session_name}")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, row := range strings.Split(out, "\n") {
		if row != "" {
			names = append(names, row)
		}
	}
	return names, nil
}

// Terminate kills the named session. (Port of terminate.)
func (c *Client) Terminate(sessionName string) error {
	_, err := c.run("kill-session", "-t", sessionName)
	return err
}

// SendKeys sends text followed by Enter, as if typed by the user.
// (Port of send_keys.) The `--` terminates tmux option parsing so text
// starting with `-` is not mistaken for a flag; Enter follows as a key name.
func (c *Client) SendKeys(sessionName, text string) error {
	_, err := c.run("send-keys", "-t", sessionName, "--", text, "Enter")
	return err
}

// GetPanePID returns the PID of the process running in the session's pane,
// or (0, false) if it cannot be determined. (Port of get_pane_pid.)
func (c *Client) GetPanePID(sessionName string) (int, bool) {
	out, err := c.run("list-panes", "-t", sessionName, "-F", "#{pane_pid}")
	if err != nil {
		return 0, false
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) == 0 || lines[0] == "" {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil {
		return 0, false
	}
	return pid, true
}

// HasActiveChildren reports whether the pane's shell has any descendant
// processes. Used to keep an ephemeral terminal alive while it has work in
// flight. A clean prompt has no descendants. (Port of has_active_children.)
func (c *Client) HasActiveChildren(sessionName string) bool {
	pid, ok := c.GetPanePID(sessionName)
	if !ok {
		return false
	}
	desc, err := getDescendants(pid)
	if err != nil {
		return false
	}
	return len(desc) > 0
}

// GetPaneHistorySize returns the current tmux pane history size (grows as
// output arrives), or (0, false) on failure. (Port of get_pane_history_size.)
func (c *Client) GetPaneHistorySize(sessionName string) (int, bool) {
	out, err := c.run("display-message", "-p", "-t", sessionName, "#{history_size}")
	if err != nil {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return 0, false
	}
	return n, true
}

// IsPaneInMode reports whether the pane is currently in any tmux mode
// (copy-mode, view-mode). Used by WS scroll handlers to detect when copy-mode
// was cancelled by a user keypress. (Port of is_pane_in_mode.)
func (c *Client) IsPaneInMode(sessionName string) bool {
	out, err := c.run("display-message", "-p", "-t", sessionName, "#{pane_in_mode}")
	if err != nil {
		return false
	}
	return strings.TrimSpace(out) == "1"
}

// CaptureVisibleScreen captures only the currently visible pane content
// (no scrollback, no ANSI). Returns "" on failure, like the Python version.
// (Port of capture_visible_screen.)
func (c *Client) CaptureVisibleScreen(sessionName string) string {
	out, err := c.run("capture-pane", "-p", "-t", sessionName)
	if err != nil {
		return ""
	}
	return out
}

// CaptureFullHistory captures the entire scrollback + visible content of a
// pane. When ansi is true the escape sequences are included. Returns "" on
// failure. (Port of capture_full_history.)
func (c *Client) CaptureFullHistory(sessionName string, ansi bool) string {
	args := []string{"capture-pane", "-p", "-S", "-", "-E", "-", "-t", sessionName}
	if ansi {
		// Python inserts "-e" at index 2 (right after "-p").
		args = append(args[:2], append([]string{"-e"}, args[2:]...)...)
	}
	out, err := c.run(args...)
	if err != nil {
		return ""
	}
	return out
}

// ResizeWindow resizes the named session's window to the given cols×rows.
// This was referenced by the task as resize_window; the Python service resized
// via the PtyHandle, but tmux also supports resize-window directly.
func (c *Client) ResizeWindow(sessionName string, cols, rows int) error {
	_, err := c.run("resize-window", "-t", sessionName,
		"-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows))
	return err
}

// autoAcceptTrustDialog polls the TUI after startup; if Claude's
// workspace-trust dialog shows, it presses Enter to accept the default first
// option. Returns silently if no dialog appears within timeout. Never returns
// an error — failure here must not affect session creation.
// (Port of _auto_accept_trust_dialog; runs in a goroutine.)
func (c *Client) autoAcceptTrustDialog(sessionName string, timeout time.Duration) {
	time.Sleep(800 * time.Millisecond) // let the TUI render before first scan
	start := time.Now()
	sent := false
	for time.Since(start) < timeout {
		screen := c.CaptureVisibleScreen(sessionName)
		isTrust := looksLikeTrustDialog(screen)
		if isTrust && !sent {
			if _, err := c.run("send-keys", "-t", sessionName, "Enter"); err != nil {
				return
			}
			sent = true
			slog.Info("auto-accepted trust dialog", "session", sessionName)
			time.Sleep(500 * time.Millisecond)
			continue
		}
		if sent && !isTrust {
			return // dialog cleared — success
		}
		time.Sleep(400 * time.Millisecond)
	}
	if sent {
		slog.Warn("trust dialog Enter sent but dialog did not clear in time",
			"session", sessionName, "timeout", timeout)
	}
}

// --- live-reloaded getter accessors (nil-safe) ---

func (c *Client) claudeBin() string {
	if c.ClaudeBin != nil {
		if v := c.ClaudeBin(); v != "" {
			return v
		}
	}
	return "claude"
}

func (c *Client) cursorBin() string {
	if c.CursorBin != nil {
		if v := c.CursorBin(); v != "" {
			return v
		}
	}
	return "agent"
}

func (c *Client) claudeShell() string {
	if c.ClaudeShell != nil {
		return c.ClaudeShell()
	}
	return ""
}

func (c *Client) proxyEnv() map[string]string {
	if c.ProxyEnv != nil {
		return c.ProxyEnv()
	}
	return nil
}

func (c *Client) proxyMode() string {
	if c.ProxyMode != nil {
		if v := c.ProxyMode(); v != "" {
			return v
		}
	}
	return ProxyModeTapUpstream
}
