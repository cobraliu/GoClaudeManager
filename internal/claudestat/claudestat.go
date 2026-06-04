// Package claudestat ports the Claude "live status / hook" detection helpers
// from the Python ClaudeManager (app/services/claude_pid.py and the hook
// helpers in app/api/sessions.py).
//
// It detects, for a running Claude CLI session:
//   - AskUserQuestion (AUQ) widgets, parsed either from a captured tmux TUI
//     screen or from the per-session PreToolUse hook file,
//   - tool-approval waits,
//   - in-flight conversation compaction (PreCompact hook + TUI scan),
//   - a human-readable TUI hint.
//
// All ~/.claude and ~/.claude_manager paths are resolved via os.UserHomeDir.
// Only the standard library is used.
package claudestat

import (
	"bufio"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ── Constants ──────────────────────────────────────────────────────────────

// ansiRE matches ANSI escape sequences (colors, cursor movement, etc.) plus CR.
var ansiRE = regexp.MustCompile(`\x1b\[[0-9;?]*[a-zA-Z]|\x1b[=>]|\r`)

// compactPctRE matches the percentage portion of a "Compacting conversation… 45%"
// line in the TUI.
var compactPctRE = regexp.MustCompile(`(\d{1,3})\s*%`)

// compactBarChars are the progress-bar glyphs Claude Code's TUI uses for the
// compaction bar. These obscure Unicode rectangles are essentially absent from
// normal chat text, so requiring one nearby keeps user-typed or assistant-quoted
// "Compacting conversation…" strings from triggering a false positive.
var compactBarChars = []string{"▰", "▱"}

// compactTUITailLines is how many trailing lines of the TUI pane to scan for the
// compaction banner. A tail of 20 comfortably covers it across terminal sizes.
const compactTUITailLines = 20

// compactHookTimeout is the stale-marker timeout for the PreCompact hook signal.
// A real compaction completes well within this window; if the marker hangs
// around longer the hook fired but no compact_boundary was ever written, so we
// drop the signal.
const compactHookTimeout = 15 * time.Minute

// compactGrace absorbs clock skew + the PreCompact hook fire moment itself when
// comparing JSONL timestamps against the compaction marker's start time.
const compactGrace = 2 * time.Second

// auqJSONLWindow is the tail byte window scanned in the session JSONL when
// resolving whether a hook AUQ has already been answered.
const auqJSONLWindow = 4 * 1024 * 1024

// compactJSONLWindow is the tail byte window scanned in the session JSONL when
// resolving whether compaction has completed.
const compactJSONLWindow = 262144

// hookTailLines is the maximum number of trailing lines read from a per-session
// hook file (matches the Python deque(maxlen=500)).
const hookTailLines = 500

// approveToolLabels maps a tool name to a human-readable action verb phrase for
// FormatTUIHint.
var approveToolLabels = map[string]string{
	"Bash":      "run a command",
	"Write":     "write a file",
	"Edit":      "edit a file",
	"MultiEdit": "edit files",
	"Read":      "read a file",
	"WebFetch":  "fetch a URL",
	"WebSearch": "perform a search",
}

// auqHintText is the canonical AUQ hint string. The frontend's isWaitingForAuq
// gating looks for the "asking a question" substring, so keep it stable.
const auqHintText = "Claude is asking a question — answer in Chat or switch to TUI"

// ── Helpers ────────────────────────────────────────────────────────────────

func stripANSI(text string) string {
	return ansiRE.ReplaceAllString(text, "")
}

func homeDir() (string, bool) {
	h, err := os.UserHomeDir()
	if err != nil {
		slog.Debug("claudestat: cannot resolve home dir", "err", err)
		return "", false
	}
	return h, true
}

// ── AUQ option regexes (compiled once) ─────────────────────────────────────

var (
	// multiOptRE matches a multi-select option line: "❯ [ ] label" / "[x] label".
	multiOptRE = regexp.MustCompile(`^[❯>]?\s*\[[ x]\]\s+(.+)$`)
	// singleOptRE matches a single-select numbered option line: "❯ 1. label".
	singleOptRE = regexp.MustCompile(`^[❯>]?\s*(\d+)\.\s+(.+)$`)
	// numberedPrefixRE matches a leading "N." prefix for description lookahead.
	numberedPrefixRE = regexp.MustCompile(`^[❯>]?\s*\d+\.`)
)

// ParseAUQFromScreen parses AskUserQuestion data from a captured tmux TUI
// screen. It returns the parsed payload and true, or (nil, false) when the
// screen does not show an AUQ widget.
//
// The returned map matches the Python shape:
//
//	{
//	  "question": string,
//	  "header": string,
//	  "multiSelect": bool,
//	  "allowFreeform": bool,           // true when a "Type something." option exists
//	  "options": []map[string]any{{"label": string, "description": string, ...}}
//	}
func ParseAUQFromScreen(screen string) (map[string]any, bool) {
	clean := stripANSI(screen)
	lines := strings.Split(clean, "\n")
	// strings.Split keeps a trailing "" if the text ends with \n; mirror
	// Python's splitlines() which drops it.
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}

	header := ""
	question := ""
	options := []map[string]any{}
	multiSelect := false
	allowFreeform := false
	state := "before" // before → header_found → question_found → options

	i := 0
	for i < len(lines) {
		raw := lines[i]
		stripped := strings.TrimSpace(raw)
		i++

		switch state {
		case "before":
			if strings.Contains(stripped, "☐") {
				header = strings.TrimSpace(strings.ReplaceAll(stripped, "☐", ""))
				state = "header_found"
			}
			continue

		case "header_found":
			if stripped != "" {
				question = stripped
				state = "question_found"
			}
			continue

		case "question_found":
			// Multi-select: options have [ ] or [x] prefix.
			if m := multiOptRE.FindStringSubmatch(stripped); m != nil {
				multiSelect = true
				label := strings.TrimSpace(m[1])
				checked := strings.Contains(stripped, "[x]")
				low := strings.ToLower(label)
				if low != "type something." && low != "chat about this" {
					options = append(options, map[string]any{
						"label":       label,
						"description": "",
						"checked":     checked,
					})
				} else if low == "type something." {
					allowFreeform = true
				}
				continue
			}

			// Single-select: numbered options.
			if m := singleOptRE.FindStringSubmatch(stripped); m != nil {
				label := strings.TrimSpace(m[2])
				low := strings.ToLower(label)
				if low == "type something." {
					allowFreeform = true
				} else if low != "chat about this" {
					desc := ""
					if i < len(lines) {
						nextStripped := strings.TrimSpace(lines[i])
						if nextStripped != "" && !numberedPrefixRE.MatchString(nextStripped) {
							if !strings.Contains(nextStripped, "Enter to select") && !strings.Contains(nextStripped, "─") {
								desc = nextStripped
								i++
							}
						}
					}
					options = append(options, map[string]any{
						"label":       label,
						"description": desc,
					})
				}
			} else if strings.Contains(stripped, "Enter to select") ||
				strings.Contains(strings.ToLower(stripped), "space to select") ||
				(strings.Contains(stripped, strings.Repeat("─", 10)) && len(options) > 0) {
				goto done
			}
		}
	}

done:
	if question != "" && (len(options) > 0 || allowFreeform) {
		return map[string]any{
			"question":      question,
			"header":        header,
			"multiSelect":   multiSelect,
			"allowFreeform": allowFreeform,
			"options":       options,
		}, true
	}
	return nil, false
}

// ── ExitPlanMode menu parsing ──────────────────────────────────────────────

var (
	// planMenuOptRE matches a numbered ExitPlanMode menu line: "❯ 1. Yes, and …".
	// capture-pane -p yields plain text (no ANSI) including the ❯ highlight
	// marker, so the marker and label parse directly. Groups: 1=highlight,
	// 2=number, 3=label.
	planMenuOptRE = regexp.MustCompile(`(?m)^\s*(❯)?\s*(\d+)\.\s+(.+?)\s*$`)
	// planApprovePhrasingRE is a plan-specific approve phrasing used to recognize
	// the ExitPlanMode menu structurally (resilient to wording/order changes).
	planApprovePhrasingRE = regexp.MustCompile(`(?i)bypass permissions|auto-?accept edits|manually approve edits`)
)

// PlanMenuOption is one parsed ExitPlanMode menu row.
type PlanMenuOption struct {
	Index       int    `json:"index"`       // 0-based position in the rendered list
	Label       string `json:"label"`       // text after "N. "
	Highlighted bool   `json:"highlighted"` // the ❯ cursor is on this row
}

// ParsePlanMenu extracts the numbered options from a captured ExitPlanMode menu
// screen. Recognition is structural so it survives wording/order/count changes
// across Claude Code versions: ≥2 numbered options plus a plan-specific approve
// phrasing, or the stable "Would you like to proceed" prompt. Returns the
// options, the highlighted row index (0 if none marked), and whether the screen
// looks like a plan menu.
func ParsePlanMenu(screen string) (opts []PlanMenuOption, highlightedIdx int, ok bool) {
	// The plan body renders directly ABOVE the menu and routinely contains
	// numbered lists of its own, so a whole-screen sweep would absorb plan
	// content as extra "options" — corrupting both the rendered card and the
	// index-delta arrow-key navigation built on these options. Anchor to the
	// stable prompt line when present…
	region := screen
	if i := strings.LastIndex(screen, "Would you like to proceed"); i >= 0 {
		region = screen[i:]
	}
	matches := planMenuOptRE.FindAllStringSubmatch(region, -1)
	// …then keep only the LAST run of consecutively-numbered rows starting at
	// "1." — the real menu always renders as 1..N at the bottom; any earlier
	// numbered rows are plan content.
	start := -1
	for i, m := range matches {
		if m[2] == "1" {
			start = i
		}
	}
	if start < 0 {
		return nil, 0, false
	}
	run := matches[start : start+1]
	for i := start + 1; i < len(matches); i++ {
		n, _ := strconv.Atoi(matches[i][2])
		prev, _ := strconv.Atoi(matches[i-1][2])
		if n != prev+1 {
			break
		}
		run = append(run, matches[i])
	}
	for i, m := range run {
		o := PlanMenuOption{Index: i, Label: strings.TrimSpace(m[3]), Highlighted: m[1] == "❯"}
		if o.Highlighted {
			highlightedIdx = i
		}
		opts = append(opts, o)
	}
	if len(opts) < 2 {
		return nil, 0, false
	}
	hasApprovePhrasing := false
	for _, o := range opts {
		if planApprovePhrasingRE.MatchString(o.Label) {
			hasApprovePhrasing = true
			break
		}
	}
	if !hasApprovePhrasing && !strings.Contains(screen, "Would you like to proceed") {
		return nil, 0, false
	}
	return opts, highlightedIdx, true
}

// ── PID waiting state ──────────────────────────────────────────────────────

// pidSession is the subset of ~/.claude/sessions/{pid}.json we read.
type pidSession struct {
	Status     string `json:"status"`
	WaitingFor string `json:"waitingFor"`
}

// GetPIDWaitingState returns (waitingFor, hintType, true) if the Claude CLI
// process is paused waiting for user input, or ("", "", false) otherwise.
//
// hintType is one of:
//
//	"auq"     — AskUserQuestion: user should reply in Chat
//	"approve" — tool approval: user must interact in TUI
//
// It reads ~/.claude/sessions/{pid}.json.
func GetPIDWaitingState(pid int) (waitingFor string, hintType string, ok bool) {
	if pid == 0 {
		return "", "", false
	}
	home, hok := homeDir()
	if !hok {
		return "", "", false
	}
	sf := filepath.Join(home, ".claude", "sessions", strconv.Itoa(pid)+".json")
	b, err := os.ReadFile(sf)
	if err != nil {
		// Missing file or unreadable → not waiting.
		return "", "", false
	}
	var data pidSession
	if err := json.Unmarshal(b, &data); err != nil {
		return "", "", false
	}
	if data.Status != "waiting" {
		return "", "", false
	}
	if data.WaitingFor == "" {
		return "", "", false
	}
	if strings.Contains(data.WaitingFor, "AskUserQuestion") {
		return data.WaitingFor, "auq", true
	}
	return data.WaitingFor, "approve", true
}

// FormatTUIHint returns a human-readable hint describing what Claude is waiting
// for.
func FormatTUIHint(waitingFor, hintType string) string {
	if hintType == "auq" {
		return auqHintText
	}
	// approve * → extract tool name.
	tool := strings.TrimSpace(strings.TrimPrefix(waitingFor, "approve "))
	if tool == "" {
		tool = "action"
	}
	desc, found := approveToolLabels[tool]
	if !found {
		desc = "use " + tool
	}
	return "Claude needs approval to " + desc + " — go to TUI"
}

// ── Hook file reader ───────────────────────────────────────────────────────

// SessionHooks holds the most-recent AUQ and approval hook payloads for a
// session, as recorded by the PreToolUse hook. Both are raw JSON objects so
// unknown keys pass through to the frontend.
type SessionHooks struct {
	// AUQ is the raw tool_input of the most recent AskUserQuestion call, or nil.
	AUQ map[string]any
	// Approve is {"tool_name": string, "tool_input": map[string]any} for the
	// most recent non-AUQ tool call, or nil.
	Approve map[string]any
}

func hooksFile(home, claudeSessionID string) string {
	return filepath.Join(home, ".claude_manager", "hooks", claudeSessionID+".jsonl")
}

func compactMarkerFile(home, claudeSessionID string) string {
	return filepath.Join(home, ".claude_manager", "compact_state", claudeSessionID+".json")
}

// readHookTail returns the last hookTailLines lines of the per-session hook
// file (newest last), or (nil, false) if the file is missing/unreadable.
func readHookTail(home, claudeSessionID string) ([]string, bool) {
	hookFile := hooksFile(home, claudeSessionID)
	f, err := os.Open(hookFile)
	if err != nil {
		return nil, false
	}
	defer f.Close()

	ring := make([]string, 0, hookTailLines)
	sc := bufio.NewScanner(f)
	// Allow long hook lines (tool inputs can be large).
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if len(ring) < hookTailLines {
			ring = append(ring, line)
		} else {
			// Slide the window: drop oldest, append newest.
			copy(ring, ring[1:])
			ring[len(ring)-1] = line
		}
	}
	return ring, true
}

// hookEntry is the parsed shape of a single per-session hook line.
type hookEntry struct {
	ToolName  string         `json:"tool_name"`
	ToolUseID string         `json:"tool_use_id"`
	ToolInput map[string]any `json:"tool_input"`
}

// ReadSessionHooks returns the most-recent AUQ and approval payloads recorded in
// the per-session hook file for the given Claude session id. Either returned map
// may be nil. Reading a missing file yields (nil, nil).
func ReadSessionHooks(claudeSessionID string) (auq map[string]any, approve map[string]any) {
	h := ReadSessionHooksStruct(claudeSessionID)
	return h.AUQ, h.Approve
}

// ReadSessionHooksStruct is the struct-returning variant of ReadSessionHooks.
func ReadSessionHooksStruct(claudeSessionID string) SessionHooks {
	home, ok := homeDir()
	if !ok {
		return SessionHooks{}
	}
	tail, ok := readHookTail(home, claudeSessionID)
	if !ok {
		return SessionHooks{}
	}
	var entry SessionHooks
	for _, line := range tail {
		var d hookEntry
		if err := json.Unmarshal([]byte(line), &d); err != nil {
			continue
		}
		if d.ToolName == "" {
			continue
		}
		if d.ToolName == "AskUserQuestion" {
			if d.ToolInput != nil {
				entry.AUQ = d.ToolInput
			} else {
				entry.AUQ = map[string]any{}
			}
		} else {
			ti := d.ToolInput
			if ti == nil {
				ti = map[string]any{}
			}
			entry.Approve = map[string]any{
				"tool_name":  d.ToolName,
				"tool_input": ti,
			}
		}
	}
	return entry
}

// ── Compacting detection ───────────────────────────────────────────────────

// compactMarker is the subset of the PreCompact marker file we read.
type compactMarker struct {
	StartedAtEpoch float64 `json:"started_at_epoch"`
}

// IsCompactingViaHook returns true if the PreCompact hook fired and compaction
// is in flight for the given session.
//
// It self-clears the marker (so future polls return false) when any of:
//   - the marker is older than compactHookTimeout (stale),
//   - the session JSONL has any entry timestamped >= marker.started + grace
//     (Claude writes nothing during compaction, so any new line means we moved
//     past it),
//   - tuiScreen was captured (non-empty) but no longer shows a live
//     "Compacting conversation" banner with a progress-bar glyph.
//
// Pass tuiScreen == "" to skip the TUI-side resolution check.
func IsCompactingViaHook(claudeSessionID, cwd, tuiScreen string) bool {
	home, ok := homeDir()
	if !ok {
		return false
	}
	marker := compactMarkerFile(home, claudeSessionID)
	b, err := os.ReadFile(marker)
	if err != nil {
		return false
	}

	drop := func() bool {
		if err := os.Remove(marker); err != nil && !os.IsNotExist(err) {
			slog.Debug("claudestat: failed to drop compact marker", "session", claudeSessionID, "err", err)
		}
		return false
	}

	var meta compactMarker
	started := 0.0
	if err := json.Unmarshal(b, &meta); err == nil {
		started = meta.StartedAtEpoch
	}

	if started <= 0.0 || time.Since(time.Unix(0, int64(started*float64(time.Second)))) > compactHookTimeout {
		return drop()
	}

	// JSONL-side resolution: any entry timestamped past started+grace.
	jsonlPath := FindSessionJSONL(claudeSessionID, cwd)
	if jsonlPath != "" {
		if compactionResolvedInJSONL(jsonlPath, started) {
			return drop()
		}
	}

	// TUI-side resolution: a fresh screen capture that no longer shows the live
	// compaction status bar means the hook signal is stale.
	if tuiScreen != "" {
		if !screenShowsCompacting(tuiScreen) {
			return drop()
		}
	}

	return true
}

// compactionResolvedInJSONL reports whether the session JSONL contains any entry
// timestamped at or after started+grace, scanning only the tail window.
func compactionResolvedInJSONL(jsonlPath string, started float64) bool {
	tail, ok := readTailLines(jsonlPath, compactJSONLWindow, 200)
	if !ok {
		return false
	}
	thresh := started + compactGrace.Seconds()
	// Iterate newest-first.
	for i := len(tail) - 1; i >= 0; i-- {
		line := tail[i]
		if !strings.Contains(line, `"timestamp"`) {
			continue
		}
		var d struct {
			Timestamp string `json:"timestamp"`
		}
		if err := json.Unmarshal([]byte(line), &d); err != nil {
			continue
		}
		if d.Timestamp == "" {
			continue
		}
		when, ok := parseISOEpoch(d.Timestamp)
		if !ok {
			continue
		}
		if when >= thresh {
			return true
		}
	}
	return false
}

// parseISOEpoch parses an ISO-8601 timestamp (with optional trailing Z) into
// Unix seconds (float).
func parseISOEpoch(ts string) (float64, bool) {
	// Try a few layouts; the Python code uses datetime.fromisoformat which
	// accepts both "Z" and explicit offsets.
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
	} {
		if t, err := time.Parse(layout, ts); err == nil {
			return float64(t.UnixNano()) / float64(time.Second), true
		}
	}
	return 0, false
}

// screenShowsCompacting reports whether the tail of the TUI screen shows a live
// "Compacting conversation" banner together with a progress-bar glyph in the
// same or next line.
func screenShowsCompacting(tuiScreen string) bool {
	tailLines := lastLines(splitLines(tuiScreen), compactTUITailLines)
	for i, ln := range tailLines {
		if !strings.Contains(ln, "Compacting conversation") {
			continue
		}
		end := i + 2
		if end > len(tailLines) {
			end = len(tailLines)
		}
		window := strings.Join(tailLines[i:end], "\n")
		for _, ch := range compactBarChars {
			if strings.Contains(window, ch) {
				return true
			}
		}
	}
	return false
}

// CompactingFromScreen scans a TUI screen for the live compaction banner and
// returns (progress, true) when found. progress is e.g. "45%" or "" if no
// percentage was rendered. This is the TUI-only detection path (path (b) in the
// Python compute_session_status); the percentage is only available here.
func CompactingFromScreen(tuiScreen string) (progress string, compacting bool) {
	tailLines := lastLines(splitLines(tuiScreen), compactTUITailLines)
	for i, ln := range tailLines {
		if !strings.Contains(ln, "Compacting conversation") {
			continue
		}
		end := i + 2
		if end > len(tailLines) {
			end = len(tailLines)
		}
		window := tailLines[i:end]
		windowText := strings.Join(window, "\n")
		hasBar := false
		for _, ch := range compactBarChars {
			if strings.Contains(windowText, ch) {
				hasBar = true
				break
			}
		}
		if !hasBar {
			continue
		}
		pct := ""
		for _, wl := range window {
			if m := compactPctRE.FindStringSubmatch(wl); m != nil {
				if val, err := strconv.Atoi(m[1]); err == nil && val >= 0 && val <= 100 {
					pct = strconv.Itoa(val) + "%"
					break
				}
			}
		}
		return pct, true
	}
	return "", false
}

// ── Pending AUQ from hooks ─────────────────────────────────────────────────

// PendingAUQFromHooks returns the latest unanswered AUQ tool_input from the
// per-session hook file, or (nil, false).
//
// Logic (mirrors the Python _pending_auq_from_hooks):
//  1. Find the most recent AUQ entry in the per-session hook file.
//  2. Check the session JSONL — if the AUQ's tool_use_id already has a
//     corresponding tool_result, the user has answered → return (nil, false).
//  3. Otherwise it is pending; return its tool_input.
func PendingAUQFromHooks(claudeSessionID, cwd string) (map[string]any, bool) {
	home, ok := homeDir()
	if !ok {
		return nil, false
	}
	tail, ok := readHookTail(home, claudeSessionID)
	if !ok {
		return nil, false
	}

	var latestAUQID string
	var latestAUQInput map[string]any
	// Iterate newest-first.
	for i := len(tail) - 1; i >= 0; i-- {
		var d hookEntry
		if err := json.Unmarshal([]byte(tail[i]), &d); err != nil {
			continue
		}
		if d.ToolName == "AskUserQuestion" {
			latestAUQID = d.ToolUseID
			latestAUQInput = d.ToolInput
			break
		}
	}

	if latestAUQID == "" || latestAUQInput == nil {
		return nil, false
	}

	// Check whether this AUQ was already answered (tool_result in JSONL).
	// A `decided` verdict means the AUQ's fate is known and it is NOT pending:
	// either a tool_result was found (answered), or the id is buried before the
	// scan window in a file larger than the window — asked long ago, so Claude
	// has produced megabytes of transcript since and it is necessarily resolved.
	// Only (decided == false) — a recent id with no result yet, or a small file
	// with no id at all — leaves the AUQ genuinely pending.
	jsonlPath := FindSessionJSONL(claudeSessionID, cwd)
	if jsonlPath != "" {
		if _, decided := auqAnsweredInJSONL(jsonlPath, latestAUQID); decided {
			return nil, false
		}
	}

	return latestAUQInput, true
}

// auqAnsweredInJSONL scans the tail window of the session JSONL for the AUQ
// tool_use_id. It returns:
//
//	(true,  true)  — id seen with a tool_result → answered
//	(false, true)  — id absent and file larger than the window → answered (buried)
//	(false, false) — id seen without a tool_result, OR window covers whole file
//	                 and id absent → genuinely pending (caller keeps the AUQ)
func auqAnsweredInJSONL(jsonlPath, auqID string) (answered, decided bool) {
	return auqAnsweredInJSONLWindow(jsonlPath, auqID, auqJSONLWindow)
}

// auqAnsweredInJSONLWindow is auqAnsweredInJSONL with an injectable tail-scan
// window (the production caller passes auqJSONLWindow; tests pass a small value
// to exercise the buried-before-window branch without a multi-MB fixture).
func auqAnsweredInJSONLWindow(jsonlPath, auqID string, window int64) (answered, decided bool) {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return false, false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return false, false
	}
	size := fi.Size()
	off := int64(0)
	if size > window {
		off = size - window
	}
	if _, err := f.Seek(off, 0); err != nil {
		return false, false
	}
	buf := make([]byte, size-off)
	if _, err := readFull(f, buf); err != nil {
		return false, false
	}
	needle := []byte(auqID)
	resultMark := []byte(`"tool_result"`)
	idSeen := false
	for _, raw := range splitBytesNL(buf) {
		if containsBytes(raw, needle) {
			idSeen = true
			if containsBytes(raw, resultMark) {
				return true, true // answered
			}
		}
	}
	if !idSeen && size > window {
		return false, true // buried older than window → answered
	}
	// id seen without tool_result, or whole file scanned and id absent → pending.
	return false, false
}

// ── small byte/line utilities (stdlib-only) ────────────────────────────────

func splitLines(s string) []string {
	lines := strings.Split(s, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}
	return lines
}

func lastLines(lines []string, n int) []string {
	if len(lines) <= n {
		return lines
	}
	return lines[len(lines)-n:]
}

// readTailLines reads up to the last `window` bytes of a file and returns up to
// the last `maxLines` decoded text lines.
func readTailLines(path string, window int64, maxLines int) ([]string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, false
	}
	size := fi.Size()
	off := int64(0)
	if size > window {
		off = size - window
	}
	if _, err := f.Seek(off, 0); err != nil {
		return nil, false
	}
	buf := make([]byte, size-off)
	if _, err := readFull(f, buf); err != nil {
		return nil, false
	}
	lines := strings.Split(string(buf), "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return lines, true
}

func readFull(f *os.File, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := f.Read(buf[total:])
		total += n
		if err != nil {
			if total == len(buf) {
				return total, nil
			}
			return total, err
		}
	}
	return total, nil
}

func splitBytesNL(b []byte) [][]byte {
	var out [][]byte
	start := 0
	for i := 0; i < len(b); i++ {
		if b[i] == '\n' {
			out = append(out, b[start:i])
			start = i + 1
		}
	}
	if start <= len(b) {
		out = append(out, b[start:])
	}
	return out
}

func containsBytes(haystack, needle []byte) bool {
	if len(needle) == 0 {
		return true
	}
	if len(needle) > len(haystack) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := 0; j < len(needle); j++ {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
