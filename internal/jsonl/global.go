package jsonl

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// This file ports the "global session listing", "subagents", and
// "raw-messages pagination" primitives from
// app/services/claude_session_reader.py and
// app/services/cursor_session_reader.py. Stdlib only.

// mtimeSecs returns the float-seconds modification time, matching Python's
// `os.stat().st_mtime` (used verbatim in the JSON shapes below).
func mtimeSecs(fi os.FileInfo) float64 {
	return float64(fi.ModTime().UnixNano()) / 1e9
}

// ── Global session listing ──────────────────────────────────────────────────

// GlobalSession is one entry inside a GlobalSessionGroup.sessions list. Field
// names/order mirror the Python dict built in list_all_claude_sessions_global /
// list_all_cursor_sessions_global.
type GlobalSession struct {
	AgentSessionID string   `json:"agent_session_id"`
	Mtime          float64  `json:"mtime"`
	Title          *string  `json:"title"`
	Prompts        []string `json:"prompts"`
	Cwd            string   `json:"cwd"`
}

// GlobalSessionGroup mirrors the per-cwd group dict:
//
//	{"dir", "dir_exists", "sessions", "latest_mtime"}
type GlobalSessionGroup struct {
	Dir         string          `json:"dir"`
	DirExists   bool            `json:"dir_exists"`
	Sessions    []GlobalSession `json:"sessions"`
	LatestMtime float64         `json:"latest_mtime"`
}

// readSessionCwd reads the cwd field from the first ~10 JSONL entries. Port of
// _read_session_cwd. Returns "" if none found.
func readSessionCwd(jsonlPath string) string {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := newScanner(f)
	for i := 0; i < 10 && sc.Scan(); i++ {
		var d struct {
			Cwd string `json:"cwd"`
		}
		if err := json.Unmarshal(sc.Bytes(), &d); err != nil {
			continue
		}
		if d.Cwd != "" {
			return d.Cwd
		}
	}
	return ""
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// groupAndSort folds a cwd→sessions map into the sorted group list shared by the
// claude and cursor global listers.
func groupAndSort(byCwd map[string][]GlobalSession) []GlobalSessionGroup {
	result := make([]GlobalSessionGroup, 0, len(byCwd))
	for cwd, sessions := range byCwd {
		sort.SliceStable(sessions, func(i, j int) bool {
			return sessions[i].Mtime > sessions[j].Mtime
		})
		var latest float64
		if len(sessions) > 0 {
			latest = sessions[0].Mtime
		}
		result = append(result, GlobalSessionGroup{
			Dir:         cwd,
			DirExists:   isDir(cwd),
			Sessions:    sessions,
			LatestMtime: latest,
		})
	}
	sort.SliceStable(result, func(i, j int) bool {
		return result[i].LatestMtime > result[j].LatestMtime
	})
	return result
}

// ListAllClaudeSessionsGlobal scans every ~/.claude/projects dir and returns
// sessions grouped by cwd, excluding any whose agent_session_id is occupied.
// Port of list_all_claude_sessions_global.
func ListAllClaudeSessionsGlobal(occupied map[string]bool) []GlobalSessionGroup {
	base := projectsDir()
	if base == "" {
		return []GlobalSessionGroup{}
	}
	projEntries, err := os.ReadDir(base)
	if err != nil {
		return []GlobalSessionGroup{}
	}

	byCwd := map[string][]GlobalSession{}

	for _, pe := range projEntries {
		if !pe.IsDir() {
			continue
		}
		projName := pe.Name()
		projPath := filepath.Join(base, projName)
		files, err := os.ReadDir(projPath)
		if err != nil {
			continue
		}
		for _, fe := range files {
			if fe.IsDir() || filepath.Ext(fe.Name()) != ".jsonl" {
				continue
			}
			stem := strings.TrimSuffix(fe.Name(), ".jsonl")
			if occupied[stem] {
				continue
			}
			jsonlPath := filepath.Join(projPath, fe.Name())

			// Decoded dir name is authoritative for "where this lives now".
			// Project name is e.g. "-mnt-hdd2-foo"; drop the leading "-" then
			// "-"→"/" and prepend "/".
			decodedDir := "/"
			if len(projName) > 0 {
				decodedDir = "/" + strings.ReplaceAll(projName[1:], "-", "/")
			}
			internalCwd := readSessionCwd(jsonlPath)
			var cwd string
			// Trust internal cwd only when it re-encodes to the same dir name.
			if internalCwd != "" &&
				strings.ReplaceAll(strings.ReplaceAll(internalCwd, "/", "-"), "_", "-") == projName {
				cwd = internalCwd
			} else {
				cwd = decodedDir
			}

			fi, err := fe.Info()
			if err != nil {
				continue
			}
			data, _ := EnrichSession(stem, cwd)
			prompts := data.Prompts
			if prompts == nil {
				prompts = []string{}
			}
			byCwd[cwd] = append(byCwd[cwd], GlobalSession{
				AgentSessionID: stem,
				Mtime:          mtimeSecs(fi),
				Title:          data.Title,
				Prompts:        prompts,
				Cwd:            cwd,
			})
		}
	}

	return groupAndSort(byCwd)
}

// ListAllCursorSessionsGlobal scans every ~/.cursor/projects dir and returns
// sessions grouped by cwd. Port of list_all_cursor_sessions_global.
func ListAllCursorSessionsGlobal(occupied map[string]bool) []GlobalSessionGroup {
	base := cursorProjectsDir()
	if base == "" {
		return []GlobalSessionGroup{}
	}
	projEntries, err := os.ReadDir(base)
	if err != nil {
		return []GlobalSessionGroup{}
	}

	byCwd := map[string][]GlobalSession{}

	for _, pe := range projEntries {
		if !pe.IsDir() {
			continue
		}
		projName := pe.Name()
		transcripts := filepath.Join(base, projName, "agent-transcripts")
		if !isDir(transcripts) {
			continue
		}
		// Reverse slug: "home-sgf-Projs-foo" → "/home/sgf/Projs/foo".
		cwd := "/" + strings.ReplaceAll(projName, "-", "/")

		chatDirs, err := os.ReadDir(transcripts)
		if err != nil {
			continue
		}
		for _, cd := range chatDirs {
			if !cd.IsDir() {
				continue
			}
			chatID := cd.Name()
			if occupied[chatID] {
				continue
			}
			jsonlPath := filepath.Join(transcripts, chatID, chatID+".jsonl")
			fi, err := os.Stat(jsonlPath)
			if err != nil || fi.IsDir() {
				continue
			}
			data, _ := EnrichCursorSession(chatID, cwd)
			prompts := data.Prompts
			if prompts == nil {
				prompts = []string{}
			}
			// Skip empty sessions (no title and no prompts).
			if (data.Title == nil || *data.Title == "") && len(prompts) == 0 {
				continue
			}
			byCwd[cwd] = append(byCwd[cwd], GlobalSession{
				AgentSessionID: chatID,
				Mtime:          mtimeSecs(fi),
				Title:          data.Title,
				Prompts:        prompts,
				Cwd:            cwd,
			})
		}
	}

	return groupAndSort(byCwd)
}

// ── Local (per-cwd) session listing ─────────────────────────────────────────

// LocalSession is one entry from list_local_sessions / list_project_session_ids
// (the session-switcher dropdown shape): {agent_session_id, mtime, title}.
type LocalSession struct {
	AgentSessionID string  `json:"agent_session_id"`
	Mtime          float64 `json:"mtime"`
	Title          *string `json:"title"`
}

// ListProjectSessionIDs returns all JSONL session stems in the Claude project
// dir for cwd, newest first. Port of list_project_session_ids.
func ListProjectSessionIDs(cwd string) []LocalSession {
	base := projectsDir()
	if base == "" {
		return []LocalSession{}
	}
	cwd = strings.TrimRight(cwd, "/")
	for _, encoded := range []string{
		strings.ReplaceAll(strings.ReplaceAll(cwd, "/", "-"), "_", "-"),
		strings.ReplaceAll(cwd, "/", "-"),
	} {
		projPath := filepath.Join(base, encoded)
		if !isDir(projPath) {
			continue
		}
		files, err := os.ReadDir(projPath)
		if err != nil {
			continue
		}
		results := []LocalSession{}
		for _, fe := range files {
			if fe.IsDir() || filepath.Ext(fe.Name()) != ".jsonl" {
				continue
			}
			stem := strings.TrimSuffix(fe.Name(), ".jsonl")
			fi, err := fe.Info()
			if err != nil {
				continue
			}
			data, _ := EnrichSession(stem, cwd)
			results = append(results, LocalSession{
				AgentSessionID: stem,
				Mtime:          mtimeSecs(fi),
				Title:          data.Title,
			})
		}
		sort.SliceStable(results, func(i, j int) bool {
			return results[i].Mtime > results[j].Mtime
		})
		return results
	}
	return []LocalSession{}
}

// ListCursorLocalSessions returns all cursor agent sessions for cwd in the
// {agent_session_id, mtime, title} shape (CursorAdapter.list_local_sessions),
// newest first.
func ListCursorLocalSessions(cwd string) []LocalSession {
	base := cursorProjectsDir()
	if base == "" {
		return []LocalSession{}
	}
	transcripts := filepath.Join(base, cursorCwdToSlug(cwd), "agent-transcripts")
	chatDirs, err := os.ReadDir(transcripts)
	if err != nil {
		return []LocalSession{}
	}
	results := []LocalSession{}
	for _, cd := range chatDirs {
		if !cd.IsDir() {
			continue
		}
		chatID := cd.Name()
		jsonlPath := filepath.Join(transcripts, chatID, chatID+".jsonl")
		fi, err := os.Stat(jsonlPath)
		if err != nil || fi.IsDir() {
			continue
		}
		data, _ := EnrichCursorSession(chatID, cwd)
		results = append(results, LocalSession{
			AgentSessionID: chatID,
			Mtime:          mtimeSecs(fi),
			Title:          data.Title,
		})
	}
	sort.SliceStable(results, func(i, j int) bool {
		return results[i].Mtime > results[j].Mtime
	})
	return results
}

// ── Subagents ───────────────────────────────────────────────────────────────

// Subagent mirrors a list_subagents item:
// {agentId, description, agentType, mtime}.
type Subagent struct {
	AgentID     string  `json:"agentId"`
	Description string  `json:"description"`
	AgentType   string  `json:"agentType"`
	Mtime       float64 `json:"mtime"`
}

// findSubagentsDir locates "<jsonl_parent>/<sid>/subagents", or "" if absent.
// Port of _find_subagents_dir.
func findSubagentsDir(claudeSessionID, cwd string) string {
	jsonlPath := FindSessionJSONL(claudeSessionID, cwd)
	if jsonlPath == "" {
		return ""
	}
	dir := filepath.Join(filepath.Dir(jsonlPath), claudeSessionID, "subagents")
	if isDir(dir) {
		return dir
	}
	return ""
}

// ListSubagents lists all sub-agents for a Claude session. Port of
// list_subagents. Returns a non-nil (possibly empty) slice.
func ListSubagents(claudeSessionID, cwd string) []Subagent {
	dir := findSubagentsDir(claudeSessionID, cwd)
	if dir == "" {
		return []Subagent{}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []Subagent{}
	}
	// Python uses sorted(glob("agent-*.meta.json")).
	var metaNames []string
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, "agent-") && strings.HasSuffix(n, ".meta.json") {
			metaNames = append(metaNames, n)
		}
	}
	sort.Strings(metaNames)

	results := []Subagent{}
	for _, name := range metaNames {
		metaPath := filepath.Join(dir, name)
		raw, err := os.ReadFile(metaPath)
		if err != nil {
			continue
		}
		var meta struct {
			Description string `json:"description"`
			AgentType   string `json:"agentType"`
		}
		if err := json.Unmarshal(raw, &meta); err != nil {
			continue
		}
		// "agent-abc123.meta.json" → strip "agent-" prefix + ".meta.json" suffix.
		agentID := strings.TrimSuffix(strings.TrimPrefix(name, "agent-"), ".meta.json")
		var mtime float64
		jsonlFile := filepath.Join(dir, "agent-"+agentID+".jsonl")
		if fi, err := os.Stat(jsonlFile); err == nil {
			mtime = mtimeSecs(fi)
		}
		results = append(results, Subagent{
			AgentID:     agentID,
			Description: meta.Description,
			AgentType:   meta.AgentType,
			Mtime:       mtime,
		})
	}
	return results
}

// SubagentLines mirrors get_subagent_lines: {lines, total}.
type SubagentLines struct {
	Lines []string `json:"lines"`
	Total int      `json:"total"`
}

// GetSubagentLines returns raw JSONL lines from a sub-agent file starting at
// fromLine. Port of get_subagent_lines.
func GetSubagentLines(claudeSessionID, cwd, agentID string, fromLine int) SubagentLines {
	empty := SubagentLines{Lines: []string{}, Total: 0}
	dir := findSubagentsDir(claudeSessionID, cwd)
	if dir == "" {
		return empty
	}
	jsonlFile := filepath.Join(dir, "agent-"+agentID+".jsonl")
	f, err := os.Open(jsonlFile)
	if err != nil {
		return empty
	}
	defer f.Close()

	all := []string{}
	sc := newScanner(f)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\n\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		all = append(all, line)
	}
	total := len(all)
	if fromLine < 0 {
		fromLine = 0
	}
	if fromLine > total {
		fromLine = total
	}
	lines := all[fromLine:]
	if lines == nil {
		lines = []string{}
	}
	return SubagentLines{Lines: lines, Total: total}
}

// ── Raw-messages pagination ─────────────────────────────────────────────────

// RawMessagesPage mirrors read_raw_messages_page: {messages, total}. Messages
// are returned as raw JSON values to preserve the exact on-disk shape.
type RawMessagesPage struct {
	Messages []json.RawMessage `json:"messages"`
	Total    int               `json:"total"`
}

// ReadRawMessagesPage forward-scans the JSONL at jsonlPath, re-sorts by
// effective timestamp (oldest→newest), then windows the result.
//
// Port of read_raw_messages_page (the offset==nil / cutoff==nil tail path).
//   - tail>0  → last `tail` entries.
//   - tail<=0 → everything.
//
// `total` is the count of all eligible entries.
func ReadRawMessagesPage(jsonlPath string, tail int) RawMessagesPage {
	empty := RawMessagesPage{Messages: []json.RawMessage{}, Total: 0}
	f, err := os.Open(jsonlPath)
	if err != nil {
		return empty
	}
	defer f.Close()

	var entries []json.RawMessage
	sc := newScanner(f)
	for sc.Scan() {
		b := sc.Bytes()
		if len(strings.TrimSpace(string(b))) == 0 {
			continue
		}
		// Validate JSON; skip undecodable lines (Python's json.loads guard).
		if !json.Valid(b) {
			continue
		}
		entries = append(entries, append(json.RawMessage(nil), b...))
	}
	if len(entries) == 0 {
		return empty
	}

	ordered := sortByEffectiveTS(entries)
	total := len(ordered)
	if tail > 0 && total > tail {
		ordered = ordered[total-tail:]
	}
	out := make([]json.RawMessage, len(ordered))
	copy(out, ordered)
	return RawMessagesPage{Messages: out, Total: total}
}

// SortRawByEffectiveTS is the exported entry point for the raw-messages
// reorder used by the API layer (see sortByEffectiveTS).
func SortRawByEffectiveTS(entries []json.RawMessage) []json.RawMessage {
	return sortByEffectiveTS(entries)
}

// ReadRawMessagesPageFull is the full port of Python read_raw_messages_page,
// supporting the optional cutoff_ts filter (to freeze limited shares) and
// offset-based forward pagination — both of which the share viewer needs and
// which ReadRawMessagesPage/ReadRawMessagesTail (the tail-only fast paths) omit.
//
// It returns RAW renderer-compatible JSONL entries (the share viewer's
// renderConversationBody expects raw entries, NOT simplified chat bubbles).
//
//   - cutoffTs != nil → keep only entries whose effective ts <= *cutoffTs.
//   - offset  != nil  → ascending slice [*offset : *offset+limit]
//     (limit<=0 means "to the end").
//   - offset  == nil  → the last `limit` entries (limit<=0 means "everything").
//
// `total` is the count of eligible entries AFTER the optional cutoff filter, so
// the viewer can tell how much remains to page in.
func ReadRawMessagesPageFull(jsonlPath string, limit int, cutoffTs *float64, offset *int) RawMessagesPage {
	empty := RawMessagesPage{Messages: []json.RawMessage{}, Total: 0}
	f, err := os.Open(jsonlPath)
	if err != nil {
		return empty
	}
	defer f.Close()

	var entries []json.RawMessage
	sc := newScanner(f)
	for sc.Scan() {
		b := sc.Bytes()
		if len(strings.TrimSpace(string(b))) == 0 {
			continue
		}
		if !json.Valid(b) {
			continue
		}
		entries = append(entries, append(json.RawMessage(nil), b...))
	}
	if len(entries) == 0 {
		return empty
	}

	// Effective-timestamp stable sort (oldest→newest), retaining each entry's
	// effective ts so we can apply the cutoff filter against it.
	n := len(entries)
	eff := make([]float64, n)
	var prevEff float64
	for i, e := range entries {
		if ts := entryTimestamp(e); ts != nil {
			eff[i] = *ts
			prevEff = *ts
		} else {
			eff[i] = prevEff
		}
	}
	idx := make([]int, n)
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool {
		ia, ib := idx[a], idx[b]
		if eff[ia] != eff[ib] {
			return eff[ia] < eff[ib]
		}
		return ia < ib
	})

	ordered := make([]json.RawMessage, 0, n)
	for _, j := range idx {
		if cutoffTs != nil && eff[j] > *cutoffTs {
			continue
		}
		ordered = append(ordered, entries[j])
	}

	total := len(ordered)
	switch {
	case offset != nil:
		start := *offset
		if start < 0 {
			start = 0
		}
		if start >= total {
			ordered = []json.RawMessage{}
		} else if limit > 0 {
			end := start + limit
			if end > total {
				end = total
			}
			ordered = ordered[start:end]
		} else {
			ordered = ordered[start:]
		}
	case limit > 0 && total > limit:
		ordered = ordered[total-limit:]
	}

	out := make([]json.RawMessage, len(ordered))
	copy(out, ordered)
	return RawMessagesPage{Messages: out, Total: total}
}

// StripUserQueryTags removes Cursor's <user_query>/<user_info>/<system_reminder>
// wrappers (exported entry point for the API layer; see stripUserQueryTags).
func StripUserQueryTags(text string) string { return stripUserQueryTags(text) }

// sortByEffectiveTS stably re-sorts entries by "effective timestamp": each
// entry's own `timestamp` if present, else the previous entry's effective ts.
// Port of the _effective_timestamps + stable indexed-sort logic shared by
// read_raw_messages_page / get_raw_messages / get_raw_messages_all.
func sortByEffectiveTS(entries []json.RawMessage) []json.RawMessage {
	n := len(entries)
	eff := make([]float64, n)
	var prevEff float64
	for i, e := range entries {
		ts := entryTimestamp(e)
		if ts == nil {
			eff[i] = prevEff
		} else {
			eff[i] = *ts
			prevEff = *ts
		}
	}
	idx := make([]int, n)
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool {
		ia, ib := idx[a], idx[b]
		if eff[ia] != eff[ib] {
			return eff[ia] < eff[ib]
		}
		return ia < ib
	})
	out := make([]json.RawMessage, n)
	for i, j := range idx {
		out[i] = entries[j]
	}
	return out
}

// entryTimestamp parses the `timestamp` string field of a JSONL entry into epoch
// seconds, or nil when absent/unparseable. Mirrors Python's _parse_ts used by
// the raw-messages reorder logic.
func entryTimestamp(e json.RawMessage) *float64 {
	var d struct {
		Timestamp string `json:"timestamp"`
	}
	if err := json.Unmarshal(e, &d); err != nil {
		return nil
	}
	if d.Timestamp == "" {
		return nil
	}
	ts := parseISOTs(d.Timestamp)
	if ts == 0 {
		// parseISOTs returns 0 on failure; treat as unparseable to match the
		// Python branch (which returns None and falls back to prev).
		return nil
	}
	return &ts
}
