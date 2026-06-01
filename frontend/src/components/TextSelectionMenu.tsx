// Global menu for selected text. Two trigger modes:
//   1. **Shift + right-click** anywhere outside excluded zones (xterm /
//      CodeMirror / [data-no-context-menu]) — preserves the native context
//      menu for plain right-clicks.
//   2. **Plain right-click** inside a `[data-str-menu-auto]` zone (e.g.
//      FileViewer content) — but only when there is a non-empty selection.
//      With no selection, we let the native context menu fire as usual.
//      Inside an auto zone, the CodeMirror exclusion is overridden so the
//      menu works on selected code too.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_ORDER, STRING_TOOLS, StringTool, ToolCategory } from "../lib/stringTools";
import { copyText } from "./FileEditorModal";

interface MenuState {
  x: number;
  y: number;
  text: string;
}

interface ResultState {
  toolLabel: string;
  output: string;
  error?: string;
}

// Column width (px) sized to the longest label in each category. If you add
// a tool with a longer label, bump the matching number here.
const COL_WIDTH: Record<ToolCategory, number> = {
  Encode: 120,
  Format: 120,
  Case: 130,
  Lines: 120,
  Hash: 120,
  Time: 130,
  Info: 70,
};
const MENU_WIDTH = Object.values(COL_WIDTH).reduce((a, b) => a + b, 0) + 2; // + outer border

function isInExcludedZone(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".xterm")) return true;
  if (target.closest('[class*="cm-"]')) return true;
  if (target.closest("[data-no-context-menu]")) return true;
  return false;
}

function isInAutoZone(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("[data-str-menu-auto]") !== null;
}

export function TextSelectionMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [result, setResult] = useState<ResultState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // ── contextmenu trap (Shift + right-click only) ─────────────────────────────
  // Shift+mousedown is the browser's native "extend selection to click point"
  // gesture. If we let it through, the selection has already been mutated by
  // the time `contextmenu` fires and we'd read the wrong text. So we trap
  // mousedown in capture phase and preventDefault on shift+right — that
  // blocks selection extension only; the contextmenu event still fires.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 2 || !e.shiftKey) return;
      // Skip excluded zones, unless we're inside an auto zone (FileViewer)
      // where CodeMirror normally falls under exclusion but should still
      // honor selection preservation.
      if (isInExcludedZone(e.target) && !isInAutoZone(e.target)) return;
      const sel = window.getSelection();
      if (!sel || sel.toString().length === 0) return;
      e.preventDefault();
    };
    const onCtx = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const sel = window.getSelection();
      const text = sel ? sel.toString() : "";
      const inAuto = isInAutoZone(e.target);

      if (inAuto) {
        // Plain right-click inside auto zone: only override native menu when
        // there's a selection to act on; empty selection → let native fire.
        if (text.length === 0) return;
      } else {
        // Outside auto zone: original Shift+right-click contract.
        if (!e.shiftKey) return;
        if (isInExcludedZone(e.target)) return;
        if (text.length === 0) return;
      }

      e.preventDefault();
      e.stopPropagation();
      const x = Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_WIDTH - 8));
      const y = Math.max(8, Math.min(e.clientY, window.innerHeight - 280));
      setMenu({ x, y, text });
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("contextmenu", onCtx, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("contextmenu", onCtx, true);
    };
  }, []);

  // ── dismiss on outside click / Esc / page scroll / resize ───────────────────
  useEffect(() => {
    if (!menu) return;
    const isInsideMenu = (t: EventTarget | null) =>
      menuRef.current && t instanceof Node && menuRef.current.contains(t);
    const onDown = (e: MouseEvent) => {
      if (isInsideMenu(e.target)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onScroll = (e: Event) => {
      if (isInsideMenu(e.target)) return;
      setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [menu]);

  const runTool = useCallback(async (tool: StringTool, input: string) => {
    setMenu(null);
    try {
      const out = await tool.run(input);
      setResult({ toolLabel: tool.label, output: out });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setResult({ toolLabel: tool.label, output: "", error: msg });
    }
  }, []);

  const grouped = useMemo<Record<ToolCategory, StringTool[]>>(() => {
    const m: Record<string, StringTool[]> = {};
    for (const t of STRING_TOOLS) {
      (m[t.category] ||= []).push(t);
    }
    return m as Record<ToolCategory, StringTool[]>;
  }, []);

  return (
    <>
      {menu && (
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: menu.y,
            left: menu.x,
            width: MENU_WIDTH,
            background: "var(--bg-modal, #1c1f24)",
            border: "1px solid var(--border, #333)",
            borderRadius: 6,
            boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
            zIndex: 9000,
            fontSize: 12,
            color: "var(--text-body)",
            display: "flex",
            alignItems: "stretch",
            userSelect: "none",
            overflow: "hidden",
          }}
        >
          {CATEGORY_ORDER.map((cat, idx) => (
            <div
              key={cat}
              style={{
                width: COL_WIDTH[cat],
                borderLeft: idx === 0 ? "none" : "1px solid var(--bg-hover, #2a2d33)",
                display: "flex",
                flexDirection: "column",
                padding: "4px 0",
              }}
            >
              <div
                style={{
                  padding: "3px 10px 4px",
                  fontSize: 10,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                  borderBottom: "1px solid var(--bg-hover, #2a2d33)",
                  marginBottom: 2,
                }}
              >
                {cat}
              </div>
              {(grouped[cat] || []).map(t => (
                <MenuItem key={t.id} label={t.label} onClick={() => runTool(t, menu.text)} />
              ))}
            </div>
          ))}
        </div>
      )}

      {result && (
        <ResultDialog
          title={result.toolLabel}
          output={result.output}
          error={result.error}
          onClose={() => setResult(null)}
        />
      )}
    </>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        padding: "4px 10px",
        cursor: "pointer",
        background: hover ? "var(--bg-hover)" : "transparent",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {label}
    </div>
  );
}

function ResultDialog({
  title,
  output,
  error,
  onClose,
}: {
  title: string;
  output: string;
  error?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCopy = () => {
    copyText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9100,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--bg-modal, #1c1f24)",
          border: "1px solid var(--border, #333)",
          borderRadius: 8,
          width: "min(720px, 90vw)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--bg-hover)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-body)" }}>
            {title}
          </div>
          <div style={{ flex: 1 }} />
          {!error && (
            <button
              onClick={handleCopy}
              style={{
                background: copied ? "var(--accent-green, #2ea043)" : "var(--bg-hover)",
                color: copied ? "#fff" : "var(--text-body)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                padding: "4px 10px",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              background: "var(--bg-hover)",
              color: "var(--text-body)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: 14,
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            color: error ? "var(--accent-red, #ff6464)" : "var(--text-body)",
          }}
        >
          {error ? error : output}
        </div>
      </div>
    </div>
  );
}
