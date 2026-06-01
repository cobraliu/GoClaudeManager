# Architecture

GoClaudeManager is the Go reimplementation of the backend of
[ClaudeManager](https://github.com/cobraliu/ClaudeManager) — a self-hosted web
UI for managing multiple Claude Code / Codex / Cursor CLI sessions that each run
inside a **tmux pane**. The React + Vite frontend and the on-disk data formats
(SQLite `data.db`, Claude JSONL transcripts) are reused unchanged; only the
backend is rewritten.

This document describes how the Go backend is structured and why it is shaped
that way.

## What the predecessor did, and where it hurt

The Python (FastAPI + uvicorn) backend ran everything on a single asyncio event
loop, offloading blocking work to thread pools. It worked, but three structural
issues capped its throughput — and all three are exactly what Go is good at:

1. **Whole-file JSONL parsing under the GIL.** Session state (latest turn,
   goals, tasks, AskUserQuestion / compaction detection) was derived by
   re-reading and `json.loads`-ing the *entire* transcript on every pass. A
   single session's JSONL can reach hundreds of thousands of lines, and this ran
   inside 2s/5s polling loops across every session — tens of millions of JSON
   parses every couple of seconds, all holding the GIL and starving the event
   loop.

2. **One `fork+exec` per tmux operation.** Every `has-session`,
   `capture-pane`, `get-pane-history`, etc. spawned a fresh `tmux` subprocess
   (~10–50 ms each). At 100 sessions this was ~80–100 process creations per
   second of pure syscall and context-switch overhead.

3. **Poll-and-recompute instead of event-driven.** The watchdog and status
   loops did *sleep → `SELECT * FROM sessions` → recompute everything*. Cost
   grew linearly with session count and was completely decoupled from whether
   anything had actually changed — idle sessions were recomputed forever.

Plus a single serialized SQLite connection and a `fork` per PTY WebSocket.

## Core idea: event-driven + incremental

The Go backend replaces *poll-and-recompute* with *watch-and-react*:

```
                ┌─────────────────────────────────────────────┐
                │                Go backend                     │
  browser ─WS──▶│  WSHub ──┐                                    │
  browser ─REST▶│  HTTP    │   one goroutine per session        │
                │          ▼                                    │
                │   ┌──────────────┐  subscribe ┌─────────────┐ │
                │   │ SessionState │◀───────────│ JSONL watch │ │ fsnotify
                │   │ (in-mem, RW) │            │ (incremental)│ │
                │   └──────┬───────┘            └─────────────┘ │
                │          │ change event                       │
                │          ▼                                    │
                │     WSHub.Broadcast(session) ──push──▶ frontend│
                │                                               │
                │   tmux client (shared socket)   ──────────────┼─▶ tmux server
                │   PTYManager(creack/pty)   GitService(go-git) │
                │   SQLite(WAL)              AnthropicProxy(SSE) │
                └─────────────────────────────────────────────┘
```

Key design points:

- **One goroutine per session (actor model).** Each session's derived state is
  updated serially by its own goroutine, so no locks are needed; callers reach
  it through channels. Goroutines are cheap enough that "a goroutine + a watcher
  per session" scales to hundreds of sessions without strain.

- **Incremental JSONL parsing.** Each transcript is watched with `fsnotify` and
  parsed only from the last byte offset forward, maintaining the derived state
  in memory. A full parse happens once, at first load. Per-cycle cost drops from
  *O(total lines)* to *O(new bytes)*.

- **Reverse-scan tail reads.** For the common "show me the latest messages" path
  on a huge transcript, a reverse-scanning reader (`ReadRawMessagesTail`) reads
  from the end of the file instead of from the front, eliminating multi-minute
  loads on large sessions.

- **State push instead of state polling.** The frontend receives status changes
  pushed over WebSocket when they happen. A REST `/status` endpoint still exists
  (returning the in-memory snapshot, an O(1) read) for first paint and as a
  fallback.

- **SQLite in WAL mode** so reads don't block on writes, with a
  `sessions(status)` index so active-session queries use `WHERE status IN (...)`
  instead of a full scan.

- **PTY via `creack/pty`.** Each terminal WebSocket gets a read goroutine
  pumping PTY output to the socket and a writer pumping input back, with
  resize / copy-mode scrolling matched to the original behavior.

- **gzip-compressed JSON responses** (~4–5× on the large transcript/diff/graph
  payloads) at negligible CPU.

## tmux integration

tmux itself is not replaced — it is the core of session persistence. All
sessions live on a single dedicated tmux socket (`claude-web`), which means the
web server can be restarted at any time **without disturbing running Claude
panes**. The reverse proxy and the web server are separate binaries precisely so
that bouncing the web layer never interrupts in-flight requests flowing through
the proxy.

## Anthropic reverse proxy

`cmd/proxy` is a standalone reverse proxy that forwards every request to
`api.anthropic.com` (optionally through a configurable upstream HTTP proxy),
streams responses back to the Claude CLI unbuffered, and snapshots in-flight
assistant content from streaming SSE responses to
`~/.claude/cached_messages/{session_id}/{ts}.json` so the frontend can preview a
reply while it is still being generated.

There are two independent "proxy" knobs that are easy to conflate. The **tap
upstream** — where this proxy forwards to reach the internet — is an ops-level
startup flag (`--upstream-proxy` / `ANTHROPIC_PROXY_UPSTREAM`, empty = direct);
the proxy binary reads no database. Separately, the DB/UI **session proxy** (the
`proxy` config key) is injected into sessions as `http_proxy`/`https_proxy`; in
`real` mode it is the CLI's direct proxy, and in `tap_upstream` mode it covers
only the session's non-Anthropic traffic (the tap path uses `NO_PROXY` for
`127.0.0.1`). The web server surfaces the tap upstream read-only by echoing the
env it was launched with — never by giving the proxy DB access.

## Package layout

```
cmd/
  server         web server entry point (graceful shutdown, background loops)
  proxy          Anthropic reverse proxy + SSE tap (runs independently)
internal/
  app            assembly, lifecycle, background goroutines
  config         env vars (CLAUDEMANAGER_*, ROOT_PATH, …) + configs table
  api            chi sub-routers: sessions / auth / admin / git / code / share / …
  ws             WebSocket: PTY passthrough (terminal/term) + status push
  tmux           tmux client (session & terminal lifecycle) + PTY (creack/pty)
  term           embedded background terminals
  jsonl          incremental JSONL parse + in-memory derived state + tail reader
  git            git operations (go-git + CLI fallback)
  status         session status snapshot manager
  proxy          reverse-proxy + SSE aggregator implementation
  store          SQLite (WAL) + indexes
  auth           JWT (HS256) + Google OAuth
  model          domain models
  fsutil         filesystem helpers (tree, file sniffing)
  claudestat     Claude credential / usage helpers
  web            SPA hosting (embedded bundle + on-disk dir)
  obs            slog structured logging
```

## Performance summary

| Bottleneck (Python) | Go approach | Effect |
|---|---|---|
| Whole-file JSONL parse | fsnotify + offset-incremental parse + in-mem state | per-cycle CPU *O(total lines)* → *O(new bytes)*, no GIL |
| `fork` per tmux op | long-lived client on a shared socket | process creation ~80/s → ≈0 (only PTY attach execs) |
| Poll-and-recompute | event-driven + incremental push + in-mem snapshot | idle sessions cost nothing; `/status` read is O(1) |
| Single serialized SQLite conn | WAL + read concurrency + `status` index | reads no longer block on writes |
| `fork` per PTY WebSocket | `creack/pty` + goroutine pumps | goroutines far cheaper than threads; connections scale |
| GIL | none — true parallelism | multiple cores usable for parallel JSONL/diff work |

## Compatibility

- **Database** — reuses the existing SQLite schema as-is; the only additions are
  WAL mode and a `sessions(status)` index. No data migration required.
- **Claude JSONL / hook files / proxy snapshots** — read formats are unchanged;
  only the parser is reimplemented.
- **Frontend** — the API contract (URLs, request/response JSON, WebSocket
  message formats) is preserved, so the React app runs unchanged.
- **External binaries** — tmux, git, and the claude/codex/cursor CLIs are still
  required at runtime.

## Tech stack

| Concern | Library |
|---|---|
| HTTP router | `go-chi/chi` |
| WebSocket | `coder/websocket` |
| PTY | `creack/pty` |
| git | `go-git/go-git` + `git` CLI fallback |
| file watching | `fsnotify/fsnotify` |
| SQLite | `modernc.org/sqlite` (pure Go, no CGO → single static binary) |
| JWT | `golang-jwt/jwt` |
| OAuth | `golang.org/x/oauth2` + `google.golang.org/api/idtoken` |
| logging | `log/slog` (stdlib) |

Choosing pure-Go SQLite keeps the build CGO-free, so the whole backend ships as
a single static binary with no language runtime to install.
