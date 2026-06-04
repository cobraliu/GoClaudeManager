package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/git"
	"github.com/loki/goclaudemanager/internal/model"
)

// registerGitRoutes wires the /{id}/git/* endpoints ported from the git section
// of app/api/sessions.py onto the sessions subrouter (already authenticated).
// All paths are relative to the sessions mount (/api/sessions).
func registerGitRoutes(r chi.Router, d Deps) {
	r.Get("/{id}/git", func(w http.ResponseWriter, r *http.Request) { gitInfo(d, w, r) })
	r.Get("/{id}/git/search", func(w http.ResponseWriter, r *http.Request) { gitSearch(d, w, r) })
	r.Get("/{id}/git/branches", func(w http.ResponseWriter, r *http.Request) { gitBranches(d, w, r) })
	r.Get("/{id}/git/graph", func(w http.ResponseWriter, r *http.Request) { gitGraph(d, w, r) })
	r.Get("/{id}/git/active-cwd-sessions", func(w http.ResponseWriter, r *http.Request) { gitActiveCwdSessions(d, w, r) })
	r.Post("/{id}/git/checkout", func(w http.ResponseWriter, r *http.Request) { gitCheckout(d, w, r) })
	r.Post("/{id}/git/init", func(w http.ResponseWriter, r *http.Request) { gitInitRepo(d, w, r) })
	r.Put("/{id}/git/gitignore", func(w http.ResponseWriter, r *http.Request) { gitUpdateGitignore(d, w, r) })
	r.Put("/{id}/git/remote", func(w http.ResponseWriter, r *http.Request) { gitSetRemote(d, w, r) })
	r.Post("/{id}/git/push", func(w http.ResponseWriter, r *http.Request) { gitPush(d, w, r) })
	r.Post("/{id}/git/pull", func(w http.ResponseWriter, r *http.Request) { gitPull(d, w, r) })

	r.Get("/{id}/git/merge/status", func(w http.ResponseWriter, r *http.Request) { gitMergeStatus(d, w, r) })
	r.Get("/{id}/git/merge/preview", func(w http.ResponseWriter, r *http.Request) { gitMergePreview(d, w, r) })
	r.Get("/{id}/git/merge/file-diff", func(w http.ResponseWriter, r *http.Request) { gitMergeFileDiff(d, w, r) })
	r.Post("/{id}/git/merge/start", func(w http.ResponseWriter, r *http.Request) { gitMergeStart(d, w, r) })
	r.Get("/{id}/git/merge/file", func(w http.ResponseWriter, r *http.Request) { gitMergeFile(d, w, r) })
	r.Post("/{id}/git/merge/resolve", func(w http.ResponseWriter, r *http.Request) { gitMergeResolve(d, w, r) })
	r.Post("/{id}/git/merge/continue", func(w http.ResponseWriter, r *http.Request) { gitMergeContinue(d, w, r) })
	r.Post("/{id}/git/merge/abort", func(w http.ResponseWriter, r *http.Request) { gitMergeAbort(d, w, r) })

	r.Post("/{id}/git/commit", func(w http.ResponseWriter, r *http.Request) { gitCommit(d, w, r) })
	r.Post("/{id}/git/rollback", func(w http.ResponseWriter, r *http.Request) { gitRollback(d, w, r) })
	r.Get("/{id}/git/show/{commit_hash}", func(w http.ResponseWriter, r *http.Request) { gitShow(d, w, r) })
	r.Get("/{id}/git/file-log", func(w http.ResponseWriter, r *http.Request) { gitFileLog(d, w, r) })
	r.Get("/{id}/git/file-show", func(w http.ResponseWriter, r *http.Request) { gitFileShow(d, w, r) })
	r.Get("/{id}/git/file-diff", func(w http.ResponseWriter, r *http.Request) { gitFileDiff(d, w, r) })
	r.Post("/{id}/git/diff", func(w http.ResponseWriter, r *http.Request) { gitDiff(d, w, r) })

	// Shadow-git rewind system (independent of the real .git) — shadow_routes.go.
	r.Get("/{id}/shadow/log", func(w http.ResponseWriter, r *http.Request) { shadowLogHandler(d, w, r) })
	r.Get("/{id}/shadow/show/{commit_hash}", func(w http.ResponseWriter, r *http.Request) { shadowShowHandler(d, w, r) })
	r.Get("/{id}/shadow/commit/{commit_hash}", func(w http.ResponseWriter, r *http.Request) { shadowCommitHandler(d, w, r) })
	r.Get("/{id}/shadow/diff", func(w http.ResponseWriter, r *http.Request) { shadowDiffHandler(d, w, r) })
	r.Get("/{id}/shadow/restore-preview", func(w http.ResponseWriter, r *http.Request) { shadowRestorePreviewHandler(d, w, r) })
	r.Post("/{id}/shadow/restore", func(w http.ResponseWriter, r *http.Request) { shadowRestoreHandler(d, w, r) })
	r.Post("/{id}/shadow/snapshot", func(w http.ResponseWriter, r *http.Request) { shadowSnapshotHandler(d, w, r) })
}

// gitRequireRepo resolves the owned session and ensures cwd is a git repo,
// mirroring _require_session_repo: 404 if not owned, 400 if not a repo. Returns
// nil after writing the response on failure.
func gitRequireRepo(d Deps, w http.ResponseWriter, r *http.Request) *model.Session {
	s := resolveOwned(d, w, r)
	if s == nil {
		return nil
	}
	if !d.Git.IsRepo(s.Cwd) {
		writeErr(w, http.StatusBadRequest, "not a git repo")
		return nil
	}
	return s
}

// ── GET /{id}/git ────────────────────────────────────────────────────────────

func gitInfo(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if !d.Git.IsRepo(s.Cwd) {
		d.Git.Init(r.Context(), s.Cwd)
	}
	allLog := nonNilCommits(d.Git.Log(s.Cwd, 10000))
	gitignore := ""
	if b, err := os.ReadFile(filepath.Join(s.Cwd, ".gitignore")); err == nil {
		gitignore = string(b)
	}
	remote := d.Git.GetRemote(s.Cwd)
	writeJSON(w, http.StatusOK, map[string]any{
		"is_repo":   true,
		"log":       allLog,
		"gitignore": gitignore,
		"remote":    remote,
	})
}

// ── GET /{id}/git/search ─────────────────────────────────────────────────────

func gitSearch(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || !d.Git.IsRepo(s.Cwd) {
		writeJSON(w, http.StatusOK, []git.CommitSearchResult{})
		return
	}
	res := d.Git.SearchCommits(r.Context(), s.Cwd, q, 500)
	if res == nil {
		res = []git.CommitSearchResult{}
	}
	writeJSON(w, http.StatusOK, res)
}

// ── GET /{id}/git/branches ───────────────────────────────────────────────────

func gitBranches(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if !d.Git.IsRepo(s.Cwd) {
		writeJSON(w, http.StatusOK, map[string]any{"current": "", "local": []string{}})
		return
	}
	info := d.Git.ListBranches(r.Context(), s.Cwd)
	dirty := d.Git.IsDirty(r.Context(), s.Cwd)
	// Match Python: returns git_list_branches(...) dict with an added "dirty"
	// key. We marshal the struct fields plus dirty.
	writeJSON(w, http.StatusOK, map[string]any{
		"current":          info.Current,
		"local":            nonNilStr(info.Local),
		"local_with_dates": nonNilBranchTS(info.LocalWithDates),
		"remote_only":      nonNilStr(info.RemoteOnly),
		"dirty":            dirty,
	})
}

// ── GET /{id}/git/graph ──────────────────────────────────────────────────────

func gitGraph(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if !d.Git.IsRepo(s.Cwd) {
		writeJSON(w, http.StatusOK, []git.GraphCommit{})
		return
	}
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "current"
	}
	n := queryInt(r, "n", 500)
	if n < 1 {
		n = 1
	}
	if n > 5000 {
		n = 5000
	}
	res := d.Git.GraphLog(r.Context(), s.Cwd, scope, n)
	if res == nil {
		res = []git.GraphCommit{}
	}
	writeJSON(w, http.StatusOK, res)
}

// ── GET /{id}/git/active-cwd-sessions ────────────────────────────────────────

func gitActiveCwdSessions(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	who := auth.FromContext(r.Context())
	sessions, err := d.Store.ListForOwner(who.Username)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	targetCwd := realpath(s.Cwd)
	active := []map[string]any{}
	for _, o := range sessions {
		if o.ID == s.ID {
			continue
		}
		if o.Status != model.StatusRunning && o.Status != model.StatusDetached {
			continue
		}
		if realpath(o.Cwd) != targetCwd {
			continue
		}
		var lastAct any
		if o.LastActivityAt != nil {
			lastAct = o.LastActivityAt.String()
		}
		active = append(active, map[string]any{
			"id":               o.ID,
			"name":             o.Name,
			"status":           o.Status,
			"tool":             o.Tool,
			"last_activity_at": lastAct,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": active})
}

// ── POST /{id}/git/checkout ──────────────────────────────────────────────────

type gitCheckoutBody struct {
	Branch string `json:"branch"`
	Stash  bool   `json:"stash"`
	Remote bool   `json:"remote"`
}

func gitCheckout(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body gitCheckoutBody
	if !readJSON(w, r, &body) {
		return
	}
	if !d.Git.IsRepo(s.Cwd) {
		writeErr(w, http.StatusBadRequest, "not a git repo")
		return
	}
	var result git.CheckoutResult
	if body.Remote {
		result = d.Git.CheckoutRemoteBranch(r.Context(), s.Cwd, body.Branch, body.Stash)
	} else {
		result = d.Git.CheckoutBranch(r.Context(), s.Cwd, body.Branch, body.Stash)
	}
	if !result.OK {
		if result.Conflict {
			writeJSON(w, http.StatusConflict, map[string]any{
				"detail": map[string]any{
					"code":              "conflict",
					"message":           "local changes would be overwritten by checkout; commit or stash them first",
					"conflicting_files": nonNilStr(result.ConflictingFiles),
				},
			})
			return
		}
		writeErr(w, http.StatusBadRequest, result.Output)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"branch":  body.Branch,
		"output":  result.Output,
		"stashed": result.Stashed,
	})
}

// ── POST /{id}/git/init ──────────────────────────────────────────────────────

func gitInitRepo(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	result := d.Git.Init(r.Context(), s.Cwd)
	if !result.OK {
		writeErr(w, http.StatusInternalServerError, result.Output)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// ── PUT /{id}/git/gitignore ──────────────────────────────────────────────────

type gitignoreBody struct {
	Content string `json:"content"`
}

func gitUpdateGitignore(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body gitignoreBody
	if !readJSON(w, r, &body) {
		return
	}
	if err := os.WriteFile(filepath.Join(s.Cwd, ".gitignore"), []byte(body.Content), 0o644); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── PUT /{id}/git/remote ─────────────────────────────────────────────────────

type gitRemoteBody struct {
	URL string `json:"url"`
}

func gitSetRemote(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body gitRemoteBody
	if !readJSON(w, r, &body) {
		return
	}
	url := strings.TrimSpace(body.URL)
	result := d.Git.SetRemote(s.Cwd, url)
	if !result.OK {
		writeErr(w, http.StatusInternalServerError, result.Output)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "remote": url})
}

// ── POST /{id}/git/push ──────────────────────────────────────────────────────

func gitPush(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if d.Git.GetRemote(s.Cwd) == "" {
		writeErr(w, http.StatusBadRequest, "no remote configured")
		return
	}
	result := d.Git.Push(r.Context(), s.Cwd)
	if !result.OK {
		writeErr(w, http.StatusInternalServerError, result.Output)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": result.Output})
}

// ── POST /{id}/git/pull ──────────────────────────────────────────────────────

func gitPull(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	result := d.Git.Pull(r.Context(), s.Cwd)
	if !result.OK {
		writeErr(w, http.StatusBadRequest, result.Output)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": result.Output})
}

// ── Merge endpoints ──────────────────────────────────────────────────────────

func gitMergeStatus(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	writeJSON(w, http.StatusOK, d.Git.MergeStatus(r.Context(), s.Cwd))
}

func gitMergePreview(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	source := r.URL.Query().Get("source")
	target := r.URL.Query().Get("target")
	writeJSON(w, http.StatusOK, d.Git.MergePreview(r.Context(), s.Cwd, source, target))
}

func gitMergeFileDiff(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	source := r.URL.Query().Get("source")
	target := r.URL.Query().Get("target")
	path := r.URL.Query().Get("path")
	writeJSON(w, http.StatusOK, d.Git.MergeFileDiff(r.Context(), s.Cwd, source, target, path))
}

type gitMergeStartBody struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

func gitMergeStart(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	var body gitMergeStartBody
	if !readJSON(w, r, &body) {
		return
	}
	result := d.Git.MergeStart(r.Context(), s.Cwd, body.Source, body.Target)
	if !result.OK {
		writeErr(w, http.StatusBadRequest, result.Output)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func gitMergeFile(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	if !fileExists(filepath.Join(s.Cwd, ".git", "MERGE_HEAD")) {
		writeErr(w, http.StatusBadRequest, "no merge in progress")
		return
	}
	path := r.URL.Query().Get("path")
	writeJSON(w, http.StatusOK, d.Git.ConflictFileVersions(r.Context(), s.Cwd, path))
}

type gitResolveBody struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func gitMergeResolve(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	if !fileExists(filepath.Join(s.Cwd, ".git", "MERGE_HEAD")) {
		writeErr(w, http.StatusBadRequest, "no merge in progress")
		return
	}
	var body gitResolveBody
	if !readJSON(w, r, &body) {
		return
	}
	result := d.Git.ResolveFile(r.Context(), s.Cwd, body.Path, body.Content)
	if !result.OK {
		writeErr(w, http.StatusBadRequest, result.Output)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": d.Git.MergeStatus(r.Context(), s.Cwd)})
}

type gitMergeContinueBody struct {
	Message *string `json:"message"`
}

func gitMergeContinue(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	var body gitMergeContinueBody
	if !readJSON(w, r, &body) {
		return
	}
	msg := ""
	if body.Message != nil {
		msg = *body.Message
	}
	result := d.Git.MergeContinue(r.Context(), s.Cwd, msg)
	if !result.OK {
		writeErr(w, http.StatusBadRequest, result.Output)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": result.Output})
}

func gitMergeAbort(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	result := d.Git.MergeAbort(r.Context(), s.Cwd)
	if !result.OK {
		writeErr(w, http.StatusBadRequest, result.Output)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": result.Output})
}

// ── POST /{id}/git/commit ────────────────────────────────────────────────────

type gitCommitBody struct {
	Message *string `json:"message"`
}

// gitCommit commits the real working tree. The message (subject + optional body)
// is now always user-supplied — there is no auto-generation. An empty message is
// rejected so a commit is never made with a placeholder subject.
func gitCommit(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body gitCommitBody
	if !readJSON(w, r, &body) {
		return
	}
	if !d.Git.IsRepo(s.Cwd) {
		writeErr(w, http.StatusBadRequest, "not a git repo")
		return
	}
	msg := ""
	if body.Message != nil {
		msg = strings.TrimSpace(*body.Message)
	}
	if msg == "" {
		writeErr(w, http.StatusBadRequest, "commit message required")
		return
	}
	who := auth.FromContext(r.Context())
	result := d.Git.AddCommit(r.Context(), s.Cwd, msg, who.Username)
	if !result.OK {
		writeErr(w, http.StatusInternalServerError, result.Output)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// ── POST /{id}/git/rollback ──────────────────────────────────────────────────

type gitRollbackBody struct {
	CommitHash string `json:"commit_hash"`
}

func gitRollback(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	var body gitRollbackBody
	if !readJSON(w, r, &body) {
		return
	}
	who := auth.FromContext(r.Context())
	result := d.Git.Rollback(r.Context(), s.Cwd, body.CommitHash, who.Username)
	if !result.OK {
		writeErr(w, http.StatusInternalServerError, result.Output)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// ── GET /{id}/git/show/{commit_hash} ─────────────────────────────────────────

func gitShow(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	commitHash := chi.URLParam(r, "commit_hash")
	writeJSON(w, http.StatusOK, d.Git.ShowCommit(r.Context(), s.Cwd, commitHash))
}

// ── GET /{id}/git/file-log ───────────────────────────────────────────────────

func gitFileLog(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")
	n := queryInt(r, "n", 50)
	if n < 1 {
		n = 1
	}
	if n > 200 {
		n = 200
	}
	writeJSON(w, http.StatusOK, nonNilCommits(d.Git.FileLog(s.Cwd, path, n)))
}

// ── GET /{id}/git/file-show ──────────────────────────────────────────────────

func gitFileShow(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")
	commit := r.URL.Query().Get("commit")
	if !isAlnumHash(commit) {
		writeErr(w, http.StatusBadRequest, "invalid commit hash")
		return
	}
	content := d.Git.FileShow(s.Cwd, path, commit)
	writeJSON(w, http.StatusOK, map[string]any{"content": content, "commit": commit, "path": path})
}

// ── GET /{id}/git/file-diff ──────────────────────────────────────────────────

func gitFileDiff(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")
	commit := r.URL.Query().Get("commit")
	if !isAlnumHash(commit) {
		writeErr(w, http.StatusBadRequest, "invalid commit hash")
		return
	}
	diff := d.Git.FileDiffAtCommit(r.Context(), s.Cwd, path, commit)
	writeJSON(w, http.StatusOK, map[string]any{"diff": diff, "commit": commit, "path": path})
}

// ── POST /{id}/git/diff ──────────────────────────────────────────────────────

type gitDiffBody struct {
	OldHash string `json:"old_hash"`
	NewHash string `json:"new_hash"`
}

func gitDiff(d Deps, w http.ResponseWriter, r *http.Request) {
	s := gitRequireRepo(d, w, r)
	if s == nil {
		return
	}
	var body gitDiffBody
	if !readJSON(w, r, &body) {
		return
	}
	changed := d.Git.DiffFiles(r.Context(), s.Cwd, body.OldHash, body.NewHash)
	files := []map[string]any{}
	for i, path := range changed {
		if i >= 50 { // cap at 50 files
			break
		}
		oldContent := d.Git.FileAtCommit(s.Cwd, body.OldHash, path)
		newContent := d.Git.FileAtCommit(s.Cwd, body.NewHash, path)
		files = append(files, map[string]any{
			"path":        path,
			"old_content": oldContent,
			"new_content": newContent,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"files":    files,
		"old_hash": body.OldHash,
		"new_hash": body.NewHash,
	})
}

// ── local helpers ────────────────────────────────────────────────────────────

// isAlnumHash mirrors Python's commit.replace("-", "").isalnum() validation.
func isAlnumHash(commit string) bool {
	stripped := strings.ReplaceAll(commit, "-", "")
	if stripped == "" {
		return false
	}
	for _, c := range stripped {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			return false
		}
	}
	return true
}

func realpath(p string) string {
	if rp, err := filepath.EvalSymlinks(p); err == nil {
		return rp
	}
	return filepath.Clean(p)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func nonNilCommits(c []git.Commit) []git.Commit {
	if c == nil {
		return []git.Commit{}
	}
	return c
}

func nonNilStr(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func nonNilBranchTS(b []git.BranchWithTS) []git.BranchWithTS {
	if b == nil {
		return []git.BranchWithTS{}
	}
	return b
}
