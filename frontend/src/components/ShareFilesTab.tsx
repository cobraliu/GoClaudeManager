import { useCallback, useEffect, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import {
  getPublicShareFiles,
  getPublicShareFileContent,
  publicShareRawUrl,
  type ShareFileEntry,
} from "../api/sessionApi";
import { renderMarkdown } from "../lib/markdown";

type Theme = "light" | "dark";

interface Palette {
  bg: string; panel: string; border: string; text: string; muted: string;
  hover: string; accent: string; codeBg: string; gutter: string;
}

const PALETTE: Record<Theme, Palette> = {
  light: { bg: "#ffffff", panel: "#f6f8fa", border: "#e2e5e9", text: "#1f2328", muted: "#8a9099", hover: "#eef1f4", accent: "#2563eb", codeBg: "#f6f8fa", gutter: "#b6bcc4" },
  dark: { bg: "#1e1e1e", panel: "#181818", border: "#333", text: "#d7dce2", muted: "#8b929b", hover: "#2a2a2a", accent: "#58a6ff", codeBg: "#161b22", gutter: "#5a6068" },
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "tiff", "tif", "ico", "svg"]);
const HLJS_LANGS: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", py: "python", rb: "ruby", go: "go",
  rs: "rust", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", cc: "cpp",
  hpp: "cpp", cs: "csharp", php: "php", swift: "swift", scala: "scala",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", json: "json",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", sql: "sql",
  css: "css", scss: "scss", less: "less", html: "xml", xml: "xml",
  lua: "lua", pl: "perl", r: "r", diff: "diff", patch: "diff", make: "makefile",
};

function ext(name: string): string { return name.split(".").pop()?.toLowerCase() ?? ""; }
function isImage(name: string): boolean { return IMAGE_EXTS.has(ext(name)); }
function isCsv(name: string): boolean { const e = ext(name); return e === "csv" || e === "tsv"; }
function isMd(name: string): boolean { const e = ext(name); return e === "md" || e === "markdown"; }
function isHtml(name: string): boolean { const e = ext(name); return e === "html" || e === "htm"; }

function parseCsv(content: string, delimiter: string): string[][] {
  return content.trim().split("\n").map((line) => {
    const cells: string[] = [];
    let cur = "", inQ = false;
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
}

// ── file tree (read-only, lazy) ─────────────────────────────────────────────

function TreeNode({
  entry, hash, depth, selectedPath, onSelect, pal,
}: {
  entry: ShareFileEntry; hash: string; depth: number;
  selectedPath: string; onSelect: (e: ShareFileEntry) => void; pal: Palette;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<ShareFileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const isDir = entry.type === "dir";
  const selected = !isDir && entry.path === selectedPath;

  const toggle = useCallback(async () => {
    if (isDir) {
      const next = !expanded;
      setExpanded(next);
      if (next && children === null) {
        setLoading(true);
        try {
          const res = await getPublicShareFiles(hash, entry.path);
          setChildren(res.entries);
        } catch { setChildren([]); }
        finally { setLoading(false); }
      }
    } else {
      onSelect(entry);
    }
  }, [isDir, expanded, children, hash, entry, onSelect]);

  const indent = 6 + depth * 14;
  return (
    <div>
      <div
        onClick={toggle}
        style={{
          display: "flex", alignItems: "center", gap: 5, cursor: "pointer",
          padding: `4px 8px 4px ${indent}px`, fontSize: 13,
          background: selected ? pal.hover : "transparent",
          color: selected ? pal.accent : pal.text,
          borderRadius: 4,
        }}
        onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.background = pal.hover; }}
        onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        {isDir ? (
          <span style={{ width: 10, fontSize: 9, color: pal.muted, flexShrink: 0 }}>
            {loading ? "…" : expanded ? "▼" : "▶"}
          </span>
        ) : (
          <span style={{ width: 10, flexShrink: 0 }} />
        )}
        <span style={{ fontSize: 13, flexShrink: 0 }}>{isDir ? "📁" : "📄"}</span>
        <span style={{ fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {entry.name}
        </span>
      </div>
      {expanded && children && children.map((c) => (
        <TreeNode key={c.path} entry={c} hash={hash} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} pal={pal} />
      ))}
      {expanded && children && children.length === 0 && (
        <div style={{ padding: `2px 8px 2px ${indent + 25}px`, fontSize: 11, color: pal.muted }}>(空)</div>
      )}
    </div>
  );
}

// ── right-side content panel ────────────────────────────────────────────────

function FileContent({ hash, entry, pal, theme }: { hash: string; entry: ShareFileEntry; pal: Palette; theme: Theme }) {
  const [content, setContent] = useState<string | null>(null);
  const [isText, setIsText] = useState(true);
  const [tooLarge, setTooLarge] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [raw, setRaw] = useState(false); // raw vs preview for csv/md/html
  const [htmlMax, setHtmlMax] = useState(false); // html preview filling the viewport

  useEffect(() => {
    if (!htmlMax) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setHtmlMax(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [htmlMax]);

  const image = isImage(entry.name);
  const canPreview = isCsv(entry.name) || isMd(entry.name) || isHtml(entry.name);

  useEffect(() => {
    setRaw(false);
    setHtmlMax(false);
    if (image) { setContent(null); return; }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    getPublicShareFileContent(hash, entry.path)
      .then((d) => {
        if (cancelled) return;
        setContent(d.content);
        setIsText(d.is_text);
        setTooLarge(d.too_large);
      })
      .catch((e) => { if (!cancelled) setErr(String(e instanceof Error ? e.message : e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [hash, entry.path, image]);

  const placeholder = (msg: string) => (
    <div style={{ padding: 40, textAlign: "center", color: pal.muted, fontSize: 13 }}>{msg}</div>
  );

  let inner: React.ReactNode;
  if (image) {
    inner = (
      <div style={{ padding: 16, textAlign: "center" }}>
        <img src={publicShareRawUrl(hash, entry.path)} alt={entry.name}
          style={{ maxWidth: "100%", height: "auto", borderRadius: 6, border: `1px solid ${pal.border}` }} />
      </div>
    );
  } else if (loading) {
    inner = placeholder("加载中…");
  } else if (err) {
    inner = placeholder(err);
  } else if (tooLarge) {
    inner = placeholder("文件过大，不可在线查看");
  } else if (!isText) {
    inner = placeholder("该文件类型不可在线查看");
  } else if (content !== null) {
    if (!raw && isCsv(entry.name)) {
      inner = <CsvTable content={content} delimiter={ext(entry.name) === "tsv" ? "\t" : ","} pal={pal} />;
    } else if (!raw && isMd(entry.name)) {
      inner = <div className="md" style={{ padding: 16, color: pal.text }} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />;
    } else if (!raw && isHtml(entry.name)) {
      // allow-scripts WITHOUT allow-same-origin: the page runs its JS as an
      // opaque origin (interactive) but cannot reach our cookies/API. Same
      // sandbox the in-session HtmlViewer uses.
      inner = (
        <>
          <iframe title={entry.name} srcDoc={content} sandbox="allow-scripts"
            style={htmlMax
              ? { position: "fixed", inset: 0, width: "100vw", height: "100vh", border: "none", background: "#fff", zIndex: 9999 }
              : { width: "100%", height: "70vh", border: "none", background: "#fff" }} />
          {htmlMax && (
            <button
              onClick={() => setHtmlMax(false)}
              title="还原 (Esc)"
              style={{ position: "fixed", top: 12, right: 12, zIndex: 10000, fontSize: 12, padding: "5px 12px", borderRadius: 6, cursor: "pointer", background: pal.panel, color: pal.text, border: `1px solid ${pal.border}`, boxShadow: "0 2px 8px rgba(0,0,0,.3)" }}
            >⤡ 还原</button>
          )}
        </>
      );
    } else {
      inner = <CodeBlock code={content} lang={HLJS_LANGS[ext(entry.name)]} pal={pal} theme={theme} />;
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 12px", borderBottom: `1px solid ${pal.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: "monospace", fontSize: 12, color: pal.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.path}</span>
        {content !== null && isText && !tooLarge && (
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {!raw && isHtml(entry.name) && (
              <button
                onClick={() => setHtmlMax(true)}
                title="最大化 (Esc 还原)"
                style={{ fontSize: 12, padding: "3px 10px", borderRadius: 5, cursor: "pointer", background: pal.panel, color: pal.text, border: `1px solid ${pal.border}` }}
              >
                ⤢ 最大化
              </button>
            )}
            {canPreview && (
              <button
                onClick={() => { setRaw((v) => !v); setHtmlMax(false); }}
                style={{ fontSize: 12, padding: "3px 10px", borderRadius: 5, cursor: "pointer", background: pal.panel, color: pal.text, border: `1px solid ${pal.border}` }}
              >
                {raw ? "预览" : "原始"}
              </button>
            )}
          </div>
        )}
      </div>
      <div style={{ overflow: "auto" }}>{inner}</div>
    </div>
  );
}

function CsvTable({ content, delimiter, pal }: { content: string; delimiter: string; pal: Palette }) {
  const rows = parseCsv(content, delimiter);
  if (rows.length === 0) return <div style={{ padding: 16, color: pal.muted }}>空文件</div>;
  const [header, ...body] = rows;
  return (
    <div style={{ overflowX: "auto", padding: 12 }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, fontFamily: "monospace", color: pal.text }}>
        <thead>
          <tr>{header.map((h, i) => (
            <th key={i} style={{ border: `1px solid ${pal.border}`, padding: "4px 8px", background: pal.panel, textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>{header.map((_, ci) => (
              <td key={ci} style={{ border: `1px solid ${pal.border}`, padding: "4px 8px", whiteSpace: "nowrap" }}>{r[ci] ?? ""}</td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock({ code, lang, pal, theme }: { code: string; lang?: string; pal: Palette; theme: Theme }) {
  let html: string;
  try {
    html = lang && hljs.getLanguage(lang)
      ? hljs.highlight(code, { language: lang }).value
      : hljs.highlightAuto(code).value;
  } catch {
    html = code.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
  }
  const lineCount = code.split("\n").length;
  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
  // Explicit font metrics on BOTH <pre> so the gutter and code lines stay
  // aligned (the `monospace` keyword resets font-size in some browsers).
  const preFont: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace", fontSize: 12.5, lineHeight: 1.6 };
  return (
    <div className={`cmf-code cmf-${theme}`} style={{ display: "flex", background: pal.codeBg }}>
      <pre style={{ ...preFont, margin: 0, padding: "12px 8px", textAlign: "right", color: pal.gutter, userSelect: "none", whiteSpace: "pre", flexShrink: 0 }}>{gutter}</pre>
      <pre style={{ ...preFont, margin: 0, padding: 12, whiteSpace: "pre", overflowX: "auto", flex: 1 }}>
        <code className="hljs" style={{ ...preFont, background: "transparent", padding: 0 }} dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

// hljs token colors (github light / dark), scoped under .cmf-{theme}.
function hljsThemeCss(): string {
  return `
.cmf-light .hljs{color:#1f2328}
.cmf-light .hljs-comment,.cmf-light .hljs-quote{color:#6a737d}
.cmf-light .hljs-keyword,.cmf-light .hljs-selector-tag,.cmf-light .hljs-built_in,.cmf-light .hljs-name,.cmf-light .hljs-tag{color:#d73a49}
.cmf-light .hljs-string,.cmf-light .hljs-doctag,.cmf-light .hljs-template-variable,.cmf-light .hljs-variable,.cmf-light .hljs-regexp,.cmf-light .hljs-addition{color:#032f62}
.cmf-light .hljs-literal,.cmf-light .hljs-number,.cmf-light .hljs-bullet,.cmf-light .hljs-symbol,.cmf-light .hljs-link{color:#005cc5}
.cmf-light .hljs-title,.cmf-light .hljs-section,.cmf-light .hljs-attr,.cmf-light .hljs-attribute,.cmf-light .hljs-type,.cmf-light .hljs-class .hljs-title{color:#6f42c1}
.cmf-light .hljs-meta,.cmf-light .hljs-deletion{color:#b31d28}
.cmf-dark .hljs{color:#c9d1d9}
.cmf-dark .hljs-comment,.cmf-dark .hljs-quote{color:#8b949e}
.cmf-dark .hljs-keyword,.cmf-dark .hljs-selector-tag,.cmf-dark .hljs-built_in,.cmf-dark .hljs-name,.cmf-dark .hljs-tag{color:#ff7b72}
.cmf-dark .hljs-string,.cmf-dark .hljs-doctag,.cmf-dark .hljs-template-variable,.cmf-dark .hljs-variable,.cmf-dark .hljs-regexp,.cmf-dark .hljs-addition{color:#a5d6ff}
.cmf-dark .hljs-literal,.cmf-dark .hljs-number,.cmf-dark .hljs-bullet,.cmf-dark .hljs-symbol,.cmf-dark .hljs-link{color:#79c0ff}
.cmf-dark .hljs-title,.cmf-dark .hljs-section,.cmf-dark .hljs-attr,.cmf-dark .hljs-attribute,.cmf-dark .hljs-type,.cmf-dark .hljs-class .hljs-title{color:#d2a8ff}
.cmf-dark .hljs-meta,.cmf-dark .hljs-deletion{color:#ffa198}
`;
}

// ── main Files tab ───────────────────────────────────────────────────────────

export function ShareFilesTab({ hash, theme }: { hash: string; theme: Theme }) {
  const pal = PALETTE[theme];
  const [roots, setRoots] = useState<ShareFileEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<ShareFileEntry | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 700);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const styleRef = useRef<HTMLStyleElement | null>(null);

  useEffect(() => {
    const s = document.createElement("style");
    s.setAttribute("data-share-files", "");
    s.textContent = hljsThemeCss();
    document.head.appendChild(s);
    styleRef.current = s;
    return () => { s.remove(); };
  }, []);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 700);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    getPublicShareFiles(hash, "")
      .then((r) => setRoots(r.entries))
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
  }, [hash]);

  const tree = (
    <div style={{ overflowY: "auto", padding: 6, flex: 1, minHeight: 0 }}>
      {err ? (
        <div style={{ padding: 12, fontSize: 12, color: "#c0392b" }}>{err}</div>
      ) : roots === null ? (
        <div style={{ padding: 12, fontSize: 12, color: pal.muted }}>加载文件树…</div>
      ) : roots.length === 0 ? (
        <div style={{ padding: 12, fontSize: 12, color: pal.muted }}>无可见文件</div>
      ) : (
        roots.map((e) => (
          <TreeNode key={e.path} entry={e} hash={hash} depth={0} selectedPath={selected?.path ?? ""} onSelect={setSelected} pal={pal} />
        ))
      )}
    </div>
  );

  const content = selected ? (
    <FileContent key={selected.path} hash={hash} entry={selected} pal={pal} theme={theme} />
  ) : (
    <div style={{ padding: 40, textAlign: "center", color: pal.muted, fontSize: 13 }}>从左侧选择一个文件查看</div>
  );

  if (narrow) {
    return (
      <div style={{ border: `1px solid ${pal.border}`, borderRadius: 8, overflow: "hidden", background: pal.bg }}>
        {selected ? (
          <div>
            <button
              onClick={() => setSelected(null)}
              style={{ width: "100%", textAlign: "left", padding: "8px 12px", border: "none", borderBottom: `1px solid ${pal.border}`, background: pal.panel, color: pal.accent, fontSize: 13, cursor: "pointer" }}
            >← 文件列表</button>
            {content}
          </div>
        ) : tree}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", border: `1px solid ${pal.border}`, borderRadius: 8, overflow: "hidden", background: pal.bg, minHeight: 360 }}>
      {treeCollapsed ? (
        <button
          onClick={() => setTreeCollapsed(false)}
          title="展开目录树"
          style={{ width: 34, flexShrink: 0, borderRight: `1px solid ${pal.border}`, background: pal.panel, color: pal.muted, border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "10px 0", fontSize: 13 }}
        >
          <span>📁</span><span>▶</span>
        </button>
      ) : (
        <div style={{ width: 260, flexShrink: 0, borderRight: `1px solid ${pal.border}`, background: pal.panel, maxHeight: "78vh", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 8px 5px 10px", borderBottom: `1px solid ${pal.border}`, flexShrink: 0 }}>
            <span style={{ fontSize: 12, color: pal.muted }}>文件</span>
            <button
              onClick={() => setTreeCollapsed(true)}
              title="收起目录树"
              style={{ fontSize: 12, padding: "2px 8px", cursor: "pointer", background: pal.bg, color: pal.text, border: `1px solid ${pal.border}`, borderRadius: 4 }}
            >◀ 收起</button>
          </div>
          {tree}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0, maxHeight: "78vh", overflow: "auto" }}>{content}</div>
    </div>
  );
}
