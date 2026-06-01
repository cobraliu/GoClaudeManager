package jsonl

import (
	"bufio"
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"time"
)

// scannerBufMax bounds bufio.Scanner token size. JSONL lines can be large
// (tool outputs, base64), so we allow up to 16MB per line; lines longer than
// this are skipped (matching the Python json.loads failure → continue).
const scannerBufMax = 16 * 1024 * 1024

const compactPrefix = "This session is being continued from a previous conversation"

var systemInjectionPrefixes = []string{
	compactPrefix,
	"<task-notification>",
	"<system-reminder>",
}

// slashCmdRe matches the Claude CLI slash-command wrapper:
//
//	<command-name>/goal</command-name> ... <command-args>...</command-args>
//
// normalized to "/goal <args>". (?s) makes "." match newlines (Python re.DOTALL).
var slashCmdRe = regexp.MustCompile(
	`(?s)^\s*<command-name>(/[^<\s]+)</command-name>.*?<command-args>(.*?)</command-args>\s*$`,
)

// newScanner returns a bufio.Scanner over r with a 16MB max token size.
func newScanner(r io.Reader) *bufio.Scanner {
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 0, 64*1024), scannerBufMax)
	return s
}

// normalizeSlashCmd collapses a CLI slash-command wrapper to "/cmd <args>".
func normalizeSlashCmd(text string) string {
	m := slashCmdRe.FindStringSubmatch(text)
	if m == nil {
		return text
	}
	cmd := m[1]
	args := strings.TrimSpace(m[2])
	if args != "" {
		return cmd + " " + args
	}
	return cmd
}

// blocks decodes a message's content into a slice of contentBlocks. Returns nil
// for a string-valued content (handled separately).
func (m *rawMessage) blocks() []contentBlock {
	if m == nil || len(m.Content) == 0 {
		return nil
	}
	var bs []contentBlock
	if err := json.Unmarshal(m.Content, &bs); err != nil {
		return nil
	}
	return bs
}

// contentString returns the content when it is a JSON string, else "".
func (m *rawMessage) contentString() (string, bool) {
	if m == nil || len(m.Content) == 0 {
		return "", false
	}
	var s string
	if err := json.Unmarshal(m.Content, &s); err == nil {
		return s, true
	}
	return "", false
}

// extractText extracts plain text from a message. For list content it joins the
// "text" blocks with spaces; for string content it uses the raw string. The
// result is slash-command-normalized. Ignores tool_result content.
// (Port of _extract_text.)
func extractText(m *rawMessage) string {
	if m == nil {
		return ""
	}
	var raw string
	if s, ok := m.contentString(); ok {
		raw = strings.TrimSpace(s)
	} else {
		var parts []string
		for _, b := range m.blocks() {
			if b.Type == "text" {
				parts = append(parts, b.Text)
			}
		}
		raw = strings.TrimSpace(strings.Join(parts, " "))
	}
	return normalizeSlashCmd(raw)
}

// isUserMessage reports whether the entry is a real user prompt (not a tool
// result). (Port of _is_user_message.)
func isUserMessage(d *rawEntry) bool {
	if d.Type != "user" || d.Message == nil || d.Message.Role != "user" {
		return false
	}
	for _, b := range d.Message.blocks() {
		if b.Type == "tool_result" {
			return false
		}
	}
	return true
}

// isCompactMessage reports whether text is a system-injected message.
func isCompactMessage(text string) bool {
	for _, p := range systemInjectionPrefixes {
		if strings.HasPrefix(text, p) {
			return true
		}
	}
	return false
}

// isTurnComplete reports whether the entry marks a completed Claude turn.
func isTurnComplete(d *rawEntry) bool {
	return d.Type == "system" && d.Subtype == "turn_duration"
}

// parseISOTs parses an ISO-8601 timestamp (with trailing "Z" or offset) into
// Unix seconds (float). Returns 0 on failure. (Port of _parse_iso_ts / _parse_ts.)
func parseISOTs(ts string) float64 {
	if ts == "" {
		return 0
	}
	// Go's RFC3339 handles "Z" and "+00:00" natively.
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		t, err = time.Parse(time.RFC3339, ts)
		if err != nil {
			return 0
		}
	}
	return float64(t.UnixNano()) / 1e9
}

// queueContentString returns the trimmed string content of a queue-operation
// entry. queue-operation content is a top-level "content" string field.
func (d *rawEntry) queueContentString() string {
	if len(d.Content) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(d.Content, &s); err != nil {
		return ""
	}
	return strings.TrimSpace(s)
}

// decodeLine unmarshals a single JSONL line into a rawEntry. Returns ok=false
// on malformed JSON (caller skips, matching Python's json.loads/except).
func decodeLine(line []byte) (rawEntry, bool) {
	var d rawEntry
	if err := json.Unmarshal(line, &d); err != nil {
		return rawEntry{}, false
	}
	return d, true
}
