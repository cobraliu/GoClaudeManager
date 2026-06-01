package git

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// This file holds operations that shell out to the `git` CLI. They fall into
// two groups:
//   - display diffs / patches, where go-git's formatting differs from git's and
//     the frontend expects git-CLI output verbatim; and
//   - operations go-git implements poorly or not at all in v5 (status --porcelain
//     semantics, --grep/--graph log, for-each-ref, checkout with carry-over,
//     stash, networked clone/push/pull/fetch, merge + merge-tree, rollback).

// runOut runs git in cwd and returns combined stdout (Python's helpers mostly
// read stdout only). Returns "" on non-zero exit.
func (s *Service) outOK(ctx context.Context, cwd string, args ...string) string {
	out, _, err := s.run(ctx, cwd, args...)
	if err != nil {
		return ""
	}
	return out
}

// ── status / dirty / staged ─────────────────────────────────────────────────

// IsDirty reports whether there are any uncommitted changes (staged or
// unstaged). Mirrors git_is_dirty (`status --porcelain`).
func (s *Service) IsDirty(ctx context.Context, cwd string) bool {
	out := s.outOK(ctx, cwd, "-c", "core.quotepath=false", "status", "--porcelain")
	return strings.TrimSpace(out) != ""
}

// stagedFiles returns files staged for commit. Mirrors _get_staged_files.
func (s *Service) stagedFiles(ctx context.Context, cwd string) []string {
	out := s.outOK(ctx, cwd, "-c", "core.quotepath=false", "diff", "--cached", "--name-only")
	return nonEmptyLines(out)
}

// ── add + commit ─────────────────────────────────────────────────────────────

// AddCommit runs `git add -A` then commits. The commit body lists changed files;
// message is the subject line. committed is false when there is nothing to
// commit. author becomes both user.name and the local part of user.email.
// Mirrors git_add_commit. Uses the CLI to match the custom -c author config and
// the -F - stdin path that avoids E2BIG on huge messages.
func (s *Service) AddCommit(ctx context.Context, cwd, message, author string) CommandResult {
	if author == "" {
		author = "claude"
	}
	if _, errOut, err := s.run(ctx, cwd, "add", "-A"); err != nil {
		return CommandResult{OK: false, Committed: false, Output: strings.TrimSpace(errOut)}
	}

	staged := s.stagedFiles(ctx, cwd)
	full := message
	if len(staged) > 0 {
		var b strings.Builder
		b.WriteString("Changed files:\n")
		for _, f := range staged {
			b.WriteString("  ")
			b.WriteString(f)
			b.WriteString("\n")
		}
		full = message + "\n\n" + strings.TrimRight(b.String(), "\n")
	}

	stdout, stderr, err := s.runStdin(ctx, cwd, full,
		"-c", "core.quotepath=false",
		"-c", "user.email="+author+"@auto",
		"-c", "user.name="+author,
		"commit", "-F", "-",
	)
	out := strings.TrimSpace(stdout + stderr)
	if err == nil {
		return CommandResult{OK: true, Committed: true, Output: out}
	}
	if strings.Contains(out, "nothing to commit") || strings.Contains(out, "nothing added to commit") {
		return CommandResult{OK: true, Committed: false, Output: out}
	}
	return CommandResult{OK: false, Committed: false, Output: out}
}

// ── log variants needing CLI features ────────────────────────────────────────

const (
	usSep = "\x1f" // unit separator field delimiter
	rsSep = "\x1e" // record separator
)

// SearchCommits searches commit messages (case-insensitive) for query, up to n
// commits. Mirrors git_search_commits.
func (s *Service) SearchCommits(ctx context.Context, cwd, query string, n int) []CommitSearchResult {
	if n <= 0 {
		n = 500
	}
	out := s.outOK(ctx, cwd,
		"-c", "core.quotepath=false", "log", "-"+strconv.Itoa(n),
		"--grep="+query, "--regexp-ignore-case",
		"--format="+rsSep+"%H"+usSep+"%h"+usSep+"%s"+usSep+"%an"+usSep+"%ai"+usSep+"%B",
	)
	if out == "" {
		return nil
	}
	qLower := strings.ToLower(query)
	var entries []CommitSearchResult
	for _, record := range strings.Split(out, rsSep) {
		record = strings.TrimSpace(record)
		if record == "" {
			continue
		}
		parts := strings.SplitN(record, usSep, 6)
		if len(parts) < 5 {
			continue
		}
		hash := strings.TrimSpace(parts[0])
		if hash == "" {
			continue
		}
		body := ""
		if len(parts) > 5 {
			body = parts[5]
		}
		context := ""
		for _, line := range strings.Split(body, "\n") {
			if strings.Contains(strings.ToLower(line), qLower) {
				context = truncateRunes(strings.TrimSpace(line), 300)
				break
			}
		}
		entries = append(entries, CommitSearchResult{
			Hash:      hash,
			ShortHash: strings.TrimSpace(parts[1]),
			Subject:   strings.TrimSpace(parts[2]),
			Author:    strings.TrimSpace(parts[3]),
			Date:      strings.TrimSpace(parts[4]),
			Context:   context,
		})
	}
	return entries
}

// GraphLog returns commits for client-side graph rendering. scope is "current"
// (HEAD), "all", or a branch name. Mirrors git_graph_log.
func (s *Service) GraphLog(ctx context.Context, cwd, scope string, n int) []GraphCommit {
	if n <= 0 {
		n = 500
	}
	args := []string{"-c", "core.quotepath=false", "log", "-" + strconv.Itoa(n),
		"--pretty=format:%H" + usSep + "%h" + usSep + "%P" + usSep + "%s" + usSep + "%an" + usSep + "%ai" + usSep + "%D"}
	switch {
	case scope == "all":
		args = append(args, "--all")
	case scope != "" && scope != "current":
		args = append(args, scope)
	}
	out := s.outOK(ctx, cwd, args...)
	if out == "" {
		return nil
	}
	var entries []GraphCommit
	for _, line := range strings.Split(out, "\n") {
		parts := strings.Split(line, usSep)
		if len(parts) < 6 {
			continue
		}
		refsRaw := ""
		if len(parts) > 6 {
			refsRaw = parts[6]
		}
		// Initialize as empty (non-nil) slices: a nil slice marshals to JSON
		// `null`, and the client maps over commit.refs / commit.parents
		// unconditionally (root commits have no parents; most commits have no
		// refs) — null there throws "Cannot read properties of null (reading
		// 'map')". Python returned [] here.
		refs := []string{}
		for _, r := range strings.Split(refsRaw, ",") {
			if t := strings.TrimSpace(r); t != "" {
				refs = append(refs, t)
			}
		}
		parents := []string{}
		for _, p := range strings.Split(parts[2], " ") {
			if p != "" {
				parents = append(parents, p)
			}
		}
		entries = append(entries, GraphCommit{
			Hash:      parts[0],
			ShortHash: parts[1],
			Parents:   parents,
			Subject:   parts[3],
			Author:    parts[4],
			Date:      parts[5],
			Refs:      refs,
		})
	}
	return entries
}

// ── diffs / show (CLI for exact formatting) ──────────────────────────────────

// FileDiffAtCommit returns the unified diff for relPath in commitHash.
// Mirrors git_file_diff.
func (s *Service) FileDiffAtCommit(ctx context.Context, cwd, relPath, commitHash string) string {
	return s.outOK(ctx, cwd, "-c", "core.quotepath=false", "show", "--patch", "--no-color",
		commitHash, "--", relPath)
}

// DiffFiles returns the list of files changed between two commits.
// Mirrors git_diff_files.
func (s *Service) DiffFiles(ctx context.Context, cwd, oldHash, newHash string) []string {
	out := s.outOK(ctx, cwd, "-c", "core.quotepath=false", "diff", "--name-only", oldHash, newHash)
	return nonEmptyLines(out)
}

// WorkingFileDiff returns the unified diff for a single working-tree file,
// matching code_api's display logic: diff against HEAD, falling back to the
// index, then synthesising an all-added diff for untracked files. Pass the
// file's current line slice for the untracked fallback (nil to skip it).
func (s *Service) WorkingFileDiff(ctx context.Context, cwd, relPath string, untrackedLines []string) string {
	diff := s.outOK(ctx, cwd, "diff", "HEAD", "--", relPath)
	if diff == "" {
		diff = s.outOK(ctx, cwd, "diff", "--cached", "--", relPath)
	}
	if diff == "" {
		// ls-files --error-unmatch prints the path if tracked, exits non-zero if not.
		tracked := s.outOK(ctx, cwd, "ls-files", "--error-unmatch", relPath)
		if strings.TrimSpace(tracked) == "" && len(untrackedLines) > 0 {
			var b strings.Builder
			b.WriteString("--- /dev/null\n+++ b/")
			b.WriteString(relPath)
			b.WriteString("\n@@ -0,0 +1,")
			b.WriteString(strconv.Itoa(len(untrackedLines)))
			b.WriteString(" @@\n")
			for i, line := range untrackedLines {
				b.WriteString("+")
				b.WriteString(line)
				if i < len(untrackedLines)-1 {
					b.WriteString("\n")
				}
			}
			diff = b.String()
		}
	}
	return diff
}

// ShowCommit returns full commit details: message + per-file old/new content
// (capped at 50 files). Mirrors git_show_commit. The diff-file enumeration uses
// the CLI; per-file content uses go-git (FileAtCommit).
func (s *Service) ShowCommit(ctx context.Context, cwd, commitHash string) ShowCommit {
	message := s.CommitFullMessage(cwd, commitHash)
	parent := commitHash + "^"
	changed := s.DiffFiles(ctx, cwd, parent, commitHash)
	if len(changed) == 0 {
		const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
		changed = s.DiffFiles(ctx, cwd, emptyTree, commitHash)
	}
	limit := len(changed)
	if limit > 50 {
		limit = 50
	}
	files := make([]FileVersion, 0, limit)
	for _, path := range changed[:limit] {
		files = append(files, FileVersion{
			Path:       path,
			OldContent: s.FileAtCommit(cwd, parent, path),
			NewContent: s.FileAtCommit(cwd, commitHash, path),
		})
	}
	return ShowCommit{Message: message, Files: files}
}

// DiffCommits returns per-file old/new content between two commits (capped at
// 50). Mirrors the git_diff_endpoint loop in sessions.py.
func (s *Service) DiffCommits(ctx context.Context, cwd, oldHash, newHash string) []FileVersion {
	changed := s.DiffFiles(ctx, cwd, oldHash, newHash)
	limit := len(changed)
	if limit > 50 {
		limit = 50
	}
	files := make([]FileVersion, 0, limit)
	for _, path := range changed[:limit] {
		files = append(files, FileVersion{
			Path:       path,
			OldContent: s.FileAtCommit(cwd, oldHash, path),
			NewContent: s.FileAtCommit(cwd, newHash, path),
		})
	}
	return files
}

// ── branches ─────────────────────────────────────────────────────────────────

// ListBranches returns {current, local, local_with_dates, remote_only} for the
// branch picker. Mirrors git_list_branches.
func (s *Service) ListBranches(ctx context.Context, cwd string) BranchInfo {
	info := BranchInfo{Current: s.CurrentBranch(cwd)}

	localOut := s.outOK(ctx, cwd, "for-each-ref",
		"--format=%(refname:short)%09%(committerdate:unix)", "refs/heads/")
	for _, line := range strings.Split(localOut, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		name, ts, _ := strings.Cut(line, "\t")
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		info.Local = append(info.Local, name)
		n, _ := strconv.ParseInt(strings.TrimSpace(ts), 10, 64)
		info.LocalWithDates = append(info.LocalWithDates, BranchWithTS{Name: name, CommitterDate: n})
	}

	remoteOut := s.outOK(ctx, cwd, "for-each-ref",
		"--format=%(refname:short)", "refs/remotes/origin/")
	localSet := make(map[string]struct{}, len(info.Local))
	for _, l := range info.Local {
		localSet[l] = struct{}{}
	}
	for _, line := range strings.Split(remoteOut, "\n") {
		ref := strings.TrimSpace(line)
		if ref == "" || ref == "origin/HEAD" || strings.Contains(ref, "/HEAD") {
			continue
		}
		if !strings.HasPrefix(ref, "origin/") {
			continue
		}
		name := ref[len("origin/"):]
		if name == "" {
			continue
		}
		if _, ok := localSet[name]; !ok {
			info.RemoteOnly = append(info.RemoteOnly, name)
		}
	}
	if info.Local == nil {
		info.Local = []string{}
	}
	if info.LocalWithDates == nil {
		info.LocalWithDates = []BranchWithTS{}
	}
	if info.RemoteOnly == nil {
		info.RemoteOnly = []string{}
	}
	return info
}

// CheckoutBranch checks out an existing local branch. If stash is true, the
// working tree is stashed first. Conflict info is returned when local changes
// would be overwritten. Mirrors git_checkout_branch.
func (s *Service) CheckoutBranch(ctx context.Context, cwd, branch string, stash bool) CheckoutResult {
	if stash {
		if res, ok := s.doStash(ctx, cwd, branch); !ok {
			return res
		} else {
			return s.checkoutInner(ctx, cwd, res.Stashed, "checkout", branch)
		}
	}
	return s.checkoutInner(ctx, cwd, false, "checkout", branch)
}

// CheckoutRemoteBranch fetches origin/branch and creates a local tracking
// branch, then checks it out. Mirrors git_checkout_remote_branch.
func (s *Service) CheckoutRemoteBranch(ctx context.Context, cwd, branch string, stash bool) CheckoutResult {
	if _, errOut, err := s.runEnv(ctx, cwd, s.proxy(), "fetch", "origin", branch); err != nil {
		return CheckoutResult{OK: false, Output: strings.TrimSpace(errOut), Conflict: false}
	}
	stashed := false
	if stash {
		if res, ok := s.doStash(ctx, cwd, branch); !ok {
			return res
		} else {
			stashed = res.Stashed
		}
	}
	return s.checkoutInner(ctx, cwd, stashed, "checkout", "-b", branch, "--track", "origin/"+branch)
}

// doStash runs `git stash push -u -m <auto msg>`. On success returns
// (result with Stashed set, true); on failure returns (error result, false).
func (s *Service) doStash(ctx context.Context, cwd, target string) (CheckoutResult, bool) {
	current := s.CurrentBranch(cwd)
	if current == "" {
		current = "detached"
	}
	ts := time.Now().Format("2006-01-02 15:04:05")
	msg := "claudemanager: WIP on " + current + " (switching to " + target + ") @ " + ts
	stdout, stderr, err := s.run(ctx, cwd, "stash", "push", "-u", "-m", msg)
	if err != nil {
		return CheckoutResult{OK: false, Output: strings.TrimSpace(stderr), Conflict: false}, false
	}
	stashed := !strings.Contains(stdout+stderr, "No local changes")
	return CheckoutResult{Stashed: stashed}, true
}

// checkoutInner runs a checkout command and parses conflict output.
func (s *Service) checkoutInner(ctx context.Context, cwd string, stashed bool, args ...string) CheckoutResult {
	stdout, stderr, err := s.run(ctx, cwd, args...)
	out := strings.TrimSpace(stdout + stderr)
	if err == nil {
		return CheckoutResult{OK: true, Output: out, Conflict: false, Stashed: stashed}
	}
	if strings.Contains(out, "would be overwritten by checkout") ||
		strings.Contains(out, "would be overwritten by merge") {
		var conflicting []string
		for _, line := range strings.Split(stdout+stderr, "\n") {
			if strings.HasPrefix(line, "\t") {
				if t := strings.TrimSpace(line); t != "" {
					conflicting = append(conflicting, t)
				}
			}
		}
		return CheckoutResult{OK: false, Output: out, Conflict: true, ConflictingFiles: conflicting}
	}
	return CheckoutResult{OK: false, Output: out, Conflict: false}
}

// ── networked ops (proxy-injected) ───────────────────────────────────────────

func (s *Service) proxy() map[string]string {
	if s == nil || s.proxyEnv == nil {
		return nil
	}
	return s.proxyEnv()
}

// Clone clones url into targetDir (which must not exist). The parent directory
// is created if needed. Proxy env is injected. Mirrors git_clone (5-min timeout).
func (s *Service) Clone(ctx context.Context, url, targetDir string) CommandResult {
	parent := filepath.Dir(targetDir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return CommandResult{OK: false, Output: err.Error()}
	}
	cctx, cancel := context.WithTimeout(ctx, 300*time.Second)
	defer cancel()
	stdout, stderr, err := s.runEnv(cctx, "", s.proxy(), "clone", url, targetDir)
	return CommandResult{OK: err == nil, Output: strings.TrimSpace(stdout + stderr)}
}

// Push pushes HEAD's branch to origin with -u. Proxy env is injected. Mirrors
// git_push (60s timeout, defaults branch to "main").
func (s *Service) Push(ctx context.Context, cwd string) CommandResult {
	branch := s.CurrentBranch(cwd)
	if branch == "" {
		branch = "main"
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	stdout, stderr, err := s.runEnv(cctx, cwd, s.proxy(), "push", "-u", "origin", branch)
	return CommandResult{OK: err == nil, Output: strings.TrimSpace(stdout + stderr)}
}

// Pull pulls the current branch (--ff-only), using the tracking upstream if set,
// else origin/<branch>. Proxy env is injected. Mirrors git_pull (60s timeout).
func (s *Service) Pull(ctx context.Context, cwd string) CommandResult {
	current := s.CurrentBranch(cwd)
	if current == "" {
		return CommandResult{OK: false, Output: "not on a branch"}
	}
	_, _, upErr := s.run(ctx, cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
	args := []string{"pull", "--ff-only"}
	if upErr != nil {
		args = append(args, "origin", current)
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	stdout, stderr, err := s.runEnv(cctx, cwd, s.proxy(), args...)
	return CommandResult{OK: err == nil, Output: strings.TrimSpace(stdout + stderr)}
}

// ── rollback ──────────────────────────────────────────────────────────────────

// Rollback restores the tree of commitHash via `checkout <hash> -- .` then
// commits, preserving intermediate history. Mirrors git_rollback.
func (s *Service) Rollback(ctx context.Context, cwd, commitHash, author string) CommandResult {
	if author == "" {
		author = "claude"
	}
	if _, errOut, err := s.run(ctx, cwd, "checkout", commitHash, "--", "."); err != nil {
		return CommandResult{OK: false, Output: strings.TrimSpace(errOut)}
	}
	short := commitHash
	if len(short) > 8 {
		short = short[:8]
	}
	stdout, stderr, err := s.run(ctx, cwd,
		"-c", "user.email="+author+"@auto",
		"-c", "user.name="+author,
		"commit", "-m", "rollback to "+short,
	)
	out := strings.TrimSpace(stdout + stderr)
	if err == nil {
		return CommandResult{OK: true, Output: out}
	}
	if strings.Contains(out, "nothing to commit") {
		return CommandResult{OK: true, Output: "Already at that version, nothing to rollback"}
	}
	return CommandResult{OK: false, Output: out}
}

// ── small shared helpers ─────────────────────────────────────────────────────

func nonEmptyLines(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		if strings.TrimSpace(line) != "" {
			out = append(out, line)
		}
	}
	return out
}
