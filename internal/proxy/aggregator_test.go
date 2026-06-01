package proxy

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// silentLogger discards output so tests stay quiet.
func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// readLatestSnapshot returns the parsed payload of the highest-ts_ns snapshot
// file in dir (snapshots are named {ts_ns}.json).
func readLatestSnapshot(t *testing.T, dir string) snapshotPayload {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") && !strings.HasPrefix(e.Name(), ".") {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		t.Fatalf("no snapshot files written in %s", dir)
	}
	sort.Strings(names) // ts_ns is monotonic in our test clock, lexical works
	data, err := os.ReadFile(filepath.Join(dir, names[len(names)-1]))
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	var p snapshotPayload
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	return p
}

// feedRaw parses an SSE wire string and feeds every event through the
// aggregator, snapshotting "final" on message_stop, exactly as the proxy loop
// does. It returns nothing; assertions read from disk.
func feedRaw(agg *StreamAggregator, raw string) {
	events, _ := parseSSEChunk(raw)
	for _, ev := range events {
		agg.FeedEvent(ev)
		if ev.name == "message_stop" {
			agg.MaybeSnapshot("final")
		}
	}
}

func TestAggregateTextAndToolUse(t *testing.T) {
	dir := t.TempDir()
	agg := NewStreamAggregator("sess-1", dir, silentLogger())

	// A complete Anthropic message stream: one text block (split across two
	// deltas) followed by one tool_use block whose input arrives as partial
	// JSON deltas, then content_block_stop and message_stop.
	raw := strings.Join([]string{
		`event: message_start`,
		`data: {"type":"message_start","message":{"id":"msg_abc123","role":"assistant"}}`,
		``,
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		``,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello, "}}`,
		``,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}`,
		``,
		`event: content_block_stop`,
		`data: {"type":"content_block_stop","index":0}`,
		``,
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}`,
		``,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}`,
		``,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"SF\"}"}}`,
		``,
		`event: content_block_stop`,
		`data: {"type":"content_block_stop","index":1}`,
		``,
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		``,
		``,
	}, "\n")

	feedRaw(agg, raw)

	p := readLatestSnapshot(t, dir)
	if p.Kind != "final" {
		t.Errorf("kind = %q, want final", p.Kind)
	}
	if p.SessionID != "sess-1" {
		t.Errorf("session_id = %q, want sess-1", p.SessionID)
	}
	if p.RequestID != "msg_abc123" {
		t.Errorf("request_id = %q, want msg_abc123", p.RequestID)
	}
	if len(p.Content) != 2 {
		t.Fatalf("content len = %d, want 2: %+v", len(p.Content), p.Content)
	}

	// Block 0: text
	b0 := p.Content[0]
	if b0["type"] != "text" {
		t.Errorf("block0 type = %v, want text", b0["type"])
	}
	if b0["text"] != "Hello, world" {
		t.Errorf("block0 text = %q, want %q", b0["text"], "Hello, world")
	}

	// Block 1: tool_use with parsed input and no leftover _partial_json
	b1 := p.Content[1]
	if b1["type"] != "tool_use" {
		t.Errorf("block1 type = %v, want tool_use", b1["type"])
	}
	if b1["name"] != "get_weather" {
		t.Errorf("block1 name = %v, want get_weather", b1["name"])
	}
	if _, leftover := b1["_partial_json"]; leftover {
		t.Errorf("block1 still has _partial_json: %+v", b1)
	}
	input, ok := b1["input"].(map[string]any)
	if !ok {
		t.Fatalf("block1 input not an object: %T %v", b1["input"], b1["input"])
	}
	if input["city"] != "SF" {
		t.Errorf("block1 input.city = %v, want SF", input["city"])
	}
}

func TestSnapshotThrottleAndDirty(t *testing.T) {
	dir := t.TempDir()
	agg := NewStreamAggregator("sess-2", dir, silentLogger())

	// Drive a deterministic monotonic clock.
	base := time.Unix(1000, 0)
	cur := base
	oldMono := monoNow
	monoNow = func() time.Time { return cur }
	defer func() { monoNow = oldMono }()

	// First snapshot with no content: nothing dirty → no write.
	if agg.MaybeSnapshot("snapshot") {
		t.Fatal("snapshot written despite nothing dirty")
	}

	// Feed a delta → dirty. Throttle window not elapsed since lastSnap=zero,
	// but first call: lastSnap is zero so Sub is huge → writes.
	feedRaw(agg, "event: content_block_delta\ndata: {\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n")
	if !agg.MaybeSnapshot("snapshot") {
		t.Fatal("first dirty snapshot should write")
	}

	// Immediately feed more and snapshot again within the throttle window:
	// should be skipped (interval not elapsed).
	feedRaw(agg, "event: content_block_delta\ndata: {\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" there\"}}\n\n")
	if agg.MaybeSnapshot("snapshot") {
		t.Fatal("snapshot within throttle window should be skipped")
	}

	// Advance past the interval → should write.
	cur = cur.Add(SnapshotInterval + time.Millisecond)
	if !agg.MaybeSnapshot("snapshot") {
		t.Fatal("snapshot after interval should write")
	}

	p := readLatestSnapshot(t, dir)
	if p.Content[0]["text"] != "hi there" {
		t.Errorf("text = %q, want %q", p.Content[0]["text"], "hi there")
	}
}

func TestPartialToolInputSnapshot(t *testing.T) {
	dir := t.TempDir()
	agg := NewStreamAggregator("sess-3", dir, silentLogger())

	// tool_use whose JSON input has NOT finished (no content_block_stop yet):
	// the snapshot should expose the raw partial under input._partial_raw and
	// flag partial=true, matching the Python mid-stream behaviour.
	feedRaw(agg, strings.Join([]string{
		`event: content_block_start`,
		`data: {"index":0,"content_block":{"type":"tool_use","id":"t1","name":"f"}}`,
		``,
		`event: content_block_delta`,
		`data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\"a\":1"}}`,
		``,
		``,
	}, "\n"))

	if !agg.MaybeSnapshot("final") {
		t.Fatal("final snapshot should write")
	}
	p := readLatestSnapshot(t, dir)
	b0 := p.Content[0]
	if b0["partial"] != true {
		t.Errorf("expected partial=true, got %v", b0["partial"])
	}
	input, ok := b0["input"].(map[string]any)
	if !ok {
		t.Fatalf("input not object: %v", b0["input"])
	}
	if input["_partial_raw"] != `{"a":1` {
		t.Errorf("_partial_raw = %v, want %q", input["_partial_raw"], `{"a":1`)
	}
}
