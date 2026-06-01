// Embeds asciiflow.com inside a modal. Cross-origin iframe — we get
// the editor "for free" but can't bridge save/load to our backend.
// Drawings persist in asciiflow.com's own localStorage (per-browser).

import { useEffect } from "react";

export function AsciiflowModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9050,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "92vw",
          height: "90vh",
          background: "var(--bg-modal, #1c1f24)",
          border: "1px solid var(--border, #333)",
          borderRadius: 8,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 16px 50px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "8px 14px",
            borderBottom: "1px solid var(--bg-hover)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "var(--bg-surface)",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>ASCII Diagram (asciiflow.com)</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Drawings persist in your browser at asciiflow.com (not synced).
          </div>
          <div style={{ flex: 1 }} />
          <a
            href="https://asciiflow.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              background: "var(--bg-hover)",
              color: "var(--text-body)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "4px 10px",
              fontSize: 11,
              textDecoration: "none",
            }}
          >
            Open in tab ↗
          </a>
          <button
            onClick={onClose}
            style={{
              background: "var(--bg-hover)",
              color: "var(--text-body)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "4px 12px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
        <iframe
          title="asciiflow"
          src="https://asciiflow.com"
          style={{ width: "100%", height: "100%", border: 0, background: "#fff" }}
          allow="clipboard-write; clipboard-read"
        />
      </div>
    </div>
  );
}
