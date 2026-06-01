package claudestat

import (
	"os"
	"path/filepath"
	"strings"
)

// projectsDir returns ~/.claude/projects, or "" if it is not a directory.
func projectsDir() string {
	home, ok := homeDir()
	if !ok {
		return ""
	}
	d := filepath.Join(home, ".claude", "projects")
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
// _find_session_jsonl; kept local so this package depends only on the standard
// library.)
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

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}
