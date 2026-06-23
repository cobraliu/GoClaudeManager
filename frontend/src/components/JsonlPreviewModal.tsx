import { useState, useEffect, useMemo } from "react";
import { getConversationJsonl, downloadConversationJsonl, downloadConversationBundle, type JsonlPageResponse } from "../api/sessionApi";

// ── Helpers ──────────────────────────────────────────────────────────────────
function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => _execCopy(text));
  } else { _execCopy(text); }
}
function _execCopy(text: string) {
  const el = document.createElement("textarea");
  el.value = text; el.style.cssText = "position:fixed;opacity:0;left:-9999px";
  document.body.appendChild(el); el.focus(); el.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(el);
}

function tryFormatJson(raw: string): string {
  return JSON.stringify(JSON.parse(raw), null, 2);
}

// ── Read-only cell popup ──────────────────────────────────────────────────────
function ValuePopup({ value, columnName, onClose }: { value: string; columnName: string; onClose: () => void }) {
  const [formatted, setFormatted] = useState<string | null>(null);
  const [fmtError, setFmtError] = useState<string | null>(null);

  const handleFormat = () => {
    if (formatted !== null) { setFormatted(null); setFmtError(null); return; }
    try { setFormatted(tryFormatJson(value)); setFmtError(null); }
    catch { setFmtError("Invalid JSON"); }
  };

  const display = formatted ?? value;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--bg-surface)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: 20, maxWidth: "70vw", maxHeight: "70vh", minWidth: 400, overflow: "hidden", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0, flexWrap: "wrap", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{columnName}</span>
            <button onClick={handleFormat} style={{ background: formatted !== null ? "var(--accent-blue)" : "var(--btn-icon-bg)", color: "#fff", fontSize: 10, padding: "2px 10px" }}>
              {formatted !== null ? "Raw" : "Format JSON"}
            </button>
            {fmtError && <span style={{ fontSize: 11, color: "var(--accent-red)" }}>{fmtError}</span>}
            <button onClick={() => copyText(display)} style={{ background: "#2d1a4a", color: "#a78bfa", border: "1px solid #4c1d95", fontSize: 10, padding: "2px 10px" }}>Copy</button>
          </div>
          <button onClick={onClose} style={{ background: "var(--btn-icon-bg)", color: "var(--text-secondary)", fontSize: 11, padding: "2px 8px" }}>✕</button>
        </div>
        <pre style={{ margin: 0, flex: 1, overflow: "auto", color: formatted !== null ? "#a5d6ff" : "var(--text-primary)", fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,monospace', fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {display}
        </pre>
      </div>
    </div>
  );
}

// ── JSONL table viewer ────────────────────────────────────────────────────────
function jsonlPageSize(colCount: number): number {
  const raw = Math.round((5000 / Math.max(1, colCount)) / 10) * 10;
  return Math.min(500, Math.max(10, raw));
}

function JsonlViewer({ content, pageOffset = 0, paginate = true }: { content: string; pageOffset?: number; paginate?: boolean }) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [expandedCell, setExpandedCell] = useState<{ value: string; col: string } | null>(null);
  const [page, setPage] = useState(0);

  const { headers, rows } = useMemo(() => {
    const keyOrder: string[] = [];
    const keySet = new Set<string>();
    const parsed: Record<string, unknown>[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
          for (const k of Object.keys(obj as object)) {
            if (!keySet.has(k)) { keySet.add(k); keyOrder.push(k); }
          }
          parsed.push(obj as Record<string, unknown>);
        } else {
          if (!keySet.has("_value")) { keySet.add("_value"); keyOrder.push("_value"); }
          parsed.push({ _value: obj });
        }
      } catch {
        if (!keySet.has("_raw")) { keySet.add("_raw"); keyOrder.push("_raw"); }
        parsed.push({ _raw: trimmed });
      }
    }
    return { headers: keyOrder, rows: parsed };
  }, [content]);

  const cellStr = (val: unknown): string => {
    if (val === undefined || val === null) return "";
    if (typeof val === "string") return val;
    return JSON.stringify(val);
  };

  const sortedRows = useMemo(() => {
    if (sortCol === null) return rows;
    return [...rows].sort((a, b) => {
      const av = cellStr(a[sortCol]);
      const bv = cellStr(b[sortCol]);
      const an = Number(av), bn = Number(bv);
      const cmp = (!isNaN(an) && !isNaN(bn) && av !== "" && bv !== "")
        ? an - bn : av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
      return sortAsc ? cmp : -cmp;
    });
  }, [rows, sortCol, sortAsc]);

  const handleHeaderClick = (col: string) => {
    if (sortCol === col) {
      if (!sortAsc) { setSortCol(null); setSortAsc(true); } else setSortAsc(false);
    } else { setSortCol(col); setSortAsc(true); }
    setPage(0);
  };

  if (rows.length === 0) return <div style={{ color: "var(--text-muted)", padding: 16, fontSize: 13 }}>Empty or invalid JSONL</div>;

  const pageSize = paginate ? jsonlPageSize(headers.length) : sortedRows.length;
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const pageRows = paginate ? sortedRows.slice(page * pageSize, (page + 1) * pageSize) : sortedRows;
  const MAX_CELL = 80;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {expandedCell && (
        <ValuePopup value={expandedCell.value} columnName={expandedCell.col} onClose={() => setExpandedCell(null)} />
      )}
      <div style={{ overflow: "auto", flex: 1 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%", whiteSpace: "nowrap" }}>
          <thead>
            <tr style={{ background: "var(--bg-surface)", position: "sticky", top: 0 }}>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-strong)", color: "var(--text-faint)", textAlign: "right", fontWeight: 400, userSelect: "none", minWidth: 36, fontSize: 11 }}>#</th>
              {headers.map((h) => (
                <th key={h} onClick={() => handleHeaderClick(h)}
                  style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-strong)", color: sortCol === h ? "var(--accent-blue)" : "var(--text-secondary)", textAlign: "left", fontWeight: 600, cursor: "pointer", userSelect: "none" }}>
                  {h}
                  <span style={{ marginLeft: 4, fontSize: 10, opacity: sortCol === h ? 1 : 0.25 }}>
                    {sortCol === h ? (sortAsc ? "▲" : "▼") : "▲"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, ri) => {
              const absIdx = page * pageSize + ri;
              return (
                <tr key={absIdx} style={{ background: ri % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}>
                  <td style={{ padding: "4px 8px", borderBottom: "1px solid var(--bg-hover)", color: "var(--text-faint)", fontFamily: "monospace", textAlign: "right", userSelect: "none", fontSize: 11 }}>{pageOffset + absIdx + 1}</td>
                  {headers.map((col) => {
                    const val = row[col];
                    const missing = val === undefined;
                    const isNull = val === null;
                    const str = missing || isNull ? "" : cellStr(val);
                    const isNested = !missing && !isNull && typeof val === "object";
                    const truncated = str.length > MAX_CELL;
                    return (
                      <td key={col}
                        onClick={() => !missing && !isNull && setExpandedCell({ value: str, col })}
                        title={truncated ? "Click to view full content" : undefined}
                        style={{
                          padding: "4px 12px", borderBottom: "1px solid var(--bg-hover)",
                          color: missing || isNull ? "var(--text-faint)" : isNested ? "#a78bfa" : "var(--text-primary)",
                          fontFamily: "monospace", maxWidth: 300, overflow: "hidden",
                          textOverflow: "ellipsis", cursor: !missing && !isNull ? "pointer" : "default", whiteSpace: "nowrap",
                        }}
                        onMouseEnter={(e) => { if (!missing && !isNull) e.currentTarget.style.background = "rgba(88,166,255,0.08)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
                      >
                        {missing || isNull ? <span style={{ color: "var(--text-faint)" }}>{isNull ? "null" : "—"}</span> : str}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Pagination bar */}
      {totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "6px 12px", borderTop: "1px solid var(--bg-hover)", background: "var(--bg-surface)", flexShrink: 0, fontSize: 12 }}>
          <button disabled={page === 0} onClick={() => setPage(0)} style={{ background: "var(--btn-icon-bg)", color: page === 0 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 8px" }}>«</button>
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} style={{ background: "var(--btn-icon-bg)", color: page === 0 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 8px" }}>‹</button>
          <span style={{ color: "var(--text-muted)" }}>{page + 1} / {totalPages}</span>
          <span style={{ color: "var(--text-faint)", fontSize: 11 }}>({sortedRows.length} rows)</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} style={{ background: "var(--btn-icon-bg)", color: page >= totalPages - 1 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 8px" }}>›</button>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)} style={{ background: "var(--btn-icon-bg)", color: page >= totalPages - 1 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 8px" }}>»</button>
        </div>
      )}
    </div>
  );
}

const SERVER_PAGE_SIZE = 200;

// ── Modal ─────────────────────────────────────────────────────────────────────
interface Props {
  sessionId: string;
  sessionTitle: string;
  onClose: () => void;
  /** When true, render as an inline panel (no fixed-position backdrop). */
  inline?: boolean;
}

export function JsonlPreviewModal({ sessionId, sessionTitle, onClose, inline = false }: Props) {
  const [data, setData] = useState<JsonlPageResponse | null>(null);
  const [serverPage, setServerPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jumpInput, setJumpInput] = useState("");
  const [downloading, setDownloading] = useState<"" | "jsonl" | "bundle">("");

  const runDownload = (kind: "jsonl" | "bundle") => {
    if (downloading) return;
    setDownloading(kind);
    const fn = kind === "jsonl" ? downloadConversationJsonl : downloadConversationBundle;
    fn(sessionId)
      .catch((e) => setError(String(e)))
      .finally(() => setDownloading(""));
  };

  useEffect(() => {
    setLoading(true);
    setError(null);
    getConversationJsonl(sessionId, serverPage, SERVER_PAGE_SIZE)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [sessionId, serverPage]);

  const totalServerPages = data ? Math.max(1, Math.ceil(data.total / SERVER_PAGE_SIZE)) : 1;
  const lineStart = serverPage * SERVER_PAGE_SIZE + 1;
  const lineEnd = data ? lineStart + data.lines.length - 1 : lineStart;

  const handleJump = () => {
    const n = parseInt(jumpInput, 10);
    if (!isNaN(n) && n >= 1 && n <= totalServerPages) {
      setServerPage(n - 1);
    }
    setJumpInput("");
  };

  const outerStyle: React.CSSProperties = inline
    ? { width: "100%", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-base)" }
    : { position: "fixed", inset: 0, zIndex: 3000, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center" };
  const innerStyle: React.CSSProperties = inline
    ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }
    : { width: "92vw", height: "88vh", background: "var(--bg-base)", borderRadius: 10, border: "1px solid var(--border-strong)", display: "flex", flexDirection: "column", overflow: "hidden" };

  return (
    <div onClick={inline ? undefined : onClose} style={outerStyle}>
      <div onClick={(e) => e.stopPropagation()} style={innerStyle}>
        {/* Header */}
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--bg-hover)", background: "var(--bg-surface)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--text-secondary)", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            📄 {sessionTitle} — conversation.jsonl
          </span>
          {/* Download controls — kept right after the title so they stay
              prominent (and reachable) even on a narrow phone where the
              pagination controls wrap to a later row. */}
          <button
            onClick={() => runDownload("jsonl")}
            disabled={!!downloading}
            title="Download the raw .jsonl transcript"
            style={{ background: "var(--btn-icon-bg)", color: "var(--text-secondary)", fontSize: 11, padding: "4px 8px", flexShrink: 0, opacity: downloading ? 0.5 : 1 }}
          >{downloading === "jsonl" ? "…" : "⤓ jsonl"}</button>
          <button
            onClick={() => runDownload("bundle")}
            disabled={!!downloading}
            title="Download transcript + subagents/tool-results + memory as a zip"
            style={{ background: "var(--btn-icon-bg)", color: "var(--text-secondary)", fontSize: 11, padding: "4px 8px", flexShrink: 0, opacity: downloading ? 0.5 : 1 }}
          >{downloading === "bundle" ? "…" : "⤓ bundle"}</button>
          {data && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                lines {lineStart}–{lineEnd} / {data.total}
              </span>
              <button
                disabled={serverPage === 0 || loading}
                onClick={() => setServerPage(0)}
                style={{ background: "var(--btn-icon-bg)", color: serverPage === 0 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 7px" }}
              >«</button>
              <button
                disabled={serverPage === 0 || loading}
                onClick={() => setServerPage((p) => p - 1)}
                style={{ background: "var(--btn-icon-bg)", color: serverPage === 0 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 7px" }}
              >‹</button>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{serverPage + 1}/{totalServerPages}</span>
              <button
                disabled={serverPage >= totalServerPages - 1 || loading}
                onClick={() => setServerPage((p) => p + 1)}
                style={{ background: "var(--btn-icon-bg)", color: serverPage >= totalServerPages - 1 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 7px" }}
              >›</button>
              <button
                disabled={serverPage >= totalServerPages - 1 || loading}
                onClick={() => setServerPage(totalServerPages - 1)}
                style={{ background: "var(--btn-icon-bg)", color: serverPage >= totalServerPages - 1 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 7px" }}
              >»</button>
              {totalServerPages > 2 && (
                <>
                  <input
                    value={jumpInput}
                    onChange={(e) => setJumpInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleJump(); }}
                    placeholder="Go to…"
                    style={{
                      width: 58, fontSize: 11, padding: "2px 6px",
                      background: "var(--bg-hover)", border: "1px solid var(--text-faintest)",
                      borderRadius: 4, color: "var(--text-body)", outline: "none",
                    }}
                  />
                  <button
                    disabled={loading}
                    onClick={handleJump}
                    style={{ background: "var(--btn-icon-bg)", color: "var(--text-secondary)", fontSize: 11, padding: "2px 7px" }}
                  >Go</button>
                </>
              )}
            </div>
          )}
          <button onClick={onClose} style={{ background: "var(--btn-icon-bg)", color: "var(--text-secondary)", fontSize: 12, padding: "4px 10px" }}>✕</button>
        </div>
        {/* Body */}
        {error ? (
          <div style={{ padding: 24, color: "var(--accent-red)", fontSize: 13 }}>{error}</div>
        ) : loading || data === null ? (
          <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
        ) : (
          <JsonlViewer content={data.lines.join("\n")} pageOffset={serverPage * SERVER_PAGE_SIZE} paginate={false} />
        )}
      </div>
    </div>
  );
}
