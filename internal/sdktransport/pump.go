package sdktransport

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/loki/goclaudemanager/internal/store"
)

// pump tails one session's json-out NDJSON file and folds the events into a
// State. On start it replays from offset 0 (cheap: json-out is truncated on
// every fresh wrapper spawn) so a server restart rebuilds streaming/pending
// state; resolution events (interaction_resolved / tool_result / turn_complete)
// come after their prompts in the append-only file, so replay converges to
// exactly the still-pending interactions.
//
// It also writes streaming-preview snapshots into the same
// ~/.claude/cached_messages/<agentSID>/ tree the anthropic tap proxy uses, in
// the identical payload shape — so the existing mergeProxySnapshots read path
// (and the frontend) need zero changes for sdk sessions.
type pump struct {
	sessionID string
	jsonOut   string
	store     *store.Store

	quit chan struct{}
	once sync.Once

	mu sync.Mutex
	st State

	// snapshot-writer state (touched only by the run goroutine).
	replay    bool      // true while draining pre-existing json-out content
	seq       int       // per-stream-segment counter → synthetic request_id
	content   []block   // evolving content[] for the current segment
	lastWrite time.Time // throttle (≥500ms between snapshot files)
	lastFile  string    // previous snapshot file, removed on each rewrite

	lastTouch time.Time // throttle for store.UpdateActivity (≥2s)
}

// block is one snapshot content block ({"type":"text","text":...} or
// {"type":"thinking","thinking":...}) matching the proxy aggregator's shape.
type block map[string]any

func newPump(sessionID, jsonOut string, st *store.Store) *pump {
	return &pump{sessionID: sessionID, jsonOut: jsonOut, store: st, quit: make(chan struct{})}
}

func (p *pump) stop() { p.once.Do(func() { close(p.quit) }) }

func (p *pump) snapshot() State {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.st
	if s.PendingAUQ != nil {
		cp := *s.PendingAUQ
		s.PendingAUQ = &cp
	}
	if s.PendingPlan != nil {
		cp := *s.PendingPlan
		s.PendingPlan = &cp
	}
	return s
}

// run is the tail loop: read newly appended bytes every 150ms, split into
// lines (carrying partial trailing lines across reads), dispatch each event.
func (p *pump) run() {
	var offset int64
	var carry []byte
	p.replay = true
	for {
		fi, err := os.Stat(p.jsonOut)
		if err == nil {
			if fi.Size() < offset {
				// json-out was truncated (fresh wrapper spawn) — start over.
				offset, carry = 0, nil
				p.resetForTruncate()
			}
			if fi.Size() > offset {
				data, n, err := readChunk(p.jsonOut, offset)
				if err == nil && n > 0 {
					offset += int64(n)
					carry = append(carry, data...)
					for {
						idx := bytes.IndexByte(carry, '\n')
						if idx < 0 {
							break
						}
						line := carry[:idx]
						carry = carry[idx+1:]
						p.handleLine(line)
					}
				}
			}
		}
		// First full drain done → subsequent events are live.
		if p.replay {
			if fi2, err2 := os.Stat(p.jsonOut); err2 != nil || fi2.Size() <= offset {
				p.replay = false
			}
		}
		select {
		case <-p.quit:
			p.removeLastSnapshot()
			return
		case <-time.After(150 * time.Millisecond):
		}
	}
}

// readChunk reads up to 4MB starting at offset. The file is append-only, so a
// short read just means more next tick.
func readChunk(path string, offset int64) ([]byte, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	if _, err := f.Seek(offset, 0); err != nil {
		return nil, 0, err
	}
	buf := make([]byte, 4<<20)
	n, err := f.Read(buf)
	if n > 0 {
		return buf[:n], n, nil
	}
	return nil, 0, err
}

// outEvent is the superset of json-out StructuredEvent fields we consume.
type outEvent struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId"` // session_start
	Text      string          `json:"text"`      // text / thinking
	Partial   bool            `json:"partial"`
	ToolUseID string          `json:"toolUseId"` // ask/plan/tool_result/interaction_resolved
	Questions json.RawMessage `json:"questions"` // ask_user_question
	Plan      string          `json:"plan"`      // plan_review
	Kind      string          `json:"kind"`      // interaction_resolved: ask|plan|permission
}

func (p *pump) handleLine(line []byte) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return
	}
	var ev outEvent
	if err := json.Unmarshal(line, &ev); err != nil {
		return
	}

	switch ev.Type {
	case "session_start":
		if ev.SessionID != "" {
			p.mu.Lock()
			changed := p.st.AgentSessionID != ev.SessionID
			p.st.AgentSessionID = ev.SessionID
			p.mu.Unlock()
			if changed {
				// The wrapper's session_start is authoritative — a --resume
				// forks to a NEW session id, so always pin the latest.
				if err := p.store.UpdateAgentSessionID(p.sessionID, ev.SessionID); err != nil {
					slog.Warn("sdk pump: pin agent_session_id failed",
						"session", p.sessionID, "err", err)
				}
			}
		}

	case "text", "thinking":
		if ev.Partial {
			p.mu.Lock()
			p.st.IsStreaming = true
			p.mu.Unlock()
			p.touchActivity()
			p.appendDelta(ev.Type, ev.Text)
			p.maybeWriteSnapshot()
		} else {
			// Authoritative block — the CLI has flushed (or is flushing) the
			// real JSONL line; retire this segment's preview snapshot.
			p.endSegment()
		}

	case "tool_use":
		p.endSegment()

	case "ask_user_question":
		var questions []map[string]any
		_ = json.Unmarshal(ev.Questions, &questions)
		p.mu.Lock()
		p.st.IsStreaming = false
		p.st.PendingAUQ = &Pending{
			ToolUseID: ev.ToolUseID,
			Data:      buildAUQData(questions),
		}
		p.mu.Unlock()
		p.endSegment()

	case "plan_review":
		p.mu.Lock()
		p.st.IsStreaming = false
		p.st.PendingPlan = &Pending{
			ToolUseID: ev.ToolUseID,
			Data:      buildPlanData(ev.Plan),
		}
		p.mu.Unlock()
		p.endSegment()

	case "interaction_resolved":
		p.mu.Lock()
		switch ev.Kind {
		case "ask":
			p.st.PendingAUQ = nil
		case "plan":
			p.st.PendingPlan = nil
		}
		p.mu.Unlock()

	case "tool_result":
		// Belt & braces: a result for the pending prompt also clears it.
		p.mu.Lock()
		if a := p.st.PendingAUQ; a != nil && a.ToolUseID == ev.ToolUseID {
			p.st.PendingAUQ = nil
		}
		if pl := p.st.PendingPlan; pl != nil && pl.ToolUseID == ev.ToolUseID {
			p.st.PendingPlan = nil
		}
		p.mu.Unlock()

	case "turn_complete", "error":
		p.mu.Lock()
		p.st.IsStreaming = false
		p.mu.Unlock()
		p.endSegment()
		// Mark the turn boundary so computeStreaming (last_activity vs
		// last_turn) clears is_streaming promptly without pane scraping.
		if !p.replay {
			_ = p.store.UpdateActivity(p.sessionID)
			_ = p.store.UpdateLastTurnAt(p.sessionID, float64(time.Now().UnixNano())/1e9)
		}
	}
}

// touchActivity bumps last_activity_at on live streaming output, throttled —
// for tmux sessions the PTY watcher does this; for sdk sessions the pump is
// the activity source.
func (p *pump) touchActivity() {
	if p.replay || time.Since(p.lastTouch) < 2*time.Second {
		return
	}
	p.lastTouch = time.Now()
	_ = p.store.UpdateActivity(p.sessionID)
}

func (p *pump) resetForTruncate() {
	p.mu.Lock()
	p.st.IsStreaming = false
	p.st.PendingAUQ = nil
	p.st.PendingPlan = nil
	p.mu.Unlock()
	p.endSegment()
	p.replay = true
}

// ── streaming-preview snapshots ────────────────────────────────────────────

// appendDelta grows the evolving content[]: consecutive deltas of the same
// type extend the last block; a type switch starts a new block.
func (p *pump) appendDelta(typ, text string) {
	if text == "" {
		return
	}
	key := "text"
	if typ == "thinking" {
		key = "thinking"
	}
	if n := len(p.content); n > 0 {
		if last := p.content[n-1]; last["type"] == typ {
			cur, _ := last[key].(string)
			last[key] = cur + text
			return
		}
	}
	p.content = append(p.content, block{"type": typ, key: text})
}

// maybeWriteSnapshot writes the current content[] as a cached_messages
// snapshot, throttled to one file per 500ms, replacing the previous file for
// this segment so at most one snapshot per in-flight request exists on disk.
func (p *pump) maybeWriteSnapshot() {
	if p.replay || len(p.content) == 0 {
		return
	}
	agentSID := func() string { p.mu.Lock(); defer p.mu.Unlock(); return p.st.AgentSessionID }()
	if agentSID == "" {
		return
	}
	if time.Since(p.lastWrite) < 500*time.Millisecond {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	dir := filepath.Join(home, ".claude", "cached_messages", agentSID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	tsNs := time.Now().UnixNano()
	payload := map[string]any{
		"session_id": agentSID,
		"request_id": fmt.Sprintf("sdk-%s-%d", shortID(p.sessionID), p.seq),
		"ts_ns":      tsNs,
		"kind":       "snapshot",
		"content":    p.content,
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	final := filepath.Join(dir, fmt.Sprintf("%d.json", tsNs))
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return
	}
	p.removeLastSnapshot()
	p.lastFile = final
	p.lastWrite = time.Now()
}

// endSegment retires the current preview: the authoritative JSONL line (or
// turn end) supersedes it, so the snapshot file is deleted and the synthetic
// request_id advances.
func (p *pump) endSegment() {
	p.removeLastSnapshot()
	p.content = nil
	p.seq++
	p.lastWrite = time.Time{}
}

func (p *pump) removeLastSnapshot() {
	if p.lastFile != "" {
		_ = os.Remove(p.lastFile)
		p.lastFile = ""
	}
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// ── tui_*_data builders ────────────────────────────────────────────────────

// buildAUQData shapes an ask_user_question event as tui_auq_data. The SDK
// gives us the raw AskUserQuestion tool input's questions array — the same
// shape claudestat.ReadSessionHooks surfaces from the PreToolUse hook, which
// the frontend already renders.
func buildAUQData(questions []map[string]any) map[string]any {
	if questions == nil {
		questions = []map[string]any{}
	}
	return map[string]any{"questions": questions}
}

// PlanOptionLabels are the synthetic plan-approval options for sdk sessions.
// The labels deliberately match what claudestat.ParsePlanMenu would extract
// from the screen so the existing frontend card and the planApprove
// label/decision resolution work unchanged. The slice position doubles as the
// option index the API resolves against (see sdkPlanApprove).
var PlanOptionLabels = []string{
	"Yes, and auto-accept edits",
	"Yes, and manually approve edits",
	"No, keep planning",
	"Tell Claude what to change",
}

// buildPlanData shapes a plan_review event as tui_plan_data (same keys and
// 0-based index convention as the screen-parsed variant in status.Compute:
// options[{index,label,highlighted}] + highlighted — the frontend echoes that
// index back on submit), plus the plan markdown for richer rendering.
func buildPlanData(plan string) map[string]any {
	opts := make([]map[string]any, len(PlanOptionLabels))
	for i, label := range PlanOptionLabels {
		opts[i] = map[string]any{
			"index":       i,
			"label":       label,
			"highlighted": i == 0,
		}
	}
	data := map[string]any{"options": opts, "highlighted": 0}
	if s := strings.TrimSpace(plan); s != "" {
		data["plan"] = s
	}
	return data
}
