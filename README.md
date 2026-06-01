# GoClaudeManager

A self-hosted web UI for running and managing many **Claude Code / Codex / Cursor CLI** sessions from a single browser tab.

[![License](https://img.shields.io/badge/License-Private-lightgrey.svg)](#license)
[![Go](https://img.shields.io/badge/go-1.26%2B-00ADD8.svg)](https://go.dev/)
[![Node](https://img.shields.io/badge/node-18%2B-green.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-linux%20%7C%20macOS-lightgrey.svg)](#requirements)

Each session runs inside a **tmux** pane — you get a full terminal, a live conversation viewer, a file & git browser, and a code-diff panel, all from one tab, on desktop or mobile.

> **The high-performance Go rewrite of [ClaudeManager](https://github.com/cobraliu/ClaudeManager).** Same UI, same data, a backend that scales. The React frontend and on-disk formats (SQLite, Claude JSONL) are reused unchanged; the Python/FastAPI backend is reimplemented in Go as an event-driven, single-binary server. See [Why Go?](#why-go) for the numbers.

---

## Why GoClaudeManager?

If you run several Claude Code sessions across different projects, the usual SSH + tmux + `claude --resume` dance gets old fast. GoClaudeManager keeps every session alive in a tmux pane on the server and gives you **one browser tab** to attach, watch the conversation stream in real time, browse code, drive git, and jump straight into the terminal TUI — from your laptop or your phone.

It is a drop-in successor to the Python ClaudeManager: point it at the same data and it just works, but it stays responsive at dozens of concurrent sessions where the Python version started to choke.

---

## Table of Contents

- [Highlights](#highlights)
- [Features](#features)
- [Why Go?](#why-go)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Security](#security)
- [Documentation](#documentation)
- [License](#license)

---

## Highlights

- ⚡ **Built for scale** — event-driven, incremental JSONL parsing and a long-lived tmux connection keep CPU flat as sessions pile up. No GIL, no per-op `fork`, no full-file re-parsing.
- 📦 **Single static binary** — pure-Go SQLite (no CGO). Drop it on a box and run; no language runtime to install.
- 🔁 **Restart without disruption** — the web server and the API proxy are separate binaries on a dedicated tmux socket, so you can redeploy the UI without touching live Claude panes.
- 📱 **Desktop & mobile** — full TUI passthrough, dedicated mobile layout, touch scrolling and copy.
- 🔑 **Web-driven login** — refresh expired Claude credentials right from the browser, no SSH required.

---

## Features

### Session management
- **Multi-session dashboard** — create, resume, attach, and terminate Claude Code / Codex / Cursor sessions, shared across devices
- **Embedded terminal** — full xterm.js TUI forwarded directly to the session's tmux pane, on desktop and mobile
- **Persistent bash terminals** — open named (survives disconnect) or ephemeral background terminals per session; **named terminals are auto-shown and pinned**, server-persisted so they follow you across devices
- **Load existing sessions** — import sessions from `~/.claude/projects/` by browsing their JSONL history

### Conversation & insight
- **Live chat view** — conversation bubbles parsed incrementally from the Claude JSONL, with **streaming preview** of the reply that's still being generated
- **Goals / Tasks / AUQs dock** — track `/goal`s, Claude's TodoWrite/TaskCreate items, and every `AskUserQuestion` interaction in a collapsible right-side dock
- **Slash-command badges & compaction banner** — `/goal`, `/compact`, etc. surface as styled badges; a live `Compacting … XX%` progress banner shows while `/compact` runs
- **Mermaid rendering & HTML export** — ` ```mermaid ` blocks render inline; export the full conversation to a self-contained HTML file
- **Raw JSONL viewer** — inspect the underlying conversation log, with a fast reverse-scan tail reader that opens even multi-hundred-MB transcripts instantly

### Code & git
- **Code panel** — file tree + side-by-side diff viewer of changed files
- **CHANGES panel** — change statistics that **respect `.gitignore`** (counts what git sees, not a raw filesystem walk)
- **Git integration** — commit history, branch graph, diffs, merge, `.gitignore` editing, auto-commit
- **One-click file copy** — copy file contents to the clipboard from the viewer

### Platform
- **Assisted login** — drive the `claude /login` OAuth flow from the web UI to refresh the shared credentials all sessions use (admin-only)
- **Anthropic reverse proxy (SSE tap)** — forwards to `api.anthropic.com`, streams unbuffered, and snapshots in-flight replies for streaming preview
- **User accounts** — JWT auth with admin / regular roles; optional Google OAuth; public read-only share links
- **Mobile-friendly** — dedicated mobile page, swipe-to-scroll TUI history, touch select-and-copy

---

## Why Go?

The Python (FastAPI) version did everything on one asyncio loop and re-derived state by re-reading entire transcripts inside polling loops. Three rewrites carry the performance story:

| Bottleneck (Python) | GoClaudeManager | Result |
|---|---|---|
| Re-parse the **whole** JSONL every poll, under the GIL | `fsnotify` watch + **incremental** parse from the last byte offset | per-cycle cost drops from *O(total lines)* to *O(new bytes)* |
| One `fork+exec` **per tmux op** (~80/s at 100 sessions) | one long-lived tmux client on a shared socket | process churn → ≈0 |
| Poll-and-recompute every session on a timer | **per-session goroutine** actor + push-on-change | idle sessions cost nothing |
| Single serialized SQLite connection | WAL mode + `status` index | reads stop blocking on writes |
| Multi-minute open on huge transcripts | reverse-scan tail reader | opens instantly |

The whole backend ships as a **single static binary** (pure-Go SQLite, no CGO), and gzip-compressed JSON responses cut large transcript/diff/graph payloads ~4–5×.

---

## Architecture

Two independent Go binaries:

| Binary | Entry | Default bind | Role |
|---|---|---|---|
| `bin/gocm` | `cmd/server` | `0.0.0.0:19099` | Web server: REST API, WebSocket, serves the frontend SPA |
| `bin/proxy` | `cmd/proxy` | `127.0.0.1:19098` | Anthropic reverse proxy + SSE tap |

- Every tmux session lives on a dedicated socket (`claude-web`), so **restarting the web server never interrupts a running Claude pane**.
- Sessions are stored in SQLite (WAL) `data.db`; the conversation comes from Claude's JSONL, parsed incrementally.
- The frontend is a static SPA that can be **embedded in the binary** (single-file deploy) or **served from disk** (dev hot-reload).

For the full design — concurrency model, data flow, and module map — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| Linux or macOS | — | Windows not supported |
| Go | 1.26+ | Backend build |
| Node.js | 18+ | Frontend build |
| tmux | any | Session isolation |
| `claude` / `codex` / `cursor` CLI | latest | on `$PATH`, as needed |

---

## Quick Start

```bash
# 1. Clone
git clone git@github.com:cobraliu/GoClaudeManager.git
cd GoClaudeManager

# 2. Build the frontend + both binaries
./build.sh

# 3. Start (web server only by default; bring up the proxy on first run)
./restart.sh --with-proxy
```

Health check, then open **http://localhost:19099**:

```bash
curl localhost:19099/health     # {"status":"ok"}
curl localhost:19099/api/meta   # {"backend":"go",...}
```

### Build & run scripts

`build.sh` — build `frontend/dist` + `bin/proxy` + `bin/gocm`:

```bash
./build.sh                   # full build
./build.sh -r --no-proxy     # build, then restart the web server only
VITE_BASE=/myccm/ ./build.sh # sub-path deployment (match ROOT_PATH)
```

`restart.sh` — production start/stop. **By default it restarts only the web server and leaves the proxy running**, so in-flight sessions are never interrupted:

```bash
./restart.sh                # restart web server only (default)
./restart.sh --with-proxy   # restart web server AND proxy
./restart.sh --proxy        # restart proxy only
./restart.sh --build        # force a rebuild first
```

Dev mode (serve the frontend from disk, no embedding):

```bash
PORT=19399 FRONTEND_DIST=$(pwd)/frontend/dist go run ./cmd/server
```

> **Faster builds in mainland China (optional):** `build.sh` / `restart.sh` default to `GOPROXY=https://goproxy.cn,direct` and `GOSUMDB=off`; override via env vars if needed.

---

## Configuration Reference

### Web server (`cmd/server`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `19099` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `ROOT_PATH` | *(empty)* | Sub-path deployment prefix; must match the frontend `VITE_BASE` |
| `FRONTEND_DIST` | *(empty)* | Path to a dist dir to serve from disk; otherwise the embedded bundle is used |
| `CLAUDEMANAGER_DATA_DIR` | *(empty → `./data`)* | Data directory (holds `data.db`) |
| `CM_TMUX_SOCKET` | `claude-web` | tmux socket name (override to isolate tests) |
| `CLAUDE_PROXY_PORT` | `19098` | Anthropic proxy port sessions route through |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `GOOGLE_CLIENT_ID` | *(empty)* | Google OAuth login (optional) |

### Anthropic proxy (`cmd/proxy`)

| Flag / Variable | Default | Description |
|---|---|---|
| `--port` / `ANTHROPIC_PROXY_PORT` | `19098` | Listen port |
| `--upstream-proxy` / `ANTHROPIC_PROXY_UPSTREAM` | *(empty)* | Upstream HTTP proxy (leave empty for a direct connection) |

---

## Security

GoClaudeManager exposes a Claude Code shell, a file browser, and a terminal over HTTP. **Read this before deploying anywhere reachable beyond `localhost`.**

- **Don't expose it directly to the public internet.** Put it behind a reverse proxy with TLS (Caddy / Nginx / Traefik) and an additional access layer (basic auth, OAuth proxy, VPN, or IP allowlist).
- **Treat every account as a shell account.** Even non-admin users can open shells and edit files in the configured workspace. Only invite people you'd otherwise hand SSH access.
- **Credentials are shared.** All sessions run under the host user's `~/.claude/.credentials.json` — one identity for every web user. The assisted-login flow that rewrites it is admin-only.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design, concurrency model, performance, and the Python→Go module map.

---

## License

Private project. © loki / cobraliu.
