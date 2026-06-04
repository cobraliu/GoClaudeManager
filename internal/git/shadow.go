package git

// Shadow-git rewind system.
//
// A *shadow repository* is a git-dir kept OUTSIDE the project (under the app's
// data dir) whose work-tree points at the real project directory. It snapshots
// the working tree at each completed turn and commits into its own history, so
// the project's real `.git` is never touched. This gives a "stronger" rewind
// than Claude Code's native one (which only restores files Claude edited and
// truncates the conversation): the shadow captures the entire non-ignored
// working tree, independent of Claude, with prompt-labeled commits per branch.
//
// Branch-awareness: the shadow mirrors the real repo's current branch into a
// parallel `shadow/<realbranch>` ref. Because the work-tree IS the real project
// dir, we must NEVER `checkout` between shadow branches (that would overwrite
// the user's real files). Instead we move HEAD with `symbolic-ref` and reset the
// index with `read-tree` (no `-u`), which leaves the working tree untouched.
// The ONLY operation that writes the working tree is ShadowRestore.
//
// All git invocations set GIT_DIR (the shadow repo) and GIT_WORK_TREE (the real
// project dir) via runEnv; the project `.gitignore` is honored automatically
// because git reads work-tree ignore files, and the real `.git/` is added to the
// shadow's info/exclude so it is never tracked.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// RewindPoint is one shadow commit (one completed turn, or a manual/safety snapshot).
type RewindPoint struct {
	Hash      string `json:"hash"`
	ShortHash string `json:"short_hash"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	Ts        int64  `json:"ts"`      // committer date, unix seconds
	Prompt    string `json:"prompt"`  // best-effort user prompt extracted from the body
	Session   string `json:"session"` // Session trailer, if present
}

// ShadowRestoreResult is returned by ShadowRestore. The restore is a FORWARD
// move on the branch: the pre-restore state is committed as a point (BeforeHash)
// and the restored state as a new point (NewHash), so the timeline stays linear
// and you can always "go back" by restoring BeforeHash.
type ShadowRestoreResult struct {
	OK           bool   `json:"ok"`
	RestoredFrom string `json:"restored_from"` // the rewind point that was restored
	NewHash      string `json:"new_hash"`      // the new point capturing the restored state
	BeforeHash   string `json:"before_hash"`   // the point capturing the pre-restore state
}

// ShadowPreview is the diff a restore WOULD produce (current working tree → target),
// returned by ShadowRestorePreview so the user can review before confirming.
type ShadowPreview struct {
	Hash  string             `json:"hash"`
	Files []ShadowFileChange `json:"files"`
	Diff  string             `json:"diff"`
}

// ShadowShowResult is the detail view of one rewind point.
type ShadowShowResult struct {
	Hash    string             `json:"hash"`
	Message string             `json:"message"`
	Files   []ShadowFileChange `json:"files"`
}

// ShadowFileChange is one changed path in a rewind point (name-status).
type ShadowFileChange struct {
	Status string `json:"status"`
	Path   string `json:"path"`
}

// ShadowCommitDetail mirrors git.ShowCommit (message + per-file old/new content)
// so the frontend can render a shadow rewind point in the SAME side-by-side diff
// modal used for real commits.
type ShadowCommitDetail struct {
	Hash    string        `json:"hash"`
	Message string        `json:"message"`
	Files   []FileVersion `json:"files"`
}

// ── path helpers (pure; no Service needed) ───────────────────────────────────

// ShadowProjectDir maps an absolute workdir to its per-project shadow directory
// under root, keyed by a hash of the path (so two sessions on the same project
// share one shadow timeline).
func ShadowProjectDir(root, workdir string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(workdir)))
	return filepath.Join(root, hex.EncodeToString(sum[:])[:16])
}

// ShadowGitDir is the shadow GIT_DIR for a workdir.
func ShadowGitDir(root, workdir string) string {
	return filepath.Join(ShadowProjectDir(root, workdir), "git")
}

// ── per-shadow-dir serialization ─────────────────────────────────────────────

var (
	shadowMuMap  = map[string]*sync.Mutex{}
	shadowMuLock sync.Mutex
)

func shadowLock(gitDir string) func() {
	shadowMuLock.Lock()
	mu := shadowMuMap[gitDir]
	if mu == nil {
		mu = &sync.Mutex{}
		shadowMuMap[gitDir] = mu
	}
	shadowMuLock.Unlock()
	mu.Lock()
	return mu.Unlock
}

// ── helpers ──────────────────────────────────────────────────────────────────

// shadowEnv returns GIT_DIR/GIT_WORK_TREE as ABSOLUTE paths. They must be
// absolute because the git subprocess runs with cmd.Dir set to the work-tree,
// so a relative GIT_DIR (e.g. dev "data/shadow/…") would otherwise resolve
// against the work-tree instead of the server's cwd.
func shadowEnv(gitDir, workdir string) map[string]string {
	if abs, err := filepath.Abs(gitDir); err == nil {
		gitDir = abs
	}
	if abs, err := filepath.Abs(workdir); err == nil {
		workdir = abs
	}
	return map[string]string{"GIT_DIR": gitDir, "GIT_WORK_TREE": workdir}
}

// sanitizeBranch keeps a branch name safe for use inside a ref path. Slashes are
// preserved (feature/foo → shadow/feature/foo); anything else outside a small
// allowlist becomes '-'. Leading dots/dashes are neutralized.
func sanitizeBranch(b string) string {
	b = strings.TrimSpace(b)
	if b == "" {
		return "_worktree"
	}
	var sb strings.Builder
	for _, r := range b {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '-', r == '/':
			sb.WriteRune(r)
		default:
			sb.WriteRune('-')
		}
	}
	out := strings.Trim(sb.String(), "./-")
	if out == "" {
		return "_worktree"
	}
	return out
}

func shadowRef(branch string) string { return "refs/heads/shadow/" + sanitizeBranch(branch) }

func (s *Service) shadowRefExists(ctx context.Context, env map[string]string, ref string) bool {
	_, _, err := s.runEnv(ctx, "", env, "show-ref", "--verify", "--quiet", ref)
	return err == nil
}

func (s *Service) shadowStaged(ctx context.Context, dir string, env map[string]string) bool {
	out, _, _ := s.runEnv(ctx, dir, env, "diff", "--cached", "--name-only")
	return strings.TrimSpace(out) != ""
}

// RealBranch returns the project's current branch name, or a "_detached…" /
// "_worktree" fallback when detached / not a repo. Exported for the trigger loop.
func (s *Service) RealBranch(ctx context.Context, workdir string) string {
	out, _, err := s.run(ctx, workdir, "rev-parse", "--abbrev-ref", "HEAD")
	b := strings.TrimSpace(out)
	if err != nil || b == "" {
		return "_worktree"
	}
	if b == "HEAD" { // detached
		sh, _, _ := s.run(ctx, workdir, "rev-parse", "--short", "HEAD")
		if sh = strings.TrimSpace(sh); sh != "" {
			return "_detached-" + sh
		}
		return "_detached"
	}
	return b
}

// ensureShadowRepo initializes the shadow git-dir on first use and makes sure the
// real repo's .git is never tracked.
func (s *Service) ensureShadowRepo(ctx context.Context, gitDir, workdir string) error {
	if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); err == nil {
		return nil
	}
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		return err
	}
	env := shadowEnv(gitDir, workdir)
	if _, errOut, err := s.runEnv(ctx, workdir, env, "init", "-q"); err != nil {
		return fmt.Errorf("shadow init: %s", strings.TrimSpace(errOut))
	}
	excl := filepath.Join(gitDir, "info", "exclude")
	_ = os.MkdirAll(filepath.Dir(excl), 0o755)
	if b, _ := os.ReadFile(excl); !strings.Contains(string(b), ".git/") {
		f, err := os.OpenFile(excl, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = f.WriteString("\n.git/\n")
			_ = f.Close()
		}
	}
	return nil
}

// ── snapshot ─────────────────────────────────────────────────────────────────

// ShadowSnapshot commits the current working tree onto shadow/<branch> without
// touching the working tree. Returns committed=false (no error) when there is
// nothing new to record. `message` is committed verbatim (the caller embeds the
// subject/prompt/trailers).
func (s *Service) ShadowSnapshot(ctx context.Context, gitDir, workdir, branch, message, author string) (hash string, committed bool, err error) {
	unlock := shadowLock(gitDir)
	defer unlock()
	return s.shadowSnapshotLocked(ctx, gitDir, workdir, branch, message, author)
}

// shadowSnapshotLocked is the lock-free body (callers that already hold the lock,
// e.g. ShadowRestore's safety snapshot, use this).
func (s *Service) shadowSnapshotLocked(ctx context.Context, gitDir, workdir, branch, message, author string) (hash string, committed bool, err error) {
	if err = s.ensureShadowRepo(ctx, gitDir, workdir); err != nil {
		return "", false, err
	}
	env := shadowEnv(gitDir, workdir)
	ref := shadowRef(branch)

	// Point HEAD at the shadow branch WITHOUT touching the working tree.
	if _, eo, e := s.runEnv(ctx, workdir, env, "symbolic-ref", "HEAD", ref); e != nil {
		return "", false, fmt.Errorf("symbolic-ref: %s", strings.TrimSpace(eo))
	}
	// Reset the index to the branch tip (or empty for an unborn branch); no -u so
	// the working tree is left alone.
	if s.shadowRefExists(ctx, env, ref) {
		if _, eo, e := s.runEnv(ctx, workdir, env, "read-tree", ref); e != nil {
			return "", false, fmt.Errorf("read-tree: %s", strings.TrimSpace(eo))
		}
	} else {
		if _, eo, e := s.runEnv(ctx, workdir, env, "read-tree", "--empty"); e != nil {
			return "", false, fmt.Errorf("read-tree --empty: %s", strings.TrimSpace(eo))
		}
	}
	// Stage the current disk state (respects the project .gitignore).
	if _, eo, e := s.runEnv(ctx, workdir, env, "add", "-A"); e != nil {
		return "", false, fmt.Errorf("add: %s", strings.TrimSpace(eo))
	}
	if !s.shadowStaged(ctx, workdir, env) {
		return "", false, nil // nothing new
	}
	if author == "" {
		author = "claude"
	}
	out, errOut, e := s.runStdinEnv(ctx, workdir, env, message,
		"-c", "core.quotepath=false",
		"-c", "user.email="+author+"@shadow",
		"-c", "user.name="+author,
		"commit", "-F", "-",
	)
	if e != nil {
		return "", false, fmt.Errorf("commit: %s", strings.TrimSpace(out+errOut))
	}
	h, _, _ := s.runEnv(ctx, workdir, env, "rev-parse", "HEAD")
	return strings.TrimSpace(h), true, nil
}

// ── log / show / diff ────────────────────────────────────────────────────────

const (
	shadowFieldSep  = "\x1f"
	shadowRecordSep = "\x1e"
)

// ShadowLog lists rewind points on shadow/<branch>, most recent first.
func (s *Service) ShadowLog(ctx context.Context, gitDir, workdir, branch string, limit int) ([]RewindPoint, error) {
	env := shadowEnv(gitDir, workdir)
	ref := shadowRef(branch)
	if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); err != nil {
		return []RewindPoint{}, nil
	}
	if !s.shadowRefExists(ctx, env, ref) {
		return []RewindPoint{}, nil
	}
	args := []string{"log"}
	if limit > 0 {
		args = append(args, "-n", strconv.Itoa(limit))
	}
	args = append(args, ref, "--format=%H"+shadowFieldSep+"%h"+shadowFieldSep+"%ct"+shadowFieldSep+"%s"+shadowFieldSep+"%b"+shadowRecordSep)
	out, errOut, err := s.runEnv(ctx, workdir, env, args...)
	if err != nil {
		return nil, fmt.Errorf("shadow log: %s", strings.TrimSpace(errOut))
	}
	var points []RewindPoint
	for _, rec := range strings.Split(out, shadowRecordSep) {
		rec = strings.Trim(rec, "\n")
		if rec == "" {
			continue
		}
		f := strings.Split(rec, shadowFieldSep)
		if len(f) < 5 {
			continue
		}
		ts, _ := strconv.ParseInt(strings.TrimSpace(f[2]), 10, 64)
		body := f[4]
		points = append(points, RewindPoint{
			Hash:      f[0],
			ShortHash: f[1],
			Ts:        ts,
			Subject:   f[3],
			Body:      body,
			Prompt:    extractPromptFromBody(body),
			Session:   extractTrailer(body, "Session"),
		})
	}
	return points, nil
}

// ShadowShow returns the message + changed files for one rewind point.
func (s *Service) ShadowShow(ctx context.Context, gitDir, workdir, hash string) (ShadowShowResult, error) {
	env := shadowEnv(gitDir, workdir)
	msg, _, _ := s.runEnv(ctx, workdir, env, "show", "-s", "--format=%B", hash)
	out, errOut, err := s.runEnv(ctx, workdir, env, "show", "--name-status", "--format=", hash)
	if err != nil {
		return ShadowShowResult{}, fmt.Errorf("shadow show: %s", strings.TrimSpace(errOut))
	}
	res := ShadowShowResult{Hash: hash, Message: strings.TrimRight(msg, "\n")}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			res.Files = append(res.Files, ShadowFileChange{Status: parts[0], Path: strings.Join(parts[1:], " ")})
		}
	}
	return res, nil
}

// ShadowDiff returns the unified diff a rewind point introduced for one path
// (or the whole point when path is empty).
func (s *Service) ShadowDiff(ctx context.Context, gitDir, workdir, hash, path string) (string, error) {
	env := shadowEnv(gitDir, workdir)
	args := []string{"show", "--format=", hash}
	if path != "" {
		args = append(args, "--", path)
	}
	out, errOut, err := s.runEnv(ctx, workdir, env, args...)
	if err != nil {
		return "", fmt.Errorf("shadow diff: %s", strings.TrimSpace(errOut))
	}
	return out, nil
}

// ShadowCommitDetail returns a rewind point's full message plus per-file old/new
// content (capped at 50 files), shaped like git.ShowCommit so the frontend can
// reuse the real-commit side-by-side diff modal. Old content comes from the
// commit's parent; a missing parent blob (added file / root commit) yields "".
func (s *Service) ShadowCommitDetail(ctx context.Context, gitDir, workdir, hash string) (ShadowCommitDetail, error) {
	env := shadowEnv(gitDir, workdir)
	msg, _, _ := s.runEnv(ctx, workdir, env, "show", "-s", "--format=%B", hash)
	names, errOut, err := s.runEnv(ctx, workdir, env, "-c", "core.quotepath=false", "show", "--name-only", "--format=", hash)
	if err != nil {
		return ShadowCommitDetail{}, fmt.Errorf("shadow detail: %s", strings.TrimSpace(errOut))
	}
	paths := nonEmptyLines(names)
	if len(paths) > 50 {
		paths = paths[:50]
	}
	files := make([]FileVersion, 0, len(paths))
	for _, p := range paths {
		// `git show <rev>:<path>` errors for a path absent at that rev (added or
		// deleted); treat that as empty rather than failing the whole request.
		old, _, oerr := s.runEnv(ctx, workdir, env, "show", hash+"^:"+p)
		if oerr != nil {
			old = ""
		}
		newer, _, nerr := s.runEnv(ctx, workdir, env, "show", hash+":"+p)
		if nerr != nil {
			newer = ""
		}
		files = append(files, FileVersion{Path: p, OldContent: old, NewContent: newer})
	}
	return ShadowCommitDetail{Hash: hash, Message: strings.TrimRight(msg, "\n"), Files: files}, nil
}

// ── restore ──────────────────────────────────────────────────────────────────

// ShadowRestorePreview returns the diff a restore to `hash` WOULD produce
// (current working tree → target). It stages the current working tree into the
// shadow index (a benign internal mutation — no commit, no ref move, no working
// tree change) and diffs it against the target, reversed so the patch reads as
// the change restore will apply.
func (s *Service) ShadowRestorePreview(ctx context.Context, gitDir, workdir, branch, hash string) (ShadowPreview, error) {
	unlock := shadowLock(gitDir)
	defer unlock()
	if err := s.ensureShadowRepo(ctx, gitDir, workdir); err != nil {
		return ShadowPreview{}, err
	}
	env := shadowEnv(gitDir, workdir)
	_, _, _ = s.runEnv(ctx, workdir, env, "symbolic-ref", "HEAD", shadowRef(branch))
	// Make the index reflect the current working tree (does NOT touch files).
	if _, eo, e := s.runEnv(ctx, workdir, env, "add", "-A"); e != nil {
		return ShadowPreview{}, fmt.Errorf("add: %s", strings.TrimSpace(eo))
	}
	ns, _, _ := s.runEnv(ctx, workdir, env, "-c", "core.quotepath=false", "diff", "--cached", "--name-status", "-R", hash)
	patch, eo, err := s.runEnv(ctx, workdir, env, "-c", "core.quotepath=false", "diff", "--cached", "-R", hash)
	if err != nil {
		return ShadowPreview{}, fmt.Errorf("diff: %s", strings.TrimSpace(eo))
	}
	res := ShadowPreview{Hash: hash, Diff: patch}
	for _, line := range strings.Split(ns, "\n") {
		if line = strings.TrimSpace(line); line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			res.Files = append(res.Files, ShadowFileChange{Status: parts[0], Path: strings.Join(parts[1:], " ")})
		}
	}
	return res, nil
}

// ShadowRestore makes the project's tracked working tree match `hash`, as a
// FORWARD move so the action is itself reversible:
//  1. snapshot the current state → a visible "before rewind" point (BeforeHash);
//  2. update the working tree+index to `hash` WITHOUT moving the branch
//     (`read-tree -u --reset`, which leaves ignored files like node_modules alone);
//  3. commit the restored state as a NEW point on the branch (NewHash).
//
// The timeline stays linear and complete, so "going back" is just restoring
// BeforeHash. This is the ONLY shadow op that writes the working tree.
func (s *Service) ShadowRestore(ctx context.Context, gitDir, workdir, branch, hash string) (ShadowRestoreResult, error) {
	unlock := shadowLock(gitDir)
	defer unlock()

	if err := s.ensureShadowRepo(ctx, gitDir, workdir); err != nil {
		return ShadowRestoreResult{}, err
	}
	env := shadowEnv(gitDir, workdir)
	ref := shadowRef(branch)
	short := hash
	if len(short) > 7 {
		short = short[:7]
	}

	// 1. Snapshot the current state so it remains a visible/restorable point.
	beforeHash, _, err := s.shadowSnapshotLocked(ctx, gitDir, workdir, branch, "Before rewind to "+short, "claude")
	if err != nil {
		return ShadowRestoreResult{}, fmt.Errorf("safety snapshot: %w", err)
	}
	if beforeHash == "" { // nothing changed → current tip already represents "before"
		if t, _, e := s.runEnv(ctx, workdir, env, "rev-parse", "--verify", "--quiet", ref); e == nil {
			beforeHash = strings.TrimSpace(t)
		}
	}

	// 2. Restore the working tree+index to `hash` without moving the branch.
	if _, eo, e := s.runEnv(ctx, workdir, env, "read-tree", "-u", "--reset", hash); e != nil {
		return ShadowRestoreResult{}, fmt.Errorf("read-tree: %s", strings.TrimSpace(eo))
	}

	// 3. Commit the restored state as a new forward point.
	msg := fmt.Sprintf("Rewind to %s\n\nReal-Branch: %s", short, branch)
	out, errOut, e := s.runStdinEnv(ctx, workdir, env,
		msg, "-c", "user.email=claude@shadow", "-c", "user.name=claude", "commit", "-F", "-")
	newHash := beforeHash
	if e != nil {
		if o := out + errOut; !strings.Contains(o, "nothing to commit") {
			return ShadowRestoreResult{}, fmt.Errorf("commit: %s", strings.TrimSpace(o))
		}
		// Identical to the pre-restore state → no-op restore.
	} else {
		h, _, _ := s.runEnv(ctx, workdir, env, "rev-parse", "HEAD")
		newHash = strings.TrimSpace(h)
	}
	return ShadowRestoreResult{OK: true, RestoredFrom: hash, NewHash: newHash, BeforeHash: beforeHash}, nil
}

// ── body parsing ─────────────────────────────────────────────────────────────

// extractTrailer pulls a "Key: value" trailer line out of a commit body.
func extractTrailer(body, key string) string {
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, key+":") {
			return strings.TrimSpace(strings.TrimPrefix(line, key+":"))
		}
	}
	return ""
}

// extractPromptFromBody returns the text under a "Prompt:"/"Prompts:" label,
// stopping at the "Response:" section or the trailing Key: trailers. Best-effort
// snippet for the rewind list.
func extractPromptFromBody(body string) string {
	lines := strings.Split(body, "\n")
	var out []string
	capturing := false
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if !capturing {
			if t == "Prompt:" || t == "Prompts:" {
				capturing = true
			}
			continue
		}
		if t == "Response:" || isTrailerLine(t) {
			break
		}
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func isTrailerLine(t string) bool {
	for _, k := range []string{"Turn-Ts:", "Session:", "Real-Branch:"} {
		if strings.HasPrefix(t, k) {
			return true
		}
	}
	return false
}
