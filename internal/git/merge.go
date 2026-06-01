package git

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Merge operations with VSCode-style conflict resolution. All shell out to the
// git CLI: merge-tree conflict probing, three-way merge, stage extraction, and
// merge --abort have no faithful go-git equivalent in v5.

// MergeStatus reports whether a merge is in progress and which files conflict.
// Mirrors git_merge_status.
func (s *Service) MergeStatus(ctx context.Context, cwd string) MergeStatus {
	mergeHeadPath := filepath.Join(cwd, ".git", "MERGE_HEAD")
	st := MergeStatus{CurrentBranch: s.CurrentBranch(cwd), ConflictedFiles: []string{}}
	data, err := os.ReadFile(mergeHeadPath)
	if err != nil {
		return st
	}
	st.InProgress = true
	mh := strings.TrimSpace(string(data))
	if len(mh) > 8 {
		mh = mh[:8]
	}
	st.MergeHead = mh

	ls := s.outOK(ctx, cwd, "ls-files", "-u")
	seen := map[string]struct{}{}
	for _, line := range strings.Split(ls, "\n") {
		if !strings.Contains(line, "\t") {
			continue
		}
		path := strings.SplitN(line, "\t", 2)[1]
		if _, ok := seen[path]; !ok {
			seen[path] = struct{}{}
			st.ConflictedFiles = append(st.ConflictedFiles, path)
		}
	}
	return st
}

// MergePreview is a read-only preview of merging source into target.
// Mirrors git_merge_preview.
func (s *Service) MergePreview(ctx context.Context, cwd, source, target string) MergePreview {
	if source == "" || target == "" {
		return MergePreview{MergeKind: "error", Error: "source and target are required"}
	}
	if source == target {
		return MergePreview{MergeKind: "error", Error: "source and target are the same"}
	}

	run := func(args ...string) (string, string, bool) {
		stdout, stderr, err := s.run(ctx, cwd, append([]string{"-c", "core.quotepath=false"}, args...)...)
		return stdout, stderr, err == nil
	}

	for _, ref := range []string{source, target} {
		if _, _, ok := run("rev-parse", "--verify", ref+"^{commit}"); !ok {
			return MergePreview{MergeKind: "error", Error: "unknown ref: " + ref}
		}
	}

	baseOut, _, ok := run("merge-base", target, source)
	base := strings.TrimSpace(baseOut)
	if !ok || base == "" {
		return MergePreview{MergeKind: "error", Error: "no common ancestor between " + target + " and " + source}
	}

	count := func(rng string) int {
		out, _, ok := run("rev-list", "--count", rng)
		if !ok {
			return 0
		}
		n, _ := strconv.Atoi(strings.TrimSpace(out))
		return n
	}
	ahead := count(base + ".." + source)
	behind := count(base + ".." + target)

	var changed []ChangedFile
	if nsOut, _, ok := run("diff", "--name-status", target+"..."+source); ok {
		for _, line := range strings.Split(nsOut, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			parts := strings.Split(line, "\t")
			if len(parts) < 2 {
				continue
			}
			status := parts[0]
			if len(status) > 0 {
				status = status[:1]
			}
			changed = append(changed, ChangedFile{Path: parts[len(parts)-1], Status: status})
		}
	}

	var commits []MergeCommit
	fmtStr := "%H" + usSep + "%h" + usSep + "%an" + usSep + "%ad" + usSep + "%s"
	if logOut, _, ok := run("log", "--pretty=format:"+fmtStr, "--date=iso-strict",
		"--max-count=200", base+".."+source); ok {
		for _, line := range strings.Split(logOut, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			parts := strings.Split(line, usSep)
			if len(parts) < 5 {
				continue
			}
			commits = append(commits, MergeCommit{
				Hash: parts[0], Short: parts[1],
				Author: parts[2], Date: parts[3], Subject: parts[4],
			})
		}
	}

	if ahead == 0 {
		return MergePreview{MergeKind: "up_to_date", Ahead: 0, Behind: behind,
			Commits: []MergeCommit{}, ChangedFiles: []ChangedFile{}, ConflictingFiles: []string{}}
	}
	if behind == 0 {
		return MergePreview{MergeKind: "fast_forward", Ahead: ahead, Behind: 0,
			Commits: commits, ChangedFiles: changed, ConflictingFiles: []string{}}
	}

	// Three-way merge: probe conflicts with `git merge-tree --write-tree`.
	mtOut, mtErr, mtOK := run("merge-tree", "--write-tree", "--name-only",
		"--merge-base="+base, target, source)
	if mtOK {
		return MergePreview{MergeKind: "clean", Ahead: ahead, Behind: behind,
			Commits: commits, ChangedFiles: changed, ConflictingFiles: []string{}}
	}
	var lines []string
	for _, ln := range strings.Split(mtOut, "\n") {
		if strings.TrimSpace(ln) != "" {
			lines = append(lines, ln)
		}
	}
	var conflicting []string
	if len(lines) > 1 {
		conflicting = lines[1:]
	}
	if len(conflicting) == 0 && strings.TrimSpace(mtErr) == "" {
		// Older git without --write-tree: fall back to legacy merge-tree.
		if legacyOut, _, ok := run("merge-tree", base, target, source); ok &&
			!strings.Contains(legacyOut, "<<<<<<<") {
			return MergePreview{MergeKind: "clean", Ahead: ahead, Behind: behind,
				Commits: commits, ChangedFiles: changed, ConflictingFiles: []string{}}
		}
	}
	if conflicting == nil {
		conflicting = []string{}
	}
	return MergePreview{MergeKind: "conflict", Ahead: ahead, Behind: behind,
		Commits: commits, ChangedFiles: changed, ConflictingFiles: conflicting}
}

// MergeFileDiff returns the unified diff of path between target and source
// (symmetric form). Mirrors git_merge_file_diff.
func (s *Service) MergeFileDiff(ctx context.Context, cwd, source, target, path string) MergeFileDiff {
	if source == "" || target == "" || path == "" {
		return MergeFileDiff{Error: "source, target, and path are required"}
	}
	stdout, stderr, err := s.run(ctx, cwd, "-c", "core.quotepath=false", "diff", "--no-color",
		target+"..."+source, "--", path)
	if err != nil {
		msg := strings.TrimSpace(stderr)
		if msg == "" {
			msg = "diff failed"
		}
		return MergeFileDiff{Error: msg}
	}
	return MergeFileDiff{Diff: stdout}
}

// MergeStart merges source into target (no-ff), checking out target first if
// needed, and creates a backup/before-merge-<ts> branch beforehand.
// Mirrors git_merge_start (120s merge timeout).
func (s *Service) MergeStart(ctx context.Context, cwd, source, target string) MergeStartResult {
	if source == target {
		return MergeStartResult{OK: false, Output: "source and target branches are the same"}
	}
	if _, err := os.Stat(filepath.Join(cwd, ".git", "MERGE_HEAD")); err == nil {
		return MergeStartResult{OK: false, Output: "a merge is already in progress; resolve or abort it first"}
	}
	if s.IsDirty(ctx, cwd) {
		return MergeStartResult{OK: false, Output: "working tree has uncommitted changes; commit or stash before merging"}
	}

	current := s.CurrentBranch(cwd)
	if current != target {
		stdout, stderr, err := s.run(ctx, cwd, "checkout", target)
		if err != nil {
			return MergeStartResult{OK: false,
				Output: "failed to checkout target branch '" + target + "': " + strings.TrimSpace(stdout+stderr)}
		}
	}

	ts := time.Now().Format("20060102-150405")
	backup := "backup/before-merge-" + ts
	if _, _, err := s.run(ctx, cwd, "branch", backup, "HEAD"); err != nil {
		sha := strings.TrimSpace(s.outOK(ctx, cwd, "rev-parse", "--short", "HEAD"))
		if sha == "" {
			sha = "x"
		}
		backup = "backup/before-merge-" + ts + "-" + sha
		if _, errOut, err2 := s.run(ctx, cwd, "branch", backup, "HEAD"); err2 != nil {
			return MergeStartResult{OK: false, Output: "failed to create backup branch: " + strings.TrimSpace(errOut)}
		}
	}

	mctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	stdout, stderr, err := s.run(mctx, cwd, "merge", "--no-ff", "--no-edit", source)
	out := strings.TrimSpace(stdout + stderr)
	if err == nil {
		if strings.Contains(out, "Already up to date") || strings.Contains(out, "Already up-to-date") {
			_, _, _ = s.run(ctx, cwd, "branch", "-D", backup)
			return MergeStartResult{OK: true, UpToDate: true, Output: out}
		}
		return MergeStartResult{OK: true, Clean: true, Output: out, BackupBranch: backup}
	}

	status := s.MergeStatus(ctx, cwd)
	if status.InProgress && len(status.ConflictedFiles) > 0 {
		return MergeStartResult{OK: true, Clean: false,
			ConflictedFiles: status.ConflictedFiles, Output: out, BackupBranch: backup}
	}
	_, _, _ = s.run(ctx, cwd, "branch", "-D", backup)
	return MergeStartResult{OK: false, Output: out}
}

// ConflictFileVersions returns base/ours/theirs/working for a conflicted file.
// Mirrors git_conflict_file_versions.
func (s *Service) ConflictFileVersions(ctx context.Context, cwd, path string) ConflictVersions {
	show := func(stage int) string {
		return s.outOK(ctx, cwd, "show", ":"+strconv.Itoa(stage)+":"+path)
	}
	working := ""
	if data, err := os.ReadFile(filepath.Join(cwd, path)); err == nil {
		working = string(data)
	}
	return ConflictVersions{
		Path:    path,
		Base:    show(1),
		Ours:    show(2),
		Theirs:  show(3),
		Working: working,
	}
}

// ResolveFile writes resolved content to disk then `git add`s it. Mirrors
// git_resolve_file.
func (s *Service) ResolveFile(ctx context.Context, cwd, path, content string) CommandResult {
	target := filepath.Join(cwd, path)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return CommandResult{OK: false, Output: "write failed: " + err.Error()}
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return CommandResult{OK: false, Output: "write failed: " + err.Error()}
	}
	stdout, stderr, err := s.run(ctx, cwd, "add", "--", path)
	if err != nil {
		return CommandResult{OK: false, Output: strings.TrimSpace(stdout + stderr)}
	}
	return CommandResult{OK: true, Output: ""}
}

// MergeContinue finalises an in-progress merge, refusing if files remain
// unmerged. An empty message uses --no-edit. Mirrors git_merge_continue.
func (s *Service) MergeContinue(ctx context.Context, cwd, message string) CommandResult {
	if _, err := os.Stat(filepath.Join(cwd, ".git", "MERGE_HEAD")); err != nil {
		return CommandResult{OK: false, Output: "no merge in progress"}
	}
	status := s.MergeStatus(ctx, cwd)
	if len(status.ConflictedFiles) > 0 {
		return CommandResult{OK: false, Output: "still unresolved: " + strings.Join(status.ConflictedFiles, ", ")}
	}
	args := []string{"commit", "--no-edit"}
	if message != "" {
		args = []string{"commit", "-m", message}
	}
	stdout, stderr, err := s.run(ctx, cwd, args...)
	return CommandResult{OK: err == nil, Output: strings.TrimSpace(stdout + stderr)}
}

// MergeAbort aborts the in-progress merge. Mirrors git_merge_abort.
func (s *Service) MergeAbort(ctx context.Context, cwd string) CommandResult {
	stdout, stderr, err := s.run(ctx, cwd, "merge", "--abort")
	return CommandResult{OK: err == nil, Output: strings.TrimSpace(stdout + stderr)}
}
