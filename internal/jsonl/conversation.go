package jsonl

import (
	"os"
	"strings"
)

// convState accumulates conversation bubbles; reused by the incremental cache.
// It mirrors the streaming state machine in get_conversation.
type convState struct {
	confirmed            []ConversationTurn
	currentGroup         []ConversationTurn
	pendingAssistant     *ConversationTurn
	latestStreaming      *ConversationTurn
	accumulatedAssistant []string
	inCompaction         bool
}

func newConvState() *convState { return &convState{} }

func (s *convState) clone() *convState {
	cp := &convState{
		confirmed:            append([]ConversationTurn(nil), s.confirmed...),
		currentGroup:         append([]ConversationTurn(nil), s.currentGroup...),
		accumulatedAssistant: append([]string(nil), s.accumulatedAssistant...),
		inCompaction:         s.inCompaction,
	}
	if s.pendingAssistant != nil {
		c := *s.pendingAssistant
		cp.pendingAssistant = &c
	}
	if s.latestStreaming != nil {
		c := *s.latestStreaming
		cp.latestStreaming = &c
	}
	return cp
}

func (s *convState) feed(d *rawEntry) {
	switch {
	case isUserMessage(d):
		if s.pendingAssistant != nil {
			s.currentGroup = append(s.currentGroup, *s.pendingAssistant)
			s.pendingAssistant = nil
		}
		s.accumulatedAssistant = nil
		s.latestStreaming = nil
		text := extractText(d.Message)
		if text != "" && isCompactMessage(text) {
			s.inCompaction = true
		} else if text != "" {
			s.inCompaction = false
			s.currentGroup = append(s.currentGroup, ConversationTurn{Role: "user", Text: text, Ts: parseISOTs(d.Timestamp)})
		}

	case d.Type == "queue-operation" && d.Operation == "enqueue":
		content := d.queueContentString()
		if content != "" && !isCompactMessage(content) {
			s.currentGroup = append(s.currentGroup, ConversationTurn{Role: "user", Text: content, Ts: parseISOTs(d.Timestamp)})
		}

	case d.Type == "assistant":
		if d.Message == nil {
			return
		}
		var stop string
		hasStop := d.Message.StopReason != nil
		if hasStop {
			stop = *d.Message.StopReason
		}
		switch {
		case hasStop && stop == "end_turn":
			text := extractText(d.Message)
			parts := s.accumulatedAssistant
			if text != "" {
				parts = append(append([]string(nil), parts...), text)
			}
			filtered := parts[:0]
			for _, p := range parts {
				if p != "" {
					filtered = append(filtered, p)
				}
			}
			s.accumulatedAssistant = nil
			if len(filtered) > 0 {
				pa := ConversationTurn{Role: "assistant", Text: strings.Join(filtered, "\n\n"), Ts: parseISOTs(d.Timestamp)}
				if s.inCompaction {
					pa.Compacting = true
				}
				s.pendingAssistant = &pa
			}
			s.latestStreaming = nil
		case !hasStop: // stop_reason is null/absent → streaming
			text := extractText(d.Message)
			if text != "" {
				ls := ConversationTurn{Role: "assistant", Text: text, Streaming: true, Ts: parseISOTs(d.Timestamp)}
				if s.inCompaction {
					ls.Compacting = true
				}
				s.latestStreaming = &ls
			}
		case stop == "tool_use":
			text := extractText(d.Message)
			if text != "" {
				s.accumulatedAssistant = append(s.accumulatedAssistant, text)
			}
		}

	case isTurnComplete(d):
		if s.pendingAssistant != nil {
			s.currentGroup = append(s.currentGroup, *s.pendingAssistant)
			s.pendingAssistant = nil
		}
		s.accumulatedAssistant = nil
		s.latestStreaming = nil
		s.inCompaction = false
		ts := parseISOTs(d.Timestamp)
		for i := range s.currentGroup {
			s.currentGroup[i].Ts = ts
		}
		s.confirmed = append(s.confirmed, s.currentGroup...)
		s.currentGroup = nil
	}
}

// result assembles the final conversation slice, filtering confirmed turns by
// fromTs and always appending the in-progress exchange.
func (s *convState) result(fromTs float64) []ConversationTurn {
	out := []ConversationTurn{}
	for _, t := range s.confirmed {
		if t.Ts > fromTs {
			out = append(out, t)
		}
	}
	switch {
	case s.latestStreaming != nil:
		out = append(out, s.currentGroup...)
		out = append(out, *s.latestStreaming)
	case s.pendingAssistant != nil:
		out = append(out, s.currentGroup...)
		out = append(out, *s.pendingAssistant)
	case s.inCompaction && len(s.currentGroup) == 0:
		out = append(out, ConversationTurn{Role: "assistant", Text: "Compacting conversation…", Streaming: true, Compacting: true})
	case len(s.currentGroup) > 0:
		out = append(out, s.currentGroup...)
	}
	return out
}

// GetConversation ports get_conversation (full scan). Returns chat bubbles
// [{role, text, streaming, ts}]; confirmed turns whose turn_duration ts > fromTs
// plus the always-included in-progress exchange.
func GetConversation(claudeSessionID, cwd string, fromTs float64) ([]ConversationTurn, error) {
	jsonlPath := FindSessionJSONL(claudeSessionID, cwd)
	if jsonlPath == "" {
		return []ConversationTurn{}, nil
	}
	f, err := os.Open(jsonlPath)
	if err != nil {
		return []ConversationTurn{}, err
	}
	defer f.Close()

	st := newConvState()
	sc := newScanner(f)
	for sc.Scan() {
		d, ok := decodeLine(sc.Bytes())
		if !ok {
			continue
		}
		st.feed(&d)
	}
	return st.result(fromTs), sc.Err()
}
