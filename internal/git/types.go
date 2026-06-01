package git

import (
	"io"
	"os"
	"strings"
)

// Commit is a single log entry. JSON tags match the Python service so the same
// frontend payloads work unchanged.
type Commit struct {
	Hash      string `json:"hash"`
	ShortHash string `json:"short_hash"`
	Subject   string `json:"subject"`
	Author    string `json:"author"`
	Date      string `json:"date"`
}

// CommitSearchResult is a log entry plus the first body line that matched the
// search query.
type CommitSearchResult struct {
	Hash      string `json:"hash"`
	ShortHash string `json:"short_hash"`
	Subject   string `json:"subject"`
	Author    string `json:"author"`
	Date      string `json:"date"`
	Context   string `json:"context"`
}

// GraphCommit is a commit shaped for client-side graph rendering.
type GraphCommit struct {
	Hash      string   `json:"hash"`
	ShortHash string   `json:"short_hash"`
	Parents   []string `json:"parents"`
	Subject   string   `json:"subject"`
	Author    string   `json:"author"`
	Date      string   `json:"date"`
	Refs      []string `json:"refs"`
}

// CommandResult mirrors the {"ok", "output"} dicts the Python service returns
// for write operations. Committed/UpToDate are populated only by the methods
// that need them.
type CommandResult struct {
	OK        bool   `json:"ok"`
	Output    string `json:"output"`
	Committed bool   `json:"committed,omitempty"`
	UpToDate  bool   `json:"up_to_date,omitempty"`
}

// CheckoutResult is returned by branch checkout. Conflict + ConflictingFiles
// surface git's "local changes would be overwritten" case.
type CheckoutResult struct {
	OK               bool     `json:"ok"`
	Output           string   `json:"output"`
	Conflict         bool     `json:"conflict"`
	ConflictingFiles []string `json:"conflicting_files,omitempty"`
	Stashed          bool     `json:"stashed,omitempty"`
}

// BranchInfo is the payload for the branch picker.
type BranchInfo struct {
	Current         string         `json:"current"`
	Local           []string       `json:"local"`
	LocalWithDates  []BranchWithTS `json:"local_with_dates"`
	RemoteOnly      []string       `json:"remote_only"`
}

// BranchWithTS pairs a local branch name with its committer date (unix secs).
type BranchWithTS struct {
	Name          string `json:"name"`
	CommitterDate int64  `json:"committerdate"`
}

// FileVersion is a per-file old/new content pair for commit/diff display.
type FileVersion struct {
	Path       string `json:"path"`
	OldContent string `json:"old_content"`
	NewContent string `json:"new_content"`
}

// ShowCommit is the full detail for one commit: message + per-file contents.
type ShowCommit struct {
	Message string        `json:"message"`
	Files   []FileVersion `json:"files"`
}

// MergeStatus reports whether a merge is in progress and which files conflict.
type MergeStatus struct {
	InProgress      bool     `json:"in_progress"`
	ConflictedFiles []string `json:"conflicted_files"`
	MergeHead       string   `json:"merge_head"`
	CurrentBranch   string   `json:"current_branch"`
}

// MergePreview is the read-only result of probing a merge.
type MergePreview struct {
	MergeKind        string         `json:"merge_kind"`
	Error            string         `json:"error,omitempty"`
	Ahead            int            `json:"ahead,omitempty"`
	Behind           int            `json:"behind,omitempty"`
	Commits          []MergeCommit  `json:"commits,omitempty"`
	ChangedFiles     []ChangedFile  `json:"changed_files,omitempty"`
	ConflictingFiles []string       `json:"conflicting_files,omitempty"`
}

// MergeCommit is a commit in a merge preview (note: "short" not "short_hash").
type MergeCommit struct {
	Hash    string `json:"hash"`
	Short   string `json:"short"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Subject string `json:"subject"`
}

// ChangedFile is a path + single-letter status (M/A/D/R/C).
type ChangedFile struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

// MergeFileDiff is a single-file diff between two refs.
type MergeFileDiff struct {
	Diff  string `json:"diff"`
	Error string `json:"error,omitempty"`
}

// MergeStartResult is the outcome of starting a merge.
type MergeStartResult struct {
	OK              bool     `json:"ok"`
	Clean           bool     `json:"clean,omitempty"`
	UpToDate        bool     `json:"up_to_date,omitempty"`
	Output          string   `json:"output"`
	ConflictedFiles []string `json:"conflicted_files,omitempty"`
	BackupBranch    string   `json:"backup_branch,omitempty"`
}

// ConflictVersions holds base/ours/theirs/working for a conflicted file.
type ConflictVersions struct {
	Path    string `json:"path"`
	Base    string `json:"base"`
	Ours    string `json:"ours"`
	Theirs  string `json:"theirs"`
	Working string `json:"working"`
}

// PromptEntry is one user prompt accumulated since the last commit. It feeds
// MakeCommitMessage. Fields mirror the Python dict {"text","ts","time_str"}.
type PromptEntry struct {
	Text    string  `json:"text"`
	TS      float64 `json:"ts"`
	TimeStr string  `json:"time_str"`
}

// ── small helpers shared across the package ──────────────────────────────────

// bufferString is a minimal io.Writer accumulating into a strings.Builder, used
// so we don't pull in bytes.Buffer purely for the String() convenience.
type bufferString struct{ b strings.Builder }

func (w *bufferString) Write(p []byte) (int, error) { return w.b.Write(p) }
func (w *bufferString) String() string              { return w.b.String() }

func stringReader(s string) io.Reader { return strings.NewReader(s) }

// appendEnv returns the current process env with extra entries appended.
func appendEnv(extra map[string]string) []string {
	env := os.Environ()
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}
