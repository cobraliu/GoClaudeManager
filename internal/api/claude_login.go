// Assisted Claude CLI login (/login OAuth, web-driven).
//
// Sessions launched by GoClaudeManager run `claude` with no login flow — they
// inherit the host user's ~/.claude/.credentials.json (one shared identity for
// every web user). When that OAuth token expires every session breaks, and the
// only fix used to be SSHing in and running `claude` + `/login` by hand. These
// endpoints drive that login from the web UI.
//
// A singleton login session lives on the shared "claude-web" tmux socket under
// the fixed name `claude-login`, working dir `<DataDir>/.login`. We launch a
// plain claude (no proxy tap / no ANTHROPIC_BASE_URL) so the OAuth token
// exchange and the real credentials write are untouched, type `/login`, scrape
// the authorization URL, accept a pasted auth code, and detect success.
//
// Admin-only: it rewrites the single shared credential file.
package api

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"encoding/json"

	"github.com/go-chi/chi/v5"
)

const claudeLoginSession = "claude-login"

// loginMu serializes concurrent admins driving the singleton login session.
var loginMu sync.Mutex

// expiresAtSnapshot holds the claudeAiOauth.expiresAt observed at /start, so a
// later increase (a freshly written token) is a robust success signal that is
// independent of the screen text. Guarded by loginMu.
var expiresAtSnapshot int64

// oauthURLRe matches the authorization URL claude prints. The real prefix
// (claude v2.1.158) is https://claude.com/cai/oauth/authorize?... — NOT
// claude.ai — and the URL is word-wrapped across several lines on screen, so
// callers must capture with `-J` (join) before matching. We accept any
// claude.com / anthropic.com host to stay tolerant across CLI versions.
var oauthURLRe = regexp.MustCompile(`https?://(?:[\w.-]*\.)?(?:claude\.com|claude\.ai|anthropic\.com)/[^\s"')]+`)

var loginSuccessRe = regexp.MustCompile(`(?i)login successful|logged in|successfully (?:logged in|authenticated)|authentication successful`)
var loginErrorRe = regexp.MustCompile(`(?i)invalid code|oauth error|authentication failed|login failed|expired token|an error occurred`)

// ClaudeLoginRouter builds /api/admin/claude-login. All routes are admin-only.
func ClaudeLoginRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(d.Auth.RequireAdmin)

	r.Post("/start", func(w http.ResponseWriter, r *http.Request) { claudeLoginStart(d, w, r) })
	r.Get("/status", func(w http.ResponseWriter, r *http.Request) { claudeLoginStatus(d, w, r) })
	r.Post("/code", func(w http.ResponseWriter, r *http.Request) { claudeLoginCode(d, w, r) })
	r.Post("/cancel", func(w http.ResponseWriter, r *http.Request) { claudeLoginCancel(d, w, r) })

	return r
}

// loginDir is <DataDir>/.login (DataDir empty → ./data/.login in dev).
func loginDir(d Deps) string {
	base := d.Env.DataDir
	if base == "" {
		base = "data"
	}
	return filepath.Join(base, ".login")
}

// capture grabs the joined visible screen of the login session. The -J flag
// joins word-wrapped lines so a wrapped OAuth URL stays on one logical line.
func (d Deps) captureLogin() string {
	out, err := d.Tmux.Run("capture-pane", "-p", "-J", "-t", claudeLoginSession)
	if err != nil {
		return ""
	}
	return out
}

// readCredsExpiresAt returns claudeAiOauth.expiresAt (ms epoch) from the host
// credentials file, or 0 if unreadable.
func readCredsExpiresAt() int64 {
	home, err := os.UserHomeDir()
	if err != nil {
		return 0
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil {
		return 0
	}
	var creds struct {
		ClaudeAiOauth struct {
			ExpiresAt int64 `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	if json.Unmarshal(raw, &creds) != nil {
		return 0
	}
	return creds.ClaudeAiOauth.ExpiresAt
}

type loginResult struct {
	State   string `json:"state"`   // idle|starting|awaiting_code|success|error
	URL     string `json:"url,omitempty"`
	Message string `json:"message,omitempty"`
	Screen  string `json:"screen,omitempty"`
}

// classify interprets the captured screen. credsChanged means a fresh token was
// written since /start (the authoritative success signal).
func classify(screen string, credsChanged bool) loginResult {
	res := loginResult{Screen: screen}
	url := oauthURLRe.FindString(screen)
	url = strings.TrimRight(url, ".,)")

	switch {
	case credsChanged || loginSuccessRe.MatchString(screen):
		res.State = "success"
		res.Message = "登录成功"
	case loginErrorRe.MatchString(screen):
		res.State = "error"
		res.Message = "登录失败，请重试"
	case url != "":
		res.State = "awaiting_code"
		res.URL = url
	default:
		res.State = "starting"
	}
	return res
}

// sendEnter sends a bare Enter keypress (no text) to advance a TUI menu.
func (d Deps) sendEnter() {
	_, _ = d.Tmux.Run("send-keys", "-t", claudeLoginSession, "Enter")
}

func claudeLoginStart(d Deps, w http.ResponseWriter, r *http.Request) {
	loginMu.Lock()
	defer loginMu.Unlock()

	dir := loginDir(d)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "cannot create login dir: "+err.Error())
		return
	}

	expiresAtSnapshot = readCredsExpiresAt()

	if !d.Tmux.HasSession(claudeLoginSession) {
		claudeBin := d.Tmux.ClaudeBin()
		cmd := claudeBin + " --dangerously-skip-permissions"
		// A wide, tall pane: claude redraws each row explicitly (no soft-wrap
		// markers), so capture-pane -J cannot rejoin a URL that the terminal
		// wrapped. The full OAuth URL (with &state=) is ~445 chars; -x 600
		// keeps it on a single line so the regex captures it intact.
		if _, err := d.Tmux.Run("new-session", "-d", "-s", claudeLoginSession,
			"-x", "600", "-y", "50", "-c", dir, cmd); err != nil {
			writeErr(w, http.StatusInternalServerError, "cannot start login session: "+err.Error())
			return
		}
		// Let claude boot, then dismiss the trust/onboarding dialog with Enter.
		time.Sleep(2500 * time.Millisecond)
		d.sendEnter()
		time.Sleep(800 * time.Millisecond)
	}

	// Type /login (SendKeys appends Enter → confirms the slash command), then
	// nudge through the login-method menu (option 1, "subscription", is the
	// default highlight) with a second Enter.
	_ = d.Tmux.SendKeys(claudeLoginSession, "/login")
	time.Sleep(900 * time.Millisecond)
	d.sendEnter()

	// Poll for the OAuth URL (or an early success/error) up to ~10s.
	var res loginResult
	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)
		res = classify(d.captureLogin(), readCredsExpiresAt() > expiresAtSnapshot && expiresAtSnapshot > 0)
		if res.State == "awaiting_code" || res.State == "success" || res.State == "error" {
			break
		}
	}
	writeJSON(w, http.StatusOK, res)
}

func claudeLoginStatus(d Deps, w http.ResponseWriter, _ *http.Request) {
	loginMu.Lock()
	defer loginMu.Unlock()

	if !d.Tmux.HasSession(claudeLoginSession) {
		writeJSON(w, http.StatusOK, loginResult{State: "idle"})
		return
	}
	credsChanged := readCredsExpiresAt() > expiresAtSnapshot && expiresAtSnapshot > 0
	writeJSON(w, http.StatusOK, classify(d.captureLogin(), credsChanged))
}

func claudeLoginCode(d Deps, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	code := strings.TrimSpace(body.Code)
	if code == "" {
		writeErr(w, http.StatusBadRequest, "code is required")
		return
	}

	loginMu.Lock()
	defer loginMu.Unlock()

	if !d.Tmux.HasSession(claudeLoginSession) {
		writeJSON(w, http.StatusOK, loginResult{State: "idle"})
		return
	}

	// Paste the code + Enter into the login session.
	_ = d.Tmux.SendKeys(claudeLoginSession, code)

	// Poll for success/error up to ~12s (the token exchange round-trips a server).
	var res loginResult
	for i := 0; i < 24; i++ {
		time.Sleep(500 * time.Millisecond)
		credsChanged := readCredsExpiresAt() > expiresAtSnapshot && expiresAtSnapshot > 0
		res = classify(d.captureLogin(), credsChanged)
		if res.State == "success" || res.State == "error" {
			break
		}
	}
	writeJSON(w, http.StatusOK, res)
}

func claudeLoginCancel(d Deps, w http.ResponseWriter, _ *http.Request) {
	loginMu.Lock()
	defer loginMu.Unlock()

	if d.Tmux.HasSession(claudeLoginSession) {
		_, _ = d.Tmux.Run("kill-session", "-t", claudeLoginSession)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
