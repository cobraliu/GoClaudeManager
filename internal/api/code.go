package api

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/fsutil"
)

// registerCodeRoutes wires the /{id}/code/* endpoints ported from
// app/api/code_api.py onto the sessions subrouter (already authenticated). All
// paths are relative to the sessions mount (/api/sessions).
func registerCodeRoutes(r chi.Router, d Deps) {
	r.Get("/{id}/code/changed-files", func(w http.ResponseWriter, r *http.Request) { codeChangedFiles(d, w, r) })
	r.Get("/{id}/code/file", func(w http.ResponseWriter, r *http.Request) { codeFile(d, w, r) })
	r.Get("/{id}/code/tree", func(w http.ResponseWriter, r *http.Request) { codeTree(d, w, r) })
	r.Get("/{id}/code/dirs", func(w http.ResponseWriter, r *http.Request) { codeDirs(d, w, r) })
	r.Get("/{id}/code/exists", func(w http.ResponseWriter, r *http.Request) { codeExists(d, w, r) })
}

// ── extension → highlight-language map (code_api.py _EXT_LANG) ───────────────

var codeExtLang = map[string]string{
	".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
	".py": "python", ".css": "css", ".scss": "scss", ".less": "css",
	".html": "xml", ".htm": "xml", ".xml": "xml",
	".json": "json", ".jsonc": "json",
	".md": "markdown", ".mdx": "markdown",
	".sh": "bash", ".bash": "bash", ".zsh": "bash",
	".yaml": "yaml", ".yml": "yaml",
	".toml": "toml", ".ini": "ini", ".cfg": "ini",
	".rs": "rust", ".go": "go", ".java": "java",
	".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
	".c": "c", ".h": "c", ".hpp": "cpp",
	".sql": "sql", ".graphql": "graphql", ".gql": "graphql",
	".env": "bash", ".txt": "plaintext",
}

// codeSkipDirs mirrors code_api.py _SKIP_DIRS — the directories pruned from the
// tree / dirs listing. This is the code-browser's own fixed set (independent of
// the admin blacklist used elsewhere); we keep it verbatim from Python.
var codeSkipDirs = []string{
	".git", "__pycache__", "node_modules", ".venv", "venv", "env",
	"dist", "build", ".next", ".nuxt", ".cache", "coverage", ".tox",
	".mypy_cache", ".pytest_cache", "target", "out", ".idea", ".vscode",
}

// Untracked-dir probe limits (code_api.py).
const (
	untrackedDirMaxFiles      = 500
	untrackedDirMaxBytes      = 50 * 1024 * 1024 // 50 MB
	untrackedLineCountMaxByte = 1 * 1024 * 1024  // 1 MB
)

// ── GET /{id}/code/changed-files ─────────────────────────────────────────────

func codeChangedFiles(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	cwd := s.Cwd

	ctx := r.Context()
	out := codeGitOut(d, ctx, cwd, "status", "--porcelain")
	files := []map[string]any{}
	warnings := []map[string]any{}
	if out == "" {
		writeJSON(w, http.StatusOK, map[string]any{"files": files, "warnings": warnings})
		return
	}

	// Collect numstat (added/removed) for tracked + staged changes.
	type ar struct{ a, r int }
	numstat := map[string]ar{}
	for _, args := range [][]string{
		{"diff", "--numstat", "HEAD"},
		{"diff", "--numstat", "--cached", "HEAD"},
	} {
		nsOut := codeGitOut(d, ctx, cwd, args...)
		for _, line := range strings.Split(nsOut, "\n") {
			parts := strings.Split(line, "\t")
			if len(parts) != 3 {
				continue
			}
			a := parseNumOrZero(parts[0])
			rm := parseNumOrZero(parts[1])
			p := parts[2]
			prev := numstat[p]
			numstat[p] = ar{prev.a + a, prev.r + rm}
		}
	}

	statusMap := map[byte]string{
		'M': "modified", 'A': "added", 'D': "deleted",
		'R': "renamed", 'C': "copied", 'U': "conflict",
		'?': "untracked",
	}

	var safeDirsToExpand []string

	for _, line := range strings.Split(out, "\n") {
		if len(line) < 4 {
			continue
		}
		xy := line[:2]
		path := line[3:]
		if i := strings.Index(path, " -> "); i >= 0 {
			path = path[i+len(" -> "):]
		}
		path = strings.Trim(strings.TrimSpace(path), `"`)

		var statusChar byte = '?'
		if t := strings.TrimSpace(xy); t != "" {
			statusChar = t[0]
		}
		status, ok := statusMap[statusChar]
		if !ok {
			status = "modified"
		}

		// Collapsed untracked directory: `?? codes/`
		if status == "untracked" && strings.HasSuffix(path, "/") {
			rel := strings.TrimRight(path, "/")
			probe := probeUntrackedDir(d, ctx, cwd, rel)
			if probe.exceeded || probe.isBareRepo {
				kind := "large_untracked_dir"
				if probe.isBareRepo {
					kind = "bare_git_repo"
				}
				warnings = append(warnings, map[string]any{
					"kind":              kind,
					"path":              rel,
					"file_count":        probe.fileCount,
					"approx_size_bytes": probe.totalBytes,
					"is_bare_repo":      probe.isBareRepo,
					"suggested_ignore":  rel + "/",
				})
				files = append(files, map[string]any{
					"path":           path,
					"status":         "untracked",
					"is_skipped_dir": true,
				})
				continue
			}
			safeDirsToExpand = append(safeDirsToExpand, rel)
			continue
		}

		entry := map[string]any{"path": path, "status": status}
		if v, ok := numstat[path]; ok {
			entry["added"] = v.a
			entry["removed"] = v.r
		} else if status == "untracked" {
			fp := filepath.Join(cwd, path)
			if fi, err := os.Stat(fp); err == nil && fi.Mode().IsRegular() {
				if lc, ok := countLinesBounded(fp); ok {
					entry["added"] = lc
					entry["removed"] = 0
				}
			}
		}
		files = append(files, entry)
	}

	// Second pass: expand safe untracked dirs, scoped per dir.
	for _, rel := range safeDirsToExpand {
		sub := codeGitOut(d, ctx, cwd, "status", "--porcelain", "--untracked-files=all", "--", rel)
		for _, line := range strings.Split(sub, "\n") {
			if len(line) < 4 || !strings.HasPrefix(line, "?? ") {
				continue
			}
			p := strings.Trim(strings.TrimSpace(line[3:]), `"`)
			if strings.HasSuffix(p, "/") {
				continue
			}
			entry := map[string]any{"path": p, "status": "untracked"}
			fp := filepath.Join(cwd, p)
			if fi, err := os.Stat(fp); err == nil && fi.Mode().IsRegular() {
				if lc, ok := countLinesBounded(fp); ok {
					entry["added"] = lc
					entry["removed"] = 0
				}
			}
			files = append(files, entry)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"files": files, "warnings": warnings})
}

type untrackedProbe struct {
	fileCount  int
	totalBytes int64
	exceeded   bool
	isBareRepo bool
}

// probeUntrackedDir sizes a collapsed untracked directory with early stop.
//
// It counts only the files git itself would track — i.e. it enumerates via
// `git status --porcelain --untracked-files=all -- rel`, which honors
// .gitignore — rather than walking the raw filesystem. Walking the FS counted
// already-ignored content (node_modules/, dist/) and falsely flagged dirs like
// frontend/ as "too large, add to .gitignore" even though git sees only a
// handful of small source files under them.
func probeUntrackedDir(d Deps, ctx context.Context, cwd, rel string) untrackedProbe {
	target := filepath.Join(cwd, rel)
	p := untrackedProbe{isBareRepo: isBareGitRepo(target)}
	// A nested git repo is reported by git as a single `?? rel/` entry and is
	// never recursed into, so the listing below would be empty — surface it via
	// the bare-repo flag instead of (mis)counting zero files.
	if p.isBareRepo {
		return p
	}
	sub := codeGitOut(d, ctx, cwd, "status", "--porcelain", "--untracked-files=all", "--", rel)
	for _, line := range strings.Split(sub, "\n") {
		if len(line) < 4 || !strings.HasPrefix(line, "?? ") {
			continue
		}
		rp := strings.Trim(strings.TrimSpace(line[3:]), `"`)
		if rp == "" || strings.HasSuffix(rp, "/") {
			continue
		}
		p.fileCount++
		if fi, err := os.Stat(filepath.Join(cwd, rp)); err == nil && fi.Mode().IsRegular() {
			p.totalBytes += fi.Size()
		}
		if p.fileCount >= untrackedDirMaxFiles || p.totalBytes >= untrackedDirMaxBytes {
			p.exceeded = true
			break
		}
	}
	return p
}

// isBareGitRepo mirrors code_api.py _is_bare_git_repo.
func isBareGitRepo(p string) bool {
	if fi, err := os.Stat(filepath.Join(p, "HEAD")); err != nil || !fi.Mode().IsRegular() {
		return false
	}
	if fi, err := os.Stat(filepath.Join(p, "objects")); err != nil || !fi.IsDir() {
		return false
	}
	if fi, err := os.Stat(filepath.Join(p, "refs")); err != nil || !fi.IsDir() {
		return false
	}
	return true
}

// countLinesBounded streams a newline count, returning ok=false for files over
// the size cap (mirrors code_api.py _count_lines_bounded). Matches Python's
// per-line iteration semantics: the count is the number of "lines" produced by
// iterating the file object, i.e. the number of newline-terminated segments
// plus a trailing unterminated segment.
func countLinesBounded(fp string) (int, bool) {
	fi, err := os.Stat(fp)
	if err != nil || fi.Size() > untrackedLineCountMaxByte {
		return 0, false
	}
	data, err := os.ReadFile(fp)
	if err != nil {
		return 0, false
	}
	if len(data) == 0 {
		return 0, true
	}
	n := strings.Count(string(data), "\n")
	if data[len(data)-1] != '\n' {
		n++ // trailing unterminated line
	}
	return n, true
}

// ── GET /{id}/code/file ──────────────────────────────────────────────────────

var diffHunkRe = regexp.MustCompile(`[-+](\d+)(?:,\d+)?`)

func codeFile(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	cwd := s.Cwd
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, http.StatusUnprocessableEntity, "path is required")
		return
	}
	metaOnly := r.URL.Query().Get("meta_only") == "true"

	target, err := fsutil.SafePath(cwd, path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Invalid path")
		return
	}
	fi, err := os.Stat(target)
	if err != nil {
		writeErr(w, http.StatusNotFound, "File not found")
		return
	}
	if fi.IsDir() {
		writeErr(w, http.StatusBadRequest, "Not a file")
		return
	}

	mtime := float64(fi.ModTime().UnixNano()) / 1e9

	if metaOnly {
		writeJSON(w, http.StatusOK, map[string]any{
			"path":          path,
			"is_binary":     true,
			"size":          fi.Size(),
			"mtime":         mtime,
			"content":       "",
			"language":      "binary",
			"added_lines":   []int{},
			"removed_lines": []int{},
			"truncated":     false,
		})
		return
	}

	f, err := os.Open(target)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	head := make([]byte, 8192)
	hn, _ := f.Read(head)
	f.Close()
	head = head[:hn]

	if bytesContainsNull(head) {
		writeJSON(w, http.StatusOK, map[string]any{
			"path":          path,
			"is_binary":     true,
			"size":          fi.Size(),
			"mtime":         mtime,
			"content":       "",
			"language":      "binary",
			"added_lines":   []int{},
			"removed_lines": []int{},
			"truncated":     false,
		})
		return
	}

	raw, err := os.ReadFile(target)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	content := decodeReplaceBytes(raw)

	// Admin-configurable truncation, computing total_lines from the full file.
	mode := d.Cfg.FileViewerMode()
	allLines := splitLinesPy(content)
	totalLines := len(allLines)
	truncated := false
	var truncatedBy string
	switch mode {
	case fsutil.FileViewerModeLines:
		maxLines := d.Cfg.FileViewerMaxLines()
		if totalLines > maxLines {
			truncated = true
			truncatedBy = "lines"
			allLines = allLines[:maxLines]
			content = strings.Join(allLines, "\n")
		}
	case fsutil.FileViewerModeBytes:
		maxBytes := d.Cfg.FileViewerMaxBytes()
		enc := []byte(content)
		if len(enc) > maxBytes {
			truncated = true
			truncatedBy = "bytes"
			content = decodeReplaceBytes(enc[:maxBytes])
			allLines = splitLinesPy(content)
		}
	}
	lines := allLines
	displayedLines := len(lines)

	language := codeExtLang[strings.ToLower(filepath.Ext(target))]
	if language == "" {
		language = "plaintext"
	}

	ctx := r.Context()
	diffOut := codeGitOut(d, ctx, cwd, "diff", "HEAD", "--", path)
	if diffOut == "" {
		diffOut = codeGitOut(d, ctx, cwd, "diff", "--cached", "--", path)
	}
	if diffOut == "" {
		tracked := codeGitOut(d, ctx, cwd, "ls-files", "--error-unmatch", path)
		if strings.TrimSpace(tracked) == "" && len(lines) > 0 {
			var sb strings.Builder
			sb.WriteString("--- /dev/null\n+++ b/" + path + "\n")
			sb.WriteString("@@ -0,0 +1," + strconv.Itoa(len(lines)) + " @@\n")
			plus := make([]string, len(lines))
			for i, ln := range lines {
				plus[i] = "+" + ln
			}
			sb.WriteString(strings.Join(plus, "\n"))
			diffOut = sb.String()
		}
	}

	added, removed := parseDiffLines(diffOut)

	resp := map[string]any{
		"path":            path,
		"content":         content,
		"language":        language,
		"added_lines":     added,
		"removed_lines":   removed,
		"truncated":       truncated,
		"displayed_lines": displayedLines,
		"diff_raw":        diffOut,
		"size":            fi.Size(),
		"mtime":           mtime,
		"total_lines":     totalLines,
	}
	if truncated {
		resp["truncated_by"] = truncatedBy
	} else {
		resp["truncated_by"] = nil
	}
	writeJSON(w, http.StatusOK, resp)
}

// parseDiffLines mirrors code_api.py _parse_diff_lines, returning sorted
// 1-based added (new-file) and removed (old-file) line numbers.
func parseDiffLines(diff string) ([]int, []int) {
	addedSet := map[int]struct{}{}
	removedSet := map[int]struct{}{}
	newLine := 0
	oldLine := 0
	for _, raw := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(raw, "@@"):
			if m := regexp.MustCompile(`\+(\d+)(?:,\d+)?`).FindStringSubmatch(raw); m != nil {
				if v, err := strconv.Atoi(m[1]); err == nil {
					newLine = v - 1
				}
			}
			if m := regexp.MustCompile(`-(\d+)(?:,\d+)?`).FindStringSubmatch(raw); m != nil {
				if v, err := strconv.Atoi(m[1]); err == nil {
					oldLine = v - 1
				}
			}
		case strings.HasPrefix(raw, "+") && !strings.HasPrefix(raw, "+++"):
			newLine++
			addedSet[newLine] = struct{}{}
		case strings.HasPrefix(raw, "-") && !strings.HasPrefix(raw, "---"):
			oldLine++
			removedSet[oldLine] = struct{}{}
		case !strings.HasPrefix(raw, "\\"):
			newLine++
			oldLine++
		}
	}
	return sortedKeys(addedSet), sortedKeys(removedSet)
}

func sortedKeys(m map[int]struct{}) []int {
	out := make([]int, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}

// ── GET /{id}/code/tree ──────────────────────────────────────────────────────

func codeTree(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	depth := queryInt(r, "depth", 2)
	if depth < 1 {
		depth = 1
	}
	if depth > 6 {
		depth = 6
	}
	path := r.URL.Query().Get("path")

	root, err := filepath.Abs(s.Cwd)
	if err != nil {
		writeErr(w, http.StatusNotFound, "cwd not found")
		return
	}
	if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
		writeErr(w, http.StatusNotFound, "cwd not found")
		return
	}

	start := root
	if path != "" && path != "." {
		start, err = fsutil.SafePath(root, path)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "Invalid path")
			return
		}
		if fi, err := os.Stat(start); err != nil || !fi.IsDir() {
			writeErr(w, http.StatusNotFound, "path not found")
			return
		}
	}

	writeJSON(w, http.StatusOK, buildCodeTree(start, root, 0, depth))
}

// buildCodeTree ports code_api.py _build_tree, including the depth-limit
// "children=null means has-content-not-loaded" lazy-load signal.
func buildCodeTree(path, root string, depth, maxDepth int) map[string]any {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		rel = filepath.Base(path)
	}
	if path == root {
		rel = "."
	}
	fi, err := os.Stat(path)
	if err != nil || !fi.IsDir() {
		return map[string]any{"name": filepath.Base(path), "path": rel, "type": "file"}
	}

	node := map[string]any{"name": filepath.Base(path), "path": rel, "type": "dir"}
	children := []map[string]any{}

	entries, derr := os.ReadDir(path)
	if derr != nil {
		node["children"] = children
		return node
	}
	// Sort: dirs first, then alphabetical (case-insensitive) — matches
	// sorted(key=lambda p: (p.is_file(), p.name.lower())).
	sort.SliceStable(entries, func(i, j int) bool {
		fi, fj := !entries[i].IsDir(), !entries[j].IsDir()
		if fi != fj {
			return !fi
		}
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})

	if depth < maxDepth {
		for _, e := range entries {
			name := e.Name()
			if codeInSkip(name) {
				continue
			}
			if !e.IsDir() && codeSkipExt(name) {
				continue
			}
			children = append(children, buildCodeTree(filepath.Join(path, name), root, depth+1, maxDepth))
		}
		node["children"] = children
		return node
	}

	// At depth limit: signal "has content, not yet loaded" via children=null.
	hasContent := false
	for _, e := range entries {
		name := e.Name()
		if codeInSkip(name) {
			continue
		}
		if e.IsDir() || !codeSkipExt(name) {
			hasContent = true
			break
		}
	}
	if hasContent {
		node["children"] = nil
	} else {
		node["children"] = children
	}
	return node
}

// ── GET /{id}/code/dirs ──────────────────────────────────────────────────────

func codeDirs(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")

	root, err := filepath.Abs(s.Cwd)
	if err != nil {
		writeErr(w, http.StatusNotFound, "cwd not found")
		return
	}
	if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
		writeErr(w, http.StatusNotFound, "cwd not found")
		return
	}

	target := root
	if path != "" && path != "." {
		target, err = fsutil.SafePath(root, path)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "Invalid path")
			return
		}
		if fi, err := os.Stat(target); err != nil || !fi.IsDir() {
			writeErr(w, http.StatusNotFound, "path not found")
			return
		}
	}

	dirs := []string{}
	if entries, err := os.ReadDir(target); err == nil {
		sort.SliceStable(entries, func(i, j int) bool {
			return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
		})
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			if codeInSkip(e.Name()) {
				continue
			}
			dirs = append(dirs, e.Name())
		}
	}
	outPath := path
	if outPath == "" {
		outPath = "."
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": outPath, "dirs": dirs})
}

// ── GET /{id}/code/exists ────────────────────────────────────────────────────

func codeExists(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, http.StatusUnprocessableEntity, "path is required")
		return
	}
	target, err := fsutil.SafePath(s.Cwd, path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Invalid path")
		return
	}
	exists := false
	isFile := false
	if fi, err := os.Stat(target); err == nil {
		exists = true
		isFile = fi.Mode().IsRegular()
	}
	writeJSON(w, http.StatusOK, map[string]any{"exists": exists, "is_file": isFile})
}

// ── shared helpers (local to this file) ──────────────────────────────────────

// codeGitOut runs `git <args>` in cwd and returns stdout, swallowing rc/stderr
// (mirrors code_api.py _git, which returns only result.stdout). The git package
// exposes no raw-stdout method, so we shell out locally here.
func codeGitOut(_ Deps, ctx context.Context, cwd string, args ...string) string {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	out, _ := cmd.Output()
	return string(out)
}

func codeInSkip(name string) bool {
	for _, s := range codeSkipDirs {
		if s == name {
			return true
		}
	}
	return false
}

// codeSkipExt mirrors code_api.py _SKIP_EXT.
func codeSkipExt(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".pyc", ".pyo", ".class", ".o", ".a", ".so", ".dll", ".exe", ".bin", ".wasm":
		return true
	}
	return false
}

func parseNumOrZero(s string) int {
	if s == "-" {
		return 0
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

func bytesContainsNull(b []byte) bool {
	for _, c := range b {
		if c == 0 {
			return true
		}
	}
	return false
}

// decodeReplaceBytes converts bytes to a string replacing invalid UTF-8 with
// U+FFFD (Python decode(errors="replace")).
func decodeReplaceBytes(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b))
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		if r == utf8.RuneError && size == 1 {
			sb.WriteRune('�')
			b = b[1:]
			continue
		}
		sb.WriteRune(r)
		b = b[size:]
	}
	return sb.String()
}

// splitLinesPy mirrors Python str.splitlines() for \n / \r\n: no trailing empty
// element for a final newline.
func splitLinesPy(s string) []string {
	if s == "" {
		return []string{}
	}
	parts := strings.Split(s, "\n")
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	for i, p := range parts {
		parts[i] = strings.TrimSuffix(p, "\r")
	}
	return parts
}
