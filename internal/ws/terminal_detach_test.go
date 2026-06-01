package ws

import (
	"context"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/config"
	"github.com/loki/goclaudemanager/internal/model"
	"github.com/loki/goclaudemanager/internal/store"
	"github.com/loki/goclaudemanager/internal/term"
	"github.com/loki/goclaudemanager/internal/tmux"
)

// TestDetachDoesNotTerminate is the regression test for the refresh-terminate
// bug: closing the terminal WebSocket (page refresh / weak network) must leave
// the tmux session alive and mark the session DETACHED, never TERMINATED.
func TestDetachDoesNotTerminate(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	dir := t.TempDir()
	t.Setenv("CLAUDEMANAGER_DATA_DIR", dir)
	st, err := store.Open()
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	const sock = "cm-wstest"
	tx := tmux.New(sock)
	t.Cleanup(func() { _, _ = tx.Run("kill-server") })

	const tmuxName = "wstest-sess"
	// A plain long-lived bash, standing in for the claude TUI.
	if _, err := tx.Run("new-session", "-d", "-s", tmuxName, "-x", "200", "-y", "50", "bash"); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	if !tx.HasSession(tmuxName) {
		t.Fatalf("session not created")
	}

	wsTok := "tok-123"
	s := &model.Session{
		ID:              "sess-ws",
		OwnerID:         "alice",
		Name:            "demo",
		Project:         "proj",
		Cwd:             dir,
		Tool:            "claude",
		Status:          model.StatusRunning,
		CreatedAt:       model.NowUTC(),
		UpdatedAt:       model.NowUTC(),
		TmuxSessionName: tmuxName,
		WsToken:         &wsTok,
		CodexTransport:  "tui",
	}
	if err := st.CreateSession(s); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	deps := Deps{Store: st, Tmux: tx, Auth: auth.New("secret"), Env: config.Env{}, Term: term.New(tx)}
	srv := httptest.NewServer(Router(deps))
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/sessions/sess-ws?token=" + wsTok + "&cols=200&rows=50"

	// --- First connect, then disconnect (the "refresh"). ---
	dialAndDrop(t, wsURL)

	// Give cleanup() a moment to run.
	waitStatus(t, st, "sess-ws", func(got model.SessionStatus) bool {
		return got == model.StatusDetached
	}, "detached after disconnect")

	if !tx.HasSession(tmuxName) {
		t.Fatalf("tmux session was killed by a mere disconnect")
	}

	// --- Reconnect: status must come back to running. ---
	c2 := dial(t, wsURL)
	waitStatus(t, st, "sess-ws", func(got model.SessionStatus) bool {
		return got == model.StatusRunning
	}, "running after reattach")
	_ = c2.Close(websocket.StatusNormalClosure, "")
}

func dial(t *testing.T, wsURL string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	// Read one frame so we know the pump is live.
	rctx, rcancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer rcancel()
	_, _, _ = c.Read(rctx)
	return c
}

func dialAndDrop(t *testing.T, wsURL string) {
	t.Helper()
	c := dial(t, wsURL)
	// Abruptly close the TCP connection to mimic a refresh / dropped network.
	_ = c.CloseNow()
	time.Sleep(300 * time.Millisecond)
}

func waitStatus(t *testing.T, st *store.Store, id string, ok func(model.SessionStatus) bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last model.SessionStatus
	for time.Now().Before(deadline) {
		s, err := st.GetSession(id)
		if err == nil && s != nil {
			last = s.Status
			if ok(s.Status) {
				return
			}
			if s.Status == model.StatusTerminated {
				t.Fatalf("%s: session was TERMINATED (the bug)", what)
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("%s: timed out, last status=%q", what, last)
}
