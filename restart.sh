#!/usr/bin/env bash
# restart.sh — (re)start GoClaudeManager as the production backend.
#
#   web server      : 0.0.0.0:19099     (cmd/server → bin/gocm)
#   anthropic proxy : 127.0.0.1:19098   (cmd/proxy  → bin/proxy, upstream 127.0.0.1:8138)
#
# It frees the relevant port(s) (which on the very first run also stops the legacy
# Python uvicorn/proxy that previously owned them), then launches the selected Go
# binaries and waits for health. The tmux sessions live on the independent
# "claude-web" socket, so restarting here never disturbs running Claude panes.
#
# By DEFAULT only the web server is (re)started — the proxy is left running and
# untouched, so restarting the backend never interrupts the network of Claude
# sessions that are mid-conversation (their in-flight requests flow through the
# proxy). Restart the proxy explicitly only when you actually need to (first
# boot, or after changing proxy code/upstream).
#
# Usage:
#   ./restart.sh              # restart ONLY the web server (default; proxy left alone)
#   ./restart.sh --with-proxy # restart web server AND the anthropic proxy
#   ./restart.sh --proxy      # restart ONLY the anthropic proxy
#   ./restart.sh --no-proxy   # explicit form of the default (web server only)
#   ./restart.sh --build      # force a fresh rebuild of the affected binaries
#                             #   (combine, e.g. `--with-proxy --build`)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Toolchain (China-friendly defaults; override by exporting before calling).
export PATH="$PATH:/home/sgf/go/bin"
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
export GOSUMDB="${GOSUMDB:-off}"
export GOPATH="${GOPATH:-$HOME/.gopath-gocm}"
export GOFLAGS="${GOFLAGS:--mod=mod}"

WEB_HOST="${WEB_HOST:-0.0.0.0}"
WEB_PORT="${WEB_PORT:-19099}"
PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
PROXY_PORT="${PROXY_PORT:-19098}"
PROXY_UPSTREAM="${PROXY_UPSTREAM:-http://127.0.0.1:8138}"

LEGACY_DB="$ROOT/../ClaudeManager/data/data.db"
DB="$ROOT/data/data.db"
LOG_DIR="$ROOT/run"
mkdir -p "$LOG_DIR" bin data

# ── args ──────────────────────────────────────────────────────────────────────
# MODE: all | proxy-only | backend-only. Default backend-only so a routine
# restart never bounces the proxy and disturbs live sessions' network.
FORCE_BUILD=0
MODE="backend-only"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)               FORCE_BUILD=1 ;;
    --with-proxy|--all)    MODE="all" ;;
    --proxy)               MODE="proxy-only" ;;
    --no-proxy)            MODE="backend-only" ;;
    -h|--help)
      echo "Usage: $0 [--with-proxy | --proxy | --no-proxy] [--build]"
      echo "  (default)     restart only the web server; leave the proxy running"
      echo "  --with-proxy  restart the web server AND the anthropic proxy"
      echo "  --proxy       restart only the anthropic proxy"
      echo "  --no-proxy    explicit form of the default (web server only)"
      echo "  --build       force-rebuild the affected binaries first"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

DO_WEB=true
DO_PROXY=true
case "$MODE" in
  proxy-only)   DO_WEB=false ;;
  backend-only) DO_PROXY=false ;;
esac

# kill_listener PORT — terminate only the process that is *listening* on PORT
# (precise, so it never touches the autossh reverse tunnel's client sockets),
# then wait up to 5s for the port to free.
kill_listener() {
  local port="$1" pids pid
  pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)
  for pid in $pids; do
    echo "    stopping pid $pid holding :$port"
    kill "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 25); do
    ss -ltnH "sport = :$port" 2>/dev/null | grep -q . || return 0
    sleep 0.2
  done
  echo "    WARNING: :$port still occupied after 5s" >&2
}

echo "==> mode: $MODE"
# Only free the port(s) for the service(s) we are about to (re)start — this is
# what makes --no-proxy non-disruptive to the live proxy.
$DO_WEB   && { echo "==> Freeing :$WEB_PORT";   kill_listener "$WEB_PORT"; }
$DO_PROXY && { echo "==> Freeing :$PROXY_PORT"; kill_listener "$PROXY_PORT"; }

# Seed data/data.db from the legacy Python install on first run only — never
# clobber a db this service already owns. (The one-time production cutover copies
# the latest Python db in by hand, after Python is stopped.) Only the web server
# touches the db.
if $DO_WEB && [[ ! -f "$DB" && -f "$LEGACY_DB" ]]; then
  echo "==> Seeding data/data.db from $LEGACY_DB"
  cp "$LEGACY_DB" "$DB"
fi

# ── build (only what we'll start) ─────────────────────────────────────────────
if $DO_PROXY && { [[ "$FORCE_BUILD" == 1 ]] || [[ ! -x bin/proxy ]]; }; then
  echo "==> Building proxy"
  go build -o bin/proxy ./cmd/proxy
fi
if $DO_WEB && { [[ "$FORCE_BUILD" == 1 ]] || [[ ! -x bin/gocm ]]; }; then
  echo "==> Building server"
  go build -o bin/gocm ./cmd/server
fi

# ── start proxy ───────────────────────────────────────────────────────────────
if $DO_PROXY; then
  echo "==> Starting anthropic proxy on $PROXY_HOST:$PROXY_PORT (upstream $PROXY_UPSTREAM)"
  nohup ./bin/proxy --host "$PROXY_HOST" --port "$PROXY_PORT" --upstream-proxy "$PROXY_UPSTREAM" \
    > "$LOG_DIR/proxy.log" 2>&1 &
  echo $! > "$LOG_DIR/proxy.pid"

  echo -n "==> Waiting for proxy /_proxy_health "
  for _ in $(seq 1 25); do
    if curl -fsS --noproxy '*' "http://127.0.0.1:$PROXY_PORT/_proxy_health" >/dev/null 2>&1; then
      echo "OK"; break
    fi
    echo -n "."; sleep 0.2
  done
fi

# ── start web server ──────────────────────────────────────────────────────────
if $DO_WEB; then
  echo "==> Starting web server on $WEB_HOST:$WEB_PORT"
  HOST="$WEB_HOST" PORT="$WEB_PORT" FRONTEND_DIST="$ROOT/frontend/dist" \
    nohup ./bin/gocm > "$LOG_DIR/server.log" 2>&1 &
  echo $! > "$LOG_DIR/server.pid"

  echo -n "==> Waiting for /health "
  for _ in $(seq 1 50); do
    if curl -fsS --noproxy '*' "http://127.0.0.1:$WEB_PORT/health" >/dev/null 2>&1; then
      echo "OK"
      echo "==> Up — web=http://$WEB_HOST:$WEB_PORT  proxy=$PROXY_HOST:$PROXY_PORT"
      echo "    logs: $LOG_DIR/server.log  $LOG_DIR/proxy.log"
      exit 0
    fi
    echo -n "."
    sleep 0.2
  done
  echo
  echo "!! web server did not become healthy; tail of server.log:" >&2
  tail -n 20 "$LOG_DIR/server.log" >&2 || true
  exit 1
fi

# proxy-only path: report and exit.
echo "==> Up — proxy=$PROXY_HOST:$PROXY_PORT  (web server left untouched)"
echo "    logs: $LOG_DIR/proxy.log"
