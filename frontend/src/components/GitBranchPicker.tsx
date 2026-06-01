import { useState, useEffect, useRef, useCallback } from "react";
import {
  getGitBranches,
  gitCheckoutBranch,
  gitPull,
  getActiveCwdSessions,
  GitCheckoutConflictError,
  type ActiveCwdSession,
  type GitBranchInfo,
} from "../api/sessionApi";

interface Props {
  sessionId: string;
  /** Bumped whenever an external action (commit/checkout) should re-fetch state. */
  refreshKey?: number;
  /** Called after a successful branch switch so consumers can refresh their data. */
  onBranchChanged?: (branch: string) => void;
  /** Called whenever branch info is (re)loaded — used by parents to size the toolbar. */
  onInfoLoaded?: (info: GitBranchInfo) => void;
  /** Compact = small button suitable for the FILES header. */
  compact?: boolean;
  /** Icon-only mode — abbreviates the branch name (e.g., "f·foo-bar"). */
  iconOnly?: boolean;
  /** When set, overrides the button's maxWidth — used by parent to grow into spare row width. */
  maxWidth?: number;
}

export function GitBranchPicker({ sessionId, refreshKey, onBranchChanged, onInfoLoaded, compact = true, iconOnly = false, maxWidth }: Props) {
  const [info, setInfo] = useState<GitBranchInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState<{ branch: string; remote: boolean } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(null);

  // Recompute popup position whenever it opens / window scrolls / resizes.
  useEffect(() => {
    if (!open) { setPopupPos(null); return; }
    const update = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r) setPopupPos({ top: r.bottom + 2, left: r.left });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // Stabilize the callback via ref so identity changes from the parent don't
  // re-trigger getGitBranches() on every render.
  const onInfoLoadedRef = useRef(onInfoLoaded);
  useEffect(() => { onInfoLoadedRef.current = onInfoLoaded; }, [onInfoLoaded]);

  const reload = useCallback(() => {
    getGitBranches(sessionId)
      .then(i => { setInfo(i); onInfoLoadedRef.current?.(i); })
      .catch(() => { const empty: GitBranchInfo = { current: "", local: [] }; setInfo(empty); onInfoLoadedRef.current?.(empty); });
  }, [sessionId]);

  useEffect(() => { reload(); }, [reload, refreshKey]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = info?.current ?? "";
  const f = filter.trim().toLowerCase();
  const localBranches = (info?.local ?? []).filter(b => !f || b.toLowerCase().includes(f));
  const remoteBranches = (info?.remote_only ?? []).filter(b => !f || b.toLowerCase().includes(f));

  const handlePick = (branch: string, remote: boolean) => {
    if (!remote && branch === current) { setOpen(false); return; }
    setOpen(false);
    setPending({ branch, remote });
  };

  const onSuccess = (branch: string) => {
    setPending(null);
    reload();
    onBranchChanged?.(branch);
  };

  const baseBtnStyle: React.CSSProperties = iconOnly
    ? { display: "inline-flex", alignItems: "center", gap: 3, background: "var(--bg-hover)", border: "1px solid var(--text-faintest)", borderRadius: 4, padding: "1px 4px", fontSize: 11, color: "var(--text-secondary)", cursor: "pointer", minWidth: 0, overflow: "hidden" }
    : compact
      ? { display: "inline-flex", alignItems: "center", gap: 4, background: "var(--bg-hover)", border: "1px solid var(--text-faintest)", borderRadius: 4, padding: "1px 6px", fontSize: 11, color: "var(--text-secondary)", cursor: "pointer", maxWidth: 200, overflow: "hidden", minWidth: 0 }
      : { display: "inline-flex", alignItems: "center", gap: 4, background: "var(--bg-hover)", border: "1px solid var(--text-faintest)", borderRadius: 4, padding: "3px 10px", fontSize: 12, color: "var(--text-secondary)", cursor: "pointer", maxWidth: 260 };
  // When parent passes maxWidth (computed from spare row width), honor it so the
  // picker expands to use the leftover space when the branch name is truncated.
  const btnStyle: React.CSSProperties = maxWidth !== undefined ? { ...baseBtnStyle, maxWidth } : baseBtnStyle;

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block", minWidth: 0 }}>
      <button
        ref={buttonRef}
        onClick={() => setOpen(o => !o)}
        style={btnStyle}
        title={current ? `Branch: ${current}` : "Not on a branch"}
        disabled={!info || info.local.length === 0}
      >
        <svg width={10} height={10} viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}>
          <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
        </svg>
        {/* Always show the branch name so users know the active branch without
            opening the dropdown. In iconOnly (narrowest) mode, abbreviate long
            names as `<first>.<last7>` (e.g., "feature/foo-bar" → "f.foo-bar"). */}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            direction: iconOnly ? "ltr" : "rtl",
            textAlign: "left",
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {iconOnly
            ? (current && current.length > 8 ? `${current[0]}·${current.slice(-7)}` : current || "(detached)")
            : <bdi style={{ unicodeBidi: "plaintext" }}>{current || "(detached)"}</bdi>}
        </span>
        {info?.dirty && <span title="Working tree has uncommitted changes" style={{ color: "var(--accent-amber)", fontSize: 10, flexShrink: 0 }}>●</span>}
        <span style={{ color: "var(--text-faint)", fontSize: 9, flexShrink: 0 }}>▾</span>
      </button>

      {open && popupPos && info && (info.local.length > 0 || (info.remote_only ?? []).length > 0) && (
        <div style={{ position: "fixed", top: popupPos.top, left: popupPos.left, zIndex: 4000, background: "var(--bg-surface)", border: "1px solid var(--border-strong)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.4)", minWidth: 260, maxWidth: 360 }}>
          <div style={{ padding: 6, borderBottom: "1px solid var(--bg-hover)" }}>
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter branches..."
              style={{ width: "100%", background: "var(--bg-base)", border: "1px solid var(--text-faintest)", borderRadius: 4, padding: "3px 6px", color: "var(--text-body)", fontSize: 11, outline: "none" }}
            />
          </div>
          <div style={{ maxHeight: 320, overflowY: "auto", padding: "4px 0" }}>
            {localBranches.length === 0 && remoteBranches.length === 0 && (
              <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-faint)" }}>No matches</div>
            )}
            {localBranches.length > 0 && (
              <>
                <div style={{ padding: "2px 10px", fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Local</div>
                {localBranches.map(b => (
                  <div
                    key={`local-${b}`}
                    onClick={() => handlePick(b, false)}
                    style={{ padding: "4px 10px", fontSize: 12, fontFamily: "monospace", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, background: b === current ? "rgba(88,166,255,0.12)" : "transparent", color: b === current ? "var(--accent-blue)" : "var(--text-body)" }}
                    onMouseEnter={(e) => { if (b !== current) (e.currentTarget as HTMLDivElement).style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { if (b !== current) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                  >
                    <span style={{ width: 10, textAlign: "center" }}>{b === current ? "✓" : ""}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b}</span>
                  </div>
                ))}
              </>
            )}
            {remoteBranches.length > 0 && (
              <>
                <div style={{ padding: "6px 10px 2px", fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.05em", borderTop: localBranches.length > 0 ? "1px solid var(--bg-hover)" : "none", marginTop: localBranches.length > 0 ? 4 : 0 }}>Remote (origin) — picking will fetch & track</div>
                {remoteBranches.map(b => (
                  <div
                    key={`remote-${b}`}
                    onClick={() => handlePick(b, true)}
                    style={{ padding: "4px 10px", fontSize: 12, fontFamily: "monospace", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "var(--text-body)" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                    title="Fetch from origin and create a local tracking branch"
                  >
                    <span style={{ width: 10, textAlign: "center", color: "var(--accent-amber)" }}>↓</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ color: "var(--text-faint)" }}>origin/</span>{b}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {pending && (
        <BranchCheckoutConfirm
          sessionId={sessionId}
          branch={pending.branch}
          remote={pending.remote}
          onCancel={() => setPending(null)}
          onDone={() => onSuccess(pending.branch)}
        />
      )}
    </div>
  );
}

/* ─── Branch checkout confirm — also reused by Revert (see ConfirmAffectingChangeModal) ─── */
function BranchCheckoutConfirm({
  sessionId, branch, remote = false, onCancel, onDone,
}: {
  sessionId: string;
  branch: string;
  remote?: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [active, setActive] = useState<ActiveCwdSession[] | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Set when the attempt comes back with a conflict; checkout is then blocked
  // until the user commits or stashes those files manually.
  const [conflict, setConflict] = useState<{ files: string[] } | null>(null);

  useEffect(() => {
    getActiveCwdSessions(sessionId).then(r => setActive(r.sessions)).catch(() => setActive([]));
  }, [sessionId]);

  const hasActive = (active?.length ?? 0) > 0;
  const requireAck = hasActive;
  const ackOk = !requireAck || ack;

  const doCheckout = async (stash: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await gitCheckoutBranch(sessionId, branch, { stash, remote });
      onDone();
    } catch (e) {
      if (e instanceof GitCheckoutConflictError) {
        setConflict({ files: e.conflict.conflicting_files });
        setErr(null);
      } else {
        setErr(String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 6000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={busy ? undefined : onCancel}
    >
      <div
        style={{ width: 480, maxWidth: "92vw", background: "var(--bg-base)", border: "1px solid var(--border-strong)", borderRadius: 8, display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--bg-hover)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-body)" }}>
            {remote ? "Fetch & track remote branch" : "Checkout branch"}
          </span>
          <button onClick={onCancel} disabled={busy} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 12, padding: "3px 8px" }}>✕</button>
        </div>
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10, fontSize: 12, color: "var(--text-body)" }}>
          <div>
            {remote ? (
              <>
                Will run <span style={{ fontFamily: "monospace", color: "var(--text-muted)" }}>git fetch origin {branch}</span>, then <span style={{ fontFamily: "monospace", color: "var(--text-muted)" }}>git checkout -b {branch} --track origin/{branch}</span>.
              </>
            ) : (
              <>Switching to branch <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{branch}</span></>
            )}
            {conflict === null && (
              <span style={{ color: "var(--text-muted)" }}> · uncommitted edits will be carried over if they don't conflict.</span>
            )}
          </div>

          {conflict && (
            <div style={{ background: "rgba(248, 81, 73, 0.12)", border: "1px solid var(--accent-red)", borderRadius: 4, padding: "8px 10px", color: "var(--text-body)", fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ color: "var(--accent-red)", fontWeight: 600 }}>⚠ Checkout blocked — local changes would be overwritten</div>
              {conflict.files.length > 0 && (
                <div style={{ maxHeight: 140, overflowY: "auto", fontFamily: "monospace", fontSize: 11, color: "var(--text-secondary)" }}>
                  {conflict.files.map(f => <div key={f}>{f}</div>)}
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Stash & Checkout preserves these edits (recover later with <span style={{ fontFamily: "monospace" }}>git stash pop</span>), or commit them via terminal first.
              </div>
            </div>
          )}

          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
              Other sessions currently editing this working directory:
            </div>
            {active === null ? (
              <div style={{ fontSize: 12, color: "var(--text-faint)" }}>Checking…</div>
            ) : active.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--accent-green)" }}>✓ No active sessions on this cwd.</div>
            ) : (
              <div style={{ background: "var(--bg-surface)", border: "1px solid var(--accent-red)", borderRadius: 4, padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {active.map(s => (
                  <div key={s.id} style={{ display: "flex", gap: 8, fontSize: 12, fontFamily: "monospace" }}>
                    <span style={{ color: "var(--accent-red)" }}>● {s.status}</span>
                    <span style={{ color: "var(--text-body)" }}>{s.name}</span>
                    <span style={{ color: "var(--text-faint)" }}>({s.tool})</span>
                  </div>
                ))}
                <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>
                  Stop these sessions first, or acknowledge below that you understand the working tree may change under them.
                </div>
              </div>
            )}
          </div>

          {requireAck && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text-body)" }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I understand the active session(s) may break.
            </label>
          )}

          {err && <div style={{ fontSize: 12, color: "var(--accent-red)" }}>{err}</div>}
        </div>
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--bg-hover)", display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button onClick={onCancel} disabled={busy} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 12, padding: "5px 12px" }}>
            Cancel
          </button>
          {conflict ? (
            <button
              disabled={!ackOk || busy}
              onClick={() => doCheckout(true)}
              style={{
                background: !ackOk ? "var(--bg-hover)" : "var(--accent-amber)",
                color: !ackOk ? "var(--text-faint)" : "#000",
                fontSize: 12, padding: "5px 14px",
              }}
              title="Run git stash push -u, then checkout. Recover later with git stash pop."
            >
              {busy ? "Stashing & checking out…" : "Stash & Checkout"}
            </button>
          ) : (
            <button
              disabled={!ackOk || busy}
              onClick={() => doCheckout(false)}
              style={{
                background: !ackOk ? "var(--bg-hover)" : "var(--accent-blue)",
                color: !ackOk ? "var(--text-faint)" : "#fff",
                fontSize: 12, padding: "5px 14px",
              }}
            >
              {busy ? "Checking out…" : "Checkout"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Generic confirm modal: warn about active sessions before any destructive change.
 *    Reused for Revert (action=revert). Pure UI; caller supplies the action handler. */
export function ConfirmAffectingChangeModal({
  sessionId, title, description, actionLabel, busyLabel, onCancel, onConfirm,
}: {
  sessionId: string;
  title: string;
  description: React.ReactNode;
  actionLabel: string;
  busyLabel?: string;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  const [active, setActive] = useState<ActiveCwdSession[] | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getActiveCwdSessions(sessionId).then(r => setActive(r.sessions)).catch(() => setActive([]));
  }, [sessionId]);

  const hasActive = (active?.length ?? 0) > 0;
  const requireAck = hasActive;
  const canProceed = !requireAck || ack;

  const handleConfirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onConfirm();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 6000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={busy ? undefined : onCancel}
    >
      <div
        style={{ width: 480, maxWidth: "92vw", background: "var(--bg-base)", border: "1px solid var(--border-strong)", borderRadius: 8, display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--bg-hover)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-body)" }}>{title}</span>
          <button onClick={onCancel} disabled={busy} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 12, padding: "3px 8px" }}>✕</button>
        </div>
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10, fontSize: 12, color: "var(--text-body)" }}>
          <div>{description}</div>

          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
              Other sessions currently editing this working directory:
            </div>
            {active === null ? (
              <div style={{ fontSize: 12, color: "var(--text-faint)" }}>Checking…</div>
            ) : active.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--accent-green)" }}>✓ No active sessions on this cwd.</div>
            ) : (
              <div style={{ background: "var(--bg-surface)", border: "1px solid var(--accent-red)", borderRadius: 4, padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {active.map(s => (
                  <div key={s.id} style={{ display: "flex", gap: 8, fontSize: 12, fontFamily: "monospace" }}>
                    <span style={{ color: "var(--accent-red)" }}>● {s.status}</span>
                    <span style={{ color: "var(--text-body)" }}>{s.name}</span>
                    <span style={{ color: "var(--text-faint)" }}>({s.tool})</span>
                  </div>
                ))}
                <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>
                  Stop these sessions first, or acknowledge below.
                </div>
              </div>
            )}
          </div>

          {requireAck && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text-body)" }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I understand this may interfere with the active session(s).
            </label>
          )}

          {err && <div style={{ fontSize: 12, color: "var(--accent-red)" }}>{err}</div>}
        </div>
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--bg-hover)", display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button onClick={onCancel} disabled={busy} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 12, padding: "5px 12px" }}>Cancel</button>
          <button
            disabled={!canProceed || busy}
            onClick={handleConfirm}
            style={{ background: canProceed ? "var(--accent-red)" : "var(--bg-hover)", color: canProceed ? "#fff" : "var(--text-faint)", fontSize: 12, padding: "5px 14px" }}
          >
            {busy ? (busyLabel ?? "Working…") : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Pull button — fast-forward pull of the current branch's upstream ─── */
export function GitPullButton({
  sessionId, onPulled, compact = true, iconOnly = false,
}: {
  sessionId: string;
  onPulled?: () => void;
  compact?: boolean;
  iconOnly?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    setToast(null);
    try {
      const r = await gitPull(sessionId);
      const msg = r.output?.split("\n")[0] || "Up to date";
      setToast({ kind: "ok", text: msg });
      onPulled?.();
    } catch (e) {
      setToast({ kind: "err", text: String(e).replace(/^Error:\s*/, "") });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  const btnStyle: React.CSSProperties = iconOnly
    ? { display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--bg-hover)", border: "1px solid var(--text-faintest)", borderRadius: 4, padding: "1px 4px", fontSize: 11, color: "var(--text-secondary)", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1, flexShrink: 0 }
    : compact
      ? { display: "inline-flex", alignItems: "center", gap: 4, background: "var(--bg-hover)", border: "1px solid var(--text-faintest)", borderRadius: 4, padding: "1px 6px", fontSize: 11, color: "var(--text-secondary)", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1, flexShrink: 0 }
      : { display: "inline-flex", alignItems: "center", gap: 4, background: "var(--bg-hover)", border: "1px solid var(--text-faintest)", borderRadius: 4, padding: "3px 10px", fontSize: 12, color: "var(--text-secondary)", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 };

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={handleClick}
        disabled={busy}
        style={btnStyle}
        title={busy ? "Pulling…" : "git pull --ff-only"}
      >
        <svg width={10} height={10} viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}>
          <path d="M7.78 12.53a.75.75 0 01-1.06 0L2.47 8.28a.75.75 0 011.06-1.06l2.72 2.72V2.75a.75.75 0 011.5 0v7.19l2.72-2.72a.75.75 0 111.06 1.06l-4.25 4.25zM2.75 14a.75.75 0 000 1.5h10.5a.75.75 0 000-1.5H2.75z" />
        </svg>
        {!iconOnly && (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {busy ? "Pulling…" : "Pull"}
          </span>
        )}
      </button>
      {toast && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200,
            background: toast.kind === "ok" ? "rgba(46,160,67,0.95)" : "rgba(248,81,73,0.95)",
            color: "#fff", fontSize: 11, padding: "4px 8px", borderRadius: 4,
            maxWidth: 320, whiteSpace: "pre-wrap", wordBreak: "break-word",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
