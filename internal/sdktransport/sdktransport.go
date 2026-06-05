// Package sdktransport drives claude sessions running the claude-structured
// wrapper (the SDK transport, transport="sdk").
//
// Topology: the wrapper's Ink TUI lives in a tmux pane exactly like a normal
// claude session (restart survival + xterm.js attach unchanged), but instead
// of send-keys/capture-pane screen-scraping the Go server talks a typed NDJSON
// protocol over two per-session channels in <DataDir>/sdk/<sessionID>/:
//
//	json-in   a FIFO the wrapper tails (reopen loop) — Go writes one JSON
//	          line per message: {"type":"user",...} for prompts,
//	          {"type":"respond",...} for AUQ/plan answers,
//	          {"type":"control",...} for interrupt/set_model.
//	json-out  a regular append-only file of normalized StructuredEvent NDJSON
//	          the wrapper tees — Go tails it (the pump) to learn the agent
//	          session id, streaming text, pending AUQ/plan prompts, etc.
//
// The Manager owns one pump per started session and exposes the wrapper-side
// state to status.Compute and the API handlers.
package sdktransport

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/loki/goclaudemanager/internal/store"
)

// Pending describes an unanswered interactive prompt surfaced by the wrapper.
type Pending struct {
	ToolUseID string
	// Data is ready-to-serve tui_auq_data / tui_plan_data for status.Compute.
	Data map[string]any
}

// State is the live wrapper-side view of one sdk session.
type State struct {
	AgentSessionID string
	IsStreaming    bool
	PendingAUQ     *Pending
	PendingPlan    *Pending
}

// Manager owns the per-session pumps and the json-in writers.
type Manager struct {
	store   *store.Store
	dataDir string // CLAUDEMANAGER_DATA_DIR, "" = dev layout (./data)

	mu    sync.Mutex
	pumps map[string]*pump
}

// New builds the Manager. dataDir mirrors config.Env.DataDir semantics.
func New(st *store.Store, dataDir string) *Manager {
	return &Manager{store: st, dataDir: dataDir, pumps: map[string]*pump{}}
}

// RuntimeDir is <DataDir>/sdk/<sessionID> (dev fallback ./data/sdk/<id>),
// stable across server restarts so a surviving wrapper keeps its channels.
// Always absolute: the paths are handed to the wrapper as --json-in/--json-out
// flags, and the wrapper's cwd is the session workspace — a relative path
// would resolve against the wrong directory and kill the spawn with ENOENT.
func (m *Manager) RuntimeDir(sessionID string) string {
	base := m.dataDir
	if base == "" {
		base = "data"
	}
	if abs, err := filepath.Abs(base); err == nil {
		base = abs
	}
	return filepath.Join(base, "sdk", sessionID)
}

// JSONInPath / JSONOutPath are the channel file paths inside RuntimeDir.
func (m *Manager) JSONInPath(sessionID string) string {
	return filepath.Join(m.RuntimeDir(sessionID), "json-in")
}
func (m *Manager) JSONOutPath(sessionID string) string {
	return filepath.Join(m.RuntimeDir(sessionID), "json-out")
}

// EnsureChannels creates the runtime dir, the json-in FIFO and an empty
// json-out file if missing, returning both paths. Existing channels (and any
// json-out content) are left as-is — use ResetChannels for a fresh spawn.
func (m *Manager) EnsureChannels(sessionID string) (jsonIn, jsonOut string, err error) {
	dir := m.RuntimeDir(sessionID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", fmt.Errorf("sdk runtime dir: %w", err)
	}
	jsonIn = m.JSONInPath(sessionID)
	if err := syscall.Mkfifo(jsonIn, 0o600); err != nil && !errors.Is(err, os.ErrExist) {
		return "", "", fmt.Errorf("mkfifo json-in: %w", err)
	}
	jsonOut = m.JSONOutPath(sessionID)
	f, err := os.OpenFile(jsonOut, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return "", "", fmt.Errorf("create json-out: %w", err)
	}
	_ = f.Close()
	return jsonIn, jsonOut, nil
}

// ResetChannels is EnsureChannels plus truncating json-out. Call before
// spawning a NEW wrapper process (create/resume) so the pump never replays a
// previous run's events; never call it for a surviving wrapper (reconcile).
func (m *Manager) ResetChannels(sessionID string) (jsonIn, jsonOut string, err error) {
	jsonIn, jsonOut, err = m.EnsureChannels(sessionID)
	if err != nil {
		return "", "", err
	}
	if err := os.Truncate(jsonOut, 0); err != nil {
		return "", "", fmt.Errorf("truncate json-out: %w", err)
	}
	return jsonIn, jsonOut, nil
}

// Start launches (or restarts) the json-out pump for a session. Idempotent:
// an existing pump is stopped first. Replay from offset 0 rebuilds streaming/
// pending state after a server restart.
func (m *Manager) Start(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if old, ok := m.pumps[sessionID]; ok {
		old.stop()
	}
	p := newPump(sessionID, m.JSONOutPath(sessionID), m.store)
	m.pumps[sessionID] = p
	go p.run()
}

// Stop halts the pump for a session (the wrapper itself is owned by tmux).
func (m *Manager) Stop(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.pumps[sessionID]; ok {
		p.stop()
		delete(m.pumps, sessionID)
	}
}

// StopAll halts every pump (server shutdown).
func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, p := range m.pumps {
		p.stop()
		delete(m.pumps, id)
	}
}

// State returns the live wrapper-side state, if the session has a pump.
func (m *Manager) State(sessionID string) (State, bool) {
	m.mu.Lock()
	p, ok := m.pumps[sessionID]
	m.mu.Unlock()
	if !ok {
		return State{}, false
	}
	return p.snapshot(), true
}

// Send delivers a user turn. The shape matches what the wrapper's own
// session.send() builds, delivered via json-in "user" → session.pushRaw().
// JSON-encoding (vs a plain-text line) keeps multi-line prompts as one turn.
func (m *Manager) Send(sessionID, text string) error {
	return m.writeLine(sessionID, map[string]any{
		"type":               "user",
		"message":            map[string]any{"role": "user", "content": text},
		"parent_tool_use_id": nil,
	})
}

// Respond resolves the wrapper's current interaction (AUQ answer, plan
// decision). payload shape is kind-specific — see the json-in protocol in
// rewriteCodeCli/tui/run.tsx dispatchJsonIn.
func (m *Manager) Respond(sessionID, toolUseID string, payload any) error {
	return m.writeLine(sessionID, map[string]any{
		"type":      "respond",
		"toolUseId": toolUseID,
		"payload":   payload,
	})
}

// Control sends a control action: "interrupt", "set_model" {model},
// "set_permission_mode" {mode}. extra keys are merged into the message.
func (m *Manager) Control(sessionID, action string, extra map[string]any) error {
	msg := map[string]any{"type": "control", "action": action}
	for k, v := range extra {
		msg[k] = v
	}
	return m.writeLine(sessionID, msg)
}

// writeLine appends one NDJSON line to the session's json-in FIFO using
// open-write-close per message. O_NONBLOCK makes open fail with ENXIO instead
// of blocking forever when the wrapper isn't reading (dead pane, mid-reopen);
// we retry briefly to ride out the wrapper's 50ms reopen loop, then surface a
// clear error so callers can fall back to the lost-message registry.
func (m *Manager) writeLine(sessionID string, obj any) error {
	b, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	path := m.JSONInPath(sessionID)
	deadline := time.Now().Add(3 * time.Second)
	for {
		f, err := os.OpenFile(path, os.O_WRONLY|syscall.O_NONBLOCK, 0)
		if err == nil {
			_, werr := f.Write(b)
			_ = f.Close()
			if werr != nil {
				return fmt.Errorf("sdk json-in write: %w", werr)
			}
			return nil
		}
		if !errors.Is(err, syscall.ENXIO) || time.Now().After(deadline) {
			return fmt.Errorf("sdk session not reading json-in (wrapper down?): %w", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
