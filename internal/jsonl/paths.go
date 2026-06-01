package jsonl

import (
	"os"
	"path/filepath"
	"strings"
)

// projectsDir returns ~/.claude/projects, or "" if it is not a directory.
func projectsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	d := filepath.Join(home, ".claude", "projects")
	if fi, err := os.Stat(d); err == nil && fi.IsDir() {
		return d
	}
	return ""
}

// cursorProjectsDir returns ~/.cursor/projects, or "" if not a directory.
func cursorProjectsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	d := filepath.Join(home, ".cursor", "projects")
	if fi, err := os.Stat(d); err == nil && fi.IsDir() {
		return d
	}
	return ""
}

// FindSessionJSONL locates the JSONL conversation file for a Claude session.
//
// Claude encodes the cwd into the project dir name by replacing "/" (and
// historically "_") with "-": e.g. /mnt/hdd2/foo_bar → -mnt-hdd2-foo-bar. We
// try both encodings, then fall back to scanning every project dir for a file
// named "<sessionID>.jsonl". Returns "" if not found. (Port of
// _find_session_jsonl.)
func FindSessionJSONL(claudeSessionID, cwd string) string {
	base := projectsDir()
	if base == "" {
		return ""
	}
	cwd = strings.TrimRight(cwd, "/")
	for _, encoded := range []string{
		strings.ReplaceAll(strings.ReplaceAll(cwd, "/", "-"), "_", "-"),
		strings.ReplaceAll(cwd, "/", "-"),
	} {
		p := filepath.Join(base, encoded, claudeSessionID+".jsonl")
		if fileExists(p) {
			return p
		}
	}
	// Fallback: search all project dirs.
	entries, err := os.ReadDir(base)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		p := filepath.Join(base, e.Name(), claudeSessionID+".jsonl")
		if fileExists(p) {
			return p
		}
	}
	return ""
}

// FindNewestClaudeSessionID returns the stem of the most-recently-modified
// JSONL in the Claude project dir for cwd, or "".
func FindNewestClaudeSessionID(cwd string) string {
	return FindNewestClaudeSessionIDExcluding(cwd, nil)
}

// FindNewestClaudeSessionIDExcluding is FindNewestClaudeSessionID but skips any
// JSONL whose stem is in exclude. Callers pass the set of agent_session_ids that
// belong to OTHER sessions so the newest-in-cwd fallback never adopts a sibling
// session's transcript. exclude may be nil.
func FindNewestClaudeSessionIDExcluding(cwd string, exclude map[string]bool) string {
	base := projectsDir()
	if base == "" {
		return ""
	}
	cwd = strings.TrimRight(cwd, "/")
	for _, encoded := range []string{
		strings.ReplaceAll(strings.ReplaceAll(cwd, "/", "-"), "_", "-"),
		strings.ReplaceAll(cwd, "/", "-"),
	} {
		dir := filepath.Join(base, encoded)
		if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		best := ""
		var bestMtime int64
		for _, e := range entries {
			if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
				continue
			}
			stem := strings.TrimSuffix(e.Name(), ".jsonl")
			if exclude[stem] {
				continue
			}
			fi, err := e.Info()
			if err != nil {
				continue
			}
			if mt := fi.ModTime().UnixNano(); mt > bestMtime {
				bestMtime = mt
				best = stem
			}
		}
		return best
	}
	return ""
}

// cursorCwdToSlug converts a workspace path to the Cursor project dir name:
// /home/sgf/Projs/foo → home-sgf-Projs-foo. (Port of _cwd_to_slug.)
func cursorCwdToSlug(cwd string) string {
	return strings.ReplaceAll(strings.Trim(cwd, "/"), "/", "-")
}

// FindCursorJSONL locates ~/.cursor/projects/<slug>/agent-transcripts/<chatID>/<chatID>.jsonl.
func FindCursorJSONL(chatID, cwd string) string {
	base := cursorProjectsDir()
	if base == "" {
		return ""
	}
	p := filepath.Join(base, cursorCwdToSlug(cwd), "agent-transcripts", chatID, chatID+".jsonl")
	if fileExists(p) {
		return p
	}
	return ""
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}
