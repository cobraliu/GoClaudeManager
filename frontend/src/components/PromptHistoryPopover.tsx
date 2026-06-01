import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getPromptHistory,
  type PromptHistoryEntry,
} from "../api/sessionApi";

interface Props {
  sessionId: string;
  onPick: (text: string) => void;
  onClose: () => void;
  // Anchor: client-rect of the button that opened the popover. The panel
  // is positioned with its bottom edge just above the anchor (so the list
  // grows upward, since the input bar lives at the viewport bottom).
  anchorRect: DOMRect | null;
  // When provided, the panel fills this element's bounding box (less a
  // small inset above the anchor button) — used for "full chat area"
  // mode so the user can browse a long history without a cramped popover.
  containerRect?: DOMRect | null;
  // On small screens we ignore anchorRect and render as a bottom sheet.
  mobile?: boolean;
}

const PAGE_SIZE = 20;

function relTime(ts: number): string {
  const diff = (Date.now() / 1000) - ts;
  if (diff < 5) return "just now";
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function absTime(ts: number): string {
  if (!ts || ts <= 0) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}:${ss}`;
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  if (d.getFullYear() === now.getFullYear()) return `${mo}-${dd} ${hh}:${mm}`;
  return `${d.getFullYear()}-${mo}-${dd} ${hh}:${mm}`;
}

export function PromptHistoryPopover({
  sessionId,
  onPick,
  onClose,
  anchorRect,
  containerRect,
  mobile = false,
}: Props) {
  const [entries, setEntries] = useState<PromptHistoryEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [pageIndex, setPageIndex] = useState<number>(0); // 0-based
  const [loading, setLoading] = useState(false);

  // Search: rawQuery is the live input value; query is the debounced
  // version that actually drives the request.
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");

  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounce search input → query (and reset to page 0 on change).
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setQuery(rawQuery.trim());
      setPageIndex(0);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [rawQuery]);

  const totalPages = useMemo(() => {
    if (total <= 0) return 0;
    return Math.ceil(total / PAGE_SIZE);
  }, [total]);

  const loadPage = useCallback(
    async (page: number, q: string) => {
      setLoading(true);
      try {
        const res = await getPromptHistory(sessionId, {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          query: q || undefined,
        });
        setEntries(res.entries);
        setTotal(res.total);
        setErr(null);
        requestAnimationFrame(() => {
          if (listRef.current) listRef.current.scrollTop = 0;
        });
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    loadPage(pageIndex, query);
  }, [loadPage, pageIndex, query]);

  const goFirst = useCallback(() => {
    if (loading || pageIndex === 0) return;
    setPageIndex(0);
  }, [loading, pageIndex]);

  const goPrev = useCallback(() => {
    if (loading || pageIndex <= 0) return;
    setPageIndex((p) => p - 1);
  }, [loading, pageIndex]);

  const goNext = useCallback(() => {
    if (loading) return;
    if (pageIndex + 1 >= totalPages) return;
    setPageIndex((p) => p + 1);
  }, [loading, pageIndex, totalPages]);

  const goLast = useCallback(() => {
    if (loading || totalPages === 0) return;
    if (pageIndex >= totalPages - 1) return;
    setPageIndex(totalPages - 1);
  }, [loading, pageIndex, totalPages]);

  // Dismiss on outside click + Escape.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const handlePick = useCallback(
    (text: string) => {
      onPick(text);
      onClose();
    },
    [onPick, onClose],
  );

  // Positioning. Mobile fills the entire chat container; PC takes the
  // upper half above the input bar. Without a container, fall back to a
  // floating panel (PC) or a viewport bottom-sheet (mobile).
  let panelStyle: React.CSSProperties;
  if (mobile && containerRect) {
    // Fill the chat container from its top edge down to just above the
    // input bar — anchor the panel's bottom on the history button so the
    // textarea stays visible and tappable.
    panelStyle = {
      position: "fixed",
      left: containerRect.left,
      top: containerRect.top,
      width: containerRect.width,
      bottom: anchorRect
        ? Math.max(8, window.innerHeight - anchorRect.top + 6)
        : Math.max(8, window.innerHeight - containerRect.bottom),
    };
  } else if (containerRect) {
    const halfHeight = Math.max(220, Math.round(containerRect.height / 2));
    const bottomOffset = anchorRect
      ? Math.max(8, window.innerHeight - anchorRect.top + 8)
      : Math.max(8, window.innerHeight - containerRect.bottom + 80);
    panelStyle = {
      position: "fixed",
      left: containerRect.left + 4,
      width: containerRect.width - 8,
      bottom: bottomOffset,
      height: halfHeight,
    };
  } else if (mobile) {
    panelStyle = {
      position: "fixed",
      left: 8,
      right: 8,
      bottom: anchorRect ? Math.max(8, window.innerHeight - anchorRect.top + 6) : 80,
      maxHeight: "70vh",
      height: "70vh",
    };
  } else {
    panelStyle = {
      position: "fixed",
      left: anchorRect ? Math.max(8, Math.min(anchorRect.left - 120, window.innerWidth - 580)) : 80,
      bottom: anchorRect ? Math.max(8, window.innerHeight - anchorRect.top + 8) : 80,
      width: 560,
      maxHeight: "min(640px, 75vh)",
      height: "min(640px, 75vh)",
    };
  }

  return (
    <div
      ref={panelRef}
      style={{
        ...panelStyle,
        background: "var(--bg-base)",
        border: "1px solid var(--text-faintest)",
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        zIndex: 9100,
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: mobile ? "6px 8px" : "8px 12px",
        borderBottom: "1px solid var(--text-faintest)",
        fontSize: 12, color: "var(--text-secondary)",
      }}>
        {!mobile && (
          <span style={{ whiteSpace: "nowrap" }}>
            Sent history{total > 0 ? ` · ${total}` : ""}
          </span>
        )}
        <input
          type="text"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          placeholder="Search…"
          style={{
            flex: 1,
            background: "var(--bg-input, transparent)",
            border: "1px solid var(--text-faintest)",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 12,
            color: "var(--text-body)",
            outline: "none",
            minWidth: 0,
          }}
        />
        {rawQuery && (
          <button
            onClick={() => setRawQuery("")}
            style={{
              background: "transparent", border: 0, color: "var(--text-faint)",
              fontSize: 12, cursor: "pointer", padding: "0 4px",
            }}
            title="Clear search"
          >×</button>
        )}
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "1px solid var(--text-faintest)",
            color: "var(--text-secondary)",
            borderRadius: 4,
            fontSize: 12,
            cursor: "pointer",
            padding: "1px 6px",
          }}
          title="Close"
        >✕</button>
      </div>

      <div ref={listRef} style={{ overflowY: "auto", flex: 1 }}>
        {entries === null && !err && (
          <div style={{ padding: 12, fontSize: 12, color: "var(--text-faint)" }}>
            Loading…
          </div>
        )}
        {err && (
          <div style={{ padding: 12, fontSize: 12, color: "#d33" }}>
            {err}
          </div>
        )}
        {entries !== null && entries.length === 0 && !err && (
          <div style={{ padding: 12, fontSize: 12, color: "var(--text-faint)" }}>
            {query
              ? `No prompts match "${query}".`
              : "No prompts sent yet in this session."}
          </div>
        )}
        {entries?.map((e) => (
          <HistoryRow
            key={e.id}
            entry={e}
            query={query}
            compact={mobile}
            onPick={() => handlePick(e.text)}
          />
        ))}
      </div>

      <PagerBar
        pageIndex={pageIndex}
        totalPages={totalPages}
        loading={loading}
        onFirst={goFirst}
        onPrev={goPrev}
        onNext={goNext}
        onLast={goLast}
      />
    </div>
  );
}

interface PagerProps {
  pageIndex: number;
  totalPages: number;
  loading: boolean;
  onFirst: () => void;
  onPrev: () => void;
  onNext: () => void;
  onLast: () => void;
}

function PagerBar({
  pageIndex,
  totalPages,
  loading,
  onFirst,
  onPrev,
  onNext,
  onLast,
}: PagerProps) {
  const atFirst = pageIndex === 0;
  const atLast = totalPages === 0 || pageIndex >= totalPages - 1;
  const displayPage = totalPages === 0 ? 0 : pageIndex + 1;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        padding: "4px 6px",
        borderTop: "1px solid var(--text-faintest)",
        background: "var(--bg-subtle, transparent)",
        fontSize: 11,
        color: "var(--text-secondary)",
      }}
    >
      <PagerButton onClick={onFirst} disabled={atFirst || loading} title="First page">«</PagerButton>
      <PagerButton onClick={onPrev} disabled={atFirst || loading} title="Previous page">‹</PagerButton>
      <span style={{ padding: "0 6px", whiteSpace: "nowrap", minWidth: 36, textAlign: "center" }}>
        {displayPage} / {totalPages}
      </span>
      <PagerButton onClick={onNext} disabled={atLast || loading} title="Next page">›</PagerButton>
      <PagerButton onClick={onLast} disabled={atLast || loading} title="Last page">»</PagerButton>
    </div>
  );
}

function PagerButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: "transparent",
        border: "1px solid var(--text-faintest)",
        color: disabled ? "var(--text-faint)" : "var(--text-body)",
        borderRadius: 4,
        width: 24,
        height: 22,
        padding: 0,
        fontSize: 12,
        lineHeight: 1,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >{children}</button>
  );
}

function HistoryRow({
  entry,
  query,
  compact,
  onPick,
}: {
  entry: PromptHistoryEntry;
  query: string;
  compact: boolean;
  onPick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: compact ? "8px 10px" : "10px 14px",
        borderBottom: "1px solid var(--text-faintest)",
        background: hover ? "var(--bg-hover)" : "transparent",
        display: "flex", alignItems: "center", gap: 8,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11, color: "var(--text-faint)",
          marginBottom: 3,
          display: "flex", gap: 6, alignItems: "baseline",
        }}>
          <span>{relTime(entry.sent_at)}</span>
          {absTime(entry.sent_at) && (
            <span style={{ opacity: 0.7, fontFamily: "var(--font-mono, monospace)" }}>
              {absTime(entry.sent_at)}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 13, color: "var(--text-body)",
            display: "-webkit-box",
            WebkitLineClamp: 4,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
            lineHeight: 1.5,
          }}
        >{renderHighlighted(entry.text, query)}</div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onPick(); }}
        title="Fill into the input box"
        style={{
          flexShrink: 0,
          background: "var(--bg-base)",
          border: "1px solid var(--text-faintest)",
          color: "var(--text-body)",
          fontSize: 13,
          borderRadius: 6,
          width: 28, height: 26, padding: 0,
          cursor: "pointer",
          lineHeight: 1,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >→</button>
    </div>
  );
}

// Highlight every case-insensitive occurrence of `query` inside `text`.
// Returns plain string when no query (avoids extra spans / DOM churn).
function renderHighlighted(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let keyN = 0;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark
        key={`m${keyN++}`}
        style={{
          background: "var(--highlight-bg, #fff59d)",
          color: "inherit",
          padding: 0,
        }}
      >{text.slice(idx, idx + needle.length)}</mark>,
    );
    i = idx + needle.length;
  }
  return parts;
}
