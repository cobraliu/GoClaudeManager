package jsonl

import (
	"bufio"
	"io"
	"log/slog"
	"os"
	"sort"
	"sync"
	"sync/atomic"
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
// concurrent use. Locking is per file: c.mu only guards the entries map, and
// each entry's own mu serializes parsing/reading that one transcript — so a
// cold parse of a huge (100MB+) transcript blocks only requests for that same
// file, not every other session's polls.
type Cache struct {
	mu      sync.Mutex // guards entries and lastSweepNano
	entries map[string]*cacheEntry

	// lastSweepNano throttles the O(n) eviction sweep; see maybeEvictLocked.
	lastSweepNano int64
}

// NewCache returns an empty incremental parse cache.
func NewCache() *Cache {
	return &Cache{entries: map[string]*cacheEntry{}}
}

type cacheEntry struct {
	mu sync.Mutex // guards every field below except lastAccess

	size       int64
	mtime      int64 // UnixNano
	offset     int64 // byte offset of the first not-yet-parsed line
	lastAccess int64 // UnixNano of the last acquire, for TTL/LRU eviction; guarded by Cache.mu

	goals       *goalState
	todos       *todoState
	conv        *convState
	planOutstanding map[string]struct{}
	auqs            *auqState
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

	// snap is the last Enrich result, readable without mu so listings can
	// show it while the entry is busy (see EnrichFast); warming marks a
	// background parse in progress.
	snap    atomic.Pointer[EnrichResult]
	warming atomic.Bool
}

func newCacheEntry() *cacheEntry {
	e := &cacheEntry{}
	e.reset()
	return e
}

// reset clears the parsed state (for a full rescan) in place, so goroutines
// already waiting on e.mu see the fresh state. Caller holds e.mu (or owns e).
func (e *cacheEntry) reset() {
	e.size, e.mtime, e.offset = 0, 0, 0
	e.goals = newGoalState()
	e.todos = newTodoState()
	e.conv = newConvState()
	e.planOutstanding = map[string]struct{}{}
	e.auqs = newAUQState()
	e.subagent = newSubagentState()
	e.toolResults = map[string]bool{}
	e.userMsgs, e.userTimestamps = nil, nil
}

// acquire returns the cache entry for jsonlPath synced to the current file
// contents, with its mu LOCKED (the caller must Unlock it), or nil if the file
// cannot be stat'd.
func (c *Cache) acquire(jsonlPath string) *cacheEntry {
	if jsonlPath == "" {
		return nil // transcript not found: don't cache an entry for ""
	}
	c.mu.Lock()
	e := c.entries[jsonlPath]
	if e == nil {
		e = newCacheEntry()
		c.entries[jsonlPath] = e
	}
	now := time.Now().UnixNano()
	e.lastAccess = now
	c.maybeEvictLocked(now)
	c.mu.Unlock()

	e.mu.Lock()
	if !e.sync(jsonlPath) {
		e.mu.Unlock()
		return nil
	}
	return e
}

// sync brings e up to date with the file at jsonlPath, parsing only appended
// bytes when possible. Returns false if the file cannot be stat'd. Caller holds
// e.mu.
func (e *cacheEntry) sync(jsonlPath string) bool {
	fi, err := os.Stat(jsonlPath)
	if err != nil {
		slog.Debug("jsonl cache: stat failed", "path", jsonlPath, "err", err)
		return false
	}
	size := fi.Size()
	mtime := fi.ModTime().UnixNano()

	// Unchanged → cache hit, no parsing.
	if e.offset != 0 && size == e.size && mtime == e.mtime {
		return true
	}
	// Shrank or rewritten → full rescan.
	if size < e.offset || (e.offset > 0 && mtime < e.mtime && size <= e.size) {
		e.reset()
	}

	start := e.offset
	if start > size {
		start = 0
	}
	if size == start {
		// No new bytes (e.g. mtime touched but content identical).
		e.size = size
		e.mtime = mtime
		return true
	}

	f, err := os.Open(jsonlPath)
	if err != nil {
		slog.Debug("jsonl cache: open failed", "path", jsonlPath, "err", err)
		return true
	}
	defer f.Close()
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		slog.Debug("jsonl cache: seek failed", "path", jsonlPath, "err", err)
		return true
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
	return true
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
			e.userMsgs = append(e.userMsgs, text)
			if d.Timestamp != "" {
				e.userTimestamps = append(e.userTimestamps, d.Timestamp)
			}
		}
	case d.Type == "queue-operation" && d.Operation == "enqueue":
		content := d.queueContentString()
		if content != "" && !isCompactMessage(content) {
			e.userMsgs = append(e.userMsgs, content)
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

	// AskUserQuestion rounds (the ask, or the tool_result answering it).
	if containsBytes(line, "AskUserQuestion") || containsBytes(line, "tool_result") {
		e.auqs.feed(&d)
	}

	// Plan-pending.
	feedPlanLine(line, e.planOutstanding)
}

// ── Cached derivations ───────────────────────────────────────────────────────

// Enrich returns the enrich_session result for the session at jsonlPath,
// using the incremental cache. SearchText is always empty here: the
// conversation text is no longer searched, and copying it on every listing
// was the dominant cost for large transcripts.
func (c *Cache) Enrich(jsonlPath string) EnrichResult {
	e := c.acquire(jsonlPath)
	if e == nil {
		return emptyEnrich()
	}
	defer e.mu.Unlock()
	return e.enrichLocked()
}

// enrichSyncLimit: in EnrichFast, a never-parsed transcript up to this size is
// parsed inline (well under a second); a larger one is parsed in the
// background so a listing never waits seconds on it.
const enrichSyncLimit = 8 << 20

// warmSem bounds concurrent background parses.
var warmSem = make(chan struct{}, 2)

// EnrichFast is Enrich for latency-sensitive listings (the session list and its
// search). It never waits on a transcript another request is parsing, and
// never parses a large never-seen transcript inline — a cold parse of a
// 100MB+ file takes seconds, and the list used to stall on every such file
// after each server restart. In those cases it returns the last snapshot
// (empty on the very first access) and parses in the background, so the next
// poll has the full result.
func (c *Cache) EnrichFast(jsonlPath string) EnrichResult {
	if jsonlPath == "" {
		return emptyEnrich()
	}
	c.mu.Lock()
	e := c.entries[jsonlPath]
	if e == nil {
		e = newCacheEntry()
		c.entries[jsonlPath] = e
	}
	now := time.Now().UnixNano()
	e.lastAccess = now
	c.maybeEvictLocked(now)
	c.mu.Unlock()

	if e.mu.TryLock() {
		inline := e.offset > 0
		if !inline {
			if fi, err := os.Stat(jsonlPath); err == nil && fi.Size() <= enrichSyncLimit {
				inline = true
			}
		}
		if inline {
			defer e.mu.Unlock()
			if !e.sync(jsonlPath) {
				return emptyEnrich()
			}
			return e.enrichLocked()
		}
		e.mu.Unlock()
	}
	c.warm(jsonlPath, e)
	if r := e.snap.Load(); r != nil {
		return *r
	}
	return emptyEnrich()
}

// warm parses jsonlPath in the background (once at a time per entry).
func (c *Cache) warm(jsonlPath string, e *cacheEntry) {
	if !e.warming.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer e.warming.Store(false)
		warmSem <- struct{}{}
		defer func() { <-warmSem }()
		c.Enrich(jsonlPath)
	}()
}

func emptyEnrich() EnrichResult {
	return EnrichResult{Prompts: []string{}, SearchText: []string{}}
}

// enrichLocked derives the Enrich result and records it as the entry's
// snapshot. Caller holds e.mu.
func (e *cacheEntry) enrichLocked() EnrichResult {
	res := emptyEnrich()
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
	snap := res
	snap.Prompts = append([]string{}, res.Prompts...)
	e.snap.Store(&snap)
	return res
}

// Goals returns the read_goals result via the incremental cache.
func (c *Cache) Goals(jsonlPath string) GoalsResult {
	e := c.acquire(jsonlPath)
	if e == nil {
		return GoalsResult{History: []Goal{}}
	}
	defer e.mu.Unlock()
	return e.goals.clone().result()
}

// TodoPlans returns the get_todo_plans result via the incremental cache.
func (c *Cache) TodoPlans(jsonlPath string) TodoPlansResult {
	e := c.acquire(jsonlPath)
	if e == nil {
		return TodoPlansResult{Active: []Todo{}, History: []TodoPlan{}}
	}
	defer e.mu.Unlock()
	return e.todos.clone().result()
}

// Conversation returns the get_conversation result (turns with ts > fromTs plus
// the in-progress exchange) via the incremental cache.
func (c *Cache) Conversation(jsonlPath string, fromTs float64) []ConversationTurn {
	e := c.acquire(jsonlPath)
	if e == nil {
		return []ConversationTurn{}
	}
	defer e.mu.Unlock()
	return e.conv.clone().result(fromTs)
}

// AUQs returns the list_auqs result via the incremental cache.
func (c *Cache) AUQs(jsonlPath string) []AUQ {
	e := c.acquire(jsonlPath)
	if e == nil {
		return []AUQ{}
	}
	defer e.mu.Unlock()
	return e.auqs.result()
}

// PlanPending returns whether an ExitPlanMode is awaiting a decision, via the
// incremental cache.
func (c *Cache) PlanPending(jsonlPath string) bool {
	e := c.acquire(jsonlPath)
	if e == nil {
		return false
	}
	defer e.mu.Unlock()
	return len(e.planOutstanding) > 0
}

// subagentSummary returns a snapshot of the sub-agent accumulator for the
// transcript at path, parsing only appended bytes. Returns a zero state if the
// file cannot be read.
func (c *Cache) subagentSummary(path string) *subagentState {
	e := c.acquire(path)
	if e == nil {
		return newSubagentState()
	}
	defer e.mu.Unlock()
	return e.subagent.clone()
}

// parentToolResults returns a snapshot of the {tool_use id → is_error} map for
// the parent transcript at path, parsing only appended bytes. Returns an empty
// map if the file cannot be read.
func (c *Cache) parentToolResults(path string) map[string]bool {
	e := c.acquire(path)
	if e == nil {
		return map[string]bool{}
	}
	defer e.mu.Unlock()
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
