package jsonl

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
)

// CursorEnrichResult mirrors enrich_cursor_session (no search_text/timestamp).
type CursorEnrichResult struct {
	Title   *string  `json:"title"`
	Prompts []string `json:"prompts"`
}

var (
	cursorUserQueryOpen  = regexp.MustCompile(`<user_query>\s*`)
	cursorUserQueryClose = regexp.MustCompile(`\s*</user_query>`)
	cursorUserInfo       = regexp.MustCompile(`(?s)<user_info>.*?</user_info>`)
	cursorSysReminder    = regexp.MustCompile(`(?s)<system_reminder>.*?</system_reminder>`)
)

// stripUserQueryTags removes Cursor's <user_query>/<user_info>/<system_reminder>
// wrappers. (Port of _strip_user_query_tags.)
func stripUserQueryTags(text string) string {
	text = cursorUserQueryOpen.ReplaceAllString(text, "")
	text = cursorUserQueryClose.ReplaceAllString(text, "")
	text = cursorUserInfo.ReplaceAllString(text, "")
	text = cursorSysReminder.ReplaceAllString(text, "")
	return strings.TrimSpace(text)
}

// cursorEntry decodes a Cursor JSONL line. Role is top-level; content lives in
// message.content as a block list.
type cursorEntry struct {
	Role    string `json:"role"`
	Message struct {
		Content []cursorBlock `json:"content"`
	} `json:"message"`
}

type cursorBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func cursorExtractText(blocks []cursorBlock) string {
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

// EnrichCursorSession ports enrich_cursor_session: {title, prompts}. Prompts is
// [first] / [first,last] / [first, penultimate, last] (each ≤120 chars).
func EnrichCursorSession(chatID, cwd string) (CursorEnrichResult, error) {
	jsonlPath := FindCursorJSONL(chatID, cwd)
	if jsonlPath == "" {
		return CursorEnrichResult{}, nil
	}
	f, err := os.Open(jsonlPath)
	if err != nil {
		return CursorEnrichResult{}, err
	}
	defer f.Close()

	var userMsgs []string
	sc := newScanner(f)
	for sc.Scan() {
		var d cursorEntry
		if err := json.Unmarshal(sc.Bytes(), &d); err != nil {
			continue
		}
		if d.Role != "user" {
			continue
		}
		text := stripUserQueryTags(cursorExtractText(d.Message.Content))
		if text != "" {
			userMsgs = append(userMsgs, text)
		}
	}
	if len(userMsgs) == 0 {
		return CursorEnrichResult{}, sc.Err()
	}

	res := CursorEnrichResult{Title: strPtr(truncate(userMsgs[0], 80))}
	switch {
	case len(userMsgs) == 1:
		res.Prompts = []string{userMsgs[0]}
	case len(userMsgs) == 2:
		res.Prompts = []string{userMsgs[0], userMsgs[1]}
	default:
		res.Prompts = []string{userMsgs[0], userMsgs[len(userMsgs)-2], userMsgs[len(userMsgs)-1]}
	}
	for i := range res.Prompts {
		res.Prompts[i] = truncate(res.Prompts[i], 120)
	}
	return res, sc.Err()
}

// GetCursorConversation ports get_cursor_conversation. ts is the 1-based index
// of the turn among non-empty user/assistant turns (stable across appends);
// only turns with ts > fromTs are returned.
func GetCursorConversation(chatID, cwd string, fromTs float64) ([]ConversationTurn, error) {
	jsonlPath := FindCursorJSONL(chatID, cwd)
	if jsonlPath == "" {
		return []ConversationTurn{}, nil
	}
	f, err := os.Open(jsonlPath)
	if err != nil {
		return []ConversationTurn{}, err
	}
	defer f.Close()

	turns := []ConversationTurn{}
	turnIndex := 0
	sc := newScanner(f)
	for sc.Scan() {
		var d cursorEntry
		if err := json.Unmarshal(sc.Bytes(), &d); err != nil {
			continue
		}
		if d.Role != "user" && d.Role != "assistant" {
			continue
		}
		var text string
		if d.Role == "user" {
			text = stripUserQueryTags(cursorExtractText(d.Message.Content))
		} else {
			text = cursorExtractText(d.Message.Content)
		}
		if text == "" {
			continue
		}
		turnIndex++
		if float64(turnIndex) > fromTs {
			turns = append(turns, ConversationTurn{Role: d.Role, Text: text, Ts: float64(turnIndex)})
		}
	}
	return turns, sc.Err()
}
