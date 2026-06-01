import { useState } from "react";

// ── Terminal assistive keys bar ─────────────────────────────────────────────
// On-screen helper keys for touch devices (tablets / phones) whose soft
// keyboards can't easily produce ESC, Tab, Ctrl-combos, arrows, or shell
// symbols like | ~ \ etc. Sends raw byte sequences straight to the PTY via the
// `sendKey` callback (which the parent wires to TerminalPane's sendRawRef →
// ws.sendInput). Shared by the desktop Term panel and the mobile shell so both
// stay in sync from one source of truth.

const NAV_KEYS = [
  { label: "ESC", seq: "\x1b", title: "Escape" },
  { label: "TAB", seq: "\t", title: "Tab" },
  { label: "←", seq: "\x1b[D", title: "Arrow Left" },
  { label: "↑", seq: "\x1b[A", title: "Arrow Up" },
  { label: "↓", seq: "\x1b[B", title: "Arrow Down" },
  { label: "→", seq: "\x1b[C", title: "Arrow Right" },
];

// Ctrl+letter combos encode as the control character (letter code − 64): C→\x03.
const CTRL_KEYS = [
  { letter: "C", desc: "int", title: "Ctrl+C — Interrupt" },
  { letter: "D", desc: "eof", title: "Ctrl+D — EOF / logout" },
  { letter: "Z", desc: "sus", title: "Ctrl+Z — Suspend" },
  { letter: "L", desc: "clr", title: "Ctrl+L — Clear screen" },
  { letter: "A", desc: "home", title: "Ctrl+A — Beginning of line" },
  { letter: "E", desc: "end", title: "Ctrl+E — End of line" },
  { letter: "U", desc: "kill", title: "Ctrl+U — Kill line" },
  { letter: "W", desc: "back", title: "Ctrl+W — Delete word back" },
  { letter: "R", desc: "hist", title: "Ctrl+R — History search" },
];

// Shell symbols that tablet/phone keyboards bury behind several taps.
const SYM_KEYS = ["|", "~", "`", "\\", "/", "-", "_", "*", "&", "$", "#", "{", "}", "[", "]", "<", ">", ";", '"', "'"];

const arrowLabels = "←↑↓→";

export function TermKeysBar({ sendKey }: { sendKey: (seq: string) => void }) {
  // Only one expandable row open at a time (ctrl-combos vs symbols).
  const [expanded, setExpanded] = useState<"none" | "ctrl" | "sym">("none");

  const sendCtrl = (letter: string) => {
    sendKey(String.fromCharCode(letter.charCodeAt(0) - 64));
    setExpanded("none");
  };

  const btnBase: React.CSSProperties = {
    flex: 1, height: 40, background: "transparent", border: "none",
    borderRight: "1px solid var(--border-subtle)", color: "var(--text-primary)",
    fontSize: 13, fontFamily: "monospace", fontWeight: 600,
    cursor: "pointer", padding: 0, userSelect: "none",
  };
  const toggleStyle = (on: boolean): React.CSSProperties => ({
    ...btnBase,
    background: on ? "color-mix(in srgb, var(--accent-blue) 20%, var(--bg-base))" : "transparent",
    color: on ? "var(--accent-blue)" : "var(--text-secondary)",
    letterSpacing: 0.5,
  });

  return (
    <div style={{ flexShrink: 0, background: "var(--bg-surface)", borderTop: "1px solid var(--border)" }}>
      {/* Primary row: modifier toggles + nav keys */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border-subtle)" }}>
        <button
          title="Ctrl modifier — tap, then tap a letter"
          onPointerDown={(e) => { e.preventDefault(); setExpanded(v => v === "ctrl" ? "none" : "ctrl"); }}
          style={toggleStyle(expanded === "ctrl")}
        >CTRL</button>
        <button
          title="Symbols — | ~ \\ / etc."
          onPointerDown={(e) => { e.preventDefault(); setExpanded(v => v === "sym" ? "none" : "sym"); }}
          style={toggleStyle(expanded === "sym")}
        >SYM</button>
        {NAV_KEYS.map((k) => {
          const isArrow = k.label.length === 1 && arrowLabels.includes(k.label);
          return (
            <button
              key={k.label}
              title={k.title}
              onPointerDown={(e) => { e.preventDefault(); sendKey(k.seq); }}
              style={{ ...btnBase, fontSize: isArrow ? 18 : 13 }}
            >{k.label}</button>
          );
        })}
      </div>

      {/* Expandable: Ctrl+letter combos */}
      {expanded === "ctrl" && (
        <div style={{ display: "flex", overflowX: "auto", scrollbarWidth: "none" }}>
          {CTRL_KEYS.map(({ letter, desc, title }) => (
            <button
              key={letter}
              title={title}
              onPointerDown={(e) => { e.preventDefault(); sendCtrl(letter); }}
              style={{
                flexShrink: 0, minWidth: 52, height: 40,
                background: "transparent", border: "none",
                borderRight: "1px solid var(--border-subtle)",
                cursor: "pointer", userSelect: "none",
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 1, padding: 0,
              }}
            >
              <span style={{ fontSize: 13, fontFamily: "monospace", fontWeight: 700, color: "var(--accent-blue)", lineHeight: 1 }}>^{letter}</span>
              <span style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1, letterSpacing: 0.3 }}>{desc}</span>
            </button>
          ))}
        </div>
      )}

      {/* Expandable: shell symbols */}
      {expanded === "sym" && (
        <div style={{ display: "flex", overflowX: "auto", scrollbarWidth: "none" }}>
          {SYM_KEYS.map((s) => (
            <button
              key={s}
              title={s}
              onPointerDown={(e) => { e.preventDefault(); sendKey(s); }}
              style={{
                flexShrink: 0, minWidth: 40, height: 40,
                background: "transparent", border: "none",
                borderRight: "1px solid var(--border-subtle)",
                color: "var(--text-primary)", cursor: "pointer", userSelect: "none",
                fontSize: 16, fontFamily: "monospace", fontWeight: 600, padding: 0,
              }}
            >{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}
