import { useEffect, useRef, useState } from "react";
import { type AttentionKind, ATTENTION_LABEL } from "./SessionCard";

export interface AttentionItem {
  id: string;
  name: string;
  kind: AttentionKind;
}

interface Props {
  items: AttentionItem[];
  onJump: (id: string) => void;
}

const KIND_ICON: Record<AttentionKind, string> = {
  plan: "📋",
  auq: "❓",
  approve: "🔧",
};

// Top-right floating bubble that flags OTHER sessions needing interaction
// (answer question / approve plan / approve tool) so the user notices even
// with the session sidebar collapsed. Persistent red badge while anything is
// pending; the dropdown briefly auto-pops when a new session starts waiting.
export function AttentionNotifier({ items, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const prevIdsRef = useRef<Set<string>>(new Set());
  const autoTimerRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Pop the panel open for a moment whenever a session id newly appears.
  useEffect(() => {
    const curIds = new Set(items.map((i) => i.id));
    let hasNew = false;
    for (const id of curIds) {
      if (!prevIdsRef.current.has(id)) { hasNew = true; break; }
    }
    prevIdsRef.current = curIds;
    if (hasNew && items.length > 0) {
      setAutoOpen(true);
      if (autoTimerRef.current) window.clearTimeout(autoTimerRef.current);
      autoTimerRef.current = window.setTimeout(() => setAutoOpen(false), 4000);
    }
  }, [items]);

  useEffect(() => () => {
    if (autoTimerRef.current) window.clearTimeout(autoTimerRef.current);
  }, []);

  // Close the manually-opened panel on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (items.length === 0) return null;

  const expanded = open || autoOpen;

  return (
    <div ref={rootRef} style={{ position: "fixed", top: 8, right: 12, zIndex: 400 }}>
      <button
        className="attention-banner"
        onClick={() => { setAutoOpen(false); setOpen((o) => !o); }}
        title={`${items.length} session(s) need attention`}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          border: "none", borderRadius: 999, cursor: "pointer",
          color: "#fff", fontSize: 12, fontWeight: 700,
          padding: "5px 11px", lineHeight: 1,
        }}
      >
        <span style={{ fontSize: 13 }}>⚠</span>
        <span>{items.length}</span>
      </button>

      {expanded && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0,
            minWidth: 240, maxWidth: 340,
            background: "var(--bg-modal)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            padding: 6,
            display: "flex", flexDirection: "column", gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
              color: "var(--text-muted)", textTransform: "uppercase",
              padding: "4px 8px 2px",
            }}
          >
            Needs attention
          </div>
          {items.map((it) => (
            <button
              key={it.id}
              onClick={() => { setOpen(false); setAutoOpen(false); onJump(it.id); }}
              title={`Jump to ${it.name}`}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                background: "var(--bg-hover)", border: "none",
                borderLeft: "3px solid #dc2626", borderRadius: 6,
                cursor: "pointer", textAlign: "left",
                padding: "7px 9px", width: "100%",
              }}
            >
              <span style={{ fontSize: 14, flexShrink: 0 }}>{KIND_ICON[it.kind]}</span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 12, fontWeight: 600, color: "var(--text-body)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    maxWidth: 280,
                  }}
                >
                  {it.name}
                </span>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#ef4444", letterSpacing: 0.4 }}>
                  {ATTENTION_LABEL[it.kind]}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
