package api

// Worktree endpoints: list / create / merge-back / remove linked git worktrees,
// so parallel agents can each work on their own branch and directory.
//
// Scope: the session's cwd when it is a repository root, plus the
// repositories found in its subdirectories (see git.FindRepos). A repository
// in a PARENT of cwd is never used — a plain project folder under a workspace dir
// that happens to be a git repo must not manage (or check out) that whole repo.
// Mutating endpoints name the repository via "repo" (any worktree path of it);
// it must be in that scope. Sessions are matched to worktrees by cwd.

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/git"
	"github.com/loki/goclaudemanager/internal/model"
)

func registerWorktreeRoutes(r chi.Router, d Deps) {
	r.Get("/{id}/git/worktrees", func(w http.ResponseWriter, r *http.Request) { listWorktrees(d, w, r) })
	r.Post("/{id}/git/worktrees", func(w http.ResponseWriter, r *http.Request) { addWorktree(d, w, r) })
	r.Post("/{id}/git/worktrees/merge", func(w http.ResponseWriter, r *http.Request) { mergeWorktree(d, w, r) })
	r.Post("/{id}/git/worktrees/remove", func(w http.ResponseWriter, r *http.Request) { removeWorktree(d, w, r) })
}

type worktreeSession struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Project string `json:"project"`
	Status  string `json:"status"`
	Tool    string `json:"tool"`
}

type worktreeView struct {
	git.Worktree
	IsCurrent bool              `json:"is_current"`
	Sessions  []worktreeSession `json:"sessions"`
}

type repoView struct {
	// Rel is the found repository root relative to the session's cwd: "" for
	// cwd itself, else e.g. "group/r2".
	Rel       string         `json:"rel"`
	Root      string         `json:"root"`
	MainPath  string         `json:"main_path"`
	Base      string         `json:"base"`
	Worktrees []worktreeView `json:"worktrees"`
}

// sessionsByRoot maps the (resolved) work-tree root of each of the owner's
// live sessions to those sessions. Keying by the session's own root means a
// session belongs to a worktree when it runs at its root or in a subdirectory,
// but never when it sits in a separate repository nested inside it.
func sessionsByRoot(ctx context.Context, d Deps, owner string) map[string][]worktreeSession {
	out := map[string][]worktreeSession{}
	sessions, err := d.Store.ListForOwner(owner)
	if err != nil {
		return out
	}
	for _, o := range sessions {
		if o.Status != model.StatusRunning && o.Status != model.StatusDetached {
			continue
		}
		if top := d.Git.Toplevel(ctx, o.Cwd); top != "" {
			k := git.RealPath(top)
			out[k] = append(out[k], worktreeSession{
				ID: o.ID, Name: o.Name, Project: o.Project, Status: string(o.Status), Tool: o.Tool,
			})
		}
	}
	return out
}

// repoLists lists the worktrees of each root (in parallel), dropping roots
// that resolve to an already-listed repository (e.g. two linked worktrees of
// the same repo both found by the scan).
type repoList struct {
	Root string // the scanned root that produced the list
	git.WorktreeList
}

func repoLists(ctx context.Context, d Deps, roots []string, withStatus bool) []repoList {
	lists := make([]git.WorktreeList, len(roots))
	ok := make([]bool, len(roots))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, root := range roots {
		wg.Add(1)
		go func(i int, root string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if l, err := d.Git.ListWorktrees(ctx, root, withStatus); err == nil {
				lists[i], ok[i] = l, true
			}
		}(i, root)
	}
	wg.Wait()
	seen := map[string]bool{}
	var out []repoList
	for i, l := range lists {
		if !ok[i] || seen[git.RealPath(l.MainPath)] {
			continue
		}
		seen[git.RealPath(l.MainPath)] = true
		out = append(out, repoList{Root: roots[i], WorktreeList: l})
	}
	return out
}

func listWorktrees(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	ctx := r.Context()
	roots := d.Git.FindRepos(ctx, s.Cwd)
	lists := repoLists(ctx, d, roots, true)
	who := auth.FromContext(ctx)
	byRoot := sessionsByRoot(ctx, d, who.Username)
	cur := ""
	if top := d.Git.Toplevel(ctx, s.Cwd); top != "" {
		cur = git.RealPath(top)
	}
	repos := make([]repoView, 0, len(lists))
	for _, l := range lists {
		rel, err := filepath.Rel(filepath.Clean(s.Cwd), l.Root)
		if err != nil || rel == "." {
			rel = ""
		}
		rv := repoView{Rel: rel, Root: l.Root, MainPath: l.MainPath, Base: l.Base, Worktrees: make([]worktreeView, 0, len(l.Worktrees))}
		for _, wt := range l.Worktrees {
			k := git.RealPath(wt.Path)
			ss := byRoot[k]
			if ss == nil {
				ss = []worktreeSession{}
			}
			rv.Worktrees = append(rv.Worktrees, worktreeView{Worktree: wt, IsCurrent: k == cur, Sessions: ss})
		}
		repos = append(repos, rv)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"repos": repos,
		// false when cwd is not itself a repository root (the repos were all
		// found in its subdirectories).
		"cwd_is_repo": len(roots) > 0 && filepath.Clean(roots[0]) == filepath.Clean(s.Cwd),
	})
}

// worktreeRepo resolves the owned session and the repository a mutating
// worktree request targets: body "repo" (any worktree path of it), or the
// cwd's own repository when cwd is a repository root. The repository must be
// in the session's scope (see the file comment). Returns the repo path to run
// git in.
func worktreeRepo(d Deps, w http.ResponseWriter, r *http.Request, repo string) (*model.Session, string) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return nil, ""
	}
	ctx := r.Context()
	roots := d.Git.FindRepos(ctx, s.Cwd)
	repo = strings.TrimSpace(repo)
	if repo == "" {
		if len(roots) > 0 && filepath.Clean(roots[0]) == filepath.Clean(s.Cwd) {
			return s, s.Cwd
		}
		writeErr(w, http.StatusBadRequest, "repo is required: this directory is not the root of a git repository")
		return nil, ""
	}
	target, err := d.Git.ListWorktrees(ctx, repo, false)
	if err != nil || target.FindWorktree(repo) == nil {
		writeErr(w, http.StatusBadRequest, "not a git repository root: "+repo)
		return nil, ""
	}
	for _, l := range repoLists(ctx, d, roots, false) {
		if git.RealPath(l.MainPath) == git.RealPath(target.MainPath) {
			return s, repo
		}
	}
	writeErr(w, http.StatusBadRequest, "repository "+target.MainPath+" is outside this session's directory")
	return nil, ""
}

type addWorktreeBody struct {
	Repo    string `json:"repo"`
	Branch  string `json:"branch"`
	Base    string `json:"base"`
	CopyEnv *bool  `json:"copy_env"`
}

func addWorktree(d Deps, w http.ResponseWriter, r *http.Request) {
	var body addWorktreeBody
	if !readJSON(w, r, &body) {
		return
	}
	s, repo := worktreeRepo(d, w, r, body.Repo)
	if s == nil {
		return
	}
	path, err := d.Git.AddWorktree(r.Context(), repo, git.AddWorktreeOpts{
		Branch: body.Branch, Base: body.Base, CopyEnv: body.CopyEnv == nil || *body.CopyEnv,
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"path": path, "branch": strings.TrimSpace(body.Branch)})
}

type worktreePathBody struct {
	Repo         string `json:"repo"`
	Path         string `json:"path"`
	Force        bool   `json:"force"`
	DeleteBranch bool   `json:"delete_branch"`
}

func mergeWorktree(d Deps, w http.ResponseWriter, r *http.Request) {
	var body worktreePathBody
	if !readJSON(w, r, &body) {
		return
	}
	s, repo := worktreeRepo(d, w, r, body.Repo)
	if s == nil {
		return
	}
	writeJSON(w, http.StatusOK, d.Git.MergeWorktreeIntoBase(r.Context(), repo, body.Path))
}

func removeWorktree(d Deps, w http.ResponseWriter, r *http.Request) {
	var body worktreePathBody
	if !readJSON(w, r, &body) {
		return
	}
	s, repo := worktreeRepo(d, w, r, body.Repo)
	if s == nil {
		return
	}
	list, err := d.Git.ListWorktrees(r.Context(), repo, false)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	wt := list.FindWorktree(body.Path)
	if wt == nil {
		writeErr(w, http.StatusBadRequest, "not a worktree of this repository")
		return
	}
	// Never pull a directory out from under a live agent: any live session
	// whose cwd is inside the worktree (its own root or a nested repo) blocks.
	who := auth.FromContext(r.Context())
	sessions, _ := d.Store.ListForOwner(who.Username)
	for _, o := range sessions {
		if o.Status != model.StatusRunning && o.Status != model.StatusDetached {
			continue
		}
		if p, c := git.RealPath(wt.Path), git.RealPath(o.Cwd); c == p || strings.HasPrefix(c, p+string(filepath.Separator)) {
			writeErr(w, http.StatusConflict, "worktree is in use by running session "+o.Name+"; stop it first")
			return
		}
	}
	if err := d.Git.RemoveWorktree(r.Context(), repo, wt.Path, body.Force, body.DeleteBranch); err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
