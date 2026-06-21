package git

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// swrite writes a file, creating parent dirs (unlike the package-level writeFile
// in git_test.go which takes dir+name and does not mkdir).
func swrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func sread(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// shadowFixture sets up a work-tree with a .gitignore and a separate shadow
// git-dir, and returns (service, gitDir, workdir).
func shadowFixture(t *testing.T) (*Service, string, string) {
	t.Helper()
	root := t.TempDir()
	workdir := filepath.Join(root, "project")
	gitDir := ShadowGitDir(filepath.Join(root, "shadow"), workdir)
	swrite(t, filepath.Join(workdir, ".gitignore"), "node_modules/\n")
	swrite(t, filepath.Join(workdir, "a.txt"), "one")
	return New(nil, nil), gitDir, workdir
}

func TestShadowSnapshotAndLog(t *testing.T) {
	s, gitDir, workdir := shadowFixture(t)
	ctx := context.Background()

	hash, committed, err := s.ShadowSnapshot(ctx, gitDir, workdir, "main", "first turn\n\nPrompt:\nhello\n\nTurn-Ts: 1\nSession: sess-1", "tester")
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if !committed || hash == "" {
		t.Fatalf("expected a commit, got committed=%v hash=%q", committed, hash)
	}

	pts, err := s.ShadowLog(ctx, gitDir, workdir, "main", 0)
	if err != nil {
		t.Fatalf("log: %v", err)
	}
	if len(pts) != 1 {
		t.Fatalf("want 1 rewind point, got %d", len(pts))
	}
	if pts[0].Subject != "first turn" {
		t.Errorf("subject = %q", pts[0].Subject)
	}
	if pts[0].Prompt != "hello" {
		t.Errorf("prompt = %q, want hello", pts[0].Prompt)
	}
	if pts[0].Session != "sess-1" {
		t.Errorf("session = %q, want sess-1", pts[0].Session)
	}

	// No new changes → no new commit.
	_, committed2, err := s.ShadowSnapshot(ctx, gitDir, workdir, "main", "noop", "tester")
	if err != nil {
		t.Fatalf("snapshot2: %v", err)
	}
	if committed2 {
		t.Error("expected no commit when nothing changed")
	}
}

// Switching the shadow branch must NOT modify the real working tree.
func TestShadowBranchSwitchLeavesWorktree(t *testing.T) {
	s, gitDir, workdir := shadowFixture(t)
	ctx := context.Background()

	if _, _, err := s.ShadowSnapshot(ctx, gitDir, workdir, "main", "on main", "tester"); err != nil {
		t.Fatalf("snapshot main: %v", err)
	}
	// Change the file on disk, then snapshot onto a DIFFERENT branch.
	swrite(t, filepath.Join(workdir, "a.txt"), "two")
	before := sread(t, filepath.Join(workdir, "a.txt"))
	if _, _, err := s.ShadowSnapshot(ctx, gitDir, workdir, "feature/x", "on feature", "tester"); err != nil {
		t.Fatalf("snapshot feature: %v", err)
	}
	if after := sread(t, filepath.Join(workdir, "a.txt")); after != before {
		t.Errorf("branch switch changed worktree: before=%q after=%q", before, after)
	}
	// Each branch has its own timeline.
	if pts, _ := s.ShadowLog(ctx, gitDir, workdir, "main", 0); len(pts) != 1 {
		t.Errorf("main timeline = %d points, want 1", len(pts))
	}
	if pts, _ := s.ShadowLog(ctx, gitDir, workdir, "feature/x", 0); len(pts) != 1 {
		t.Errorf("feature timeline = %d points, want 1", len(pts))
	}
}

func TestShadowRestore(t *testing.T) {
	s, gitDir, workdir := shadowFixture(t)
	ctx := context.Background()

	// v1: a.txt="one"
	if _, _, err := s.ShadowSnapshot(ctx, gitDir, workdir, "main", "v1", "tester"); err != nil {
		t.Fatalf("v1: %v", err)
	}
	pts, _ := s.ShadowLog(ctx, gitDir, workdir, "main", 0)
	v1 := pts[0].Hash

	// v2: change a.txt, add new tracked file, add an ignored file.
	swrite(t, filepath.Join(workdir, "a.txt"), "two")
	swrite(t, filepath.Join(workdir, "b.txt"), "new file")
	swrite(t, filepath.Join(workdir, "node_modules", "junk.txt"), "ignored")
	if _, committed, err := s.ShadowSnapshot(ctx, gitDir, workdir, "main", "v2", "tester"); err != nil || !committed {
		t.Fatalf("v2: committed=%v err=%v", committed, err)
	}

	// Preview the restore before doing it: should list a.txt + b.txt as changing.
	pv, err := s.ShadowRestorePreview(ctx, gitDir, workdir, "main", v1)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if len(pv.Files) < 2 || pv.Diff == "" {
		t.Errorf("preview = %+v (want ≥2 files + a diff)", pv)
	}

	res, err := s.ShadowRestore(ctx, gitDir, workdir, "main", v1)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if !res.OK || res.NewHash == "" || res.BeforeHash == "" {
		t.Fatalf("restore result = %+v", res)
	}
	if got := sread(t, filepath.Join(workdir, "a.txt")); got != "one" {
		t.Errorf("a.txt = %q, want one (reverted)", got)
	}
	if _, err := os.Stat(filepath.Join(workdir, "b.txt")); !os.IsNotExist(err) {
		t.Errorf("b.txt should have been removed (added after v1)")
	}
	if got := sread(t, filepath.Join(workdir, "node_modules", "junk.txt")); got != "ignored" {
		t.Errorf("ignored file should be untouched, got %q", got)
	}
	// Forward, linear timeline: restore added points (before + rewind) on top of
	// v1/v2 — both pre-restore and restored states stay visible/restorable.
	after, _ := s.ShadowLog(ctx, gitDir, workdir, "main", 0)
	if len(after) < 3 {
		t.Errorf("want ≥3 points after restore (v1,v2,before,rewind), got %d", len(after))
	}
	// "Go back": the pre-restore state (b.txt present, a.txt="two") is restorable.
	if _, err := s.ShadowRestore(ctx, gitDir, workdir, "main", res.BeforeHash); err != nil {
		t.Fatalf("go-back restore: %v", err)
	}
	if got := sread(t, filepath.Join(workdir, "a.txt")); got != "two" {
		t.Errorf("after go-back a.txt = %q, want two", got)
	}
	if got := sread(t, filepath.Join(workdir, "b.txt")); got != "new file" {
		t.Errorf("after go-back b.txt should be restored, got %q", got)
	}
}

// TestShadowCommitDetail exercises the single-pass cat-file batch reader across
// the three blob cases: modified (both old+new present), added (old missing),
// and deleted (new missing).
func TestShadowCommitDetail(t *testing.T) {
	s, gitDir, workdir := shadowFixture(t)
	ctx := context.Background()

	// Point 1: a.txt="one" (from fixture) + del.txt to be removed later.
	swrite(t, filepath.Join(workdir, "del.txt"), "to be deleted")
	if _, _, err := s.ShadowSnapshot(ctx, gitDir, workdir, "main", "v1", "tester"); err != nil {
		t.Fatalf("snapshot v1: %v", err)
	}

	// Point 2: modify a.txt, add add.txt, delete del.txt.
	swrite(t, filepath.Join(workdir, "a.txt"), "one\ntwo\n")
	swrite(t, filepath.Join(workdir, "add.txt"), "brand new")
	if err := os.Remove(filepath.Join(workdir, "del.txt")); err != nil {
		t.Fatal(err)
	}
	hash, _, err := s.ShadowSnapshot(ctx, gitDir, workdir, "main", "v2", "tester")
	if err != nil {
		t.Fatalf("snapshot v2: %v", err)
	}

	det, err := s.ShadowCommitDetail(ctx, gitDir, workdir, hash)
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	byPath := map[string]FileVersion{}
	for _, f := range det.Files {
		byPath[f.Path] = f
	}
	if f := byPath["a.txt"]; f.OldContent != "one" || f.NewContent != "one\ntwo\n" {
		t.Errorf("a.txt old=%q new=%q", f.OldContent, f.NewContent)
	}
	if f := byPath["add.txt"]; f.OldContent != "" || f.NewContent != "brand new" {
		t.Errorf("add.txt old=%q new=%q (want old empty)", f.OldContent, f.NewContent)
	}
	if f := byPath["del.txt"]; f.OldContent != "to be deleted" || f.NewContent != "" {
		t.Errorf("del.txt old=%q new=%q (want new empty)", f.OldContent, f.NewContent)
	}
}
