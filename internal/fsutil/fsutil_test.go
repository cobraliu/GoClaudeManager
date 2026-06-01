package fsutil

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// buildTestTree creates a temp dir tree:
//
//	root/
//	  README.md            "hello world\nfind-me here\n"
//	  main.go              "package main\n...\nNEEDLE inside\n"
//	  big.txt              (> MaxFileSize)
//	  bin.dat              (binary, null byte)
//	  sub/
//	    util.go            "package sub\nfind-me also\n"
//	  node_modules/        (skip dir)
//	    junk.js            "NEEDLE should be skipped\n"
//	    findme_pkg/        (dir name should be skipped from name search)
func buildTestTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()

	write := func(rel, content string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("README.md", "hello world\nfind-me here\n")
	write("main.go", "package main\nfunc main() {}\nNEEDLE inside\n")
	write("sub/util.go", "package sub\nfind-me also\n")
	write("node_modules/junk.js", "NEEDLE should be skipped\nfind-me too\n")
	if err := os.MkdirAll(filepath.Join(root, "node_modules", "findme_pkg"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Binary file (null byte in first 8 KiB).
	write("bin.dat", "abc\x00def")

	// Oversized file (> MaxFileSize).
	big := strings.Repeat("a", MaxFileSize+10)
	write("big.txt", big)

	return root
}

func defaultSkip() []string { return []string{"node_modules", "venv", ".venv"} }

// ── 1. Tree listing skips node_modules ─────────────────────────────────────

func TestBuildTreeSkipsNodeModules(t *testing.T) {
	root := buildTestTree(t)
	tree, err := BuildTree(root, defaultSkip())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}
	if tree.Type != "dir" || tree.Path != "." {
		t.Fatalf("root node wrong: %+v", tree)
	}

	var names []string
	var findFile bool
	for _, c := range tree.Children {
		names = append(names, c.Name)
		if c.Name == "node_modules" {
			t.Fatalf("node_modules should have been pruned from tree")
		}
		if c.Name == "main.go" {
			findFile = true
			if c.Type != "file" || c.Size == nil {
				t.Fatalf("main.go node wrong: %+v", c)
			}
		}
	}
	if !findFile {
		t.Fatalf("main.go missing from tree; got %v", names)
	}

	// Ordering: dirs first. "sub" must come before files.
	if len(tree.Children) < 2 {
		t.Fatalf("expected multiple children, got %v", names)
	}
	if tree.Children[0].Type != "dir" {
		t.Fatalf("expected dirs first, got %v", names)
	}

	// sub/ should contain util.go.
	var sub *TreeNode
	for _, c := range tree.Children {
		if c.Name == "sub" {
			sub = c
		}
	}
	if sub == nil || len(sub.Children) != 1 || sub.Children[0].Name != "util.go" {
		t.Fatalf("sub subtree wrong: %+v", sub)
	}
}

// ── 2. File read truncation (lines + bytes) + guards ───────────────────────

func TestReadFileLinesTruncation(t *testing.T) {
	root := buildTestTree(t)
	// main.go has 3 lines; cap at 2.
	fc, err := ReadFile(root, "main.go", ViewerSettings{Mode: FileViewerModeLines, MaxLines: 2})
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !fc.Truncated || fc.TruncatedBy != "lines" {
		t.Fatalf("expected lines truncation, got %+v", fc)
	}
	if fc.TotalLines != 3 || fc.DisplayedLines != 2 {
		t.Fatalf("line counts wrong: total=%d displayed=%d", fc.TotalLines, fc.DisplayedLines)
	}
	if strings.Contains(fc.Content, "NEEDLE") {
		t.Fatalf("truncated content should not include line 3: %q", fc.Content)
	}
	if fc.Content != "package main\nfunc main() {}" {
		t.Fatalf("unexpected content: %q", fc.Content)
	}
}

func TestReadFileBytesTruncation(t *testing.T) {
	root := buildTestTree(t)
	fc, err := ReadFile(root, "README.md", ViewerSettings{Mode: FileViewerModeBytes, MaxBytes: 5})
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !fc.Truncated || fc.TruncatedBy != "bytes" {
		t.Fatalf("expected bytes truncation, got %+v", fc)
	}
	if fc.Content != "hello" {
		t.Fatalf("expected first 5 bytes 'hello', got %q", fc.Content)
	}
}

func TestReadFileUnlimited(t *testing.T) {
	root := buildTestTree(t)
	fc, err := ReadFile(root, "main.go", ViewerSettings{Mode: FileViewerModeUnlimited})
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if fc.Truncated || fc.TotalLines != 3 || fc.DisplayedLines != 3 {
		t.Fatalf("unlimited read wrong: %+v", fc)
	}
}

func TestReadFileGuards(t *testing.T) {
	root := buildTestTree(t)

	if _, err := ReadFile(root, "big.txt", ViewerSettings{Mode: FileViewerModeUnlimited}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge for big.txt, got %v", err)
	}
	if _, err := ReadFile(root, "bin.dat", ViewerSettings{Mode: FileViewerModeUnlimited}); !errors.Is(err, ErrBinary) {
		t.Fatalf("expected ErrBinary for bin.dat, got %v", err)
	}
	if _, err := ReadFile(root, "nope.txt", ViewerSettings{Mode: FileViewerModeUnlimited}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// ── 3. Name search ─────────────────────────────────────────────────────────

func TestSearchNames(t *testing.T) {
	root := buildTestTree(t)
	res, err := SearchNames(root, "find-me", defaultSkip(), false)
	if err != nil {
		t.Fatalf("SearchNames: %v", err)
	}
	// No file literally named "find-me*" exists; ensure node_modules/findme_pkg
	// is excluded when searching for "findme".
	_ = res

	res, err = SearchNames(root, "util", defaultSkip(), false)
	if err != nil {
		t.Fatalf("SearchNames util: %v", err)
	}
	if len(res) != 1 || res[0].Name != "util.go" {
		t.Fatalf("expected util.go, got %+v", res)
	}

	// "findme" matches a dir inside node_modules — must be pruned.
	res, err = SearchNames(root, "findme", defaultSkip(), false)
	if err != nil {
		t.Fatalf("SearchNames findme: %v", err)
	}
	for _, e := range res {
		if strings.Contains(e.Path, "node_modules") {
			t.Fatalf("node_modules result should be pruned: %+v", e)
		}
	}

	// ".go" matches main.go and sub/util.go.
	res, err = SearchNames(root, ".go", defaultSkip(), false)
	if err != nil {
		t.Fatalf("SearchNames .go: %v", err)
	}
	if len(res) != 2 {
		t.Fatalf("expected 2 .go hits, got %d: %+v", len(res), res)
	}
}

// ── 4. Content search ──────────────────────────────────────────────────────

func TestSearchContent(t *testing.T) {
	root := buildTestTree(t)
	res, err := SearchContent(root, "NEEDLE", defaultSkip(), false, 0, 0)
	if err != nil {
		t.Fatalf("SearchContent: %v", err)
	}
	// node_modules/junk.js also contains NEEDLE but must be skipped.
	if len(res) != 1 {
		t.Fatalf("expected 1 NEEDLE hit (main.go only), got %d: %+v", len(res), res)
	}
	m := res[0]
	if m.Path != "main.go" || m.Line != 3 || !strings.Contains(m.Snippet, "NEEDLE inside") {
		t.Fatalf("unexpected match: %+v", m)
	}

	// "find-me" appears in README.md and sub/util.go (case-insensitive).
	res, err = SearchContent(root, "FIND-ME", defaultSkip(), false, 0, 0)
	if err != nil {
		t.Fatalf("SearchContent find-me: %v", err)
	}
	if len(res) != 2 {
		t.Fatalf("expected 2 find-me hits, got %d: %+v", len(res), res)
	}
}

// ── 5. Path safety ─────────────────────────────────────────────────────────

func TestSafePath(t *testing.T) {
	root := buildTestTree(t)

	// Empty / "." / "/" map to root.
	for _, rel := range []string{"", ".", "/"} {
		p, err := SafePath(root, rel)
		if err != nil || p != filepath.Clean(root) {
			t.Fatalf("SafePath(%q) = %q, %v; want root", rel, p, err)
		}
	}

	// Valid nested path.
	p, err := SafePath(root, "sub/util.go")
	if err != nil || p != filepath.Join(root, "sub", "util.go") {
		t.Fatalf("SafePath(sub/util.go) = %q, %v", p, err)
	}

	// Traversal escapes must be rejected.
	for _, bad := range []string{"../etc/passwd", "../../foo", "sub/../../escape", "/../../etc"} {
		if _, err := SafePath(root, bad); !errors.Is(err, ErrTraversal) {
			t.Fatalf("SafePath(%q) expected ErrTraversal, got %v", bad, err)
		}
	}

	// ReadFile must also reject traversal.
	if _, err := ReadFile(root, "../../etc/passwd", ViewerSettings{Mode: FileViewerModeUnlimited}); !errors.Is(err, ErrTraversal) {
		t.Fatalf("ReadFile traversal expected ErrTraversal, got %v", err)
	}
}

// ── Flat listing ───────────────────────────────────────────────────────────

func TestListDir(t *testing.T) {
	root := buildTestTree(t)
	entries, err := ListDir(root, "", defaultSkip(), false)
	if err != nil {
		t.Fatalf("ListDir: %v", err)
	}
	for _, e := range entries {
		if e.Name == "node_modules" {
			t.Fatalf("node_modules should be bypassed entirely in ListDir")
		}
	}
	// Dirs first: first entry should be "sub".
	if len(entries) == 0 || entries[0].Name != "sub" || entries[0].Type != "dir" {
		t.Fatalf("expected 'sub' dir first, got %+v", entries)
	}
}
