#!/usr/bin/env bash
# build-structured.sh — build the claude-structured wrapper (../rewriteCodeCli)
# and copy its compiled binaries next to the server binary in bin/.
#
# The SDK session transport spawns bin/claude-structured inside a tmux pane;
# bin/claude is the native CLI it drives (shipped alongside so the compiled
# wrapper can resolve it without node_modules). bin/ is gitignored — these
# binaries are never committed.
#
# Skips (exit 0) when the sibling repo or bun is missing, so the main build
# never breaks on machines without the wrapper checked out.
#
# Usage: scripts/build-structured.sh [path-to-rewriteCodeCli]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-$ROOT/../rewriteCodeCli}"

if [[ ! -f "$SRC/package.json" ]]; then
  echo "==> build-structured: $SRC not found — skipping (sdk transport stays unavailable)"
  exit 0
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "==> build-structured: bun not on PATH — skipping (sdk transport stays unavailable)"
  exit 0
fi

echo "==> build-structured: bun run build in $SRC"
( cd "$SRC" && bun run build )

mkdir -p "$ROOT/bin"
install -m 0755 "$SRC/dist/claude-structured" "$ROOT/bin/claude-structured"
if [[ -f "$SRC/dist/claude" ]]; then
  install -m 0755 "$SRC/dist/claude" "$ROOT/bin/claude"
fi
echo "==> build-structured: installed bin/claude-structured$([[ -f "$SRC/dist/claude" ]] && echo ' + bin/claude')"
