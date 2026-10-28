package git

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Worktree support: parallel agents each get their own linked worktree (own
// branch + directory) of the same repository, so their edits never collide.
//
// Layout: linked worktrees live next to the main checkout, in
// <parent>/<repo>.worktrees/<branch-slug>. Keeping them outside the main tree
// means no .gitignore entry is needed and the main tree's file watcher, search
// and zip download never see them.

// Worktree is one entry of `git worktree list` plus its live status.
type Worktree struct {
	Path     string `json:"path"`
	Branch   string `json:"branch"` // "" when detached
	Head     string `json:"head"`   // short sha
	IsMain   bool   `json:"is_main"`
	Detached bool   `json:"detached"`
	Locked   bool   `json:"locked"`
	Prunable bool   `json:"prunable"` // directory is gone

	// Status (relative to the main worktree's branch = base).
	Dirty      int    `json:"dirty"`  // changed/untracked paths
	Ahead      int    `json:"ahead"`  // commits on this branch not in base
	Behind     int    `json:"behind"` // commits in base not on this branch
	LastCommit string `json:"last_commit"`
	LastTime   int64  `json:"last_time"` // unix seconds
}

// WorktreeList is the repository's worktrees plus the base branch.
type WorktreeList struct {
	MainPath  string     `json:"main_path"`
	Base      string     `json:"base"` // branch checked out in the main worktree
	Worktrees []Worktree `json:"worktrees"`
}

// ListWorktrees lists every worktree of the repository containing cwd.
// withStatus additionally computes dirty / ahead / behind / last commit.
func (s *Service) ListWorktrees(ctx context.Context, cwd string, withStatus bool) (WorktreeList, error) {
	out, errOut, err := s.run(ctx, cwd, "worktree", "list", "--porcelain")
	if err != nil {
		return WorktreeList{}, errors.New(strings.TrimSpace(errOut))
	}
	var list WorktreeList
	var cur *Worktree
	flush := func() {
		if cur != nil {
			list.Worktrees = append(list.Worktrees, *cur)
			cur = nil
		}
	}
	for _, line := range strings.Split(out, "\n") {
		key, val, _ := strings.Cut(line, " ")
		switch key {
		case "worktree":
			flush()
			cur = &Worktree{Path: val}
		case "HEAD":
			if cur != nil && len(val) >= 8 {
				cur.Head = val[:8]
			}
		case "branch":
			if cur != nil {
				cur.Branch = strings.TrimPrefix(val, "refs/heads/")
			}
		case "detached":
			if cur != nil {
				cur.Detached = true
			}
		case "locked":
			if cur != nil {
				cur.Locked = true
			}
		case "prunable":
			if cur != nil {
				cur.Prunable = true
			}
		case "bare":
			cur = nil // a bare main repo has no work tree to show
		}
	}
	flush()
	if len(list.Worktrees) == 0 {
		return list, errors.New("no worktrees")
	}
	list.Worktrees[0].IsMain = true
	list.MainPath = list.Worktrees[0].Path
	list.Base = list.Worktrees[0].Branch

	if withStatus {
		// Each worktree costs a few git processes (status on a big tree is
		// the slow one); run them in parallel.
		var wg sync.WaitGroup
		sem := make(chan struct{}, 8)
		for i := range list.Worktrees {
			wg.Add(1)
			go func(w *Worktree) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				s.fillWorktreeStatus(ctx, w, list.Base)
			}(&list.Worktrees[i])
		}
		wg.Wait()
	}
	return list, nil
}

func (s *Service) fillWorktreeStatus(ctx context.Context, w *Worktree, base string) {
	if w.Prunable {
		return
	}
	if st := s.outOK(ctx, w.Path, "status", "--porcelain"); st != "" {
		w.Dirty = len(nonEmptyLines(st))
	}
	if f := strings.Split(strings.TrimSpace(s.outOK(ctx, w.Path, "log", "-1", "--format=%s%x00%ct")), "\x00"); len(f) == 2 {
		w.LastCommit = f[0]
		w.LastTime, _ = strconv.ParseInt(f[1], 10, 64)
	}
	if w.IsMain || base == "" {
		return
	}
	// left = only in base (behind), right = only in HEAD (ahead).
	if f := strings.Fields(s.outOK(ctx, w.Path, "rev-list", "--left-right", "--count", base+"...HEAD")); len(f) == 2 {
		w.Behind, _ = strconv.Atoi(f[0])
		w.Ahead, _ = strconv.Atoi(f[1])
	}
}

// FindWorktree returns the worktree whose path is path (after resolving
// symlinks), or nil.
func (l WorktreeList) FindWorktree(path string) *Worktree {
	want := realPath(path)
	for i := range l.Worktrees {
		if realPath(l.Worktrees[i].Path) == want {
			return &l.Worktrees[i]
		}
	}
	return nil
}

// Toplevel returns the root of the work tree containing dir ("" when dir is
// not inside a git work tree).
func (s *Service) Toplevel(ctx context.Context, dir string) string {
	return strings.TrimSpace(s.outOK(ctx, dir, "rev-parse", "--show-toplevel"))
}

// SubdirOf returns dir relative to its work-tree root ("" when dir is the
// root, or not in a repo).
func (s *Service) SubdirOf(ctx context.Context, dir string) string {
	top := s.Toplevel(ctx, dir)
	if top == "" {
		return ""
	}
	rel, err := filepath.Rel(realPath(top), realPath(dir))
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return ""
	}
	return rel
}

// How many directory levels below cwd FindRepos searches for repositories:
// RepoScanDepth when cwd is not a repository root, RepoRootScanDepth (for
// nested, independent repositories) when it is.
const (
	RepoScanDepth     = 2
	RepoRootScanDepth = 1
)

// FindRepos returns the repository roots a worktree view of dir covers: dir
// itself when it is the root of a work tree, plus every repository root in
// its subdirectories (RepoRootScanDepth levels below a repository root,
// RepoScanDepth below a plain folder). A repository in a PARENT of dir is
// never included. Hidden directories, node_modules and <repo>.worktrees
// containers are skipped, and a found repository is not descended into.
func (s *Service) FindRepos(ctx context.Context, dir string) []string {
	dir = filepath.Clean(dir)
	var out []string
	depth := RepoScanDepth
	if s.isRepoRoot(ctx, dir) {
		out = append(out, dir)
		depth = RepoRootScanDepth
	}
	var walk func(d string, level int)
	walk = func(d string, level int) {
		if level > depth {
			return
		}
		entries, err := os.ReadDir(d)
		if err != nil {
			return
		}
		for _, e := range entries {
			name := e.Name()
			if !e.IsDir() || strings.HasPrefix(name, ".") || name == "node_modules" || strings.HasSuffix(name, ".worktrees") {
				continue
			}
			sub := filepath.Join(d, name)
			if s.isRepoRoot(ctx, sub) {
				out = append(out, sub)
				continue
			}
			walk(sub, level+1)
		}
	}
	walk(dir, 1)
	return out
}

// isRepoRoot reports whether dir is the root of a git work tree (main or
// linked). The cheap .git check comes first so plain folders inside some
// enclosing repository cost no git process.
func (s *Service) isRepoRoot(ctx context.Context, dir string) bool {
	if _, err := os.Lstat(filepath.Join(dir, ".git")); err != nil {
		return false
	}
	top := s.Toplevel(ctx, dir)
	return top != "" && realPath(top) == realPath(dir)
}

// Containing returns the worktree whose directory contains dir, or nil.
// Path-prefix only: use WorktreeOf to respect nested repositories.
func (l WorktreeList) Containing(dir string) *Worktree {
	d := realPath(dir)
	var best *Worktree
	for i := range l.Worktrees {
		p := realPath(l.Worktrees[i].Path)
		if d == p || strings.HasPrefix(d, p+string(filepath.Separator)) {
			if best == nil || len(p) > len(realPath(best.Path)) {
				best = &l.Worktrees[i]
			}
		}
	}
	return best
}

// RealPath resolves symlinks (falling back to Clean) so paths compare reliably.
func RealPath(p string) string { return realPath(p) }

func realPath(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

var slugUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// WorktreeDirFor returns where a new worktree for branch is placed.
func WorktreeDirFor(mainPath, branch string) string {
	slug := strings.Trim(slugUnsafe.ReplaceAllString(branch, "-"), "-.")
	if slug == "" {
		slug = "wt-" + time.Now().Format("20060102-150405")
	}
	return filepath.Join(filepath.Dir(mainPath), filepath.Base(mainPath)+".worktrees", slug)
}

// AddWorktreeOpts configures AddWorktree.
type AddWorktreeOpts struct {
	Branch string // branch to create (or check out, if it exists and is free)
	Base   string // start point for a new branch; "" = HEAD of cwd
	// CopyEnv copies untracked top-level .env* files from the main worktree
	// (they are usually gitignored, so a fresh checkout lacks them).
	CopyEnv bool
}

// AddWorktree creates a linked worktree for the repository containing cwd and
// returns its path.
func (s *Service) AddWorktree(ctx context.Context, cwd string, o AddWorktreeOpts) (string, error) {
	o.Branch = strings.TrimSpace(o.Branch)
	if o.Branch == "" {
		return "", errors.New("branch name is required")
	}
	if _, errOut, err := s.run(ctx, cwd, "check-ref-format", "--branch", o.Branch); err != nil {
		return "", fmt.Errorf("invalid branch name %q: %s", o.Branch, strings.TrimSpace(errOut))
	}
	list, err := s.ListWorktrees(ctx, cwd, false)
	if err != nil {
		return "", err
	}
	for _, w := range list.Worktrees {
		if w.Branch == o.Branch {
			return "", fmt.Errorf("branch %q is already checked out at %s", o.Branch, w.Path)
		}
	}
	dir := WorktreeDirFor(list.MainPath, o.Branch)
	if _, err := os.Stat(dir); err == nil {
		return "", fmt.Errorf("directory already exists: %s", dir)
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return "", err
	}

	args := []string{"worktree", "add"}
	if s.outOK(ctx, cwd, "rev-parse", "--verify", "--quiet", "refs/heads/"+o.Branch) != "" {
		args = append(args, dir, o.Branch) // existing, currently unchecked-out branch
	} else {
		args = append(args, "-b", o.Branch, dir)
		if o.Base != "" {
			args = append(args, o.Base)
		}
	}
	if stdout, errOut, err := s.run(ctx, cwd, args...); err != nil {
		return "", errors.New(strings.TrimSpace(stdout + errOut))
	}
	if o.CopyEnv {
		s.copyEnvFiles(ctx, list.MainPath, dir)
	}
	return dir, nil
}

// copyEnvFiles copies top-level .env / .env.* files that git doesn't track.
func (s *Service) copyEnvFiles(ctx context.Context, from, to string) {
	matches, _ := filepath.Glob(filepath.Join(from, ".env*"))
	for _, src := range matches {
		fi, err := os.Stat(src)
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		name := filepath.Base(src)
		if s.outOK(ctx, from, "ls-files", "--", name) != "" {
			continue // tracked: already in the checkout
		}
		dst := filepath.Join(to, name)
		if _, err := os.Stat(dst); err == nil {
			continue
		}
		if data, err := os.ReadFile(src); err == nil {
			_ = os.WriteFile(dst, data, fi.Mode().Perm())
		}
	}
}

// RemoveWorktree removes a linked worktree (never the main one). force
// discards uncommitted changes; deleteBranch also deletes its branch
// (only when fully merged into base unless force).
func (s *Service) RemoveWorktree(ctx context.Context, cwd, path string, force, deleteBranch bool) error {
	list, err := s.ListWorktrees(ctx, cwd, false)
	if err != nil {
		return err
	}
	w := list.FindWorktree(path)
	if w == nil {
		return fmt.Errorf("not a worktree of this repository: %s", path)
	}
	if w.IsMain {
		return errors.New("the main worktree cannot be removed")
	}
	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, w.Path)
	if w.Prunable {
		args = []string{"worktree", "prune"}
	}
	if stdout, errOut, err := s.run(ctx, list.MainPath, args...); err != nil {
		return errors.New(strings.TrimSpace(stdout + errOut))
	}
	if deleteBranch && w.Branch != "" {
		flag := "-d"
		if force {
			flag = "-D"
		}
		if stdout, errOut, err := s.run(ctx, list.MainPath, "branch", flag, w.Branch); err != nil {
			return fmt.Errorf("worktree removed, but branch %s was kept: %s", w.Branch, strings.TrimSpace(stdout+errOut))
		}
	}
	return nil
}

// MergeWorktreeResult reports a merge-back attempt.
type MergeWorktreeResult struct {
	OK bool `json:"ok"`
	// NeedsSync: the merge would conflict. Merge base into the worktree's
	// branch first (conflicts are then resolved inside that worktree), then
	// merge back again.
	NeedsSync       bool     `json:"needs_sync,omitempty"`
	ConflictedFiles []string `json:"conflicted_files,omitempty"`
	UpToDate        bool     `json:"up_to_date,omitempty"`
	BackupBranch    string   `json:"backup_branch,omitempty"`
	Output          string   `json:"output"`
}

// MergeWorktreeIntoBase merges a linked worktree's branch into the branch of
// the main worktree. The merge runs in the main worktree; on conflict it is
// aborted (leaving the main tree untouched) and NeedsSync is reported.
func (s *Service) MergeWorktreeIntoBase(ctx context.Context, cwd, path string) MergeWorktreeResult {
	list, err := s.ListWorktrees(ctx, cwd, false)
	if err != nil {
		return MergeWorktreeResult{Output: err.Error()}
	}
	w := list.FindWorktree(path)
	switch {
	case w == nil:
		return MergeWorktreeResult{Output: "not a worktree of this repository"}
	case w.IsMain:
		return MergeWorktreeResult{Output: "the main worktree has nothing to merge back"}
	case w.Branch == "":
		return MergeWorktreeResult{Output: "worktree is on a detached HEAD; create a branch first"}
	case list.Base == "":
		return MergeWorktreeResult{Output: "main worktree is on a detached HEAD"}
	}
	if s.IsDirty(ctx, w.Path) {
		return MergeWorktreeResult{Output: "worktree " + w.Branch + " has uncommitted changes; commit them first"}
	}
	res := s.MergeStart(ctx, list.MainPath, w.Branch, list.Base)
	if !res.OK {
		return MergeWorktreeResult{Output: res.Output}
	}
	if len(res.ConflictedFiles) > 0 {
		_ = s.MergeAbort(ctx, list.MainPath)
		if res.BackupBranch != "" {
			_, _, _ = s.run(ctx, list.MainPath, "branch", "-D", res.BackupBranch)
		}
		return MergeWorktreeResult{NeedsSync: true, ConflictedFiles: res.ConflictedFiles,
			Output: "merging " + w.Branch + " into " + list.Base + " conflicts; merge " + list.Base +
				" into " + w.Branch + " inside the worktree first, resolve there, then merge back"}
	}
	return MergeWorktreeResult{OK: true, UpToDate: res.UpToDate, BackupBranch: res.BackupBranch, Output: res.Output}
}
