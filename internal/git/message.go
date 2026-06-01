package git

import (
	"regexp"
	"strings"
)

// Commit-message construction helpers. These are pure functions (no git calls),
// ported from git_service.py make_commit_summary / make_commit_message.

var (
	reFenced   = regexp.MustCompile("(?s)```[\\w]*\\n.*?```")
	reFencedTl = regexp.MustCompile("(?s)~~~[\\w]*\\n.*?~~~")
	reInline   = regexp.MustCompile("`[^`\n]+`")
	reHeading  = regexp.MustCompile(`(?m)^#+\s*`)
	reBold     = regexp.MustCompile(`(?s)\*\*(.+?)\*\*`)
	reItalic   = regexp.MustCompile(`(?s)\*(.+?)\*`)
	reBullet   = regexp.MustCompile(`(?m)^\s*[-*]\s+`)
)

// stripCodeBlocks removes fenced code blocks (``` or ~~~) and inline code.
func stripCodeBlocks(text string) string {
	text = reFenced.ReplaceAllString(text, "")
	text = reFencedTl.ReplaceAllString(text, "")
	text = reInline.ReplaceAllString(text, "")
	return text
}

// stripMarkdownFormatting removes headings, bold/italic markers and bullets.
func stripMarkdownFormatting(text string) string {
	text = reHeading.ReplaceAllString(text, "")
	text = reBold.ReplaceAllString(text, "$1")
	text = reItalic.ReplaceAllString(text, "$1")
	text = reBullet.ReplaceAllString(text, "")
	return strings.TrimSpace(text)
}

// MakeCommitSummary extracts a commit subject from the non-code parts of the
// last assistant reply: the first non-code line of length >= 8, capped at
// maxLen. maxLen <= 0 means use the default of 72.
func MakeCommitSummary(lastAssistantText string, maxLen int) string {
	if maxLen <= 0 {
		maxLen = 72
	}
	noCode := stripCodeBlocks(lastAssistantText)
	noFmt := stripMarkdownFormatting(noCode)
	for _, line := range strings.Split(noFmt, "\n") {
		line = strings.TrimSpace(line)
		if len([]rune(line)) >= 8 {
			return truncateRunes(line, maxLen)
		}
	}
	return "Claude auto-commit"
}

// MakeCommitMessage builds a full git commit message from the prompts issued
// since the last commit plus the last assistant reply.
//
//	prompts: all user prompts since the last commit (may be empty / nil).
//	         For the legacy "plain string" path, pass a single PromptEntry with
//	         only Text set.
//	assistantText: the last assistant reply.
//
// Truncation: a single prompt keeps up to 512 chars, multiple prompts 256 each.
func MakeCommitMessage(prompts []PromptEntry, assistantText string) string {
	subject := MakeCommitSummary(assistantText, 0)

	noCode := stripCodeBlocks(assistantText)
	noFmt := stripMarkdownFormatting(noCode)
	var bodyLines []string
	for _, line := range strings.Split(noFmt, "\n") {
		if strings.TrimSpace(line) != "" {
			bodyLines = append(bodyLines, line)
		}
	}
	bodyResponse := strings.Join(bodyLines, "\n")

	// Keep only prompts with non-blank text.
	var promptList []PromptEntry
	for _, p := range prompts {
		if strings.TrimSpace(p.Text) != "" {
			promptList = append(promptList, p)
		}
	}

	parts := []string{subject}

	if len(promptList) > 0 {
		maxLen := 256
		if len(promptList) == 1 {
			maxLen = 512
		}
		var lines []string
		for _, p := range promptList {
			text := strings.TrimSpace(p.Text)
			runes := []rune(text)
			truncated := text
			if len(runes) > maxLen {
				truncated = string(runes[:maxLen]) + "…"
			}
			prefix := ""
			if p.TimeStr != "" {
				prefix = "[" + p.TimeStr + "] "
			}
			lines = append(lines, prefix+truncated)
		}
		label := "Prompts"
		if len(promptList) == 1 {
			label = "Prompt"
		}
		parts = append(parts, label+":\n"+strings.Join(lines, "\n\n"))
	}

	if bodyResponse != "" {
		parts = append(parts, "Response:\n"+bodyResponse)
	}

	return strings.Join(parts, "\n\n")
}

// truncateRunes caps s at n runes (Python slicing semantics, not bytes).
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
