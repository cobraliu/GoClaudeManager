// Package git provides git operations for session auto-commit and the code
// browser. It is a Go port of ClaudeManager's app/services/git_service.py.
//
// Strategy (hybrid):
//   - go-git (github.com/go-git/go-git/v5) is used for repository plumbing where
//     it is reliable: init, is-repo detection, add+commit, status/dirty,
//     current branch, log/history, and remote URL read/write.
//   - the `git` CLI (os/exec) is used for anything whose textual output the
//     frontend depends on matching git exactly: unified diffs, diff --numstat,
//     `git show` patches, merge-tree conflict probing, checkout/merge/stash,
//     pull/push, and rollback. go-git's diff formatting does not match the CLI.
//
// Every method takes the repository working directory (the session cwd) as its
// first argument. A single Service value is shared across sessions.
package git

import (
	"context"
	"log/slog"
	"os/exec"
)

// DefaultGitignore is written into a freshly initialised repo when no
// .gitignore already exists. It mirrors the Python service verbatim.
const DefaultGitignore = `# Dependencies
**/node_modules/
vendor/
.pnp/
.pnp.js

# Python
__pycache__/
*.py[cod]
*.pyo
.venv/
venv/
env/
ENV/
*.egg-info/
dist/
build/
.eggs/

# Build outputs
dist/
build/
.next/
.nuxt/
out/
target/
*.class

# Large model / data files
*.bin
*.weights
*.ckpt
*.pt
*.pth
*.onnx
*.h5
*.hdf5
*.pkl
*.pickle
*.npy
*.npz
*.parquet
*.arrow
*.safetensors

# Archives
*.zip
*.tar
*.tar.gz
*.tgz
*.tar.bz2
*.rar
*.7z

# Media
*.mp4
*.avi
*.mov
*.mkv
*.mp3
*.wav
*.flac

# Logs & temp
*.log
*.tmp
*.swp
*.swo
.cache/
tmp/
temp/

# Secrets / env
.env
.env.*
*.pem
*.key
secrets.*

# OS
.DS_Store
Thumbs.db
desktop.ini

# IDE
.idea/
.vscode/
*.suo
*.user

# ClaudeManager runtime
.claude/
`

// ProxyEnvFunc returns extra environment variables (e.g. http_proxy) to inject
// into git subprocesses that touch the network (clone/push/pull/fetch). It is
// the Go analogue of Python's config.get_proxy_env. Returning nil/empty means
// "no proxy". The package never imports internal/config — the caller wires this.
type ProxyEnvFunc func() map[string]string

// Service performs git operations. The zero value is usable (no proxy, default
// logger). Construct with New to supply a proxy hook and/or logger.
type Service struct {
	// proxyEnv, when non-nil, supplies proxy env vars for networked git
	// subprocesses. nil means no proxy injection.
	proxyEnv ProxyEnvFunc
	// log is used for structured logging. Never nil after New; methods fall
	// back to slog.Default() when the Service was created as a zero value.
	log *slog.Logger
}

// New builds a Service. Both arguments may be nil: a nil proxyEnv disables proxy
// injection, a nil logger falls back to slog.Default().
func New(proxyEnv ProxyEnvFunc, logger *slog.Logger) *Service {
	return &Service{proxyEnv: proxyEnv, log: logger}
}

func (s *Service) logger() *slog.Logger {
	if s == nil || s.log == nil {
		return slog.Default()
	}
	return s.log
}

// run executes `git <args...>` in dir and returns combined stdout, stderr and
// the run error (nil on exit code 0). It does not inject proxy env.
func (s *Service) run(ctx context.Context, dir string, args ...string) (stdout, stderr string, err error) {
	return s.runEnv(ctx, dir, nil, args...)
}

// runEnv is like run but appends extra env vars (used for proxy injection).
func (s *Service) runEnv(ctx context.Context, dir string, extraEnv map[string]string, args ...string) (stdout, stderr string, err error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if len(extraEnv) > 0 {
		cmd.Env = appendEnv(extraEnv)
	}
	var out, errBuf bufferString
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	err = cmd.Run()
	return out.String(), errBuf.String(), err
}

// runStdin runs git feeding `input` on stdin (used for commit -F -).
func (s *Service) runStdin(ctx context.Context, dir, input string, args ...string) (stdout, stderr string, err error) {
	return s.runStdinEnv(ctx, dir, nil, input, args...)
}

// runStdinEnv is like runStdin but appends extra env vars (used by the shadow
// repo to inject GIT_DIR / GIT_WORK_TREE for commit -F -).
func (s *Service) runStdinEnv(ctx context.Context, dir string, extraEnv map[string]string, input string, args ...string) (stdout, stderr string, err error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if len(extraEnv) > 0 {
		cmd.Env = appendEnv(extraEnv)
	}
	cmd.Stdin = stringReader(input)
	var out, errBuf bufferString
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	err = cmd.Run()
	return out.String(), errBuf.String(), err
}
