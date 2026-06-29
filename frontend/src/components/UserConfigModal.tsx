import { useEffect, useState } from "react";
import { IconSun, IconMoon } from "./icons";
import type { LayoutScheme } from "../hooks/useUserConfig";
import {
  getConfig,
  getSystemFonts,
  setTermLifecycle,
  setTerminalFont,
  type FontInfo,
} from "../api/sessionApi";

interface Props {
  open: boolean;
  onClose: () => void;
  layout: LayoutScheme;
  onLayoutChange: (s: LayoutScheme) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  terminalFont: string | undefined;
  onTerminalFontApplied: (font: string) => void;
}

const LAYOUTS: { id: LayoutScheme; label: string; desc: string; preview: React.ReactNode }[] = [
  {
    id: "classic",
    label: "Classic",
    desc: "三栏并列：Sessions / Files / Conversation。底部可选 Terminal 面板。",
    preview: <LayoutPreviewClassic />,
  },
  {
    id: "chat-centric",
    label: "Chat-Centric",
    desc: "对话居中最大化，Files 树/查看器移到右侧检查器。底部可选 Terminal 面板。",
    preview: <LayoutPreviewChatCentric />,
  },
  {
    id: "file-centric",
    label: "File-Centric",
    desc: "宽屏 4 列：Sidebar / 宽 Files 树 / 多 tab 查看器 / Chat·TUI。tab 可同时打开多个文件、Git、JSONL，切换 session 自动保留。",
    preview: <LayoutPreviewFileCentric />,
  },
];

function LayoutPreviewClassic() {
  return (
    <svg viewBox="0 0 160 100" width="160" height="100" style={{ display: "block" }}>
      <rect x="0" y="0" width="160" height="100" fill="var(--bg-base)" stroke="var(--border)" />
      <rect x="0" y="0" width="34" height="100" fill="var(--bg-sidebar)" />
      <rect x="34" y="0" width="38" height="100" fill="var(--bg-surface)" />
      <rect x="72" y="0" width="88" height="72" fill="var(--bg-base)" />
      <rect x="72" y="72" width="88" height="28" fill="#0d1117" />
      <text x="76" y="86" fontSize="7" fill="#3fb950" fontFamily="monospace">&gt;_ term</text>
      <line x1="34" y1="0" x2="34" y2="100" stroke="var(--border)" />
      <line x1="72" y1="0" x2="72" y2="100" stroke="var(--border)" />
      <line x1="72" y1="72" x2="160" y2="72" stroke="var(--border)" />
    </svg>
  );
}

function LayoutPreviewChatCentric() {
  return (
    <svg viewBox="0 0 160 100" width="160" height="100" style={{ display: "block" }}>
      <rect x="0" y="0" width="160" height="100" fill="var(--bg-base)" stroke="var(--border)" />
      <rect x="0" y="0" width="34" height="100" fill="var(--bg-sidebar)" />
      <rect x="34" y="0" width="84" height="72" fill="var(--bg-base)" />
      <rect x="118" y="0" width="42" height="100" fill="var(--bg-surface)" />
      <rect x="34" y="72" width="84" height="28" fill="#0d1117" />
      <text x="38" y="86" fontSize="7" fill="#3fb950" fontFamily="monospace">&gt;_ term</text>
      <text x="60" y="40" fontSize="8" fill="var(--text-muted)" fontFamily="monospace">chat</text>
      <line x1="34" y1="0" x2="34" y2="100" stroke="var(--border)" />
      <line x1="118" y1="0" x2="118" y2="100" stroke="var(--border)" />
      <line x1="34" y1="72" x2="118" y2="72" stroke="var(--border)" />
    </svg>
  );
}

function LayoutPreviewFileCentric() {
  // 4-column horizontal: Sidebar | Tree | Viewer (tabs+content) | Chat (+ term strip)
  return (
    <svg viewBox="0 0 160 100" width="160" height="100" style={{ display: "block" }}>
      <rect x="0" y="0" width="160" height="100" fill="var(--bg-base)" stroke="var(--border)" />
      {/* Sidebar */}
      <rect x="0" y="0" width="18" height="100" fill="var(--bg-sidebar)" />
      {/* Tree */}
      <rect x="18" y="0" width="42" height="100" fill="var(--bg-surface)" />
      <text x="22" y="54" fontSize="7" fill="var(--text-muted)" fontFamily="monospace">tree</text>
      {/* Viewer with tab bar */}
      <rect x="60" y="0" width="60" height="10" fill="var(--bg-hover)" />
      <text x="62" y="8" fontSize="6" fill="var(--text-muted)" fontFamily="monospace">[a][b]×</text>
      <rect x="60" y="10" width="60" height="90" fill="var(--bg-base)" />
      <text x="76" y="58" fontSize="7" fill="var(--text-muted)" fontFamily="monospace">viewer</text>
      {/* Chat + term strip */}
      <rect x="120" y="0" width="40" height="72" fill="var(--bg-base)" />
      <text x="128" y="40" fontSize="8" fill="var(--text-muted)" fontFamily="monospace">chat</text>
      <rect x="120" y="72" width="40" height="28" fill="#0d1117" />
      <text x="124" y="86" fontSize="6" fill="#3fb950" fontFamily="monospace">&gt;_ term</text>
      {/* Dividers */}
      <line x1="18" y1="0" x2="18" y2="100" stroke="var(--border)" />
      <line x1="60" y1="0" x2="60" y2="100" stroke="var(--border)" />
      <line x1="60" y1="10" x2="120" y2="10" stroke="var(--border)" />
      <line x1="120" y1="0" x2="120" y2="100" stroke="var(--border)" />
      <line x1="120" y1="72" x2="160" y2="72" stroke="var(--border)" />
    </svg>
  );
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--text-faint)",
  marginBottom: 8,
  fontWeight: 600,
};

export function UserConfigModal({
  open, onClose, layout, onLayoutChange,
  theme, onToggleTheme,
  terminalFont, onTerminalFontApplied,
}: Props) {
  const [fontList, setFontList] = useState<FontInfo[]>([]);
  const [fontLoading, setFontLoading] = useState(false);
  const [fontFilter, setFontFilter] = useState("");
  const [fontMsg, setFontMsg] = useState<string | null>(null);

  // Bash terminal lifecycle (idle → standby → kill). Stored as strings so the
  // user can clear the input while typing; we parse on save.
  const [idleGrace, setIdleGrace] = useState<string>("");
  const [standbyGrace, setStandbyGrace] = useState<string>("");
  const [lifecycleMsg, setLifecycleMsg] = useState<string | null>(null);
  const [lifecycleSaving, setLifecycleSaving] = useState(false);

  useEffect(() => {
    if (!open || fontList.length > 0) return;
    setFontLoading(true);
    getSystemFonts()
      .then(f => { setFontList(f); setFontLoading(false); })
      .catch(() => setFontLoading(false));
  }, [open, fontList.length]);

  useEffect(() => {
    if (!open) return;
    getConfig()
      .then(c => {
        setIdleGrace(String(c.term_idle_grace_seconds ?? 600));
        setStandbyGrace(String(c.term_standby_grace_seconds ?? 30));
      })
      .catch(() => { /* keep blank — user can still type and save */ });
  }, [open]);

  const saveLifecycle = async () => {
    const i = Number(idleGrace);
    const s = Number(standbyGrace);
    if (!Number.isFinite(i) || i < 10) { setLifecycleMsg("Idle grace must be ≥ 10 seconds."); return; }
    if (!Number.isFinite(s) || s < 5) { setLifecycleMsg("Standby grace must be ≥ 5 seconds."); return; }
    setLifecycleSaving(true);
    setLifecycleMsg(null);
    try {
      const c = await setTermLifecycle(Math.floor(i), Math.floor(s));
      setIdleGrace(String(c.term_idle_grace_seconds));
      setStandbyGrace(String(c.term_standby_grace_seconds));
      setLifecycleMsg("Saved. Sweeper picks up new values on the next tick.");
    } catch (e) {
      setLifecycleMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLifecycleSaving(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const filteredFonts = fontList.filter(f =>
    !fontFilter || f.family.toLowerCase().includes(fontFilter.toLowerCase())
  );

  const applyFont = async (family: string) => {
    try {
      const c = await setTerminalFont(family);
      onTerminalFontApplied(c.terminal_font);
      setFontMsg(`Terminal font set to "${family}". Reattach session to take full effect.`);
    } catch (e) {
      setFontMsg(String(e));
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 4000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "min(720px, 92vw)", maxHeight: "85vh",
          background: "var(--bg-base)", border: "1px solid var(--border-strong)",
          borderRadius: 10, display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "12px 16px", borderBottom: "1px solid var(--bg-hover)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          flexShrink: 0, background: "var(--bg-surface)",
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-body)" }}>⚙ User Config</span>
          <button onClick={onClose} style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: 12, padding: "4px 10px" }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 22 }}>
          {/* Layout */}
          <section>
            <div style={sectionTitleStyle}>Layout</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
              {LAYOUTS.map(l => {
                const selected = layout === l.id;
                return (
                  <button
                    key={l.id}
                    onClick={() => onLayoutChange(l.id)}
                    title={l.desc}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "stretch", gap: 6,
                      padding: 8,
                      border: `2px solid ${selected ? "var(--accent-blue)" : "var(--border)"}`,
                      borderRadius: 8,
                      background: selected ? "rgba(88,166,255,0.08)" : "var(--bg-surface)",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <div style={{ borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)" }}>
                      {l.preview}
                    </div>
                    <div style={{
                      fontSize: 12, fontWeight: 600,
                      color: selected ? "var(--accent-blue)" : "var(--text-body)",
                    }}>
                      {selected ? "● " : ""}{l.label}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.4 }}>
                      {l.desc}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Theme */}
          <section>
            <div style={sectionTitleStyle}>Theme</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => { if (theme !== "dark") onToggleTheme(); }}
                style={{
                  padding: "8px 16px", borderRadius: 6, fontSize: 12,
                  border: `1px solid ${theme === "dark" ? "var(--accent-blue)" : "var(--border)"}`,
                  background: theme === "dark" ? "rgba(88,166,255,0.12)" : "var(--bg-surface)",
                  color: theme === "dark" ? "var(--accent-blue)" : "var(--text-body)",
                  cursor: "pointer",
                }}
              ><IconMoon style={{ verticalAlign: "-0.15em" }} /> Dark</button>
              <button
                onClick={() => { if (theme !== "light") onToggleTheme(); }}
                style={{
                  padding: "8px 16px", borderRadius: 6, fontSize: 12,
                  border: `1px solid ${theme === "light" ? "var(--accent-blue)" : "var(--border)"}`,
                  background: theme === "light" ? "rgba(88,166,255,0.12)" : "var(--bg-surface)",
                  color: theme === "light" ? "var(--accent-blue)" : "var(--text-body)",
                  cursor: "pointer",
                }}
              ><IconSun style={{ verticalAlign: "-0.15em" }} /> Light</button>
            </div>
          </section>

          {/* Terminal font */}
          <section>
            <div style={sectionTitleStyle}>Terminal Font</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
              Current: <code style={{ color: "var(--text-secondary)" }}>{terminalFont || "(default)"}</code>
            </div>
            <input
              placeholder="Filter fonts..."
              value={fontFilter}
              onChange={e => setFontFilter(e.target.value)}
              style={{
                width: "100%", padding: "6px 10px", marginBottom: 8,
                background: "var(--bg-surface)", border: "1px solid var(--border)",
                borderRadius: 5, color: "var(--text-body)", fontSize: 12,
              }}
            />
            <div style={{
              maxHeight: 200, overflowY: "auto",
              border: "1px solid var(--border)", borderRadius: 6,
              background: "var(--bg-surface)",
            }}>
              {fontLoading && <div style={{ padding: 10, fontSize: 12, color: "var(--text-muted)" }}>Loading…</div>}
              {!fontLoading && filteredFonts.length === 0 && (
                <div style={{ padding: 10, fontSize: 12, color: "var(--text-muted)" }}>No matching fonts.</div>
              )}
              {filteredFonts.map(f => {
                const isActive = f.family === terminalFont;
                return (
                  <div
                    key={f.family}
                    onClick={() => applyFont(f.family)}
                    style={{
                      padding: "6px 10px", cursor: "pointer", fontSize: 12,
                      borderBottom: "1px solid var(--bg-hover)",
                      background: isActive ? "rgba(88,166,255,0.1)" : "transparent",
                      display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
                    }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = isActive ? "rgba(88,166,255,0.1)" : "transparent"; }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      {f.recommended && (
                        <span style={{ fontSize: 9, padding: "1px 4px", background: "rgba(88,166,255,0.15)", color: "var(--accent-blue)", borderRadius: 3 }}>★</span>
                      )}
                      <span style={{ color: isActive ? "var(--accent-blue)" : "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.family}</span>
                    </span>
                    <span style={{ fontFamily: f.family, fontSize: 12, color: "var(--text-muted)" }}>AaBb 你好 123</span>
                  </div>
                );
              })}
            </div>
            {fontMsg && (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>{fontMsg}</div>
            )}
          </section>

          {/* Bash terminal lifecycle */}
          <section>
            <div style={sectionTitleStyle}>Bash Terminal Lifecycle</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
              Ephemeral tmux terminals stay alive after the last client disconnects so refreshing the
              page reattaches to the same session. Once no client has held it for the idle window, it
              enters a hidden <code>standby</code> state for the standby grace, then tmux kills it.
              A cached client that heartbeats during standby revives the terminal and pins it.
            </div>
            <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Idle grace (seconds)</span>
                <input
                  type="number"
                  min={10}
                  step={10}
                  value={idleGrace}
                  onChange={e => { setIdleGrace(e.target.value); if (lifecycleMsg) setLifecycleMsg(null); }}
                  style={{
                    width: 110, padding: "6px 8px", fontSize: 12,
                    background: "var(--bg-surface)", border: "1px solid var(--border)",
                    borderRadius: 5, color: "var(--text-body)",
                  }}
                />
                <span style={{ fontSize: 10, color: "var(--text-faint)" }}>default 600 (10 min)</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Standby grace (seconds)</span>
                <input
                  type="number"
                  min={5}
                  step={5}
                  value={standbyGrace}
                  onChange={e => { setStandbyGrace(e.target.value); if (lifecycleMsg) setLifecycleMsg(null); }}
                  style={{
                    width: 110, padding: "6px 8px", fontSize: 12,
                    background: "var(--bg-surface)", border: "1px solid var(--border)",
                    borderRadius: 5, color: "var(--text-body)",
                  }}
                />
                <span style={{ fontSize: 10, color: "var(--text-faint)" }}>default 30</span>
              </label>
              <button
                onClick={saveLifecycle}
                disabled={lifecycleSaving}
                style={{
                  padding: "6px 14px", fontSize: 12,
                  background: lifecycleSaving ? "var(--text-faintest)" : "var(--accent-blue)",
                  color: "#fff", borderRadius: 5,
                }}
              >{lifecycleSaving ? "Saving…" : "Save"}</button>
            </div>
            {lifecycleMsg && (
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)" }}>{lifecycleMsg}</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
