package jsonl

import (
	"bufio"
	"io"
	"log/slog"
	"os"
	"sort"
	"sync"
	"time"
)

// Eviction bounds. Before P6 the entries map only ever held the live sessions
// the status loop polled; once the global-listing path feeds it, it would
// otherwise accumulate one (potentially large) entry per JSONL ever browsed on
// the machine. A TTL reclaims idle entries; a hard cap bounds the worst case.
const (
	cacheMaxEntries = 512
	cacheEntryTTL   = 15 * time.Minute
	cacheSweepEvery = 60 * time.Second
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

	// lastSweepNano throttles the O(n) eviction sweep; see maybeEvictLocked.
	lastSweepNano int64
}

// NewCache returns an empty incremental parse cache.
func NewCache() *Cache {
	return &Cache{entries: map[string]*cacheEntry{}}
}

type cacheEntry struct {
	size       int64
	mtime      int64 // UnixNano
	offset     int64 // byte offset of the first not-yet-parsed line
	lastAccess int64 // UnixNano of the last sync, for TTL/LRU eviction

	goals       *goalState
	todos       *todoState
	conv        *convState
	planOutstanding map[string]struct{}
	// subagent accumulates token/metric state when this entry is a sub-agent
	// transcript; toolResults maps a tool_use id → is_error for any tool_result
	// in this entry (used on a PARENT transcript to resolve sub-agent status
	// authoritatively via meta.json's toolUseId). Each entry carries both; only
	// the relevant one is read per use.
	subagent    *subagentState
	toolResults map[string]bool

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
		subagent:        newSubagentState(),
		toolResults:     map[string]bool{},
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
	now := time.Now().UnixNano()
	e.lastAccess = now
	c.maybeEvictLocked(now)

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

// maybeEvictLocked reclaims cache entries. It is a no-op unless the map is over
// the hard cap or it has been ≥cacheSweepEvery since the last sweep, so the
// O(n) scan is amortized away from the common cache-hit path. Caller holds c.mu.
//
//   - TTL pass: drop entries untouched for ≥cacheEntryTTL (idle sessions).
//   - hard cap: if still over cacheMaxEntries, drop the least-recently-accessed
//     entries down to the cap.
//
// The entry just accessed by the calling sync has the freshest lastAccess, so
// it is never the one evicted here.
func (c *Cache) maybeEvictLocked(now int64) {
	over := len(c.entries) > cacheMaxEntries
	if !over && now-c.lastSweepNano < int64(cacheSweepEvery) {
		return
	}
	c.lastSweepNano = now

	ttl := int64(cacheEntryTTL)
	for path, e := range c.entries {
		if now-e.lastAccess > ttl {
			delete(c.entries, path)
		}
	}
	if len(c.entries) <= cacheMaxEntries {
		return
	}
	type pe struct {
		path string
		ts   int64
	}
	all := make([]pe, 0, len(c.entries))
	for p, e := range c.entries {
		all = append(all, pe{p, e.lastAccess})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].ts < all[j].ts })
	for i := 0; i < len(all)-cacheMaxEntries; i++ {
		delete(c.entries, all[i].path)
	}
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

	// Sub-agent token/metric accumulator (only meaningful for a sub-agent
	// transcript; harmless on a parent — its result is simply never read).
	e.subagent.feed(&d)

	// Parent tool_result map: id → is_error. Lets ListSubagentSummaries resolve
	// a sub-agent's status authoritatively from the parent's Task tool_result.
	if containsBytes(line, "tool_result") && d.Message != nil {
		for _, b := range d.Message.blocks() {
			if b.Type == "tool_result" && b.ToolUseID != "" {
				e.toolResults[b.ToolUseID] = b.IsError
			}
		}
	}

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

// subagentSummary returns a snapshot of the sub-agent accumulator for the
// transcript at path, parsing only appended bytes. Returns a zero state if the
// file cannot be read.
func (c *Cache) subagentSummary(path string) *subagentState {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.sync(path)
	if e == nil {
		return newSubagentState()
	}
	return e.subagent.clone()
}

// parentToolResults returns a snapshot of the {tool_use id → is_error} map for
// the parent transcript at path, parsing only appended bytes. Returns an empty
// map if the file cannot be read.
func (c *Cache) parentToolResults(path string) map[string]bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.sync(path)
	if e == nil {
		return map[string]bool{}
	}
	out := make(map[string]bool, len(e.toolResults))
	for k, v := range e.toolResults {
		out[k] = v
	}
	return out
}

// Invalidate drops the cached entry for jsonlPath, forcing a full reparse on the
// next access. Useful when the caller's file-watcher sees a delete/rename.
func (c *Cache) Invalidate(jsonlPath string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, jsonlPath)
}
