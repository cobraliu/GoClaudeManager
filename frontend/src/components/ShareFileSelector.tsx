import { useState, useEffect, useRef, useCallback } from "react";
import { getDirInfo, type DirInfoItem, type FileAccessSpec } from "../api/sessionApi";

// Hidden dotfiles and these dirs are never offered: the public viewer skips
// them too, so keeping the picker in sync means "what you select is what
// readers see". Mirrors SKIP_DIRS in app/api/files.py.
const SKIP_DIRS = new Set([
  ".git", "__pycache__", "node_modules", ".venv", "venv",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", "dist", ".next",
]);

function offerable(item: DirInfoItem): boolean {
  if (item.name.startsWith(".")) return false;
  if (item.type === "dir" && SKIP_DIRS.has(item.name)) return false;
  return true;
}

// ── inclusion-set helpers ─────────────────────────────────────────────────────

function hasFullAncestor(relPath: string, full: Set<string>): boolean {
  const parts = relPath.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (full.has(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

function hasSelectedDescendant(relPath: string, full: Set<string>, files: Set<string>): boolean {
  const prefix = relPath + "/";
  for (const p of full) if (p.startsWith(prefix)) return true;
  for (const p of files) if (p.startsWith(prefix)) return true;
  return false;
}

function dropDescendants(set: Set<string>, relPath: string): void {
  const prefix = relPath + "/";
  for (const p of [...set]) if (p.startsWith(prefix)) set.delete(p);
}

/** Tri-state toggle: dir cycles unchecked → full → unchecked (partial → full);
 *  file toggles on/off. Returns the next {full, files} sets. */
function computeNextInclusion(
  full: Set<string>,
  files: Set<string>,
  relPath: string,
  isDir: boolean,
): { full: Set<string>; files: Set<string> } {
  const nf = new Set(full);
  const nfi = new Set(files);
  if (isDir) {
    if (nf.has(relPath)) {
      nf.delete(relPath);
      dropDescendants(nf, relPath);
      dropDescendants(nfi, relPath);
    } else if (hasSelectedDescendant(relPath, nf, nfi)) {
      // partial → promote to full, clearing now-redundant descendant entries
      dropDescendants(nf, relPath);
      dropDescendants(nfi, relPath);
      nf.add(relPath);
    } else {
      nf.add(relPath);
    }
  } else {
    if (nfi.has(relPath)) nfi.delete(relPath);
    else nfi.add(relPath);
  }
  return { full: nf, files: nfi };
}

// ── tri-state checkbox ─────────────────────────────────────────────────────────

function TriCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      style={{ flexShrink: 0, cursor: disabled ? "not-allowed" : "pointer" }}
    />
  );
}

// ── tree node ──────────────────────────────────────────────────────────────────

function InclNode({
  item,
  sessionId,
  full,
  files,
  onToggle,
  depth,
  compact,
}: {
  item: DirInfoItem;
  sessionId: string;
  full: Set<string>;
  files: Set<string>;
  onToggle: (relPath: string, isDir: boolean) => void;
  depth: number;
  compact: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirInfoItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  const relPath = item.path; // dir-info paths are already relative to cwd
  const isDir = item.type === "dir";
  const underFull = hasFullAncestor(relPath, full);
  const isFull = full.has(relPath) || underFull;
  const isPartial = !isFull && isDir && hasSelectedDescendant(relPath, full, files);
  const isChecked = isDir ? isFull : underFull || files.has(relPath);
  const locked = underFull; // implicitly included by an ancestor full grant

  const handleExpand = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isDir) return;
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      setLoading(true);
      try {
        const res = await getDirInfo(sessionId, item.path, false);
        setChildren(res.items.filter(offerable));
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  }, [expanded, children, isDir, sessionId, item.path]);

  const indent = 8 + depth * (compact ? 14 : 16);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: `4px 10px 4px ${indent}px`,
          borderBottom: "1px solid var(--bg-deep)",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}
      >
        {isDir ? (
          <span
            onClick={handleExpand}
            style={{ fontSize: 9, width: 12, color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, userSelect: "none" }}
          >
            {loading ? "…" : expanded ? "▼" : "▶"}
          </span>
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}

        <TriCheckbox
          checked={isChecked}
          indeterminate={isPartial}
          disabled={locked}
          onChange={() => { if (!locked) onToggle(relPath, isDir); }}
        />

        <span style={{ fontSize: 13, flexShrink: 0 }}>{isDir ? "📁" : "📄"}</span>
        <span
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            color: isChecked ? "var(--text-primary)" : "var(--text-secondary)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.name}
        </span>
      </div>

      {expanded && children && children.length > 0 && (
        <div>
          {children.map((child) => (
            <InclNode
              key={child.path}
              item={child}
              sessionId={sessionId}
              full={full}
              files={files}
              onToggle={onToggle}
              depth={depth + 1}
              compact={compact}
            />
          ))}
        </div>
      )}
      {expanded && children && children.length === 0 && (
        <div style={{ padding: `3px 10px 3px ${indent + 28}px`, fontSize: 11, color: "var(--text-faintest)" }}>
          (空)
        </div>
      )}
    </div>
  );
}

// ── main selector ──────────────────────────────────────────────────────────────

export function ShareFileSelector({
  sessionId,
  value,
  onChange,
  compact = false,
}: {
  sessionId: string;
  value: FileAccessSpec;
  onChange: (v: FileAccessSpec) => void;
  compact?: boolean;
}) {
  const [roots, setRoots] = useState<DirInfoItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const full = new Set(value.full);
  const files = new Set(value.files);
  const count = full.size + files.size;

  useEffect(() => {
    getDirInfo(sessionId, "", false)
      .then((r) => setRoots(r.items.filter(offerable)))
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
  }, [sessionId]);

  const handleToggle = useCallback((relPath: string, isDir: boolean) => {
    const next = computeNextInclusion(new Set(value.full), new Set(value.files), relPath, isDir);
    onChange({ full: [...next.full], files: [...next.files] });
  }, [value.full, value.files, onChange]);

  return (
    <div>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 6,
          maxHeight: compact ? 240 : 300,
          overflowY: "auto",
          background: "var(--bg-base)",
        }}
      >
        {err ? (
          <div style={{ padding: 10, fontSize: 12, color: "var(--accent-red, #e05260)" }}>{err}</div>
        ) : roots === null ? (
          <div style={{ padding: 10, fontSize: 12, color: "var(--text-faint)" }}>加载文件树…</div>
        ) : roots.length === 0 ? (
          <div style={{ padding: 10, fontSize: 12, color: "var(--text-faint)" }}>无可选文件</div>
        ) : (
          roots.map((item) => (
            <InclNode
              key={item.path}
              item={item}
              sessionId={sessionId}
              full={full}
              files={files}
              onToggle={handleToggle}
              depth={0}
              compact={compact}
            />
          ))
        )}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 10, alignItems: "center" }}>
        <span>已选 {count} 项（点击目录可整体勾选，再点取消）</span>
        {count > 0 && (
          <button
            onClick={() => onChange({ full: [], files: [] })}
            style={{ fontSize: 11, padding: "2px 8px", cursor: "pointer", background: "var(--btn-icon-bg)", color: "var(--text-secondary)", border: "1px solid var(--border)", borderRadius: 4 }}
          >
            清空
          </button>
        )}
      </div>
    </div>
  );
}
