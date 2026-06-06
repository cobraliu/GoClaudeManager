import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import gitIcon from "../assets/git.svg";
import downloadIcon from "../assets/download.svg";
import moveIcon from "../assets/move.svg";
import renameIcon from "../assets/rename.svg";
import { DownloadExclusionModal } from "./DownloadExclusionModal";
import { FileIcon, NewFolderIcon } from "./FileIcon";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";
import { marked } from "../lib/markdown";
import { ConfigFormatToggle } from "./ConfigFormatToggle";
import { ConfigCheckButton } from "./ConfigCheckButton";
import { ConfigValidationBanner } from "./ConfigValidationBanner";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { detectFormat, convert, extFor, type ConfigFormat } from "../lib/configConvert";
import { useFsWatch, type FsChange } from "../lib/useFsWatch";
import {
  listFiles,
  searchFiles,
  readFile,
  writeFile,
  fetchRawFileBlob,
  mediaFileUrl,
  downloadFile,
  getDirInfo,
  downloadDirZip,
  uploadFile,
  type DirInfoResponse,
  // used only for type annotation of dlModal state

  createDir,
  sqliteQuery,
  sqliteExec,
  renameEntry,
  moveEntry,
  listArchive,
  extractArchive,
  getFileGitLog,
  getFileGitShow,
  getFileGitDiff,
  type FileEntry,
  type SqliteInfo,
  type SqliteExecResult,
} from "../api/sessionApi";

interface Props {
  sessionId: string;
  sessionCwd: string;
  onClose: () => void;
}

interface NodeState {
  entries: FileEntry[];
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  error?: string;
}


type FileKind = "edit" | "code" | "csv" | "jsonl" | "markdown" | "sqlite" | "pdf" | "image" | "audio" | "video";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "tiff", "tif", "ico", "svg", "heic", "heif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "mov", "m4v", "mkv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]);

function getExt(path: string): string {
  return path.split(".").pop()?.toLowerCase() || "";
}

const CODE_EXTS = new Set([
  "py", "pyx", "pyi",
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "css", "scss", "sass", "less",
  "html", "htm", "xml", "svg",
  "sh", "bash", "zsh", "fish",
  "go", "rs", "java", "kt", "scala",
  "c", "h", "cpp", "cc", "cxx", "hpp",
  "rb", "php", "swift", "cs",
  "sql", "graphql", "proto",
  "tf", "hcl",
  "yaml", "yml", "toml", "json",
  "r", "lua",
]);

function getFileKind(path: string, isSqlite: boolean): FileKind {
  if (isSqlite) return "sqlite";
  const ext = getExt(path);
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "jsonl") return "jsonl";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (CODE_EXTS.has(ext)) return "code";
  return "edit";
}

interface OpenFile {
  path: string;
  content: string;
  savedContent: string;
  kind: FileKind;
  isSqlite: boolean;
  size?: number;  // bytes, for binary files
}

// ── File type icons (shared via ./FileIcon) ──────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// ── Directory Picker ─────────────────────────────────────────────────────────
export function DirPicker({
  sessionId,
  value,
  onChange,
}: {
  sessionId: string;
  value: string;       // current selected path (relative to session cwd, "" = root)
  onChange: (path: string) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch subdirs of the given path
  const fetchDirs = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const res = await listFiles(sessionId, path || undefined);
      setEntries(res.entries.filter((e) => e.type === "dir" && !e.is_skipped));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { fetchDirs(value); }, [fetchDirs, value]);

  // Breadcrumb parts: ["", "a", "a/b", "a/b/c"]
  const parts = value ? ["", ...value.split("/").map((_, i, arr) => arr.slice(0, i + 1).join("/"))] : [""];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {/* Breadcrumbs */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2, alignItems: "center", fontSize: 10, color: "var(--text-muted)" }}>
        {parts.map((p, i) => {
          const label = i === 0 ? "/ (cwd)" : p.split("/").pop()!;
          const isLast = i === parts.length - 1;
          return (
            <span key={p} style={{ display: "flex", alignItems: "center", gap: 2 }}>
              {i > 0 && <span style={{ color: "var(--text-faintest)" }}>/</span>}
              <span
                onClick={() => !isLast && onChange(p)}
                style={{ color: isLast ? "var(--text-secondary)" : "var(--accent-blue)", cursor: isLast ? "default" : "pointer", fontFamily: "monospace" }}
              >
                {label}
              </span>
            </span>
          );
        })}
        {loading && <span style={{ color: "var(--text-faintest)" }}>…</span>}
      </div>
      {/* Subdir list */}
      {entries.length > 0 && (
        <div style={{ maxHeight: 120, overflowY: "auto", background: "var(--bg-base)", border: "1px solid #1f2937", borderRadius: 4 }}>
          {entries.map((e) => (
            <div
              key={e.path}
              onClick={() => onChange(e.path)}
              style={{ padding: "3px 8px", fontSize: 11, color: "var(--text-secondary)", cursor: "pointer", fontFamily: "monospace", display: "flex", alignItems: "center", gap: 5 }}
              onMouseEnter={(el) => (el.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={(el) => (el.currentTarget.style.background = "")}
            >
              <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center" }}><FileIcon isDir size={12} /></span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
            </div>
          ))}
        </div>
      )}
      {!loading && entries.length === 0 && (
        <span style={{ fontSize: 10, color: "var(--text-faintest)", fontStyle: "italic" }}>No subdirectories</span>
      )}
    </div>
  );
}

// ── Tree node renderer ───────────────────────────────────────────────────────
const _hoverBtnStyle: React.CSSProperties = {
  display: "none",
  alignItems: "center",
  justifyContent: "center",
  height: 16,
  padding: "0 5px",
  borderRadius: 3,
  background: "var(--text-faintest)",
  color: "var(--text-secondary)",
  fontSize: 10,
  flexShrink: 0,
  cursor: "pointer",
  lineHeight: 1,
  whiteSpace: "nowrap",
};

function TreeEntries({
  entries,
  tree,
  depth,
  openPath,
  onToggle,
  onOpen,
  onNewFileInDir,
  renamingPath,
  renameValue,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onMoveStart,
  onDownloadEntry,
  onListArchive,
  onExtractArchive,
  onFileHistory,
}: {
  entries: FileEntry[];
  tree: Record<string, NodeState>;
  depth: number;
  openPath: string | null;
  onToggle: (path: string, loaded: boolean) => void;
  onOpen: (entry: FileEntry) => void;
  onNewFileInDir: (dirPath: string) => void;
  renamingPath: string | null;
  renameValue: string;
  onRenameStart: (entry: FileEntry) => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onMoveStart: (entry: FileEntry) => void;
  onDownloadEntry: (entry: FileEntry) => void;
  onListArchive: (entry: FileEntry) => void;
  onExtractArchive: (entry: FileEntry) => void;
  onFileHistory: (entry: FileEntry) => void;
}) {
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renamingPath && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingPath]);

  const childProps = { tree, openPath, onToggle, onOpen, onNewFileInDir, renamingPath, renameValue, onRenameStart, onRenameChange, onRenameCommit, onRenameCancel, onMoveStart, onDownloadEntry, onListArchive, onExtractArchive, onFileHistory };

  return (
    <>
      {entries.map((entry) => {
        const indent = 8 + depth * 16;
        const childNode = tree[entry.path];
        const isExpanded = childNode?.expanded ?? false;
        const isOpen = entry.path === openPath;
        const isClickable = entry.is_text || entry.is_sqlite || getExt(entry.name) === "pdf" || IMAGE_EXTS.has(getExt(entry.name)) || VIDEO_EXTS.has(getExt(entry.name)) || AUDIO_EXTS.has(getExt(entry.name));
        const isRenaming = renamingPath === entry.path;

        if (entry.type === "dir") {
          return (
            <div key={entry.path}>
              <div
                className="tree-dir-row"
                onClick={() =>
                  !isRenaming && !entry.is_skipped &&
                  onToggle(entry.path, childNode?.loaded ?? false)
                }
                style={{
                  padding: `3px 8px 3px ${indent}px`,
                  cursor: entry.is_skipped ? "default" : "pointer",
                  color: entry.is_skipped ? "var(--text-faint)" : "var(--text-secondary)",
                  fontSize: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  userSelect: "none",
                  borderRadius: 3,
                  position: "relative",
                }}
                onMouseEnter={(e) => {
                  if (!entry.is_skipped && !isRenaming) {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.querySelectorAll(".tree-hover-btn").forEach((b) => ((b as HTMLElement).style.display = "flex"));
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.querySelectorAll(".tree-hover-btn").forEach((b) => ((b as HTMLElement).style.display = "none"));
                }}
              >
                <span style={{ fontSize: 9, width: 10, flexShrink: 0, color: "var(--text-muted)" }}>
                  {entry.is_skipped ? "" : isExpanded ? "▼" : "▶"}
                </span>
                <FileIcon isDir isOpen={isExpanded} size={13} />
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => onRenameChange(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") { e.preventDefault(); onRenameCommit(); }
                      if (e.key === "Escape") { e.preventDefault(); onRenameCancel(); }
                    }}
                    style={{ flex: 1, background: "var(--bg-base)", border: "1px solid #58a6ff", borderRadius: 3, padding: "1px 5px", color: "var(--text-body)", fontSize: 11, outline: "none", minWidth: 0 }}
                  />
                ) : (
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {entry.name}
                    {entry.is_skipped && <span style={{ color: "var(--text-faintest)", fontSize: 10 }}> (skipped)</span>}
                  </span>
                )}
                {childNode?.loading && <span style={{ color: "var(--text-faint)", fontSize: 10 }}>…</span>}
                {!entry.is_skipped && !isRenaming && (
                  <>
                    <span
                      className="tree-hover-btn"
                      onClick={(e) => { e.stopPropagation(); onNewFileInDir(entry.path); }}
                      title={`New file in ${entry.name}`}
                      style={{ ..._hoverBtnStyle, width: 16, padding: 0 }}
                    >+</span>
                    <span
                      className="tree-hover-btn"
                      onClick={(e) => { e.stopPropagation(); onRenameStart(entry); }}
                      title="Rename"
                      style={_hoverBtnStyle}
                    ><img src={renameIcon} style={{ width: 13, height: 13, display: "block", filter: "invert(0.5)" }} /></span>
                    <span
                      className="tree-hover-btn"
                      onClick={(e) => { e.stopPropagation(); onMoveStart(entry); }}
                      title="Move to…"
                      style={_hoverBtnStyle}
                    ><img src={moveIcon} style={{ width: 13, height: 13, display: "block", filter: "invert(0.7)" }} /></span>
                    <span
                      className="tree-hover-btn"
                      onClick={(e) => { e.stopPropagation(); onDownloadEntry(entry); }}
                      title="Download as zip"
                      style={_hoverBtnStyle}
                    ><img src={downloadIcon} style={{ width: 11, height: 11, display: "block", filter: "invert(0.6)" }} /></span>
                  </>
                )}
              </div>
              {isExpanded && childNode && childNode.error && (
                <div style={{ padding: "3px 8px 3px " + (indent + 24) + "px", fontSize: 11, color: "var(--accent-red)" }}>
                  {childNode.error}
                </div>
              )}
              {isExpanded && childNode && !childNode.error && (
                <TreeEntries
                  entries={childNode.entries}
                  depth={depth + 1}
                  {...childProps}
                />
              )}
            </div>
          );
        }

        return (
          <div
            key={entry.path}
            onClick={() => !isRenaming && isClickable && onOpen(entry)}
            style={{
              padding: `3px 8px 3px ${indent + 15}px`,
              cursor: isRenaming ? "default" : isClickable ? "pointer" : "default",
              color: isOpen ? "var(--accent-blue)" : isClickable ? "var(--text-primary)" : "var(--text-muted)",
              background: isOpen ? "rgba(88,166,255,0.12)" : "transparent",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 5,
              userSelect: "none",
              borderRadius: 3,
              position: "relative",
            }}
            onMouseEnter={(e) => {
              if (!isRenaming && !isOpen) e.currentTarget.style.background = "var(--bg-hover)";
              if (!isRenaming) e.currentTarget.querySelectorAll(".tree-hover-btn").forEach((b) => ((b as HTMLElement).style.display = "flex"));
            }}
            onMouseLeave={(e) => {
              if (!isOpen) e.currentTarget.style.background = "transparent";
              e.currentTarget.querySelectorAll(".tree-hover-btn").forEach((b) => ((b as HTMLElement).style.display = "none"));
            }}
          >
            <FileIcon name={entry.name} size={13} />
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => onRenameChange(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") { e.preventDefault(); onRenameCommit(); }
                  if (e.key === "Escape") { e.preventDefault(); onRenameCancel(); }
                }}
                style={{ flex: 1, background: "var(--bg-base)", border: "1px solid #58a6ff", borderRadius: 3, padding: "1px 5px", color: "var(--text-body)", fontSize: 11, outline: "none", minWidth: 0 }}
              />
            ) : (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {entry.name}
              </span>
            )}
            {!isRenaming && entry.size != null && (
              <span style={{ color: "var(--text-faintest)", fontSize: 10, flexShrink: 0 }}>
                {formatSize(entry.size)}
              </span>
            )}
            {!isRenaming && (
              <>
                {entry.is_archive && (
                  <>
                    <span
                      className="tree-hover-btn"
                      onClick={(e) => { e.stopPropagation(); onListArchive(entry); }}
                      title="List archive contents"
                      style={_hoverBtnStyle}
                    >📋</span>
                    <span
                      className="tree-hover-btn"
                      onClick={(e) => { e.stopPropagation(); onExtractArchive(entry); }}
                      title="Extract archive"
                      style={_hoverBtnStyle}
                    >📦</span>
                  </>
                )}
                <span
                  className="tree-hover-btn"
                  onClick={(e) => { e.stopPropagation(); onRenameStart(entry); }}
                  title="Rename"
                  style={_hoverBtnStyle}
                ><img src={renameIcon} style={{ width: 13, height: 13, display: "block", filter: "invert(0.5)" }} /></span>
                <span
                  className="tree-hover-btn"
                  onClick={(e) => { e.stopPropagation(); onMoveStart(entry); }}
                  title="Move to…"
                  style={_hoverBtnStyle}
                ><img src={moveIcon} style={{ width: 13, height: 13, display: "block", filter: "invert(0.7)" }} /></span>
                <span
                  className="tree-hover-btn"
                  onClick={(e) => { e.stopPropagation(); onDownloadEntry(entry); }}
                  title="Download"
                  style={_hoverBtnStyle}
                ><img src={downloadIcon} style={{ width: 11, height: 11, display: "block", filter: "invert(0.6)" }} /></span>
                {!entry.is_skipped && (
                  <span
                    className="tree-hover-btn"
                    onClick={(e) => { e.stopPropagation(); onFileHistory(entry); }}
                    title="Git history"
                    style={_hoverBtnStyle}
                  ><img src={gitIcon} style={{ width: 11, height: 11, display: "block", filter: "invert(0.6)" }} /></span>
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

// ── JSON syntax highlighter (theme-aware via CSS variables) ──────────────────

function highlightJson(json: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const span = (color: string, text: string) => `<span style="color:${color}">${esc(text)}</span>`;

  let out = "";
  let i = 0;
  const len = json.length;

  while (i < len) {
    // String token
    if (json[i] === '"') {
      let j = i + 1;
      while (j < len) {
        if (json[j] === "\\") { j += 2; continue; }
        if (json[j] === '"') { j++; break; }
        j++;
      }
      const str = json.slice(i, j);
      // Determine if this is a key: scan past whitespace for a colon
      let k = j;
      while (k < len && (json[k] === " " || json[k] === "\t")) k++;
      const isKey = json[k] === ":";
      out += span(isKey ? "var(--accent-blue)" : "var(--accent-green)", str);
      i = j;
    }
    // Number
    else if (json[i] === "-" || (json[i] >= "0" && json[i] <= "9")) {
      let j = i + 1;
      while (j < len && /[\d.eE+\-]/.test(json[j])) j++;
      out += span("var(--accent-amber)", json.slice(i, j));
      i = j;
    }
    // true / false / null
    else if (json.startsWith("true", i)) {
      out += span("var(--accent-amber)", "true"); i += 4;
    } else if (json.startsWith("false", i)) {
      out += span("var(--accent-amber)", "false"); i += 5;
    } else if (json.startsWith("null", i)) {
      out += span("var(--text-muted)", "null"); i += 4;
    }
    // Structural / whitespace — pass through escaped
    else {
      out += esc(json[i]); i++;
    }
  }
  return out;
}

// ── JSON repair & format ─────────────────────────────────────────────────────

/** Convert Python-dict-style single-quoted strings to valid JSON double-quoted strings. */
function pyDictToJson(s: string): string {
  let result = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      // Double-quoted string — pass through verbatim (handle escapes)
      result += ch; i++;
      while (i < s.length) {
        const c = s[i];
        result += c;
        if (c === "\\") { i++; if (i < s.length) { result += s[i]; i++; } }
        else if (c === '"') { i++; break; }
        else i++;
      }
    } else if (ch === "'") {
      // Single-quoted string — convert to double-quoted
      result += '"'; i++;
      while (i < s.length) {
        const c = s[i];
        if (c === "\\" && s[i + 1] === "'") { result += "'"; i += 2; }          // \' → '
        else if (c === "\\" && s[i + 1] === "\\") { result += "\\\\"; i += 2; } // \\ → \\
        else if (c === '"') { result += '\\"'; i++; }                            // " → \"
        else if (c === "'") { result += '"'; i++; break; }                      // end
        else if (c === "\n") { result += "\\n"; i++; }
        else if (c === "\r") { result += "\\r"; i++; }
        else { result += c; i++; }
      }
    } else if (s.startsWith("True", i) && !/\w/.test(s[i + 4] ?? "")) {
      result += "true"; i += 4;
    } else if (s.startsWith("False", i) && !/\w/.test(s[i + 5] ?? "")) {
      result += "false"; i += 5;
    } else if (s.startsWith("None", i) && !/\w/.test(s[i + 4] ?? "")) {
      result += "null"; i += 4;
    } else {
      result += ch; i++;
    }
  }
  return result;
}

function repairAndFormatJson(raw: string): string {
  let s = raw.trim();
  // Strip markdown code-fence (```json ... ``` or ``` ... ```)
  s = s.replace(/^```(?:json|python|py)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();

  // Attempt 1: parse as-is
  try { return JSON.stringify(JSON.parse(s), null, 4); } catch { /* fall through */ }

  // Attempt 2: Python dict → JSON (single quotes, True/False/None) + trailing commas
  const converted = pyDictToJson(s).replace(/,(\s*[}\]])/g, "$1");
  try { return JSON.stringify(JSON.parse(converted), null, 4); } catch { /* fall through */ }

  throw new Error("Invalid JSON");
}

// ── CSV Viewer ───────────────────────────────────────────────────────────────
function csvPageSize(colCount: number): number {
  const raw = Math.round((5000 / Math.max(1, colCount)) / 10) * 10;
  return Math.min(500, Math.max(10, raw));
}

export function CsvViewer({ content, delimiter }: { content: string; delimiter: string }) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(0);

  const rows = useMemo(() => {
    return content.trim().split("\n").map((line) => {
      const cells: string[] = [];
      let cur = "";
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') inQ = false;
          else cur += ch;
        } else {
          if (ch === '"') inQ = true;
          else if (ch === delimiter) { cells.push(cur); cur = ""; }
          else cur += ch;
        }
      }
      cells.push(cur);
      return cells;
    });
  }, [content, delimiter]);

  if (rows.length === 0) return <div style={{ color: "var(--text-muted)", padding: 16 }}>Empty file</div>;
  const headers = rows[0];
  const dataRows = rows.slice(1);
  const pageSize = csvPageSize(headers.length);
  const totalPages = Math.max(1, Math.ceil(dataRows.length / pageSize));

  const sortedRows = useMemo(() => {
    if (sortCol === null) return dataRows;
    return [...dataRows].sort((a, b) => {
      const av = a[sortCol] ?? "";
      const bv = b[sortCol] ?? "";
      const an = Number(av), bn = Number(bv);
      const cmp = (!isNaN(an) && !isNaN(bn) && av !== "" && bv !== "")
        ? an - bn
        : av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
      return sortAsc ? cmp : -cmp;
    });
  }, [dataRows, sortCol, sortAsc]);

  const safePage = Math.min(page, totalPages - 1);
  const pageRows = sortedRows.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const rowStart = safePage * pageSize; // 0-based offset for row numbering

  const handleHeaderClick = (ci: number) => {
    setPage(0);
    if (sortCol === ci) {
      if (!sortAsc) { setSortCol(null); setSortAsc(true); }
      else setSortAsc(false);
    } else {
      setSortCol(ci);
      setSortAsc(true);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      {/* pagination bar */}
      {totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 12px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text-secondary)", flexShrink: 0 }}>
          <button onClick={() => setPage(0)} disabled={safePage === 0} style={{ background: "none", border: "none", color: safePage === 0 ? "var(--text-faintest)" : "var(--text-secondary)", cursor: safePage === 0 ? "default" : "pointer", padding: "0 2px", fontSize: 14 }}>«</button>
          <button onClick={() => setPage(safePage - 1)} disabled={safePage === 0} style={{ background: "none", border: "none", color: safePage === 0 ? "var(--text-faintest)" : "var(--text-secondary)", cursor: safePage === 0 ? "default" : "pointer", padding: "0 2px", fontSize: 14 }}>‹</button>
          <span style={{ minWidth: 80, textAlign: "center" }}>{safePage + 1} / {totalPages}</span>
          <button onClick={() => setPage(safePage + 1)} disabled={safePage >= totalPages - 1} style={{ background: "none", border: "none", color: safePage >= totalPages - 1 ? "var(--text-faintest)" : "var(--text-secondary)", cursor: safePage >= totalPages - 1 ? "default" : "pointer", padding: "0 2px", fontSize: 14 }}>›</button>
          <button onClick={() => setPage(totalPages - 1)} disabled={safePage >= totalPages - 1} style={{ background: "none", border: "none", color: safePage >= totalPages - 1 ? "var(--text-faintest)" : "var(--text-secondary)", cursor: safePage >= totalPages - 1 ? "default" : "pointer", padding: "0 2px", fontSize: 14 }}>»</button>
          <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>{dataRows.length} rows, {pageSize} per page</span>
        </div>
      )}
      <div style={{ overflow: "auto", flex: 1 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%", whiteSpace: "nowrap" }}>
          <thead>
            <tr style={{ background: "var(--bg-surface)", position: "sticky", top: 0 }}>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-faint)", textAlign: "right", fontWeight: 400, userSelect: "none", minWidth: 36, fontSize: 11 }}>#</th>
              {headers.map((h, i) => (
                <th
                  key={i}
                  onClick={() => handleHeaderClick(i)}
                  style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", color: sortCol === i ? "var(--accent-blue)" : "var(--text-secondary)", textAlign: "left", fontWeight: 600, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                >
                  {h}
                  <span style={{ marginLeft: 4, fontSize: 10, opacity: sortCol === i ? 1 : 0.25 }}>
                    {sortCol === i ? (sortAsc ? "▲" : "▼") : "▲"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, ri) => (
              <tr key={ri} style={{ background: ri % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}>
                <td style={{ padding: "4px 8px", borderBottom: "1px solid #1f2937", color: "var(--text-faint)", fontFamily: "monospace", textAlign: "right", userSelect: "none", fontSize: 11 }}>{rowStart + ri + 1}</td>
                {headers.map((_, ci) => (
                  <td key={ci} style={{ padding: "4px 12px", borderBottom: "1px solid #1f2937", color: "var(--text-primary)", fontFamily: "monospace" }}>
                    {row[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Read-only cell popup (JSONL / CSV expand) ────────────────────────────────
function ValuePopup({ value, columnName, onClose }: {
  value: string;
  columnName: string;
  onClose: () => void;
}) {
  const [formatted, setFormatted] = useState<string | null>(null);
  const [fmtError, setFmtError] = useState<string | null>(null);

  const handleFormat = () => {
    if (formatted !== null) { setFormatted(null); setFmtError(null); return; }
    try { setFormatted(repairAndFormatJson(value)); setFmtError(null); }
    catch (e) { setFmtError(String(e)); }
  };

  const display = formatted ?? value;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 20, maxWidth: "70vw", maxHeight: "70vh", minWidth: 400, overflow: "hidden", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0, flexWrap: "wrap", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{columnName}</span>
            <button onClick={handleFormat} style={{ background: formatted !== null ? "var(--accent-blue)" : "var(--text-faintest)", color: "#fff", fontSize: 10, padding: "2px 10px" }}>
              {formatted !== null ? "Raw" : "Format JSON"}
            </button>
            {fmtError && <span style={{ fontSize: 11, color: "var(--accent-red)" }}>Format failed</span>}
            <button onClick={() => copyText(display)} style={{ background: "#2d1a4a", color: "#a78bfa", border: "1px solid #4c1d95", fontSize: 10, padding: "2px 10px" }}>
              Copy
            </button>
          </div>
          <button onClick={onClose} style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 11, padding: "2px 8px" }}>✕</button>
        </div>
        <pre style={{ margin: 0, flex: 1, overflow: "auto", color: "var(--text-body)", fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,monospace', fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {formatted !== null
            ? <code dangerouslySetInnerHTML={{ __html: highlightJson(formatted) }} />
            : display}
        </pre>
      </div>
    </div>
  );
}

// ── JSONL Viewer ─────────────────────────────────────────────────────────────
function jsonlPageSize(colCount: number): number {
  const raw = Math.round((5000 / Math.max(1, colCount)) / 10) * 10;
  return Math.min(500, Math.max(10, raw));
}

// Flatten an object into dotted keys up to `maxDepth` levels deep.
// Arrays are never flattened (they stay as a single column value).
// Objects at the depth limit are also left as-is (rendered as JSON in cell).
function flattenJsonlRow(
  obj: Record<string, unknown>,
  maxDepth: number,
  prefix = "",
  depth = 1,
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      out[key] = v;
    } else if (v !== null && typeof v === "object" && depth < maxDepth) {
      flattenJsonlRow(v as Record<string, unknown>, maxDepth, key, depth + 1, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

const JSONL_FLATTEN_MAX_DEPTH = 2;

export function JsonlViewer({ content }: { content: string }) {
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
          // Flatten up to JSONL_FLATTEN_MAX_DEPTH levels via dotted keys.
          // Arrays are kept as-is (single cell, JSON-stringified on display).
          const flat = flattenJsonlRow(obj as Record<string, unknown>, JSONL_FLATTEN_MAX_DEPTH);
          for (const k of Object.keys(flat)) {
            if (!keySet.has(k)) { keySet.add(k); keyOrder.push(k); }
          }
          parsed.push(flat);
        } else {
          // Top-level arrays or primitives: single "_value" column
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

  // Stringify a cell value for display (nested → compact JSON)
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
        ? an - bn
        : av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
      return sortAsc ? cmp : -cmp;
    });
  }, [rows, sortCol, sortAsc]);

  const handleHeaderClick = (col: string) => {
    if (sortCol === col) {
      if (!sortAsc) { setSortCol(null); setSortAsc(true); }
      else setSortAsc(false);
    } else { setSortCol(col); setSortAsc(true); }
    setPage(0);
  };

  if (rows.length === 0) return <div style={{ color: "var(--text-muted)", padding: 16, fontSize: 13 }}>Empty or invalid JSONL</div>;

  const pageSize = jsonlPageSize(headers.length);
  const totalPages = Math.ceil(sortedRows.length / pageSize);
  const pageRows = sortedRows.slice(page * pageSize, (page + 1) * pageSize);
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
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-faint)", textAlign: "right", fontWeight: 400, userSelect: "none", minWidth: 36, fontSize: 11 }}>#</th>
              {headers.map((h) => (
                <th key={h} onClick={() => handleHeaderClick(h)}
                  style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", color: sortCol === h ? "var(--accent-blue)" : "var(--text-secondary)", textAlign: "left", fontWeight: 600, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
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
                  <td style={{ padding: "4px 8px", borderBottom: "1px solid #1f2937", color: "var(--text-faint)", fontFamily: "monospace", textAlign: "right", userSelect: "none", fontSize: 11 }}>{absIdx + 1}</td>
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
                          padding: "4px 12px", borderBottom: "1px solid #1f2937",
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "6px 12px", borderTop: "1px solid #1f2937", background: "var(--bg-surface)", flexShrink: 0, fontSize: 12 }}>
          <button disabled={page === 0} onClick={() => setPage(0)} style={{ background: "var(--text-faintest)", color: page === 0 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 8px" }}>«</button>
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} style={{ background: "var(--text-faintest)", color: page === 0 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 8px" }}>‹</button>
          <span style={{ color: "var(--text-muted)" }}>{page + 1} / {totalPages}</span>
          <span style={{ color: "var(--text-faint)", fontSize: 11 }}>({sortedRows.length} rows)</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} style={{ background: "var(--text-faintest)", color: page >= totalPages - 1 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 8px" }}>›</button>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)} style={{ background: "var(--text-faintest)", color: page >= totalPages - 1 ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "2px 8px" }}>»</button>
        </div>
      )}
    </div>
  );
}

// ── Markdown Viewer ──────────────────────────────────────────────────────────
function mdSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")       // strip HTML tags
    .replace(/[^\p{L}\p{N}\s-]/gu, "")  // keep letters, numbers, spaces, dashes
    .trim()
    .replace(/\s+/g, "-");
}

const _mdRenderer = new marked.Renderer();
_mdRenderer.heading = ({ text, depth }: { text: string; depth: number }) => {
  const id = mdSlug(text);
  return `<h${depth} id="${id}">${text}</h${depth}>\n`;
};
marked.use({ renderer: _mdRenderer });

function MarkdownViewer({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    try {
      return marked.parse(content) as string;
    } catch {
      return "<pre>" + content + "</pre>";
    }
  }, [content]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href || !href.startsWith("#")) return;
    e.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const el = containerRef.current?.querySelector(`[id="${CSS.escape(id)}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div
      ref={containerRef}
      className="md-preview"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
      style={{
        flex: 1,
        overflow: "auto",
        padding: "16px 24px",
        color: "var(--text-primary)",
        fontSize: 14,
        lineHeight: 1.7,
      }}
    />
  );
}

// ── Code Viewer ──────────────────────────────────────────────────────────────
function CodeViewer({ content, ext }: { content: string; ext: string }) {
  const { src, highlighted } = useMemo(() => {
    try {
      let src = content;
      if (ext === "json") {
        try { src = repairAndFormatJson(content); } catch { /* use raw */ }
      }
      const lang = hljs.getLanguage(ext) ? ext : undefined;
      const highlighted = lang
        ? hljs.highlight(src, { language: lang }).value
        : hljs.highlightAuto(src).value;
      return { src, highlighted };
    } catch {
      return {
        src: content,
        highlighted: content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      };
    }
  }, [content, ext]);

  const lineCount = src.split("\n").length;

  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", background: "var(--bg-base)" }}>
      {/* Line numbers */}
      <div
        aria-hidden
        style={{
          padding: "12px 8px 12px 12px",
          textAlign: "right",
          color: "var(--text-faint)",
          fontSize: 13,
          lineHeight: 1.6,
          fontFamily: '"Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace',
          userSelect: "none",
          flexShrink: 0,
          borderRight: "1px solid #1f2937",
          minWidth: 40,
        }}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      {/* Code */}
      <pre
        style={{
          flex: 1,
          overflow: "visible",
          margin: 0,
          padding: "12px 16px",
          fontSize: 13,
          lineHeight: 1.6,
          fontFamily: '"Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace',
        }}
      >
        <code
          className={`hljs language-${ext}`}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

// ── Diff Viewer ──────────────────────────────────────────────────────────────
function DiffViewer({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--bg-base)", fontFamily: '"Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace', fontSize: 12, lineHeight: 1.6 }}>
      {lines.map((line, i) => {
        let bg = "transparent";
        let color = "var(--text-primary)";
        if (line.startsWith("+++") || line.startsWith("---")) {
          color = "var(--text-muted)";
        } else if (line.startsWith("+")) {
          bg = "var(--diff-add-bg)";
          color = "var(--diff-add-text)";
        } else if (line.startsWith("-")) {
          bg = "var(--diff-del-bg)";
          color = "var(--diff-del-text)";
        } else if (line.startsWith("@@")) {
          bg = "rgba(88,166,255,0.08)";
          color = "var(--accent-blue)";
        } else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new ") || line.startsWith("deleted ")) {
          color = "var(--text-muted)";
        }
        return (
          <div key={i} style={{ background: bg, color, padding: "0 12px", whiteSpace: "pre", minHeight: "1.6em" }}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

export function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => _execCopy(text));
  } else {
    _execCopy(text);
  }
}
function _execCopy(text: string) {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed"; el.style.opacity = "0";
  document.body.appendChild(el);
  el.focus(); el.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(el);
}

// ── Cell / text expand popup (with JSON format, copy, edit) ──────────────────
interface CellCtx {
  value: string;
  rawValue: unknown;
  columnName: string;
  allColumns: string[];
  allRawValues: unknown[];
}

function _sqlLiteral(raw: unknown, editText: string): string {
  if (raw === null || raw === undefined) return "NULL";
  if (typeof raw === "number") {
    const n = Number(editText);
    return isNaN(n) ? `'${editText.replace(/'/g, "''")}'` : String(n);
  }
  return `'${editText.replace(/'/g, "''")}'`;
}

function _sqlWhere(cols: string[], vals: unknown[]): string {
  return cols.map((c, i) => {
    const v = vals[i];
    if (v === null || v === undefined) return `"${c}" IS NULL`;
    if (typeof v === "number") return `"${c}" = ${v}`;
    return `"${c}" = '${String(v).replace(/'/g, "''")}'`;
  }).join(" AND ");
}

function CellPopup({
  ctx, tableName, sessionId, dbPath, onSaved, onClose,
}: {
  ctx: CellCtx;
  tableName: string;
  sessionId: string;
  dbPath: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { value, rawValue, columnName, allColumns, allRawValues } = ctx;
  const [formatted, setFormatted] = useState<string | null>(null);
  const [fmtError, setFmtError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(value);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const handleFormat = () => {
    if (formatted !== null) { setFormatted(null); setFmtError(null); return; }
    try { setFormatted(repairAndFormatJson(value)); setFmtError(null); }
    catch (e) { setFmtError(String(e)); }
  };

  const handleSave = async () => {
    setSaving(true); setSaveErr("");
    try {
      const setVal = _sqlLiteral(rawValue, editText);
      const where = _sqlWhere(allColumns, allRawValues);
      const sql = `UPDATE "${tableName}" SET "${columnName}" = ${setVal} WHERE ${where}`;
      await sqliteExec(sessionId, dbPath, sql);
      onSaved();
      onClose();
    } catch (e) { setSaveErr(String(e)); } finally { setSaving(false); }
  };

  const display = formatted ?? value;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 20, maxWidth: "70vw", maxHeight: "70vh", minWidth: 400, overflow: "hidden", display: "flex", flexDirection: "column", gap: 10 }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0, flexWrap: "wrap", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{columnName}</span>
            {!editing && (
              <>
                <button onClick={handleFormat}
                  style={{ background: formatted !== null ? "var(--accent-blue)" : "var(--text-faintest)", color: "#fff", fontSize: 10, padding: "2px 10px" }}>
                  {formatted !== null ? "Raw" : "Format JSON"}
                </button>
                {fmtError && <span style={{ fontSize: 11, color: "var(--accent-red)" }}>Format failed</span>}
                <button onClick={() => copyText(display)}
                  style={{ background: "#2d1a4a", color: "#a78bfa", border: "1px solid #4c1d95", fontSize: 10, padding: "2px 10px" }}>
                  Copy
                </button>
                <button onClick={() => { setEditText(value); setSaveErr(""); setEditing(true); }}
                  style={{ background: "#1a2a1a", color: "var(--accent-green)", border: "1px solid #2d5a2d", fontSize: 10, padding: "2px 10px" }}>
                  Edit
                </button>
              </>
            )}
            {editing && (
              <>
                <button onClick={handleSave} disabled={saving}
                  style={{ background: saving ? "var(--text-faintest)" : "#238636", color: saving ? "var(--text-muted)" : "#fff", fontSize: 10, padding: "2px 10px" }}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button onClick={() => setEditing(false)}
                  style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "2px 10px" }}>
                  Cancel
                </button>
                {saveErr && <span style={{ fontSize: 11, color: "var(--accent-red)" }}>{saveErr}</span>}
              </>
            )}
          </div>
          <button onClick={onClose} style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 11, padding: "2px 8px" }}>✕</button>
        </div>
        {editing ? (
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            style={{ flex: 1, background: "var(--bg-base)", border: "1px solid #374151", borderRadius: 4, color: "var(--text-body)", fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,monospace', fontSize: 13, padding: 10, resize: "none", outline: "none", minHeight: 200 }}
          />
        ) : (
          <pre style={{ margin: 0, flex: 1, overflow: "auto", color: "var(--text-body)", fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,monospace', fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {formatted !== null
              ? <code dangerouslySetInnerHTML={{ __html: highlightJson(formatted) }} />
              : display}
          </pre>
        )}
      </div>
    </div>
  );
}

// ── SQLite Viewer ────────────────────────────────────────────────────────────
export function SqliteViewer({ sessionId, path }: { sessionId: string; path: string }) {
  const [info, setInfo] = useState<SqliteInfo | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedCell, setExpandedCell] = useState<CellCtx | null>(null);
  const [sql, setSql] = useState("");
  const [execResult, setExecResult] = useState<SqliteExecResult | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [execing, setExecing] = useState(false);
  const PAGE_SIZE = 100;

  // Drag-resizable table-list panel. Persisted so a wider list survives reloads.
  const [tableListWidth, setTableListWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem("sqliteTableListW"));
    return Number.isFinite(stored) && stored >= 100 && stored <= 600 ? stored : 180;
  });
  const dragRef = useRef({ dragging: false, startX: 0, startW: 0 });
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.dragging) return;
      const delta = e.clientX - dragRef.current.startX;
      setTableListWidth(Math.max(100, Math.min(600, dragRef.current.startW + delta)));
    };
    const onUp = () => {
      if (!dragRef.current.dragging) return;
      dragRef.current.dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);
  useEffect(() => { localStorage.setItem("sqliteTableListW", String(tableListWidth)); }, [tableListWidth]);

  const load = useCallback(async (table?: string, off = 0) => {
    setLoading(true);
    setError(null);
    try {
      const res = await sqliteQuery(sessionId, path, table, PAGE_SIZE, off);
      setInfo(res);
      if (table) {
        setSelectedTable(table);
        setOffset(off);
      } else if (res.tables.length > 0 && !selectedTable) {
        // Auto-select first table
        const first = res.tables[0];
        const full = await sqliteQuery(sessionId, path, first, PAGE_SIZE, 0);
        setInfo(full);
        setSelectedTable(first);
        setOffset(0);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, path, selectedTable]);

  const handleExec = useCallback(async () => {
    const stmt = sql.trim();
    if (!stmt) return;
    setExecing(true);
    setExecError(null);
    setExecResult(null);
    try {
      const res = await sqliteExec(sessionId, path, stmt);
      setExecResult(res);
      // Refresh table data if a DML statement was executed
      if (res.affected > 0 && selectedTable) {
        await load(selectedTable, offset);
      } else if (!res.columns.length && selectedTable) {
        await load(selectedTable, offset);
      }
    } catch (e) {
      setExecError(String(e));
    } finally {
      setExecing(false);
    }
  }, [sessionId, path, sql, selectedTable, offset, load]);

  useEffect(() => {
    load();
  }, []);  // eslint-disable-line

  if (error) return <div style={{ padding: 16, color: "var(--accent-red)", fontSize: 13 }}>{error}</div>;
  if (!info) return <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>;

  const totalPages = Math.ceil((info.total || 0) / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {expandedCell !== null && (
        <CellPopup
          ctx={expandedCell}
          tableName={selectedTable!}
          sessionId={sessionId}
          dbPath={path}
          onSaved={() => load(selectedTable!, offset)}
          onClose={() => setExpandedCell(null)}
        />
      )}
      {/* Table list */}
      <div style={{ width: tableListWidth, overflowY: "auto", padding: "8px 4px", flexShrink: 0 }}>
        <div style={{ fontSize: 10, color: "var(--text-muted)", padding: "4px 8px", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>
          Tables
        </div>
        {info.tables.map((t) => (
          <div
            key={t}
            onClick={() => load(t, 0)}
            title={t}
            style={{
              padding: "5px 10px",
              fontSize: 12,
              color: t === selectedTable ? "var(--accent-blue)" : "var(--text-secondary)",
              background: t === selectedTable ? "rgba(88,166,255,0.12)" : "transparent",
              cursor: "pointer",
              borderRadius: 4,
              fontFamily: "monospace",
              wordBreak: "break-all",
              lineHeight: 1.35,
            }}
            onMouseEnter={(e) => { if (t !== selectedTable) e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { if (t !== selectedTable) e.currentTarget.style.background = "transparent"; }}
          >
            🗄️ {t}
          </div>
        ))}
      </div>

      {/* Drag handle between table list and data panel */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          dragRef.current = { dragging: true, startX: e.clientX, startW: tableListWidth };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        style={{ width: 4, background: "#1f2937", cursor: "col-resize", flexShrink: 0, transition: "background 0.15s" }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--text-faintest)"; }}
        onMouseLeave={(e) => { if (!dragRef.current.dragging) (e.currentTarget as HTMLDivElement).style.background = "#1f2937"; }}
      />

      {/* Table data */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {selectedTable && info.columns.length > 0 ? (
          <>
            <div style={{ padding: "6px 12px", borderBottom: "1px solid #1f2937", fontSize: 11, color: "var(--text-muted)", background: "var(--bg-surface)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: "monospace", color: "var(--text-secondary)" }}>{selectedTable}</span>
              <span>{info.total} rows{loading ? " · loading…" : ""}</span>
            </div>
            <div style={{ overflow: "auto", flex: 1 }}>
              <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%", whiteSpace: "nowrap" }}>
                <thead>
                  <tr style={{ background: "var(--bg-surface)", position: "sticky", top: 0 }}>
                    {info.columns.map((col, i) => (
                      <th key={i} style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)", textAlign: "left", fontWeight: 600 }}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {info.rows.map((row, ri) => (
                    <tr key={ri} style={{ background: ri % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}>
                      {(row as unknown[]).map((cell, ci) => {
                        const str = cell == null ? null : String(cell);
                        const truncated = str != null && str.length > 80;
                        return (
                          <td
                            key={ci}
                            onClick={() => str != null && setExpandedCell({
                              value: str,
                              rawValue: cell,
                              columnName: info.columns[ci],
                              allColumns: info.columns,
                              allRawValues: row as unknown[],
                            })}
                            title={truncated ? "Click to view full content" : undefined}
                            style={{
                              padding: "4px 12px",
                              borderBottom: "1px solid #1f2937",
                              color: str == null ? "var(--text-faint)" : "var(--text-primary)",
                              fontFamily: "monospace",
                              maxWidth: 300,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              cursor: str != null ? "pointer" : "default",
                              whiteSpace: "nowrap",
                            }}
                            onMouseEnter={(e) => { if (str != null) e.currentTarget.style.background = "rgba(88,166,255,0.08)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
                          >
                            {str == null ? "NULL" : str}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div style={{ padding: "6px 12px", borderTop: "1px solid #1f2937", display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: "var(--text-muted)" }}>
                <button
                  disabled={currentPage === 0}
                  onClick={() => load(selectedTable!, offset - PAGE_SIZE)}
                  style={{ background: "var(--text-faintest)", color: "var(--text-body)", fontSize: 11, padding: "3px 8px" }}
                >
                  Prev
                </button>
                <span>{currentPage + 1}/{totalPages}</span>
                <button
                  disabled={currentPage >= totalPages - 1}
                  onClick={() => load(selectedTable!, offset + PAGE_SIZE)}
                  style={{ background: "var(--text-faintest)", color: "var(--text-body)", fontSize: 11, padding: "3px 8px" }}
                >
                  Next
                </button>
              </div>
            )}
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faintest)", fontSize: 13 }}>
            {info.tables.length === 0 ? "No tables found" : "Select a table"}
          </div>
        )}

        {/* ── SQL Console ── */}
        <div style={{ borderTop: "1px solid var(--border)", background: "var(--bg-surface)", flexShrink: 0 }}>
          <div style={{ padding: "6px 10px", fontSize: 10, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>
            SQL Console
          </div>
          <div style={{ padding: "0 10px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleExec();
                }
              }}
              placeholder="SELECT * FROM table WHERE ...&#10;Ctrl+Enter to run"
              spellCheck={false}
              rows={3}
              style={{
                width: "100%",
                background: "var(--bg-base)",
                color: "var(--text-primary)",
                border: "1px solid #374151",
                borderRadius: 4,
                fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,monospace',
                fontSize: 12,
                padding: "6px 8px",
                resize: "vertical",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                onClick={handleExec}
                disabled={execing || !sql.trim()}
                style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 11, padding: "4px 14px" }}
              >
                {execing ? "Running…" : "Run (Ctrl+Enter)"}
              </button>
              {execResult && (
                <span style={{ fontSize: 11, color: "#34d399" }}>{execResult.message}</span>
              )}
              {execError && (
                <span style={{ fontSize: 11, color: "var(--accent-red)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={execError}>
                  {execError}
                </span>
              )}
            </div>
            {/* SELECT result table */}
            {execResult && execResult.columns.length > 0 && (
              <div style={{ maxHeight: 160, overflow: "auto", border: "1px solid #1f2937", borderRadius: 4 }}>
                <table style={{ borderCollapse: "collapse", fontSize: 11, minWidth: "100%", whiteSpace: "nowrap" }}>
                  <thead>
                    <tr style={{ background: "var(--bg-hover)", position: "sticky", top: 0 }}>
                      {execResult.columns.map((c, i) => (
                        <th key={i} style={{ padding: "4px 10px", color: "var(--text-secondary)", textAlign: "left", fontWeight: 600, borderBottom: "1px solid #374151" }}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {execResult.rows.map((row, ri) => (
                      <tr key={ri}>
                        {(row as unknown[]).map((cell, ci) => (
                          <td key={ci} style={{ padding: "3px 10px", color: "var(--text-primary)", fontFamily: "monospace", borderBottom: "1px solid #1f2937" }}>
                            {cell == null ? <span style={{ color: "var(--text-faint)" }}>NULL</span> : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── PDF Viewer ───────────────────────────────────────────────────────────────
function PdfViewer({ sessionId, path }: { sessionId: string; path: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    fetchRawFileBlob(sessionId, path)
      .then((u) => { url = u; setBlobUrl(u); })
      .catch((e) => setError(String(e)));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [sessionId, path]);

  if (error) return <div style={{ padding: 24, color: "var(--accent-red)", fontSize: 13 }}>{error}</div>;
  if (!blobUrl) return <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>Loading PDF…</div>;

  return (
    <iframe
      src={blobUrl}
      style={{ flex: 1, border: "none", width: "100%", height: "100%", background: "#fff" }}
      title={path}
    />
  );
}

// ── Image Viewer ─────────────────────────────────────────────────────────────
function ImageViewer({ sessionId, path }: { sessionId: string; path: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    fetchRawFileBlob(sessionId, path)
      .then((u) => { url = u; setBlobUrl(u); })
      .catch((e) => setError(String(e)));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [sessionId, path]);

  if (error) return <div style={{ padding: 24, color: "var(--accent-red)", fontSize: 13 }}>{error}</div>;
  if (!blobUrl) return <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>;

  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "var(--bg-deep)" }}>
      <img src={blobUrl} alt={path} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 4 }} />
    </div>
  );
}

// ── Video / Audio Viewer ──────────────────────────────────────────────────────
// Stream straight from the fs/media URL (Range-enabled, cache-friendly) instead
// of buffering a blob, so seeking works and large files don't load into memory.
function VideoViewer({ sessionId, path }: { sessionId: string; path: string }) {
  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "var(--bg-deep)" }}>
      <video src={mediaFileUrl(sessionId, path)} controls preload="metadata" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 4 }} />
    </div>
  );
}

function AudioViewer({ sessionId, path }: { sessionId: string; path: string }) {
  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "var(--bg-deep)" }}>
      <audio src={mediaFileUrl(sessionId, path)} controls preload="metadata" style={{ width: "100%", maxWidth: 600 }} />
    </div>
  );
}

// ── Archive Viewer ───────────────────────────────────────────────────────────
export function ArchiveViewer({ sessionId, path }: { sessionId: string; path: string }) {
  const [entries, setEntries] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listArchive(sessionId, path)
      .then((res) => { setEntries(res.entries); setTotal(res.total); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [sessionId, path]);

  if (loading) return <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>;
  if (error) return <div style={{ padding: 24, color: "var(--accent-red)", fontSize: 13 }}>{error}</div>;

  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "6px 12px", borderBottom: "1px solid #1f2937", fontSize: 11, color: "var(--text-muted)", background: "var(--bg-surface)", flexShrink: 0 }}>
        {path.split("/").pop()} — {total} {total === entries.length ? "" : `(showing ${entries.length} of ${total}) `}entries
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {entries.map((e, i) => (
          <div key={i} style={{ padding: "3px 14px", fontSize: 12, color: "var(--text-primary)", fontFamily: "monospace", borderBottom: "1px solid #1a2030" }}>
            {e}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Editor with line numbers ─────────────────────────────────────────────────
export function EditorWithLineNumbers({
  textareaRef,
  content,
  onChange,
  onKeyDown,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  content: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const lineCount = content.split("\n").length;

  // Sync gutter scroll with textarea scroll
  const syncScroll = useCallback(() => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, [textareaRef]);

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden", background: "var(--bg-base)" }}>
      {/* Line numbers gutter */}
      <div
        ref={gutterRef}
        aria-hidden
        style={{
          padding: "12px 8px 12px 12px",
          textAlign: "right",
          color: "var(--text-faint)",
          fontSize: 13,
          lineHeight: 1.6,
          fontFamily: '"Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace',
          userSelect: "none",
          flexShrink: 0,
          borderRight: "1px solid #1f2937",
          overflowY: "hidden",
          minWidth: 40,
        }}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        style={{ ...editorStyle, flex: 1 }}
      />
    </div>
  );
}

// ── Main modal ───────────────────────────────────────────────────────────────
const SHOW_HIDDEN_KEY = (sid: string) => `fileEditor.showHidden.${sid}`;

export function FileEditorModal({ sessionId, sessionCwd, onClose }: Props) {
  // Per-session preference: dot-prefixed files are hidden by default; the
  // toolbar toggle persists in localStorage so each session remembers it.
  const [showHidden, setShowHiddenState] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_HIDDEN_KEY(sessionId)) === "1"; }
    catch { return false; }
  });
  const setShowHidden = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setShowHiddenState((prev) => {
      const next = typeof v === "function" ? (v as (prev: boolean) => boolean)(prev) : v;
      try { localStorage.setItem(SHOW_HIDDEN_KEY(sessionId), next ? "1" : "0"); } catch {}
      return next;
    });
  }, [sessionId]);
  const [tree, setTree] = useState<Record<string, NodeState>>({
    "": { entries: [], expanded: true, loaded: false, loading: false },
  });
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [saving, setSaving] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"preview" | "edit">("preview");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // New-file creation state
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileParent, setNewFileParent] = useState("");  // picked via DirPicker
  const [newFileName, setNewFileName] = useState("");
  const newFileInputRef = useRef<HTMLInputElement>(null);

  // New-dir creation state
  const [creatingDir, setCreatingDir] = useState(false);
  const [newDirParent, setNewDirParent] = useState("");  // picked via DirPicker
  const [newDirName, setNewDirName] = useState("");
  const newDirInputRef = useRef<HTMLInputElement>(null);

  // Upload state
  const [uploadForm, setUploadForm] = useState(false);
  const [uploadDir, setUploadDir] = useState("");
  const [uploadPending, setUploadPending] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Rename state
  const [renamingEntry, setRenamingEntry] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Move state: which entry is being moved + chosen destination dir
  const [movingEntry, setMovingEntry] = useState<FileEntry | null>(null);
  const [moveDestDir, setMoveDestDir] = useState("");

  // Archive viewer state (null = not viewing an archive)
  const [archiveViewPath, setArchiveViewPath] = useState<string | null>(null);

  // Git file history state
  type GitFileLogEntry = { hash: string; short_hash: string; subject: string; author: string; date: string };
  const [historyFile, setHistoryFile] = useState<{ path: string; entries: GitFileLogEntry[] } | null>(null);
  const [historyContent, setHistoryContent] = useState<{ commit: string; full: string; diff: string } | null>(null);
  const [historyViewMode, setHistoryViewMode] = useState<"diff" | "full">("diff");
  const [historyLoading, setHistoryLoading] = useState(false);
  // Path-based history search (for deleted files not visible in tree)
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [historySearchPath, setHistorySearchPath] = useState("");

  const MAX_TRANSFER_MB = 16;
  const MAX_TRANSFER_BYTES = MAX_TRANSFER_MB * 1024 * 1024;

  // Tree panel width (drag-resizable)
  const [treeWidth, setTreeWidth] = useState(260);
  const dragRef = useRef({ dragging: false, startX: 0, startW: 0 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.dragging) return;
      const delta = e.clientX - dragRef.current.startX;
      setTreeWidth(Math.max(140, Math.min(600, dragRef.current.startW + delta)));
    };
    const onUp = () => { dragRef.current.dragging = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!searchQuery.trim()) { setSearchResults(null); setSearchLoading(false); return; }
    setSearchLoading(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const res = await searchFiles(sessionId, searchQuery.trim(), showHidden);
        setSearchResults(res.entries);
      } catch { setSearchResults([]); }
      finally { setSearchLoading(false); }
    }, 300);
  }, [searchQuery, sessionId, showHidden]);

  const loadDir = useCallback(
    async (path: string) => {
      setTree((t) => ({
        ...t,
        [path]: { ...(t[path] ?? { entries: [], expanded: true, loaded: false }), loading: true },
      }));
      try {
        const res = await listFiles(sessionId, path || undefined, showHidden);
        setTree((t) => ({
          ...t,
          [path]: { entries: res.entries, expanded: true, loaded: true, loading: false },
        }));
      } catch (e) {
        setTree((t) => ({
          ...t,
          [path]: { ...(t[path] ?? { entries: [], expanded: true, loaded: false }), loading: false, loaded: true, error: String(e) },
        }));
      }
    },
    [sessionId, showHidden]
  );

  // Reload tree when showHidden or loadDir changes
  useEffect(() => {
    setTree({ "": { entries: [], expanded: true, loaded: false, loading: false } });
    loadDir("");
  }, [loadDir]);

  // Real-time file watching: refresh only directories that are currently loaded in the tree
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const [flashPaths, setFlashPaths] = useState<Set<string>>(new Set());

  useFsWatch(sessionId, useCallback((changes: FsChange[]) => {
    const t = treeRef.current;
    // Collect unique parent dirs that need a refresh
    const dirsToRefresh = new Set<string>();
    const changedPaths = new Set<string>();
    for (const c of changes) {
      changedPaths.add(c.path);
      if (t[c.dir] && t[c.dir].loaded) dirsToRefresh.add(c.dir);
    }
    for (const dir of dirsToRefresh) loadDir(dir);
    // Flash the changed paths briefly
    if (changedPaths.size) {
      setFlashPaths(changedPaths);
      setTimeout(() => setFlashPaths(new Set()), 1200);
    }
  }, [loadDir]));

  // Download / upload / mkdir handlers (after loadDir to avoid TDZ)
  const handleDownload = useCallback(async () => {
    if (!openFile) return;
    if (openFile.size !== undefined && openFile.size > MAX_TRANSFER_BYTES) {
      alert(`File is too large to download (${(openFile.size / 1024 / 1024).toFixed(1)} MB). Limit is ${MAX_TRANSFER_MB} MB.`);
      return;
    }
    try {
      await downloadFile(sessionId, openFile.path);
    } catch (e) { alert(String(e)); }
  }, [openFile, sessionId]);

  const handleCreateDir = useCallback(async () => {
    const name = newDirName.trim();
    if (!name) return;
    const fullPath = newDirParent ? `${newDirParent}/${name}` : name;
    try {
      await createDir(sessionId, fullPath);
      setCreatingDir(false);
      setNewDirParent("");
      setNewDirName("");
      await loadDir(newDirParent || "");
    } catch (e) { alert(String(e)); }
  }, [sessionId, newDirParent, newDirName, loadDir]);

  const handleUpload = useCallback(async () => {
    if (!uploadPending) return;
    if (uploadPending.size > MAX_TRANSFER_BYTES) {
      alert(`File is too large to upload (${(uploadPending.size / 1024 / 1024).toFixed(1)} MB). Limit is ${MAX_TRANSFER_MB} MB.`);
      return;
    }
    setUploading(true);
    try {
      await uploadFile(sessionId, uploadDir, uploadPending);
      setUploadForm(false);
      setUploadPending(null);
      setUploadDir("");
      await loadDir(uploadDir || "");
    } catch (e) { alert(String(e)); } finally { setUploading(false); }
  }, [sessionId, uploadDir, uploadPending, loadDir]);

  const handleRenameStart = useCallback((entry: FileEntry) => {
    setRenamingEntry(entry);
    setRenameValue(entry.name);
  }, []);

  const handleRenameCancel = useCallback(() => {
    setRenamingEntry(null);
    setRenameValue("");
  }, []);

  const handleRenameCommit = useCallback(async () => {
    if (!renamingEntry) return;
    const newName = renameValue.trim();
    if (!newName || newName === renamingEntry.name) { handleRenameCancel(); return; }
    try {
      await renameEntry(sessionId, renamingEntry.path, newName);
      const parentDir = renamingEntry.path.includes("/")
        ? renamingEntry.path.split("/").slice(0, -1).join("/")
        : "";
      setRenamingEntry(null);
      setRenameValue("");
      await loadDir(parentDir);
    } catch (e) { alert(String(e)); }
  }, [sessionId, renamingEntry, renameValue, handleRenameCancel, loadDir]);

  const DOWNLOAD_MAX_MB = 100;
  const DOWNLOAD_COMPRESS_MB = 16; // above this: zip with compression; below: direct/store

  // Download exclusion modal state
  const [dlModal, setDlModal] = useState<{ path: string; info: DirInfoResponse } | null>(null);
  const [dlLoading, setDlLoading] = useState(false);

  const handleDownloadEntry = useCallback(async (entry: FileEntry) => {
    if (entry.type === "dir") {
      setDlLoading(true);
      try {
        const info = await getDirInfo(sessionId, entry.path);
        if (info.total_size > DOWNLOAD_MAX_MB * 1024 * 1024) {
          setDlModal({ path: entry.path, info });
        } else {
          // Small dirs: store (no compression) for speed; large dirs: compress
          const compress = info.total_size > DOWNLOAD_COMPRESS_MB * 1024 * 1024;
          await downloadDirZip(sessionId, entry.path, [], compress);
        }
      } catch (e) { alert(String(e)); }
      finally { setDlLoading(false); }
      return;
    }
    // File
    const sizeMB = entry.size != null ? entry.size / 1024 / 1024 : null;
    if (sizeMB != null && sizeMB > DOWNLOAD_MAX_MB) {
      alert(`File too large to download (${sizeMB.toFixed(1)}MB). Limit is ${DOWNLOAD_MAX_MB}MB.`);
      return;
    }
    // Large files (>16MB): zip-compress before downloading
    if (sizeMB != null && sizeMB > DOWNLOAD_COMPRESS_MB) {
      if (!confirm(`File is ${sizeMB.toFixed(1)}MB. It will be downloaded as a zip. Continue?`)) return;
      try {
        await downloadDirZip(sessionId, entry.path, [], true);
      } catch (e) { alert(String(e)); }
      return;
    }
    try {
      await downloadFile(sessionId, entry.path);
    } catch (e) { alert(String(e)); }
  }, [sessionId]);

  // Download entire cwd (for session card button wired via parent)
  const handleDownloadCwd = useCallback(async () => {
    setDlLoading(true);
    try {
      const info = await getDirInfo(sessionId, "");
      if (info.total_size > DOWNLOAD_MAX_MB * 1024 * 1024) {
        setDlModal({ path: "", info });
      } else {
        await downloadDirZip(sessionId, "", []);
      }
    } catch (e) { alert(String(e)); }
    finally { setDlLoading(false); }
  }, [sessionId]);

  const handleMoveStart = useCallback((entry: FileEntry) => {
    setMovingEntry(entry);
    // Default destination = parent directory of the entry
    const parent = entry.path.includes("/")
      ? entry.path.split("/").slice(0, -1).join("/")
      : "";
    setMoveDestDir(parent);
  }, []);

  const handleMoveCommit = useCallback(async () => {
    if (!movingEntry) return;
    try {
      await moveEntry(sessionId, movingEntry.path, moveDestDir);
      const srcParent = movingEntry.path.includes("/")
        ? movingEntry.path.split("/").slice(0, -1).join("/")
        : "";
      setMovingEntry(null);
      // Reload both source parent and destination
      const dirs = new Set([srcParent, moveDestDir]);
      await Promise.all([...dirs].map((d) => loadDir(d)));
    } catch (e) { alert(String(e)); }
  }, [sessionId, movingEntry, moveDestDir, loadDir]);

  const handleListArchive = useCallback((entry: FileEntry) => {
    setArchiveViewPath(entry.path);
    setOpenFile(null);
    setFileError(null);
    setHistoryFile(null);
    setHistoryContent(null);
  }, []);

  const handleFileHistory = useCallback(async (entry: FileEntry) => {
    setHistoryLoading(true);
    setHistoryContent(null);
    try {
      const log = await getFileGitLog(sessionId, entry.path);
      setHistoryFile({ path: entry.path, entries: log });
      setOpenFile(null);
      setArchiveViewPath(null);
      setFileError(null);
    } catch (e) { alert(String(e)); }
    finally { setHistoryLoading(false); }
  }, [sessionId]);

  const handleHistorySearchSubmit = useCallback(async () => {
    const p = historySearchPath.trim().replace(/^\/+/, "");
    if (!p) return;
    setHistoryLoading(true);
    setHistoryContent(null);
    try {
      const log = await getFileGitLog(sessionId, p);
      setHistoryFile({ path: p, entries: log });
      setOpenFile(null);
      setArchiveViewPath(null);
      setFileError(null);
      setHistorySearchOpen(false);
    } catch (e) { alert(String(e)); }
    finally { setHistoryLoading(false); }
  }, [sessionId, historySearchPath]);

  const handleHistoryCommitClick = useCallback(async (filePath: string, commitHash: string) => {
    setHistoryLoading(true);
    try {
      const [showRes, diffRes] = await Promise.all([
        getFileGitShow(sessionId, filePath, commitHash),
        getFileGitDiff(sessionId, filePath, commitHash),
      ]);
      setHistoryContent({ commit: commitHash, full: showRes.content, diff: diffRes.diff });
    } catch (e) { alert(String(e)); }
    finally { setHistoryLoading(false); }
  }, [sessionId]);

  const handleExtractArchive = useCallback(async (entry: FileEntry) => {
    try {
      const res = await extractArchive(sessionId, entry.path);
      const parentDir = entry.path.includes("/")
        ? entry.path.split("/").slice(0, -1).join("/")
        : "";
      await loadDir(parentDir);
      alert(`Extracted to: ${res.output_dir}`);
    } catch (e) { alert(String(e)); }
  }, [sessionId, loadDir]);

  const toggleDir = useCallback(
    (path: string, loaded: boolean) => {
      if (!loaded) {
        loadDir(path);
      } else {
        setTree((t) => ({
          ...t,
          [path]: { ...t[path], expanded: !t[path]?.expanded },
        }));
      }
    },
    [loadDir]
  );

  // Preview-only overrides: null = show original content
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewExt, setPreviewExt] = useState<string>("");
  const [previewLabel, setPreviewLabel] = useState<string>("");
  const clearPreview = useCallback(() => {
    setPreviewContent(null); setPreviewExt(""); setPreviewLabel(""); setJsonFmtError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFileHandler = useCallback(
    async (entry: FileEntry) => {
      if (openFile && openFile.content !== openFile.savedContent) {
        if (!confirm("Unsaved changes will be lost. Continue?")) return;
      }
      setFileError(null);
      setJsonFmtError(null);
      setPreviewContent(null); setPreviewExt(""); setPreviewLabel("");
      setArchiveViewPath(null);
      setHistoryFile(null);
      setHistoryContent(null);
      if (entry.is_sqlite) {
        const kind = "sqlite";
        setOpenFile({ path: entry.path, content: "", savedContent: "", kind, isSqlite: true });
        setViewMode("preview");
        return;
      }

      if (getExt(entry.name) === "pdf") {
        setOpenFile({ path: entry.path, content: "", savedContent: "", kind: "pdf", isSqlite: false, size: entry.size ?? undefined });
        setViewMode("preview");
        return;
      }

      if (IMAGE_EXTS.has(getExt(entry.name))) {
        setOpenFile({ path: entry.path, content: "", savedContent: "", kind: "image", isSqlite: false, size: entry.size ?? undefined });
        setViewMode("preview");
        return;
      }

      if (VIDEO_EXTS.has(getExt(entry.name)) || AUDIO_EXTS.has(getExt(entry.name))) {
        const kind = VIDEO_EXTS.has(getExt(entry.name)) ? "video" : "audio";
        setOpenFile({ path: entry.path, content: "", savedContent: "", kind, isSqlite: false, size: entry.size ?? undefined });
        setViewMode("preview");
        return;
      }

      try {
        const res = await readFile(sessionId, entry.path);
        const kind = getFileKind(res.path, false);
        setOpenFile({ path: res.path, content: res.content, savedContent: res.content, kind, isSqlite: false, size: entry.size ?? undefined });
        setViewMode("preview");
        if (kind === "edit") {
          setTimeout(() => textareaRef.current?.focus(), 50);
        }
      } catch (e: unknown) {
        setFileError(String(e));
      }
    },
    [sessionId, openFile]
  );

  const handleSave = useCallback(async () => {
    if (!openFile || saving || openFile.isSqlite) return;
    setSaving(true);
    try {
      await writeFile(sessionId, openFile.path, openFile.content);
      setOpenFile((f) => (f ? { ...f, savedContent: f.content } : f));
    } catch (e) {
      alert(String(e));
    } finally {
      setSaving(false);
    }
  }, [sessionId, openFile, saving]);

  const startCreating = useCallback((dirPath: string) => {
    setCreatingFile(true);
    setNewFileParent(dirPath);
    setNewFileName("");
    setTimeout(() => newFileInputRef.current?.focus(), 30);
  }, []);

  const handleCreateFile = useCallback(async () => {
    const name = newFileName.trim();
    if (!name || !creatingFile) return;
    const relPath = newFileParent ? `${newFileParent}/${name}` : name;
    try {
      await writeFile(sessionId, relPath, "");
      setCreatingFile(false);
      setNewFileParent("");
      setNewFileName("");
      // Reload the parent directory in the tree
      const parentDir = relPath.includes("/") ? relPath.split("/").slice(0, -1).join("/") : "";
      await loadDir(parentDir);
      // Open the new file
      const kind = getFileKind(relPath, false);
      setOpenFile({ path: relPath, content: "", savedContent: "", kind, isSqlite: false });
      setViewMode("edit");
      setFileError(null);
      setTimeout(() => textareaRef.current?.focus(), 50);
    } catch (e) {
      alert(String(e));
    }
  }, [sessionId, newFileName, newFileParent, creatingFile, loadDir]);

  // Ctrl/Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  const isModified = openFile ? openFile.content !== openFile.savedContent : false;

  const ext = openFile ? getExt(openFile.path) : "";
  const supportsPreview = openFile && (openFile.kind === "code" || openFile.kind === "csv" || openFile.kind === "jsonl" || openFile.kind === "markdown" || openFile.kind === "pdf");
  const isJsonl = openFile && ext === "jsonl";
  const sourceFmt: ConfigFormat | null = openFile && !isJsonl ? detectFormat(openFile.path) : null;

  const [jsonFmtError, setJsonFmtError] = useState<string | null>(null);
  const [convertTarget, setConvertTarget] = useState<"raw" | ConfigFormat>("raw");

  // Reset target on file change
  useEffect(() => {
    setConvertTarget("raw");
    setJsonFmtError(null);
  }, [openFile?.path]);

  // Apply target → preview content
  const [convertError, setConvertError] = useState<string | null>(null);
  useEffect(() => {
    if (!openFile || !sourceFmt || convertTarget === "raw") {
      setConvertError(null);
      if (!previewLabel.startsWith("Formatted JSONL")) clearPreview();
      return;
    }
    const r = convert(openFile.content, sourceFmt, convertTarget, { jsonRepair: repairAndFormatJson });
    if (r.ok) {
      setConvertError(null);
      setPreviewContent(r.content);
      setPreviewExt(extFor(convertTarget));
      setPreviewLabel(sourceFmt === convertTarget ? `Formatted ${convertTarget.toUpperCase()}` : `→ ${convertTarget.toUpperCase()}`);
    } else {
      setConvertError(r.error);
      clearPreview();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFile?.content, sourceFmt, convertTarget]);

  // JSONL: keep per-line format button
  const handleFormatJsonl = useCallback(() => {
    if (!openFile) return;
    if (previewLabel === "Formatted JSONL") { clearPreview(); return; }
    clearPreview();
    try {
      const lines = openFile.content.split("\n").map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return "";
        return repairAndFormatJson(trimmed);
      });
      setPreviewContent(lines.join("\n"));
      setPreviewExt("jsonl");
      setPreviewLabel("Formatted JSONL");
    } catch (e) { setJsonFmtError(String(e)); }
  }, [openFile, previewLabel, clearPreview]);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {/* Download exclusion dialog */}
        {dlModal && (
          <DownloadExclusionModal
            sessionId={sessionId}
            basePath={dlModal.path}
            info={dlModal.info}
            onClose={() => setDlModal(null)}
          />
        )}

        {/* Move dialog */}
        {movingEntry && (
          <div
            onClick={() => setMovingEntry(null)}
            style={{ position: "absolute", inset: 0, zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)", borderRadius: 10 }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 20, width: 360, display: "flex", flexDirection: "column", gap: 12 }}
            >
              <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>
                Move <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{movingEntry.path}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Select destination directory:</div>
              <DirPicker sessionId={sessionId} value={moveDestDir} onChange={setMoveDestDir} />
              <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "monospace" }}>
                → {moveDestDir || "/ (cwd)"}
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setMovingEntry(null)} style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 11, padding: "4px 12px" }}>Cancel</button>
                <button
                  onClick={handleMoveCommit}
                  style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 11, padding: "4px 14px" }}
                >Move here</button>
              </div>
            </div>
          </div>
        )}
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
            <FileIcon isDir size={13} />
            <span style={{ fontSize: 12, color: "var(--text-secondary)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {sessionCwd}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {isModified && (
              <span style={{ fontSize: 11, color: "#f59e0b" }}>● unsaved</span>
            )}
            {/* Preview label indicator */}
            {previewLabel && (
              <span style={{ fontSize: 11, color: "var(--accent-blue)", background: "rgba(88,166,255,0.12)", padding: "2px 8px", borderRadius: 4 }}>
                {previewLabel}
              </span>
            )}
            {jsonFmtError && (
              <span style={{ fontSize: 11, color: "var(--accent-red)" }}>Format failed</span>
            )}
            {/* JSONL: per-line format button */}
            {isJsonl && (
              <button
                onClick={handleFormatJsonl}
                style={{ background: previewLabel === "Formatted JSONL" ? "var(--accent-blue)" : "var(--text-faintest)", color: "#fff", fontSize: 11, padding: "4px 10px" }}
              >
                {previewLabel === "Formatted JSONL" ? "Raw" : "Format JSONL"}
              </button>
            )}
            {/* JSON / YAML / TOML conversion */}
            {sourceFmt && openFile && (
              <>
                <ConfigFormatToggle
                  source={sourceFmt}
                  target={convertTarget}
                  onChange={setConvertTarget}
                  error={convertError}
                />
                <ConfigCheckButton
                  content={openFile.content}
                  format={sourceFmt}
                  disabled={convertTarget !== "raw"}
                />
              </>
            )}
            {supportsPreview && (
              <button
                onClick={() => { clearPreview(); setViewMode((m) => m === "preview" ? "edit" : "preview"); }}
                style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 11, padding: "4px 10px" }}
              >
                {viewMode === "preview" ? "Edit" : "Preview"}
              </button>
            )}
            {openFile && !openFile.isSqlite && openFile.kind !== "pdf" && openFile.kind !== "image" && openFile.kind !== "video" && openFile.kind !== "audio" && (
              <button
                onClick={() => {
                  const text = previewContent ?? openFile.content;
                  const bytes = new Blob([text]).size;
                  if (bytes > 500 * 1024) {
                    alert(`File is too large to copy (${(bytes / 1024).toFixed(0)} KB). Limit is 500 KB.`);
                    return;
                  }
                  copyText(text);
                }}
                title="Copy file content to clipboard"
                style={{ background: "#2d1a4a", color: "#a78bfa", border: "1px solid #4c1d95", fontSize: 11, padding: "4px 10px" }}
              >
                Copy
              </button>
            )}
            {openFile && !openFile.isSqlite && openFile.kind !== "pdf" && openFile.kind !== "image" && openFile.kind !== "video" && openFile.kind !== "audio" && (
              <button
                onClick={handleSave}
                disabled={!isModified || saving}
                style={{ background: isModified ? "var(--accent-blue)" : "var(--text-faintest)", color: "#fff", fontSize: 11, padding: "4px 14px" }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            )}
            <button
              onClick={onClose}
              style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 12, padding: "4px 10px" }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* File tree */}
          <div style={{ ...treeStyle, width: treeWidth, minWidth: 140, maxWidth: 600 }}>
            {/* Search bar */}
            <div style={{ padding: "4px 6px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 4 }}>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search files…"
                style={{ flex: 1, background: "var(--bg-surface)", border: "1px solid var(--border-strong)", borderRadius: 4, padding: "3px 8px", color: "var(--text-primary)", fontSize: 11, outline: "none", boxSizing: "border-box" }}
              />
              {flashPaths.size > 0 && (
                <span title="Files changed" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-green)", flexShrink: 0, display: "inline-block", animation: "cursor-blink 0.8s step-end infinite" }} />
              )}
            </div>

            {/* New file toolbar — hidden during search */}
            {!searchQuery && (
              <div style={{ padding: "4px 6px 6px", borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
                {creatingFile ? (
                  /* New file form — DirPicker for parent + filename input */
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Parent directory:</div>
                    <DirPicker sessionId={sessionId} value={newFileParent} onChange={setNewFileParent} />
                    <div style={{ display: "flex", gap: 4 }}>
                      <input
                        ref={newFileInputRef}
                        value={newFileName}
                        onChange={(e) => setNewFileName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); handleCreateFile(); }
                          if (e.key === "Escape") { setCreatingFile(false); setNewFileParent(""); setNewFileName(""); }
                        }}
                        placeholder="filename.py"
                        autoFocus
                        style={{ flex: 1, background: "var(--bg-base)", border: "1px solid #374151", borderRadius: 3, padding: "3px 6px", color: "var(--text-body)", fontSize: 11, outline: "none", minWidth: 0 }}
                      />
                      <button onClick={handleCreateFile} disabled={!newFileName.trim()} style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 10, padding: "2px 8px", flexShrink: 0 }}>OK</button>
                      <button onClick={() => { setCreatingFile(false); setNewFileParent(""); setNewFileName(""); }} style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "2px 6px", flexShrink: 0 }}>✕</button>
                    </div>
                    {newFileName.trim() && (
                      <div style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "monospace" }}>
                        → {newFileParent ? `${newFileParent}/${newFileName.trim()}` : newFileName.trim()}
                      </div>
                    )}
                  </div>
                ) : creatingDir ? (
                  /* New dir form — DirPicker for parent + name input */
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Parent directory:</div>
                    <DirPicker sessionId={sessionId} value={newDirParent} onChange={setNewDirParent} />
                    <div style={{ display: "flex", gap: 4 }}>
                      <input
                        ref={newDirInputRef}
                        value={newDirName}
                        onChange={(e) => setNewDirName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleCreateDir(); } if (e.key === "Escape") { setCreatingDir(false); setNewDirParent(""); setNewDirName(""); } }}
                        placeholder="new-dir-name"
                        autoFocus
                        style={{ flex: 1, background: "var(--bg-base)", border: "1px solid #374151", borderRadius: 3, padding: "3px 6px", color: "var(--text-body)", fontSize: 11, outline: "none", minWidth: 0 }}
                      />
                      <button onClick={handleCreateDir} disabled={!newDirName.trim()} style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 10, padding: "2px 8px", flexShrink: 0 }}>OK</button>
                      <button onClick={() => { setCreatingDir(false); setNewDirParent(""); setNewDirName(""); }} style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "2px 6px", flexShrink: 0 }}>✕</button>
                    </div>
                    {newDirName.trim() && (
                      <div style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "monospace" }}>
                        → {newDirParent ? `${newDirParent}/${newDirName.trim()}` : newDirName.trim()}
                      </div>
                    )}
                  </div>
                ) : uploadForm ? (
                  /* Upload form — DirPicker for target dir */
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Upload to:</div>
                    <DirPicker sessionId={sessionId} value={uploadDir} onChange={setUploadDir} />
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <button
                        onClick={() => uploadInputRef.current?.click()}
                        style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "2px 8px", flexShrink: 0 }}
                      >
                        Choose file
                      </button>
                      <span style={{ fontSize: 10, color: uploadPending ? (uploadPending.size > MAX_TRANSFER_BYTES ? "var(--accent-red)" : "var(--text-secondary)") : "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {uploadPending ? `${uploadPending.name} (${formatSize(uploadPending.size)})` : "No file chosen"}
                      </span>
                      <input ref={uploadInputRef} type="file" style={{ display: "none" }} onChange={(e) => setUploadPending(e.target.files?.[0] ?? null)} />
                    </div>
                    {uploadPending && uploadPending.size > MAX_TRANSFER_BYTES && (
                      <span style={{ fontSize: 10, color: "var(--accent-red)" }}>File exceeds {MAX_TRANSFER_MB}MB limit</span>
                    )}
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        onClick={handleUpload}
                        disabled={!uploadPending || uploadPending.size > MAX_TRANSFER_BYTES || uploading}
                        style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 10, padding: "2px 10px", flex: 1 }}
                      >
                        {uploading ? "Uploading…" : "Upload"}
                      </button>
                      <button onClick={() => { setUploadForm(false); setUploadPending(null); setUploadDir(""); }} style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "2px 8px" }}>✕</button>
                    </div>
                  </div>
                ) : historySearchOpen ? (
                  <div style={{ display: "flex", gap: 4 }}>
                    <input
                      autoFocus
                      value={historySearchPath}
                      onChange={(e) => setHistorySearchPath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); handleHistorySearchSubmit(); }
                        if (e.key === "Escape") { setHistorySearchOpen(false); setHistorySearchPath(""); }
                      }}
                      placeholder="relative/path/to/file"
                      style={{ flex: 1, background: "var(--bg-base)", border: "1px solid #374151", borderRadius: 3, padding: "3px 6px", color: "var(--text-body)", fontSize: 11, outline: "none", minWidth: 0 }}
                    />
                    <button onClick={handleHistorySearchSubmit} disabled={!historySearchPath.trim() || historyLoading} style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 10, padding: "2px 8px", flexShrink: 0 }}>Go</button>
                    <button onClick={() => { setHistorySearchOpen(false); setHistorySearchPath(""); }} style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "2px 6px", flexShrink: 0 }}>✕</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => startCreating("")} style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "3px 0", flex: 1 }}>+ File</button>
                    <button onClick={() => { setCreatingDir(true); setTimeout(() => newDirInputRef.current?.focus(), 80); }} title="New folder" style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "3px 0", flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 3 }}><NewFolderIcon size={12} color="var(--text-body)" /><span>+ Dir</span></button>
                    <button onClick={() => setUploadForm(true)} style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "3px 0", flex: 1 }}>⬆ Upload</button>
                    <button
                      onClick={() => setHistorySearchOpen(true)}
                      title="View git history for any file path (including deleted files)"
                      style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "3px 6px", flexShrink: 0, display: "flex", alignItems: "center" }}
                    ><img src={gitIcon} style={{ width: 12, height: 12, filter: "invert(0.6)" }} /></button>
                    <button
                      onClick={handleDownloadCwd}
                      disabled={dlLoading}
                      title="Download working directory as zip"
                      style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 10, padding: "3px 6px", flexShrink: 0, display: "flex", alignItems: "center", opacity: dlLoading ? 0.5 : 1 }}
                    ><img src={downloadIcon} style={{ width: 12, height: 12, filter: "invert(0.6)" }} /></button>
                    <button
                      onClick={() => setShowHidden((v) => !v)}
                      title={showHidden ? "Hide dot-prefixed files" : "Show dot-prefixed files"}
                      style={{ background: showHidden ? "var(--accent-blue)" : "var(--bg-hover)", color: showHidden ? "#fff" : "var(--text-body)", fontSize: 10, padding: "3px 6px", flexShrink: 0 }}
                    >.*</button>
                  </div>
                )}
              </div>
            )}

            {/* Search results OR normal tree */}
            {searchQuery.trim() ? (
              searchLoading ? (
                <div style={{ padding: "12px 8px", color: "var(--text-faint)", fontSize: 12 }}>Searching…</div>
              ) : searchResults && searchResults.length === 0 ? (
                <div style={{ padding: "12px 8px", color: "var(--text-faint)", fontSize: 12 }}>No matches</div>
              ) : searchResults ? (
                <>
                  {searchResults.map((entry) => {
                    const isClickable = entry.is_text || entry.is_sqlite || getExt(entry.name) === "pdf" || IMAGE_EXTS.has(getExt(entry.name)) || VIDEO_EXTS.has(getExt(entry.name)) || AUDIO_EXTS.has(getExt(entry.name));
                    const isOpen = entry.path === openFile?.path;
                    return (
                      <div
                        key={entry.path}
                        onClick={() => isClickable && openFileHandler(entry)}
                        title={entry.path}
                        style={{
                          padding: "3px 8px", cursor: isClickable ? "pointer" : "default",
                          color: isOpen ? "var(--accent-blue)" : entry.type === "dir" ? "var(--text-secondary)" : isClickable ? "var(--text-primary)" : "var(--text-muted)",
                          background: isOpen ? "rgba(88,166,255,0.12)" : "transparent",
                          fontSize: 12, display: "flex", alignItems: "center", gap: 5, userSelect: "none", borderRadius: 3,
                        }}
                        onMouseEnter={(e) => { if (!isOpen) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!isOpen) e.currentTarget.style.background = "transparent"; }}
                      >
                        <FileIcon name={entry.name} isDir={entry.type === "dir"} size={13} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{entry.name}</span>
                        <span style={{ fontSize: 10, color: "var(--text-faintest)", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 80 }}>
                          {entry.path.slice(0, entry.path.length - entry.name.length - 1).split("/").pop() || ""}
                        </span>
                      </div>
                    );
                  })}
                </>
              ) : null
            ) : (
              <>
                <TreeEntries
                  entries={tree[""]?.entries ?? []}
                  tree={tree}
                  depth={0}
                  openPath={openFile?.path ?? null}
                  onToggle={toggleDir}
                  onOpen={openFileHandler}
                  onNewFileInDir={startCreating}
                  renamingPath={renamingEntry?.path ?? null}
                  renameValue={renameValue}
                  onRenameStart={handleRenameStart}
                  onRenameChange={setRenameValue}
                  onRenameCommit={handleRenameCommit}
                  onRenameCancel={handleRenameCancel}
                  onMoveStart={handleMoveStart}
                  onDownloadEntry={handleDownloadEntry}
                  onListArchive={handleListArchive}
                  onExtractArchive={handleExtractArchive}
                  onFileHistory={handleFileHistory}
                />
                {tree[""]?.loading && (
                  <div style={{ padding: 12, color: "var(--text-faint)", fontSize: 12 }}>Loading…</div>
                )}
                {tree[""]?.error && (
                  <div style={{ padding: 12, color: "var(--accent-red)", fontSize: 12 }}>{tree[""].error}</div>
                )}
              </>
            )}
          </div>

          {/* Drag handle */}
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              dragRef.current = { dragging: true, startX: e.clientX, startW: treeWidth };
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
            }}
            style={{ width: 4, background: "var(--bg-hover)", cursor: "col-resize", flexShrink: 0, transition: "background 0.15s" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--text-faintest)"; }}
            onMouseLeave={(e) => { if (!dragRef.current.dragging) (e.currentTarget as HTMLDivElement).style.background = "var(--bg-hover)"; }}
          />

          {/* Editor / Viewer */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {historyFile ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {/* History panel header */}
                <div style={{ padding: "4px 14px", background: "var(--bg-surface)", fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace", flexShrink: 0, borderBottom: "1px solid #1f2937", display: "flex", alignItems: "center", gap: 6 }}>
                  <img src={gitIcon} style={{ width: 13, height: 13, flexShrink: 0, filter: "invert(0.6)" }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1, minWidth: 0 }}>
                    {historyFile.path}
                  </span>
                  {historyContent && (
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <button
                        onClick={() => setHistoryViewMode("diff")}
                        style={{ background: historyViewMode === "diff" ? "var(--accent-blue)" : "var(--text-faintest)", color: "#fff", fontSize: 10, padding: "1px 8px", borderRadius: 3, border: "none", cursor: "pointer" }}
                      >Diff</button>
                      <button
                        onClick={() => setHistoryViewMode("full")}
                        style={{ background: historyViewMode === "full" ? "var(--accent-blue)" : "var(--text-faintest)", color: "#fff", fontSize: 10, padding: "1px 8px", borderRadius: 3, border: "none", cursor: "pointer" }}
                      >Full</button>
                    </div>
                  )}
                  {historyLoading && <span style={{ color: "var(--text-faint)", flexShrink: 0 }}>Loading…</span>}
                  <button onClick={() => { setHistoryFile(null); setHistoryContent(null); }} style={{ background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", flexShrink: 0 }}>✕</button>
                </div>
                {/* History body: commit list + optional content view */}
                <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
                  {/* Commit list */}
                  <div style={{ width: historyContent ? 300 : undefined, flex: historyContent ? undefined : 1, overflowY: "auto", borderRight: historyContent ? "1px solid #1f2937" : undefined, flexShrink: 0 }}>
                    {historyFile.entries.length === 0 ? (
                      <div style={{ padding: "24px 16px", color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>No history found</div>
                    ) : (
                      historyFile.entries.map((entry) => {
                        const isSelected = historyContent?.commit === entry.hash;
                        const dateStr = entry.date.slice(0, 16).replace("T", " ");
                        return (
                          <div
                            key={entry.hash}
                            onClick={() => handleHistoryCommitClick(historyFile.path, entry.hash)}
                            style={{
                              padding: "7px 12px",
                              borderBottom: "1px solid #1a2030",
                              cursor: "pointer",
                              background: isSelected ? "rgba(88,166,255,0.12)" : "transparent",
                              display: "flex",
                              flexDirection: "column",
                              gap: 2,
                            }}
                            onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                            onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--accent-blue)", flexShrink: 0 }}>{entry.short_hash}</span>
                              <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{dateStr}</span>
                              <span style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.author}</span>
                            </div>
                            <div style={{ fontSize: 12, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.subject}</div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  {/* Content viewer for selected commit */}
                  {historyContent && (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                      {/* Sub-header: commit hash + file name */}
                      <div style={{ padding: "4px 10px", background: "var(--bg-base)", fontSize: 11, color: "var(--text-muted)", flexShrink: 0, borderBottom: "1px solid #1f2937", display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{historyContent.commit.slice(0, 8)}</span>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{historyFile.path.split("/").pop()}</span>
                        <button onClick={() => setHistoryContent(null)} style={{ background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}>✕</button>
                      </div>
                      {historyViewMode === "full"
                        ? <CodeViewer content={historyContent.full} ext={getExt(historyFile.path)} />
                        : <DiffViewer diff={historyContent.diff} />
                      }
                    </div>
                  )}
                </div>
              </div>
            ) : archiveViewPath && !openFile ? (
              <>
                <div style={{ padding: "4px 14px", background: "var(--bg-surface)", fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace", flexShrink: 0, borderBottom: "1px solid #1f2937", display: "flex", alignItems: "center", gap: 6 }}>
                  <span>🗜️</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{archiveViewPath}</span>
                  <button onClick={() => setArchiveViewPath(null)} style={{ background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}>✕</button>
                </div>
                <ArchiveViewer sessionId={sessionId} path={archiveViewPath} />
              </>
            ) : openFile ? (
              <>
                {/* File tab */}
                <div style={{
                  padding: "4px 14px",
                  background: "var(--bg-surface)",
                  fontSize: 11,
                  color: isModified ? "#f59e0b" : "var(--text-secondary)",
                  fontFamily: "monospace",
                  flexShrink: 0,
                  borderBottom: "1px solid #1f2937",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}>
                  <FileIcon name={openFile.path.split("/").pop()!} size={13} />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{openFile.path}</span>
                  {isModified && <span style={{ color: "#f59e0b", flexShrink: 0 }}>●</span>}
                  {openFile.size !== undefined && (
                    <span style={{ color: "var(--text-faint)", flexShrink: 0 }}>{formatSize(openFile.size)}</span>
                  )}
                  {!openFile.isSqlite && (
                    <button
                      onClick={handleDownload}
                      title={openFile.size !== undefined && openFile.size > MAX_TRANSFER_BYTES ? `Too large to download (>${MAX_TRANSFER_MB}MB)` : "Download file"}
                      style={{ background: "transparent", border: "none", padding: "0 2px", cursor: "pointer", flexShrink: 0, lineHeight: 1, display: "flex", alignItems: "center" }}
                    >
                      <img src={downloadIcon} style={{ width: 14, height: 14, filter: openFile.size !== undefined && openFile.size > MAX_TRANSFER_BYTES ? "invert(0.3)" : "invert(0.6)" }} />
                    </button>
                  )}
                </div>

                {/* Auto-validation banner (only on Raw view of config files) */}
                {sourceFmt && convertTarget === "raw" && (
                  <ConfigValidationBanner content={openFile.content} format={sourceFmt} />
                )}

                {/* Content area */}
                {openFile.kind === "sqlite" ? (
                  <SqliteViewer sessionId={sessionId} path={openFile.path} />
                ) : openFile.kind === "pdf" ? (
                  <PdfViewer sessionId={sessionId} path={openFile.path} />
                ) : openFile.kind === "image" ? (
                  <ImageViewer sessionId={sessionId} path={openFile.path} />
                ) : openFile.kind === "video" ? (
                  <VideoViewer sessionId={sessionId} path={openFile.path} />
                ) : openFile.kind === "audio" ? (
                  <AudioViewer sessionId={sessionId} path={openFile.path} />
                ) : previewContent !== null ? (
                  // Preview overlay (Format JSON / → YAML / → JSON)
                  (() => {
                    const pExt = previewExt || ext;
                    if (pExt === "jsonl") return <JsonlViewer content={previewContent} />;
                    if (pExt === "yaml" || pExt === "yml") return <CodeViewer content={previewContent} ext="yaml" />;
                    return <CodeViewer content={previewContent} ext="json" />;
                  })()
                ) : openFile.kind === "csv" && viewMode === "preview" ? (
                  <CsvViewer content={openFile.content} delimiter={ext === "tsv" ? "\t" : ","} />
                ) : openFile.kind === "jsonl" && viewMode === "preview" ? (
                  <JsonlViewer content={openFile.content} />
                ) : openFile.kind === "markdown" && viewMode === "preview" ? (
                  <MarkdownViewer content={openFile.content} />
                ) : openFile.kind === "code" && viewMode === "preview" ? (
                  <CodeViewer content={openFile.content} ext={ext} />
                ) : (
                  <CodeMirrorEditor
                    content={openFile.content}
                    ext={ext}
                    onChange={(v) => setOpenFile((f) => f ? { ...f, content: v } : f)}
                    onSave={handleSave}
                  />
                )}
              </>
            ) : (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-faintest)", fontSize: 13, gap: 8 }}>
                {fileError ? (
                  <span style={{ color: "var(--accent-red)" }}>{fileError}</span>
                ) : (
                  <>
                    <FileIcon size={36} />
                    <span>Select a file to view or edit</span>
                    <span style={{ fontSize: 11, color: "var(--bg-hover)" }}>Ctrl+S to save</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2000,
};

const modalStyle: React.CSSProperties = {
  position: "relative",
  width: "92vw",
  height: "90vh",
  background: "var(--bg-base)",
  borderRadius: 10,
  border: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 14px",
  borderBottom: "1px solid #1f2937",
  background: "var(--bg-surface)",
  flexShrink: 0,
  gap: 12,
};

const treeStyle: React.CSSProperties = {
  width: 260,
  minWidth: 200,
  overflowY: "auto",
  overflowX: "hidden",
  padding: "6px 4px",
  background: "var(--bg-base)",
  flexShrink: 0,
};

const editorStyle: React.CSSProperties = {
  background: "var(--bg-base)",
  color: "var(--text-primary)",
  border: "none",
  outline: "none",
  fontFamily: '"Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace',
  fontSize: 13,
  lineHeight: 1.6,
  padding: "12px 16px",
  resize: "none",
  tabSize: 2,
};
