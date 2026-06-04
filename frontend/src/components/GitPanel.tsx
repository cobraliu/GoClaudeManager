import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import gitIcon from "../assets/git.svg";
import type { GitLogEntry, GitDiffFile, GitGraphCommit, GitBranchInfo } from "../api/sessionApi";
import {
  getGitInfo,
  getCommitDetail,
  searchGitCommits,
  gitManualCommit,
  gitRollback,
  gitDiff,
  saveGitignore,
  gitSetRemote,
  gitPush,
  getGitBranches,
  getGitGraph,
  getMergeStatus,
  type MergeStatus,
} from "../api/sessionApi";
import { GitGraph } from "./GitGraph";
import { ConfirmAffectingChangeModal } from "./GitBranchPicker";
import { MergeTab } from "./MergeTab";
import { ShadowRewindSection } from "./ShadowRewindSection";

interface Props {
  sessionId: string;
  onClose: () => void;
  /** When true, render as an inline panel (no fixed-position backdrop). */
  inline?: boolean;
}

const CONTEXT_LINES = 3; // lines of context around each hunk

interface Hunk {
  startIdx: number; // index into leftRows/rightRows
  endIdx: number;   // exclusive
}

/** Compute hunks: groups of changed rows with CONTEXT_LINES padding on each side */
function computeHunks(leftRows: DiffRow[]): Hunk[] {
  const changed: number[] = [];
  leftRows.forEach((r, i) => {
    if (r.type !== "same" && r.type !== "empty") changed.push(i);
    // also check if this row is "empty" (placeholder for added) — check rightRows via partner
  });
  // include "empty" rows on left (partner is "added") as changed
  leftRows.forEach((r, i) => {
    if (r.type === "empty") changed.push(i);
  });
  const changedSet = new Set(changed);
  if (changedSet.size === 0) return [];

  const total = leftRows.length;
  const hunks: Hunk[] = [];
  let start = -1, end = -1;
  for (let i = 0; i < total; i++) {
    if (changedSet.has(i)) {
      if (start === -1) start = Math.max(0, i - CONTEXT_LINES);
      end = Math.min(total, i + CONTEXT_LINES + 1);
    } else if (start !== -1 && i >= end) {
      hunks.push({ startIdx: start, endIdx: end });
      start = -1; end = -1;
    }
  }
  if (start !== -1) hunks.push({ startIdx: start, endIdx: end });

  // merge overlapping
  const merged: Hunk[] = [];
  for (const h of hunks) {
    if (merged.length && h.startIdx <= merged[merged.length - 1].endIdx) {
      merged[merged.length - 1].endIdx = Math.max(merged[merged.length - 1].endIdx, h.endIdx);
    } else {
      merged.push({ ...h });
    }
  }
  return merged;
}

function _fmtDiffDate(raw: string): string {
  // raw: "2024-03-15 14:23:45 +0800" or "2024-03-15T14:23:45+08:00"
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})[\sT](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return raw.slice(0, 16);
  return `${m[1]}${m[2]}${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/* ─── Synchronized side-by-side diff pane ─── */
function SideBySideDiff({
  files, mode, onModeChange, hashes,
}: {
  files: GitDiffFile[];
  mode: "full" | "onlydiff";
  onModeChange: (m: "full" | "onlydiff") => void;
  hashes?: { hash: string; date: string }[];
}) {
  const [selectedPath, setSelectedPath] = useState(files[0]?.path ?? "");
  const [hunkIdx, setHunkIdx] = useState(0);
  const [listWidth, setListWidth] = useState(180);
  const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onDragStart = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startW: listWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const newW = Math.max(80, Math.min(500, dragRef.current.startW + ev.clientX - dragRef.current.startX));
      setListWidth(newW);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const selected = files.find((f) => f.path === selectedPath) ?? files[0];
  const { leftRows, rightRows } = useMemo(() =>
    selected
      ? computeSideBySide(selected.old_content.split("\n"), selected.new_content.split("\n"))
      : { leftRows: [], rightRows: [] },
    [selected]
  );

  const hunks = useMemo(() => computeHunks(leftRows), [leftRows]);

  // Reset navigation when file or mode changes
  useEffect(() => { setHunkIdx(0); }, [selectedPath, mode]);

  const scrollToHunk = (idx: number) => {
    const el = hunkRefs.current[idx];
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 40, behavior: "smooth" });
    }
  };

  const goHunk = (delta: number) => {
    const next = Math.max(0, Math.min(hunks.length - 1, hunkIdx + delta));
    setHunkIdx(next);
    scrollToHunk(next);
  };

  // Rows to render
  const visibleSegments: { rows: [DiffRow, DiffRow][]; hunkIndex: number | null; labelLeft?: string; labelRight?: string }[] = useMemo(() => {
    if (mode === "full") {
      return [{ rows: leftRows.map((r, i) => [r, rightRows[i]] as [DiffRow, DiffRow]), hunkIndex: null }];
    }
    if (hunks.length === 0) return [];
    return hunks.map((h, hi) => {
      const lSlice = leftRows.slice(h.startIdx, h.endIdx);
      const rSlice = rightRows.slice(h.startIdx, h.endIdx);
      const oldStart = lSlice.find(r => r.lineNo !== null)?.lineNo ?? h.startIdx + 1;
      const oldEnd = [...lSlice].reverse().find(r => r.lineNo !== null)?.lineNo ?? h.endIdx;
      const newStart = rSlice.find(r => r.lineNo !== null)?.lineNo ?? h.startIdx + 1;
      const newEnd = [...rSlice].reverse().find(r => r.lineNo !== null)?.lineNo ?? h.endIdx;
      return {
        rows: lSlice.map((r, ii) => [r, rSlice[ii]] as [DiffRow, DiffRow]),
        hunkIndex: hi,
        labelLeft: `@@ -${oldStart}–${oldEnd} @@`,
        labelRight: `@@ +${newStart}–${newEnd} @@`,
      };
    });
  }, [mode, leftRows, rightRows, hunks]);

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* file list */}
      <div style={{ width: listWidth, flexShrink: 0, borderRight: "none", overflowY: "auto", padding: "6px 0" }}>
        {files.map((f) => (
          <div key={f.path} onClick={() => setSelectedPath(f.path)}
            style={{ padding: "5px 10px", fontSize: 11, fontFamily: "monospace", cursor: "pointer", background: f.path === selectedPath ? "rgba(88,166,255,0.15)" : "transparent", color: f.path === selectedPath ? "var(--accent-blue)" : "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            title={f.path}>{f.path}</div>
        ))}
      </div>
      {/* drag handle */}
      <div
        onMouseDown={onDragStart}
        style={{ width: 5, flexShrink: 0, cursor: "col-resize", background: "transparent", borderLeft: "1px solid var(--bg-hover)", borderRight: "1px solid var(--bg-hover)" }}
      />

      {/* right pane */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* toolbar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", background: "var(--bg-surface)", borderBottom: "1px solid var(--bg-hover)", flexShrink: 0 }}>
          {/* mode toggle */}
          <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: "1px solid var(--text-faintest)" }}>
            {(["onlydiff", "full"] as const).map((m) => (
              <button key={m} onClick={() => onModeChange(m)}
                style={{ padding: "2px 10px", fontSize: 11, background: mode === m ? "var(--text-faintest)" : "transparent", color: mode === m ? "var(--text-body)" : "var(--text-muted)", border: "none", cursor: "pointer" }}>
                {m === "onlydiff" ? "Only Diff" : "Full"}
              </button>
            ))}
          </div>
          {/* selected file path + hunk nav together (left-aligned) */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0, overflow: "hidden" }}>
            {selectedPath && (
              <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--accent-blue)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1, minWidth: 0 }} title={selectedPath}>
                {selectedPath}
              </span>
            )}
            {mode === "onlydiff" && hunks.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{hunks.length} hunk{hunks.length > 1 ? "s" : ""}</span>
                <button onClick={() => goHunk(-1)} disabled={hunkIdx === 0}
                  style={{ padding: "2px 8px", fontSize: 11, background: "var(--bg-hover)", color: hunkIdx === 0 ? "var(--text-faint)" : "var(--text-secondary)", border: "1px solid var(--text-faintest)", borderRadius: 4, cursor: hunkIdx === 0 ? "default" : "pointer" }}>
                  ‹ Prev
                </button>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{hunkIdx + 1} / {hunks.length}</span>
                <button onClick={() => goHunk(1)} disabled={hunkIdx === hunks.length - 1}
                  style={{ padding: "2px 8px", fontSize: 11, background: "var(--bg-hover)", color: hunkIdx === hunks.length - 1 ? "var(--text-faint)" : "var(--text-secondary)", border: "1px solid var(--text-faintest)", borderRadius: 4, cursor: hunkIdx === hunks.length - 1 ? "default" : "pointer" }}>
                  Next ›
                </button>
              </div>
            )}
            {mode === "onlydiff" && hunks.length === 0 && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>No changes</span>
            )}
          </div>
        </div>

        {/* scrollable diff area */}
        <div ref={scrollRef} style={{ flex: 1, overflow: "auto", fontFamily: "monospace", fontSize: 12 }}>
          {/* sticky column headers */}
          <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 2 }}>
            <div style={{ flex: 1, padding: "3px 8px", background: "var(--bg-surface)", color: "var(--text-muted)", fontSize: 11, borderBottom: "1px solid var(--bg-hover)", borderRight: "1px solid var(--bg-hover)" }}>
              {hashes ? <><span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{hashes[0].hash.slice(0, 8)}</span>{" "}<span>{_fmtDiffDate(hashes[0].date)}</span></> : "Before"}
            </div>
            <div style={{ flex: 1, padding: "3px 8px", background: "var(--bg-surface)", color: "var(--text-muted)", fontSize: 11, borderBottom: "1px solid var(--bg-hover)" }}>
              {hashes ? <><span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{hashes[1].hash.slice(0, 8)}</span>{" "}<span>{_fmtDiffDate(hashes[1].date)}</span></> : "After"}
            </div>
          </div>

          {visibleSegments.map((seg, si) => (
            <div key={si} ref={(el) => { if (seg.hunkIndex !== null) hunkRefs.current[seg.hunkIndex] = el; }}>
              {/* hunk separator */}
              {mode === "onlydiff" && seg.labelLeft && (
                <div style={{ display: "flex", background: "var(--bg-surface)", borderTop: si > 0 ? "2px solid var(--border)" : undefined }}>
                  <div style={{ flex: 1, padding: "2px 8px", color: "var(--accent-blue)", fontSize: 11, fontFamily: "monospace", borderRight: "1px solid var(--bg-hover)" }}>{seg.labelLeft}</div>
                  <div style={{ flex: 1, padding: "2px 8px", color: "var(--accent-blue)", fontSize: 11, fontFamily: "monospace" }}>{seg.labelRight}</div>
                </div>
              )}
              {seg.rows.map(([leftRow, rightRow], i) => (
                <div key={i} style={{ display: "flex" }}>
                  <div style={{ flex: 1, borderRight: "1px solid var(--bg-hover)", minWidth: 0 }}>
                    <DiffLine row={leftRow} side="old" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <DiffLine row={rightRow} side="new" />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Diff viewer modal ─── */
export function DiffViewer({ files, title, hashes, onClose, zIndex = 5000 }: { files: GitDiffFile[]; title?: string; hashes?: { hash: string; date: string }[]; onClose: () => void; zIndex?: number }) {
  const [mode, setMode] = useState<"full" | "onlydiff">("onlydiff");
  if (!files.length) return null;
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex }}
      onClick={onClose}
    >
      <div
        style={{ width: "95vw", height: "90vh", background: "var(--bg-base)", borderRadius: 10, border: "1px solid var(--border-strong)", display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "8px 14px", background: "var(--bg-surface)", borderBottom: "1px solid var(--bg-hover)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{title ?? "Diff Viewer"}</span>
          <button onClick={onClose} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 12, padding: "4px 10px" }}>✕</button>
        </div>
        <SideBySideDiff files={files} mode={mode} onModeChange={setMode} hashes={hashes} />
      </div>
    </div>
  );
}

/* ─── Commit detail modal ─── */
export function CommitDetailModal({
  sessionId, entry, onClose,
}: { sessionId: string; entry: GitLogEntry; onClose: () => void }) {
  const [fullMessage, setFullMessage] = useState<string | null>(null);
  const [diffFiles, setDiffFiles] = useState<GitDiffFile[] | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Fetch full message on open
  useEffect(() => {
    getCommitDetail(sessionId, entry.hash)
      .then((d) => setFullMessage(d.message ?? entry.subject))
      .catch(() => setFullMessage(entry.subject));
  }, [sessionId, entry.hash]);

  const handleShowChanges = async () => {
    setLoadingDiff(true);
    setErr(null);
    try {
      const detail = await getCommitDetail(sessionId, entry.hash);
      if (detail.files.length === 0) setErr("No file changes in this commit.");
      else setDiffFiles(detail.files);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoadingDiff(false);
    }
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5000 }}
      onClick={onClose}
    >
      <div
        style={{ width: 620, maxWidth: "95vw", maxHeight: "80vh", background: "var(--bg-base)", borderRadius: 10, border: "1px solid var(--border-strong)", display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div style={{ padding: "8px 14px", background: "var(--bg-surface)", borderBottom: "1px solid var(--bg-hover)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--accent-blue)" }}>{entry.short_hash}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{entry.author} · {new Date(entry.date).toLocaleString()}</span>
          </div>
          <button onClick={onClose} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 12, padding: "4px 10px" }}>✕</button>
        </div>

        {/* full message */}
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          <pre style={{ margin: 0, fontFamily: "monospace", fontSize: 13, color: "var(--text-body)", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.6 }}>
            {fullMessage ?? "Loading..."}
          </pre>

          {err && <div style={{ fontSize: 12, color: "var(--accent-red)" }}>{err}</div>}

          <button
            disabled={loadingDiff}
            onClick={handleShowChanges}
            style={{ alignSelf: "flex-start", background: "var(--accent-green)", color: "#fff", fontSize: 12, padding: "5px 14px" }}
          >
            {loadingDiff ? "Loading..." : "Show file changes"}
          </button>
        </div>
      </div>

      {/* diff viewer layered on top */}
      {diffFiles && (
        <DiffViewer
          files={diffFiles}
          title={`Changes in ${entry.short_hash}`}
          onClose={() => setDiffFiles(null)}
          zIndex={5100}
        />
      )}
    </div>
  );
}

type RowType = "same" | "removed" | "added" | "empty";
interface DiffRow { lineNo: number | null; text: string; type: RowType; }

function DiffLine({ row, side }: { row: DiffRow; side: "old" | "new" }) {
  const bg = row.type === "empty" ? "var(--bg-base)" : row.type === "removed" ? "var(--diff-del-bg)" : row.type === "added" ? "var(--diff-add-bg)" : "transparent";
  const prefixColor = row.type === "removed" ? "var(--diff-del-prefix)" : row.type === "added" ? "var(--diff-add-prefix)" : "var(--text-faint)";
  const textColor = row.type === "removed" ? "var(--diff-del-text)" : row.type === "added" ? "var(--diff-add-text)" : "var(--text-body)";
  const prefix = row.type === "empty" ? " " : row.type === "removed" && side === "old" ? "-" : row.type === "added" && side === "new" ? "+" : " ";
  return (
    <div style={{ display: "flex", background: bg, minHeight: 20, lineHeight: "20px" }}>
      <span style={{ width: 40, flexShrink: 0, color: "var(--text-faint)", textAlign: "right", paddingRight: 8, userSelect: "none", fontSize: 11, borderRight: "1px solid var(--bg-hover)" }}>{row.lineNo ?? ""}</span>
      <span style={{ color: prefixColor, paddingLeft: 4, width: 14, flexShrink: 0 }}>{prefix}</span>
      <span style={{ color: textColor, paddingLeft: 2, whiteSpace: "pre-wrap", wordBreak: "break-all", flex: 1, minWidth: 0 }}>{row.text}</span>
    </div>
  );
}

function computeSideBySide(oldLines: string[], newLines: string[]): { leftRows: DiffRow[]; rightRows: DiffRow[] } {
  const edits = lcsEdits(oldLines, newLines);
  const left: DiffRow[] = [], right: DiffRow[] = [];
  for (const edit of edits) {
    if (edit.type === "same") {
      left.push({ lineNo: edit.oldLine, text: edit.text, type: "same" });
      right.push({ lineNo: edit.newLine, text: edit.text, type: "same" });
    } else if (edit.type === "removed") {
      left.push({ lineNo: edit.oldLine, text: edit.text, type: "removed" });
      right.push({ lineNo: null, text: "", type: "empty" });
    } else {
      left.push({ lineNo: null, text: "", type: "empty" });
      right.push({ lineNo: edit.newLine, text: edit.text, type: "added" });
    }
  }
  return { leftRows: left, rightRows: right };
}

type EditType = "same" | "removed" | "added";
interface Edit { type: EditType; text: string; oldLine: number; newLine: number; }

// LCS limit: O(m*n) matrix — cap at 1500 lines each to avoid browser freeze.
// Beyond that, fall back to a simple removed-then-added diff (no alignment).
const LCS_LINE_LIMIT = 1500;

function lcsEdits(oldL: string[], newL: string[]): Edit[] {
  if (oldL.length > LCS_LINE_LIMIT || newL.length > LCS_LINE_LIMIT) {
    // Simple fallback: all removals then all additions
    const edits: Edit[] = [];
    oldL.forEach((text, i) => edits.push({ type: "removed", text, oldLine: i + 1, newLine: 0 }));
    newL.forEach((text, j) => edits.push({ type: "added",   text, oldLine: 0,     newLine: j + 1 }));
    return edits;
  }
  const m = oldL.length, n = newL.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldL[i-1] === newL[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const edits: Edit[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldL[i-1] === newL[j-1]) { edits.push({ type: "same", text: oldL[i-1], oldLine: i, newLine: j }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { edits.push({ type: "added", text: newL[j-1], oldLine: i, newLine: j }); j--; }
    else { edits.push({ type: "removed", text: oldL[i-1], oldLine: i, newLine: j }); i--; }
  }
  return edits.reverse();
}

const PAGE_SIZE = 20;

/* ─── Git Panel ─── */
export function GitPanel({ sessionId, onClose, inline = false }: Props) {
  // Manual commit form (subject required, body optional).
  const [commitSubject, setCommitSubject] = useState("");
  const [commitBody, setCommitBody] = useState("");
  // allLog holds the complete history fetched once on open
  const [allLog, setAllLog] = useState<GitLogEntry[]>([]);
  const [logPage, setLogPage] = useState(0);
  const [logSearch, setLogSearch] = useState("");
  const [deepMode, setDeepMode] = useState(false);
  const [deepResults, setDeepResults] = useState<GitLogEntry[] | null>(null);
  const [deepSearching, setDeepSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [diffFiles, setDiffFiles] = useState<GitDiffFile[] | null>(null);
  type DiffSide = { hash: string; date: string };
  const [diffHashes, setDiffHashes] = useState<[DiffSide, DiffSide] | null>(null);
  const [detailEntry, setDetailEntry] = useState<GitLogEntry | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [gitignore, setGitignore] = useState("");
  const [gitignoreEditing, setGitignoreEditing] = useState(false);
  const [gitignoreDraft, setGitignoreDraft] = useState("");
  const [remote, setRemote] = useState("");
  const [remoteDraft, setRemoteDraft] = useState("");
  const [remoteEditing, setRemoteEditing] = useState(false);
  // Branch + view mode
  const [branches, setBranches] = useState<GitBranchInfo>({ current: "", local: [] });
  // scope: "current" (= current branch HEAD), "all", or specific local branch name
  const [scope, setScope] = useState<string>("current");
  const [viewMode, setViewMode] = useState<"list" | "graph">("list");
  const [graphCommits, setGraphCommits] = useState<GitGraphCommit[] | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  // Revert confirm state
  const [revertCandidate, setRevertCandidate] = useState<{ hash: string; short: string } | null>(null);
  // Top-level tab: history (the existing view) vs merge (conflict resolver)
  const [activeTab, setActiveTab] = useState<"history" | "merge">("history");
  // Surfaced when a merge is half-done (in_progress) — drives a banner in the History tab.
  const [mergeStatus, setMergeStatus] = useState<MergeStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const [info, br, ms] = await Promise.all([
        getGitInfo(sessionId),
        getGitBranches(sessionId).catch(() => ({ current: "", local: [] }) as GitBranchInfo),
        getMergeStatus(sessionId).catch(() => null),
      ]);
      setAllLog(info.log);
      setGitignore(info.gitignore ?? "");
      setRemote(info.remote ?? "");
      setRemoteDraft(info.remote ?? "");
      setBranches(br);
      setMergeStatus(ms);
    } catch (e) {
      setMsg(`Failed to load git info: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  // Fetch graph data whenever scope changes (used by both Graph view and non-current List view).
  // For the default "current" scope we already have allLog for list mode, so skip extra fetch
  // unless graph mode is active.
  useEffect(() => {
    if (scope === "current" && viewMode === "list") {
      setGraphCommits(null);
      return;
    }
    setGraphLoading(true);
    getGitGraph(sessionId, scope, 500)
      .then(setGraphCommits)
      .catch((e) => { setMsg(String(e)); setGraphCommits([]); })
      .finally(() => setGraphLoading(false));
  }, [sessionId, viewMode, scope, allLog.length]);

  // Unified list source: when scope == "current" use allLog (rich, paginated). When scope is
  // a specific branch or "all", project the graph fetch into GitLogEntry shape.
  const scopedLog: GitLogEntry[] = useMemo(() => {
    if (scope === "current") return allLog;
    if (!graphCommits) return [];
    return graphCommits.map(c => ({
      hash: c.hash, short_hash: c.short_hash, subject: c.subject,
      author: c.author, date: c.date,
    }));
  }, [scope, allLog, graphCommits]);

  // Derived: filter + paginate entirely in the browser (list mode)
  const filteredLog = useMemo(() => {
    if (deepMode) return deepResults ?? [];
    const base = scope === "current" ? allLog : scopedLog;
    if (!logSearch.trim()) return base;
    const q = logSearch.toLowerCase();
    return base.filter(e => e.subject.toLowerCase().includes(q) || e.short_hash.includes(q));
  }, [allLog, scopedLog, scope, logSearch, deepMode, deepResults]);

  const totalPages = Math.max(1, Math.ceil(filteredLog.length / PAGE_SIZE));
  const safePage = Math.min(logPage, totalPages - 1);
  const pageLog = filteredLog.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const handleSearchChange = (val: string) => {
    setLogSearch(val);
    setLogPage(0);
    if (deepMode) setDeepResults(null); // clear deep results when query changes
  };

  const handleDeepSearch = async () => {
    if (!logSearch.trim()) return;
    setDeepSearching(true);
    setDeepResults(null);
    setLogPage(0);
    try {
      const results = await searchGitCommits(sessionId, logSearch.trim());
      setDeepResults(results);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setDeepSearching(false);
    }
  };

  const toggleDeepMode = () => {
    const next = !deepMode;
    setDeepMode(next);
    setDeepResults(null);
    setLogPage(0);
  };

  const handleManualCommit = async () => {
    const subject = commitSubject.trim();
    if (!subject) return;
    setBusyId("commit");
    try {
      const body = commitBody.trim();
      const message = body ? `${subject}\n\n${body}` : subject;
      const res = await gitManualCommit(sessionId, message);
      setMsg(res.committed ? `Committed.` : "Nothing to commit.");
      setCommitSubject("");
      setCommitBody("");
      load();
    } catch (e) { setMsg(String(e)); } finally { setBusyId(null); }
  };

  const handleRollback = (hash: string) => {
    setRevertCandidate({ hash, short: hash.slice(0, 8) });
  };

  const doRollback = async () => {
    if (!revertCandidate) return;
    const { hash } = revertCandidate;
    setBusyId(hash);
    try {
      const res = await gitRollback(sessionId, hash);
      setMsg(res.output);
      setRevertCandidate(null);
      load();
    } catch (e) {
      setMsg(String(e));
      throw e;
    } finally {
      setBusyId(null);
    }
  };

  const handleDiff = async () => {
    if (checked.length !== 2) return;
    // Older = higher index in allLog (newest-first order)
    const idxA = allLog.findIndex((e) => e.hash === checked[0]);
    const idxB = allLog.findIndex((e) => e.hash === checked[1]);
    const entryOld = idxA > idxB ? allLog[idxA] : allLog[idxB];
    const entryNew = idxA > idxB ? allLog[idxB] : allLog[idxA];
    const [oldHash, newHash] = [entryOld.hash, entryNew.hash];
    setBusyId("diff");
    try {
      const res = await gitDiff(sessionId, oldHash, newHash);
      if (res.files.length === 0) setMsg("No file differences between these commits.");
      else {
        setDiffFiles(res.files);
        setDiffHashes([
          { hash: oldHash, date: entryOld.date },
          { hash: newHash, date: entryNew.date },
        ]);
      }
    } catch (e) { setMsg(String(e)); } finally { setBusyId(null); }
  };

  const toggleCheck = (hash: string) => {
    setChecked((prev) => {
      if (prev.includes(hash)) return prev.filter((h) => h !== hash);
      if (prev.length >= 2) return prev;
      return [...prev, hash];
    });
  };

  const handleSaveGitignore = async () => {
    setBusyId("gitignore");
    try {
      await saveGitignore(sessionId, gitignoreDraft);
      setGitignore(gitignoreDraft);
      setGitignoreEditing(false);
      setMsg("Saved .gitignore");
    } catch (e) { setMsg(String(e)); } finally { setBusyId(null); }
  };

  const handleSaveRemote = async () => {
    setBusyId("remote");
    try {
      await gitSetRemote(sessionId, remoteDraft);
      setRemote(remoteDraft);
      setRemoteEditing(false);
      setMsg(remoteDraft ? `Remote set to: ${remoteDraft}` : "Remote removed.");
    } catch (e) { setMsg(String(e)); } finally { setBusyId(null); }
  };

  const handlePush = async () => {
    if (!remote) return;
    setBusyId("push");
    try {
      const res = await gitPush(sessionId);
      setMsg(res.output);
    } catch (e) { setMsg(String(e)); } finally { setBusyId(null); }
  };

  const outerStyle: React.CSSProperties = inline
    ? { width: "100%", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-base)" }
    : { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 4000 };
  const innerStyle: React.CSSProperties = inline
    ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }
    : { width: 960, maxWidth: "97vw", maxHeight: "90vh", background: "var(--bg-base)", borderRadius: 10, border: "1px solid var(--border-strong)", display: "flex", flexDirection: "column", overflow: "hidden" };

  return (
    <div
      style={outerStyle}
      onClick={inline ? undefined : onClose}
    >
      <div
        style={innerStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div style={{ padding: "10px 16px", background: "var(--bg-surface)", borderBottom: "1px solid var(--bg-hover)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-body)", display: "flex", alignItems: "center", gap: 6 }}><img src={gitIcon} style={{ width: 16, height: 16, filter: "invert(1)" }} /> Git</span>
          <button onClick={onClose} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 12, padding: "4px 10px" }}>✕</button>
        </div>

        {/* tabs */}
        <div style={{ display: "flex", background: "var(--bg-surface)", borderBottom: "1px solid var(--bg-hover)", flexShrink: 0 }}>
          {(["history", "merge"] as const).map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              style={{
                background: activeTab === t ? "var(--bg-base)" : "transparent",
                color: activeTab === t ? "var(--accent-blue)" : "var(--text-secondary)",
                borderBottom: activeTab === t ? "2px solid var(--accent-blue)" : "2px solid transparent",
                borderRadius: 0, padding: "6px 18px", fontSize: 12, fontWeight: 600,
              }}
            >
              {t === "history" ? "History" : "Merge"}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: activeTab === "merge" ? 0 : "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          {/* status message */}
          {msg && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", background: "var(--bg-surface)", borderRadius: 4, padding: activeTab === "merge" ? "6px 16px" : "6px 10px", fontFamily: "monospace", wordBreak: "break-all" }}>
              {msg}
              <button onClick={() => setMsg(null)} style={{ float: "right", background: "transparent", color: "var(--text-faint)", fontSize: 11 }}>✕</button>
            </div>
          )}

          {activeTab === "merge" ? (
            <MergeTab
              sessionId={sessionId}
              branches={branches}
              onCompleted={() => { setActiveTab("history"); load(); }}
              setMsg={setMsg}
            />
          ) : loading ? (
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</span>
          ) : (
            <>
              {mergeStatus?.in_progress && (
                <div
                  style={{
                    background: "rgba(248,81,73,0.12)",
                    border: "1px solid var(--accent-red)",
                    borderRadius: 4,
                    padding: "8px 12px",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 12,
                    color: "var(--text-body)",
                  }}
                >
                  <span style={{ color: "var(--accent-red)", fontSize: 14 }}>⚠</span>
                  <span>
                    Merge in progress — <span style={{ fontFamily: "monospace", color: "var(--accent-amber)" }}>{mergeStatus.merge_head}</span> into <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{mergeStatus.current_branch}</span>.
                    {mergeStatus.conflicted_files.length > 0 && (
                      <> {mergeStatus.conflicted_files.length} file{mergeStatus.conflicted_files.length === 1 ? "" : "s"} with conflicts.</>
                    )}
                  </span>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={() => setActiveTab("merge")}
                    style={{ background: "var(--accent-red)", color: "#fff", fontSize: 11, padding: "4px 12px" }}
                  >
                    Resolve →
                  </button>
                </div>
              )}
              {/* ── Commit form (subject required, body optional) ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    value={commitSubject}
                    onChange={(e) => setCommitSubject(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleManualCommit(); }}
                    placeholder="Commit subject (required)"
                    style={{ flex: 1, fontSize: 13, padding: "5px 8px", background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)", borderRadius: 6, color: "var(--text-body)" }}
                  />
                  <button
                    disabled={busyId === "commit" || !commitSubject.trim()}
                    onClick={handleManualCommit}
                    title="提交真实工作目录(Cmd/Ctrl+Enter)"
                    style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 11, padding: "5px 14px", borderRadius: 6, opacity: commitSubject.trim() ? 1 : 0.5, cursor: commitSubject.trim() ? "pointer" : "not-allowed", flexShrink: 0 }}>
                    {busyId === "commit" ? "..." : "Commit now"}
                  </button>
                </div>
                <textarea
                  value={commitBody}
                  onChange={(e) => setCommitBody(e.target.value)}
                  placeholder="Body (optional)"
                  rows={2}
                  style={{ fontSize: 12, padding: "5px 8px", background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)", borderRadius: 6, color: "var(--text-body)", resize: "vertical", fontFamily: "inherit" }}
                />
              </div>

              {/* ── Rewind points (shadow git, independent of the real .git) ── */}
              <ShadowRewindSection sessionId={sessionId} />

              {/* ── Remote / Push + .gitignore row ── */}
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {/* Remote */}
                <div style={{ flex: 1, display: "flex", gap: 6, alignItems: "center", background: "var(--bg-sidebar)", borderRadius: 6, padding: "6px 8px", border: "1px solid var(--bg-hover)", minWidth: 0 }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>Remote:</span>
                  {remoteEditing ? (
                    <>
                      <input
                        autoFocus
                        value={remoteDraft}
                        onChange={(e) => setRemoteDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSaveRemote(); if (e.key === "Escape") { setRemoteEditing(false); setRemoteDraft(remote); } }}
                        placeholder="https://github.com/user/repo.git"
                        style={{ flex: 1, background: "var(--bg-base)", border: "1px solid var(--text-faintest)", borderRadius: 4, padding: "4px 8px", color: "var(--text-body)", fontSize: 12, outline: "none", minWidth: 0 }}
                      />
                      <button disabled={busyId === "remote"} onClick={handleSaveRemote} style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 11, padding: "3px 10px" }}>
                        {busyId === "remote" ? "..." : "Save"}
                      </button>
                      <button onClick={() => { setRemoteEditing(false); setRemoteDraft(remote); }} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 11, padding: "3px 8px" }}>✕</button>
                    </>
                  ) : (
                    <>
                      <span
                        onClick={() => setRemoteEditing(true)}
                        style={{ flex: 1, fontSize: 12, fontFamily: "monospace", color: remote ? "var(--accent-blue)" : "var(--text-faint)", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
                        title={remote || "Click to set remote URL"}
                      >
                        {remote || "(no remote)"}
                      </span>
                      <button
                        disabled={!remote || busyId === "push"}
                        onClick={handlePush}
                        title={remote ? "Push to remote" : "Set a remote URL first"}
                        style={{ background: remote ? "#238636" : "var(--bg-hover)", color: remote ? "#fff" : "var(--text-faint)", fontSize: 11, padding: "3px 10px", flexShrink: 0 }}
                      >
                        {busyId === "push" ? "Pushing..." : "Push"}
                      </button>
                    </>
                  )}
                </div>
                {/* .gitignore */}
                <button
                  onClick={() => { setGitignoreEditing(true); setGitignoreDraft(gitignore); }}
                  style={{ display: "flex", alignItems: "center", gap: 5, background: "var(--bg-surface)", border: "1px solid var(--text-faintest)", borderRadius: 6, padding: "6px 10px", cursor: "pointer", flexShrink: 0 }}
                >
                  <span style={{ fontFamily: "monospace", color: "var(--accent-blue)", fontSize: 12 }}>.gitignore</span>
                </button>
              </div>

              {/* ── .gitignore modal ── */}
              {gitignoreEditing && (
                <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
                  onClick={() => setGitignoreEditing(false)}>
                  <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border-strong)", borderRadius: 8, width: "min(700px, 92vw)", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
                    onClick={(e) => e.stopPropagation()}>
                    <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-strong)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-body)", fontFamily: "monospace" }}>.gitignore</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button disabled={busyId === "gitignore"} onClick={handleSaveGitignore}
                          style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 12, padding: "4px 14px", border: "none", borderRadius: 4, cursor: "pointer" }}>
                          {busyId === "gitignore" ? "Saving…" : "Save"}
                        </button>
                        <button onClick={() => setGitignoreEditing(false)}
                          style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 12, padding: "4px 10px", border: "none", borderRadius: 4, cursor: "pointer" }}>✕</button>
                      </div>
                    </div>
                    <textarea
                      autoFocus
                      value={gitignoreDraft}
                      onChange={(e) => setGitignoreDraft(e.target.value)}
                      style={{ flex: 1, background: "var(--bg-base)", color: "var(--text-body)", fontFamily: "monospace", fontSize: 13, border: "none", outline: "none", padding: "12px 14px", resize: "none", minHeight: 400 }}
                    />
                  </div>
                </div>
              )}

              {/* ── Diff selection bar — only when at least 1 commit selected ── */}
              {checked.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", background: "var(--bg-surface)", borderRadius: 6, border: "1px solid var(--text-faintest)", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>Compare:</span>
                  {checked.map((hash) => {
                    const entry = allLog.find((e) => e.hash === hash);
                    return (
                      <span key={hash} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--bg-hover)", borderRadius: 4, padding: "2px 8px", fontSize: 11 }}>
                        <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{hash.slice(0, 7)}</span>
                        <span style={{ color: "var(--text-secondary)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry?.subject}</span>
                        <button onClick={() => toggleCheck(hash)} style={{ background: "transparent", color: "var(--text-faint)", fontSize: 11, padding: "0 2px", lineHeight: 1 }}>✕</button>
                      </span>
                    );
                  })}
                  <button
                    disabled={checked.length !== 2 || busyId === "diff"}
                    onClick={handleDiff}
                    style={{ marginLeft: "auto", background: checked.length === 2 ? "var(--accent-blue)" : "var(--bg-hover)", color: checked.length === 2 ? "#fff" : "var(--text-faint)", fontSize: 11, padding: "4px 14px", flexShrink: 0 }}
                  >
                    {busyId === "diff" ? "..." : "Diff"}
                  </button>
                </div>
              )}

              {/* ── Branch selector + view mode toggle ── */}
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Scope:</label>
                <select
                  value={scope}
                  onChange={(e) => { setScope(e.target.value); setLogPage(0); setChecked([]); }}
                  style={{ background: "var(--bg-hover)", color: "var(--text-body)", border: "1px solid var(--text-faintest)", borderRadius: 4, padding: "3px 6px", fontSize: 11, fontFamily: "monospace" }}
                >
                  <option value="current">Current branch{branches.current ? ` (${branches.current})` : ""}</option>
                  <option value="all">All branches</option>
                  {branches.local.filter(b => b !== branches.current).map(b => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
                <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: "1px solid var(--text-faintest)", marginLeft: "auto" }}>
                  {(["list", "graph"] as const).map((m) => (
                    <button key={m} onClick={() => setViewMode(m)}
                      style={{ padding: "2px 12px", fontSize: 11, background: viewMode === m ? "var(--text-faintest)" : "transparent", color: viewMode === m ? "var(--text-body)" : "var(--text-muted)", border: "none", cursor: "pointer" }}>
                      {m === "list" ? "List" : "Graph"}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Commit log: search + list ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {/* search + stats row */}
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    placeholder={deepMode ? "Deep search full message... (Enter)" : "Search commits..."}
                    value={logSearch}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && deepMode) handleDeepSearch(); }}
                    style={{ flex: 1, background: "var(--bg-hover)", border: `1px solid ${deepMode ? "#6366f1" : "var(--text-faintest)"}`, borderRadius: 4, padding: "5px 8px", color: "var(--text-body)", fontSize: 12, outline: "none" }}
                  />
                  {deepMode && (
                    <button
                      onClick={handleDeepSearch}
                      disabled={deepSearching || !logSearch.trim()}
                      style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 11, padding: "4px 10px", borderRadius: 4, flexShrink: 0 }}
                    >
                      {deepSearching ? "..." : "Search"}
                    </button>
                  )}
                  <button
                    onClick={toggleDeepMode}
                    title={deepMode ? "Switch to list search" : "Switch to deep search (full message)"}
                    style={{ background: deepMode ? "#4f46e5" : "var(--text-faintest)", color: deepMode ? "#c7d2fe" : "var(--text-secondary)", fontSize: 11, padding: "4px 10px", borderRadius: 4, flexShrink: 0 }}
                  >
                    {deepMode ? "Deep ✓" : "Deep"}
                  </button>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0, whiteSpace: "nowrap" }}>
                    {deepMode
                      ? deepResults !== null ? `${deepResults.length} found` : ""
                      : logSearch ? `${filteredLog.length} / ${allLog.length}` : `${allLog.length}`} commits
                    {!deepMode && totalPages > 1 && ` · p${safePage + 1}/${totalPages}`}
                  </span>
                </div>

                {viewMode === "graph" ? (
                  graphLoading ? (
                    <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading graph…</span>
                  ) : (
                    <GitGraph
                      commits={graphCommits ?? []}
                      latestHash={(graphCommits ?? [])[0]?.hash ?? null}
                      selectedHashes={checked}
                      onToggleCheck={toggleCheck}
                      checkDisabled={(h) => checked.length >= 2 && !checked.includes(h)}
                      busyHash={busyId}
                      onRevert={(c) => handleRollback(c.hash)}
                      onCommitClick={(c) => setDetailEntry({ hash: c.hash, short_hash: c.short_hash, subject: c.subject, author: c.author, date: c.date })}
                    />
                  )
                ) : pageLog.length === 0 ? (
                  <span style={{ fontSize: 13, color: "var(--text-faint)" }}>{logSearch ? "No matching commits." : "No commits yet."}</span>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {pageLog.map((entry, idx) => (
                      <CommitRow
                        key={entry.hash}
                        entry={entry}
                        isLatest={safePage === 0 && idx === 0}
                        checked={checked.includes(entry.hash)}
                        checkDisabled={checked.length >= 2 && !checked.includes(entry.hash)}
                        busy={busyId === entry.hash}
                        onToggleCheck={() => toggleCheck(entry.hash)}
                        onRollback={() => handleRollback(entry.hash)}
                        onDetail={() => setDetailEntry(entry)}
                      />
                    ))}
                  </div>
                )}

                {/* pagination — list mode only */}
                {viewMode === "list" && totalPages > 1 && (
                  <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, paddingTop: 4 }}>
                    <button disabled={safePage === 0} onClick={() => setLogPage(safePage - 1)}
                      style={{ background: "var(--text-faintest)", color: "var(--text-body)", fontSize: 11, padding: "3px 10px" }}>← Prev</button>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{safePage + 1} / {totalPages}</span>
                    <button disabled={safePage >= totalPages - 1} onClick={() => setLogPage(safePage + 1)}
                      style={{ background: "var(--text-faintest)", color: "var(--text-body)", fontSize: 11, padding: "3px 10px" }}>Next →</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {diffFiles && <DiffViewer files={diffFiles} hashes={diffHashes ?? undefined} onClose={() => { setDiffFiles(null); setDiffHashes(null); }} />}
      {detailEntry && (
        <CommitDetailModal
          sessionId={sessionId}
          entry={detailEntry}
          onClose={() => setDetailEntry(null)}
        />
      )}
      {revertCandidate && (
        <ConfirmAffectingChangeModal
          sessionId={sessionId}
          title={`Revert to ${revertCandidate.short}`}
          description={
            <span>
              This will reset the working tree to commit{" "}
              <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{revertCandidate.short}</span>
              {" "}and create a new commit. Intermediate history is preserved.
            </span>
          }
          actionLabel="Revert"
          busyLabel="Reverting…"
          onCancel={() => setRevertCandidate(null)}
          onConfirm={doRollback}
        />
      )}
    </div>
  );
}

function CommitRow({
  entry, isLatest, checked, checkDisabled, busy, onToggleCheck, onRollback, onDetail,
}: {
  entry: GitLogEntry; isLatest: boolean; checked: boolean; checkDisabled: boolean;
  busy: boolean; onToggleCheck: () => void; onRollback: () => void; onDetail: () => void;
}) {
  const d = new Date(entry.date);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${d.getMonth()+1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "3px 6px", borderRadius: 4, background: checked ? "rgba(88,166,255,0.08)" : "var(--bg-sidebar)", border: checked ? "1px solid #58a6ff44" : "1px solid var(--bg-hover)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={checked} disabled={checkDisabled} onChange={onToggleCheck}
          style={{ cursor: checkDisabled ? "not-allowed" : "pointer", flexShrink: 0, margin: 0 }}
          title={checkDisabled ? "Already 2 commits selected" : "Select for diff"} />
        <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--accent-blue)", flexShrink: 0 }}>{entry.short_hash}</span>
        <span style={{ flex: 1, fontSize: 12, color: "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry.subject}>{entry.subject}</span>
        <span style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0, whiteSpace: "nowrap" }}>{entry.author}</span>
        <span style={{ fontSize: 10, color: "var(--text-faintest)", flexShrink: 0, whiteSpace: "nowrap" }}>{dateStr}</span>
        <button onClick={(e) => { e.stopPropagation(); onDetail(); }}
          style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: 10, padding: "2px 6px", flexShrink: 0 }}
          title="View full commit details">Detail</button>
        {!isLatest && (
          <button disabled={busy} onClick={(e) => { e.stopPropagation(); onRollback(); }}
            style={{ background: "var(--bg-hover)", color: "var(--accent-amber)", fontSize: 10, padding: "2px 6px", flexShrink: 0, border: "1px solid var(--border)" }}
            title="Rollback to this commit">
            {busy ? "..." : "Revert"}
          </button>
        )}
      </div>
      {entry.context && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace", paddingLeft: 20, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={entry.context}>
          ↳ {entry.context}
        </div>
      )}
    </div>
  );
}
