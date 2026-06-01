package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	gogit "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// open opens the repository whose working tree contains dir, walking up to find
// the .git directory (matching `git rev-parse --is-inside-work-tree`).
func (s *Service) open(dir string) (*gogit.Repository, error) {
	return gogit.PlainOpenWithOptions(dir, &gogit.PlainOpenOptions{DetectDotGit: true})
}

// IsRepo reports whether cwd is inside a git work tree. Uses go-git's directory
// walk, equivalent to `git rev-parse --is-inside-work-tree`.
func (s *Service) IsRepo(cwd string) bool {
	_, err := s.open(cwd)
	return err == nil
}

// Init initialises a repository at cwd (go-git) and writes DefaultGitignore if
// no .gitignore already exists. Mirrors git_init.
func (s *Service) Init(ctx context.Context, cwd string) CommandResult {
	if _, err := gogit.PlainInit(cwd, false); err != nil {
		// Already-a-repo is not an error for the caller's purposes, but match the
		// Python contract: report ok=false with the message on failure.
		if err == gogit.ErrRepositoryAlreadyExists {
			s.writeGitignore(cwd)
			return CommandResult{OK: true, Output: "Reinitialized existing Git repository"}
		}
		return CommandResult{OK: false, Output: err.Error()}
	}
	s.writeGitignore(cwd)
	return CommandResult{OK: true, Output: "Initialized empty Git repository"}
}

func (s *Service) writeGitignore(cwd string) {
	p := filepath.Join(cwd, ".gitignore")
	if _, err := os.Stat(p); err == nil {
		return // already exists
	}
	if err := os.WriteFile(p, []byte(DefaultGitignore), 0o644); err != nil {
		s.logger().Warn("write .gitignore failed", "path", p, "err", err)
	}
}

// CurrentBranch returns the current branch name, or "" if detached or on error.
// Mirrors git_current_branch (which maps "HEAD" -> "").
func (s *Service) CurrentBranch(cwd string) string {
	repo, err := s.open(cwd)
	if err != nil {
		return ""
	}
	head, err := repo.Head()
	if err != nil {
		return ""
	}
	if head.Name().IsBranch() {
		return head.Name().Short()
	}
	return "" // detached HEAD
}

// GetRemote returns the URL of the 'origin' remote, or "" if unset.
func (s *Service) GetRemote(cwd string) string {
	repo, err := s.open(cwd)
	if err != nil {
		return ""
	}
	rem, err := repo.Remote("origin")
	if err != nil {
		return ""
	}
	urls := rem.Config().URLs
	if len(urls) == 0 {
		return ""
	}
	return urls[0]
}

// SetRemote sets or replaces the 'origin' remote URL. An empty url removes it.
// Mirrors git_set_remote.
func (s *Service) SetRemote(cwd, url string) CommandResult {
	repo, err := s.open(cwd)
	if err != nil {
		return CommandResult{OK: false, Output: err.Error()}
	}
	// Remove existing origin if present (ignore "not found").
	_ = repo.DeleteRemote("origin")
	if strings.TrimSpace(url) == "" {
		return CommandResult{OK: true, Output: "Remote removed."}
	}
	if _, err := repo.CreateRemote(&config.RemoteConfig{Name: "origin", URLs: []string{url}}); err != nil {
		return CommandResult{OK: false, Output: err.Error()}
	}
	return CommandResult{OK: true, Output: ""}
}

// Log returns the last n commits reachable from HEAD. Mirrors git_log.
func (s *Service) Log(cwd string, n int) []Commit {
	repo, err := s.open(cwd)
	if err != nil {
		return nil
	}
	iter, err := repo.Log(&gogit.LogOptions{})
	if err != nil {
		return nil
	}
	defer iter.Close()
	out := make([]Commit, 0, n)
	for len(out) < n {
		c, err := iter.Next()
		if err != nil {
			break
		}
		out = append(out, commitFromObject(c))
	}
	return out
}

// FileLog returns up to n commits touching relPath. go-git's Log with a
// PathFilter approximates `git log --follow` (it does not follow renames; see
// the package notes). Mirrors git_file_log.
func (s *Service) FileLog(cwd, relPath string, n int) []Commit {
	repo, err := s.open(cwd)
	if err != nil {
		return nil
	}
	clean := filepath.ToSlash(relPath)
	iter, err := repo.Log(&gogit.LogOptions{
		PathFilter: func(p string) bool { return p == clean },
	})
	if err != nil {
		return nil
	}
	defer iter.Close()
	out := make([]Commit, 0, n)
	for len(out) < n {
		c, err := iter.Next()
		if err != nil {
			break
		}
		out = append(out, commitFromObject(c))
	}
	return out
}

// FileShow returns the content of relPath at commitHash, or "" if not found.
// Mirrors git_file_show / git_file_at_commit (binary -> "(binary file)" for
// FileAtCommit, "" here to match git_file_show's plain text behaviour).
func (s *Service) FileShow(cwd, relPath, commitHash string) string {
	content, ok := s.fileAt(cwd, commitHash, relPath)
	if !ok {
		return ""
	}
	return content
}

// FileAtCommit returns the content of filepath at commitHash. Binary files come
// back as "(binary file)" and missing files as "". Mirrors git_file_at_commit.
func (s *Service) FileAtCommit(cwd, commitHash, file string) string {
	content, ok := s.fileAt(cwd, commitHash, file)
	if !ok {
		return ""
	}
	return content
}

// fileAt is the shared reader: returns (content, found). Binary -> "(binary file)".
func (s *Service) fileAt(cwd, ref, file string) (string, bool) {
	repo, err := s.open(cwd)
	if err != nil {
		return "", false
	}
	hash, err := repo.ResolveRevision(plumbing.Revision(ref))
	if err != nil {
		return "", false
	}
	commit, err := repo.CommitObject(*hash)
	if err != nil {
		return "", false
	}
	f, err := commit.File(filepath.ToSlash(file))
	if err != nil {
		return "", false
	}
	isBin, err := f.IsBinary()
	if err == nil && isBin {
		return "(binary file)", true
	}
	content, err := f.Contents()
	if err != nil {
		return "", false
	}
	return content, true
}

// CommitFullMessage returns the full message (subject+body) of commitHash.
func (s *Service) CommitFullMessage(cwd, commitHash string) string {
	repo, err := s.open(cwd)
	if err != nil {
		return ""
	}
	hash, err := repo.ResolveRevision(plumbing.Revision(commitHash))
	if err != nil {
		return ""
	}
	commit, err := repo.CommitObject(*hash)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(commit.Message)
}

// commitFromObject maps a go-git commit to our Commit shape. Date uses the same
// ISO format git's %ai produces ("2006-01-02 15:04:05 -0700").
func commitFromObject(c *object.Commit) Commit {
	return Commit{
		Hash:      c.Hash.String(),
		ShortHash: c.Hash.String()[:7],
		Subject:   firstLine(c.Message),
		Author:    c.Author.Name,
		Date:      c.Author.When.Format("2006-01-02 15:04:05 -0700"),
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}
