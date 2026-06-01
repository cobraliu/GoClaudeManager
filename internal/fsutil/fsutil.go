// Package fsutil ports the read-only filesystem logic from the Python
// ClaudeManager (app/api/files.py and app/api/code_api.py) into pure,
// config-decoupled Go functions.
//
// All configuration (skip-dir names, file-viewer mode/limits, the root
// directory) is taken as explicit parameters so the package never depends on
// any config singleton. Structs that are serialized to the frontend use JSON
// field names matching the original Python (pydantic) responses.
package fsutil

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// ── Constants ported from the Python source ────────────────────────────────

// MaxFileSize mirrors files.py MAX_FILE_SIZE (1 MiB). read_file rejects files
// larger than this with HTTP 413 ("file too large (>1MB)"). This is the hard
// size guard the task refers to — the Python source has no separate ">500KB
// copy guard"; the authoritative read guard is this 1 MiB cap.
const MaxFileSize = 1 * 1024 * 1024

// MaxDirEntries mirrors files.py MAX_DIR_ENTRIES — the per-directory cap used
// by the flat list endpoint.
const MaxDirEntries = 500

// MaxSearchResults mirrors files.py MAX_SEARCH_RESULTS — the cap on name-search
// hits. We reuse the same value as the default cap for content search.
const MaxSearchResults = 200

// sniffBytes is the head-read size for the binary null-byte sniff, matching
// files.py _is_text (8192 bytes / 8 KiB).
const sniffBytes = 8192

// File-viewer modes mirror config.py FILE_VIEWER_MODE_* constants.
const (
	FileViewerModeUnlimited = "unlimited"
	FileViewerModeLines     = "lines"
	FileViewerModeBytes     = "bytes"
)

// Default viewer limits mirror config.py defaults.
const (
	DefaultFileViewerMaxLines = 3000
	DefaultFileViewerMaxBytes = 1024 * 1024 // 1 MiB
)

// ── Text-detection tables ported from files.py ─────────────────────────────

// textExtensions mirrors files.py TEXT_EXTENSIONS.
var textExtensions = map[string]struct{}{
	".txt": {}, ".md": {}, ".markdown": {}, ".rst": {}, ".json": {}, ".json5": {}, ".jsonl": {},
	".yaml": {}, ".yml": {}, ".toml": {}, ".ini": {}, ".cfg": {}, ".conf": {}, ".env": {},
	".py": {}, ".pyx": {}, ".pyi": {},
	".js": {}, ".jsx": {}, ".ts": {}, ".tsx": {}, ".mjs": {}, ".cjs": {},
	".css": {}, ".scss": {}, ".sass": {}, ".less": {},
	".html": {}, ".htm": {}, ".xml": {}, ".svg": {},
	".sh": {}, ".bash": {}, ".zsh": {}, ".fish": {}, ".ps1": {},
	".go": {}, ".rs": {}, ".java": {}, ".kt": {}, ".scala": {},
	".c": {}, ".h": {}, ".cpp": {}, ".cc": {}, ".cxx": {}, ".hpp": {},
	".rb": {}, ".php": {}, ".swift": {}, ".cs": {}, ".fs": {},
	".lua": {}, ".vim": {}, ".el": {},
	".sql": {}, ".graphql": {}, ".proto": {},
	".tf": {}, ".hcl": {},
	".r": {},
	".csv": {}, ".tsv": {},
	".log": {}, ".lock": {},
	".gitignore": {}, ".gitattributes": {}, ".editorconfig": {},
}

// specialNamesText mirrors files.py SPECIAL_NAMES_TEXT.
var specialNamesText = map[string]struct{}{
	"Makefile": {}, "Dockerfile": {}, "Vagrantfile": {}, "Gemfile": {},
	"Rakefile": {}, "Pipfile": {}, "Procfile": {}, "Brewfile": {},
	".gitignore": {}, ".gitattributes": {}, ".env": {}, ".editorconfig": {},
	"requirements.txt": {}, "setup.py": {}, "setup.cfg": {}, "pyproject.toml": {},
	"package.json": {}, "package-lock.json": {}, "yarn.lock": {},
	"go.mod": {}, "go.sum": {}, "Cargo.toml": {}, "Cargo.lock": {},
	"LICENSE": {}, "README": {}, "CHANGELOG": {}, "AUTHORS": {}, "NOTICE": {}, "COPYING": {},
}

// sqliteExtensions mirrors files.py SQLITE_EXTENSIONS.
var sqliteExtensions = map[string]struct{}{
	".db": {}, ".sqlite": {}, ".sqlite3": {}, ".db3": {},
}

// skipDirsMarked mirrors files.py SKIP_DIRS — directories that are *marked*
// is_skipped in flat listings (shown but flagged) and pruned during walks.
// This is distinct from the admin "blacklist" (skipDirs parameter) which is
// bypassed entirely.
var skipDirsMarked = map[string]struct{}{
	".git": {}, "__pycache__": {}, "node_modules": {}, ".venv": {}, "venv": {},
	".mypy_cache": {}, ".pytest_cache": {}, ".ruff_cache": {}, "dist": {}, ".next": {},
}

// archiveSuffixes mirrors files.py ARCHIVE_EXTENSIONS_SUFFIX.
var archiveSuffixes = []string{
	".zip", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz",
	".tar", ".gz", ".bz2", ".xz",
}

// ── Errors ─────────────────────────────────────────────────────────────────

var (
	// ErrTraversal is returned when a requested path escapes the allowed root.
	// Mirrors the Python HTTP 403 "path traversal not allowed".
	ErrTraversal = errors.New("path traversal not allowed")
	// ErrNotFound mirrors the Python 404 "file/path not found".
	ErrNotFound = errors.New("not found")
	// ErrNotFile is returned when a file operation targets a non-file.
	ErrNotFile = errors.New("not a file")
	// ErrNotDir is returned when a directory operation targets a non-directory.
	ErrNotDir = errors.New("not a directory")
	// ErrTooLarge mirrors the Python 413 "file too large (>1MB)".
	ErrTooLarge = errors.New("file too large")
	// ErrBinary mirrors the Python 415 "binary file not supported".
	ErrBinary = errors.New("binary file not supported")
)

// ── Path safety ────────────────────────────────────────────────────────────

// SafePath resolves rel against root and guarantees the result stays inside
// root. It ports files.py _resolve / code_api.py _safe_path: an empty/"."/"/"
// rel maps to root itself; any resolved target that is not root and not a
// descendant of root returns ErrTraversal.
//
// root is cleaned (its symlinks are NOT resolved — callers pass an already
// trusted absolute root). The returned path is an absolute, cleaned path.
func SafePath(root, rel string) (string, error) {
	base := filepath.Clean(root)
	if rel == "" || rel == "." || rel == "/" {
		return base, nil
	}
	// Strip leading slashes so an absolute-looking rel is treated as relative
	// to base (mirrors Python's rel.lstrip("/")).
	cleanedRel := strings.TrimLeft(rel, "/")
	target := filepath.Clean(filepath.Join(base, cleanedRel))
	if target == base {
		return target, nil
	}
	if !strings.HasPrefix(target, base+string(os.PathSeparator)) {
		return "", ErrTraversal
	}
	return target, nil
}

// ── Text / type detection ──────────────────────────────────────────────────

// IsProbablyText mirrors files.py _is_probably_text: an extension/name-only
// guess that never opens the file.
func IsProbablyText(name string) bool {
	if _, ok := specialNamesText[name]; ok {
		return true
	}
	_, ok := textExtensions[strings.ToLower(filepath.Ext(name))]
	return ok
}

// isTextFile mirrors files.py _is_text: probably-text by name, else sniff the
// first 8 KiB for a null byte.
func isTextFile(path string) bool {
	if IsProbablyText(filepath.Base(path)) {
		return true
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, sniffBytes)
	n, _ := io.ReadFull(f, buf)
	if n == 0 {
		return true
	}
	return !bytes.Contains(buf[:n], []byte{0})
}

// isSQLiteName reports whether name has a sqlite extension (files.py SQLITE_EXTENSIONS).
func isSQLiteName(name string) bool {
	_, ok := sqliteExtensions[strings.ToLower(filepath.Ext(name))]
	return ok
}

// isArchiveName mirrors files.py _is_archive_name.
func isArchiveName(name string) bool {
	n := strings.ToLower(name)
	for _, s := range archiveSuffixes {
		if strings.HasSuffix(n, s) {
			return true
		}
	}
	return false
}

// inSet is a small membership helper for the skipDirs slice parameter.
func inSet(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// ── 1. Directory tree listing ──────────────────────────────────────────────

// TreeNode is the nested directory-tree shape consumed by the frontend file
// tree. Field names match code_api.py _build_tree output ("name", "path",
// "type", "children"). For files, Children is nil and omitted. Size is a Go
// addition (the task asks for sizes); it is omitted for directories.
type TreeNode struct {
	Name     string      `json:"name"`
	Path     string      `json:"path"` // relative to root; root itself is "."
	Type     string      `json:"type"` // "dir" | "file"
	Size     *int64      `json:"size,omitempty"`
	Children []*TreeNode `json:"children,omitempty"`
}

// BuildTree walks root and returns a nested tree. Any directory whose NAME is
// in skipDirs is pruned at every depth (mirrors code_api.py _build_tree's
// `if child.name in _SKIP_DIRS: continue`, but using the caller-provided
// skipDirs instead of a hardcoded set). Entries are ordered dirs-first then
// alphabetical (case-insensitive), matching the Python
// `sorted(key=lambda p: (p.is_file(), p.name.lower()))`.
//
// Unlike the Python depth-limited lazy loader, this performs a full recursive
// walk (the task asks for the full tree). Symlinked directories are listed as
// files-less dir nodes but not descended into, to avoid cycles.
func BuildTree(root string, skipDirs []string) (*TreeNode, error) {
	root = filepath.Clean(root)
	info, err := os.Stat(root)
	if err != nil {
		return nil, ErrNotFound
	}
	if !info.IsDir() {
		return nil, ErrNotDir
	}
	return buildTreeNode(root, root, skipDirs), nil
}

func buildTreeNode(path, root string, skipDirs []string) *TreeNode {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		rel = filepath.Base(path)
	}
	if path == root {
		rel = "."
	}

	node := &TreeNode{Name: filepath.Base(path), Path: rel, Type: "dir", Children: []*TreeNode{}}

	entries, err := os.ReadDir(path)
	if err != nil {
		slog.Debug("fsutil: read dir failed", "path", path, "err", err)
		return node
	}

	// Sort: dirs first, then alphabetical (case-insensitive). os.DirEntry's
	// IsDir() is the equivalent of Python p.is_file() ordering inverted.
	sort.SliceStable(entries, func(i, j int) bool {
		fi, fj := !entries[i].IsDir(), !entries[j].IsDir() // is_file flag
		if fi != fj {
			return !fi // dirs (is_file=false) sort first
		}
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})

	for _, e := range entries {
		name := e.Name()
		isDir := e.IsDir()
		if isDir && inSet(skipDirs, name) {
			continue
		}
		childPath := filepath.Join(path, name)
		if isDir {
			node.Children = append(node.Children, buildTreeNode(childPath, root, skipDirs))
		} else {
			child := &TreeNode{Name: name, Path: mustRel(root, childPath), Type: "file"}
			if fi, ferr := e.Info(); ferr == nil {
				sz := fi.Size()
				child.Size = &sz
			}
			node.Children = append(node.Children, child)
		}
	}
	return node
}

func mustRel(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return filepath.Base(path)
	}
	return rel
}

// ── 2. File read with truncation ───────────────────────────────────────────

// ViewerSettings carries the admin-configurable truncation knobs (taken as
// parameters, not read from config). Mirrors config.py get_file_viewer_mode /
// _max_lines / _max_bytes.
type ViewerSettings struct {
	Mode     string // "unlimited" | "lines" | "bytes"
	MaxLines int
	MaxBytes int
}

// FileContent is the truncation-aware file-read result. JSON field names match
// the code_api.py /code/file response: "path", "content", "truncated",
// "truncated_by", "displayed_lines", "total_lines", "size", "is_binary".
type FileContent struct {
	Path           string `json:"path"`
	Content        string `json:"content"`
	Truncated      bool   `json:"truncated"`
	TruncatedBy    string `json:"truncated_by,omitempty"` // "lines" | "bytes"
	DisplayedLines int    `json:"displayed_lines"`
	TotalLines     int    `json:"total_lines"`
	Size           int64  `json:"size"`
	IsBinary       bool   `json:"is_binary"`
}

// ReadFile reads the file at rel under root, applying the path-safety check and
// the viewer truncation rules. It replicates both Python behaviors:
//
//   - files.py read_file hard guards: reject files > MaxFileSize (1 MiB) with
//     ErrTooLarge, reject binary (null byte in first 8 KiB) with ErrBinary.
//   - code_api.py get_file truncation: total_lines computed from the full file;
//     "lines" mode caps to MaxLines (joined with "\n"); "bytes" mode caps the
//     UTF-8 encoding to MaxBytes then decodes; "unlimited" returns everything.
//
// content is read as UTF-8 with invalid sequences replaced (mirrors Python
// errors="replace").
func ReadFile(root, rel string, vs ViewerSettings) (*FileContent, error) {
	target, err := SafePath(root, rel)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return nil, ErrNotFound
	}
	if info.IsDir() {
		return nil, ErrNotFile
	}
	if info.Size() > MaxFileSize {
		return nil, ErrTooLarge
	}
	if !isTextFile(target) {
		return nil, ErrBinary
	}

	raw, err := os.ReadFile(target)
	if err != nil {
		return nil, err
	}
	content := decodeReplace(raw)

	allLines := splitLines(content)
	totalLines := len(allLines)
	truncated := false
	truncatedBy := ""

	switch vs.Mode {
	case FileViewerModeLines:
		maxLines := vs.MaxLines
		if totalLines > maxLines {
			truncated = true
			truncatedBy = "lines"
			allLines = allLines[:maxLines]
			content = strings.Join(allLines, "\n")
		}
	case FileViewerModeBytes:
		maxBytes := vs.MaxBytes
		encoded := []byte(content)
		if len(encoded) > maxBytes {
			truncated = true
			truncatedBy = "bytes"
			content = decodeReplace(encoded[:maxBytes])
			allLines = splitLines(content)
		}
	default:
		// FileViewerModeUnlimited (and any unknown mode) returns everything.
	}

	relOut := mustRel(filepath.Clean(root), target)
	return &FileContent{
		Path:           relOut,
		Content:        content,
		Truncated:      truncated,
		TruncatedBy:    truncatedBy,
		DisplayedLines: len(allLines),
		TotalLines:     totalLines,
		Size:           info.Size(),
		IsBinary:       false,
	}, nil
}

// decodeReplace converts bytes to a string, replacing invalid UTF-8 sequences
// with U+FFFD, mirroring Python's decode(errors="replace").
func decodeReplace(b []byte) string {
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

// splitLines mirrors Python str.splitlines() for the common cases: it splits on
// \n and strips a trailing \r (so \r\n is handled). Unlike strings.Split it
// does NOT produce a trailing empty element for a final newline, matching
// splitlines() semantics relied on by the line-count logic.
func splitLines(s string) []string {
	if s == "" {
		return []string{}
	}
	parts := strings.Split(s, "\n")
	// Drop a single trailing empty element produced by a final "\n".
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	for i, p := range parts {
		parts[i] = strings.TrimSuffix(p, "\r")
	}
	return parts
}

// ── 3 & 4. Search ──────────────────────────────────────────────────────────

// FileEntry mirrors files.py FileEntry (the pydantic model serialized by the
// list/search endpoints). JSON field names match exactly: "name", "path",
// "type", "size", "is_text", "is_skipped", "is_sqlite", "is_archive".
type FileEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"` // relative to root
	Type      string `json:"type"` // "file" | "dir"
	Size      *int64 `json:"size"`
	IsText    bool   `json:"is_text"`
	IsSkipped bool   `json:"is_skipped"`
	IsSqlite  bool   `json:"is_sqlite"`
	IsArchive bool   `json:"is_archive"`
}

// SearchNames recursively finds files/dirs whose name contains q
// (case-insensitive) under root, mirroring files.py search_files. Directories
// whose name is in skipDirs OR in the marked SKIP_DIRS set are pruned (Python:
// `skip_names = SKIP_DIRS | _blacklisted_dirs()`). Hidden entries (leading
// dot) are excluded unless includeHidden is true. Results are capped at
// MaxSearchResults.
func SearchNames(root, q string, skipDirs []string, includeHidden bool) ([]FileEntry, error) {
	base := filepath.Clean(root)
	if info, err := os.Stat(base); err != nil || !info.IsDir() {
		return nil, ErrNotDir
	}
	needle := strings.ToLower(q)
	var results []FileEntry

	err := walkDirs(base, skipDirs, includeHidden, func(dir string, entries []os.DirEntry) bool {
		// Check directories first (Python checks dirs then files per root).
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			name := e.Name()
			if !includeHidden && strings.HasPrefix(name, ".") {
				continue
			}
			if strings.Contains(strings.ToLower(name), needle) {
				rel := mustRel(base, filepath.Join(dir, name))
				results = append(results, FileEntry{Name: name, Path: rel, Type: "dir"})
				if len(results) >= MaxSearchResults {
					return false
				}
			}
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if !includeHidden && strings.HasPrefix(name, ".") {
				continue
			}
			if strings.Contains(strings.ToLower(name), needle) {
				results = append(results, makeFileEntry(base, filepath.Join(dir, name), e))
				if len(results) >= MaxSearchResults {
					return false
				}
			}
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

func makeFileEntry(base, full string, e os.DirEntry) FileEntry {
	name := e.Name()
	isSq := isSQLiteName(name)
	isArc := isArchiveName(name)
	var size *int64
	if fi, err := e.Info(); err == nil {
		s := fi.Size()
		size = &s
	}
	return FileEntry{
		Name:      name,
		Path:      mustRel(base, full),
		Type:      "file",
		Size:      size,
		IsText:    !isSq && !isArc && IsProbablyText(name),
		IsSqlite:  isSq,
		IsArchive: isArc,
	}
}

// ContentMatch is a single grep-like hit: file (relative), 1-based line number,
// and the matching line as a snippet. JSON field names: "path", "line",
// "snippet".
type ContentMatch struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Snippet string `json:"snippet"`
}

// SearchContent performs a grep-like, case-insensitive substring search of file
// CONTENTS under root, respecting skipDirs (and the marked SKIP_DIRS set) and
// the same hidden-file rules as name search. Only files that look like text
// (IsProbablyText) and are within MaxFileSize are scanned, and binary files are
// skipped via a null-byte sniff — this mirrors the cost-control philosophy of
// files.py (cheap name-based text guess, bounded per-file work).
//
// Each matching line yields one ContentMatch; snippets are trimmed of trailing
// CR/LF and capped to maxSnippet runes. Results are capped at maxResults
// (pass <= 0 to use MaxSearchResults). There is no equivalent endpoint in the
// Python source; this follows the established conventions of that module.
func SearchContent(root, q string, skipDirs []string, includeHidden bool, maxResults, maxSnippet int) ([]ContentMatch, error) {
	base := filepath.Clean(root)
	if info, err := os.Stat(base); err != nil || !info.IsDir() {
		return nil, ErrNotDir
	}
	if maxResults <= 0 {
		maxResults = MaxSearchResults
	}
	if maxSnippet <= 0 {
		maxSnippet = 200
	}
	needle := strings.ToLower(q)
	var results []ContentMatch

	err := walkDirs(base, skipDirs, includeHidden, func(dir string, entries []os.DirEntry) bool {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if !includeHidden && strings.HasPrefix(name, ".") {
				continue
			}
			if !IsProbablyText(name) {
				continue
			}
			full := filepath.Join(dir, name)
			fi, err := e.Info()
			if err != nil || fi.Size() > MaxFileSize {
				continue
			}
			hits := grepFile(full, base, needle, maxSnippet, maxResults-len(results))
			results = append(results, hits...)
			if len(results) >= maxResults {
				return false
			}
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	if len(results) > maxResults {
		results = results[:maxResults]
	}
	return results, nil
}

// grepFile scans one file line-by-line for needle (already lowercased),
// returning up to budget matches. A null byte on the first read aborts the
// file (binary).
func grepFile(path, base, needle string, maxSnippet, budget int) []ContentMatch {
	if budget <= 0 {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	rel := mustRel(base, path)
	var out []ContentMatch
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), MaxFileSize+1)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		raw := scanner.Bytes()
		if lineNo == 1 && bytes.Contains(raw, []byte{0}) {
			return nil // binary
		}
		line := decodeReplace(raw)
		if strings.Contains(strings.ToLower(line), needle) {
			out = append(out, ContentMatch{
				Path:    rel,
				Line:    lineNo,
				Snippet: truncRunes(strings.TrimRight(line, "\r\n"), maxSnippet),
			})
			if len(out) >= budget {
				break
			}
		}
	}
	return out
}

func truncRunes(s string, max int) string {
	if max <= 0 || utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max])
}

// walkDirs walks base depth-first, pruning directories whose name is in
// skipDirs OR in the marked SKIP_DIRS set, and (unless includeHidden) hidden
// directories. For each visited directory it calls fn(dir, entries); fn returns
// false to stop the walk early (used to honor result caps). Order is dirs
// before recursion, matching os.walk top-down semantics.
func walkDirs(base string, skipDirs []string, includeHidden bool, fn func(dir string, entries []os.DirEntry) bool) error {
	stack := []string{base}
	for len(stack) > 0 {
		dir := stack[len(stack)-1]
		stack = stack[:len(stack)-1]

		entries, err := os.ReadDir(dir)
		if err != nil {
			slog.Debug("fsutil: walk read dir failed", "path", dir, "err", err)
			continue
		}
		if !fn(dir, entries) {
			return nil
		}
		// Push subdirs (reverse order so iteration stays roughly lexical).
		for i := len(entries) - 1; i >= 0; i-- {
			e := entries[i]
			if !e.IsDir() {
				continue
			}
			name := e.Name()
			if !includeHidden && strings.HasPrefix(name, ".") {
				continue
			}
			if inSet(skipDirs, name) {
				continue
			}
			if _, marked := skipDirsMarked[name]; marked {
				continue
			}
			stack = append(stack, filepath.Join(dir, name))
		}
	}
	return nil
}

// ── Flat directory listing (bonus, mirrors files.py list_files) ─────────────

// ListDir returns the immediate entries of the directory at rel under root,
// mirroring files.py list_files: directories whose name is in skipDirs are
// bypassed entirely (not returned); marked SKIP_DIRS directories are returned
// with IsSkipped=true; entries are dirs-first then alphabetical; hidden entries
// are excluded unless includeHidden; the listing is capped at MaxDirEntries.
func ListDir(root, rel string, skipDirs []string, includeHidden bool) ([]FileEntry, error) {
	base := filepath.Clean(root)
	target, err := SafePath(base, rel)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return nil, ErrNotFound
	}
	if !info.IsDir() {
		return nil, ErrNotDir
	}

	raw, err := os.ReadDir(target)
	if err != nil {
		return []FileEntry{}, nil
	}
	if !includeHidden {
		filtered := raw[:0:0]
		for _, e := range raw {
			if !strings.HasPrefix(e.Name(), ".") {
				filtered = append(filtered, e)
			}
		}
		raw = filtered
	}
	sort.SliceStable(raw, func(i, j int) bool {
		fi, fj := !raw[i].IsDir(), !raw[j].IsDir()
		if fi != fj {
			return !fi
		}
		return strings.ToLower(raw[i].Name()) < strings.ToLower(raw[j].Name())
	})

	out := make([]FileEntry, 0, len(raw))
	for _, e := range raw {
		if len(out) >= MaxDirEntries {
			break
		}
		name := e.Name()
		isDir := e.IsDir()
		if isDir && inSet(skipDirs, name) {
			continue // bypassed entirely
		}
		full := filepath.Join(target, name)
		if isDir {
			_, marked := skipDirsMarked[name]
			out = append(out, FileEntry{
				Name:      name,
				Path:      mustRel(base, full),
				Type:      "dir",
				IsSkipped: marked,
			})
			continue
		}
		out = append(out, makeFileEntry(base, full, e))
	}
	return out, nil
}
