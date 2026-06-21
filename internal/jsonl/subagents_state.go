package jsonl

// subagentState accumulates the per-sub-agent metrics derived from an
// agent-<id>.jsonl transcript. Like goalState/convState it follows the
// feed/clone/result idiom so the incremental Cache can advance it over only the
// appended bytes of a growing file.
//
// Token totals sum the per-message usage across every assistant line. Each
// assistant line in a sub-agent transcript is a distinct API message (unique
// id, no streaming-snapshot duplicates), so summing does not double-count.
type subagentState struct {
	model            string
	tokensIn         int
	tokensOut        int
	tokensCacheRead  int
	tokensCacheWrite int
	toolUses         int
	firstTs          float64
	lastTs           float64
	lastText         string
	lastStop         string
	sawError         bool
}

func newSubagentState() *subagentState { return &subagentState{} }

func (s *subagentState) feed(d *rawEntry) {
	ts := parseISOTs(d.Timestamp)
	if ts != 0 {
		if s.firstTs == 0 || ts < s.firstTs {
			s.firstTs = ts
		}
		if ts > s.lastTs {
			s.lastTs = ts
		}
	}

	switch d.Type {
	case "assistant":
		if d.Message == nil {
			return
		}
		if d.Message.Model != "" {
			s.model = d.Message.Model
		}
		if u := d.Message.Usage; u != nil {
			s.tokensIn += u.InputTokens
			s.tokensOut += u.OutputTokens
			s.tokensCacheRead += u.CacheReadInputTokens
			s.tokensCacheWrite += u.CacheCreationInputTokens
		}
		if d.Message.StopReason != nil {
			s.lastStop = *d.Message.StopReason
		}
		for _, b := range d.Message.blocks() {
			if b.Type == "tool_use" {
				s.toolUses++
			}
		}
		if t := extractText(d.Message); t != "" {
			s.lastText = t
		}
	case "user":
		if d.Message == nil {
			return
		}
		for _, b := range d.Message.blocks() {
			if b.Type == "tool_result" && b.IsError {
				s.sawError = true
			}
		}
	}
}

func (s *subagentState) clone() *subagentState {
	cp := *s
	return &cp
}

// outputPreview is the trailing assistant text, truncated for display.
func (s *subagentState) outputPreview() string { return truncate(s.lastText, 280) }
