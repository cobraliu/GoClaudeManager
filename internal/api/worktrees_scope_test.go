package api

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/loki/goclaudemanager/internal/git"
	"github.com/loki/goclaudemanager/internal/model"
)

func TestScopedGitRoot(t *testing.T) {
	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	initRepo := func(dir string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
			t.Fatal(err)
		}
		run(dir, "init", "-q")
		os.WriteFile(filepath.Join(dir, "sub", "a.txt"), []byte("a\n"), 0o644)
		run(dir, "add", ".")
		run(dir, "commit", "-qm", "init")
	}

	base := git.RealPath(t.TempDir())
	ws := filepath.Join(base, "ws")     // session cwd: a plain workspace dir
	sub := filepath.Join(ws, "proj")    // a repository inside it
	outside := filepath.Join(base, "x") // a repository outside the workspace
	initRepo(sub)
	initRepo(outside)
	wt := filepath.Join(base, "proj.worktrees", "feat")
	run(sub, "worktree", "add", "-q", "-b", "feat", wt)
	wtOut := filepath.Join(base, "x.worktrees", "feat")
	run(outside, "worktree", "add", "-q", "-b", "feat", wtOut)

	s := &model.Session{Cwd: ws}
	ctx := context.Background()
	cases := []struct {
		dir  string
		want string
	}{
		{sub, sub},                       // repo inside cwd
		{filepath.Join(sub, "sub"), sub}, // its subdirectory resolves to the root
		{wt, wt},                         // linked worktree outside cwd of an in-scope repo
		{filepath.Join(wt, "sub"), wt},
		{outside, ""}, // repo outside cwd
		{wtOut, ""},   // worktree of an out-of-scope repo
		{ws, ""},      // not a repo
		{"proj", ""},  // relative
	}
	for _, c := range cases {
		got, ok := scopedGitRoot(ctx, s, c.dir)
		if (c.want != "") != ok || got != c.want {
			t.Errorf("scopedGitRoot(%s) = %q, %v; want %q", c.dir, got, ok, c.want)
		}
	}
	// A session whose cwd is a subdirectory of a repo never reaches the parent repo.
	if _, ok := scopedGitRoot(ctx, &model.Session{Cwd: filepath.Join(sub, "sub")}, sub); ok {
		t.Error("parent repository of cwd must be out of scope")
	}
}
