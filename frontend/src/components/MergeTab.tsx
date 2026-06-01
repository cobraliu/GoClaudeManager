import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import hljs from "highlight.js/lib/common";
import {
  getMergeStatus,
  getMergePreview,
  getMergeFileDiff,
  gitMergeStart,
  gitMergeAbort,
  gitMergeContinue,
  getMergeConflictFile,
  gitResolveFile,
  type MergeStatus,
  type MergePreview,
  type ConflictFileVersions,
  type GitBranchInfo,
} from "../api/sessionApi";

interface Props {
  sessionId: string;
  branches: GitBranchInfo;
  setMsg: (msg: string | null) => void;
  /** Called when the merge fully completes (commit succeeded) or is aborted. */
  onCompleted: () => void;
}

export function MergeTab({ sessionId, branches, setMsg, onCompleted }: Props) {
  const [status, setStatus] = useState<MergeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<string>("");
  const [target, setTarget] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [backupBranch, setBackupBranch] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return getMergeStatus(sessionId)
      .then(s => { setStatus(s); return s; })
      .catch(e => { setErr(String(e)); return null; });
  }, [sessionId]);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  // Debounced preview fetch whenever both branches are selected and differ.
  useEffect(() => {
    if (!source || !target || source === target) { setPreview(null); return; }
    let cancelled = false;
    setPreviewLoading(true);
    const handle = setTimeout(async () => {
      try {
        const p = await getMergePreview(sessionId, source, target);
        if (!cancelled) setPreview(p);
      } catch (e) {
        if (!cancelled) setPreview({ merge_kind: "error", error: String(e) });
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [sessionId, source, target]);

  // Default target to main/master; default source to the most-recently-
  // committed branch other than main/master (often what the user just worked on).
  useEffect(() => {
    if (target || !branches.local.length) return;
    const def = branches.local.includes("main")
      ? "main"
      : branches.local.includes("master")
        ? "master"
        : branches.current || branches.local[0];
    setTarget(def);
  }, [target, branches]);

  useEffect(() => {
    if (source || !branches.local.length) return;
    const dated = branches.local_with_dates ?? [];
    const candidates = dated
      .filter(b => b.name !== "main" && b.name !== "master")
      .sort((a, b) => b.committerdate - a.committerdate);
    const def = candidates[0]?.name
      ?? branches.local.find(b => b !== "main" && b !== "master")
      ?? "";
    if (def) setSource(def);
  }, [source, branches]);

  const handleSwap = () => {
    setSource(target);
    setTarget(source);
  };

  const handleStart = async () => {
    if (!source || !target) return;
    if (source === target) {
      setErr("Source and target must be different branches.");
      return;
    }
    setStarting(true);
    setErr(null);
    try {
      const r = await gitMergeStart(sessionId, source, target);
      if (r.up_to_date) {
        setMsg(`${target} is already up to date with ${source}.`);
        onCompleted();
        return;
      }
      if (r.clean) {
        const bk = r.backup_branch ? ` Backup: ${r.backup_branch} (delete with \`git branch -D\` once verified).` : "";
        setMsg(`Merged ${source} into ${target} cleanly.${bk}`);
        onCompleted();
        return;
      }
      // Conflict — stash backup-branch name for the resolver banner, then refresh status.
      setBackupBranch(r.backup_branch ?? null);
      await refresh();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setStarting(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>Loading merge status…</div>;
  }

  if (status?.in_progress) {
    return (
      <MergeResolver
        sessionId={sessionId}
        status={status}
        backupBranch={backupBranch}
        onStatusChange={setStatus}
        onCompleted={() => { setStatus(null); setBackupBranch(null); onCompleted(); }}
        setMsg={setMsg}
      />
    );
  }

  const allBranches = branches.local;
  const canStart = !!source && !!target && source !== target && !starting;
  const selectStyle: React.CSSProperties = {
    background: "var(--bg-surface)", color: "var(--text-body)",
    border: "1px solid var(--text-faintest)", borderRadius: 4,
    padding: "4px 8px", fontSize: 12, fontFamily: "monospace",
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, fontSize: 13, color: "var(--text-body)" }}>
      <div style={{ color: "var(--text-secondary)" }}>
        Merge a source branch into a target branch.
      </div>
      {allBranches.length < 2 ? (
        <div style={{ color: "var(--text-muted)" }}>Need at least 2 local branches to merge.</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Source:</label>
            <select value={source} onChange={(e) => setSource(e.target.value)} style={selectStyle}>
              <option value="">— select source —</option>
              {allBranches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <button
              type="button"
              onClick={handleSwap}
              disabled={!source && !target}
              title="Swap source and target"
              style={{
                background: "var(--bg-surface)",
                color: "var(--text-body)",
                border: "1px solid var(--text-faintest)",
                borderRadius: 4,
                padding: "2px 8px",
                fontSize: 12,
                cursor: source || target ? "pointer" : "default",
                opacity: source || target ? 1 : 0.5,
              }}
            >⇄</button>
            <span style={{ color: "var(--text-faint)" }}>→</span>
            <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Target:</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)} style={selectStyle}>
              <option value="">— select target —</option>
              {allBranches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <button
              disabled={!canStart}
              onClick={handleStart}
              style={{ background: canStart ? "var(--accent-blue)" : "var(--bg-hover)", color: canStart ? "#fff" : "var(--text-faint)", fontSize: 12, padding: "4px 14px" }}
            >
              {starting ? "Merging…" : "Start Merge"}
            </button>
          </div>
          {source && target && source === target && (
            <div style={{ fontSize: 11, color: "var(--accent-amber)" }}>Source and target must differ.</div>
          )}
          {source && target && source !== target && (
            <MergePreviewBlock
              sessionId={sessionId}
              preview={preview}
              loading={previewLoading}
              source={source}
              target={target}
            />
          )}
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Checks out <span style={{ fontFamily: "monospace" }}>{target || "<target>"}</span> (if not already), then runs
            {" "}<span style={{ fontFamily: "monospace" }}>git merge --no-ff --no-edit {source || "<source>"}</span>.
            On conflict, you'll get a 3-pane resolver for each conflicted file.
          </div>
        </>
      )}
      {err && (
        <div style={{ background: "rgba(248,81,73,0.12)", border: "1px solid var(--accent-red)", borderRadius: 4, padding: "8px 10px", color: "var(--text-body)", fontSize: 12, whiteSpace: "pre-wrap" }}>
          {err}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver: per-file 3-pane editor with hunk-level Accept buttons

interface ConflictHunk {
  startLine: number;    // 0-based line index of <<<<<<<
  endLine: number;      // 0-based line index of >>>>>>>
  ours: string[];
  theirs: string[];
}

function parseConflictHunks(content: string): ConflictHunk[] {
  const lines = content.split("\n");
  const hunks: ConflictHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      const startLine = i;
      const ours: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("=======") && !lines[i].startsWith(">>>>>>>")) {
        ours.push(lines[i]);
        i++;
      }
      const theirs: string[] = [];
      if (i < lines.length && lines[i].startsWith("=======")) {
        i++;
        while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
          theirs.push(lines[i]);
          i++;
        }
      }
      if (i < lines.length && lines[i].startsWith(">>>>>>>")) {
        hunks.push({ startLine, endLine: i, ours, theirs });
        i++;
      }
    } else {
      i++;
    }
  }
  return hunks;
}

/** Replace the lines [startLine..endLine] inclusive with the given replacement lines. */
function replaceLines(content: string, startLine: number, endLine: number, replacement: string[]): string {
  const lines = content.split("\n");
  lines.splice(startLine, endLine - startLine + 1, ...replacement);
  return lines.join("\n");
}

function langForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", go: "go", rs: "rust", java: "java", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    rb: "ruby", php: "php", sh: "bash", md: "markdown", json: "json", yaml: "yaml", yml: "yaml",
    html: "html", css: "css", scss: "scss", sql: "sql", xml: "xml", toml: "ini",
  };
  return map[ext] || "plaintext";
}

function MergeResolver({
  sessionId, status, backupBranch, onStatusChange, onCompleted, setMsg,
}: {
  sessionId: string;
  status: MergeStatus;
  backupBranch: string | null;
  onStatusChange: (s: MergeStatus) => void;
  onCompleted: () => void;
  setMsg: (m: string | null) => void;
}) {
  const files = status.conflicted_files;
  const [activeFile, setActiveFile] = useState<string | null>(files[0] ?? null);
  const [versions, setVersions] = useState<ConflictFileVersions | null>(null);
  const [result, setResult] = useState<string>("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [busy, setBusy] = useState<"abort" | "continue" | "resolve" | null>(null);
  const [confirmAbort, setConfirmAbort] = useState(false);
  // When activeFile changes, reload its versions
  useEffect(() => {
    if (!activeFile) { setVersions(null); setResult(""); return; }
    setLoadingFile(true);
    getMergeConflictFile(sessionId, activeFile)
      .then(v => { setVersions(v); setResult(v.working); })
      .catch(e => setMsg(String(e)))
      .finally(() => setLoadingFile(false));
  }, [sessionId, activeFile, setMsg]);

  // Re-pick default file when the conflicted set shrinks
  useEffect(() => {
    if (activeFile && !files.includes(activeFile)) {
      setActiveFile(files[0] ?? null);
    }
  }, [files, activeFile]);

  const hunks = useMemo(() => parseConflictHunks(result), [result]);

  const acceptHunk = (hunk: ConflictHunk, choice: "ours" | "theirs" | "both") => {
    let replacement: string[];
    if (choice === "ours") replacement = hunk.ours;
    else if (choice === "theirs") replacement = hunk.theirs;
    else replacement = [...hunk.ours, ...hunk.theirs];
    setResult(prev => replaceLines(prev, hunk.startLine, hunk.endLine, replacement));
  };

  const handleSaveResolved = async () => {
    if (!activeFile) return;
    setBusy("resolve");
    try {
      const r = await gitResolveFile(sessionId, activeFile, result);
      onStatusChange(r.status);
      setMsg(`Resolved ${activeFile}`);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleContinue = async () => {
    setBusy("continue");
    try {
      const r = await gitMergeContinue(sessionId);
      setMsg(r.output || "Merge completed.");
      onCompleted();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const doAbort = async () => {
    setBusy("abort");
    try {
      const r = await gitMergeAbort(sessionId);
      setMsg(r.output || "Merge aborted.");
      onCompleted();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
      setConfirmAbort(false);
    }
  };

  const allResolved = files.length === 0;
  const hasMarkers = hunks.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 0 }}>
      {backupBranch && (
        <div
          style={{
            padding: "6px 16px",
            fontSize: 11,
            background: "rgba(88,166,255,0.08)",
            borderBottom: "1px solid var(--bg-hover)",
            color: "var(--text-body)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span title="A backup branch was created pointing at the pre-merge HEAD. You can roll back at any time." style={{ color: "var(--accent-blue)" }}>💾 Backup:</span>
          <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{backupBranch}</span>
          <span style={{ color: "var(--text-muted)" }}>
            — to roll back: <span style={{ fontFamily: "monospace" }}>git reset --hard {backupBranch}</span>
          </span>
        </div>
      )}
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", background: "var(--bg-surface)", borderBottom: "1px solid var(--bg-hover)", flexShrink: 0 }}>
        <div style={{ fontSize: 12, color: "var(--text-body)" }}>
          Merging <span style={{ fontFamily: "monospace", color: "var(--accent-amber)" }}>{status.merge_head}</span> into <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{status.current_branch}</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {allResolved ? "All conflicts resolved." : `${files.length} file${files.length === 1 ? "" : "s"} remaining`}
        </div>
        <div style={{ flex: 1 }} />
        <button
          disabled={busy !== null}
          onClick={() => setConfirmAbort(true)}
          style={{ background: "var(--bg-hover)", color: "var(--accent-red)", fontSize: 12, padding: "4px 12px", border: "1px solid var(--accent-red)" }}
        >
          {busy === "abort" ? "Aborting…" : "Abort Merge"}
        </button>
        <button
          disabled={!allResolved || busy !== null}
          onClick={handleContinue}
          style={{ background: allResolved && busy === null ? "#238636" : "var(--bg-hover)", color: allResolved && busy === null ? "#fff" : "var(--text-faint)", fontSize: 12, padding: "4px 14px" }}
        >
          {busy === "continue" ? "Committing…" : "Continue Merge"}
        </button>
      </div>

      {/* Body: file list + 3-pane resolver */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* File list */}
        <div style={{ width: 220, flexShrink: 0, borderRight: "1px solid var(--bg-hover)", overflowY: "auto", background: "var(--bg-surface)" }}>
          <div style={{ padding: "6px 10px", fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Conflicted files
          </div>
          {files.length === 0 && (
            <div style={{ padding: "6px 10px", fontSize: 12, color: "var(--accent-green)" }}>✓ All resolved</div>
          )}
          {files.map(f => (
            <div
              key={f}
              onClick={() => setActiveFile(f)}
              style={{
                padding: "5px 10px", fontSize: 12, fontFamily: "monospace", cursor: "pointer",
                background: f === activeFile ? "rgba(88,166,255,0.15)" : "transparent",
                color: f === activeFile ? "var(--accent-blue)" : "var(--text-body)",
                borderLeft: f === activeFile ? "2px solid var(--accent-blue)" : "2px solid transparent",
                wordBreak: "break-all",
              }}
              title={f}
            >
              {f}
            </div>
          ))}
        </div>

        {/* 3-pane resolver */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {!activeFile ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
              {allResolved ? "All files resolved — click Continue Merge." : "Select a file to resolve."}
            </div>
          ) : loadingFile || !versions ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
              Loading {activeFile}…
            </div>
          ) : (
            <FileResolver
              path={activeFile}
              versions={versions}
              result={result}
              setResult={setResult}
              hunks={hunks}
              onAcceptHunk={acceptHunk}
              onSaveResolved={handleSaveResolved}
              saving={busy === "resolve"}
              hasMarkers={hasMarkers}
            />
          )}
        </div>
      </div>

      {/* Abort confirm */}
      {confirmAbort && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 6000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={busy ? undefined : () => setConfirmAbort(false)}
        >
          <div
            style={{ width: 420, maxWidth: "92vw", background: "var(--bg-base)", border: "1px solid var(--border-strong)", borderRadius: 8, display: "flex", flexDirection: "column" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--bg-hover)", fontSize: 13, fontWeight: 600 }}>Abort merge?</div>
            <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--text-body)" }}>
              This restores the working tree to its state before the merge started. Any resolutions you've saved will be lost.
            </div>
            <div style={{ padding: "10px 14px", borderTop: "1px solid var(--bg-hover)", display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <button onClick={() => setConfirmAbort(false)} disabled={busy !== null} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 12, padding: "5px 12px" }}>Cancel</button>
              <button onClick={doAbort} disabled={busy !== null} style={{ background: "var(--accent-red)", color: "#fff", fontSize: 12, padding: "5px 14px" }}>
                {busy === "abort" ? "Aborting…" : "Abort Merge"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-file 3-pane viewer

function FileResolver({
  path, versions, result, setResult, hunks, onAcceptHunk,
  onSaveResolved, saving, hasMarkers,
}: {
  path: string;
  versions: ConflictFileVersions;
  result: string;
  setResult: (s: string) => void;
  hunks: ConflictHunk[];
  onAcceptHunk: (h: ConflictHunk, choice: "ours" | "theirs" | "both") => void;
  onSaveResolved: () => void;
  saving: boolean;
  hasMarkers: boolean;
}) {
  const lang = langForPath(path);
  const [showRaw, setShowRaw] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <>
      {/* Pane labels */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--bg-hover)", background: "var(--bg-surface)", flexShrink: 0 }}>
        <div style={{ flex: 1, padding: "4px 10px", fontSize: 11, color: "var(--accent-blue)", borderRight: "1px solid var(--bg-hover)" }}>
          Current (ours)
        </div>
        <div style={{ flex: 1, padding: "4px 10px", fontSize: 11, color: "var(--accent-amber)", borderRight: "1px solid var(--bg-hover)" }}>
          Incoming (theirs)
        </div>
        <div style={{ flex: 1, padding: "4px 10px", fontSize: 11, color: "var(--text-body)", display: "flex", alignItems: "center", gap: 8 }}>
          Result
          <button
            onClick={() => setShowRaw(s => !s)}
            style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: 10, padding: "1px 6px" }}
            title={showRaw ? "Switch to hunk-by-hunk view" : "Edit raw text"}
          >
            {showRaw ? "Hunks" : "Raw"}
          </button>
        </div>
      </div>

      {/* Three panes */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <ReadOnlyPane content={versions.ours} lang={lang} />
        <ReadOnlyPane content={versions.theirs} lang={lang} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, borderLeft: "1px solid var(--bg-hover)" }}>
          {showRaw ? (
            <textarea
              ref={textareaRef}
              value={result}
              onChange={(e) => setResult(e.target.value)}
              spellCheck={false}
              style={{
                flex: 1, background: "var(--bg-base)", color: "var(--text-body)",
                border: "none", outline: "none", padding: 8, fontSize: 11,
                fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,"Courier New",monospace',
                resize: "none", whiteSpace: "pre", overflow: "auto",
              }}
            />
          ) : (
            <ResultHunkView
              content={result}
              hunks={hunks}
              lang={lang}
              onAccept={onAcceptHunk}
            />
          )}
        </div>
      </div>

      {/* Footer: save resolved */}
      <div style={{ padding: "6px 12px", borderTop: "1px solid var(--bg-hover)", background: "var(--bg-surface)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {hasMarkers ? `${hunks.length} unresolved hunk${hunks.length === 1 ? "" : "s"}` : "No conflict markers — ready to mark resolved."}
        </span>
        <div style={{ flex: 1 }} />
        <button
          disabled={hasMarkers || saving}
          onClick={onSaveResolved}
          title={hasMarkers ? "Resolve all hunks first" : "git add this file"}
          style={{ background: !hasMarkers && !saving ? "var(--accent-blue)" : "var(--bg-hover)", color: !hasMarkers && !saving ? "#fff" : "var(--text-faint)", fontSize: 12, padding: "4px 14px" }}
        >
          {saving ? "Saving…" : "Mark Resolved"}
        </button>
      </div>
    </>
  );
}

function ReadOnlyPane({ content, lang }: { content: string; lang: string }) {
  const html = useMemo(() => {
    try { return hljs.highlight(content || " ", { language: lang, ignoreIllegals: true }).value; }
    catch { return escapeHtml(content); }
  }, [content, lang]);
  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--bg-base)", borderRight: "1px solid var(--bg-hover)", minWidth: 0 }}>
      <pre style={{ margin: 0, padding: 8, fontSize: 11, fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,"Courier New",monospace', whiteSpace: "pre", color: "var(--text-body)" }}>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render the Result with each conflict hunk inline-replaced by an Accept-buttons widget. */
function ResultHunkView({
  content, hunks, lang, onAccept,
}: {
  content: string;
  hunks: ConflictHunk[];
  lang: string;
  onAccept: (h: ConflictHunk, choice: "ours" | "theirs" | "both") => void;
}) {
  const lines = content.split("\n");

  // Build a sequence of segments: { kind: "text", text } | { kind: "hunk", hunk }
  type Segment = { kind: "text"; text: string } | { kind: "hunk"; hunk: ConflictHunk };
  const segments: Segment[] = [];
  let cursor = 0;
  for (const h of hunks) {
    if (h.startLine > cursor) {
      const text = lines.slice(cursor, h.startLine).join("\n");
      segments.push({ kind: "text", text });
    }
    segments.push({ kind: "hunk", hunk: h });
    cursor = h.endLine + 1;
  }
  if (cursor < lines.length) {
    segments.push({ kind: "text", text: lines.slice(cursor).join("\n") });
  }

  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--bg-base)", minWidth: 0, padding: 0 }}>
      {segments.length === 0 && (
        <div style={{ padding: 12, fontSize: 12, color: "var(--text-muted)" }}>(empty)</div>
      )}
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          if (!seg.text) return null;
          let html = "";
          try { html = hljs.highlight(seg.text, { language: lang, ignoreIllegals: true }).value; }
          catch { html = escapeHtml(seg.text); }
          return (
            <pre key={i} style={{ margin: 0, padding: "0 8px", fontSize: 11, fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,"Courier New",monospace', whiteSpace: "pre", color: "var(--text-body)" }}>
              <code dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
          );
        }
        const h = seg.hunk;
        const oursHtml = (() => { try { return hljs.highlight(h.ours.join("\n"), { language: lang, ignoreIllegals: true }).value; } catch { return escapeHtml(h.ours.join("\n")); } })();
        const theirsHtml = (() => { try { return hljs.highlight(h.theirs.join("\n"), { language: lang, ignoreIllegals: true }).value; } catch { return escapeHtml(h.theirs.join("\n")); } })();
        return (
          <div key={i} style={{ margin: "4px 8px", border: "1px solid var(--accent-amber)", borderRadius: 4, overflow: "hidden", background: "var(--bg-surface)" }}>
            <div style={{ display: "flex", gap: 6, padding: "4px 8px", background: "rgba(187,128,9,0.15)", fontSize: 11, color: "var(--text-secondary)", alignItems: "center" }}>
              <span>Conflict</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => onAccept(h, "ours")} title="Use the Current (ours) version" style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 10, padding: "2px 8px" }}>Accept Current</button>
              <button onClick={() => onAccept(h, "theirs")} title="Use the Incoming (theirs) version" style={{ background: "var(--accent-amber)", color: "#000", fontSize: 10, padding: "2px 8px" }}>Accept Incoming</button>
              <button onClick={() => onAccept(h, "both")} title="Keep both, ours then theirs" style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "2px 8px", border: "1px solid var(--text-faintest)" }}>Accept Both</button>
            </div>
            <div style={{ display: "flex" }}>
              <div style={{ flex: 1, borderRight: "1px solid var(--bg-hover)", background: "rgba(88,166,255,0.08)", minWidth: 0, overflow: "auto" }}>
                <div style={{ padding: "2px 6px", fontSize: 10, color: "var(--accent-blue)", background: "rgba(88,166,255,0.12)" }}>Current</div>
                <pre style={{ margin: 0, padding: "2px 8px", fontSize: 11, fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,"Courier New",monospace', whiteSpace: "pre", color: "var(--text-body)" }}>
                  <code dangerouslySetInnerHTML={{ __html: oursHtml }} />
                </pre>
              </div>
              <div style={{ flex: 1, background: "rgba(187,128,9,0.08)", minWidth: 0, overflow: "auto" }}>
                <div style={{ padding: "2px 6px", fontSize: 10, color: "var(--accent-amber)", background: "rgba(187,128,9,0.12)" }}>Incoming</div>
                <pre style={{ margin: 0, padding: "2px 8px", fontSize: 11, fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,"Courier New",monospace', whiteSpace: "pre", color: "var(--text-body)" }}>
                  <code dangerouslySetInnerHTML={{ __html: theirsHtml }} />
                </pre>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge preview block: status badge + Commits/Diff tabs

const STATUS_COLOR: Record<string, string> = {
  M: "var(--accent-amber)", A: "var(--accent-green)", D: "var(--accent-red)",
  R: "var(--accent-blue)", C: "var(--accent-blue)",
};

function statusBadge(kind: MergePreview["merge_kind"], err?: string): { label: string; color: string; bg: string } {
  switch (kind) {
    case "up_to_date": return { label: "✓ Up to date", color: "var(--accent-green)", bg: "rgba(63,185,80,0.12)" };
    case "fast_forward": return { label: "→ Fast-forward (clean)", color: "var(--accent-blue)", bg: "rgba(88,166,255,0.12)" };
    case "clean": return { label: "✓ Clean merge", color: "var(--accent-green)", bg: "rgba(63,185,80,0.12)" };
    case "conflict": return { label: "⚠ Would conflict", color: "var(--accent-amber)", bg: "rgba(187,128,9,0.15)" };
    case "error": return { label: err ? `✕ ${err}` : "✕ Error", color: "var(--accent-red)", bg: "rgba(248,81,73,0.12)" };
  }
}

function MergePreviewBlock({
  sessionId, preview, loading, source, target,
}: {
  sessionId: string;
  preview: MergePreview | null;
  loading: boolean;
  source: string;
  target: string;
}) {
  const [tab, setTab] = useState<"commits" | "diff">("commits");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const conflictSet = useMemo(
    () => new Set(preview?.conflicting_files ?? []),
    [preview],
  );

  // Default the file selection to the first changed file once the preview arrives.
  useEffect(() => {
    const files = preview?.changed_files;
    if (!files || files.length === 0) { setSelectedFile(null); return; }
    if (!selectedFile || !files.find(f => f.path === selectedFile)) {
      setSelectedFile(files[0].path);
    }
  }, [preview, selectedFile]);

  // Lazy fetch per-file diff when on Diff tab.
  useEffect(() => {
    if (tab !== "diff" || !selectedFile) { setDiff(""); setDiffError(null); return; }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    getMergeFileDiff(sessionId, source, target, selectedFile)
      .then(r => {
        if (cancelled) return;
        if (r.error) { setDiffError(r.error); setDiff(""); }
        else { setDiff(r.diff || ""); }
      })
      .catch(e => { if (!cancelled) { setDiffError(String(e)); setDiff(""); } })
      .finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, source, target, selectedFile, tab]);

  const containerStyle: React.CSSProperties = {
    border: "1px solid var(--bg-hover)", borderRadius: 6,
    background: "var(--bg-surface)", display: "flex", flexDirection: "column",
    fontSize: 12,
  };

  if (loading && !preview) {
    return (
      <div style={{ ...containerStyle, padding: "10px 12px", color: "var(--text-muted)" }}>
        Loading preview for <span style={{ fontFamily: "monospace" }}>{source}</span> → <span style={{ fontFamily: "monospace" }}>{target}</span>…
      </div>
    );
  }
  if (!preview) return null;
  const badge = statusBadge(preview.merge_kind, preview.error);
  const commits = preview.commits ?? [];
  const files = preview.changed_files ?? [];

  return (
    <div style={containerStyle}>
      {/* Status header */}
      <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", borderBottom: "1px solid var(--bg-hover)" }}>
        <span style={{ padding: "2px 8px", borderRadius: 4, background: badge.bg, color: badge.color, fontWeight: 600 }}>
          {badge.label}
        </span>
        {preview.merge_kind !== "error" && (
          <span style={{ color: "var(--text-muted)" }}>
            <span style={{ color: "var(--accent-blue)", fontFamily: "monospace" }}>{source}</span> is{" "}
            <span style={{ color: "var(--text-body)" }}>{preview.ahead ?? 0}</span> commit{preview.ahead === 1 ? "" : "s"} ahead,{" "}
            <span style={{ color: "var(--text-body)" }}>{preview.behind ?? 0}</span> behind{" "}
            <span style={{ color: "var(--accent-amber)", fontFamily: "monospace" }}>{target}</span>
          </span>
        )}
        {loading && <span style={{ color: "var(--text-faint)", fontSize: 11 }}>refreshing…</span>}
      </div>

      {preview.merge_kind === "error" || preview.merge_kind === "up_to_date" ? null : (
        <>
          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid var(--bg-hover)" }}>
            <TabButton active={tab === "commits"} onClick={() => setTab("commits")}>
              Commits {commits.length > 0 && <span style={{ opacity: 0.7 }}>({commits.length})</span>}
            </TabButton>
            <TabButton active={tab === "diff"} onClick={() => setTab("diff")}>
              Code diff {files.length > 0 && <span style={{ opacity: 0.7 }}>({files.length})</span>}
            </TabButton>
          </div>

          {/* Tab body */}
          {tab === "commits" ? (
            <CommitsTabBody commits={commits} />
          ) : (
            <DiffTabBody
              files={files}
              conflictSet={conflictSet}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              diff={diff}
              diffLoading={diffLoading}
              diffError={diffError}
            />
          )}
        </>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "var(--bg-base)" : "transparent",
        color: active ? "var(--accent-blue)" : "var(--text-secondary)",
        border: "none",
        borderBottom: active ? "2px solid var(--accent-blue)" : "2px solid transparent",
        padding: "6px 14px", fontSize: 12, cursor: "pointer", fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}

function CommitsTabBody({ commits }: { commits: MergePreview["commits"] }) {
  if (!commits || commits.length === 0) {
    return <div style={{ padding: "10px 12px", color: "var(--text-muted)" }}>(no commits)</div>;
  }
  return (
    <div style={{ maxHeight: 240, overflowY: "auto" }}>
      {commits.map(c => (
        <div key={c.hash} style={{ padding: "5px 12px", display: "flex", gap: 10, alignItems: "baseline", borderBottom: "1px solid var(--bg-hover)" }}>
          <span style={{ fontFamily: "monospace", color: "var(--accent-amber)", fontSize: 11 }}>{c.short}</span>
          <span style={{ color: "var(--text-body)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.subject}>
            {c.subject}
          </span>
          <span style={{ color: "var(--text-faint)", fontSize: 11, whiteSpace: "nowrap" }} title={c.date}>
            {c.author}
          </span>
        </div>
      ))}
    </div>
  );
}

function DiffTabBody({
  files, conflictSet, selectedFile, onSelectFile,
  diff, diffLoading, diffError,
}: {
  files: Array<{ path: string; status: string }>;
  conflictSet: Set<string>;
  selectedFile: string | null;
  onSelectFile: (p: string) => void;
  diff: string;
  diffLoading: boolean;
  diffError: string | null;
}) {
  if (files.length === 0) {
    return <div style={{ padding: "10px 12px", color: "var(--text-muted)" }}>(no file changes)</div>;
  }
  return (
    <div style={{ display: "flex", minHeight: 200, maxHeight: 360 }}>
      {/* File list */}
      <div style={{ width: 240, flexShrink: 0, borderRight: "1px solid var(--bg-hover)", overflowY: "auto" }}>
        {files.map(f => {
          const isConflict = conflictSet.has(f.path);
          const isActive = f.path === selectedFile;
          return (
            <div
              key={f.path}
              onClick={() => onSelectFile(f.path)}
              title={f.path + (isConflict ? "  (would conflict)" : "")}
              style={{
                padding: "4px 8px", fontSize: 11, fontFamily: "monospace", cursor: "pointer",
                background: isActive ? "rgba(88,166,255,0.15)" : "transparent",
                borderLeft: isActive ? "2px solid var(--accent-blue)" : "2px solid transparent",
                color: isConflict ? "var(--accent-red)" : "var(--text-body)",
                display: "flex", gap: 6, alignItems: "baseline",
              }}
            >
              <span style={{ width: 12, color: STATUS_COLOR[f.status] || "var(--text-muted)" }}>{f.status}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.path}
              </span>
              {isConflict && <span style={{ fontSize: 9, color: "var(--accent-red)" }}>⚠</span>}
            </div>
          );
        })}
      </div>
      {/* Diff viewer */}
      <div style={{ flex: 1, overflow: "auto", background: "var(--bg-base)", minWidth: 0 }}>
        {diffLoading ? (
          <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 12 }}>Loading diff…</div>
        ) : diffError ? (
          <div style={{ padding: 12, color: "var(--accent-red)", fontSize: 12 }}>{diffError}</div>
        ) : !diff ? (
          <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 12 }}>(empty diff)</div>
        ) : (
          <DiffView diff={diff} />
        )}
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre style={{ margin: 0, padding: "6px 10px", fontSize: 11, fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,"Courier New",monospace', whiteSpace: "pre" }}>
      {lines.map((ln, i) => {
        let color = "var(--text-body)";
        let bg = "transparent";
        if (ln.startsWith("+++") || ln.startsWith("---")) { color = "var(--text-faint)"; }
        else if (ln.startsWith("@@")) { color = "var(--accent-blue)"; bg = "rgba(88,166,255,0.08)"; }
        else if (ln.startsWith("+")) { color = "var(--accent-green)"; bg = "rgba(63,185,80,0.08)"; }
        else if (ln.startsWith("-")) { color = "var(--accent-red)"; bg = "rgba(248,81,73,0.08)"; }
        else if (ln.startsWith("diff --git")) { color = "var(--text-faint)"; }
        return (
          <div key={i} style={{ color, background: bg, whiteSpace: "pre" }}>
            {ln || " "}
          </div>
        );
      })}
    </pre>
  );
}
