import { useCallback, useEffect, useState } from "react";
import {
  shadowLog, shadowRestore, shadowRestorePreview, shadowCommitDetail, shadowSnapshot,
  type RewindPoint, type ShadowPreview, type ShadowFileChange, type GitDiffFile,
} from "../api/sessionApi";
import { DiffViewer } from "./GitPanel";

/** A list of changed files (git name-status: M/A/D/R…). Used by the restore preview. */
function FileList({ files, maxHeight = 110 }: { files: ShadowFileChange[]; maxHeight?: number }) {
  return (
    <div style={{ maxHeight, overflowY: "auto", marginBottom: 6 }}>
      {files.map((f) => (
        <div key={f.path} style={{ fontSize: 11, display: "flex", gap: 6, fontFamily: "var(--font-mono, monospace)" }}>
          <span style={{ color: "var(--accent-amber)", width: 14, flexShrink: 0 }}>{f.status}</span>
          <span style={{ color: "var(--text-secondary)", wordBreak: "break-all" }}>{f.path}</span>
        </div>
      ))}
    </div>
  );
}

/** Renders a unified diff with +/-/@@ line coloring. Used by the restore preview. */
function DiffPre({ diff, maxHeight = 180 }: { diff: string; maxHeight?: number }) {
  if (!diff) return null;
  return (
    <pre style={{
      margin: "0 0 6px", maxHeight, overflow: "auto", fontSize: 10, lineHeight: 1.4,
      background: "var(--bg-sidebar)", padding: 6, borderRadius: 4, whiteSpace: "pre",
      fontFamily: "var(--font-mono, monospace)",
    }}>
      {diff.split("\n").map((line, i) => (
        <div key={i} style={{
          color: line.startsWith("+") && !line.startsWith("+++") ? "var(--accent-green, #4caf50)"
            : line.startsWith("-") && !line.startsWith("---") ? "var(--accent-red, #e5534b)"
            : line.startsWith("@@") ? "var(--accent-cyan, #56b6c2)"
            : "var(--text-faint)",
        }}>{line || " "}</div>
      ))}
    </pre>
  );
}

/** Popup detail for one revert point — mirrors GitPanel's CommitDetailModal:
 *  header (hash · time), full commit message (incl. body), and a "Show file
 *  changes" button that opens the SAME side-by-side DiffViewer used for real
 *  commits, so the look is identical. */
function ShadowDetailModal({ sessionId, point, onClose }: { sessionId: string; point: RewindPoint; onClose: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [files, setFiles] = useState<GitDiffFile[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    shadowCommitDetail(sessionId, point.hash)
      .then((d) => { setMessage(d.message || point.subject); setFiles(d.files || []); })
      .catch((e) => { setMessage(point.subject); setErr(String(e)); });
  }, [sessionId, point.hash, point.subject]);

  const fmt = (unix: number) => unix ? new Date(unix * 1000).toLocaleString() : "";

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5000 }}
      onClick={onClose}
    >
      <div
        style={{ width: 620, maxWidth: "95vw", maxHeight: "80vh", background: "var(--bg-base)", borderRadius: 10, border: "1px solid var(--border-strong)", display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "8px 14px", background: "var(--bg-surface)", borderBottom: "1px solid var(--bg-hover)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--accent-blue)" }}>{point.short_hash}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>revert point · {fmt(point.ts)}</span>
          </div>
          <button onClick={onClose} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 12, padding: "4px 10px" }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          <pre style={{ margin: 0, fontFamily: "monospace", fontSize: 13, color: "var(--text-body)", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.6 }}>
            {message ?? "Loading..."}
          </pre>

          {err && <div style={{ fontSize: 12, color: "var(--accent-red)" }}>{err}</div>}

          <button
            disabled={message === null}
            onClick={() => { if (files.length === 0) setErr("本回合无文件改动。"); else setShowDiff(true); }}
            style={{ alignSelf: "flex-start", background: "var(--accent-green)", color: "#fff", fontSize: 12, padding: "5px 14px" }}
          >
            Show file changes{files.length ? ` (${files.length})` : ""}
          </button>
        </div>
      </div>

      {showDiff && files.length > 0 && (
        <DiffViewer
          files={files}
          title={`Changes in ${point.short_hash}`}
          onClose={() => setShowDiff(false)}
          zIndex={5100}
        />
      )}
    </div>
  );
}

/** Revert points = commits in the per-project *shadow* git repo (kept under the
 *  app data dir, work-tree = the project). Each completed turn is snapshotted
 *  there, so this is an undo history that NEVER touches the project's real .git.
 *  Restore overwrites the tracked working tree to a past point (a safety
 *  snapshot is taken first); ignored files like node_modules are left alone. */
export function ShadowRewindSection({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState<RewindPoint[]>([]);
  const [branch, setBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Two-step restore: clicking Restore first loads a diff preview inline; the
  // actual (destructive) restore only runs after the user confirms it.
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [preview, setPreview] = useState<ShadowPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Detail popup: the rewind point whose commit message + changes to show.
  const [detailPoint, setDetailPoint] = useState<RewindPoint | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await shadowLog(sessionId, 200);
      setPoints(data.points || []);
      setBranch(data.branch || "");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Poll while expanded so new turns show up at second-level cadence.
  useEffect(() => {
    if (!open) return;
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [open, refresh]);

  // Step 1: open the diff preview for a point (toggles off if already open).
  const openPreview = async (p: RewindPoint) => {
    if (previewFor === p.hash) { setPreviewFor(null); setPreview(null); return; }
    setPreviewFor(p.hash);
    setPreview(null);
    setPreviewLoading(true);
    setMsg(null);
    try {
      setPreview(await shadowRestorePreview(sessionId, p.hash));
    } catch (e) {
      setMsg(String(e));
      setPreviewFor(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Step 2: actually restore, after the user has seen the diff.
  const confirmRestore = async (p: RewindPoint) => {
    setBusy(p.hash);
    setMsg(null);
    try {
      const res = await shadowRestore(sessionId, p.hash);
      setMsg(res.ok ? "已恢复（旧状态已存为 revert 点，可再回去）。" : "恢复失败。");
      setPreviewFor(null);
      setPreview(null);
      refresh();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleSnapshotNow = async () => {
    setBusy("snap");
    setMsg(null);
    try {
      const res = await shadowSnapshot(sessionId);
      setMsg(res.committed ? "已创建 revert 点。" : "无改动，未创建。");
      refresh();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const fmtTime = (unix: number) => {
    if (!unix) return "";
    const d = new Date(unix * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <div style={{ border: "1px solid var(--bg-hover)", borderRadius: 6, background: "var(--bg-sidebar)" }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer", userSelect: "none" }}
      >
        <span style={{ fontSize: 10, color: "var(--text-faint)" }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-body)" }}>Revert points</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>影子备份 · 不动真实 git</span>
        {branch && <span style={{ fontSize: 10, color: "var(--text-faint)" }}>· {branch}</span>}
        <div style={{ flex: 1 }} />
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); handleSnapshotNow(); }}
            disabled={busy === "snap"}
            title="立刻创建一个 revert 点"
            style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: 11, padding: "3px 10px", borderRadius: 5 }}>
            {busy === "snap" ? "..." : "Snapshot now"}
          </button>
        )}
      </div>

      {open && (
        <div style={{ borderTop: "1px solid var(--bg-hover)", padding: "6px 8px", maxHeight: 280, overflowY: "auto" }}>
          {msg && <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "2px 4px 6px" }}>{msg}</div>}
          {loading && points.length === 0 && <div style={{ fontSize: 12, color: "var(--text-faint)", padding: 8 }}>加载中…</div>}
          {!loading && points.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-faint)", padding: 8 }}>
              暂无 revert 点（完成一个回合后会自动生成）。
            </div>
          )}
          {points.map((p) => (
            <div key={p.hash} style={{ borderBottom: "1px solid var(--bg-hover)" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 6px" }}>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 12, color: "var(--text-body)", wordBreak: "break-word" }}>{p.subject || "(no subject)"}</span>
                  <span style={{ fontSize: 10, color: "var(--text-faint)", display: "flex", gap: 8 }}>
                    <code>{p.short_hash}</code>
                    <span>{fmtTime(p.ts)}</span>
                  </span>
                  {p.prompt && (
                    <span style={{ fontSize: 10, color: "var(--text-muted)", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.prompt}
                    </span>
                  )}
                </span>
                <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => setDetailPoint(p)}
                    disabled={busy === p.hash}
                    title="查看该点的提交信息与变更（弹窗）"
                    style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: 11, padding: "3px 10px", borderRadius: 5 }}>
                    Detail
                  </button>
                  <button
                    onClick={() => openPreview(p)}
                    disabled={busy === p.hash}
                    style={{ background: "var(--bg-hover)", color: "var(--accent-amber)", fontSize: 11, padding: "3px 10px", borderRadius: 5 }}>
                    {previewFor === p.hash ? "收起" : "Restore…"}
                  </button>
                </span>
              </div>

              {previewFor === p.hash && (
                <div style={{ padding: "4px 6px 8px", background: "var(--bg-main)", borderRadius: 5, margin: "0 2px 6px" }}>
                  {previewLoading && <div style={{ fontSize: 11, color: "var(--text-faint)", padding: 4 }}>正在比较差异…</div>}
                  {!previewLoading && preview && (
                    <>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "2px 2px 4px" }}>
                        恢复到此点会改动以下 {preview.files.length} 个文件（被忽略的文件不受影响）：
                      </div>
                      {preview.files.length === 0 ? (
                        <div style={{ fontSize: 11, color: "var(--text-faint)", padding: 4 }}>与当前工作目录一致，无差异。</div>
                      ) : (
                        <FileList files={preview.files} />
                      )}
                      <DiffPre diff={preview.diff} />
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button
                          onClick={() => { setPreviewFor(null); setPreview(null); }}
                          disabled={busy === p.hash}
                          style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: 11, padding: "3px 12px", borderRadius: 5 }}>
                          取消
                        </button>
                        <button
                          onClick={() => confirmRestore(p)}
                          disabled={busy === p.hash}
                          style={{ background: "var(--accent-amber)", color: "#1a1a1a", fontSize: 11, fontWeight: 600, padding: "3px 12px", borderRadius: 5 }}>
                          {busy === p.hash ? "恢复中…" : "确认恢复"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {detailPoint && (
        <ShadowDetailModal sessionId={sessionId} point={detailPoint} onClose={() => setDetailPoint(null)} />
      )}
    </div>
  );
}
