package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/jsonl"
	"github.com/loki/goclaudemanager/internal/model"
)

// This file ports a batch of read-only session endpoints from
// app/api/sessions.py:
//
//	GET /{id}/search                       (~1110)
//	GET /{id}/conversation/jsonl           (~2285)
//	GET /{id}/available-claude-sessions    (~2347)
//	GET /{id}/subagents                    (~2368)
//	GET /{id}/subagents/{agentID}          (~2381)
//	GET /{id}/raw-messages                 (~2422)
//	GET /{id}/raw-messages/all             (~2709)
//
// and the external-browse endpoints (mounted under the same /api/sessions
// subrouter, so they inherit RequireUser):
//
//	GET /external          (~715)
//	GET /external-cursor   (~723)
//	GET /external-codex    (~731)
//	GET /external-preview  (~740)
//
// JSON shapes mirror the Python responses exactly.

// ansiEscapeRe mirrors Python's re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", raw).
var ansiEscapeRe = regexp.MustCompile("\x1b\\[[0-9;]*[A-Za-z]")

// registerReadExtraRoutes wires the session-scoped read endpoints onto the
// already-authenticated /api/sessions subrouter (RequireUser applied upstream).
func registerReadExtraRoutes(r chi.Router, d Deps) {
	r.Get("/{id}/search", func(w http.ResponseWriter, r *http.Request) { searchSession(d, w, r) })
	r.Get("/{id}/conversation/jsonl", func(w http.ResponseWriter, r *http.Request) { conversationJSONL(d, w, r) })
	r.Get("/{id}/available-claude-sessions", func(w http.ResponseWriter, r *http.Request) { availableClaudeSessions(d, w, r) })
	r.Get("/{id}/subagents", func(w http.ResponseWriter, r *http.Request) { getSubagents(d, w, r) })
	r.Get("/{id}/subagents/{agentID}", func(w http.ResponseWriter, r *http.Request) { getSubagentContent(d, w, r) })
	r.Get("/{id}/raw-messages", func(w http.ResponseWriter, r *http.Request) { getRawMessages(d, w, r) })
	r.Get("/{id}/raw-messages/all", func(w http.ResponseWriter, r *http.Request) { getRawMessagesAll(d, w, r) })
}

// registerExternalRoutes wires the /external* browse endpoints onto the
// /api/sessions subrouter.
func registerExternalRoutes(r chi.Router, d Deps) {
	r.Get("/external", func(w http.ResponseWriter, r *http.Request) { browseExternalSessions(d, w, r) })
	r.Get("/external-cursor", func(w http.ResponseWriter, r *http.Request) { browseCursorSessions(d, w, r) })
	r.Get("/external-codex", func(w http.ResponseWriter, r *http.Request) { browseCodexSessions(d, w, r) })
	r.Get("/external-preview", func(w http.ResponseWriter, r *http.Request) { getExternalPreview(d, w, r) })
}

// agentSessionID returns the session's agent_session_id or "".
func agentSessionID(s *model.Session) string {
	if s.AgentSessionID != nil {
		return *s.AgentSessionID
	}
	return ""
}

// resolveJSONLPath replicates `adapter.get_jsonl_path(chat_sid, cwd)` for the
// claude/cursor tools. Codex is not ported (returns "").
func resolveJSONLPath(tool, chatSID, cwd string) string {
	switch tool {
	case "cursor":
		return jsonl.FindCursorJSONL(chatSID, cwd)
	default:
		return jsonl.FindSessionJSONL(chatSID, cwd)
	}
}

// findNewestSessionID returns the newest transcript id in cwd for the tool,
// skipping any id in `exclude` (the set of agent_session_ids owned by OTHER
// sessions) so a fallback can recover s's own rotated transcript without ever
// adopting a sibling's. exclude may be nil.
func findNewestSessionID(tool, cwd string, exclude map[string]bool) string {
	switch tool {
	case "cursor":
		for _, ls := range jsonl.ListCursorLocalSessions(cwd) {
			if !exclude[ls.AgentSessionID] {
				return ls.AgentSessionID
			}
		}
		return ""
	default:
		return jsonl.FindNewestClaudeSessionIDExcluding(cwd, exclude)
	}
}

// resolveChatSID picks the agent/chat session id to read conversation history
// from for session s.
//
// The agent_session_id is captured once, per-session, at create time and is
// never *reassigned* (not by resume, not by a poller). It is the authoritative
// link to this session's transcript. The decision (see resolveChatSIDCore):
//
//   - stored id whose JSONL exists → use it (the happy path).
//   - never talked + own file absent → "" (a brand-new session has no transcript
//     yet; the newest file in a shared cwd would be a SIBLING's — borrowing it is
//     the "data got mixed up" bug).
//   - has conversed but own id no longer resolves (Claude rotated the id on
//     compaction and removed the old file) → recover the newest transcript in the
//     cwd, EXCLUDING any id already claimed by another session, so we recover s's
//     own rotated transcript without ever showing a sibling's conversation.
//
// This recovers a session's own rotated transcript (the common single-session
// case) while still guaranteeing two sessions in one cwd never cross-contaminate.
// It reads only — the stored agent_session_id is not modified.
func resolveChatSID(d Deps, s *model.Session) string {
	exclude, _ := d.Store.GetAllAgentSessionIDs(s.ID)
	return resolveChatSIDCore(s, exclude)
}

// resolveChatSIDCore is the pure decision logic (no DB), exercised by tests.
// `exclude` is the set of agent_session_ids owned by OTHER sessions.
func resolveChatSIDCore(s *model.Session, exclude map[string]bool) string {
	stored := agentSessionID(s)
	if stored != "" && resolveJSONLPath(s.Tool, stored, s.Cwd) != "" {
		return stored
	}
	// Own transcript does not resolve. Only a session that has actually had a
	// turn can own a transcript under a rotated id; one that never talked must
	// not borrow a sibling's newest file.
	if s.LastTurnAt == nil {
		return ""
	}
	if newest := findNewestSessionID(s.Tool, s.Cwd, exclude); newest != "" {
		return newest
	}
	return stored
}

// ── GET /{id}/search ─────────────────────────────────────────────────────────

type searchHit struct {
	Line    int    `json:"line"`
	Col     int    `json:"col"`
	Text    string `json:"text"`
	Context string `json:"context"`
}

func searchSession(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	// FastAPI: q is required, min_length=1.
	q := r.URL.Query().Get("q")
	if len(q) < 1 {
		writeErr(w, http.StatusUnprocessableEntity, "q is required")
		return
	}

	raw := ""
	if s.Status == model.StatusRunning || s.Status == model.StatusDetached {
		raw = d.Tmux.CaptureFullHistory(s.TmuxSessionName, false)
	}
	if raw == "" {
		writeJSON(w, http.StatusOK, []searchHit{})
		return
	}

	clean := ansiEscapeRe.ReplaceAllString(raw, "")
	lines := splitLines(clean)

	results := []searchHit{}
	qLower := strings.ToLower(q)
	qLen := len(q)
	for i, line := range lines {
		lineLower := strings.ToLower(line)
		start := 0
		for {
			rel := strings.Index(lineLower[start:], qLower)
			if rel == -1 {
				break
			}
			pos := start + rel
			ctxStart := i - 1
			if ctxStart < 0 {
				ctxStart = 0
			}
			ctxEnd := i + 2
			if ctxEnd > len(lines) {
				ctxEnd = len(lines)
			}
			context := strings.Join(lines[ctxStart:ctxEnd], "\n")

			snipStart := pos - 20
			if snipStart < 0 {
				snipStart = 0
			}
			snipEnd := pos + qLen + 40
			if snipEnd > len(line) {
				snipEnd = len(line)
			}
			snippet := strings.TrimSpace(line[snipStart:snipEnd])
			results = append(results, searchHit{
				Line:    i + 1,
				Col:     pos + 1,
				Text:    snippet,
				Context: context,
			})
			start = pos + qLen
			if len(results) >= 200 {
				break
			}
		}
		if len(results) >= 200 {
			break
		}
	}
	writeJSON(w, http.StatusOK, results)
}

// splitLines mirrors Python's str.splitlines() closely enough for tmux output:
// split on \n after normalizing \r\n and \r.
func splitLines(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	if s == "" {
		return []string{}
	}
	// Python splitlines() does not produce a trailing empty element for a
	// final newline.
	s = strings.TrimSuffix(s, "\n")
	return strings.Split(s, "\n")
}

// ── GET /{id}/conversation/jsonl ─────────────────────────────────────────────

func conversationJSONL(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	page := queryInt(r, "page", 0)
	if page < 0 {
		page = 0
	}
	pageSize := queryInt(r, "page_size", 200)
	if pageSize < 1 {
		pageSize = 1
	}
	if pageSize > 1000 {
		pageSize = 1000
	}

	chatSID := resolveChatSID(d, s)
	if chatSID == "" {
		writeErr(w, http.StatusNotFound, "no "+s.Tool+" session")
		return
	}
	jsonlPath := resolveJSONLPath(s.Tool, chatSID, s.Cwd)
	if jsonlPath == "" {
		writeErr(w, http.StatusNotFound, "jsonl file not found")
		return
	}

	// Single forward scan yields both the total line count and the requested
	// [offset, offset+pageSize) window. Only the rare out-of-range case (the
	// caller asked for a page past the end, e.g. with a stale total) pays a
	// second targeted read after clamping — the common in-range request is one
	// pass over the file instead of the previous two.
	offset := page * pageSize
	pageLines, total, err := readJSONLPage(jsonlPath, offset, pageSize)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if total > 0 && offset >= total {
		page = int(math.Ceil(float64(total)/float64(pageSize))) - 1
		if page < 0 {
			page = 0
		}
		offset = page * pageSize
		pageLines, _, err = readJSONLPage(jsonlPath, offset, pageSize)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"lines":     pageLines,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	})
}

// readJSONLPage scans the file once, returning the [offset, offset+pageSize)
// window of non-empty lines (trailing \r\n stripped) and the total non-empty
// line count. Capturing both in a single pass avoids a separate counting scan;
// the window stops growing at pageSize but the scan continues to finish the
// count (needed for pagination), so memory stays bounded to pageSize lines.
func readJSONLPage(path string, offset, pageSize int) ([]string, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	out := []string{}
	total := 0
	sc := newJSONLScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		if total >= offset && len(out) < pageSize {
			out = append(out, strings.TrimRight(line, "\n\r"))
		}
		total++
	}
	if err := sc.Err(); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// newJSONLScanner is a large-buffer line scanner for potentially huge JSONL
// lines (mirrors jsonl.newScanner's 16MiB cap, kept local to the api package).
func newJSONLScanner(r io.Reader) *bufio.Scanner {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	return sc
}

// ── GET /{id}/available-claude-sessions ──────────────────────────────────────

func availableClaudeSessions(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var allSessions []jsonl.LocalSession
	switch s.Tool {
	case "cursor":
		allSessions = jsonl.ListCursorLocalSessions(s.Cwd)
	default:
		allSessions = d.JSONL.ListProjectSessionIDs(s.Cwd)
	}

	occupied, _ := d.Store.GetAllAgentSessionIDs(s.ID)
	currentSID := agentSessionID(s)

	out := []jsonl.LocalSession{}
	for _, ls := range allSessions {
		if occupied[ls.AgentSessionID] {
			continue
		}
		if ls.AgentSessionID == currentSID {
			continue
		}
		out = append(out, ls)
	}
	writeJSON(w, http.StatusOK, out)
}

// ── GET /{id}/subagents and /{id}/subagents/{agentID} ────────────────────────

func getSubagents(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	chatSID := resolveChatSID(d, s)
	if chatSID == "" {
		writeJSON(w, http.StatusOK, []jsonl.SubagentSummary{})
		return
	}
	writeJSON(w, http.StatusOK, d.JSONL.ListSubagentSummaries(chatSID, s.Cwd))
}

func getSubagentContent(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	agentID := chi.URLParam(r, "agentID")
	chatSID := resolveChatSID(d, s)
	if chatSID == "" {
		writeErr(w, http.StatusNotFound, "no claude session")
		return
	}
	fromLine := queryInt(r, "from_line", 0)
	if fromLine < 0 {
		fromLine = 0
	}
	writeJSON(w, http.StatusOK, jsonl.GetSubagentLines(chatSID, s.Cwd, agentID, fromLine))
}

// ── GET /{id}/raw-messages ───────────────────────────────────────────────────

func getRawMessages(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	// tail: default 100, ge=10, le=2000.
	tail := queryInt(r, "tail", 100)
	if tail < 10 {
		tail = 10
	}
	if tail > 2000 {
		tail = 2000
	}

	if s.Tool == "codex" {
		// Codex reader is not ported to Go; mirror the "no session" empty body.
		slog.Debug("raw-messages: codex tool not supported in Go port", "session", s.ID)
		writeJSON(w, http.StatusOK, map[string]any{"messages": []any{}, "total": 0})
		return
	}

	chatSID := resolveChatSID(d, s)
	jsonlPath := ""
	if chatSID != "" {
		jsonlPath = resolveJSONLPath(s.Tool, chatSID, s.Cwd)
	}
	if jsonlPath == "" {
		writeJSON(w, http.StatusOK, map[string]any{"messages": []any{}, "total": 0})
		return
	}

	// History paging: when the client sends an explicit `offset` it wants a
	// bounded, static older slice [offset:offset+limit] (raw eligible-entry
	// space) to PREPEND to its live window — NOT the growing live tail. Old
	// history is already flushed to JSONL, so there is no token, no incremental
	// delta and no proxy-snapshot merge here (snapshots only matter for the live
	// tail). This mirrors public_share.go's offset windowing.
	if r.URL.Query().Has("offset") {
		offset := queryInt(r, "offset", 0)
		if offset < 0 {
			offset = 0
		}
		limit := queryInt(r, "limit", 200)
		if limit < 10 {
			limit = 10
		}
		if limit > 2000 {
			limit = 2000
		}
		page := jsonl.ReadRawMessagesPageFull(jsonlPath, limit, nil, &offset)
		if s.Tool == "cursor" {
			transformed := transformCursorRaw(page.Messages)
			writeJSON(w, http.StatusOK, map[string]any{"messages": transformed, "total": page.Total})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"messages": page.Messages, "total": page.Total})
		return
	}

	// Change token folds the JSONL size+mtime with the in-flight proxy snapshot
	// dir state (count + newest-mtime + total-size). Streaming assistant content
	// arrives as snapshots under ~/.claude/cached_messages/{chatSID}/ even while
	// the JSONL is static, so the snapshot state MUST be part of the token — else
	// the live view would freeze mid-stream. A matching since_token guarantees the
	// merged result is unchanged, so we skip the parse+merge entirely.
	token := rawMessagesToken(jsonlPath, chatSID)
	since := r.URL.Query().Get("since_token")
	if since != "" && since == token {
		writeJSON(w, http.StatusOK, map[string]any{"unchanged": true, "token": token})
		return
	}

	// Incremental (delta) window. When the client already holds a window (it sent
	// a since_token) AND the transcript only grew by a handful of lines since that
	// token — i.e. an append, or a snapshot-only change during streaming — there
	// is no need to re-send the whole 100-entry tail (~150KB+). We send just the
	// latest 10 JSONL entries; the client merges them into its existing window by
	// uuid. The proxy snapshots (cached_messages) are ALWAYS merged on top so the
	// streaming preview is never dropped. Cursor/codex keep the full window
	// (cursor's stable cursor-{idx} ids require the whole ordered list). On a
	// rewind/compaction (size shrank) or a large gap (>10 new lines, e.g. a burst
	// during a sparse idle poll) we fall back to the full tail so nothing is lost.
	windowTail := tail
	incremental := false
	if since != "" && s.Tool != "cursor" {
		if oldSize := tokenJSONLSize(since); oldSize > 0 {
			if curSize := fileSize(jsonlPath); curSize >= oldSize {
				if appendedLines(jsonlPath, oldSize, curSize) <= 10 {
					windowTail = 10
					incremental = true
				}
			}
		}
	}

	collected, total, err := readRawMessages(jsonlPath, windowTail)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	if s.Tool == "cursor" {
		transformed := transformCursorRaw(collected)
		writeJSON(w, http.StatusOK, map[string]any{"messages": transformed, "total": len(transformed), "token": token})
		return
	}

	// Merge in-flight anthropic-proxy snapshots so the frontend previews
	// streaming assistant content before the CLI flushes the JSONL line.
	collected = mergeProxySnapshots(collected, chatSID)

	writeJSON(w, http.StatusOK, map[string]any{
		"messages": collected, "total": total, "token": token, "incremental": incremental,
	})
}

// proxyCacheDir returns ~/.claude/cached_messages/{chatSID}, or "" if it can't
// be resolved.
func proxyCacheDir(chatSID string) string {
	if chatSID == "" {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude", "cached_messages", chatSID)
}

// rawMessagesToken builds the opaque change token: JSONL size+mtime folded with
// the proxy snapshot dir state (file count, newest mtime, total size). Mirrors
// the token string in Python get_raw_messages.
func rawMessagesToken(jsonlPath, chatSID string) string {
	var size, mtimeNs int64
	if fi, err := os.Stat(jsonlPath); err == nil {
		size = fi.Size()
		mtimeNs = fi.ModTime().UnixNano()
	}
	var snapN, snapMtime, snapSz int64
	if dir := proxyCacheDir(chatSID); dir != "" {
		if entries, err := os.ReadDir(dir); err == nil {
			for _, de := range entries {
				name := de.Name()
				if !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
					continue
				}
				fi, err := de.Info()
				if err != nil {
					continue
				}
				snapN++
				snapSz += fi.Size()
				if m := fi.ModTime().UnixNano(); m > snapMtime {
					snapMtime = m
				}
			}
		}
	}
	return fmt.Sprintf("%d:%d:%d:%d:%d", size, mtimeNs, snapN, snapMtime, snapSz)
}

// tokenJSONLSize extracts the JSONL byte-size recorded in a change token (its
// first ':'-separated field; see rawMessagesToken). Returns 0 if unparseable, so
// callers fall back to the full window.
func tokenJSONLSize(token string) int64 {
	i := strings.IndexByte(token, ':')
	if i < 0 {
		return 0
	}
	n, err := strconv.ParseInt(token[:i], 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// fileSize returns the size of path in bytes, or 0 if it can't be stat'd.
func fileSize(path string) int64 {
	if fi, err := os.Stat(path); err == nil {
		return fi.Size()
	}
	return 0
}

// appendedLines counts the newline-terminated lines added to a file in the byte
// range [oldSize, curSize) — i.e. how many JSONL entries were appended since the
// client's last token. Used to decide whether the incremental 10-entry window can
// cover the delta without leaving a gap. Reads only the appended region; if that
// region is large (>2MB) it returns a sentinel above the delta cap so the caller
// just sends the full window rather than scanning a big tail.
func appendedLines(path string, oldSize, curSize int64) int {
	if curSize <= oldSize {
		return 0
	}
	if curSize-oldSize > 2*1024*1024 {
		return 1 << 30 // far above the delta cap → force a full window
	}
	f, err := os.Open(path)
	if err != nil {
		return 1 << 30
	}
	defer f.Close()
	buf := make([]byte, curSize-oldSize)
	n, err := f.ReadAt(buf, oldSize)
	if err != nil && err != io.EOF {
		return 1 << 30
	}
	return bytes.Count(buf[:n], []byte{'\n'})
}

// mergeProxySnapshots appends synthetic in-flight assistant entries built from
// the anthropic-proxy snapshots in ~/.claude/cached_messages/{chatSID}/ so the
// frontend can preview streaming content before the CLI flushes the JSONL line.
// Dedup against JSONL by message.id; for one in-flight request keep only the
// latest snapshot; drop snapshots already older than the newest JSONL entry.
// Mirrors the merge block in Python get_raw_messages.
func mergeProxySnapshots(collected []json.RawMessage, chatSID string) []json.RawMessage {
	dir := proxyCacheDir(chatSID)
	if dir == "" {
		return collected
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return collected
	}

	// seen assistant message ids already in the JSONL, the newest JSONL
	// timestamp (ns), and the last real entry's uuid (for parentUuid linkage).
	seen := map[string]bool{}
	var maxTsNs int64
	var lastUUID string
	for _, raw := range collected {
		var e struct {
			Type      string `json:"type"`
			UUID      string `json:"uuid"`
			Timestamp string `json:"timestamp"`
			Message   struct {
				ID string `json:"id"`
			} `json:"message"`
		}
		if err := json.Unmarshal(raw, &e); err != nil {
			continue
		}
		lastUUID = e.UUID
		if e.Type == "assistant" && e.Message.ID != "" {
			seen[e.Message.ID] = true
		}
		if e.Timestamp != "" {
			if t, err := time.Parse(time.RFC3339Nano, e.Timestamp); err == nil {
				if ns := t.UnixNano(); ns > maxTsNs {
					maxTsNs = ns
				}
			}
		}
	}

	type snapData struct {
		tsNs    int64
		kind    string
		reqID   string
		content []json.RawMessage
	}
	latest := map[string]snapData{}
	for _, de := range entries {
		name := de.Name()
		if !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		tsNs, err := strconv.ParseInt(strings.TrimSuffix(name, ".json"), 10, 64)
		if err != nil {
			continue
		}
		if tsNs <= maxTsNs {
			continue // CLI already flushed past this snapshot
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var snap struct {
			RequestID string            `json:"request_id"`
			Kind      string            `json:"kind"`
			Content   []json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(data, &snap); err != nil {
			continue
		}
		if snap.RequestID == "" || seen[snap.RequestID] {
			continue
		}
		if cur, ok := latest[snap.RequestID]; !ok || tsNs > cur.tsNs {
			latest[snap.RequestID] = snapData{tsNs, snap.Kind, snap.RequestID, snap.Content}
		}
	}
	if len(latest) == 0 {
		return collected
	}

	type item struct {
		iso string
		raw json.RawMessage
	}
	var items []item
	for _, s := range latest {
		iso := time.Unix(0, s.tsNs).UTC().Format(time.RFC3339Nano)
		content := s.content
		if content == nil {
			content = []json.RawMessage{}
		}
		var parentUUID any
		if lastUUID != "" {
			parentUUID = lastUUID
		}
		obj := map[string]any{
			"type":           "assistant",
			"uuid":           "tap-" + s.reqID,
			"parentUuid":     parentUUID,
			"timestamp":      iso,
			"sessionId":      chatSID,
			"_synthetic":     true,
			"_snapshot_kind": s.kind,
			"message": map[string]any{
				"role":    "assistant",
				"id":      s.reqID,
				"content": content,
			},
		}
		b, err := json.Marshal(obj)
		if err != nil {
			continue
		}
		items = append(items, item{iso, b})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].iso < items[j].iso })
	for _, it := range items {
		collected = append(collected, it.raw)
	}
	return collected
}

// readRawMessages reads the last `tail` JSONL entries, then stable-sorts the
// collected window by effective timestamp. It delegates to the reverse-scan
// reader so a huge, actively-growing transcript (the live ClaudeManager session
// is ~100MB / 50k lines) does not get fully parsed into memory on every poll —
// the old forward scan blocked for minutes and repeated on each change-token tick.
func readRawMessages(path string, tail int) ([]json.RawMessage, int, error) {
	return jsonl.ReadRawMessagesTail(path, tail)
}

// ── GET /{id}/raw-messages/all ───────────────────────────────────────────────

func getRawMessagesAll(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}

	if s.Tool == "codex" {
		slog.Debug("raw-messages/all: codex tool not supported in Go port", "session", s.ID)
		writeJSON(w, http.StatusOK, map[string]any{"messages": []any{}, "total": 0})
		return
	}

	chatSID := resolveChatSID(d, s)
	jsonlPath := ""
	if chatSID != "" {
		jsonlPath = resolveJSONLPath(s.Tool, chatSID, s.Cwd)
	}
	if jsonlPath == "" {
		writeJSON(w, http.StatusOK, map[string]any{"messages": []any{}, "total": 0})
		return
	}

	// Forward-scan everything (tail<=0 = unbounded), reorder by effective ts.
	page := jsonl.ReadRawMessagesPage(jsonlPath, 0)
	collected := page.Messages
	total := page.Total

	if s.Tool == "cursor" {
		transformed := transformCursorRaw(collected)
		writeJSON(w, http.StatusOK, map[string]any{"messages": transformed, "total": len(transformed)})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"messages": collected, "total": total})
}

// ── Cursor raw transform ─────────────────────────────────────────────────────

// transformCursorRaw converts top-level {"role":...} Cursor entries into the
// Claude raw shape ConversationPane expects. Port of the cursor branch shared
// by get_raw_messages / get_raw_messages_all.
func transformCursorRaw(collected []json.RawMessage) []map[string]any {
	out := []map[string]any{}
	idx := 0
	for _, raw := range collected {
		var d struct {
			Role    string `json:"role"`
			Message struct {
				Content []json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal(raw, &d); err != nil {
			continue
		}
		if d.Role != "user" && d.Role != "assistant" {
			continue
		}
		cleanBlocks := []any{}
		for _, blk := range d.Message.Content {
			var b struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			if err := json.Unmarshal(blk, &b); err != nil {
				continue
			}
			if b.Type == "text" {
				text := jsonl.StripUserQueryTags(b.Text)
				if text != "" {
					cleanBlocks = append(cleanBlocks, map[string]any{"type": "text", "text": text})
				}
			} else {
				// Preserve the block verbatim.
				var generic map[string]any
				if err := json.Unmarshal(blk, &generic); err == nil {
					cleanBlocks = append(cleanBlocks, generic)
				}
			}
		}
		if len(cleanBlocks) == 0 {
			continue
		}
		var parentUUID any
		if idx > 0 {
			parentUUID = "cursor-" + itoa(int64(idx-1))
		} else {
			parentUUID = nil
		}
		out = append(out, map[string]any{
			"type":       d.Role,
			"uuid":       "cursor-" + itoa(int64(idx)),
			"parentUuid": parentUUID,
			"timestamp":  "",
			"message":    map[string]any{"role": d.Role, "content": cleanBlocks},
		})
		idx++
	}
	return out
}

// ── /external* browse endpoints ──────────────────────────────────────────────

func browseExternalSessions(d Deps, w http.ResponseWriter, r *http.Request) {
	occupied, err := d.Store.GetAllAgentSessionIDs("")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, d.JSONL.ListAllClaudeSessionsGlobal(occupied))
}

func browseCursorSessions(d Deps, w http.ResponseWriter, r *http.Request) {
	occupied, err := d.Store.GetAllAgentSessionIDs("")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, jsonl.ListAllCursorSessionsGlobal(occupied))
}

func browseCodexSessions(d Deps, w http.ResponseWriter, r *http.Request) {
	// Codex session reader is not ported to Go yet; return an empty list with
	// the same [] shape as the Python endpoint.
	slog.Debug("external-codex: codex reader not ported to Go; returning empty list")
	writeJSON(w, http.StatusOK, []jsonl.GlobalSessionGroup{})
}

func getExternalPreview(d Deps, w http.ResponseWriter, r *http.Request) {
	// RequireUser already enforced; user identity is unused beyond auth.
	_ = auth.FromContext(r.Context())

	agentSID := r.URL.Query().Get("agent_session_id")
	cwd := r.URL.Query().Get("cwd")
	if agentSID == "" || cwd == "" {
		writeErr(w, http.StatusUnprocessableEntity, "agent_session_id and cwd are required")
		return
	}
	tool := r.URL.Query().Get("tool")
	if tool == "" {
		tool = "claude"
	}

	var turns []jsonl.ConversationTurn
	switch tool {
	case "cursor":
		turns, _ = jsonl.GetCursorConversation(agentSID, cwd, 0)
	case "codex":
		// Not ported; treat as empty conversation.
		slog.Debug("external-preview: codex tool not ported to Go", "agent_session_id", agentSID)
		turns = []jsonl.ConversationTurn{}
	default:
		turns, _ = jsonl.GetConversation(agentSID, cwd, 0)
	}
	if turns == nil {
		turns = []jsonl.ConversationTurn{}
	}

	total := len(turns)
	preview := turns
	truncatedBefore := 0
	if total > 200 {
		preview = append(append([]jsonl.ConversationTurn{}, turns[:100]...), turns[total-100:]...)
		truncatedBefore = total - 200
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"turns":            preview,
		"total":            total,
		"truncated_before": truncatedBefore,
	})
}

// ensure errors import is used (defensive: some build configs flag otherwise).
var _ = errors.New
