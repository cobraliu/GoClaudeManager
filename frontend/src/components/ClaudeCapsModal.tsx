import { useState, useEffect, useRef, useCallback } from "react";
import { renderMarkdown } from "../lib/markdown";
import {
  listClaudeCaps,
  readClaudeCapFile,
  writeClaudeCapFile,
  deleteClaudeCapFile,
  listCapVersions,
  rollbackCapVersion,
  readCapVersionContent,
  type CapItem,
  type CapSection,
  type CapListResponse,
  type CapVersion,
} from "../api/sessionApi";

// ── Types ─────────────────────────────────────────────────────────────────────

type Scope = "global" | "project";

interface EditorState {
  scope: Scope;
  section: CapSection;
  item: CapItem | null;
  relpath: string;
  content: string;
  originalContent: string;
  loading: boolean;
  saving: boolean;
  deleting: boolean;
  newName: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileExt(section: CapSection): string {
  return section.new_template === "json" ? ".json" : ".md";
}

function defaultContent(section: CapSection, name: string): string {
  if (section.new_template === "json") return "{}";
  return `# ${name}\n\n`;
}

function fmtSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}K`;
}

function relTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch { return iso; }
}

function fileKind(relpath: string): "md" | "json" | "other" {
  if (relpath.endsWith(".md")) return "md";
  if (relpath.endsWith(".json")) return "other"; // json handled separately
  return "other";
}

// ── Main component ────────────────────────────────────────────────────────────

export function ClaudeCapsModal({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
  const [scope, setScope] = useState<Scope>("global");
  const [data, setData] = useState<CapListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [historyEditor, setHistoryEditor] = useState<EditorState | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const load = useCallback(async (s: Scope) => {
    setLoading(true); setError("");
    try {
      const res = await listClaudeCaps(s, s === "project" ? (cwd ?? undefined) : undefined);
      setData(res);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [cwd]);

  useEffect(() => { load(scope); }, [scope, load]);

  useEffect(() => {
    if (historyEditor) {
      history.pushState({ capsHistory: true }, "");
      const onPop = () => setHistoryEditor(null);
      window.addEventListener("popstate", onPop);
      return () => window.removeEventListener("popstate", onPop);
    }
  }, [!!historyEditor]);

  useEffect(() => {
    if (editor && !historyEditor) {
      history.pushState({ capsEditor: true }, "");
      const onPop = () => setEditor(null);
      window.addEventListener("popstate", onPop);
      return () => window.removeEventListener("popstate", onPop);
    }
  }, [!!editor, !!historyEditor]);

  const openItem = async (s: Scope, section: CapSection, item: CapItem) => {
    setEditor({ scope: s, section, item, relpath: item.relpath, content: "", originalContent: "", loading: true, saving: false, deleting: false, newName: "" });
    try {
      const res = await readClaudeCapFile(s, item.relpath, s === "project" ? (cwd ?? undefined) : undefined);
      setEditor(e => e ? { ...e, content: res.content, originalContent: res.content, loading: false } : null);
    } catch {
      setEditor(e => e ? { ...e, loading: false } : null);
    }
  };

  const openNew = (s: Scope, section: CapSection) => {
    const blank = defaultContent(section, "new");
    setEditor({ scope: s, section, item: null, relpath: "", content: blank, originalContent: "", loading: false, saving: false, deleting: false, newName: "" });
  };

  const requestSave = () => {
    if (!editor) return;
    if (!editor.item) { doSave(); return; }
    if (editor.content === editor.originalContent) { alert("No changes to save."); return; }
    setShowDiff(true);
  };

  const doSave = async () => {
    if (!editor) return;
    setShowDiff(false);
    let relpath = editor.relpath;
    if (!editor.item) {
      const name = editor.newName.trim();
      if (!name) { alert("Enter a filename"); return; }
      const ext = fileExt(editor.section);
      const safe = name.replace(/[^a-zA-Z0-9_\-. ]/g, "_").replace(/\s+/g, "_");
      const fname = safe.endsWith(ext) ? safe : safe + ext;
      relpath = editor.section.new_dir ? `${editor.section.new_dir}/${fname}` : fname;
    }
    setEditor(e => e ? { ...e, saving: true } : null);
    try {
      await writeClaudeCapFile(editor.scope, relpath, editor.content, editor.scope === "project" ? (cwd ?? undefined) : undefined);
      setEditor(null); load(editor.scope);
    } catch (err) {
      alert(String(err));
      setEditor(e => e ? { ...e, saving: false } : null);
    }
  };

  const deleteEditor = async () => {
    if (!editor?.item) return;
    if (!confirm(`Delete ${editor.item.name}?`)) return;
    setEditor(e => e ? { ...e, deleting: true } : null);
    try {
      await deleteClaudeCapFile(editor.scope, editor.item.relpath, editor.scope === "project" ? (cwd ?? undefined) : undefined);
      setEditor(null); load(editor.scope);
    } catch (err) {
      alert(String(err));
      setEditor(e => e ? { ...e, deleting: false } : null);
    }
  };

  const onRollbackDone = (restoredContent: string) => {
    setHistoryEditor(null);
    if (editor) setEditor(e => e ? { ...e, content: restoredContent, originalContent: restoredContent } : null);
  };

  if (historyEditor) return <HistoryPanel editor={historyEditor} cwd={cwd} onBack={() => setHistoryEditor(null)} onRestored={onRollbackDone} />;
  if (showDiff && editor) return <DiffPanel original={editor.originalContent} updated={editor.content} filename={editor.item?.name ?? ""} onCancel={() => setShowDiff(false)} onConfirm={doSave} />;
  if (editor) return <EditorPanel editor={editor} onBack={() => setEditor(null)} onChange={c => setEditor(e => e ? { ...e, content: c } : null)} onChangeName={n => setEditor(e => e ? { ...e, newName: n } : null)} onSave={requestSave} onDelete={deleteEditor} onHistory={() => setHistoryEditor(editor)} />;

  const hasProject = !!cwd;
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", display: "flex", flexDirection: "column", zIndex: 200 }}>
      <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-secondary)", fontSize: 20, cursor: "pointer", padding: "0 8px 0 0", lineHeight: 1 }}>←</button>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-bright)", flex: 1 }}>Claude Capabilities</span>
      </div>
      <div style={{ display: "flex", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
        {(["global", "project"] as Scope[]).map(s => {
          const disabled = s === "project" && !hasProject;
          return (
            <button key={s} onClick={() => !disabled && setScope(s)} disabled={disabled}
              style={{ flex: 1, height: 38, background: "none", border: "none", borderBottom: scope === s ? "2px solid var(--accent-blue)" : "2px solid transparent", color: disabled ? "var(--border)" : scope === s ? "var(--accent-blue)" : "var(--text-secondary)", fontSize: 13, fontWeight: scope === s ? 600 : 400, cursor: disabled ? "not-allowed" : "pointer" }}>
              {s === "global" ? "Global (~/.claude)" : "Project (.claude/)"}
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading && <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>}
        {error && <div style={{ padding: 16, color: "var(--accent-red)", fontSize: 13 }}>{error}</div>}
        {!loading && !error && data && data.sections.map(section => (
          <SectionBlock key={section.id} section={section} scope={scope}
            onOpenItem={item => openItem(scope, section, item)}
            onNew={section.new_template ? () => openNew(scope, section) : null} />
        ))}
      </div>
    </div>
  );
}

// ── SectionBlock ──────────────────────────────────────────────────────────────

function SectionBlock({ section, scope, onOpenItem, onNew }: {
  section: CapSection; scope: Scope;
  onOpenItem: (item: CapItem) => void; onNew: (() => void) | null;
}) {
  return (
    <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "8px 14px 4px", gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 1, flex: 1 }}>{section.title}</span>
        {onNew && <button onClick={onNew} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--accent-blue)", fontSize: 12, padding: "2px 8px", cursor: "pointer" }}>+ New</button>}
      </div>
      {section.items.length === 0
        ? <div style={{ padding: "6px 14px 10px", color: "var(--text-faint)", fontSize: 12, fontStyle: "italic" }}>empty</div>
        : section.items.map(item => <ItemRow key={item.relpath} item={item} onOpen={() => onOpenItem(item)} />)}
    </div>
  );
}

function ItemRow({ item, onOpen }: { item: CapItem; onOpen: () => void }) {
  const isJson = item.relpath.endsWith(".json");
  const isMd = item.relpath.endsWith(".md");
  const typeTag = isJson ? "JSON" : isMd ? "MD" : null;
  return (
    <button onClick={onOpen}
      style={{ display: "flex", alignItems: "center", width: "100%", padding: "8px 14px", background: "none", border: "none", borderTop: "1px solid var(--bg-surface)", cursor: "pointer", textAlign: "left", gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13, color: item.exists ? "var(--text-bright)" : "var(--text-faint)", fontWeight: item.exists ? 500 : 400 }}>{item.name}</span>
          {typeTag && <span style={{ fontSize: 9, color: "var(--text-faint)", background: "var(--bg-surface)", borderRadius: 3, padding: "1px 4px", fontFamily: "monospace" }}>{typeTag}</span>}
          {!item.exists && <span style={{ fontSize: 10, color: "var(--border)", background: "var(--bg-hover)", borderRadius: 3, padding: "1px 5px" }}>not set</span>}
          {item.exists && item.size > 0 && <span style={{ fontSize: 10, color: "var(--text-faint)" }}>{fmtSize(item.size)}</span>}
        </div>
        {item.description && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.description}</div>}
      </div>
      <span style={{ color: "var(--border)", fontSize: 14, flexShrink: 0 }}>›</span>
    </button>
  );
}

// ── EditorPanel ───────────────────────────────────────────────────────────────

type ViewMode = "preview" | "tree" | "edit";

function defaultViewMode(editor: EditorState): ViewMode {
  if (!editor.item) return "edit";
  if (editor.relpath.endsWith(".md")) return "preview";
  if (editor.relpath.endsWith(".json")) return "tree";
  return "edit";
}

function EditorPanel({ editor, onBack, onChange, onChangeName, onSave, onDelete, onHistory }: {
  editor: EditorState; onBack: () => void;
  onChange: (c: string) => void; onChangeName: (n: string) => void;
  onSave: () => void; onDelete: () => void; onHistory: () => void;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => defaultViewMode(editor));
  const taRef = useRef<HTMLTextAreaElement>(null);
  const isNew = !editor.item;
  const isMd = editor.relpath.endsWith(".md") || (isNew && editor.section.new_template === "md");
  const isJson = editor.relpath.endsWith(".json") || (isNew && editor.section.new_template === "json");

  // When editor content loads, keep viewMode appropriate
  useEffect(() => {
    if (!editor.loading && isNew) setViewMode("edit");
  }, [editor.loading]);

  useEffect(() => {
    if (viewMode === "edit" && !editor.loading && taRef.current) taRef.current.focus();
  }, [viewMode, editor.loading]);

  const toggleLabel = viewMode === "edit"
    ? (isMd ? "Preview" : isJson ? "Tree" : null)
    : "Edit";

  const toggleMode = () => {
    if (viewMode === "edit") setViewMode(isMd ? "preview" : "tree");
    else setViewMode("edit");
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", display: "flex", flexDirection: "column", zIndex: 210 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", padding: "10px 10px", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0, gap: 6 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "var(--text-secondary)", fontSize: 20, cursor: "pointer", padding: "0 6px 0 0", lineHeight: 1, flexShrink: 0 }}>←</button>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {isNew ? `New — ${editor.section.title}` : editor.item!.name}
        </span>
        {toggleLabel && (
          <button onClick={toggleMode}
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: 4, color: viewMode === "edit" ? "var(--accent-blue)" : "var(--text-secondary)", fontSize: 12, padding: "4px 10px", cursor: "pointer", flexShrink: 0 }}>
            {toggleLabel}
          </button>
        )}
        {editor.item && (
          <button onClick={onHistory}
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-secondary)", fontSize: 12, padding: "4px 10px", cursor: "pointer", flexShrink: 0 }}>
            History
          </button>
        )}
        {editor.item && (
          <button onClick={onDelete} disabled={editor.deleting || editor.saving}
            style={{ background: "none", border: "1px solid var(--accent-red)", borderRadius: 4, color: "var(--accent-red)", fontSize: 12, padding: "4px 10px", cursor: "pointer", flexShrink: 0 }}>
            {editor.deleting ? "…" : "Del"}
          </button>
        )}
        {viewMode === "edit" && (
          <button onClick={onSave} disabled={editor.saving || editor.deleting || editor.loading}
            style={{ background: "var(--accent-blue)", border: "none", borderRadius: 4, color: "#fff", fontSize: 13, padding: "4px 14px", cursor: "pointer", flexShrink: 0 }}>
            {editor.saving ? "…" : "Save"}
          </button>
        )}
      </div>

      {/* Path / filename input */}
      <div style={{ padding: "4px 14px", borderBottom: "1px solid var(--bg-surface)", flexShrink: 0 }}>
        {isNew ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{editor.section.new_dir ? `${editor.section.new_dir}/` : ""}</span>
            <input value={editor.newName} onChange={e => onChangeName(e.target.value)} placeholder="filename"
              style={{ fontSize: 12, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-bright)", padding: "3px 8px", flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{fileExt(editor.section)}</span>
          </div>
        ) : (
          <span style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "monospace" }}>{editor.item!.relpath}</span>
        )}
      </div>

      {/* Body */}
      {editor.loading
        ? <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
        : viewMode === "preview"
          ? <MarkdownPreview content={editor.content} />
          : viewMode === "tree"
            ? <JsonTreeView content={editor.content} />
            : <textarea ref={taRef} value={editor.content} onChange={e => onChange(e.target.value)} spellCheck={false}
                style={{ flex: 1, width: "100%", boxSizing: "border-box", background: "var(--bg-base)", color: "var(--text-bright)", border: "none", outline: "none", fontFamily: "'Ubuntu Sans Mono', 'Ubuntu Mono', monospace", fontSize: 13, lineHeight: 1.6, padding: "12px 14px", resize: "none", whiteSpace: "pre" }} />
      }
    </div>
  );
}

// ── MarkdownPreview ───────────────────────────────────────────────────────────

function MarkdownPreview({ content }: { content: string }) {
  const html = renderMarkdown(content || "*Empty file*");
  return (
    <div
      dangerouslySetInnerHTML={{ __html: html }}
      style={{
        flex: 1, overflowY: "auto", padding: "14px 16px",
        color: "var(--text-bright)", fontSize: 14, lineHeight: 1.75,
        // basic typography
      }}
      className="caps-md-preview"
    />
  );
}

// ── JsonTreeView ──────────────────────────────────────────────────────────────

function JsonTreeView({ content }: { content: string }) {
  let parsed: unknown;
  let parseErr = "";
  try { parsed = JSON.parse(content || "null"); }
  catch (e) { parseErr = String(e); }

  if (parseErr) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
        <div style={{ color: "var(--accent-red)", fontSize: 12, marginBottom: 8 }}>Invalid JSON: {parseErr}</div>
        <pre style={{ margin: 0, fontSize: 12, color: "var(--text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{content}</pre>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px", fontFamily: "'Ubuntu Sans Mono', monospace", fontSize: 12 }}>
      <JsonNode value={parsed} depth={0} />
    </div>
  );
}

function JsonNode({ value, depth }: { value: unknown; depth: number }) {
  if (value === null) return <span style={{ color: "var(--text-muted)" }}>null</span>;
  if (value === undefined) return <span style={{ color: "var(--text-muted)" }}>undefined</span>;
  if (typeof value === "boolean") return <span style={{ color: "var(--accent-blue)" }}>{value ? "true" : "false"}</span>;
  if (typeof value === "number") return <span style={{ color: "var(--accent-blue)" }}>{value}</span>;
  if (typeof value === "string") return <span style={{ color: "var(--accent-blue)" }}>"{value}"</span>;
  if (Array.isArray(value)) return <JsonArray arr={value} depth={depth} />;
  if (typeof value === "object") return <JsonObject obj={value as Record<string, unknown>} depth={depth} />;
  return <span style={{ color: "var(--text-primary)" }}>{String(value)}</span>;
}

function JsonObject({ obj, depth }: { obj: Record<string, unknown>; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const entries = Object.entries(obj);
  if (entries.length === 0) return <span style={{ color: "var(--text-muted)" }}>{"{}"}</span>;
  return (
    <span>
      <button onClick={() => setOpen(o => !o)}
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 11, padding: "0 2px", lineHeight: 1 }}>
        {open ? "▾" : "▸"}
      </button>
      {!open
        ? <span style={{ color: "var(--text-muted)" }}>{`{ ${entries.length} key${entries.length > 1 ? "s" : ""} }`}</span>
        : (
          <div style={{ paddingLeft: 16, borderLeft: "1px solid var(--border-subtle)", marginLeft: 2 }}>
            {entries.map(([k, v]) => (
              <div key={k} style={{ padding: "2px 0" }}>
                <span style={{ color: "var(--accent-amber)" }}>"{k}"</span>
                <span style={{ color: "var(--text-muted)" }}>: </span>
                <JsonNode value={v} depth={depth + 1} />
              </div>
            ))}
          </div>
        )
      }
    </span>
  );
}

function JsonArray({ arr, depth }: { arr: unknown[]; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (arr.length === 0) return <span style={{ color: "var(--text-muted)" }}>[]</span>;
  return (
    <span>
      <button onClick={() => setOpen(o => !o)}
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 11, padding: "0 2px", lineHeight: 1 }}>
        {open ? "▾" : "▸"}
      </button>
      {!open
        ? <span style={{ color: "var(--text-muted)" }}>{`[ ${arr.length} item${arr.length > 1 ? "s" : ""} ]`}</span>
        : (
          <div style={{ paddingLeft: 16, borderLeft: "1px solid var(--border-subtle)", marginLeft: 2 }}>
            {arr.map((v, i) => (
              <div key={i} style={{ padding: "2px 0" }}>
                <span style={{ color: "var(--text-muted)" }}>{i}: </span>
                <JsonNode value={v} depth={depth + 1} />
              </div>
            ))}
          </div>
        )
      }
    </span>
  );
}

// ── HistoryPanel ──────────────────────────────────────────────────────────────

function HistoryPanel({ editor, cwd, onBack, onRestored }: {
  editor: EditorState; cwd: string | null;
  onBack: () => void; onRestored: (content: string) => void;
}) {
  const [versions, setVersions] = useState<CapVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await listCapVersions(editor.scope, editor.relpath, editor.scope === "project" ? (cwd ?? undefined) : undefined);
        setVersions(res.versions);
      } catch { setVersions([]); }
      finally { setLoading(false); }
    })();
  }, [editor.scope, editor.relpath, cwd]);

  const doRollback = async (v: CapVersion) => {
    if (!confirm(`Restore version from ${relTime(v.saved_at)}?\n\nCurrent content will be saved as a new version.`)) return;
    setRollingBack(v.version_id);
    try {
      await rollbackCapVersion(editor.scope, editor.relpath, v.version_id, editor.scope === "project" ? (cwd ?? undefined) : undefined);
      const res = await readClaudeCapFile(editor.scope, editor.relpath, editor.scope === "project" ? (cwd ?? undefined) : undefined);
      onRestored(res.content);
    } catch (err) { alert(String(err)); setRollingBack(null); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", display: "flex", flexDirection: "column", zIndex: 220 }}>
      <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0, gap: 8 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "var(--text-secondary)", fontSize: 20, cursor: "pointer", padding: "0 6px 0 0", lineHeight: 1, flexShrink: 0 }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)" }}>Version History</div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{editor.relpath}</div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading && <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>}
        {!loading && versions.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "var(--text-faint)", fontSize: 13 }}>No saved versions yet</div>}
        {!loading && versions.map((v, i) => (
          <div key={v.version_id} style={{ borderBottom: "1px solid var(--bg-surface)", padding: "10px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, color: "var(--text-bright)", fontWeight: 500 }}>{relTime(v.saved_at)}</span>
                  {i === 0 && <span style={{ fontSize: 10, background: "color-mix(in srgb, var(--accent-blue) 20%, var(--bg-base))", color: "var(--accent-blue)", borderRadius: 3, padding: "1px 5px" }}>latest</span>}
                  <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{fmtSize(v.size)}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "monospace" }}>{v.preview || "(empty)"}</div>
              </div>
              <button onClick={() => setPreviewId(previewId === v.version_id ? null : v.version_id)}
                style={{ background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-secondary)", fontSize: 11, padding: "3px 8px", cursor: "pointer", flexShrink: 0 }}>
                {previewId === v.version_id ? "Hide" : "View"}
              </button>
              <button onClick={() => doRollback(v)} disabled={rollingBack !== null}
                style={{ background: rollingBack === v.version_id ? "var(--bg-deep)" : "var(--bg-deep)", border: "1px solid #1f6feb", borderRadius: 4, color: "var(--accent-blue)", fontSize: 12, padding: "4px 12px", cursor: "pointer", flexShrink: 0 }}>
                {rollingBack === v.version_id ? "…" : "Restore"}
              </button>
            </div>
            {previewId === v.version_id && (
              <VersionPreview scope={editor.scope} relpath={editor.relpath} versionId={v.version_id} cwd={cwd} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── DiffPanel ─────────────────────────────────────────────────────────────────

function computeDiff(original: string, updated: string): Array<{ type: "same" | "add" | "remove"; text: string }> {
  const A = original.split("\n"), B = updated.split("\n");
  const m = A.length, n = B.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? 1 + dp[i+1][j+1] : Math.max(dp[i+1][j], dp[i][j+1]);
  const out: Array<{ type: "same" | "add" | "remove"; text: string }> = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && A[i] === B[j]) { out.push({ type: "same", text: A[i] }); i++; j++; }
    else if (j < n && (i >= m || dp[i+1][j] <= dp[i][j+1])) { out.push({ type: "add", text: B[j] }); j++; }
    else { out.push({ type: "remove", text: A[i] }); i++; }
  }
  return out;
}

function DiffPanel({ original, updated, filename, onCancel, onConfirm }: {
  original: string; updated: string; filename: string; onCancel: () => void; onConfirm: () => void;
}) {
  const diff = computeDiff(original, updated);
  const adds = diff.filter(d => d.type === "add").length;
  const rems = diff.filter(d => d.type === "remove").length;
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", display: "flex", flexDirection: "column", zIndex: 215 }}>
      <div style={{ display: "flex", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0, gap: 8 }}>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: "var(--text-secondary)", fontSize: 20, cursor: "pointer", padding: "0 6px 0 0", lineHeight: 1, flexShrink: 0 }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)" }}>Review Changes</div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "monospace" }}>{filename}</div>
        </div>
        <button onClick={onConfirm} style={{ background: "var(--accent-blue)", border: "none", borderRadius: 4, color: "#fff", fontSize: 13, padding: "5px 16px", cursor: "pointer", flexShrink: 0 }}>Save</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", fontFamily: "'Ubuntu Sans Mono', monospace", fontSize: 12 }}>
        {diff.map((line, idx) => {
          if (line.type === "same") return null;
          const bg = line.type === "add" ? "var(--diff-add-bg)" : "var(--diff-del-bg)";
          const color = line.type === "add" ? "var(--diff-add-text)" : "var(--diff-del-text)";
          return (
            <div key={idx} style={{ background: bg, borderLeft: `3px solid ${color}`, padding: "2px 10px 2px 8px", display: "flex", gap: 6 }}>
              <span style={{ color, flexShrink: 0, userSelect: "none" }}>{line.type === "add" ? "+" : "−"}</span>
              <span style={{ color: "var(--text-body)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{line.text || " "}</span>
            </div>
          );
        })}
      </div>
      <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-faint)", flexShrink: 0 }}>
        +{adds} added · −{rems} removed lines
      </div>
    </div>
  );
}

// ── VersionPreview ─────────────────────────────────────────────────────────────

function VersionPreview({ scope, relpath, versionId, cwd }: {
  scope: Scope; relpath: string; versionId: string; cwd: string | null;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await readCapVersionContent(scope, relpath, versionId, scope === "project" ? (cwd ?? undefined) : undefined);
        setContent(res.content);
      } catch (e) { setContent(String(e)); }
      finally { setLoading(false); }
    })();
  }, [scope, relpath, versionId, cwd]);
  return (
    <div style={{ marginTop: 8, background: "var(--bg-surface)", borderRadius: 6, padding: "8px 10px", overflow: "auto", maxHeight: 300 }}>
      {loading
        ? <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Loading…</span>
        : <pre style={{ margin: 0, fontSize: 11, color: "var(--text-primary)", fontFamily: "'Ubuntu Sans Mono', monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{content ?? ""}</pre>}
    </div>
  );
}
