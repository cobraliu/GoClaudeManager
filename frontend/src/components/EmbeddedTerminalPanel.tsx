import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createTerminal,
  deleteTerminal,
  heartbeatTerminal,
  issueTerminalToken,
  listTerminals,
  renameTerminal,
  createAdminTerminal,
  deleteAdminTerminal,
  heartbeatAdminTerminal,
  issueAdminTerminalToken,
  listAdminTerminals,
  renameAdminTerminal,
  type CreateTerminalResponse,
  type IssueTerminalTokenResponse,
  type TerminalHeartbeatResponse,
  type TerminalInfo,
} from "../api/sessionApi";
import { TerminalPane } from "./TerminalPane";
import { TermKeysBar } from "./TermKeysBar";

// Assistive-keys bar visibility, persisted. Defaults ON for touch devices
// (tablets/phones whose soft keyboards lack ESC/Ctrl/symbols), OFF otherwise.
const KEYS_BAR_LS = "termKeysBar:v1";
const initialKeysBar = (): boolean => {
  if (typeof window === "undefined") return false;
  const saved = window.localStorage.getItem(KEYS_BAR_LS);
  if (saved !== null) return saved === "1";
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
};

// Per-instance cache: which term_id we were attached to last. Used on panel
// mount / page reload to reattach instead of spawning yet another ephemeral.
// Bumping the prefix invalidates all stored ids if the schema ever changes.
const TERM_CACHE_PREFIX = "cmTermLastTermId:v1:";
const termCacheKey = (instanceKey: string) => TERM_CACHE_PREFIX + instanceKey;

// Heartbeat interval. The default backend idle grace is 600s; 30s gives ~20
// heartbeats per window, so transient network blips don't lose the terminal.
// Stays safely below any reasonable user-configured idle grace.
const HEARTBEAT_INTERVAL_MS = 30_000;

// Adapter so the same panel can drive session-scoped terminals
// (/api/sessions/{id}/terminals/...) and admin-scoped terminals
// (/api/admin/terminals/...) with identical lifecycle semantics.
export interface TerminalApi {
  list: () => Promise<{ items: TerminalInfo[] }>;
  create: (opts: { name?: string | null; cwd?: string }) => Promise<CreateTerminalResponse>;
  issueToken: (termId: string) => Promise<IssueTerminalTokenResponse>;
  rename: (termId: string, name: string | null) => Promise<TerminalInfo>;
  delete: (termId: string) => Promise<{ ok: boolean }>;
  heartbeat: (termId: string) => Promise<TerminalHeartbeatResponse>;
}

interface Props {
  // Stable cache/effect key. For session terminals: the session id.
  // For admin terminals: a fixed sentinel like "__admin__".
  instanceKey: string | null;
  api: TerminalApi;
  cwd?: string;
  theme: "dark" | "light";
  fontFamily?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  height: number;
  onHeightChange: (h: number) => void;
  resizeFrom?: "top" | "bottom";
  minHeight?: number;
  maxHeightVh?: number;
  emptyHint?: string;
  // When true, the panel stretches to fill its flex parent instead of using
  // the fixed `height` prop. Used for full-page placements (admin terminal
  // tab) where the parent already manages sizing.
  fill?: boolean;
}

type Attached = { termId: string; wsUrl: string; name: string | null; isNamed: boolean };

const POLL_MS = 4000;

export function EmbeddedTerminalPanel({
  instanceKey, api, cwd, theme, fontFamily,
  open, onOpenChange,
  height, onHeightChange,
  resizeFrom = "top",
  minHeight = 100,
  maxHeightVh = 70,
  emptyHint = "Select a session to open a terminal.",
  fill = false,
}: Props) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [attached, setAttached] = useState<Attached | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keysBar, setKeysBar] = useState(initialKeysBar);

  // Populated by TerminalPane; lets the assistive keys bar inject raw byte
  // sequences (ESC, Ctrl-combos, symbols) straight into the PTY.
  const sendRawRef = useRef<((data: string) => void) | null>(null);
  const toggleKeysBar = useCallback(() => {
    setKeysBar(v => {
      const next = !v;
      try { window.localStorage.setItem(KEYS_BAR_LS, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(0);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const refreshList = useCallback(async () => {
    if (!instanceKey) return;
    try {
      const r = await api.list();
      setTerminals(r.items);
    } catch {
      // swallow; periodic poll will retry
    }
  }, [instanceKey, api]);

  const openEphemeral = useCallback(async () => {
    if (!instanceKey || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.create({ cwd });
      setAttached({ termId: r.term_id, wsUrl: r.ws_url, name: r.name, isNamed: r.is_named });
      await refreshList();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [instanceKey, api, cwd, busy, refreshList]);

  const attachExisting = useCallback(async (term: TerminalInfo) => {
    if (!instanceKey || busy) return;
    // No-op when picking the terminal that's already attached — otherwise we'd
    // tear down the working WS and re-attach with a new token for no reason.
    if (attached && attached.termId === term.term_id) {
      setPicking(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await api.issueToken(term.term_id);
      setAttached({ termId: term.term_id, wsUrl: t.ws_url, name: term.name, isNamed: term.is_named });
      setPicking(false);
      await refreshList();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [instanceKey, api, busy, attached, refreshList]);

  const saveAsNamed = useCallback(async (name: string) => {
    if (!instanceKey || !attached || busy) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setRenameError(null);
    try {
      const r = await api.rename(attached.termId, trimmed);
      setAttached((a) => (a ? { ...a, name: r.name, isNamed: r.is_named } : a));
      setRenaming(false);
      setRenameValue("");
      await refreshList();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRenameError(msg);
    } finally {
      setBusy(false);
    }
  }, [instanceKey, api, attached, busy, refreshList]);

  const deleteCurrent = useCallback(async () => {
    if (!instanceKey || !attached || busy) return;
    const label = attached.name ? `"${attached.name}"` : "this ephemeral terminal";
    if (!confirm(`Delete ${label}? Any running processes inside will be killed.`)) return;
    setBusy(true);
    try {
      await api.delete(attached.termId);
      setAttached(null);
      await refreshList();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [instanceKey, api, attached, busy, refreshList]);

  // Reset all panel state when the instance changes or the panel closes.
  // Without this, switching from session A to B would leave A's terminal
  // attached (and its WS streaming) because `attached` is otherwise
  // instance-agnostic. The auto-open effect below then creates a fresh
  // ephemeral for the new instance.
  useEffect(() => {
    setAttached(null);
    setTerminals([]);
    setError(null);
    setPicking(false);
    setRenaming(false);
  }, [instanceKey, open]);

  // Auto-open: when the panel becomes visible with nothing attached, first try
  // to reattach the term_id remembered from the previous mount. Only fall back
  // to spawning a new ephemeral if the cached id is stale (404/410) or absent.
  // This is what makes a browser refresh feel like nothing happened, instead
  // of leaving an orphaned ephemeral behind every reload.
  useEffect(() => {
    if (!open || !instanceKey || attached) return;
    let cancelled = false;
    (async () => {
      try {
        const cachedId = localStorage.getItem(termCacheKey(instanceKey));
        if (cachedId) {
          try {
            // issueToken works for standby terms too, so revival
            // happens automatically when the WS later attaches.
            const t = await api.issueToken(cachedId);
            if (cancelled) return;
            setAttached({
              termId: t.term_id,
              wsUrl: t.ws_url,
              name: t.name ?? null,
              isNamed: !!t.is_named,
            });
            api.list().then((rr) => { if (!cancelled) setTerminals(rr.items); }).catch(() => {});
            return;
          } catch {
            // Cached term was swept or otherwise unreachable. Drop the cache
            // and fall through to the create-new path below.
            localStorage.removeItem(termCacheKey(instanceKey));
          }
        }
        const r = await api.list();
        if (cancelled) return;
        setTerminals(r.items);
        const c = await api.create({ cwd });
        if (cancelled) return;
        setAttached({ termId: c.term_id, wsUrl: c.ws_url, name: c.name, isNamed: c.is_named });
        api.list().then((rr) => { if (!cancelled) setTerminals(rr.items); }).catch(() => {});
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [open, instanceKey, api, cwd, attached]);

  // Persist the currently-attached term_id so the next mount can find it.
  // We store on every attach (named or ephemeral) — the cached id is just
  // "where the user was looking last in this tab," and reattach behavior
  // works identically for both kinds.
  useEffect(() => {
    if (!instanceKey) return;
    if (attached) {
      try { localStorage.setItem(termCacheKey(instanceKey), attached.termId); }
      catch { /* quota exceeded — not worth surfacing */ }
    }
  }, [instanceKey, attached]);

  // While a terminal is attached, periodically heartbeat. This keeps the
  // backend's "last holder" timestamp fresh so an ephemeral with a temporarily
  // detached WS (network blip, tab background-throttling) doesn't get swept.
  // 410 means our cached id was already swept — drop attachment so the
  // auto-open effect above can spawn a fresh one.
  useEffect(() => {
    if (!open || !instanceKey || !attached) return;
    const tick = async () => {
      try {
        await api.heartbeat(attached.termId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/gone|404|410/i.test(msg)) {
          try { localStorage.removeItem(termCacheKey(instanceKey)); } catch { /* ignore */ }
          setAttached(null);
        }
      }
    };
    const id = setInterval(tick, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [open, instanceKey, api, attached]);

  // Periodic list refresh (mostly to update attach_count badges)
  useEffect(() => {
    if (!open || !instanceKey) return;
    const id = setInterval(refreshList, POLL_MS);
    return () => clearInterval(id);
  }, [open, instanceKey, refreshList]);

  // Close picker on outside-click / Escape.
  useEffect(() => {
    if (!picking) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPicking(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicking(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [picking]);

  // Drag-to-resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dy = e.clientY - dragStartY.current;
      const direction = resizeFrom === "top" ? -1 : 1;
      const next = dragStartH.current + direction * dy;
      const max = Math.floor(window.innerHeight * maxHeightVh / 100);
      onHeightChange(Math.max(minHeight, Math.min(next, max)));
    };
    const onUp = () => { dragging.current = false; document.body.style.cursor = ""; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizeFrom, minHeight, maxHeightVh, onHeightChange]);

  const startDrag = (e: React.MouseEvent) => {
    dragging.current = true;
    dragStartY.current = e.clientY;
    dragStartH.current = height;
    document.body.style.cursor = "row-resize";
    e.preventDefault();
  };

  if (!open) return null;

  const resizeHandle = (
    <div
      onMouseDown={startDrag}
      style={{ height: 4, cursor: "row-resize", background: "var(--bg-hover)", flexShrink: 0 }}
      onMouseEnter={e => { e.currentTarget.style.background = "var(--border-strong)"; }}
      onMouseLeave={e => { if (!dragging.current) e.currentTarget.style.background = "var(--bg-hover)"; }}
    />
  );

  const named = terminals
    .filter(t => t.is_named)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const ephemeral = terminals.filter(t => !t.is_named);

  const currentLabel = attached
    ? (attached.name ? `📌 ${attached.name}` : `▶ ephemeral (${attached.termId.slice(0, 6)})`)
    : "(no terminal)";

  return (
    <div style={{
      ...(fill ? { flex: 1, minHeight: 0 } : { height, flexShrink: 0 }),
      display: "flex", flexDirection: "column",
      background: "var(--bg-base)",
      borderTop: !fill && resizeFrom === "top" ? "1px solid var(--border)" : undefined,
      borderBottom: !fill && resizeFrom === "bottom" ? "1px solid var(--border)" : undefined,
      overflow: "hidden",
    }}>
      {!fill && resizeFrom === "top" && resizeHandle}

      {/* Header */}
      <div style={{
        padding: "4px 10px", background: "var(--bg-surface)",
        borderBottom: "1px solid var(--bg-hover)",
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0, fontSize: 11,
        position: "relative",
      }}>
        {/* Picker */}
        <div ref={pickerRef} style={{ position: "relative", display: "flex" }}>
        <button
          onClick={() => setPicking(p => !p)}
          title="Switch terminal"
          disabled={!instanceKey || busy}
          style={{
            background: "var(--bg-hover)", color: "var(--text-body)",
            fontSize: 11, padding: "2px 8px", lineHeight: 1,
            display: "flex", alignItems: "center", gap: 4,
          }}
        >
          <span style={{ fontFamily: "monospace" }}>{currentLabel}</span>
          <span style={{ fontSize: 9, color: "var(--text-muted)" }}>▾</span>
        </button>

        {picking && (
          <div style={{
            position: "absolute", top: "100%", left: 0, marginTop: 2,
            background: "var(--bg-surface)", border: "1px solid var(--border-strong)",
            borderRadius: 6, padding: 4, minWidth: 240, maxHeight: 280, overflowY: "auto",
            zIndex: 50, boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}>
            <div style={{ fontSize: 10, color: "var(--text-faint)", padding: "4px 8px", textTransform: "uppercase", letterSpacing: 0.6 }}>Named</div>
            {named.length === 0 && (
              <div style={{ padding: "4px 10px", fontSize: 11, color: "var(--text-muted)" }}>(none yet — save current to name it)</div>
            )}
            {named.map(t => (
              <button
                key={t.term_id}
                onClick={() => attachExisting(t)}
                style={{
                  display: "flex", width: "100%", textAlign: "left", padding: "4px 8px",
                  background: attached?.termId === t.term_id ? "rgba(88,166,255,0.12)" : "transparent",
                  color: attached?.termId === t.term_id ? "var(--accent-blue)" : "var(--text-body)",
                  border: "none", fontSize: 11, gap: 6, alignItems: "center",
                  cursor: "pointer",
                }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "monospace" }}>📌 {t.name}</span>
                {t.attach_count > 0 && (
                  <span style={{ fontSize: 9, padding: "1px 5px", background: "rgba(34,197,94,0.18)", color: "#22c55e", borderRadius: 3 }}>
                    👥{t.attach_count}
                  </span>
                )}
              </button>
            ))}

            <div style={{ fontSize: 10, color: "var(--text-faint)", padding: "4px 8px", marginTop: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>Ephemeral</div>
            {ephemeral.length === 0 && (
              <div style={{ padding: "4px 10px", fontSize: 11, color: "var(--text-muted)" }}>(none)</div>
            )}
            {ephemeral.map(t => (
              <button
                key={t.term_id}
                onClick={() => attachExisting(t)}
                style={{
                  display: "flex", width: "100%", textAlign: "left", padding: "4px 8px",
                  background: attached?.termId === t.term_id ? "rgba(88,166,255,0.12)" : "transparent",
                  color: attached?.termId === t.term_id ? "var(--accent-blue)" : "var(--text-body)",
                  border: "none", fontSize: 11, gap: 6, alignItems: "center",
                  cursor: "pointer",
                }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "monospace" }}>▶ {t.term_id.slice(0, 8)}</span>
                {t.attach_count > 0 && (
                  <span style={{ fontSize: 9, padding: "1px 5px", background: "rgba(34,197,94,0.18)", color: "#22c55e", borderRadius: 3 }}>
                    👥{t.attach_count}
                  </span>
                )}
              </button>
            ))}

            <div style={{ borderTop: "1px solid var(--bg-hover)", marginTop: 6, paddingTop: 4 }}>
              <button
                onClick={() => { setPicking(false); openEphemeral(); }}
                disabled={busy}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "4px 8px", background: "transparent", border: "none", color: "var(--accent-blue)", fontSize: 11, cursor: "pointer" }}
              >+ New ephemeral terminal</button>
            </div>
          </div>
        )}
        </div>

        {/* Save (rename) — only when attached and ephemeral */}
        {attached && !attached.isNamed && !renaming && (
          <button
            onClick={() => { setRenameValue(""); setRenameError(null); setRenaming(true); }}
            disabled={busy}
            title="Save this terminal with a name (won't be auto-killed)"
            style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 11, padding: "2px 8px", lineHeight: 1 }}
          >💾 Save</button>
        )}

        {attached && renaming && (
          <form
            onSubmit={(e) => { e.preventDefault(); saveAsNamed(renameValue); }}
            style={{ display: "flex", gap: 4, alignItems: "center" }}
          >
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => { setRenameValue(e.target.value); if (renameError) setRenameError(null); }}
              onKeyDown={(e) => { if (e.key === "Escape") { setRenaming(false); setRenameError(null); } }}
              placeholder="terminal name"
              title={renameError ?? undefined}
              style={{
                fontSize: 11, padding: "2px 6px", width: 120,
                background: "var(--bg-base)",
                border: `1px solid ${renameError ? "var(--accent-red, #f85149)" : "var(--border)"}`,
                color: "var(--text-body)",
                borderRadius: 3,
              }}
            />
            <button type="submit" disabled={!renameValue.trim() || busy}
              style={{
                background: renameValue.trim() ? "var(--accent-blue)" : "var(--text-faintest)",
                color: "#fff", fontSize: 11, padding: "2px 8px", lineHeight: 1,
              }}
            >OK</button>
            <button type="button" onClick={() => { setRenaming(false); setRenameError(null); }}
              style={{ background: "var(--bg-hover)", color: "var(--text-muted)", fontSize: 11, padding: "2px 6px", lineHeight: 1 }}
            >✕</button>
            {renameError && (
              <span style={{ fontSize: 10, color: "var(--accent-red, #f85149)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={renameError}>
                {renameError}
              </span>
            )}
          </form>
        )}

        {/* Delete */}
        {attached && (
          <button
            onClick={deleteCurrent}
            disabled={busy}
            title="Delete this terminal (kills tmux session)"
            style={{ background: "var(--bg-hover)", color: "var(--text-muted)", fontSize: 11, padding: "2px 8px", lineHeight: 1 }}
          >🗑</button>
        )}

        {/* Attach-count badge */}
        {attached && (() => {
          const live = terminals.find(t => t.term_id === attached.termId);
          if (!live || live.attach_count <= 1) return null;
          return (
            <span style={{ fontSize: 9, padding: "1px 5px", background: "rgba(34,197,94,0.18)", color: "#22c55e", borderRadius: 3 }}>
              👥 {live.attach_count} attached
            </span>
          );
        })()}

        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--text-faint)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 }}>
          {cwd || ""}
        </span>
        <button
          onClick={toggleKeysBar}
          title={keysBar ? "Hide assistive keys" : "Show assistive keys (ESC, Ctrl, symbols…)"}
          style={{
            background: keysBar ? "color-mix(in srgb, var(--accent-blue) 20%, var(--bg-base))" : "var(--bg-hover)",
            color: keysBar ? "var(--accent-blue)" : "var(--text-secondary)",
            fontSize: 11, padding: "2px 8px", lineHeight: 1,
          }}
        >⌨</button>
        {!fill && (
          <button
            onClick={() => onOpenChange(false)}
            title="Hide terminal"
            style={{
              background: "var(--bg-hover)", color: "var(--text-secondary)",
              fontSize: 11, padding: "2px 8px", lineHeight: 1,
            }}
          >✕</button>
        )}
      </div>

      {/* Pinned (named) terminals — always-visible quick-access strip so a
          named terminal is one click away instead of buried in the picker.
          Named terminals are server-persisted (term.Record.Name), so this bar
          is identical on every device you log in from. Shared component, so
          this serves both the session panel and the admin terminal tab. */}
      {named.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "3px 8px", flexShrink: 0,
          background: "var(--bg-base)",
          borderBottom: "1px solid var(--bg-hover)",
          overflowX: "auto", whiteSpace: "nowrap",
        }}>
          <span style={{ fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: 0.6, flexShrink: 0, marginRight: 2 }}>📌 Pinned</span>
          {named.map(t => {
            const isActive = attached?.termId === t.term_id;
            return (
              <button
                key={t.term_id}
                onClick={() => attachExisting(t)}
                disabled={busy || !instanceKey}
                title={`Open terminal "${t.name}"`}
                style={{
                  display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
                  fontSize: 11, padding: "2px 8px", lineHeight: 1, borderRadius: 4,
                  cursor: busy ? "default" : "pointer", fontFamily: "monospace",
                  background: isActive ? "rgba(88,166,255,0.16)" : "var(--bg-hover)",
                  color: isActive ? "var(--accent-blue)" : "var(--text-body)",
                  border: `1px solid ${isActive ? "var(--accent-blue)" : "transparent"}`,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 }}>{t.name}</span>
                {t.attach_count > 0 && (
                  <span style={{ fontSize: 9, padding: "0 4px", background: "rgba(34,197,94,0.18)", color: "#22c55e", borderRadius: 3 }}>👥{t.attach_count}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {error && (
          <div style={{ padding: 12, fontSize: 12, color: "var(--text-danger, #f85149)" }}>
            {error}
          </div>
        )}
        {!instanceKey && !error && (
          <div style={{ padding: 12, fontSize: 12, color: "var(--text-muted)" }}>
            {emptyHint}
          </div>
        )}
        {attached && !error && (
          <TerminalPane
            key={attached.termId + attached.wsUrl + (fontFamily || "")}
            sessionId={attached.termId}
            wsUrl={attached.wsUrl}
            scrollMode="tmux"
            theme={theme}
            onDisconnect={() => setAttached(null)}
            defaultFit
            fontFamily={fontFamily}
            sendRawRef={sendRawRef}
          />
        )}
      </div>
      {attached && !error && keysBar && (
        <TermKeysBar sendKey={(seq) => sendRawRef.current?.(seq)} />
      )}
      {!fill && resizeFrom === "bottom" && resizeHandle}
    </div>
  );
}

/** Build a TerminalApi bound to a specific session id. Stable across renders
 *  when sessionId is stable so the panel doesn't churn its effects. */
export function useSessionTerminalApi(sessionId: string | null): TerminalApi {
  return useMemo<TerminalApi>(() => ({
    list: () => sessionId ? listTerminals(sessionId) : Promise.resolve({ items: [] }),
    create: (opts) => createTerminal(sessionId!, opts),
    issueToken: (termId) => issueTerminalToken(sessionId!, termId),
    rename: (termId, name) => renameTerminal(sessionId!, termId, name),
    delete: (termId) => deleteTerminal(sessionId!, termId),
    heartbeat: (termId) => heartbeatTerminal(sessionId!, termId),
  }), [sessionId]);
}

/** Admin-scoped TerminalApi — same TerminalManager backend, no session. */
export function useAdminTerminalApi(): TerminalApi {
  return useMemo<TerminalApi>(() => ({
    list: () => listAdminTerminals(),
    create: (opts) => createAdminTerminal({ name: opts.name, cwd: opts.cwd ?? "/" }),
    issueToken: (termId) => issueAdminTerminalToken(termId),
    rename: (termId, name) => renameAdminTerminal(termId, name),
    delete: (termId) => deleteAdminTerminal(termId),
    heartbeat: (termId) => heartbeatAdminTerminal(termId),
  }), []);
}
