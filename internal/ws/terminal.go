package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/claudestat"
	"github.com/loki/goclaudemanager/internal/jsonl"
	"github.com/loki/goclaudemanager/internal/model"
	"github.com/loki/goclaudemanager/internal/tmux"
)

// minCols/minRows reject obviously-broken sizes from transient client layout
// glitches. Without this, a tiny pane (e.g. 5 rows) permanently mangles Claude's
// Ink TUI into endless duplicate-line redraws, because tmux's `window-size
// latest` locks the shared window to that bad size. Must match the Python
// terminal_ws thresholds (_MIN_COLS=40, _MIN_ROWS=10).
const (
	minCols = 40
	minRows = 10
)

// clientMsg mirrors pydantic WsClientMessage.
type clientMsg struct {
	Type  string  `json:"type"`
	Data  *string `json:"data"`
	Cols  int     `json:"cols"`
	Rows  int     `json:"rows"`
	Ts    *int64  `json:"ts"`
	Query string  `json:"query"`
	Delta *int    `json:"delta"`
	Pane  *string `json:"pane"`
}

// terminalWS is the port of terminal_ws.terminal_ws.
func terminalWS(d Deps, w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "id")
	token := r.URL.Query().Get("token")
	cols := queryInt(r, "cols", 220)
	rows := queryInt(r, "rows", 50)
	if cols < minCols {
		cols = 220
	}
	if rows < minRows {
		rows = 50
	}

	session, err := d.Store.GetSession(sessionID)
	if err != nil || session == nil || session.WsToken == nil || *session.WsToken != token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if session.Status == model.StatusTerminated {
		http.Error(w, "session terminated", http.StatusGone)
		return
	}

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		slog.Warn("ws accept failed", "err", err)
		return
	}
	// coder/websocket has a 32KiB default read limit; raw paste can exceed it.
	c.SetReadLimit(4 << 20)

	ctx := r.Context()

	pty, err := d.Tmux.AttachPTY(session.TmuxSessionName, cols, rows)
	if err != nil {
		_ = wsWriteJSON(ctx, c, map[string]any{"type": "state", "payload": map[string]any{"status": "error", "message": err.Error()}})
		c.Close(websocket.StatusInternalError, "failed to attach")
		return
	}

	d.Store.UpdateAttachedClients(sessionID, +1)
	// A reattach to a detached session brings it back to running (mirrors the
	// Python terminal_ws, which flips DETACHED→RUNNING on connect).
	if session.Status == model.StatusDetached {
		if _, err := d.Store.Transition(sessionID, model.StatusRunning); err == nil {
			session.Status = model.StatusRunning
		}
	}

	// Baseline + resize + refresh (fire-and-forget).
	go func() {
		if hs, ok := d.Tmux.GetPaneHistorySize(session.TmuxSessionName); ok {
			_ = d.Store.SyncOutputOffset(sessionID, int64(hs))
		}
		_, _ = d.Tmux.Run("resize-window", "-t", session.TmuxSessionName, "-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows))
		_, _ = d.Tmux.Run("refresh-client", "-t", session.TmuxSessionName)
	}()

	// Reader goroutine: blocking PTY reads → outCh. EOF closes the channel.
	outCh := make(chan []byte, 64)
	readerCtx, stopReader := context.WithCancel(context.Background())
	go func() {
		defer close(outCh)
		for {
			data, err := pty.Read(0) // block until data or EOF
			if len(data) > 0 {
				buf := make([]byte, len(data))
				copy(buf, data)
				select {
				case outCh <- buf:
				case <-readerCtx.Done():
					return
				}
			}
			if err != nil {
				return // EOF / closed
			}
		}
	}()

	st := &termState{d: d, c: c, sessionID: sessionID, session: session, pty: pty}

	// Output pusher goroutine. It runs on its own lifecycle context (pushCtx)
	// rather than the request context: a hijacked WebSocket's r.Context() is not
	// guaranteed to fire on disconnect, so we cancel pushCtx explicitly below to
	// guarantee the pusher returns and <-pushDone never hangs.
	pushCtx, stopPush := context.WithCancel(context.Background())
	pushDone := make(chan struct{})
	go func() {
		defer close(pushDone)
		st.outputPusher(pushCtx, outCh)
	}()

	// Input loop (blocks until client disconnects).
	st.inputLoop(ctx, cols, rows)

	// Cleanup (mirrors the Python finally block). Stop the pusher first so it
	// exits via pushCtx.Done() and never takes the EOF→terminate branch for a
	// mere client disconnect; cleanup() decides detached-vs-terminated by
	// re-checking the live tmux session.
	stopReader()
	stopPush()
	c.Close(websocket.StatusNormalClosure, "")
	<-pushDone
	pty.Close()
	st.cleanup(cols, rows)
}

type termState struct {
	d         Deps
	c         *websocket.Conn
	sessionID string
	session   *model.Session
	pty       *tmux.PtyHandle

	inCopyMode  bool
	scrollDepth int

	lastActivityUpdate time.Time
	idleSynced         bool
}

func (s *termState) outputPusher(ctx context.Context, outCh chan []byte) {
	s.lastActivityUpdate = time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case data, ok := <-outCh:
			if !ok {
				// The PTY closed. This is a real termination ONLY if the tmux
				// session is actually gone (claude exited). A client detach /
				// page refresh also closes the PTY but leaves the tmux session
				// alive — in that case the session must NOT be terminated; the
				// cleanup() path will mark it detached instead.
				if !s.d.Tmux.HasSession(s.session.TmuxSessionName) {
					cur, _ := s.d.Store.GetSession(s.sessionID)
					if cur != nil && cur.Status != model.StatusTerminated {
						_ = s.d.Store.ForceStatus(s.sessionID, model.StatusTerminated)
					}
					_ = wsWriteJSON(ctx, s.c, map[string]any{"type": "state", "payload": map[string]any{"status": "terminated"}})
				}
				return
			}
			s.idleSynced = false
			if err := s.c.Write(ctx, websocket.MessageBinary, data); err != nil {
				return
			}
			if time.Since(s.lastActivityUpdate) > 2*time.Second {
				s.lastActivityUpdate = time.Now()
				_ = s.d.Store.UpdateActivity(s.sessionID)
			}
		case <-time.After(2 * time.Second):
			// PTY idle 2s → sync last_turn_at so is_streaming clears promptly.
			if !s.idleSynced {
				s.idleSynced = true
				s.syncTurn()
			}
		}
	}
}

func (s *termState) syncTurn() {
	cur, _ := s.d.Store.GetSession(s.sessionID)
	if cur == nil || cur.AgentSessionID == nil || *cur.AgentSessionID == "" {
		return
	}
	if info, err := jsonl.GetLatestTurnInfo(*cur.AgentSessionID, cur.Cwd, 0); err == nil && info.TurnTs > 0 {
		_ = s.d.Store.UpdateLastTurnAt(s.sessionID, info.TurnTs)
	}
}

func (s *termState) inputLoop(ctx context.Context, cols, rows int) {
	for {
		typ, raw, err := s.c.Read(ctx)
		if err != nil {
			return // disconnect
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
			s.handleInput(ctx, msg)
		case "scroll":
			if msg.Delta != nil {
				s.handleScroll(*msg.Delta)
			}
		case "resize":
			if msg.Cols >= minCols && msg.Rows >= minRows {
				_ = s.pty.Resize(msg.Cols, msg.Rows)
				_, _ = s.d.Tmux.Run("resize-window", "-t", s.session.TmuxSessionName, "-x", strconv.Itoa(msg.Cols), "-y", strconv.Itoa(msg.Rows))
			}
		case "exit-copy-mode":
			_, _ = s.d.Tmux.Run("send-keys", "-t", s.session.TmuxSessionName, "-X", "cancel")
			_, _ = s.d.Tmux.Run("refresh-client", "-t", s.session.TmuxSessionName)
			s.inCopyMode = false
			s.scrollDepth = 0
		case "refresh":
			_, _ = s.d.Tmux.Run("refresh-client", "-t", s.session.TmuxSessionName)
		case "search-init":
			if msg.Query != "" {
				_ = s.d.Tmux.SearchInitPTY(s.pty, msg.Query)
			}
		case "search-next":
			_ = s.d.Tmux.SearchNextPTY(s.pty)
		case "ping":
			var clientTs *int64 = msg.Ts
			_ = wsWriteJSON(ctx, s.c, map[string]any{
				"type":    "pong",
				"payload": map[string]any{"client_ts": clientTs, "server_ts": time.Now().UnixMilli()},
			})
		}
	}
}

func (s *termState) handleInput(ctx context.Context, msg clientMsg) {
	if msg.Data == nil {
		return
	}
	if s.inCopyMode {
		_, _ = s.d.Tmux.Run("send-keys", "-t", s.session.TmuxSessionName, "-X", "cancel")
		s.inCopyMode = false
		s.scrollDepth = 0
	}
	data := *msg.Data

	if msg.Pane != nil {
		// Direct-to-pane chat delivery.
		paneTarget := s.session.TmuxSessionName + ":0." + *msg.Pane
		textPart := trimNewline(data)
		fresh, _ := s.d.Store.GetSession(s.sessionID)
		if fresh != nil && pidWaitingForAUQ(fresh.ClaudeProcPID) {
			_ = wsWriteJSON(ctx, s.c, map[string]any{"type": "prompt-rejected", "reason": "auq_pending", "text": textPart})
			return
		}
		needsEnter := endsWithNewline(data)
		if textPart != "" || needsEnter {
			if textPart != "" {
				_, _ = s.d.Store.AppendPromptHistory(s.sessionID, textPart, float64(time.Now().UnixNano())/1e9, msg.Pane)
			}
			if err := s.d.Tmux.DeliverToPane(paneTarget, textPart, needsEnter); err != nil {
				_ = wsWriteJSON(ctx, s.c, map[string]any{"type": "prompt-rejected", "reason": "send_failed", "text": textPart})
			} else if textPart != "" {
				// Successful (re)submit of this text clears any matching "send
				// failed" entry on every client (rule: a successful resubmit of
				// the same message dismisses it everywhere).
				s.d.Store.ClearLostMessagesByText(s.sessionID, textPart)
			}
		}
		return
	}

	if s.session.Tool == "cursor" && endsWithNewline(data) {
		// Cursor's Ink TUI needs Enter via send-keys, not a PTY \r.
		textPart := trimNewline(data)
		if textPart != "" {
			_ = s.pty.Write([]byte(textPart))
		}
		_, _ = s.d.Tmux.Run("send-keys", "-t", s.session.TmuxSessionName, "", "Enter")
		return
	}

	_ = s.pty.Write([]byte(data))
}

func (s *termState) handleScroll(delta int) {
	name := s.session.TmuxSessionName
	actuallyInMode := s.d.Tmux.IsPaneInMode(name)
	if s.inCopyMode && !actuallyInMode {
		s.inCopyMode = false
		s.scrollDepth = 0
		_ = wsWriteJSON(context.Background(), s.c, map[string]any{"type": "copy-mode-exited"})
	}
	switch {
	case delta < 0:
		n := -delta
		if n > 50 {
			n = 50
		}
		if !s.inCopyMode {
			_, _ = s.d.Tmux.Run("copy-mode", "-t", name)
			s.inCopyMode = true
		}
		_, _ = s.d.Tmux.Run("send-keys", "-t", name, "-N", strconv.Itoa(n), "-X", "scroll-up")
		s.scrollDepth += n
	case delta > 0 && s.inCopyMode:
		n := delta
		if n > 50 {
			n = 50
		}
		s.scrollDepth -= n
		if s.scrollDepth <= 0 {
			_, _ = s.d.Tmux.Run("send-keys", "-t", name, "-X", "cancel")
			s.inCopyMode = false
			s.scrollDepth = 0
		} else {
			_, _ = s.d.Tmux.Run("send-keys", "-t", name, "-N", strconv.Itoa(n), "-X", "scroll-down")
		}
	}
}

// cleanup mirrors the Python finally block.
func (s *termState) cleanup(cols, rows int) {
	_ = s.d.Store.MarkViewed(s.sessionID, s.session.OwnerID)
	s.d.Store.UpdateAttachedClients(s.sessionID, -1)

	updated, _ := s.d.Store.GetSession(s.sessionID)
	if updated != nil && updated.Status == model.StatusRunning {
		if s.d.Tmux.HasSession(s.session.TmuxSessionName) {
			if updated.AttachedClients <= 0 {
				_, _ = s.d.Store.Transition(s.sessionID, model.StatusDetached)
			}
		} else {
			_ = s.d.Store.ForceStatus(s.sessionID, model.StatusTerminated)
		}
	}
	if hs, ok := s.d.Tmux.GetPaneHistorySize(s.session.TmuxSessionName); ok {
		_, _ = s.d.Store.UpdateActivityIfOffsetChanged(s.sessionID, int64(hs))
	}
	if updated != nil && updated.AgentSessionID != nil && *updated.AgentSessionID != "" {
		if info, err := jsonl.GetLatestTurnInfo(*updated.AgentSessionID, updated.Cwd, 0); err == nil && info.TurnTs > 0 {
			_ = s.d.Store.UpdateLastTurnAt(s.sessionID, info.TurnTs)
		}
	}
}

// ---- helpers --------------------------------------------------------------

func pidWaitingForAUQ(pid *int) bool {
	if pid == nil {
		return false
	}
	_, hintType, ok := claudestat.GetPIDWaitingState(*pid)
	return ok && hintType == "auq"
}

func wsWriteJSON(ctx context.Context, c *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.Write(wctx, websocket.MessageText, b)
}

func queryInt(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func endsWithNewline(s string) bool {
	return len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r')
}

func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
