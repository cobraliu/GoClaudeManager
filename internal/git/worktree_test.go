package git

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func gitT(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func writeT(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestWorktreeLifecycle(t *testing.T) {
	t.Setenv("GIT_AUTHOR_NAME", "t")
	t.Setenv("GIT_AUTHOR_EMAIL", "t@t")
	t.Setenv("GIT_COMMITTER_NAME", "t")
	t.Setenv("GIT_COMMITTER_EMAIL", "t@t")
	ctx := context.Background()
	s := newTestService()
	root := t.TempDir()
	main := filepath.Join(root, "repo")
	os.MkdirAll(main, 0o755)
	gitT(t, main, "init", "-q", "-b", "main")
	writeT(t, filepath.Join(main, "a.txt"), "one\n")
	writeT(t, filepath.Join(main, ".env"), "SECRET=1\n")
	writeT(t, filepath.Join(main, ".gitignore"), ".env\n")
	gitT(t, main, "add", "a.txt", ".gitignore")
	gitT(t, main, "commit", "-q", "-m", "init")

	dir, err := s.AddWorktree(ctx, main, AddWorktreeOpts{Branch: "feat/x", CopyEnv: true})
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "repo.worktrees", "feat-x"); dir != want {
		t.Fatalf("dir = %s, want %s", dir, want)
	}
	if _, err := os.Stat(filepath.Join(dir, ".env")); err != nil {
		t.Fatal(".env not copied")
	}
	if _, err := s.AddWorktree(ctx, main, AddWorktreeOpts{Branch: "feat/x"}); err == nil {
		t.Fatal("duplicate branch accepted")
	}
	// go-git must see the linked worktree's branch.
	if b := s.CurrentBranch(dir); b != "feat/x" {
		t.Fatalf("CurrentBranch in worktree = %q", b)
	}

	writeT(t, filepath.Join(dir, "b.txt"), "new\n")
	gitT(t, dir, "add", "b.txt")
	gitT(t, dir, "commit", "-q", "-m", "add b")
	list, err := s.ListWorktrees(ctx, dir, true)
	if err != nil {
		t.Fatal(err)
	}
	w := list.FindWorktree(dir)
	if list.Base != "main" || w == nil || w.Ahead != 1 || w.Behind != 0 || w.Dirty != 0 {
		t.Fatalf("status: base=%s wt=%+v", list.Base, w)
	}
	if c := list.Containing(filepath.Join(dir, "sub")); c == nil || c.Path != w.Path {
		t.Fatal("Containing failed")
	}
	if p := s.MergeHeadPath(ctx, dir); filepath.Base(filepath.Dir(p)) != "feat-x" {
		t.Fatalf("MergeHeadPath = %s", p)
	}

	if res := s.MergeWorktreeIntoBase(ctx, dir, dir); !res.OK {
		t.Fatalf("merge back: %+v", res)
	}
	if _, err := os.Stat(filepath.Join(main, "b.txt")); err != nil {
		t.Fatal("b.txt not merged into main")
	}

	// Conflict: both sides edit a.txt → aborted, NeedsSync, main untouched.
	writeT(t, filepath.Join(dir, "a.txt"), "wt\n")
	gitT(t, dir, "commit", "-q", "-am", "wt edit")
	writeT(t, filepath.Join(main, "a.txt"), "main\n")
	gitT(t, main, "commit", "-q", "-am", "main edit")
	res := s.MergeWorktreeIntoBase(ctx, main, dir)
	if res.OK || !res.NeedsSync {
		t.Fatalf("expected needs_sync, got %+v", res)
	}
	if s.IsDirty(ctx, main) {
		t.Fatal("main left dirty after aborted merge-back")
	}

	if err := s.RemoveWorktree(ctx, main, main, false, false); err == nil {
		t.Fatal("removed main worktree")
	}
	if err := s.RemoveWorktree(ctx, main, dir, true, true); err != nil {
		t.Fatal(err)
	}
	list, _ = s.ListWorktrees(ctx, main, false)
	if len(list.Worktrees) != 1 {
		t.Fatalf("worktrees after remove: %+v", list.Worktrees)
	}
}

// A workspace dir that is itself a git repo: its plain subfolders are not
// repository roots, and FindRepos scans subdirectories (2 levels, never the
// parent) for real repositories; a repository root also scans 1 level.
func TestFindReposNested(t *testing.T) {
	ctx := context.Background()
	s := newTestService()
	ws := t.TempDir()
	gitT(t, ws, "init", "-q", "-b", "main")
	plain := filepath.Join(ws, "plain")
	for _, d := range []string{
		filepath.Join(plain, "r1"),                 // level 1 repo
		filepath.Join(plain, "group", "r2"),        // level 2 repo
		filepath.Join(plain, "a", "b", "r3"),       // level 3: too deep
		filepath.Join(plain, "r1", "nested"),       // inside a repo: not descended
		filepath.Join(plain, "node_modules", "r4"), // skipped
		filepath.Join(plain, ".hidden", "r5"),      // skipped
	} {
		os.MkdirAll(d, 0o755)
		gitT(t, d, "init", "-q", "-b", "main")
	}
	os.MkdirAll(filepath.Join(plain, "empty", "dir"), 0o755)

	if sub := s.SubdirOf(ctx, plain); sub != "plain" {
		t.Fatalf("SubdirOf = %q", sub)
	}
	got := s.FindRepos(ctx, plain)
	want := []string{filepath.Join(plain, "group", "r2"), filepath.Join(plain, "r1")}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("FindRepos = %v, want %v", got, want)
	}
	// A repository root: itself plus nested repos one level down.
	r1 := filepath.Join(plain, "r1")
	os.MkdirAll(filepath.Join(r1, "x", "deeper"), 0o755)
	gitT(t, filepath.Join(r1, "x", "deeper"), "init", "-q", "-b", "main")
	if got := s.FindRepos(ctx, r1); len(got) != 2 || got[0] != r1 || got[1] != filepath.Join(r1, "nested") {
		t.Fatalf("FindRepos(root) = %v", got)
	}
}
