import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { DownloadExclusionModal } from "../components/DownloadExclusionModal";
import { useWindowSize } from "../lib/useWindowSize";
import {
  listSessions,
  listSessionsStatus,
  listDirs,
  createSession,
  getSession,
  attachSession,
  terminateSession,
  deleteSession,
  resumeSession,
  getConfig,
  restartServer,
  extractToDir,
  getDirInfo,
  downloadDirZip,
  getAvailableTools,
  browseExternalSessions,
  browseCursorSessions,
  browseCodexSessions,
  getExternalPreview,
  listModels,
  setSessionModel,
  listGoals,
  listSessionTodos,
  getStatusBar,
  type SessionMeta,
  type AttachResponse,
  type ExternalSession,
  type ExternalSessionGroup,
  type ExternalPreview,
  type ModelInfo,
  type TuiAuqData,
  type TuiApproveData,
  type TuiPlanData,
  type Goal,
  type TodoItem,
  type TodoPlan,
} from "../api/sessionApi";
// SessionMeta used for fileEditorSession state
import { TuiPane } from "../components/TuiPane";
import { ConversationPane } from "../components/ConversationPane";
import { CodePane, FileViewerPane, FileSidePanel, ScratchEditorPane } from "../components/CodePane";
import { SessionCard, PromptText, type AttentionKind } from "../components/SessionCard";
import { AttentionNotifier, type AttentionItem } from "../components/AttentionNotifier";
import { UsageBar, UsageCenter } from "../components/UsageBar";
import { FileEditorModal } from "../components/FileEditorModal";
import { GitPanel } from "../components/GitPanel";
import { JsonlPreviewModal } from "../components/JsonlPreviewModal";
import { MemoryPanel } from "../components/MemoryPanel";
import { downloadConversationHtml } from "../lib/exportChat";
import { apiPath } from "../lib/baseUrl";
import { SessionSideDock } from "../components/SessionSideDock";
import { UserConfigModal } from "../components/UserConfigModal";
import { ShareModal } from "../components/ShareModal";
import { EmbeddedTerminalPanel, useSessionTerminalApi } from "../components/EmbeddedTerminalPanel";
import CodexChatInput from "../components/CodexChatInput";
import { TextSelectionMenu } from "../components/TextSelectionMenu";
import { AsciiflowModal } from "../components/AsciiflowModal";
import { useUserConfig, type LayoutScheme } from "../hooks/useUserConfig";
import { useSessionTabs, type TabEntry } from "../hooks/useSessionTabs";

const PAGE_SIZE = 30;

/* ───── Fullscreen Clock ─────
 * Only mounts a 1s interval while the browser tab is actually in fullscreen
 * (Fullscreen API or PWA display-mode). Double-click cycles through:
 *   A → unix → B → unix → C → unix → D → unix → E → unix → A → …
 * so each string format alternates with a unix-seconds view. Choice persists
 * in localStorage as the cycle index.
 */
const CLOCK_FMT_KEY = "fullscreenClockIdx";
type StringFmt = "local" | "longMDY" | "longDMY12" | "isoZ" | "isoOffset";
const STRING_FMTS: StringFmt[] = ["local", "longMDY", "longDMY12", "isoZ", "isoOffset"];
const CYCLE_LEN = STRING_FMTS.length * 2;
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatString(fmt: StringFmt, d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (fmt) {
    case "local":
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    case "longMDY":
      return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    case "longDMY12": {
      const h24 = d.getHours();
      const ampm = h24 >= 12 ? "PM" : "AM";
      const h12 = h24 % 12 || 12;
      return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()} ${h12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm}`;
    }
    case "isoZ":
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
    case "isoOffset": {
      const offMin = -d.getTimezoneOffset();
      const sign = offMin >= 0 ? "+" : "-";
      const abs = Math.abs(offMin);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    }
  }
}

function clockTextAt(idx: number, d: Date): string {
  // Even slots show a string format; odd slots show unix seconds.
  if (idx % 2 === 0) return formatString(STRING_FMTS[idx / 2], d);
  return String(Math.floor(d.getTime() / 1000));
}

function FullscreenClock() {
  const [isFs, setIsFs] = useState<boolean>(() => {
    if (typeof document === "undefined") return false;
    return !!document.fullscreenElement
      || (typeof window !== "undefined" && window.matchMedia("(display-mode: fullscreen)").matches);
  });
  const [idx, setIdx] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(CLOCK_FMT_KEY);
      if (raw !== null) {
        const n = parseInt(raw, 10);
        if (Number.isInteger(n) && n >= 0 && n < CYCLE_LEN) return n;
      }
    } catch { /* storage disabled */ }
    return 0;
  });
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const sync = () => {
      const fs = !!document.fullscreenElement
        || window.matchMedia("(display-mode: fullscreen)").matches;
      setIsFs(fs);
    };
    document.addEventListener("fullscreenchange", sync);
    const mm = window.matchMedia("(display-mode: fullscreen)");
    mm.addEventListener?.("change", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      mm.removeEventListener?.("change", sync);
    };
  }, []);

  useEffect(() => {
    if (!isFs) return;
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [isFs]);

  if (!isFs) return null;

  const cycle = () => {
    setIdx(prev => {
      const next = (prev + 1) % CYCLE_LEN;
      try { localStorage.setItem(CLOCK_FMT_KEY, String(next)); } catch { /* quota / disabled */ }
      return next;
    });
  };

  return (
    <div
      onDoubleClick={cycle}
      title="Double-click to cycle time formats"
      style={{
        marginLeft: "auto",
        fontSize: 11,
        padding: "2px 8px",
        color: "var(--text-faint)",
        fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        userSelect: "none",
        cursor: "default",
      }}
    >
      {clockTextAt(idx, now)}
    </div>
  );
}

/* ───── File-Centric Viewer Column ─────
 * The middle column in file-centric layout. Holds a tab bar + the active tab's
 * content. All tab contents are mounted simultaneously with display:none for
 * inactive ones so CodeMirror state (scroll position, selection, history) is
 * preserved across tab switches.
 */
function FileCentricViewerColumn(props: {
  sessionId: string;
  sessionMeta: SessionMeta;
  tabs: TabEntry[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseMany: (ids: string[]) => void;
  onCreateScratch: () => string;
  onUpdateScratch: (id: string, content: string) => void;
  onPromoteScratch: (id: string, path: string) => void;
}) {
  const {
    sessionId, sessionMeta, tabs, activeTabId,
    onActivate, onClose, onCloseMany,
    onCreateScratch, onUpdateScratch, onPromoteScratch,
  } = props;

  // Per-tab dirty flag, reported up by FileViewerPane via onDirtyChange.
  // Git/JSONL tabs are never dirty (absent from the map = treated as clean).
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});
  const setTabDirty = useCallback((tabId: string, dirty: boolean) => {
    setDirtyMap(prev => {
      const cur = !!prev[tabId];
      if (cur === dirty) return prev;
      const next = { ...prev };
      if (dirty) next[tabId] = true;
      else delete next[tabId];
      return next;
    });
  }, []);
  // Prune dirty entries for tabs that no longer exist.
  useEffect(() => {
    setDirtyMap(prev => {
      const alive = new Set(tabs.map(t => t.id));
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (alive.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [tabs]);

  // Open dropdown menu (per-tab); pendingClose drives the dirty-confirm modal.
  // Menu is position:fixed because the tab bar uses overflow:hidden — an
  // absolute child would be clipped. Coords are captured from the trigger.
  const [menuTabId, setMenuTabId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [pendingClose, setPendingClose] = useState<{ ids: string[]; dirtyPaths: string[] } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuTabId) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuTabId(null);
        setMenuPos(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMenuTabId(null); setMenuPos(null); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuTabId]);

  const pathFor = (id: string): string => {
    const t = tabs.find(x => x.id === id);
    if (!t) return id;
    if (t.kind === "file") return t.path;
    if (t.kind === "git") return "(Git)";
    return t.title;
  };

  // Tab-list dropdown (⌄ N) — clicking a row jumps + scrolls active into view.
  const [tabListOpen, setTabListOpen] = useState(false);
  const [tabListPos, setTabListPos] = useState<{ top: number; right: number } | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!tabListOpen) return;
    const onDown = (e: MouseEvent) => {
      if (tabListRef.current && !tabListRef.current.contains(e.target as Node)) {
        setTabListOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTabListOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [tabListOpen]);

  // Scroll the active tab into view (used after activate-from-dropdown or
  // after openScratchTab appends to the end). The ref is keyed by tab id.
  const tabElRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!activeTabId) return;
    const el = tabElRefs.current[activeTabId];
    if (el) el.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTabId]);

  const requestSingleClose = (id: string) => {
    if (dirtyMap[id]) {
      setPendingClose({ ids: [id], dirtyPaths: [pathFor(id)] });
    } else {
      onClose(id);
    }
  };

  const requestClose = (scope: "saved" | "others" | "right" | "all", anchorId: string) => {
    const anchorIdx = tabs.findIndex(t => t.id === anchorId);
    let candidates: string[];
    if (scope === "saved") {
      // Always safe: skip every dirty file tab.
      candidates = tabs.filter(t => !dirtyMap[t.id]).map(t => t.id);
    } else if (scope === "others") {
      candidates = tabs.filter(t => t.id !== anchorId).map(t => t.id);
    } else if (scope === "right") {
      candidates = anchorIdx < 0 ? [] : tabs.slice(anchorIdx + 1).map(t => t.id);
    } else {
      candidates = tabs.map(t => t.id);
    }
    setMenuTabId(null);
    setMenuPos(null);
    if (candidates.length === 0) return;
    if (scope === "saved") {
      onCloseMany(candidates);
      return;
    }
    const dirtyIds = candidates.filter(id => dirtyMap[id]);
    if (dirtyIds.length === 0) {
      onCloseMany(candidates);
      return;
    }
    setPendingClose({ ids: candidates, dirtyPaths: dirtyIds.map(pathFor) });
  };

  const labelFor = (t: TabEntry): string => {
    if (t.kind === "file") {
      const base = t.path.split("/").filter(Boolean).pop() || t.path;
      return base;
    }
    if (t.kind === "git") return "Git";
    return t.title;
  };
  const titleFor = (t: TabEntry): string => {
    if (t.kind === "file") return t.path;
    if (t.kind === "git") return "Git status, diff, history, branches";
    return `${t.title} (unsaved scratch)`;
  };
  const iconFor = (t: TabEntry): string => {
    if (t.kind === "file") return "📄";
    if (t.kind === "git") return "⎇";
    return "📝";
  };

  const handleCreateScratch = () => {
    setTabListOpen(false);
    onCreateScratch();
  };

  return (
    <div style={{
      flex: "1 1 0%", minWidth: 240, minHeight: 0, overflow: "hidden",
      background: "var(--bg-base)",
      display: "flex", flexDirection: "column",
      borderRight: "1px solid var(--border)",
    }}>
      {/* Tab bar: scrollable tabs + filler (inside scroll), then ⌄ N dropdown
          and a right blank strip (outside scroll, always visible). Double-
          clicking either the inside filler or the right strip creates a new
          scratch tab. */}
      <div style={{
        flexShrink: 0, display: "flex", alignItems: "stretch",
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--border)",
        minHeight: 28,
      }}>
        <div style={{
          flex: "1 1 0%", minWidth: 0,
          display: "flex", alignItems: "stretch",
          overflowX: "auto", overflowY: "hidden",
        }}>
          {tabs.length === 0 && (
            <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text-faint)" }}>
              Click a file in the tree, double-click the blank strip to create a scratch file.
            </div>
          )}
          {tabs.map(t => {
            const isActive = t.id === activeTabId;
            const isDirty = !!dirtyMap[t.id];
            const menuOpen = menuTabId === t.id;
            return (
              <div
                key={t.id}
                ref={(el) => { tabElRefs.current[t.id] = el; }}
                onClick={() => onActivate(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenuPos({ top: r.bottom + 2, right: Math.max(4, window.innerWidth - r.right) });
                  setMenuTabId(t.id);
                }}
                title={titleFor(t)}
                style={{
                  position: "relative",
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "4px 8px 4px 10px", cursor: "pointer",
                  fontSize: 11, color: isActive ? "var(--text-body)" : "var(--text-faint)",
                  background: isActive ? "var(--bg-base)" : "transparent",
                  borderRight: "1px solid var(--border)",
                  borderTop: isActive ? "1px solid var(--accent-blue)" : "1px solid transparent",
                  userSelect: "none", whiteSpace: "nowrap", flexShrink: 0,
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ fontSize: 9, opacity: 0.7 }}>{iconFor(t)}</span>
                <span>{labelFor(t)}{isDirty ? " ●" : ""}</span>
                <span
                  onClick={(e) => { e.stopPropagation(); requestSingleClose(t.id); }}
                  title={isDirty ? "Close tab (unsaved changes — will prompt)" : "Close tab"}
                  style={{
                    marginLeft: 4, padding: "0 4px", fontSize: 12, lineHeight: 1,
                    color: "var(--text-faint)", borderRadius: 3,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-body)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-faint)"; }}
                >×</span>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    if (menuOpen) { setMenuTabId(null); setMenuPos(null); return; }
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenuPos({ top: r.bottom + 2, right: Math.max(4, window.innerWidth - r.right) });
                    setMenuTabId(t.id);
                  }}
                  title="Close options"
                  style={{
                    marginLeft: 1, padding: "0 4px", fontSize: 10, lineHeight: 1,
                    color: "var(--accent-orange, #d59f00)", borderRadius: 3,
                    background: menuOpen ? "color-mix(in srgb, var(--accent-orange, #d59f00) 18%, transparent)" : "transparent",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent-orange, #d59f00) 22%, transparent)"; }}
                  onMouseLeave={(e) => { if (!menuOpen) e.currentTarget.style.background = "transparent"; }}
                >▾</span>
              </div>
            );
          })}
          {/* Filler inside scroll — double-click empty area to create scratch */}
          <div
            onDoubleClick={handleCreateScratch}
            title="Double-click to create a new scratch file"
            style={{ flex: "1 1 60px", minWidth: 60, cursor: "default" }}
          />
        </div>
        {tabs.length > 0 && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              if (tabListOpen) { setTabListOpen(false); return; }
              const r = e.currentTarget.getBoundingClientRect();
              setTabListPos({ top: r.bottom + 2, right: Math.max(4, window.innerWidth - r.right) });
              setTabListOpen(true);
            }}
            title="All open tabs"
            style={{
              flexShrink: 0, padding: "0 10px",
              display: "flex", alignItems: "center", gap: 4, cursor: "pointer",
              fontSize: 11, color: "var(--text-secondary)",
              borderLeft: "1px solid var(--border)",
              background: tabListOpen ? "var(--bg-hover)" : "transparent",
              userSelect: "none",
            }}
            onMouseEnter={(e) => { if (!tabListOpen) e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { if (!tabListOpen) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ fontSize: 12 }}>⌄</span>
            <span>{tabs.length}</span>
          </div>
        )}
        <div
          onDoubleClick={handleCreateScratch}
          title="Double-click to create a new scratch file"
          style={{
            flexShrink: 0, width: 80, cursor: "default",
            borderLeft: "1px solid var(--border)",
          }}
        />
      </div>
      {/* Tab content: mount all, display:none for inactive */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
        {tabs.length === 0 && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--text-faint)", fontSize: 12,
          }}>
            No tab open
          </div>
        )}
        {tabs.map(t => {
          const isActive = t.id === activeTabId;
          return (
            <div
              key={t.id}
              style={{
                position: "absolute", inset: 0,
                display: isActive ? "flex" : "none",
                flexDirection: "column", minHeight: 0, overflow: "hidden",
              }}
            >
              {t.kind === "file" && (
                <FileViewerPane
                  sessionId={sessionId}
                  path={t.path}
                  viewMode={t.viewMode}
                  noDiff={t.noDiff}
                  onDirtyChange={(d) => setTabDirty(t.id, d)}
                />
              )}
              {t.kind === "git" && (
                <GitPanel inline sessionId={sessionId} onClose={() => onClose(t.id)} />
              )}
              {t.kind === "scratch" && (
                <ScratchEditorPane
                  sessionId={sessionId}
                  title={t.title}
                  content={t.content}
                  onContentChange={(c) => onUpdateScratch(t.id, c)}
                  onDirtyChange={(d) => setTabDirty(t.id, d)}
                  onSaved={(savedPath) => onPromoteScratch(t.id, savedPath)}
                />
              )}
            </div>
          );
        })}
      </div>
      {tabListOpen && tabListPos && (
        <div
          ref={tabListRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed", top: tabListPos.top, right: tabListPos.right,
            minWidth: 260, maxWidth: 460, maxHeight: "60vh", overflowY: "auto",
            zIndex: 90,
            background: "var(--bg-modal)", border: "1px solid var(--border)",
            borderRadius: 4, padding: 4,
            boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
            fontSize: 11, color: "var(--text-body)",
          }}
        >
          {tabs.map(t => {
            const isActive = t.id === activeTabId;
            const isDirty = !!dirtyMap[t.id];
            const sub = t.kind === "file" ? t.path : (t.kind === "scratch" ? "(unsaved)" : "");
            return (
              <div
                key={t.id}
                onClick={() => { onActivate(t.id); setTabListOpen(false); }}
                title={titleFor(t)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "5px 8px", cursor: "pointer", borderRadius: 3,
                  background: isActive ? "var(--bg-hover)" : "transparent",
                  borderLeft: isActive ? "2px solid var(--accent-blue)" : "2px solid transparent",
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ fontSize: 10, opacity: 0.7 }}>{iconFor(t)}</span>
                <span style={{ fontWeight: isActive ? 600 : 400, whiteSpace: "nowrap" }}>
                  {labelFor(t)}{isDirty ? " ●" : ""}
                </span>
                {sub && (
                  <span style={{
                    flex: 1, minWidth: 0,
                    fontSize: 10, color: "var(--text-faint)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono, monospace)",
                  }}>{sub}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {menuTabId && menuPos && (
        <div
          ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed", top: menuPos.top, right: menuPos.right,
            minWidth: 180, zIndex: 90,
            background: "var(--bg-modal)", border: "1px solid var(--border)",
            borderRadius: 4, padding: 4,
            boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
            fontSize: 11, color: "var(--text-body)",
          }}
        >
          {([
            { key: "self", label: "Close" },
            { key: "saved", label: "Close Saved" },
            { key: "others", label: "Close Others" },
            { key: "right", label: "Close to the Right" },
            { key: "all", label: "Close All" },
          ] as const).map(item => (
            <div
              key={item.key}
              onClick={() => {
                if (item.key === "self") {
                  setMenuTabId(null);
                  setMenuPos(null);
                  requestSingleClose(menuTabId);
                } else {
                  requestClose(item.key, menuTabId);
                }
              }}
              style={{ padding: "5px 10px", cursor: "pointer", borderRadius: 3 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              {item.label}
            </div>
          ))}
        </div>
      )}
      {pendingClose && (
        <div
          onClick={() => setPendingClose(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 100,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              minWidth: 380, maxWidth: 560, maxHeight: "70vh",
              background: "var(--bg-modal)", border: "1px solid var(--border)",
              borderRadius: 6, padding: "14px 16px",
              boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
              display: "flex", flexDirection: "column", gap: 10,
              fontSize: 12, color: "var(--text-body)",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--accent-orange, #d59f00)" }}>
              Unsaved changes will be lost
            </div>
            <div style={{ color: "var(--text-secondary)" }}>
              The following {pendingClose.dirtyPaths.length === 1 ? "file has" : "files have"} unsaved edits:
            </div>
            <div style={{
              overflow: "auto", maxHeight: "40vh",
              background: "var(--bg-base)", border: "1px solid var(--border-subtle)",
              borderRadius: 4, padding: "6px 8px",
              fontFamily: "var(--font-mono, monospace)", fontSize: 11,
            }}>
              {pendingClose.dirtyPaths.map((p, i) => (
                <div key={i} style={{ padding: "2px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={p}>{p}</div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                onClick={() => setPendingClose(null)}
                style={{
                  padding: "5px 12px", fontSize: 12, cursor: "pointer",
                  background: "var(--bg-surface)", color: "var(--text-body)",
                  border: "1px solid var(--border)", borderRadius: 3,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => { const ids = pendingClose.ids; setPendingClose(null); onCloseMany(ids); }}
                style={{
                  padding: "5px 12px", fontSize: 12, cursor: "pointer",
                  background: "var(--accent-orange, #d59f00)", color: "#1c2128",
                  border: "1px solid var(--accent-orange, #d59f00)", borderRadius: 3,
                  fontWeight: 600,
                }}
              >
                Discard &amp; Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  username: string;
  onLogout: () => void;
  onSwitchToAdmin?: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

/* ───── New Session Modal ───── */
function getJwtUsername(): string {
  try {
    const token = localStorage.getItem("token") ?? "";
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64));
    return typeof payload.sub === "string" ? payload.sub : "";
  } catch { return ""; }
}

function NewSessionModal({
  workspaceBase,
  loading,
  enabledTools,
  onSubmit,
  onClose,
}: {
  workspaceBase: string;
  loading: boolean;
  enabledTools: string[];
  onSubmit: (p: { project: string; cwd?: string; git_repo_url?: string; tool: "claude" | "cursor" | "codex"; codex_transport?: "tui" | "app_server" }) => void;
  onClose: () => void;
}) {
  // Always read username from the current JWT to stay in sync with actual token
  const username = getJwtUsername();
  const prefix = `${workspaceBase}/${username}/`;

  const [project, setProject] = useState("");
  // Tool defaults to the first enabled one (fall back to claude if list is empty,
  // which shouldn't happen — backend rejects an empty enabled_tools list).
  const allTools = (["claude", "codex", "cursor"] as const).filter((t) => enabledTools.includes(t));
  const initialTool: "claude" | "cursor" | "codex" = (allTools[0] as "claude" | "cursor" | "codex" | undefined) ?? "claude";
  const [tool, setTool] = useState<"claude" | "cursor" | "codex">(initialTool);
  const [codexTransport, setCodexTransport] = useState<"tui" | "app_server">("tui");

  // suffix is the editable part after the fixed prefix
  const [suffix, setSuffix] = useState("");
  const [cwdExists, setCwdExists] = useState(false);
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ARCHIVE_MAX_MB = 100;

  const fullCwd = prefix + suffix;

  const fetchSuggestions = (fullPath: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const dirs = await listDirs(fullPath);
        // Strip the prefix so suggestions show only the relative part
        const rel = dirs.map((d) => d.startsWith(prefix) ? d.slice(prefix.length) : d);
        setSuggestions(rel);
        setActiveIdx(-1);
        // Check if the exact fullPath already exists as a dir
        setCwdExists(dirs.some((d) => d === fullPath || d === fullPath + "/"));
      } catch {
        setSuggestions([]);
        setCwdExists(false);
      }
    }, 200);
  };

  const handleSuffixChange = (val: string) => {
    setSuffix(val);
    fetchSuggestions(prefix + val);
  };

  const selectSuggestion = (rel: string) => {
    const withSlash = rel.endsWith("/") ? rel : rel + "/";
    setSuffix(withSlash);
    setSuggestions([]);
    setActiveIdx(-1);
    fetchSuggestions(prefix + withSlash);
    setGitRepoUrl(""); // reset when changing dir
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      selectSuggestion(suggestions[activeIdx]);
    } else if (e.key === "Escape") {
      setSuggestions([]);
    } else if (e.key === "Tab" && activeIdx >= 0) {
      e.preventDefault();
      selectSuggestion(suggestions[activeIdx]);
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0 }}>New Session</h3>
        <input
          placeholder="Project name *"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          style={inputStyle}
          autoFocus
        />
        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
            Agent
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            {allTools.map((k) => (
              <button
                key={k}
                onClick={() => setTool(k)}
                style={{
                  flex: 1,
                  padding: "5px 8px",
                  fontSize: 12,
                  borderRadius: 5,
                  border: "1px solid " + (tool === k ? "var(--accent-blue)" : "var(--border)"),
                  background: tool === k ? "rgba(88,166,255,0.15)" : "var(--bg-main)",
                  color: tool === k ? "var(--text-body)" : "var(--text-secondary)",
                  fontWeight: tool === k ? 600 : 400,
                  cursor: "pointer",
                  textTransform: "capitalize",
                }}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        {tool === "codex" && (
          <div>
            <label style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
              Transport
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              {(["tui", "app_server"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setCodexTransport(k)}
                  style={{
                    flex: 1,
                    padding: "5px 8px",
                    fontSize: 12,
                    borderRadius: 5,
                    border: "1px solid " + (codexTransport === k ? "var(--accent-blue)" : "var(--border)"),
                    background: codexTransport === k ? "rgba(88,166,255,0.15)" : "var(--bg-main)",
                    color: codexTransport === k ? "var(--text-body)" : "var(--text-secondary)",
                    fontWeight: codexTransport === k ? 600 : 400,
                    cursor: "pointer",
                  }}
                >
                  {k === "tui" ? "TUI (default)" : "App-server (experimental)"}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>
              {codexTransport === "tui"
                ? "Interactive terminal — full chat + paste support."
                : "Programmatic JSON-RPC — chat in the app, live AUQ/approval state. No xterm UI."}
            </div>
          </div>
        )}
        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
            Working Directory
          </label>
          {/* Fixed prefix */}
          <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "monospace", padding: "4px 0 2px", userSelect: "none" }}>
            {prefix}
          </div>
          {/* Editable suffix */}
          <input
            placeholder="subdir (optional)"
            value={suffix}
            onChange={(e) => handleSuffixChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setSuggestions([]), 150)}
            style={inputStyle}
          />
          {suggestions.length > 0 && (
            <div style={{
              background: "var(--bg-hover)",
              border: "1px solid var(--text-faintest)",
              borderRadius: 6,
              marginTop: 2,
              maxHeight: 200,
              overflowY: "auto",
            }}>
              {suggestions.map((rel, i) => (
                <div
                  key={rel}
                  onMouseDown={(e) => { e.preventDefault(); selectSuggestion(rel); }}
                  style={{
                    padding: "6px 10px",
                    fontSize: 12,
                    color: i === activeIdx ? "var(--text-body)" : "var(--text-secondary)",
                    background: i === activeIdx ? "rgba(88,166,255,0.15)" : "transparent",
                    cursor: "pointer",
                    fontFamily: "monospace",
                  }}
                  onMouseEnter={() => setActiveIdx(i)}
                >
                  {rel}
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4, fontFamily: "monospace" }}>
            → {fullCwd}
          </div>
        </div>
        {/* Git clone URL or archive upload — only when directory doesn't exist yet */}
        {!cwdExists && suffix && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
                Git Clone URL <span style={{ color: "var(--text-faint)" }}>(optional)</span>
              </label>
              <input
                placeholder="https://github.com/user/repo.git"
                value={gitRepoUrl}
                onChange={(e) => { setGitRepoUrl(e.target.value); if (e.target.value) setArchiveFile(null); }}
                style={inputStyle}
                disabled={!!archiveFile}
              />
              {gitRepoUrl && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                  Will clone into {fullCwd}
                </div>
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", textAlign: "center" }}>— or —</div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
                Upload Archive <span style={{ color: "var(--text-faint)" }}>(zip / tar.gz / tgz … max {ARCHIVE_MAX_MB}MB)</span>
              </label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  onClick={() => archiveInputRef.current?.click()}
                  disabled={!!gitRepoUrl}
                  style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 11, padding: "4px 10px", flexShrink: 0 }}
                >
                  Choose file
                </button>
                <span style={{ fontSize: 11, color: archiveFile ? (archiveFile.size > ARCHIVE_MAX_MB * 1024 * 1024 ? "#ef4444" : "var(--text-secondary)") : "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                  {archiveFile ? `${archiveFile.name} (${(archiveFile.size / 1024 / 1024).toFixed(1)}MB)` : "No file chosen"}
                </span>
                {archiveFile && (
                  <button onClick={() => setArchiveFile(null)} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>
                )}
                <input
                  ref={archiveInputRef}
                  type="file"
                  accept=".zip,.tar,.tar.gz,.tgz,.tar.bz2,.tbz2,.tar.xz,.txz,.gz,.bz2,.xz"
                  style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0] ?? null; setArchiveFile(f); if (f) setGitRepoUrl(""); }}
                />
              </div>
              {archiveFile && archiveFile.size > ARCHIVE_MAX_MB * 1024 * 1024 && (
                <div style={{ fontSize: 11, color: "#ef4444", marginTop: 3 }}>File exceeds {ARCHIVE_MAX_MB}MB limit</div>
              )}
              {archiveFile && archiveFile.size <= ARCHIVE_MAX_MB * 1024 * 1024 && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                  Will extract into {fullCwd}
                </div>
              )}
            </div>
          </div>
        )}
        {cwdExists && gitRepoUrl && (
          <div style={{ fontSize: 11, color: "#f59e0b" }}>Directory already exists — git clone URL ignored.</div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "#555", color: "var(--text-body)" }}>
            Cancel
          </button>
          <button
            disabled={loading || extracting || !project.trim() || (!!archiveFile && archiveFile.size > ARCHIVE_MAX_MB * 1024 * 1024)}
            onClick={async () => {
              const params = {
                project: project.trim(),
                cwd: suffix.trim() ? fullCwd : undefined,
                git_repo_url: gitRepoUrl.trim() || undefined,
                tool,
                ...(tool === "codex" ? { codex_transport: codexTransport } : {}),
              };
              if (archiveFile && suffix.trim()) {
                setExtracting(true);
                try {
                  await extractToDir(fullCwd, archiveFile);
                  onSubmit({ ...params, git_repo_url: undefined });
                } catch (e) {
                  alert(`Archive extraction failed: ${e}`);
                } finally {
                  setExtracting(false);
                }
              } else {
                onSubmit(params);
              }
            }}
            style={{ background: "var(--accent-blue)", color: "#fff" }}
          >
            {extracting ? "Extracting…" : loading ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───── Browse External Sessions Panel ───── */
function relativeTime(mtime: number): string {
  const diff = Date.now() / 1000 - mtime;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(mtime * 1000).toLocaleDateString();
}

function SessionPreviewModal({
  session,
  tool,
  onClose,
}: {
  session: ExternalSession;
  tool: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<ExternalPreview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getExternalPreview(session.agent_session_id, session.cwd, tool)
      .then(setPreview)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [session.agent_session_id, session.cwd]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1100,
      background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={onClose}>
      <div style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        width: "min(720px, 92vw)",
        height: "min(80vh, 680px)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
        boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {session.title || "No title"}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {session.cwd}
            </div>
          </div>
          {preview && (
            <span style={{ fontSize: 11, color: "var(--text-faint)", flexShrink: 0 }}>
              {preview.total} turns
            </span>
          )}
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 18, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          {loading && <div style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", marginTop: 32 }}>Loading…</div>}
          {!loading && !preview && <div style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", marginTop: 32 }}>Failed to load preview.</div>}
          {preview && (() => {
            const turns = preview.turns;
            const splitAt = preview.truncated_before > 0 ? 100 : turns.length;
            return <>
              {turns.slice(0, splitAt).map((t, i) => (
                <TurnBubble key={`head-${i}`} turn={t} />
              ))}
              {preview.truncated_before > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0" }}>
                  <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                  <span style={{ fontSize: 11, color: "var(--text-faint)", flexShrink: 0, padding: "2px 10px", background: "var(--bg-main)", borderRadius: 12, border: "1px solid var(--border)" }}>
                    … {preview.truncated_before} messages omitted …
                  </span>
                  <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                </div>
              )}
              {preview.truncated_before > 0 && turns.slice(100).map((t, i) => (
                <TurnBubble key={`tail-${i}`} turn={t} />
              ))}
            </>;
          })()}
        </div>
      </div>
    </div>
  );
}

function TurnBubble({ turn }: { turn: { role: string; text: string; ts: number } }) {
  const isUser = turn.role === "user";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
      <div style={{
        maxWidth: "85%",
        padding: "6px 10px",
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.5,
        background: isUser ? "var(--accent-blue)" : "var(--bg-main)",
        color: isUser ? "#fff" : "var(--text-body)",
        border: isUser ? "none" : "1px solid var(--border)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        {turn.text.length > 600 ? turn.text.slice(0, 600) + "…" : turn.text}
      </div>
    </div>
  );
}

function BrowseExternalPanel({
  onLoad,
  onClose,
  enabledTools,
}: {
  onLoad: (tool: "claude" | "cursor" | "codex", session: ExternalSession) => void;
  onClose: () => void;
  enabledTools: string[];
}) {
  const allTabs = (["claude", "codex", "cursor"] as const).filter((t) => enabledTools.includes(t));
  const initialTab: "claude" | "cursor" | "codex" = (allTabs[0] as "claude" | "cursor" | "codex" | undefined) ?? "claude";
  const [tool, setTool] = useState<"claude" | "cursor" | "codex">(initialTab);
  const [groups, setGroups] = useState<ExternalSessionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [viewingSession, setViewingSession] = useState<ExternalSession | null>(null);

  useEffect(() => {
    setLoading(true);
    setGroups([]);
    setSelectedDir(null);
    const fetcher =
      tool === "cursor" ? browseCursorSessions :
      tool === "codex" ? browseCodexSessions :
      browseExternalSessions;
    fetcher()
      .then((data) => {
        setGroups(data);
        if (data.length > 0) setSelectedDir(data[0].dir);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tool]);

  const isEmpty = (s: ExternalSession) => !s.title && s.prompts.length === 0;

  const q = search.toLowerCase();
  const filteredGroups = groups
    .map((g) => {
      const nonEmpty = g.sessions.filter((s) => !isEmpty(s));
      const visible = nonEmpty.filter((s) =>
        !q ||
        g.dir.toLowerCase().includes(q) ||
        (s.title && s.title.toLowerCase().includes(q)) ||
        s.prompts.some((p) => p.toLowerCase().includes(q))
      );
      return { ...g, sessions: visible, emptyCount: g.sessions.length - nonEmpty.length };
    })
    .filter((g) => g.sessions.length > 0 || (!q && g.emptyCount > 0))
    .sort((a, b) => {
      if (a.dir_exists !== b.dir_exists) return a.dir_exists ? -1 : 1;
      return 0; // preserve original mtime order within each group
    });

  const activeGroup = filteredGroups.find((g) => g.dir === selectedDir) ?? filteredGroups[0] ?? null;

  // When search changes, reset selection to first visible group
  useEffect(() => {
    if (filteredGroups.length > 0 && !filteredGroups.find((g) => g.dir === selectedDir)) {
      setSelectedDir(filteredGroups[0].dir);
    }
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={onClose}>
      <div style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        width: "min(900px, 94vw)",
        height: "min(640px, 85vh)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
        boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
      }} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: "11px 16px 10px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, marginRight: 4 }}>Browse External Sessions</span>
          <div style={{ display: "flex", gap: 4 }}>
            {allTabs.map((k) => (
              <button
                key={k}
                onClick={() => setTool(k)}
                style={{
                  padding: "3px 10px",
                  fontSize: 11,
                  borderRadius: 4,
                  border: "1px solid " + (tool === k ? "var(--accent-blue)" : "var(--border)"),
                  background: tool === k ? "rgba(88,166,255,0.15)" : "transparent",
                  color: tool === k ? "var(--text-body)" : "var(--text-secondary)",
                  fontWeight: tool === k ? 600 : 400,
                  cursor: "pointer",
                  textTransform: "capitalize",
                }}
              >
                {k}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <input
            autoFocus
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: "4px 9px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg-main)", color: "var(--text-body)", fontSize: 12, width: 180 }}
          />
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 18, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}>✕</button>
        </div>

        {/* Two-column body */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

          {/* Left: directory list */}
          <div style={{
            width: 240, flexShrink: 0,
            borderRight: "1px solid var(--border)",
            overflowY: "auto",
            background: "var(--bg-sidebar)",
          }}>
            {loading && <div style={{ padding: 16, color: "var(--text-faint)", fontSize: 12 }}>Loading…</div>}
            {!loading && filteredGroups.length === 0 && (
              <div style={{ padding: 16, color: "var(--text-faint)", fontSize: 12 }}>
                {search ? "No matches." : "No sessions found."}
              </div>
            )}
            {!loading && filteredGroups.map((g) => {
              const isSelected = g.dir === activeGroup?.dir;
              const dirName = g.dir.split("/").filter(Boolean).pop() || g.dir;
              return (
                <button
                  key={g.dir}
                  onClick={() => setSelectedDir(g.dir)}
                  style={{
                    width: "100%", textAlign: "left", border: "none",
                    padding: "7px 10px",
                    background: isSelected ? "var(--bg-hover)" : "transparent",
                    borderLeft: isSelected ? "2px solid var(--accent-blue)" : "2px solid transparent",
                    cursor: "pointer",
                    display: "flex", flexDirection: "column", gap: 1,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ fontSize: 12, color: isSelected ? "var(--text-body)" : "var(--text-secondary)", fontWeight: isSelected ? 500 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {dirName}
                    </span>
                    {!g.dir_exists && (
                      <span style={{ fontSize: 9, color: "#f87171", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 3, padding: "0 4px", flexShrink: 0 }}>
                        missing
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {g.dir.length > 36 ? "…" + g.dir.slice(-34) : g.dir}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-faint)" }}>
                    {g.sessions.length} session{g.sessions.length !== 1 ? "s" : ""}  ·  {relativeTime(g.latest_mtime)}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right: session list for selected dir */}
          <div style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
            {!activeGroup && !loading && (
              <div style={{ padding: 32, color: "var(--text-faint)", fontSize: 13, textAlign: "center" }}>
                Select a directory
              </div>
            )}
            {activeGroup && (
              <>
                <div style={{ padding: "8px 14px 6px", borderBottom: "1px solid var(--bg-hover)", display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace", wordBreak: "break-all", flex: 1 }}>{activeGroup.dir}</span>
                    {!activeGroup.dir_exists && (
                      <span style={{ fontSize: 11, color: "#f87171", flexShrink: 0 }}>Directory not found — sessions are read-only</span>
                    )}
                  </div>
                  {activeGroup.emptyCount > 0 && (
                    <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                      {activeGroup.emptyCount} empty session{activeGroup.emptyCount !== 1 ? "s" : ""} hidden
                    </div>
                  )}
                </div>
                {activeGroup.sessions.map((s) => {
                  const canLoad = activeGroup.dir_exists;
                  const isLoadingThis = loadingId === s.agent_session_id;
                  return (
                    <div
                      key={s.agent_session_id}
                      style={{
                        padding: "8px 14px",
                        borderBottom: "1px solid var(--bg-hover)",
                        display: "flex", alignItems: "flex-start", gap: 8,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.title || <span style={{ color: "var(--text-faint)", fontStyle: "italic" }}>No title</span>}
                        </div>
                        {s.prompts.length > 1 && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            <PromptText text={s.prompts[s.prompts.length - 1]} />
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2, display: "flex", gap: 8, alignItems: "center" }}>
                          <span>{relativeTime(s.mtime)}</span>
                          <span
                            title={s.agent_session_id}
                            style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          >
                            {s.agent_session_id.length > 18
                              ? `${s.agent_session_id.slice(0, 8)}…${s.agent_session_id.slice(-5)}`
                              : s.agent_session_id}
                          </span>
                        </div>
                      </div>
                      <button
                        title="Preview conversation"
                        onClick={() => setViewingSession(s)}
                        style={{
                          background: "var(--bg-hover)",
                          color: "var(--text-secondary)",
                          border: "1px solid var(--border)", borderRadius: 5,
                          padding: "4px 10px", fontSize: 12,
                          cursor: "pointer", flexShrink: 0,
                        }}
                      >
                        View
                      </button>
                      <button
                        disabled={!canLoad || isLoadingThis}
                        title={canLoad ? "Load session" : "Directory does not exist"}
                        onClick={async () => {
                          if (!canLoad) return;
                          setLoadingId(s.agent_session_id);
                          try { await onLoad(tool, s); } finally { setLoadingId(null); }
                        }}
                        style={{
                          background: canLoad ? "var(--accent-blue)" : "var(--bg-hover)",
                          color: canLoad ? "#fff" : "var(--text-faint)",
                          border: "none", borderRadius: 5,
                          padding: "4px 12px", fontSize: 12,
                          cursor: canLoad ? "pointer" : "not-allowed",
                          flexShrink: 0,
                          opacity: isLoadingThis ? 0.6 : 1,
                        }}
                      >
                        {isLoadingThis ? "Loading…" : "Load"}
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </div>
      {viewingSession && (
        <SessionPreviewModal session={viewingSession} tool={tool} onClose={() => setViewingSession(null)} />
      )}
    </div>
  );
}

/* ───── Main Page ───── */
export function SessionsPage({ username, onLogout, onSwitchToAdmin, theme, onToggleTheme }: Props) {
  const isAdmin = localStorage.getItem("role") === "admin";
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [active, setActive] = useState<AttachResponse | null>(null);
  const sessionTerminalApi = useSessionTerminalApi(active?.session_id ?? null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // true when the active session was opened in read-only chat mode (terminated)
  const [chatOnlyMode, setChatOnlyMode] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [workspaceBase, setWorkspaceBase] = useState("");
  const [terminalFont, setTerminalFont] = useState<string | undefined>(undefined);
  const [enabledTools, setEnabledTools] = useState<string[]>(["claude", "codex", "cursor"]);
  const [fileEditorSession, setFileEditorSession] = useState<SessionMeta | null>(null);
  // Inline overlay in the conversation column (sits above bottom toolbar, replaces TUI/Chat content)
  const [inlineView, setInlineView] = useState<"git" | "jsonl" | "memory" | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const [showBrowse, setShowBrowse] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showAsciiflow, setShowAsciiflow] = useState(false);
  const { config: userConfig, patch: patchUserConfig } = useUserConfig();
  const layout = userConfig.layout;
  const isChatCentric = layout === "chat-centric";
  const isFileCentric = layout === "file-centric";
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [rightMode, setRightMode] = useState<"terminal" | "bubble">("bubble");
  const [codeOpen, setCodeOpen] = useState(() => localStorage.getItem("codeOpen") === "1");
  const [codeWidth, setCodeWidth] = useState(() => Number(localStorage.getItem("codeW") || 260));
  const [codeFileView, setCodeFileView] = useState<{ path: string; v: number; viewMode: "full" | "diff" | "split"; noDiff?: boolean } | null>(null);
  const [rightPanelFile, setRightPanelFile] = useState<{ path: string; v: number; viewMode?: "full" | "diff" | "split" } | null>(null);
  // keep for hash routing compat
  const setRightPanel = (v: "closed" | "tree" | "code") => {
    if (v === "closed") { setCodeOpen(false); localStorage.setItem("codeOpen", "0"); }
    else { setCodeOpen(true); localStorage.setItem("codeOpen", "1"); }
  };
  const tuiScrollToBottomRef = useRef<(() => void) | null>(null);
  const convRefreshRef = useRef<(() => void) | null>(null);
  const [tuiHint, setTuiHint] = useState<string | null>(null);
  const [tuiAuqData, setTuiAuqData] = useState<TuiAuqData | null>(null);
  const [tuiApproveData, setTuiApproveData] = useState<TuiApproveData | null>(null);
  const [tuiPlanData, setTuiPlanData] = useState<TuiPlanData | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactingProgress, setCompactingProgress] = useState<string | null>(null);
  // Which session the above tui* states belong to. Used to gate the values at
  // render time so a remounting ConversationPane never observes data fetched
  // for a different session (the poll effect can only clear *after* commit).
  const [tuiOwnerSessionId, setTuiOwnerSessionId] = useState<string | null>(null);
  // Per-session attention markers for the session list. Populated by the same
  // /api/sessions/status poll that drives the active session's tui_*. Keyed by
  // session.id → highest-priority pending kind. Plan > AUQ > approve.
  const [attentionMap, setAttentionMap] = useState<Map<string, AttentionKind>>(() => new Map());
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelList, setModelList] = useState<ModelInfo[]>([]);
  const [settingModel, setSettingModel] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const activeSessionMeta = sessions.find((s) => s.id === activeSessionId);
  const isCursorSession = activeSessionMeta?.tool === "cursor";
  // Claude-only features (UsageBar, AUQ history, /goal, TodoWrite) — gate UI on this.
  const isClaudeSession = activeSessionMeta?.tool === "claude";

  // Per-session file/git/jsonl tabs (file-centric layout). Lives at the page
  // level so switching sessions reloads each session's tab set from localStorage.
  const sessionTabs = useSessionTabs(activeSessionId);
  const activeTab = sessionTabs.activeTab;

  // Reset model list when active session tool changes
  const prevToolRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const tool = activeSessionMeta?.tool;
    if (tool !== prevToolRef.current) {
      prevToolRef.current = tool;
      setModelList([]);
    }
  }, [activeSessionMeta?.tool]);

  // Download-cwd exclusion modal state
  const DOWNLOAD_MAX_MB = 100;
  const DOWNLOAD_COMPRESS_MB = 16;
  const [dlModal, setDlModal] = useState<{ sessionId: string; path: string; info: import("../api/sessionApi").DirInfoResponse } | null>(null);
  const [dlLoading, setDlLoading] = useState(false);

  const handleDownloadCwd = async (s: SessionMeta) => {
    setDlLoading(true);
    try {
      const info = await getDirInfo(s.id, "");
      if (info.total_size > DOWNLOAD_MAX_MB * 1024 * 1024) {
        setDlModal({ sessionId: s.id, path: "", info });
      } else {
        const compress = info.total_size > DOWNLOAD_COMPRESS_MB * 1024 * 1024;
        await downloadDirZip(s.id, "", [], compress);
      }
    } catch (e) { alert(String(e)); }
    finally { setDlLoading(false); }
  };

  const handleDownloadChat = async (s: SessionMeta) => {
    try {
      await downloadConversationHtml(s);
    } catch (e) { alert(String(e)); }
  };

  const [shareModalSession, setShareModalSession] = useState<SessionMeta | null>(null);

  // Side-dock section visibility (per-session can be added later; for now global)
  const [dockOpen, setDockOpen] = useState<{ auqs: boolean; tasks: boolean; goals: boolean }>(() => {
    try {
      const raw = localStorage.getItem("dockOpen");
      if (raw) {
        const p = JSON.parse(raw);
        return { auqs: !!p.auqs, tasks: !!p.tasks, goals: !!p.goals };
      }
    } catch { /* ignore */ }
    return { auqs: false, tasks: false, goals: false };
  });
  const setDockSection = (key: "auqs" | "tasks" | "goals", value: boolean) => {
    setDockOpen(() => {
      // Exclusive: opening one section closes all others.
      const next = value
        ? { auqs: false, tasks: false, goals: false, [key]: true }
        : { auqs: false, tasks: false, goals: false };
      try { localStorage.setItem("dockOpen", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const anyDockOpen = dockOpen.auqs || dockOpen.tasks || dockOpen.goals;
  // Goals + tasks polled at page level so bottom buttons can reflect active state
  // even when the dock section is collapsed or hidden.
  const [dockTodos, setDockTodos] = useState<TodoItem[]>([]);
  const [dockTodoHistory, setDockTodoHistory] = useState<TodoPlan[]>([]);
  const [dockActiveGoal, setDockActiveGoal] = useState<Goal | null>(null);
  const [dockGoalHistory, setDockGoalHistory] = useState<Goal[]>([]);
  // Active-only combined fetch for the always-visible toolbar buttons — one
  // request, no history payload. This is the high-frequency (5s) poll.
  const refreshStatusBar = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const data = await getStatusBar(activeSessionId);
      setDockTodos(data.todos_active);
      setDockActiveGoal(data.goal_active);
    } catch { /* ignore */ }
  }, [activeSessionId]);
  // Full todos (active + history). Used after an in-dock edit and while the
  // Tasks section is open; also refreshes the active state.
  const refreshDockTodos = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const data = await listSessionTodos(activeSessionId);
      setDockTodos(data.active);
      setDockTodoHistory(data.history);
    } catch { /* ignore */ }
  }, [activeSessionId]);
  // Full goals (active + history). Used while the Goals section is open.
  const refreshDockGoals = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const data = await listGoals(activeSessionId);
      setDockActiveGoal(data.active);
      setDockGoalHistory(data.history);
    } catch { /* ignore */ }
  }, [activeSessionId]);
  // Always-on poll: active todos/goal for the toolbar. History is deferred to
  // the dock-open effect below so this hot path never ships big history arrays.
  useEffect(() => {
    if (!activeSessionId || !isClaudeSession) {
      setDockTodos([]); setDockTodoHistory([]); setDockActiveGoal(null); setDockGoalHistory([]);
      return;
    }
    refreshStatusBar();
    const id = setInterval(refreshStatusBar, 5000);
    return () => clearInterval(id);
  }, [activeSessionId, isClaudeSession, refreshStatusBar]);
  // History is only rendered inside the dock, so fetch + refresh it only while
  // the Tasks/Goals section is open. The toolbar never needs history.
  useEffect(() => {
    if (!activeSessionId || !isClaudeSession) return;
    if (!dockOpen.tasks && !dockOpen.goals) return;
    const tick = () => {
      if (dockOpen.tasks) refreshDockTodos();
      if (dockOpen.goals) refreshDockGoals();
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [activeSessionId, isClaudeSession, dockOpen.tasks, dockOpen.goals, refreshDockTodos, refreshDockGoals]);

  const { width: winW, height: winH } = useWindowSize();

  /* resizable divider */
  const [leftWidth, setLeftWidth] = useState(
    () => parseInt(localStorage.getItem("splitW") || String(Math.round(window.innerWidth * 0.25)), 10)
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "1"
  );
  const dragging = useRef(false);
  const codeDragging = useRef(false);
  // While any column-resize drag is active, render a full-window transparent
  // overlay above all <iframe>s. Iframes are separate browsing contexts that
  // capture mouse events when the cursor crosses them, freezing the parent's
  // mousemove handler — visible as drag "sticking" over HTML / PDF previews.
  const [resizeDragActive, setResizeDragActive] = useState(false);

  const searchRef2 = useRef(search);
  searchRef2.current = search;

  const refresh = useCallback(async (q?: string) => {
    try {
      const res = await listSessions(q || undefined);
      // Merge in-place: preserve existing order, update data, add new at top
      setSessions((prev) => {
        const nextById = new Map(res.items.map((s) => [s.id, s]));
        const prevIds = new Set(prev.map((s) => s.id));
        // Update existing sessions in their current positions, drop disappeared ones
        const updated = prev.filter((s) => nextById.has(s.id)).map((s) => nextById.get(s.id)!);
        // New sessions not seen before go to the front
        const added = res.items.filter((s) => !prevIds.has(s.id));
        const merged = [...added, ...updated];
        // Keep active sessions (running/detached) before inactive ones; stable within each group
        const isActive = (s: SessionMeta) => s.status === "running" || s.status === "detached";
        return [...merged.filter(isActive), ...merged.filter((s) => !isActive(s))];
      });
    } catch {
      /* ignore */
    }
  }, []);

  // Fetch workspace config once on mount
  useEffect(() => {
    getConfig().then((c) => { setWorkspaceBase(c.workspace); setTerminalFont(c.terminal_font || undefined); setEnabledTools(c.enabled_tools); }).catch(() => {});
  }, []);

  // ── Hash-based session routing ──────────────────────────────────────────────
  // On mount: if URL has #/s/{id}, open that session directly
  useEffect(() => {
    const m = window.location.hash.match(/^#\/s\/(.+)/);
    if (!m) return;
    const sid = m[1];
    getSession(sid).then(async (s) => {
      // Only open the code panel if user hasn't explicitly closed it
      const shouldOpenCode = localStorage.getItem("codeOpen") !== "0";
      if (s.status === "running" || s.status === "detached") {
        try {
          const res = await attachSession(sid);
          setActive(res);
          setActiveSessionId(sid);
          setChatOnlyMode(false);
          setRightMode("bubble");
          if (shouldOpenCode) setRightPanel("tree");
        } catch {
          setActive({ session_id: sid, ws_url: "", ws_token: "" } as AttachResponse);
          setActiveSessionId(sid);
          setChatOnlyMode(true);
        }
      } else {
        setActive({ session_id: sid, ws_url: "", ws_token: "" } as AttachResponse);
        setActiveSessionId(sid);
        setChatOnlyMode(true);
        setRightMode("bubble");
        if (shouldOpenCode) setRightPanel("tree");
      }
    }).catch(() => {
      history.replaceState(null, "", window.location.pathname);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep URL hash in sync with active session
  useEffect(() => {
    if (activeSessionId) {
      history.replaceState(null, "", `#/s/${activeSessionId}`);
    } else {
      history.replaceState(null, "", window.location.pathname);
    }
  }, [activeSessionId]);

  // Poll every 5s, pause when tab hidden
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      // Idempotent: a second "visible" event (some browsers pair visibilitychange
      // with focus/pageshow) would otherwise overwrite `id` and orphan the old
      // interval, stacking 5s list-polls that never get cleared until reload.
      if (id !== null) clearInterval(id);
      refresh(searchRef2.current);
      id = setInterval(() => refresh(searchRef2.current), 5000);
    };
    const stop = () => { if (id !== null) { clearInterval(id); id = null; } };
    const onVis = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh]);

  // Poll hint status for active session (triggers JSONL refresh when AUQ/approval appears)
  useEffect(() => {
    // Clear stale per-session TUI state synchronously on session switch so the
    // remounted ConversationPane doesn't observe the previous session's AUQ /
    // approval / hint before the first poll for the new session returns.
    setTuiAuqData(null);
    setTuiApproveData(null);
    setTuiPlanData(null);
    setTuiHint(null);
    setIsCompacting(false);
    setCompactingProgress(null);

    let cancelled = false;
    const poll = async () => {
      try {
        // Active tier only: attention + live TUI hints exist solely for
        // RUNNING/DETACHED sessions, so this 3s poll skips terminated/stopped
        // ones entirely. Non-active sessions are covered by the 5s list poll.
        const res = await listSessionsStatus("active");
        if (cancelled) return;
        // Build attention map across ALL sessions (not just active) so the
        // session list can flag pending work even when nothing is attached.
        // Priority: plan > auq > approve (most user-blocking wins). Only
        // remembers ids with something pending — entries drop when cleared
        // upstream, so stale markers can't accumulate.
        const nextAttention = new Map<string, AttentionKind>();
        for (const item of res.items) {
          let kind: AttentionKind | null = null;
          if (item.tui_plan_pending) kind = "plan";
          else if (item.tui_auq_data) kind = "auq";
          else if (item.tui_approve_data) kind = "approve";
          if (kind) nextAttention.set(item.id, kind);
        }
        setAttentionMap((prev) => {
          if (prev.size === nextAttention.size) {
            let same = true;
            for (const [k, v] of nextAttention) {
              if (prev.get(k) !== v) { same = false; break; }
            }
            if (same) return prev;
          }
          return nextAttention;
        });

        if (!activeSessionId) return;
        const st = res.items.find((s) => s.id === activeSessionId);
        if (st) {
          setTuiHint((prev) => {
            const next = st.tui_hint ?? null;
            if (next !== prev && next && !prev) convRefreshRef.current?.();
            return next;
          });
          setTuiAuqData(st.tui_auq_data ?? null);
          setTuiApproveData(st.tui_approve_data ?? null);
          setTuiPlanData(st.tui_plan_data ?? null);
          setIsCompacting(!!st.is_compacting);
          setCompactingProgress(st.compacting_progress ?? null);
          setTuiOwnerSessionId(activeSessionId);
        } else {
          setTuiHint(null);
          setTuiAuqData(null);
          setTuiApproveData(null);
          setTuiPlanData(null);
          setIsCompacting(false);
          setCompactingProgress(null);
          setTuiOwnerSessionId(activeSessionId);
        }
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // Debounced search: send query to backend
  useEffect(() => {
    setPage(0);
    const timer = setTimeout(() => refresh(search), 300);
    return () => clearTimeout(timer);
  }, [search, refresh]);

  const isActiveSession = (s: SessionMeta) => s.status === "running" || s.status === "detached";
  const toolFilteredSessions = sessions.filter((s) => enabledTools.includes(s.tool));
  const visibleSessions = showAllSessions ? toolFilteredSessions : toolFilteredSessions.filter(isActiveSession);
  const totalPages = Math.max(1, Math.ceil(visibleSessions.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = visibleSessions.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE
  );

  /* drag handlers */
  const startDrag = useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizeDragActive(true);
  }, []);

  const startCodeDrag = useCallback(() => {
    codeDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizeDragActive(true);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const w = Math.max(220, Math.min(e.clientX, window.innerWidth * 0.5));
      setLeftWidth(w);
    };
    const onUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setResizeDragActive(false);
        localStorage.setItem("splitW", String(leftWidth));
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      const x = e.touches[0].clientX;
      const w = Math.max(120, Math.min(x, window.innerWidth * 0.5));
      setLeftWidth(w);
    };
    const onTouchEnd = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.userSelect = "";
        setResizeDragActive(false);
        localStorage.setItem("splitW", String(leftWidth));
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [leftWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!codeDragging.current) return;
      let w: number;
      if (isChatCentric) {
        // Chat-centric: file panel is on the RIGHT — width grows as mouse moves left
        w = Math.max(200, Math.min(window.innerWidth - e.clientX, window.innerWidth * 0.5));
      } else if (isFileCentric) {
        // File-centric: tree is the second column (after sidebar). Left edge =
        // sidebar (0 or leftWidth+5 resize bar). No toggle-strip in file-centric.
        const leftEdge = sidebarCollapsed ? 0 : leftWidth + 5;
        w = Math.max(180, Math.min(e.clientX - leftEdge, window.innerWidth * 0.4));
      } else {
        // Classic: file panel left edge = sidebar (0 or leftWidth) + toggle-strip (16) + resize-bar (0 or 5, only when sidebar is open)
        const leftEdge = sidebarCollapsed ? 16 : leftWidth + 21;
        w = Math.max(200, Math.min(e.clientX - leftEdge, window.innerWidth * 0.5));
      }
      if (isFileCentric) {
        patchUserConfig({ fileCentricTreeWidth: w });
      } else {
        setCodeWidth(w);
      }
    };
    const onUp = () => {
      if (codeDragging.current) {
        codeDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setResizeDragActive(false);
        if (!isFileCentric) localStorage.setItem("codeW", String(codeWidth));
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [leftWidth, codeWidth, sidebarCollapsed, isChatCentric, isFileCentric, patchUserConfig]);

  // File-centric: column drag between viewer (flex) and chat (fixed width).
  // Bar sits at chat's left edge; dragging right shrinks chat, dragging left grows it.
  const fcChatDragging = useRef(false);
  const startFcChatDrag = useCallback(() => {
    fcChatDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizeDragActive(true);
  }, []);
  useEffect(() => {
    if (!isFileCentric) return;
    const onMove = (e: MouseEvent) => {
      if (!fcChatDragging.current) return;
      // Zone width = window right edge − mouse X (zone is right-flush).
      // Clamp so viewer never drops below 240 px.
      const minZone = 320;
      const minViewer = 240;
      const sidebar = sidebarCollapsed ? 0 : leftWidth + 5;
      const tree = userConfig.fileCentricTreeWidth + 5;
      const maxZone = Math.max(minZone, window.innerWidth - sidebar - tree - minViewer);
      const w = Math.max(minZone, Math.min(window.innerWidth - e.clientX, maxZone));
      patchUserConfig({ fileCentricChatWidth: w });
    };
    const onUp = () => {
      if (fcChatDragging.current) {
        fcChatDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setResizeDragActive(false);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isFileCentric, sidebarCollapsed, leftWidth, userConfig.fileCentricTreeWidth, patchUserConfig]);

  // Drag bar between chat and SideDock — only active when the user is actually dragging.
  // Live ref of "any dock section open" so the chat-drag clamp can read it without
  // re-binding listeners every time dockOpen flips.
  const sideDockOpenRef = useRef(false);
  useEffect(() => { sideDockOpenRef.current = anyDockOpen; }, [anyDockOpen]);
  const sideDockDragging = useRef(false);
  // Total (chat + dock) width captured at the moment the user starts dragging.
  // Holding this constant in file-centric mode keeps the viewer width unchanged.
  const sideDockDragTotal = useRef(0);
  const startSideDockDrag = useCallback(() => {
    sideDockDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizeDragActive(true);
  }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sideDockDragging.current) return;
      const minDock = 240;
      const minChat = 320;
      if (isFileCentric) {
        // Dock is inside the zone — only sideDockWidth changes.
        // InnerCol (flex:1) auto-absorbs the leftover; zone width is unchanged.
        const maxDock = Math.max(minDock, userConfig.fileCentricChatWidth - 5 - minChat);
        const w = Math.max(minDock, Math.min(window.innerWidth - e.clientX, maxDock));
        patchUserConfig({ sideDockWidth: w });
      } else {
        const maxDock = Math.max(minDock, Math.floor(window.innerWidth * 0.6));
        const w = Math.max(minDock, Math.min(window.innerWidth - e.clientX, maxDock));
        patchUserConfig({ sideDockWidth: w });
      }
    };
    const onUp = () => {
      if (sideDockDragging.current) {
        sideDockDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setResizeDragActive(false);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isFileCentric, userConfig.fileCentricChatWidth, patchUserConfig]);

  useEffect(() => {
    if (!showModelPicker) return;
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModelPicker]);

  /* actions */
  const handleCreate = async (body: {
    project: string;
    cwd?: string;
    git_repo_url?: string;
    tool: "claude" | "cursor" | "codex";
    codex_transport?: "tui" | "app_server";
  }) => {
    setLoading(true);
    try {
      const s = await createSession(body);
      setShowModal(false);
      await refresh();
      const res = await attachSession(s.id);
      setActive(res);
      setActiveSessionId(s.id);
    } catch (e) {
      alert(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleAttach = async (id: string) => {
    try {
      const res = await attachSession(id);
      setActive(res);
      setActiveSessionId(id);
      setChatOnlyMode(false);
      setRightMode("bubble");
      setRightPanel("tree");
      setCodeFileView(null);
      refresh(searchRef2.current);
    } catch (e) {
      alert(String(e));
    }
  };

  // Sessions (other than the one currently open) that need user interaction —
  // feeds the top-right notifier so pending work is visible with the sidebar
  // collapsed. Reuses the existing attentionMap; adds no polling.
  const attentionItems = useMemo<AttentionItem[]>(() => {
    const out: AttentionItem[] = [];
    for (const [id, kind] of attentionMap) {
      if (id === activeSessionId) continue;
      const s = sessions.find((x) => x.id === id);
      out.push({ id, kind, name: s ? (s.name || s.project) : id });
    }
    return out;
  }, [attentionMap, activeSessionId, sessions]);

  const handleViewChat = (id: string) => {
    setActive({ session_id: id, ws_url: "", ws_token: "" } as AttachResponse);
    setActiveSessionId(id);
    setChatOnlyMode(true);
    setRightMode("bubble");
    setRightPanel("tree");
    setCodeFileView(null);
  };

  const handleTerminate = async (id: string) => {
    if (!confirm("Terminate this session?")) return;
    try {
      await terminateSession(id);
      if (activeSessionId === id) {
        setActive(null);
        setActiveSessionId(null);
      }
      await refresh();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to permanently delete this session? This action cannot be undone.")) return;
    try {
      await deleteSession(id);
      if (activeSessionId === id) {
        setActive(null);
        setActiveSessionId(null);
      }
      await refresh();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleResume = async (s: SessionMeta) => {
    setLoading(true);
    try {
      await resumeSession(s.id);
      await refresh();
      const res = await attachSession(s.id);
      setActive(res);
      setActiveSessionId(s.id);
      setChatOnlyMode(false);
    } catch (e) {
      alert(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleLoadExternal = async (ext: ExternalSession) => {
    const dirName = ext.cwd.split("/").filter(Boolean).pop() || ext.cwd;
    const newSession = await createSession({
      project: dirName,
      cwd: ext.cwd,
      resume_session_id: ext.agent_session_id,
    });
    await refresh();
    const res = await attachSession(newSession.id);
    setActive(res);
    setActiveSessionId(newSession.id);
    setChatOnlyMode(false);
    setShowBrowse(false);
  };

  const handleLoadCursor = async (ext: ExternalSession) => {
    const dirName = ext.cwd.split("/").filter(Boolean).pop() || ext.cwd;
    const newSession = await createSession({
      project: dirName,
      cwd: ext.cwd,
      resume_session_id: ext.agent_session_id,
      tool: "cursor",
    });
    await refresh();
    const res = await attachSession(newSession.id);
    setActive(res);
    setActiveSessionId(newSession.id);
    setChatOnlyMode(false);
    setShowBrowse(false);
  };

  const handleLoadCodex = async (ext: ExternalSession) => {
    const dirName = ext.cwd.split("/").filter(Boolean).pop() || ext.cwd;
    const newSession = await createSession({
      project: dirName,
      cwd: ext.cwd,
      resume_session_id: ext.agent_session_id,
      tool: "codex",
    });
    await refresh();
    const res = await attachSession(newSession.id);
    setActive(res);
    setActiveSessionId(newSession.id);
    setChatOnlyMode(false);
    setShowBrowse(false);
  };

  const handleRestart = async () => {
    if (!window.confirm("Restart server? All current connections will be disconnected.")) return;
    setRestarting(true);
    try {
      await restartServer();
    } catch {
      // Server may disconnect before responding — that's expected
    }
    // Poll until the server comes back
    const poll = setInterval(async () => {
      try {
        const r = await fetch(apiPath("/health"));
        if (r.ok) { clearInterval(poll); setRestarting(false); }
      } catch {}
    }, 1500);
    setTimeout(() => { clearInterval(poll); setRestarting(false); }, 30000);
  };

  return (
    <div style={{ display: "flex", position: "fixed", top: 0, left: 0, width: winW, height: winH, overflow: "hidden" }}>
      {resizeDragActive && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 99999,
            cursor: "col-resize", background: "transparent",
          }}
        />
      )}
      {/* ── Left: Session list ── */}
      <div
        style={{
          width: sidebarCollapsed ? 0 : leftWidth,
          minWidth: sidebarCollapsed ? 0 : 220,
          maxWidth: "50vw",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-sidebar)",
          overflow: "hidden",
          minHeight: 0,
          transition: "width 0.18s ease",
          order: 0,
        }}
      >
        {/* header — New / Load / Admin only */}
        {(() => {
          const compact = leftWidth < 260;
          return (
            <div
              style={{
                padding: "8px 10px",
                borderBottom: "1px solid var(--bg-hover)",
                display: "flex",
                alignItems: "center",
                flexShrink: 0,
                gap: 4,
              }}
            >
              <button
                onClick={() => setShowModal(true)}
                title="New session"
                style={{ background: "var(--accent-blue)", color: "#fff", fontSize: compact ? 14 : 12, padding: compact ? "3px 7px" : "4px 12px", lineHeight: 1 }}
              >
                {compact ? "＋" : "+ New"}
              </button>
              <button
                onClick={() => setShowBrowse(true)}
                title="Browse external Claude sessions"
                style={{ background: "#1a3a2a", color: "#4ade80", border: "1px solid #166534", borderRadius: 5, fontSize: compact ? 14 : 11, padding: compact ? "3px 7px" : "4px 8px", lineHeight: 1, cursor: "pointer" }}
              >
                {compact ? "⬇" : "Load"}
              </button>
              {onSwitchToAdmin && (
                <button
                  onClick={onSwitchToAdmin}
                  title="Admin panel"
                  style={{ background: "#1e3a5f", color: "var(--accent-blue)", fontSize: compact ? 14 : 11, padding: compact ? "3px 7px" : "4px 8px", border: "1px solid #1e4a7f", borderRadius: 4, lineHeight: 1 }}
                >
                  {compact ? "⚙" : "Admin"}
                </button>
              )}
              <button
                onClick={() => setShowConfig(true)}
                title="User Config (layout, theme, terminal font)"
                style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: compact ? 14 : 11, padding: compact ? "3px 7px" : "4px 8px", border: "1px solid var(--border)", borderRadius: 4, lineHeight: 1 }}
              >
                {compact ? "⚙" : "⚙ Config"}
              </button>
              <button
                onClick={() => setShowAsciiflow(true)}
                title="ASCII diagram editor (asciiflow.com)"
                style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: compact ? 14 : 11, padding: compact ? "3px 7px" : "4px 8px", border: "1px solid var(--border)", borderRadius: 4, lineHeight: 1 }}
              >
                {compact ? "▦" : "▦ ASCII"}
              </button>
            </div>
          );
        })()}

        {/* search + active filter */}
        <div style={{ padding: "8px 10px 4px", flexShrink: 0, display: "flex", flexDirection: "column", gap: 5 }}>
          <input
            placeholder="Search sessions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...inputStyle, width: "100%", padding: "7px 10px" }}
          />
          <button
            onClick={() => { setShowAllSessions((v) => !v); setPage(0); }}
            style={{
              width: "100%", padding: "4px 8px", borderRadius: 5, fontSize: 11,
              background: showAllSessions ? "var(--bg-hover)" : "rgba(88,166,255,0.1)",
              border: `1px solid ${showAllSessions ? "var(--border)" : "rgba(88,166,255,0.3)"}`,
              color: showAllSessions ? "var(--text-muted)" : "var(--accent-blue)",
              cursor: "pointer", textAlign: "left",
            }}
          >
            {showAllSessions ? "Showing all sessions" : "Active sessions only"}
          </button>
        </div>

        {/* session list */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            // Reserve scrollbar width even when the list fits without
            // scrolling, so toggling Active/All doesn't shift card widths
            // by the scrollbar's ~15px (caused subtle reflow jitter).
            // The card-collapse bug itself is fixed in SessionCard by
            // using overflow:clip instead of overflow:hidden.
            scrollbarGutter: "stable",
            minHeight: 0,
            padding: "6px 10px",
            display: "grid",
            // min(100%, 260px) caps the column at the container's own width,
            // so when the side-panel is narrower than 260px the card scales
            // down with it instead of overflowing and getting clipped by
            // overflowX: hidden (which was hiding the right-side action buttons).
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))",
            gap: 8,
            alignContent: "start",
          }}
        >
          {pageItems.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              isActive={activeSessionId === s.id}
              attentionKind={attentionMap.get(s.id) ?? null}
              onAttach={() => handleAttach(s.id)}
              onViewChat={() => handleViewChat(s.id)}
              onTerminate={() => handleTerminate(s.id)}
              onResume={() => handleResume(s)}
              onDelete={() => handleDelete(s.id)}
              onTaskChange={() => refresh(searchRef2.current)}
              onRename={() => refresh(searchRef2.current)}
              loading={loading}
            />
          ))}
          {visibleSessions.length === 0 && (
            <p
              style={{
                color: "var(--text-faint)",
                fontSize: 13,
                textAlign: "center",
                marginTop: 40,
              }}
            >
              {search ? "No matching sessions." : !showAllSessions ? "No active sessions." : "No sessions yet."}
            </p>
          )}
        </div>

        {/* pagination */}
        {totalPages > 1 && (
          <div
            style={{
              padding: "6px 12px",
              borderTop: "1px solid var(--bg-hover)",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--text-secondary)",
              flexShrink: 0,
            }}
          >
            <PgBtn
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              label="Prev"
            />
            <span>
              {safePage + 1}/{totalPages}
            </span>
            <PgBtn
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              label="Next"
            />
          </div>
        )}

        {/* bottom footer — user info, theme, logout */}
        {(() => {
          const compact = leftWidth < 260;
          return (
            <div style={{
              borderTop: "1px solid var(--bg-hover)", flexShrink: 0,
              padding: "6px 10px", display: "flex", alignItems: "center", gap: 4,
            }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {compact ? "" : username}
              </span>
              {isAdmin && (
                <button
                  onClick={handleRestart}
                  disabled={restarting}
                  title="Restart server"
                  style={{
                    background: restarting ? "var(--bg-hover)" : "#7c3aed",
                    color: restarting ? "var(--text-muted)" : "#e9d5ff",
                    fontSize: compact ? 14 : 11,
                    padding: compact ? "3px 7px" : "4px 8px",
                    cursor: restarting ? "not-allowed" : "pointer",
                    lineHeight: 1,
                  }}
                >
                  {compact ? "⟳" : (restarting ? "Restarting…" : "⟳ Restart")}
                </button>
              )}
              <button
                onClick={onToggleTheme}
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                style={{
                  background: "none", border: "1px solid var(--border)", borderRadius: 6,
                  padding: "3px 7px", cursor: "pointer", fontSize: 13,
                  color: "var(--text-muted)", display: "flex", alignItems: "center",
                }}
              >
                {theme === "dark" ? "☀️" : "🌙"}
              </button>
              <button
                onClick={onLogout}
                title="Logout"
                style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: compact ? 14 : 11, padding: compact ? "3px 7px" : "4px 8px", lineHeight: 1 }}
              >
                {compact ? <span style={{ display: "inline-block", transform: "rotate(-90deg)", lineHeight: 1 }}>⏻</span> : "Logout"}
              </button>
            </div>
          );
        })()}
      </div>

      {/* ── Sidebar collapse toggle strip ── */}
      <div
        onClick={() => {
          const next = !sidebarCollapsed;
          setSidebarCollapsed(next);
          localStorage.setItem("sidebarCollapsed", next ? "1" : "0");
        }}
        title={sidebarCollapsed ? "Show session list" : "Hide session list"}
        style={{
          width: 16, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
          background: "var(--bg-hover)", cursor: "pointer", fontSize: 9,
          color: "var(--text-faint)", userSelect: "none",
          borderRight: sidebarCollapsed ? "1px solid var(--border)" : "none",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-surface)"; e.currentTarget.style.color = "var(--text-secondary)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-faint)"; }}
      >
        {sidebarCollapsed ? "›" : "‹"}
      </div>

      {/* ── Resize drag handle (hidden when collapsed) ── */}
      {!sidebarCollapsed && (
        <div
          onMouseDown={startDrag}
          onTouchStart={startDrag}
          style={{
            width: 5,
            cursor: "col-resize",
            background: "var(--bg-hover)",
            flexShrink: 0,
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = "var(--border-strong)")
          }
          onMouseLeave={(e) => {
            if (!dragging.current)
              e.currentTarget.style.background = "var(--bg-hover)";
          }}
        />
      )}

      {/* ── Middle: Code panel — tree only ── */}
      {active && activeSessionMeta && (codeOpen || isFileCentric) && (
        <>
          <div style={{
            width: isFileCentric ? userConfig.fileCentricTreeWidth : codeWidth,
            flexShrink: 0, minWidth: 180,
            display: "flex", flexDirection: "column", overflow: "hidden",
            borderRight: "1px solid var(--border)",
            order: isChatCentric ? 5 : 0,
          }}>
            <CodePane
              key={active.session_id}
              sessionId={active.session_id}
              onFileSelect={(path, vm) => {
                if (isFileCentric) {
                  sessionTabs.openFileTab(path, vm, vm === "full");
                } else {
                  setCodeFileView({ path, v: Date.now(), viewMode: vm, noDiff: vm === "full" });
                  setInlineView(null);
                }
              }}
              selectedPathExternal={
                isFileCentric
                  ? (activeTab?.kind === "file" ? activeTab.path : null)
                  : (codeFileView?.path ?? null)
              }
              onGitClick={() => {
                if (isFileCentric) {
                  sessionTabs.openGitTab();
                } else if (inlineView === "git") {
                  setInlineView(null);
                } else {
                  setInlineView("git");
                  setCodeFileView(null);
                }
              }}
            />
          </div>
          <div
            onMouseDown={startCodeDrag}
            style={{
              width: 5, cursor: "col-resize", background: "var(--bg-hover)", flexShrink: 0,
              order: isChatCentric ? 4 : 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--border-strong)"; }}
            onMouseLeave={(e) => { if (!codeDragging.current) e.currentTarget.style.background = "var(--bg-hover)"; }}
          />
        </>
      )}

      {/* ── Toggle strip (hidden in file-centric — tree is always visible) ── */}
      {active && activeSessionMeta && !isFileCentric && (
        <div
          onClick={() => {
            if (codeOpen && codeFileView) {
              setCodeFileView(null);
            } else {
              const next = !codeOpen;
              setCodeOpen(next);
              localStorage.setItem("codeOpen", next ? "1" : "0");
              if (!next) setCodeFileView(null);
            }
          }}
          title={codeOpen && codeFileView ? "Back to conversation" : codeOpen ? "Hide Code panel" : "Show Code panel"}
          style={{
            width: 18, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--bg-hover)", cursor: "pointer", fontSize: codeOpen && codeFileView ? 12 : 9,
            color: "var(--text-faint)", borderLeft: codeOpen ? "none" : "1px solid var(--border)",
            borderRight: "1px solid var(--border)",
            userSelect: "none",
            order: isChatCentric ? 3 : 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-surface)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        >
          {codeOpen && codeFileView ? "←" : codeOpen ? "◀" : "▶"}
        </div>
      )}

      {/* ── Right side: viewer column (file-centric only) + chat + bottom bar ── */}
      <div style={{
        flex: "1 1 0%", minWidth: 0,
        minHeight: 0, overflow: "hidden", background: "var(--bg-base)",
        display: "flex", flexDirection: "column",
        order: isChatCentric ? 2 : 0,
      }}>
        {active ? (
          <>
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row", overflow: "hidden" }}>
            {isFileCentric && activeSessionMeta && (
              <>
                <FileCentricViewerColumn
                  sessionId={active.session_id}
                  sessionMeta={activeSessionMeta}
                  tabs={sessionTabs.tabs}
                  activeTabId={sessionTabs.activeId}
                  onActivate={sessionTabs.activate}
                  onClose={sessionTabs.closeTab}
                  onCloseMany={sessionTabs.closeTabs}
                  onCreateScratch={sessionTabs.openScratchTab}
                  onUpdateScratch={sessionTabs.updateScratchContent}
                  onPromoteScratch={sessionTabs.promoteScratchToFile}
                />
                <div
                  onMouseDown={startFcChatDrag}
                  title="Drag to resize chat column"
                  style={{ width: 5, cursor: "col-resize", background: "var(--bg-hover)", flexShrink: 0 }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--border-strong)"; }}
                  onMouseLeave={(e) => { if (!fcChatDragging.current) e.currentTarget.style.background = "var(--bg-hover)"; }}
                />
              </>
            )}
            {/* Chat+Dock zone — fixed width in file-centric so viewer is never affected
                by opening/resizing the side dock. Dock and chat redistribute WITHIN this
                zone; only the bar1 drag (viewer ↔ zone) changes zone width. */}
            <div style={{
              ...(isFileCentric
                ? { width: userConfig.fileCentricChatWidth, flexShrink: 0 }
                : { flex: 1, minWidth: 0 }),
              minHeight: 0, display: "flex", flexDirection: "row", overflow: "clip",
            }}>
            <div style={{ flex: 1, minWidth: isFileCentric ? 320 : 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {(() => {
              const isCodexAppServer =
                activeSessionMeta?.tool === "codex" &&
                activeSessionMeta?.codex_transport === "app_server";
              return (
                <>
                  {!chatOnlyMode && (
                    <div style={{ flex: 1, minHeight: 0, display: !inlineView && !codeFileView && rightMode === "terminal" ? "flex" : "none", flexDirection: "column" }}>
                      {isCodexAppServer ? (
                        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12, padding: 24, textAlign: "center" }}>
                          Codex app-server transport — no terminal. Switch to the chat view to send messages.
                        </div>
                      ) : (
                        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                          <TuiPane
                            key={active.session_id + active.ws_token + (terminalFont || "")}
                            wsUrl={active.ws_url}
                            theme={theme}
                            scrollToBottomRef={tuiScrollToBottomRef}
                            fontFamily={terminalFont}
                            useTmuxScroll={activeSessionMeta?.tool === "codex"}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  <div style={{ flex: 1, minHeight: 0, display: !inlineView && !codeFileView && rightMode === "bubble" ? "flex" : "none", flexDirection: "column" }}>
                    {(() => {
                      // Gate every tui-derived prop on the freshness check: the
                      // value must have been polled for THIS session id, otherwise
                      // we pass nulls. Without this gate a newly-mounted
                      // ConversationPane (key changes on session switch) would
                      // observe the previous session's AUQ for one render and
                      // pin it into its stickyAuq.
                      const fresh = tuiOwnerSessionId === active.session_id;
                      return (
                        <>
                          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                            <ConversationPane
                              key={active.session_id + active.ws_token}
                              sessionId={active.session_id}
                              tool={activeSessionMeta?.tool}
                              codexTransport={activeSessionMeta?.codex_transport}
                              isStreaming={activeSessionMeta?.is_streaming}
                              isCompacting={fresh ? isCompacting : false}
                              compactingProgress={fresh ? compactingProgress : null}
                              chatOnly={chatOnlyMode}
                              isWaitingForAuq={fresh && !!tuiHint?.includes("asking a question")}
                              pendingAuqData={fresh ? tuiAuqData : null}
                              pendingApproveData={fresh ? tuiApproveData : null}
                              pendingPlanData={fresh ? tuiPlanData : null}
                              refreshRef={convRefreshRef}
                            />
                          </div>
                          {isCodexAppServer && !chatOnlyMode && (
                            <CodexChatInput
                              sessionId={active.session_id}
                              onSent={() => convRefreshRef.current?.()}
                            />
                          )}
                        </>
                      );
                    })()}
                  </div>
                </>
              );
            })()}
            {codeFileView && (
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <FileViewerPane
                  key={codeFileView.path + codeFileView.v}
                  sessionId={active.session_id}
                  path={codeFileView.path}
                  viewMode={codeFileView.viewMode}
                  noDiff={codeFileView.noDiff}
                />
              </div>
            )}
            {inlineView === "git" && (
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <GitPanel
                  inline
                  sessionId={active.session_id}
                  onClose={() => setInlineView(null)}
                />
              </div>
            )}
            {inlineView === "jsonl" && activeSessionMeta && (
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <JsonlPreviewModal
                  inline
                  sessionId={active.session_id}
                  sessionTitle={activeSessionMeta.name || activeSessionMeta.project}
                  onClose={() => setInlineView(null)}
                />
              </div>
            )}
            {inlineView === "memory" && activeSessionMeta && (
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <MemoryPanel
                  sessionId={active.session_id}
                  onClose={() => setInlineView(null)}
                />
              </div>
            )}
            </div>
            {/* ↑ close InnerCol column */}
            {activeSessionMeta && anyDockOpen && (
              <div
                onMouseDown={startSideDockDrag}
                title="Drag to resize side dock"
                style={{ width: 5, cursor: "col-resize", background: "var(--bg-hover)", flexShrink: 0 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--border-strong)"; }}
                onMouseLeave={(e) => { if (!sideDockDragging.current) e.currentTarget.style.background = "var(--bg-hover)"; }}
              />
            )}
            {activeSessionMeta && (
              <SessionSideDock
                sessionId={activeSessionMeta.id}
                sessionName={activeSessionMeta.name || activeSessionMeta.project}
                isCursor={!isClaudeSession}
                open={dockOpen}
                onClose={(key) => setDockSection(key, false)}
                todos={dockTodos}
                todoHistory={dockTodoHistory}
                activeGoal={dockActiveGoal}
                goalHistory={dockGoalHistory}
                onTodosChanged={refreshDockTodos}
                width={userConfig.sideDockWidth}
              />
            )}
            </div>
            {/* ↑ close Chat+Dock zone */}
          </div>
          {/* Bottom toolbar — three groups: Functional | Views | Term */}
            <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, padding: "3px 8px", background: "var(--bg-base)", borderTop: "1px solid var(--bg-page)" }}>
              {isClaudeSession && <UsageBar />}
              {/* In file-centric, push the button cluster rightward so it sits below
                  the chat column. The cluster gets a fixed width = chat + dock so
                  its left edge hits chat col's left edge exactly. */}
              {isFileCentric && <div style={{ flex: 1, minWidth: 0 }} />}
              <div style={{
                display: "flex", alignItems: "center", gap: 4,
                ...(isFileCentric ? {
                  width: userConfig.fileCentricChatWidth - 8,
                  justifyContent: "flex-start",
                } : null),
              }}>
              {/* Group 1: Functional — Auqs / Tasks / Goals / Model */}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {activeSessionMeta && isClaudeSession && (
                <button
                  onClick={() => setDockSection("auqs", !dockOpen.auqs)}
                  title="Show AskUserQuestion history for this session"
                  style={{ fontSize: 11, padding: "2px 8px", background: dockOpen.auqs ? "rgba(88,166,255,0.15)" : "var(--bg-hover)", color: "var(--text-faint)", border: "1px solid " + (dockOpen.auqs ? "rgba(88,166,255,0.3)" : "transparent"), borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }}
                >
                  Auqs
                </button>
              )}
              {activeSessionMeta && (() => {
                const total = dockTodos.length;
                const done = dockTodos.filter((t) => t.status === "completed").length;
                const active = dockTodos.filter((t) => t.status === "in_progress").length;
                const isHot = active > 0;
                return (
                  <button
                    onClick={() => setDockSection("tasks", !dockOpen.tasks)}
                    title={isHot ? `${active} in progress` : total > 0 ? `${done}/${total} done` : "Show TODO list"}
                    style={{
                      fontSize: 11, padding: "2px 8px",
                      background: isHot ? "rgba(245,158,11,0.18)" : dockOpen.tasks ? "rgba(88,166,255,0.15)" : "var(--bg-hover)",
                      color: isHot ? "var(--accent-amber)" : total > 0 ? "var(--accent-blue)" : "var(--text-faint)",
                      border: "1px solid " + (isHot ? "rgba(245,158,11,0.45)" : dockOpen.tasks ? "rgba(88,166,255,0.3)" : "transparent"),
                      borderRadius: 4, cursor: "pointer", fontFamily: "inherit",
                      animation: isHot ? "cursor-blink 1.4s ease-in-out infinite" : undefined,
                    }}
                  >
                    Tasks{total > 0 ? ` (${done}/${total})` : ""}
                  </button>
                );
              })()}
              {activeSessionMeta && isClaudeSession && (() => {
                const hasActive = !!dockActiveGoal;
                return (
                  <button
                    onClick={() => setDockSection("goals", !dockOpen.goals)}
                    title={hasActive ? `Active goal: ${dockActiveGoal!.condition.slice(0, 60)}` : "Show /goal history"}
                    style={{
                      fontSize: 11, padding: "2px 8px",
                      background: hasActive ? "rgba(88,166,255,0.18)" : dockOpen.goals ? "rgba(88,166,255,0.15)" : "var(--bg-hover)",
                      color: hasActive ? "var(--accent-blue)" : "var(--text-faint)",
                      border: "1px solid " + (hasActive ? "rgba(88,166,255,0.45)" : dockOpen.goals ? "rgba(88,166,255,0.3)" : "transparent"),
                      borderRadius: 4, cursor: "pointer", fontFamily: "inherit",
                      display: "inline-flex", alignItems: "center", gap: 4,
                    }}
                  >
                    Goals
                    {hasActive && (
                      <span
                        style={{
                          width: 6, height: 6, borderRadius: "50%",
                          background: "var(--accent-blue)",
                          animation: "cursor-blink 1.4s ease-in-out infinite",
                          display: "inline-block",
                        }}
                      />
                    )}
                  </button>
                );
              })()}
              {activeSessionMeta && (
                <div ref={modelPickerRef} style={{ position: "relative" }}>
                  <button
                    onClick={async () => {
                      if (modelList.length === 0) { try { setModelList(await listModels(activeSessionMeta.tool || "claude")); } catch {} }
                      setShowModelPicker(v => !v);
                    }}
                    title="Switch model for this session"
                    style={{ fontSize: 11, padding: "2px 8px", background: showModelPicker ? "rgba(88,166,255,0.15)" : "var(--bg-hover)", color: activeSessionMeta.model ? "var(--accent-blue)" : "var(--text-faint)", border: "1px solid " + (activeSessionMeta.model ? "rgba(88,166,255,0.3)" : "transparent"), borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }}
                  >
                    {settingModel ? "…" : activeSessionMeta.model ? activeSessionMeta.model.replace("claude-", "").replace(/-\d{8}$/, "") : "model"}
                  </button>
                  {showModelPicker && (() => {
                    const allModels = [{ id: null as string | null, name: "Default" }, ...modelList];
                    const cols = allModels.length > 18 ? 3 : allModels.length > 9 ? 2 : 1;
                    const colW = 210;
                    return (
                      <div style={{ position: "absolute", bottom: "calc(100% + 4px)", right: 0, zIndex: 300, border: "1px solid var(--border)", borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.5)", overflow: "hidden", maxHeight: "70vh", display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, ${colW}px)`, gap: 1, background: "var(--border)", overflowY: "auto", minHeight: 0 }}>
                        {allModels.map((m) => {
                          const isCurrent = m.id === null ? !activeSessionMeta.model : activeSessionMeta.model === m.id;
                          return (
                            <div
                              key={m.id ?? "__default__"}
                              onClick={async () => {
                                setShowModelPicker(false);
                                setSettingModel(true);
                                try {
                                  const updated = await setSessionModel(activeSessionMeta.id, m.id);
                                  setSessions(prev => prev.map(p => p.id === updated.id ? updated : p));
                                } catch (e) { alert(String(e)); }
                                finally { setSettingModel(false); }
                              }}
                              onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = "var(--bg-hover)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = isCurrent ? "var(--bg-hover)" : "var(--bg-surface)"; }}
                              style={{ padding: "7px 12px", cursor: "pointer", fontSize: 12, color: isCurrent ? "var(--accent-blue)" : "var(--text-body)", background: isCurrent ? "var(--bg-hover)" : "var(--bg-surface)", display: "flex", justifyContent: "space-between", alignItems: "center", overflow: "hidden" }}
                            >
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                              {isCurrent && <span style={{ color: "var(--accent-blue)", marginLeft: 4, flexShrink: 0 }}>✓</span>}
                            </div>
                          );
                        })}
                      </div>
                      </div>
                    );
                  })()}
                </div>
              )}
              </div>
              {/* Divider */}
              <div style={{ width: 1, height: 16, background: "var(--bg-hover)", margin: "0 4px" }} />
              {/* Group 2: Views — HTML / JSONL / Chat / TUI */}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {activeSessionMeta && (
                <button
                  onClick={() => setShareModalSession(activeSessionMeta)}
                  title="分享对话"
                  style={{ fontSize: 11, padding: "2px 10px", background: "transparent", color: "var(--text-faint)", border: "1px solid transparent", borderRadius: 4 }}
                >
                  🔗 Share
                </button>
              )}
              {activeSessionMeta && (
                <button
                  onClick={() => handleDownloadChat(activeSessionMeta)}
                  title="Export chat as HTML"
                  style={{ fontSize: 11, padding: "2px 10px", background: "transparent", color: "var(--text-faint)", border: "1px solid transparent", borderRadius: 4 }}
                >
                  📥 HTML
                </button>
              )}
              {activeSessionMeta && activeSessionMeta.agent_session_id && (
                <button
                  onClick={() => {
                    if (inlineView === "jsonl") {
                      setInlineView(null);
                    } else {
                      setInlineView("jsonl");
                      setCodeFileView(null);
                    }
                  }}
                  title="Preview conversation JSONL"
                  style={{ fontSize: 11, padding: "2px 10px", background: inlineView === "jsonl" ? "var(--bg-hover)" : "transparent", color: inlineView === "jsonl" ? "var(--text-body)" : "var(--text-faint)", border: "1px solid " + (inlineView === "jsonl" ? "var(--text-faint)" : "transparent"), borderRadius: 4 }}
                >
                  📄 JSONL
                </button>
              )}
              {activeSessionMeta && (
                <button
                  onClick={() => {
                    if (inlineView === "memory") {
                      setInlineView(null);
                    } else {
                      setInlineView("memory");
                      setCodeFileView(null);
                    }
                  }}
                  title="Browse project memory files"
                  style={{ fontSize: 11, padding: "2px 10px", background: inlineView === "memory" ? "var(--bg-hover)" : "transparent", color: inlineView === "memory" ? "var(--text-body)" : "var(--text-faint)", border: "1px solid " + (inlineView === "memory" ? "var(--text-faint)" : "transparent"), borderRadius: 4 }}
                >
                  🧠 Memory
                </button>
              )}
              {(() => {
                const isActive = rightMode === "bubble" && !inlineView && !codeFileView;
                return (
                  <button
                    onClick={() => { setRightMode("bubble"); setInlineView(null); setCodeFileView(null); }}
                    style={{ fontSize: 11, padding: "2px 10px", background: isActive ? "var(--bg-hover)" : "transparent", color: isActive ? "var(--text-body)" : "var(--text-faint)", border: "1px solid " + (isActive ? "var(--text-faint)" : "transparent"), borderRadius: 4 }}
                  >
                    💬 Chat
                  </button>
                );
              })()}
              {!chatOnlyMode && rightMode === "terminal" && (
                <button
                  onClick={() => { tuiScrollToBottomRef.current?.(); }}
                  title="Scroll to bottom"
                  style={{ fontSize: 11, padding: "2px 8px", background: "var(--bg-hover)", color: "var(--text-faint)", border: "1px solid transparent", borderRadius: 4 }}
                >
                  ↓
                </button>
              )}
              {!chatOnlyMode && (() => {
                const isActive = rightMode === "terminal" && !inlineView && !codeFileView;
                return (
                  <button
                    onClick={() => { setRightMode("terminal"); setInlineView(null); setCodeFileView(null); }}
                    style={{ fontSize: 11, padding: "2px 10px", background: isActive ? "var(--bg-hover)" : "transparent", color: isActive ? "var(--text-body)" : "var(--text-faint)", border: "1px solid " + (isActive ? "var(--text-faint)" : "transparent"), borderRadius: 4 }}
                  >
                    TUI
                  </button>
                );
              })()}
              </div>
              {/* Divider */}
              <div style={{ width: 1, height: 16, background: "var(--bg-hover)", margin: "0 4px" }} />
              {/* Group 3: Terminal (and future tmux management) */}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  onClick={() => patchUserConfig({ terminalOpen: !userConfig.terminalOpen })}
                  title={userConfig.terminalOpen ? "Hide terminal" : "Show terminal"}
                  style={{ fontSize: 11, padding: "2px 10px", background: userConfig.terminalOpen ? "var(--bg-hover)" : "transparent", color: userConfig.terminalOpen ? "var(--text-body)" : "var(--text-faint)", border: "1px solid " + (userConfig.terminalOpen ? "var(--text-faint)" : "transparent"), borderRadius: 4 }}
                >
                  &gt;_ Term
                </button>
              </div>
              <FullscreenClock />
              </div>
            </div>
            <EmbeddedTerminalPanel
              instanceKey={active?.session_id ?? null}
              api={sessionTerminalApi}
              cwd={activeSessionMeta?.cwd}
              theme={theme}
              fontFamily={terminalFont}
              open={userConfig.terminalOpen}
              onOpenChange={(o) => patchUserConfig({ terminalOpen: o })}
              height={userConfig.terminalHeight}
              onHeightChange={(h) => patchUserConfig({ terminalHeight: h })}
              resizeFrom="top"
            />
          </>
        ) : (
          <UsageCenter />
        )}
      </div>

      {/* ── New Session Modal ── */}
      {showModal && (
        <NewSessionModal
          workspaceBase={workspaceBase}
          loading={loading}
          enabledTools={enabledTools}
          onSubmit={handleCreate}
          onClose={() => setShowModal(false)}
        />
      )}

      {/* ── File Editor Modal ── */}
      {fileEditorSession && (
        <FileEditorModal
          sessionId={fileEditorSession.id}
          sessionCwd={fileEditorSession.cwd}
          onClose={() => setFileEditorSession(null)}
        />
      )}

      {/* Browse external sessions panel */}
      {showBrowse && (
        <BrowseExternalPanel
          enabledTools={enabledTools}
          onLoad={(t, s) => {
            if (t === "codex") return handleLoadCodex(s);
            if (t === "cursor") return handleLoadCursor(s);
            return handleLoadExternal(s);
          }}
          onClose={() => setShowBrowse(false)}
        />
      )}

      {/* Download exclusion modal */}
      {dlModal && (
        <DownloadExclusionModal
          sessionId={dlModal.sessionId}
          basePath={dlModal.path}
          info={dlModal.info}
          onClose={() => setDlModal(null)}
        />
      )}

      {/* User Config modal */}
      <UserConfigModal
        open={showConfig}
        onClose={() => setShowConfig(false)}
        layout={userConfig.layout}
        onLayoutChange={(s: LayoutScheme) => patchUserConfig({ layout: s })}
        theme={theme}
        onToggleTheme={onToggleTheme}
        terminalFont={terminalFont}
        onTerminalFontApplied={(f) => setTerminalFont(f)}
      />

      {showAsciiflow && <AsciiflowModal onClose={() => setShowAsciiflow(false)} />}

      {shareModalSession && <ShareModal session={shareModalSession} onClose={() => setShareModalSession(null)} />}

      <AttentionNotifier items={attentionItems} onJump={handleAttach} />

      <TextSelectionMenu />

    </div>
  );
}

function PgBtn({
  disabled,
  onClick,
  label,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        background: "var(--bg-hover)",
        color: "var(--text-body)",
        fontSize: 11,
        padding: "3px 8px",
      }}
    >
      {label}
    </button>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle: React.CSSProperties = {
  background: "var(--bg-modal)",
  borderRadius: 12,
  padding: 24,
  width: 420,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const inputStyle: React.CSSProperties = {
  background: "var(--bg-base)",
  border: "1px solid var(--text-faintest)",
  borderRadius: 6,
  padding: "9px 12px",
  color: "var(--text-body)",
  fontSize: 13,
  outline: "none",
  width: "100%",
};
