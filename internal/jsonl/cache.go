package jsonl

import (
	"bufio"
	"io"
	"log/slog"
	"os"
	"sync"
)

// Cache is an in-memory incremental parser keyed by absolute file path and
// invalidated by (size, mtime).
//
// The session JSONL is append-only, so derived state only ever grows. Each
// cached entry remembers the byte offset of the last fully-parsed line and the
// accumulator states (goals / todos / conversation / plan-pending). On a poll:
//
//   - file unchanged (same size+mtime)  → return cached derived state, no I/O
//     beyond the stat;
//   - file grew                         → seek to the cached offset and parse
//     ONLY the appended bytes, advancing each accumulator;
//   - file shrank or mtime moved back   → full rescan from offset 0 (the file
//     was rewritten/compacted).
//
// This replaces the Python full-file re-parse + 30s TTL. A Cache is safe for
// concurrent use.
type Cache struct {
	mu      sync.Mutex
	entries map[string]*cacheEntry
}

// NewCache returns an empty incremental parse cache.
func NewCache() *Cache {
	return &Cache{entries: map[string]*cacheEntry{}}
}

type cacheEntry struct {
	size   int64
	mtime  int64 // UnixNano
	offset int64 // byte offset of the first not-yet-parsed line

	goals       *goalState
	todos       *todoState
	conv        *convState
	planOutstanding map[string]struct{}

	// user-prompt accumulators for enrich/turn derivations
	userMsgs       []string
	userTimestamps []string
	allTexts       []string
}

func newCacheEntry() *cacheEntry {
	return &cacheEntry{
		goals:           newGoalState(),
		todos:           newTodoState(),
		conv:            newConvState(),
		planOutstanding: map[string]struct{}{},
	}
}

// sync ensures the cache entry for jsonlPath reflects the current file contents,
// parsing only appended bytes when possible. Returns the up-to-date entry, or
// nil if the file cannot be stat'd/opened. Caller must hold c.mu.
func (c *Cache) sync(jsonlPath string) *cacheEntry {
	fi, err := os.Stat(jsonlPath)
	if err != nil {
		slog.Debug("jsonl cache: stat failed", "path", jsonlPath, "err", err)
		return nil
	}
	size := fi.Size()
	mtime := fi.ModTime().UnixNano()

	e := c.entries[jsonlPath]
	if e == nil {
		e = newCacheEntry()
		c.entries[jsonlPath] = e
	}

	// Unchanged → cache hit, no parsing.
	if e.offset != 0 && size == e.size && mtime == e.mtime {
		return e
	}
	// Shrank or rewritten → full rescan.
	if size < e.offset || (e.offset > 0 && mtime < e.mtime && size <= e.size) {
		fresh := newCacheEntry()
		c.entries[jsonlPath] = fresh
		e = fresh
	}

	start := e.offset
	if start > size {
		start = 0
	}
	if size == start {
		// No new bytes (e.g. mtime touched but content identical).
		e.size = size
		e.mtime = mtime
		return e
	}

	f, err := os.Open(jsonlPath)
	if err != nil {
		slog.Debug("jsonl cache: open failed", "path", jsonlPath, "err", err)
		return e
	}
	defer f.Close()
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		slog.Debug("jsonl cache: seek failed", "path", jsonlPath, "err", err)
		return e
	}

	consumed := start
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if err == io.EOF {
			// A trailing line without '\n' is incomplete (mid-write); leave it
			// for the next poll by not advancing `consumed` past it.
			break
		}
		if err != nil {
			slog.Debug("jsonl cache: read failed", "path", jsonlPath, "err", err)
			break
		}
		consumed += int64(len(line))
		// Trim the trailing newline (and any CR) before decoding.
		trimmed := line
		for len(trimmed) > 0 && (trimmed[len(trimmed)-1] == '\n' || trimmed[len(trimmed)-1] == '\r') {
			trimmed = trimmed[:len(trimmed)-1]
		}
		if len(trimmed) == 0 {
			continue
		}
		e.feedLine(trimmed)
	}

	e.offset = consumed
	e.size = size
	e.mtime = mtime
	return e
}

// feedLine routes one complete JSONL line into every accumulator. It applies
// the same byte pre-filters as the Python hot paths to skip json.Unmarshal on
// lines that cannot contribute to a given derivation.
func (e *cacheEntry) feedLine(line []byte) {
	d, ok := decodeLine(line)
	if !ok {
		return
	}

	// Conversation + enrich/turn accumulators (every line may matter).
	e.conv.feed(&d)

	switch {
	case isUserMessage(&d):
		text := extractText(d.Message)
		if text != "" && !isCompactMessage(text) {
			e.allTexts = append(e.allTexts, truncate(text, 500))
			e.userMsgs = append(e.userMsgs, text)
			if d.Timestamp != "" {
				e.userTimestamps = append(e.userTimestamps, d.Timestamp)
			}
		}
	case d.Type == "queue-operation" && d.Operation == "enqueue":
		content := d.queueContentString()
		if content != "" && !isCompactMessage(content) {
			e.allTexts = append(e.allTexts, truncate(content, 500))
			e.userMsgs = append(e.userMsgs, content)
		}
	case d.Type == "assistant":
		text := extractText(d.Message)
		if text != "" {
			e.allTexts = append(e.allTexts, truncate(text, 500))
		}
	}

	// Goals.
	if d.Type == "attachment" && d.Attachment != nil && d.Attachment.Type == "goal_status" {
		e.goals.feed(&d)
	}

	// Todos / plans.
	if containsBytes(line, "TodoWrite") || containsBytes(line, "TaskCreate") ||
		containsBytes(line, "TaskUpdate") || containsBytes(line, "task_reminder") {
		e.todos.feed(&d)
	}

	// Plan-pending.
	feedPlanLine(line, e.planOutstanding)
}

// ── Cached derivations ───────────────────────────────────────────────────────

// Enrich returns the enrich_session result for the session at jsonlPath,
// using the incremental cache.
func (c *Cache) Enrich(jsonlPath string) EnrichResult {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.sync(jsonlPath)
	if e == nil {
		return EnrichResult{Prompts: []string{}, SearchText: []string{}}
	}
	res := EnrichResult{Prompts: []string{}, SearchText: append([]string(nil), e.allTexts...)}
	if res.SearchText == nil {
		res.SearchText = []string{}
	}
	if len(e.userMsgs) > 0 {
		res.Title = strPtr(truncate(e.userMsgs[0], 80))
		res.Prompts = append(res.Prompts, truncate(e.userMsgs[0], 200))
		if len(e.userMsgs) >= 2 {
			res.Prompts = append(res.Prompts, truncate(e.userMsgs[len(e.userMsgs)-1], 200))
		}
	}
	if len(e.userTimestamps) > 0 {
		res.LastUserInputAt = strPtr(e.userTimestamps[len(e.userTimestamps)-1])
	}
	return res
}

// Goals returns the read_goals result via the incremental cache.
func (c *Cache) Goals(jsonlPath string) GoalsResult {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.sync(jsonlPath)
	if e == nil {
		return GoalsResult{History: []Goal{}}
	}
	return e.goals.clone().result()
}

// TodoPlans returns the get_todo_plans result via the incremental cache.
func (c *Cache) TodoPlans(jsonlPath string) TodoPlansResult {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.sync(jsonlPath)
	if e == nil {
		return TodoPlansResult{Active: []Todo{}, History: []TodoPlan{}}
	}
	return e.todos.clone().result()
}

// Conversation returns the get_conversation result (turns with ts > fromTs plus
// the in-progress exchange) via the incremental cache.
func (c *Cache) Conversation(jsonlPath string, fromTs float64) []ConversationTurn {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.sync(jsonlPath)
	if e == nil {
		return []ConversationTurn{}
	}
	return e.conv.clone().result(fromTs)
}

// PlanPending returns whether an ExitPlanMode is awaiting a decision, via the
// incremental cache.
func (c *Cache) PlanPending(jsonlPath string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.sync(jsonlPath)
	if e == nil {
		return false
	}
	return len(e.planOutstanding) > 0
}

// Invalidate drops the cached entry for jsonlPath, forcing a full reparse on the
// next access. Useful when the caller's file-watcher sees a delete/rename.
func (c *Cache) Invalidate(jsonlPath string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, jsonlPath)
}
