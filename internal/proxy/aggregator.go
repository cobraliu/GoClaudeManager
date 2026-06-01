package proxy

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// SnapshotInterval is how often (at most) an in-flight SSE aggregation is
// flushed to disk while streaming, mirroring the Python SNAPSHOT_INTERVAL_S.
const SnapshotInterval = 500 * time.Millisecond

// block is the evolving state for one content block in the assistant message.
// It uses a free-form map so we faithfully echo whatever Anthropic sends in
// content_block_start plus the deltas we accumulate, matching the Python
// StreamAggregator which mutated a plain dict.
type block map[string]any

// snapshotPayload is the on-disk JSON shape, identical to the Python payload:
//
//	{"session_id","request_id","ts_ns","kind","content":[...]}
type snapshotPayload struct {
	SessionID string `json:"session_id"`
	RequestID string `json:"request_id"`
	TsNs      int64  `json:"ts_ns"`
	Kind      string `json:"kind"`
	Content   []block `json:"content"`
}

// nowNs is overridable in tests for deterministic ts_ns values.
var nowNs = func() int64 { return time.Now().UnixNano() }

// monoNow is overridable in tests for deterministic snapshot throttling.
var monoNow = time.Now

// StreamAggregator consumes Anthropic SSE events and maintains an evolving
// content[] array, snapshotting it to disk. It is NOT safe for concurrent use;
// a single request goroutine drives it, matching the single-threaded asyncio
// model of the Python original.
type StreamAggregator struct {
	sessionID  string
	sessionDir string
	requestID  string
	blocks     map[int]block
	lastSnap   time.Time
	dirty      bool
	log        *slog.Logger

	// per-request counters for the access log line
	EventsSeen     int
	SnapshotsTaken int
}

// NewStreamAggregator builds an aggregator that writes snapshots into
// sessionDir (which must already exist).
func NewStreamAggregator(sessionID, sessionDir string, log *slog.Logger) *StreamAggregator {
	if log == nil {
		log = slog.Default()
	}
	return &StreamAggregator{
		sessionID:  sessionID,
		sessionDir: sessionDir,
		blocks:     make(map[int]block),
		log:        log,
	}
}

// Dirty reports whether there is unsnapshotted content. Used by the final-flush
// safety net so we never double-write after a successful terminal flush.
func (a *StreamAggregator) Dirty() bool { return a.dirty }

// sseEvent is one parsed SSE event: a name and its decoded JSON data object.
type sseEvent struct {
	name string
	data map[string]any
}

// FeedEvent applies one SSE event to the aggregation. Errors in individual
// events are logged at debug and swallowed, matching the Python behaviour
// (a malformed delta should not abort the whole stream tap).
func (a *StreamAggregator) FeedEvent(ev sseEvent) {
	a.EventsSeen++
	defer func() {
		if r := recover(); r != nil {
			a.log.Debug("aggregator feed error", "event", ev.name, "err", r)
		}
	}()

	switch ev.name {
	case "message_start":
		if msg, ok := ev.data["message"].(map[string]any); ok {
			if id, ok := msg["id"].(string); ok {
				a.requestID = id
			}
		}
	case "content_block_start":
		idx, ok := asIndex(ev.data["index"])
		if !ok {
			return
		}
		blk := block{}
		if cb, ok := ev.data["content_block"].(map[string]any); ok {
			for k, v := range cb {
				blk[k] = v
			}
		}
		a.blocks[idx] = blk
		a.dirty = true
	case "content_block_delta":
		idx, ok := asIndex(ev.data["index"])
		if !ok {
			return
		}
		delta, _ := ev.data["delta"].(map[string]any)
		a.applyDelta(idx, delta)
		a.dirty = true
	case "content_block_stop":
		idx, ok := asIndex(ev.data["index"])
		if !ok {
			return
		}
		if blk := a.blocks[idx]; blk != nil {
			if raw, ok := blk["_partial_json"].(string); ok {
				delete(blk, "_partial_json")
				if raw != "" {
					var parsed any
					if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
						blk["input"] = parsed
					} else {
						blk["input"] = map[string]any{"_raw": raw}
					}
				}
			}
		}
		a.dirty = true
	}
}

func (a *StreamAggregator) applyDelta(idx int, delta map[string]any) {
	blk := a.blocks[idx]
	if blk == nil {
		blk = block{}
		a.blocks[idx] = blk
	}
	dtype, _ := delta["type"].(string)
	switch dtype {
	case "text_delta":
		if _, ok := blk["type"]; !ok {
			blk["type"] = "text"
		}
		prev, _ := blk["text"].(string)
		add, _ := delta["text"].(string)
		blk["text"] = prev + add
	case "input_json_delta":
		if _, ok := blk["type"]; !ok {
			blk["type"] = "tool_use"
		}
		prev, _ := blk["_partial_json"].(string)
		add, _ := delta["partial_json"].(string)
		blk["_partial_json"] = prev + add
	case "thinking_delta":
		if _, ok := blk["type"]; !ok {
			blk["type"] = "thinking"
		}
		prev, _ := blk["thinking"].(string)
		add, _ := delta["thinking"].(string)
		blk["thinking"] = prev + add
	case "signature_delta":
		prev, _ := blk["signature"].(string)
		add, _ := delta["signature"].(string)
		blk["signature"] = prev + add
	}
}

// MaybeSnapshot writes a snapshot to disk. For kind=="snapshot" it is throttled
// to at most one write per SnapshotInterval and skips when nothing is dirty.
// kind=="final" always writes (when dirty). Returns true if a file was written.
func (a *StreamAggregator) MaybeSnapshot(kind string) bool {
	now := monoNow()
	if kind == "snapshot" {
		if !a.dirty {
			return false
		}
		if now.Sub(a.lastSnap) < SnapshotInterval {
			return false
		}
	}

	idxs := make([]int, 0, len(a.blocks))
	for idx := range a.blocks {
		idxs = append(idxs, idx)
	}
	sort.Ints(idxs)

	content := make([]block, 0, len(idxs))
	for _, idx := range idxs {
		// shallow copy so we can strip _partial_json without mutating live state
		blk := block{}
		for k, v := range a.blocks[idx] {
			blk[k] = v
		}
		if raw, ok := blk["_partial_json"]; ok {
			delete(blk, "_partial_json")
			if _, has := blk["input"]; !has {
				blk["input"] = map[string]any{"_partial_raw": raw}
				blk["partial"] = true
			}
		}
		content = append(content, blk)
	}

	payload := snapshotPayload{
		SessionID: a.sessionID,
		RequestID: a.requestID,
		TsNs:      nowNs(),
		Kind:      kind,
		Content:   content,
	}

	// Mark non-dirty before the write so any subsequent FeedEvent re-flags
	// dirty and earns a fresh snapshot (matches the Python ordering).
	a.lastSnap = now
	a.dirty = false

	if a.writeSnapshot(payload) {
		a.SnapshotsTaken++
		return true
	}
	return false
}

// writeSnapshot performs an atomic temp-file write + rename of one snapshot.
func (a *StreamAggregator) writeSnapshot(payload snapshotPayload) bool {
	data, err := json.Marshal(payload)
	if err != nil {
		a.log.Warn("snapshot marshal failed", "session", a.sessionID, "err", err)
		return false
	}
	name := jsonName(payload.TsNs)
	final := filepath.Join(a.sessionDir, name)
	tmp := filepath.Join(a.sessionDir, "."+name+".tmp")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		a.log.Warn("snapshot write failed", "path", final, "err", err)
		return false
	}
	if err := os.Rename(tmp, final); err != nil {
		a.log.Warn("snapshot rename failed", "path", final, "err", err)
		_ = os.Remove(tmp)
		return false
	}
	a.log.Debug("snapshot", "session", payload.SessionID, "kind", payload.Kind,
		"blocks", len(payload.Content), "path", final)
	return true
}

func jsonName(ts int64) string {
	return itoa(ts) + ".json"
}

// itoa avoids importing strconv just for one call site; ts_ns is non-negative.
func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// asIndex coerces an SSE "index" field (JSON numbers decode to float64) into an
// int. Returns ok=false for missing/non-numeric values.
func asIndex(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	}
	return 0, false
}
