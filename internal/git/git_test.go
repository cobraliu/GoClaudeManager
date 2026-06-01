package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// gitEnv returns a deterministic environment for the test's git subprocesses so
// commits don't depend on the developer's global config.
func newTestService() *Service {
	return New(nil, nil)
}

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func TestEndToEnd(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := newTestService()

	// Not a repo yet.
	if s.IsRepo(dir) {
		t.Fatal("expected fresh temp dir to not be a repo")
	}

	// Init.
	if res := s.Init(ctx, dir); !res.OK {
		t.Fatalf("init failed: %s", res.Output)
	}
	if !s.IsRepo(dir) {
		t.Fatal("expected repo after init")
	}
	// .gitignore should have been written.
	if _, err := os.Stat(filepath.Join(dir, ".gitignore")); err != nil {
		t.Fatalf("expected .gitignore: %v", err)
	}

	// Write and commit a file.
	writeFile(t, dir, "hello.txt", "line one\nline two\n")
	if !s.IsDirty(ctx, dir) {
		t.Fatal("expected dirty tree after writing file")
	}
	res := s.AddCommit(ctx, dir, "initial commit", "tester")
	if !res.OK || !res.Committed {
		t.Fatalf("first commit failed: ok=%v committed=%v out=%s", res.OK, res.Committed, res.Output)
	}
	if s.IsDirty(ctx, dir) {
		t.Fatal("expected clean tree after commit")
	}

	// Branch name should be non-empty (master or main).
	branch := s.CurrentBranch(dir)
	if branch == "" {
		t.Fatal("expected a current branch after first commit")
	}

	// Log should have exactly one commit with our subject.
	logs := s.Log(dir, 10)
	if len(logs) != 1 {
		t.Fatalf("expected 1 commit, got %d", len(logs))
	}
	if logs[0].Subject != "initial commit" {
		t.Fatalf("unexpected subject: %q", logs[0].Subject)
	}
	if logs[0].Author != "tester" {
		t.Fatalf("unexpected author: %q", logs[0].Author)
	}
	if len(logs[0].Hash) != 40 || len(logs[0].ShortHash) != 7 {
		t.Fatalf("unexpected hash shapes: %q / %q", logs[0].Hash, logs[0].ShortHash)
	}

	// Modify the file and check the working-tree diff.
	writeFile(t, dir, "hello.txt", "line one\nline two changed\nline three\n")
	diff := s.WorkingFileDiff(ctx, dir, "hello.txt", nil)
	if !strings.Contains(diff, "+line two changed") || !strings.Contains(diff, "-line two") {
		t.Fatalf("working diff missing expected changes:\n%s", diff)
	}

	// Commit the change with a second author.
	res2 := s.AddCommit(ctx, dir, "second commit", "tester")
	if !res2.OK || !res2.Committed {
		t.Fatalf("second commit failed: %s", res2.Output)
	}

	logs = s.Log(dir, 10)
	if len(logs) != 2 {
		t.Fatalf("expected 2 commits, got %d", len(logs))
	}

	// Diff between the two commits should list hello.txt.
	old := logs[1].Hash
	newer := logs[0].Hash
	changed := s.DiffFiles(ctx, dir, old, newer)
	found := false
	for _, f := range changed {
		if f == "hello.txt" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected hello.txt in diff files, got %v", changed)
	}

	// FileAtCommit should return old and new content.
	oldContent := s.FileAtCommit(dir, old, "hello.txt")
	if !strings.Contains(oldContent, "line two\n") || strings.Contains(oldContent, "line three") {
		t.Fatalf("unexpected old content: %q", oldContent)
	}
	newContent := s.FileAtCommit(dir, newer, "hello.txt")
	if !strings.Contains(newContent, "line three") {
		t.Fatalf("unexpected new content: %q", newContent)
	}

	// ShowCommit on the latest commit returns a message and file diff.
	show := s.ShowCommit(ctx, dir, newer)
	if show.Message == "" {
		t.Fatal("expected non-empty commit message in ShowCommit")
	}
	if len(show.Files) == 0 {
		t.Fatal("expected at least one file in ShowCommit")
	}

	// SearchCommits should find the second commit by its subject word.
	results := s.SearchCommits(ctx, dir, "second", 100)
	if len(results) != 1 || results[0].Subject != "second commit" {
		t.Fatalf("search returned %v", results)
	}

	// GraphLog should return both commits with parent linkage.
	graph := s.GraphLog(ctx, dir, "current", 100)
	if len(graph) != 2 {
		t.Fatalf("expected 2 graph commits, got %d", len(graph))
	}
	if len(graph[0].Parents) != 1 {
		t.Fatalf("expected newest commit to have 1 parent, got %v", graph[0].Parents)
	}

	// FileLog for hello.txt should report both commits.
	flog := s.FileLog(dir, "hello.txt", 50)
	if len(flog) != 2 {
		t.Fatalf("expected 2 file-log entries, got %d", len(flog))
	}

	// ListBranches.
	info := s.ListBranches(ctx, dir)
	if info.Current != branch {
		t.Fatalf("ListBranches current = %q, want %q", info.Current, branch)
	}
	if len(info.Local) != 1 {
		t.Fatalf("expected 1 local branch, got %v", info.Local)
	}

	// Remote read/write round-trip.
	if got := s.GetRemote(dir); got != "" {
		t.Fatalf("expected no remote, got %q", got)
	}
	if r := s.SetRemote(dir, "https://example.com/repo.git"); !r.OK {
		t.Fatalf("set remote failed: %s", r.Output)
	}
	if got := s.GetRemote(dir); got != "https://example.com/repo.git" {
		t.Fatalf("remote = %q", got)
	}

	// MergeStatus on a clean repo: no merge in progress.
	if ms := s.MergeStatus(ctx, dir); ms.InProgress {
		t.Fatal("expected no merge in progress")
	}
}

func TestUntrackedFileDiff(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := newTestService()
	s.Init(ctx, dir)
	// Commit something so HEAD exists.
	writeFile(t, dir, "base.txt", "x\n")
	s.AddCommit(ctx, dir, "base", "tester")

	// New untracked file: WorkingFileDiff should synthesise an all-added diff.
	writeFile(t, dir, "new.txt", "a\nb\n")
	diff := s.WorkingFileDiff(ctx, dir, "new.txt", []string{"a", "b"})
	if !strings.Contains(diff, "/dev/null") || !strings.Contains(diff, "+a") || !strings.Contains(diff, "+b") {
		t.Fatalf("unexpected untracked diff:\n%s", diff)
	}
}

func TestMakeCommitMessage(t *testing.T) {
	assistant := "## Heading\n\nThis is a meaningful summary line.\n\n```go\ncode here\n```\n\nMore body text."
	subject := MakeCommitSummary(assistant, 0)
	if subject != "This is a meaningful summary line." {
		t.Fatalf("subject = %q", subject)
	}

	prompts := []PromptEntry{{Text: "do the thing", TimeStr: "12:00"}}
	msg := MakeCommitMessage(prompts, assistant)
	if !strings.HasPrefix(msg, subject) {
		t.Fatalf("message should start with subject:\n%s", msg)
	}
	if !strings.Contains(msg, "Prompt:\n[12:00] do the thing") {
		t.Fatalf("message missing prompt section:\n%s", msg)
	}
	if !strings.Contains(msg, "Response:\n") {
		t.Fatalf("message missing response section:\n%s", msg)
	}
	if strings.Contains(msg, "code here") {
		t.Fatalf("code block should be stripped:\n%s", msg)
	}

	// Multiple prompts -> "Prompts" label.
	multi := MakeCommitMessage([]PromptEntry{{Text: "one"}, {Text: "two"}}, assistant)
	if !strings.Contains(multi, "Prompts:\n") {
		t.Fatalf("expected plural label:\n%s", multi)
	}

	// Empty assistant text -> fallback subject.
	if got := MakeCommitSummary("", 0); got != "Claude auto-commit" {
		t.Fatalf("fallback subject = %q", got)
	}
}
