import { useState, useEffect, useRef, useCallback } from "react";
import {
  getDirInfo,
  downloadDirZip,
  type DirInfoItem,
  type DirInfoResponse,
} from "../api/sessionApi";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Strip the basePath prefix to get path relative to download root. */
function relToBase(itemPath: string, basePath: string): string {
  if (!basePath) return itemPath;
  return itemPath.startsWith(basePath + "/")
    ? itemPath.slice(basePath.length + 1)
    : itemPath;
}

/** True if any ancestor of relPath is in the excluded set. */
function hasExcludedAncestor(relPath: string, excluded: Set<string>): boolean {
  const parts = relPath.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (excluded.has(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

/** True if any descendant of relPath is in the excluded set. */
function hasExcludedDescendant(relPath: string, excluded: Set<string>): boolean {
  const prefix = relPath + "/";
  for (const p of excluded) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

function formatMB(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Toggle logic for a tree node. */
function computeNextExcluded(
  prev: Set<string>,
  relPath: string,
  isDir: boolean
): Set<string> {
  const next = new Set(prev);
  if (next.has(relPath)) {
    // Excluded → include
    next.delete(relPath);
  } else if (isDir && hasExcludedDescendant(relPath, prev)) {
    // Partially excluded → clear all descendants (make fully included)
    for (const p of [...next]) {
      if (p.startsWith(relPath + "/")) next.delete(p);
    }
  } else {
    // Included → exclude
    next.add(relPath);
    // Remove now-redundant descendant exclusions
    for (const p of [...next]) {
      if (p !== relPath && p.startsWith(relPath + "/")) next.delete(p);
    }
  }
  return next;
}

// ── Tri-state checkbox ────────────────────────────────────────────────────────

function TriCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
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
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      style={{ flexShrink: 0, cursor: "pointer" }}
    />
  );
}

// ── Tree node ─────────────────────────────────────────────────────────────────

function TreeNode({
  item,
  relPath,
  sessionId,
  excluded,
  onToggle,
  onSizesLoaded,
  depth,
}: {
  item: DirInfoItem;
  relPath: string;
  sessionId: string;
  excluded: Set<string>;
  onToggle: (relPath: string, isDir: boolean) => void;
  onSizesLoaded: (entries: Array<{ relPath: string; size: number }>) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirInfoItem[] | null>(null);
  const [loadingChildren, setLoadingChildren] = useState(false);

  const isExcluded = excluded.has(relPath);
  const isAncestorExcluded = hasExcludedAncestor(relPath, excluded);
  const isDir = item.type === "dir";
  const isPartial = !isExcluded && isDir && hasExcludedDescendant(relPath, excluded);
  const isChecked = !isExcluded;
  // Dim if an ancestor is excluded (this item is implicitly excluded)
  const dimmed = isAncestorExcluded && !isExcluded;

  const handleExpand = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isDir) return;
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      setLoadingChildren(true);
      try {
        const res = await getDirInfo(sessionId, item.path);
        setChildren(res.items);
        onSizesLoaded(
          res.items.map((c) => ({
            relPath: relPath + "/" + c.name,
            size: c.size,
          }))
        );
      } catch {
        setChildren([]);
      } finally {
        setLoadingChildren(false);
      }
    }
  }, [expanded, children, isDir, sessionId, item.path, relPath, onSizesLoaded]);

  const indent = 8 + depth * 16;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: `4px 10px 4px ${indent}px`,
          borderBottom: "1px solid var(--bg-deep)",
          opacity: dimmed ? 0.4 : 1,
        }}
        onMouseEnter={(e) => { if (!dimmed) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}
      >
        {/* Expand arrow */}
        {isDir ? (
          <span
            onClick={isExcluded ? undefined : handleExpand}
            style={{
              fontSize: 9,
              width: 12,
              color: "var(--text-muted)",
              cursor: isExcluded ? "default" : "pointer",
              flexShrink: 0,
              userSelect: "none",
            }}
          >
            {loadingChildren ? "…" : expanded ? "▼" : "▶"}
          </span>
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}

        <TriCheckbox
          checked={isChecked}
          indeterminate={isPartial}
          onChange={() => onToggle(relPath, isDir)}
        />

        <span style={{ fontSize: 13, flexShrink: 0 }}>
          {isDir ? "📁" : "📄"}
        </span>
        <span
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            color: isExcluded ? "var(--text-faint)" : "var(--text-primary)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textDecoration: isExcluded ? "line-through" : "none",
          }}
        >
          {item.name}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0 }}>
          {formatMB(item.size)}
        </span>
      </div>

      {/* Children */}
      {expanded && !isExcluded && children && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              item={child}
              relPath={relPath + "/" + child.name}
              sessionId={sessionId}
              excluded={excluded}
              onToggle={onToggle}
              onSizesLoaded={onSizesLoaded}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
      {expanded && !isExcluded && children && children.length === 0 && (
        <div style={{ padding: `3px 10px 3px ${indent + 28}px`, fontSize: 11, color: "var(--text-faintest)" }}>
          (empty)
        </div>
      )}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

const DOWNLOAD_MAX_MB = 100;

interface Props {
  sessionId: string;
  /** Path being downloaded, relative to cwd. "" = cwd root. */
  basePath: string;
  info: DirInfoResponse;
  onClose: () => void;
}

export function DownloadExclusionModal({
  sessionId,
  basePath,
  info,
  onClose,
}: Props) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  // Map from relPath → size (populated as tree nodes load their children)
  const sizeMapRef = useRef<Map<string, number>>(new Map());
  const [, forceUpdate] = useState(0);
  const [downloading, setDownloading] = useState(false);

  // Seed sizeMap with top-level items on mount
  useEffect(() => {
    info.items.forEach((item) => {
      sizeMapRef.current.set(relToBase(item.path, basePath), item.size);
    });
  }, []); // eslint-disable-line

  const handleSizesLoaded = useCallback(
    (entries: Array<{ relPath: string; size: number }>) => {
      entries.forEach(({ relPath, size }) => {
        sizeMapRef.current.set(relPath, size);
      });
      forceUpdate((n) => n + 1);
    },
    []
  );

  const handleToggle = useCallback((relPath: string, isDir: boolean) => {
    setExcluded((prev) => computeNextExcluded(prev, relPath, isDir));
  }, []);

  // Compute estimated remaining size
  const computeRemaining = (): number => {
    let excludedSize = 0;
    for (const relPath of excluded) {
      if (!hasExcludedAncestor(relPath, excluded)) {
        excludedSize += sizeMapRef.current.get(relPath) ?? 0;
      }
    }
    return Math.max(0, info.total_size - excludedSize);
  };

  const remaining = computeRemaining();
  const tooLarge = remaining > DOWNLOAD_MAX_MB * 1024 * 1024;

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await downloadDirZip(sessionId, basePath, [...excluded]);
      onClose();
    } catch (e) {
      alert(String(e));
    } finally {
      setDownloading(false);
    }
  };

  const label = basePath || "/ (cwd)";

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 3000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.65)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-strong)",
          borderRadius: 8,
          padding: 20,
          width: "min(480px, 92vw)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {/* Title */}
        <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>
          Download{" "}
          <span style={{ fontFamily: "monospace", color: "#f59e0b" }}>
            {label}
          </span>
        </div>

        <div style={{ fontSize: 11, color: "#f59e0b" }}>
          Directory is too large ({formatMB(info.total_size)} &gt; {DOWNLOAD_MAX_MB}MB).
          Uncheck items to exclude — click ▶ to drill into subdirectories.
        </div>

        {/* Tree */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            border: "1px solid var(--bg-hover)",
            borderRadius: 4,
            maxHeight: 380,
            background: "var(--bg-base)",
          }}
        >
          {info.items.map((item) => {
            const rp = relToBase(item.path, basePath);
            return (
              <TreeNode
                key={item.path}
                item={item}
                relPath={rp}
                sessionId={sessionId}
                excluded={excluded}
                onToggle={handleToggle}
                onSizesLoaded={handleSizesLoaded}
                depth={0}
              />
            );
          })}
        </div>

        {/* Size estimate */}
        <div style={{ fontSize: 11, color: tooLarge ? "var(--accent-red)" : "var(--text-muted)" }}>
          Estimated size after exclusions:{" "}
          <strong style={{ color: tooLarge ? "var(--accent-red)" : "var(--text-primary)" }}>
            {formatMB(remaining)}
          </strong>
          {tooLarge && " — still exceeds 100MB, exclude more items"}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              background: "var(--btn-icon-bg)",
              color: "var(--text-secondary)",
              fontSize: 11,
              padding: "4px 12px",
            }}
          >
            Cancel
          </button>
          <button
            disabled={downloading || tooLarge}
            onClick={handleDownload}
            style={{
              background: tooLarge ? "var(--btn-icon-bg)" : "var(--accent-blue)",
              color: tooLarge ? "var(--text-faint)" : "#fff",
              fontSize: 11,
              padding: "4px 14px",
            }}
          >
            {downloading ? "Downloading…" : "Download"}
          </button>
        </div>
      </div>
    </div>
  );
}
