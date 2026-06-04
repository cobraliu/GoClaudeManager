package api

// HTTP surface for the shadow-git rewind system (see internal/git/shadow.go and
// internal/app/shadowbackup.go). All endpoints are session-scoped (RequireUser +
// resolveOwned) and operate on the session's cwd → its per-project shadow repo
// under the data dir. The real working-dir .git is never touched except by an
// explicit, confirmed restore.

import (
	"net/http"
	"path/filepath"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/git"
	"github.com/loki/goclaudemanager/internal/model"
)

// shadowRootDir mirrors app.shadowRoot (data dir layout): "<DataDir>/shadow" or
// the dev fallback "./data/shadow".
func shadowRootDir(d Deps) string {
	if d.Env.DataDir != "" {
		return filepath.Join(d.Env.DataDir, "shadow")
	}
	return filepath.Join("data", "shadow")
}

// shadowSession resolves the owned session and returns it plus the shadow gitDir
// and the resolved real branch (query "branch" overrides the current branch).
func shadowSession(d Deps, w http.ResponseWriter, r *http.Request) (*model.Session, string, string) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return nil, "", ""
	}
	if s.Cwd == "" {
		writeErr(w, http.StatusBadRequest, "session has no working directory")
		return nil, "", ""
	}
	gitDir := git.ShadowGitDir(shadowRootDir(d), s.Cwd)
	branch := r.URL.Query().Get("branch")
	if branch == "" {
		branch = d.Git.RealBranch(r.Context(), s.Cwd)
	}
	return s, gitDir, branch
}

// GET /{id}/shadow/log?branch=&limit=
func shadowLogHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	s, gitDir, branch := shadowSession(d, w, r)
	if s == nil {
		return
	}
	limit := queryInt(r, "limit", 200)
	if limit < 1 {
		limit = 1
	}
	if limit > 1000 {
		limit = 1000
	}
	points, err := d.Git.ShadowLog(r.Context(), gitDir, s.Cwd, branch, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if points == nil {
		points = []git.RewindPoint{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"branch": branch, "points": points})
}

// GET /{id}/shadow/show/{commit_hash}
func shadowShowHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	s, gitDir, _ := shadowSession(d, w, r)
	if s == nil {
		return
	}
	hash := chi.URLParam(r, "commit_hash")
	if !isAlnumHash(hash) {
		writeErr(w, http.StatusBadRequest, "invalid commit hash")
		return
	}
	res, err := d.Git.ShadowShow(r.Context(), gitDir, s.Cwd, hash)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// GET /{id}/shadow/commit/{commit_hash} — full message + per-file old/new content
// (shaped like the real-commit detail endpoint, for the same side-by-side modal).
func shadowCommitHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	s, gitDir, _ := shadowSession(d, w, r)
	if s == nil {
		return
	}
	hash := chi.URLParam(r, "commit_hash")
	if !isAlnumHash(hash) {
		writeErr(w, http.StatusBadRequest, "invalid commit hash")
		return
	}
	res, err := d.Git.ShadowCommitDetail(r.Context(), gitDir, s.Cwd, hash)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// GET /{id}/shadow/diff?hash=&path=
func shadowDiffHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	s, gitDir, _ := shadowSession(d, w, r)
	if s == nil {
		return
	}
	hash := r.URL.Query().Get("hash")
	if !isAlnumHash(hash) {
		writeErr(w, http.StatusBadRequest, "invalid commit hash")
		return
	}
	diff, err := d.Git.ShadowDiff(r.Context(), gitDir, s.Cwd, hash, r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"diff": diff, "hash": hash})
}

// GET /{id}/shadow/restore-preview?hash= — the diff a restore would produce.
func shadowRestorePreviewHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	s, gitDir, branch := shadowSession(d, w, r)
	if s == nil {
		return
	}
	hash := r.URL.Query().Get("hash")
	if !isAlnumHash(hash) {
		writeErr(w, http.StatusBadRequest, "invalid commit hash")
		return
	}
	res, err := d.Git.ShadowRestorePreview(r.Context(), gitDir, s.Cwd, branch, hash)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

type shadowRestoreBody struct {
	Hash string `json:"hash"`
}

// POST /{id}/shadow/restore {hash} — DESTRUCTIVE (overwrites the working tree to
// match the rewind point). A safety snapshot is taken first.
func shadowRestoreHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	s, gitDir, branch := shadowSession(d, w, r)
	if s == nil {
		return
	}
	var body shadowRestoreBody
	if !readJSON(w, r, &body) {
		return
	}
	if !isAlnumHash(body.Hash) {
		writeErr(w, http.StatusBadRequest, "invalid commit hash")
		return
	}
	res, err := d.Git.ShadowRestore(r.Context(), gitDir, s.Cwd, branch, body.Hash)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// POST /{id}/shadow/snapshot — take a rewind point now (manual).
func shadowSnapshotHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	s, gitDir, branch := shadowSession(d, w, r)
	if s == nil {
		return
	}
	who := "user"
	hash, committed, err := d.Git.ShadowSnapshot(r.Context(), gitDir, s.Cwd, branch,
		"Manual snapshot\n\nReal-Branch: "+branch, who)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"committed": committed, "hash": hash, "branch": branch})
}
