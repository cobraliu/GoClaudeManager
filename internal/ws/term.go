package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/term"
	"github.com/loki/goclaudemanager/internal/tmux"
)

// shellTokens is the in-process one-shot token store for ephemeral /ws/shell.
// It mirrors the Python sessions._shell_tokens dict (token → {cwd, unrestricted}).
// Tokens are minted by the REST /{id}/shell endpoint and consumed here once.
var shellTokens = newShellTokenStore()

type shellTokenInfo struct {
	Cwd          string
	Unrestricted bool
}

type shellTokenStore struct {
	mu     sync.Mutex
	tokens map[string]shellTokenInfo
}

func newShellTokenStore() *shellTokenStore {
	return &shellTokenStore{tokens: make(map[string]shellTokenInfo)}
}

// Put registers a one-shot shell token. Exported via the api package through
// PutShellToken below so the REST handler (different package) can mint tokens.
func (s *shellTokenStore) Put(token string, info shellTokenInfo) {
	s.mu.Lock()
	s.tokens[token] = info
	s.mu.Unlock()
}

func (s *shellTokenStore) Pop(token string) (shellTokenInfo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	info, ok := s.tokens[token]
	if ok {
		delete(s.tokens, token)
	}
	return info, ok
}

// PutShellToken registers an ephemeral-shell token. Called by the REST layer.
func PutShellToken(token, cwd string, unrestricted bool) {
	shellTokens.Put(token, shellTokenInfo{Cwd: cwd, Unrestricted: unrestricted})
}

// RegisterTermRoutes mounts the bash-terminal + ephemeral-shell WS routes on the
// ws sub-router. The lead wires this from ws.Router.
func RegisterTermRoutes(r chi.Router, d Deps, ts *term.Service) {
	r.Get("/terminals/{term_id}", TermWSHandler(d, ts))
	r.Get("/shell", ShellWSHandler(d))
}

// ── named/ephemeral bash terminal WS (port of term_ws.py) ───────────────────

// TermWSHandler returns the handler for /ws/terminals/{term_id}. It validates a
// one-shot token, attaches a PTY to the terminal's tmux session, and pumps raw
// output to the browser while accepting input/resize/scroll/ping messages.
func TermWSHandler(d Deps, ts *term.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		termID := chi.URLParam(r, "term_id")
		token := r.URL.Query().Get("token")
		cols := queryInt(r, "cols", 120)
		rows := queryInt(r, "rows", 30)
		if cols < minCols {
			cols = 120
		}
		if rows < minRows {
			rows = 30
		}

		if bound := ts.ConsumeToken(token); bound != termID {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		rec := ts.Get(termID)
		if rec == nil {
			http.Error(w, "terminal not found", http.StatusNotFound)
			return
		}

		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			slog.Warn("term ws accept failed", "err", err)
			return
		}
		c.SetReadLimit(4 << 20)
		ctx := r.Context()

		pty, err := d.Tmux.AttachPTY(rec.TmuxName, cols, rows)
		if err != nil {
			_ = wsWriteJSON(ctx, c, map[string]any{"type": "state", "payload": map[string]any{"status": "error", "message": err.Error()}})
			c.Close(websocket.StatusInternalError, "failed to attach")
			return
		}
		ts.OnAttach(termID)

		// Mirror PTY size onto the tmux window (fire-and-forget).
		go func() {
			_, _ = d.Tmux.Run("resize-window", "-t", rec.TmuxName, "-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows))
		}()

		st := &bashTermState{c: c, tmux: d.Tmux, pty: pty, rec: rec}

		// Reader goroutine: blocking PTY reads → outCh; EOF closes the channel.
		outCh := make(chan []byte, 64)
		readerCtx, stopReader := context.WithCancel(context.Background())
		go func() {
			defer close(outCh)
			for {
				data, rerr := pty.Read(0)
				if len(data) > 0 {
					buf := make([]byte, len(data))
					copy(buf, data)
					select {
					case outCh <- buf:
					case <-readerCtx.Done():
						return
					}
				}
				if rerr != nil {
					return
				}
			}
		}()

		// Output pusher goroutine.
		pushDone := make(chan struct{})
		go func() {
			defer close(pushDone)
			st.outputPusher(ctx, outCh)
		}()

		// Attached banner.
		_ = wsWriteJSON(ctx, c, map[string]any{
			"type": "state",
			"payload": map[string]any{
				"status":   "attached",
				"term_id":  termID,
				"name":     nameJSON(rec.Name),
				"is_named": rec.IsNamed(),
			},
		})

		// Input loop (blocks until client disconnects).
		st.inputLoop(ctx)

		// Cleanup (mirrors the Python finally block).
		stopReader()
		c.Close(websocket.StatusNormalClosure, "")
		<-pushDone
		pty.Close()
		ts.OnDetach(termID)
	}
}

type bashTermState struct {
	c    *websocket.Conn
	tmux *tmux.Client
	pty  *tmux.PtyHandle
	rec  *term.Record

	inCopyMode  bool
	scrollDepth int
}

func (s *bashTermState) outputPusher(ctx context.Context, outCh chan []byte) {
	for {
		select {
		case <-ctx.Done():
			return
		case data, ok := <-outCh:
			if !ok {
				_ = wsWriteJSON(ctx, s.c, map[string]any{"type": "state", "payload": map[string]any{"status": "terminated"}})
				return
			}
			if err := s.c.Write(ctx, websocket.MessageBinary, data); err != nil {
				return
			}
		}
	}
}

func (s *bashTermState) inputLoop(ctx context.Context) {
	name := s.rec.TmuxName
	for {
		typ, raw, err := s.c.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var msg clientMsg
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "input":
			if msg.Data != nil {
				_ = s.pty.Write([]byte(*msg.Data))
			}
		case "resize":
			if msg.Cols >= minCols && msg.Rows >= minRows {
				_ = s.pty.Resize(msg.Cols, msg.Rows)
				_, _ = s.tmux.Run("resize-window", "-t", name, "-x", strconv.Itoa(msg.Cols), "-y", strconv.Itoa(msg.Rows))
			}
		case "scroll":
			if msg.Delta != nil {
				s.handleScroll(ctx, *msg.Delta)
			}
		case "exit-copy-mode":
			_, _ = s.tmux.Run("send-keys", "-t", name, "-X", "cancel")
			_, _ = s.tmux.Run("refresh-client", "-t", name)
			s.inCopyMode = false
			s.scrollDepth = 0
		case "ping":
			_ = wsWriteJSON(ctx, s.c, map[string]any{
				"type":    "pong",
				"payload": map[string]any{"client_ts": msg.Ts, "server_ts": time.Now().UnixMilli()},
			})
		}
	}
}

func (s *bashTermState) handleScroll(ctx context.Context, delta int) {
	name := s.rec.TmuxName
	actuallyInMode := s.tmux.IsPaneInMode(name)
	if s.inCopyMode && !actuallyInMode {
		s.inCopyMode = false
		s.scrollDepth = 0
		_ = wsWriteJSON(ctx, s.c, map[string]any{"type": "copy-mode-exited"})
	}
	switch {
	case delta < 0:
		n := -delta
		if n > 50 {
			n = 50
		}
		if !s.inCopyMode {
			_, _ = s.tmux.Run("copy-mode", "-t", name)
			s.inCopyMode = true
		}
		_, _ = s.tmux.Run("send-keys", "-t", name, "-N", strconv.Itoa(n), "-X", "scroll-up")
		s.scrollDepth += n
	case delta > 0 && s.inCopyMode:
		n := delta
		if n > 50 {
			n = 50
		}
		s.scrollDepth -= n
		if s.scrollDepth <= 0 {
			_, _ = s.tmux.Run("send-keys", "-t", name, "-X", "cancel")
			s.inCopyMode = false
			s.scrollDepth = 0
		} else {
			_, _ = s.tmux.Run("send-keys", "-t", name, "-N", strconv.Itoa(n), "-X", "scroll-down")
		}
	}
}

func nameJSON(name string) any {
	if name == "" {
		return nil
	}
	return name
}

// ── ephemeral bash shell WS (port of shell_ws.py) ───────────────────────────

// blockedCmds are privileged commands neutered in the restricted shell init.
var blockedCmds = []string{
	"sudo", "su", "pkexec", "passwd", "chsh", "chfn",
	"newgrp", "visudo", "doas", "runuser",
}

// ShellWSHandler returns the handler for /ws/shell. It validates a one-shot
// token, spawns bash directly under a PTY (NOT tmux, so xterm.js gets native
// scrollback), and pumps raw output to the browser.
func ShellWSHandler(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		info, ok := shellTokens.Pop(token)
		if !ok {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}

		ptyFile, child, err := spawnBash(info.Cwd, 80, 24, info.Unrestricted)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			slog.Warn("shell ws accept failed", "err", err)
			_ = ptyFile.Close()
			_ = child.Process.Kill()
			return
		}
		c.SetReadLimit(4 << 20)
		ctx := r.Context()

		// Reader goroutine.
		outCh := make(chan []byte, 64)
		readerCtx, stopReader := context.WithCancel(context.Background())
		go func() {
			defer close(outCh)
			buf := make([]byte, 65536)
			for {
				n, rerr := ptyFile.Read(buf)
				if n > 0 {
					b := make([]byte, n)
					copy(b, buf[:n])
					select {
					case outCh <- b:
					case <-readerCtx.Done():
						return
					}
				}
				if rerr != nil {
					return
				}
			}
		}()

		// Output pusher.
		pushDone := make(chan struct{})
		go func() {
			defer close(pushDone)
			for {
				select {
				case <-ctx.Done():
					return
				case data, ok := <-outCh:
					if !ok {
						_ = wsWriteJSON(ctx, c, map[string]any{"type": "state", "payload": map[string]any{"status": "terminated"}})
						return
					}
					if err := c.Write(ctx, websocket.MessageBinary, data); err != nil {
						return
					}
				}
			}
		}()

		// Input loop.
		for {
			typ, raw, rerr := c.Read(ctx)
			if rerr != nil {
				break
			}
			if typ != websocket.MessageText {
				continue
			}
			var msg clientMsg
			if json.Unmarshal(raw, &msg) != nil {
				continue
			}
			switch msg.Type {
			case "input":
				if msg.Data != nil {
					_, _ = ptyFile.Write([]byte(*msg.Data))
				}
			case "resize":
				if msg.Cols > 0 && msg.Rows > 0 {
					_ = pty.Setsize(ptyFile, &pty.Winsize{Rows: uint16(msg.Rows), Cols: uint16(msg.Cols)})
				}
			case "ping":
				_ = wsWriteJSON(ctx, c, map[string]any{
					"type":    "pong",
					"payload": map[string]any{"client_ts": msg.Ts, "server_ts": time.Now().UnixMilli()},
				})
			}
		}

		// Cleanup.
		stopReader()
		c.Close(websocket.StatusNormalClosure, "")
		<-pushDone
		_ = ptyFile.Close()
		if child.Process != nil {
			_ = child.Process.Kill()
			_, _ = child.Process.Wait()
		}
	}
}

// spawnBash forks bash attached to a fresh PTY in cwd. unrestricted=true (admin)
// gives full system access; false restricts cd to cwd and blocks privileged
// commands via a temporary --init-file. (Port of shell_ws._spawn_bash, minus
// the firejail sandbox — see deliverable notes.)
func spawnBash(cwd string, cols, rows int, unrestricted bool) (*os.File, *exec.Cmd, error) {
	initFile, err := writeInitFile(cwd, unrestricted)
	if err != nil {
		return nil, nil, err
	}
	// Delete the init file after bash has had time to read it.
	go func() {
		time.Sleep(3 * time.Second)
		_ = os.Remove(initFile)
	}()

	cmd := exec.Command("bash", "--init-file", initFile)
	cmd.Dir = cwd
	ptyFile, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		_ = os.Remove(initFile)
		return nil, nil, err
	}
	return ptyFile, cmd, nil
}

// writeInitFile writes a bash --init-file. For restricted shells it neuters cd
// (confined to PROJECT_ROOT) and the privileged commands; for admin shells it
// just sources ~/.bashrc and cds into the project. (Ports _write_init_file /
// _write_admin_init_file.)
func writeInitFile(projectRoot string, unrestricted bool) (string, error) {
	f, err := os.CreateTemp("", ".cm_shell_*.sh")
	if err != nil {
		return "", err
	}
	defer f.Close()

	var content string
	if unrestricted {
		content = fmt.Sprintf(`# GoClaudeManager admin shell init
[ -f ~/.bashrc ] && source ~/.bashrc
builtin cd %q 2>/dev/null
export PS1='(admin) \w\$ '
`, projectRoot)
	} else {
		var blocked string
		for _, cmd := range blockedCmds {
			blocked += fmt.Sprintf("%s() { echo \"[shell] %s: not allowed\" >&2; return 1; }\n", cmd, cmd)
		}
		content = fmt.Sprintf(`# GoClaudeManager restricted shell init
PROJECT_ROOT=%q

# Restrict cd to project directory tree
cd() {
    local target="${1:-$PROJECT_ROOT}"
    local abs
    abs=$(realpath -m "$target" 2>/dev/null || echo "$target")
    case "$abs" in
        "$PROJECT_ROOT"|"$PROJECT_ROOT/"*)
            builtin cd "$@" ;;
        *)
            echo "[shell] cd: access denied (outside project directory)" >&2
            return 1 ;;
    esac
}

# Block privileged commands
%s
export PS1='(project) \w\$ '
builtin cd "$PROJECT_ROOT" 2>/dev/null
`, projectRoot, blocked)
	}

	if _, err := f.WriteString(content); err != nil {
		return "", err
	}
	return f.Name(), nil
}
