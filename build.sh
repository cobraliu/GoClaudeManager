#!/usr/bin/env bash
# build.sh — rebuild GoClaudeManager: the React frontend bundle + both Go binaries.
#
# Produces exactly what the production runner (restart.sh) consumes:
#   frontend/dist   React app, served on disk via FRONTEND_DIST
#   bin/proxy       anthropic tap proxy   (cmd/proxy)
#   bin/gocm        web server            (cmd/server)
#
# Usage:
#   ./build.sh                  # build frontend + both binaries
#   ./build.sh -r               # ...then ./restart.sh (web only; proxy untouched)
#   ./build.sh -r --with-proxy  # any args after -r are forwarded to restart.sh
#   VITE_BASE=/rosaccm/ ./build.sh   # sub-path deployment (match ROOT_PATH)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Toolchain (China-friendly defaults; override by exporting before calling).
# Make the Go toolchain reachable from non-login shells without hardcoding a
# user's home — override GO_BIN_DIR if your Go lives elsewhere.
GO_BIN_DIR="${GO_BIN_DIR:-$HOME/go/bin}"
[[ -d "$GO_BIN_DIR" ]] && export PATH="$PATH:$GO_BIN_DIR"
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
export GOSUMDB="${GOSUMDB:-off}"
export GOPATH="${GOPATH:-$HOME/.gopath-gocm}"
export GOFLAGS="${GOFLAGS:--mod=mod}"

# -r / --restart: after building, hand off to restart.sh. Everything after it is
# forwarded verbatim (e.g. --no-proxy, --proxy), so `./build.sh -r --no-proxy`
# rebuilds then bounces only the web server.
DO_RESTART=0
RESTART_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--restart) DO_RESTART=1; shift; RESTART_ARGS=("$@"); break ;;
    -h|--help)
      echo "Usage: $0 [-r [restart.sh args...]]"
      echo "  (default)   build frontend/dist + bin/proxy + bin/gocm"
      echo "  -r          after building, run ./restart.sh"
      echo "  -r ARGS...  forward ARGS to restart.sh (e.g. --no-proxy, --proxy)"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo "==> [1/3] Building frontend (vite)…"
( cd frontend && npm install --silent && npm run build )

mkdir -p bin
echo "==> [2/3] Building anthropic proxy (bin/proxy)…"
go build -o bin/proxy ./cmd/proxy
echo "==> [3/3] Building web server (bin/gocm)…"
go build -o bin/gocm ./cmd/server

# Optional: the claude-structured wrapper for the SDK session transport.
# Skips silently when ../rewriteCodeCli or bun is missing.
bash scripts/build-structured.sh

echo "==> Done: frontend/dist, bin/proxy, bin/gocm"

if [[ "$DO_RESTART" == 1 ]]; then
  echo "==> -r: handing off to ./restart.sh ${RESTART_ARGS[*]}"
  exec ./restart.sh "${RESTART_ARGS[@]}"
fi
