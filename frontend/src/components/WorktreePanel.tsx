import { useState, useEffect, useCallback } from "react";
import {
  listWorktrees,
  addWorktree,
  mergeWorktree,
  removeWorktree,
  createSession,
  getSession,
  gitMergeStart,
  requestOpenSession,
  type WorktreeList,
  type WorktreeRepo,
  type WorktreeInfo,
  type SessionMeta,
} from "../api/sessionApi";

// Git worktrees of the session's repository: one branch + directory per
// parallel agent. Lists every worktree with its status and the sessions
// running in it, and lets you create one (optionally starting a session in
// it), open/start its session, merge it back into the base branch, or remove
// it. Shared by the file panel, the Git panel and mobile.

interface Props {
  sessionId: string;
  /** Tighter layout for the narrow file-tree column. */
  compact?: boolean;
  /** Worktree the host shows changes/commits of (null = the session's cwd). */
  viewing?: string | null;
  /** When set, each worktree gets a "View" button that points the host's
   *  Changes/Commits at it (null = back to the session's own directory). */
  onView?: (wt: { path: string; branch: string } | null) => void;
}

function relTime(unix: number): string {
  if (!unix) return "";
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : "…/" + parts.slice(-2).join("/");
}

const btn = (kind: "primary" | "plain" | "danger" = "plain", disabled = false): React.CSSProperties => ({
  background: disabled ? "var(--bg-hover)" : kind === "primary" ? "var(--accent-blue)" : kind === "danger" ? "transparent" : "var(--bg-hover)",
  color: disabled ? "var(--text-faint)" : kind === "primary" ? "#fff" : kind === "danger" ? "var(--accent-red)" : "var(--text-body)",
  border: kind === "danger" ? "1px solid var(--accent-red)" : "1px solid transparent",
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 4,
  cursor: disabled ? "default" : "pointer",
  whiteSpace: "nowrap",
});

const badge = (color: string): React.CSSProperties => ({
  fontSize: 10, padding: "0 5px", borderRadius: 8, border: `1px solid ${color}`, color, whiteSpace: "nowrap",
});

interface SectionProps {
  sessionId: string;
  session: SessionMeta | null;
  repo: WorktreeRepo;
  /** Heading: "本目录" or the repo's path relative to the session's cwd. */
  label: string;
  showLabel: boolean;
  compact: boolean;
  reload: () => Promise<unknown>;
  viewing?: string | null;
  onView?: Props["onView"];
}

function RepoSection({ sessionId, session, repo: data, label, showLabel, compact, reload: load, viewing, onView }: SectionProps) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // path or "add"
  const [open, setOpen] = useState(true);

  const [showAdd, setShowAdd] = useState(false);
  const [branch, setBranch] = useState("");
  const [startSession, setStartSession] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState<WorktreeInfo | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);

  const startSessionAt = async (path: string, branchName: string) => {
    const s = await createSession({
      project: session?.project || branchName,
      cwd: path,
      tool: session?.tool ?? "claude",
      transport: session?.transport,
    });
    requestOpenSession(s.id);
  };

  const handleAdd = async () => {
    const b = branch.trim();
    if (!b) return;
    setBusy("add"); setMsg(null);
    try {
      const res = await addWorktree(sessionId, { repo: data.root, branch: b });
      setBranch(""); setShowAdd(false);
      await load();
      if (startSession) await startSessionAt(res.path, b);
      else setMsg(`Created worktree ${b} at ${res.path}`);
    } catch (e) {
      setMsg(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const handleOpen = async (wt: WorktreeInfo) => {
    if (wt.sessions.length > 0) { requestOpenSession(wt.sessions[0].id); return; }
    setBusy(wt.path); setMsg(null);
    try { await startSessionAt(wt.path, wt.branch || "worktree"); }
    catch (e) { setMsg(String((e as Error)?.message ?? e)); }
    finally { setBusy(null); }
  };

  const handleMerge = async (wt: WorktreeInfo) => {
    setBusy(wt.path); setMsg(null);
    try {
      const res = await mergeWorktree(sessionId, data.root, wt.path);
      if (res.ok) {
        setMsg(res.up_to_date ? `${data.base} already contains ${wt.branch}` :
          `Merged ${wt.branch} into ${data.base}` + (res.backup_branch ? ` (backup: ${res.backup_branch})` : ""));
      } else if (res.needs_sync) {
        setMsg(`Conflicts merging ${wt.branch} → ${data.base} (${(res.conflicted_files ?? []).join(", ")}). ` +
          `Nothing was changed. Sync ${data.base} into ${wt.branch} first and resolve inside the worktree, then merge back.`);
        setSyncTarget(wt);
      } else {
        setMsg(res.output);
      }
      await load();
    } catch (e) {
      setMsg(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  // Conflict path: merge base INTO the worktree branch, inside the worktree's
  // own session, so conflicts are resolved there with the normal Merge UI.
  const [syncTarget, setSyncTarget] = useState<WorktreeInfo | null>(null);
  const handleSync = async (wt: WorktreeInfo) => {
    const sid = wt.sessions[0]?.id;
    if (!sid) return;
    setBusy(wt.path);
    try {
      const res = await gitMergeStart(sid, data.base, wt.branch);
      if (res.conflicted_files?.length) {
        setMsg(`Sync started in ${wt.branch}: resolve ${res.conflicted_files.length} conflict(s) in that session's Git → Merge tab, then merge back.`);
        requestOpenSession(sid);
      } else setMsg(`Synced ${data.base} into ${wt.branch}. You can merge back now.`);
      setSyncTarget(null);
      await load();
    } catch (e) {
      setMsg(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (wt: WorktreeInfo, force: boolean) => {
    setBusy(wt.path); setMsg(null);
    try {
      await removeWorktree(sessionId, data.root, wt.path, { force, delete_branch: deleteBranch });
      setConfirmRemove(null); setDeleteBranch(false);
      setMsg(`Removed worktree ${wt.branch || wt.path}`);
      await load();
    } catch (e) {
      setMsg(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--text-body)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {showLabel && (
          <button onClick={() => setOpen(v => !v)} title={data.root}
            style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--text-body)", fontWeight: 600, fontSize: 12, display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            <span style={{ color: "var(--text-faint)", fontSize: 10 }}>{open ? "▾" : "▸"}</span>
            <span style={{ fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
            {data.worktrees.length > 1 && <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>({data.worktrees.length})</span>}
          </button>
        )}
        <span style={{ color: "var(--text-muted)" }}>Base</span>
        <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{data.base || "(detached)"}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => { setOpen(true); setShowAdd(v => !v); }} style={btn("primary")}>+ New worktree</button>
      </div>
      {open && <>

      {showAdd && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: 8, background: "var(--bg-surface)", borderRadius: 6 }}>
          <input
            autoFocus
            value={branch}
            onChange={e => setBranch(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") setShowAdd(false); }}
            placeholder="New branch name, e.g. feat/login"
            style={{ fontSize: 12, padding: "4px 6px", background: "var(--bg-base)", color: "var(--text-body)", border: "1px solid var(--bg-hover)", borderRadius: 4 }}
          />
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
            Branches from the current HEAD into <span style={{ fontFamily: "monospace" }}>{shortPath(data.main_path)}.worktrees/</span>; untracked .env files are copied.
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={startSession} onChange={e => setStartSession(e.target.checked)} />
            Start a {session?.tool ?? "claude"} session in it
          </label>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={() => setShowAdd(false)} style={btn()}>Cancel</button>
            <button disabled={!branch.trim() || busy === "add"} onClick={handleAdd} style={btn("primary", !branch.trim() || busy === "add")}>
              {busy === "add" ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      )}

      {msg && (
        <div style={{ fontSize: 11, color: "var(--text-secondary)", background: "var(--bg-surface)", borderRadius: 4, padding: "5px 8px", wordBreak: "break-word" }}>
          {msg}
          {syncTarget && syncTarget.sessions.length > 0 && (
            <button disabled={busy !== null} onClick={() => handleSync(syncTarget)} style={{ ...btn("primary", busy !== null), marginLeft: 6 }}>
              Sync {data.base} → {syncTarget.branch}
            </button>
          )}
          {syncTarget && syncTarget.sessions.length === 0 && (
            <span style={{ marginLeft: 4 }}>Start a session in that worktree to resolve there.</span>
          )}
          <button onClick={() => { setMsg(null); setSyncTarget(null); }} style={{ float: "right", background: "transparent", color: "var(--text-faint)", fontSize: 11, border: "none", cursor: "pointer" }}>✕</button>
        </div>
      )}

      {data.worktrees.map(wt => {
        const rowBusy = busy === wt.path;
        const viewed = !!onView && (viewing ? viewing === wt.path : wt.is_current);
        return (
          <div key={wt.path} style={{
            border: `1px solid ${viewed ? "var(--accent-green)" : wt.is_current ? "var(--accent-blue)" : "var(--bg-hover)"}`,
            borderRadius: 6, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4,
            background: wt.is_current ? "rgba(56,139,253,0.06)" : "transparent",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", minWidth: 0 }}>
              <span style={{ fontFamily: "monospace", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                ⑂ {wt.branch || `(detached ${wt.head})`}
              </span>
              {wt.is_main && <span style={badge("var(--text-muted)")}>main</span>}
              {wt.is_current && <span style={badge("var(--accent-blue)")}>this session</span>}
              {wt.dirty > 0 && <span style={badge("var(--accent-amber)")} title="Uncommitted changes">● {wt.dirty}</span>}
              {!wt.is_main && wt.ahead > 0 && <span style={badge("#3fb950")} title={`${wt.ahead} commit(s) not in ${data.base}`}>↑{wt.ahead}</span>}
              {!wt.is_main && wt.behind > 0 && <span style={badge("var(--text-muted)")} title={`${wt.behind} commit(s) in ${data.base} not here`}>↓{wt.behind}</span>}
              {wt.prunable && <span style={badge("var(--accent-red)")}>missing</span>}
            </div>
            <div title={wt.path} style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {shortPath(wt.path)}{wt.last_commit && <> · {wt.last_commit} · {relTime(wt.last_time)}</>}
            </div>
            {wt.sessions.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {wt.sessions.map(s => (
                  <button key={s.id} onClick={() => requestOpenSession(s.id)} title={s.name}
                    style={{ ...btn(), fontSize: 10, padding: "1px 6px", maxWidth: compact ? 170 : 260, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {s.id === sessionId ? "● " : "▸ "}{s.tool} · {s.name.replace(/^claude-[^-]+-/, "")}
                  </button>
                ))}
              </div>
            )}
            {!wt.prunable && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {onView && (
                  <button disabled={viewed} onClick={() => onView(wt.is_current ? null : { path: wt.path, branch: wt.branch || wt.head })}
                    title={viewed ? "Changes / Commits below show this worktree" : "Show this worktree's changes and commits in the file panel"}
                    style={viewed ? { ...btn(), color: "var(--accent-green)", cursor: "default" } : btn()}>
                    {viewed ? "✓ Viewing" : "View"}
                  </button>
                )}
                {!(wt.sessions.length === 1 && wt.sessions[0].id === sessionId) && (
                  <button disabled={rowBusy} onClick={() => handleOpen(wt)} style={btn("plain", rowBusy)}>
                    {wt.sessions.length > 0 ? "Open session" : "Start session"}
                  </button>
                )}
                {!wt.is_main && (
                  <button disabled={rowBusy || wt.ahead === 0 || wt.dirty > 0} onClick={() => handleMerge(wt)}
                    title={wt.dirty > 0 ? "Commit the worktree's changes first" : wt.ahead === 0 ? `Nothing to merge into ${data.base}` : `Merge ${wt.branch} into ${data.base}`}
                    style={btn("plain", rowBusy || wt.ahead === 0 || wt.dirty > 0)}>
                    Merge → {data.base}
                  </button>
                )}
                {!wt.is_main && (
                  <button disabled={rowBusy || wt.sessions.length > 0} onClick={() => { setConfirmRemove(wt); setDeleteBranch(wt.ahead === 0); }}
                    title={wt.sessions.length > 0 ? "Stop its sessions first" : "Remove this worktree"}
                    style={btn("danger", rowBusy || wt.sessions.length > 0)}>
                    Remove
                  </button>
                )}
              </div>
            )}
            {wt.prunable && (
              <button disabled={rowBusy} onClick={() => handleRemove(wt, false)} style={{ ...btn("danger", rowBusy), alignSelf: "flex-start" }}>Prune</button>
            )}
            {confirmRemove?.path === wt.path && (
              <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: 6, background: "var(--bg-surface)", borderRadius: 4 }}>
                <span style={{ fontSize: 11 }}>
                  Remove worktree <b>{wt.branch}</b>?{wt.dirty > 0 && <span style={{ color: "var(--accent-red)" }}> {wt.dirty} uncommitted change(s) will be lost.</span>}
                </span>
                <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-secondary)" }}>
                  <input type="checkbox" checked={deleteBranch} onChange={e => setDeleteBranch(e.target.checked)} />
                  Also delete branch {wt.branch}{wt.ahead > 0 && " (has unmerged commits!)"}
                </label>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <button onClick={() => setConfirmRemove(null)} style={btn()}>Cancel</button>
                  <button disabled={rowBusy} onClick={() => handleRemove(wt, wt.dirty > 0 || (deleteBranch && wt.ahead > 0))}
                    style={{ ...btn("plain", rowBusy), background: "var(--accent-red)", color: "#fff" }}>
                    {rowBusy ? "Removing…" : "Remove"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {data.worktrees.length === 1 && !showLabel && (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          No extra worktrees yet. Create one per parallel task so each agent edits its own branch and directory.
        </div>
      )}
      </>}
    </div>
  );
}

export function WorktreePanel({ sessionId, compact = false, viewing = null, onView }: Props) {
  const [data, setData] = useState<WorktreeList | null>(null);
  const [session, setSession] = useState<SessionMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    return listWorktrees(sessionId)
      .then(setData)
      .catch(e => setErr(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    load();
    getSession(sessionId).then(setSession).catch(() => {});
  }, [sessionId, load]);

  const pad = compact ? "6px 8px" : "10px 14px";
  if (loading) return <div style={{ padding: pad, fontSize: 12, color: "var(--text-muted)" }}>Loading worktrees…</div>;
  if (err) return <div style={{ padding: pad, fontSize: 12, color: "var(--accent-red)" }}>{err}</div>;
  if (!data) return null;

  const multi = data.repos.length > 1 || !data.cwd_is_repo;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: pad }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
        <span style={{ flex: 1 }}>
          {data.repos.length === 0
            ? "本目录及其子目录（两层）中没有 git 仓库。"
            : data.cwd_is_repo
              ? (data.repos.length > 1 ? `本目录仓库 + 子目录中的 ${data.repos.length - 1} 个仓库` : "")
              : `本目录不是 git 仓库；子目录中找到 ${data.repos.length} 个仓库`}
        </span>
        <button onClick={() => load()} title="Refresh" style={btn()}>⟳</button>
      </div>
      {data.repos.map((repo, i) => (
        <div key={repo.main_path} style={multi && i > 0 ? { borderTop: "1px solid var(--bg-hover)", paddingTop: 8 } : undefined}>
          <RepoSection
            sessionId={sessionId}
            session={session}
            repo={repo}
            label={repo.rel ? repo.rel + "/" : "本目录"}
            showLabel={multi}
            compact={compact}
            reload={load}
            viewing={viewing}
            onView={onView}
          />
        </div>
      ))}
    </div>
  );
}
