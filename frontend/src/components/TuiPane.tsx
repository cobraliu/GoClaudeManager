/**
 * TuiPane — lightweight xterm.js terminal for TUI sessions (Claude Code interactive mode).
 *
 * Follows mockClaudeJ's separation pattern:
 *   Effect 1: xterm + FitAddon init (runs once)
 *   Effect 2: WebSocket connection (reruns on wsUrl change)
 *
 * No custom wheel interception — xterm.js handles scroll natively. When Claude Code
 * has mouse tracking enabled (alternate screen TUI), xterm forwards wheel events as
 * mouse escape sequences directly to the application.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import type { Theme } from "../main";
import { WsClient } from "../lib/wsClient";

const TERMINAL_THEME_DARK = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  selectionBackground: "rgba(58, 130, 247, 0.35)",
  selectionForeground: "#ffffff",
  selectionInactiveBackground: "rgba(58, 130, 247, 0.2)",
};

const TERMINAL_THEME_LIGHT = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#0969da",
  selectionBackground: "rgba(9, 105, 218, 0.25)",
  selectionForeground: "#24292f",
  selectionInactiveBackground: "rgba(9, 105, 218, 0.15)",
};

const FONT_FAMILY_DEFAULT =
  '"Ubuntu Sans Mono", "WenQuanYi Micro Hei Mono", "WenQuanYi Zen Hei Mono", monospace';

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  fallbackCopy(text);
  return Promise.resolve();
}

function fallbackCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch { /* ok */ }
  document.body.removeChild(ta);
}

interface Props {
  wsUrl: string;
  theme?: Theme;
  fontFamily?: string;
  scrollToBottomRef?: React.MutableRefObject<(() => void) | null>;
  sendRawRef?: React.MutableRefObject<((data: string) => void) | null>;
  /**
   * When true: take over wheel/touch events and send them to the server as
   * tmux copy-mode scroll commands instead of letting xterm.js forward them
   * to the TUI. Required for TUIs that don't bind wheel for history (Codex
   * routes wheel to its input box) AND that run inline (so tmux's main-buffer
   * scrollback actually holds the chat history). xterm.js by itself can't
   * scroll, because `tmux attach-session` only replays the current viewport,
   * never the scrollback — so xterm.js never receives the history bytes.
   */
  useTmuxScroll?: boolean;
}

export function TuiPane({ wsUrl, theme, fontFamily, scrollToBottomRef, sendRawRef, useTmuxScroll }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const wsRef        = useRef<WsClient | null>(null);
  const [copyToast, setCopyToast] = useState(false);
  const [showPageBtns] = useState<boolean>(
    typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
  const WIDE_COLS = 80;
  const [wideMode, setWideMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    // Only honor wide mode on touch devices — PC has no toggle button so we never
    // want to leave a non-touch session stuck in wide mode from a prior phone visit.
    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    return isTouch && window.localStorage.getItem("tuiWideMode") === "1";
  });
  useEffect(() => {
    try { window.localStorage.setItem("tuiWideMode", wideMode ? "1" : "0"); } catch { /* ignore */ }
  }, [wideMode]);

  // Latest value of useTmuxScroll, for closures captured by the once-only setup effect.
  const useTmuxScrollRef = useRef(!!useTmuxScroll);
  useEffect(() => { useTmuxScrollRef.current = !!useTmuxScroll; }, [useTmuxScroll]);
  // Re-apply sizing when wide mode toggles
  useEffect(() => {
    const term = termRef.current;
    const fit  = fitRef.current;
    if (!term || !fit) return;
    try {
      if (wideMode) {
        const dims = fit.proposeDimensions();
        const rows = dims?.rows ?? term.rows;
        term.resize(WIDE_COLS, rows);
      } else {
        fit.fit();
      }
      wsRef.current?.sendResize(term.cols, term.rows);
    } catch { /* not visible yet */ }
  }, [wideMode]);

  const showCopyToast = () => {
    setCopyToast(true);
    setTimeout(() => setCopyToast(false), 1500);
  };

  // Scroll one screen up/down. On Claude TUI alt-screen, emit a burst of SGR
  // mouse-wheel events (Claude scrolls its own history). On the normal xterm
  // buffer, use xterm's scrollLines.
  const pageScroll = (direction: "up" | "down") => {
    const tt = termRef.current;
    if (!tt) return;
    const lines = Math.max(1, tt.rows - 2);
    const isAlt = tt.buffer.active.type === "alternate";
    if (isAlt) {
      const ws = wsRef.current;
      if (!ws) return;
      const button = direction === "up" ? 64 : 65;
      const col = Math.max(1, Math.floor(tt.cols / 2));
      const row = Math.max(1, Math.floor(tt.rows / 2));
      let seq = "";
      for (let i = 0; i < lines; i++) seq += `\x1b[<${button};${col};${row}M`;
      ws.sendInput(seq);
    } else {
      tt.scrollLines(direction === "up" ? -lines : lines);
    }
  };

  // ── Effect 1: xterm + FitAddon (mount once) ─────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el || termRef.current) return;

    const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent);

    const term = new Terminal({
      theme: theme === "light" ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK,
      fontFamily: fontFamily || FONT_FAMILY_DEFAULT,
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 10000,
      cursorBlink: true,
      convertEol: false,
      allowProposedApi: true,
      // On Mac, Alt+drag forces selection even when the app has mouse tracking active
      macOptionClickForcesSelection: true,
    });

    const fitAddon  = new FitAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.open(el);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current  = fitAddon;

    // Auto-fit whenever the container changes size. In wide mode we keep cols
    // fixed at WIDE_COLS and only recompute rows based on container height.
    const ro = new ResizeObserver(() => {
      try {
        const wm = window.localStorage.getItem("tuiWideMode") === "1";
        if (wm) {
          const dims = fitAddon.proposeDimensions();
          const rows = dims?.rows ?? term.rows;
          term.resize(WIDE_COLS, rows);
        } else {
          fitAddon.fit();
        }
      } catch { /* not visible yet */ }
      wsRef.current?.sendResize(term.cols, term.rows);
    });
    ro.observe(el);

    // ── Copy-on-select ──────────────────────────────────────────────────────
    // On Linux, the X11 PRIMARY selection handles this automatically.
    // On Mac/Windows there is no such mechanism, so we copy explicitly.
    let isMouseDown = false;
    let lastCopyAt = 0;
    const copySelection = () => {
      const sel = term.getSelection();
      if (!sel) return;
      const now = Date.now();
      if (now - lastCopyAt < 120) return; // debounce: avoid double-copy on dblclick
      lastCopyAt = now;
      copyToClipboard(sel).then(() => showCopyToast());
    };

    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      isMouseDown = true;
    }, true);

    // Bubble phase so xterm.js processes mouseup first and the selection is final
    el.addEventListener("mouseup", (e) => {
      if (!isMouseDown || e.button !== 0) return;
      isMouseDown = false;
      setTimeout(copySelection, 50);
    });

    // Track touch-driven selection so that intermediate selectionChange events
    // don't fire copy until the finger lifts.
    let inTouchSelection = false;

    // Also handles keyboard selection (Shift+arrow, etc.) and double-click word select
    term.onSelectionChange(() => {
      if (isMouseDown || inTouchSelection) return;
      copySelection();
    });

    // Cmd+C (Mac) / Ctrl+Shift+C (others): copy selection without sending to PTY.
    // Capture phase so we see it before xterm.js does and can preventDefault.
    el.addEventListener("keydown", (e) => {
      const wantCopy = isMac
        ? (e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "c")
        : (e.ctrlKey && e.shiftKey && e.key === "C");
      if (!wantCopy) return;
      const sel = term.getSelection();
      if (!sel) return;
      e.preventDefault();
      e.stopPropagation();
      copyToClipboard(sel).then(() => showCopyToast());
    }, true);

    // Wheel: let xterm.js handle natively. With Claude's mouse tracking enabled
    // (alt-screen TUI), wheel events get forwarded as mouse escape sequences and
    // Claude scrolls its own chat history. Custom tmux-copy-mode interception
    // didn't work because alt-screen panes have no tmux scrollback to show.
    //
    // Exception: when useTmuxScroll is on (Codex, launched with --no-alt-screen
    // so it lives on the main screen). Codex itself doesn't bind wheel for
    // history, AND xterm.js's own scrollback is empty here because
    // `tmux attach-session` only replays the current viewport — the chat
    // history lives ONLY in tmux's scrollback. Send the wheel delta to the
    // server, which enters tmux copy-mode and scrolls there; tmux then
    // redraws the new viewport over the PTY and xterm.js renders it.
    el.addEventListener("wheel", (e) => {
      if (!useTmuxScrollRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      const lines = Math.round(e.deltaY / 40) || (e.deltaY > 0 ? 1 : -1);
      wsRef.current?.sendScroll(lines);
    }, { passive: false, capture: true });

    // Touch scroll: xterm.js doesn't synthesize wheel/mouse-tracking events from
    // touch, so on mobile users can't scroll TUI history. Translate touchmove into
    // either SGR mouse wheel sequences (alt-screen, Claude consumes them) or
    // xterm's own scrollLines (normal screen).
    const isTouchDevice =
      "ontouchstart" in window || navigator.maxTouchPoints > 0;
    if (isTouchDevice) {
      let lastTouchY: number | null = null;
      let touchAccum = 0;
      const PX_PER_TICK = 12;
      // Multiplier on alt-screen path: Claude TUI scrolls ~1 line per wheel
      // event, so emit several events per detected tick to get "one swipe ≈
      // one screen" feel rather than a few lines.
      const WHEEL_LINES_PER_TICK = 3;

      // Long-press → drag-select state
      let touchSelectTimer: ReturnType<typeof setTimeout> | null = null;
      let touchSelectStart: { x: number; y: number } | null = null;
      let touchSelectStartCell: { col: number; row: number } | null = null;
      let touchSelectStartedAt = 0;
      let touchSelectDidMove = false;

      const cellFromXY = (clientX: number, clientY: number): { col: number; row: number } | null => {
        const screen = el.querySelector(".xterm-screen") as HTMLElement | null;
        const tt = termRef.current;
        if (!screen || !tt) return null;
        const rect = screen.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || tt.cols <= 0 || tt.rows <= 0) return null;
        const cellW = rect.width / tt.cols;
        const cellH = rect.height / tt.rows;
        let col = Math.floor((clientX - rect.left) / cellW);
        let screenRow = Math.floor((clientY - rect.top) / cellH);
        col = Math.max(0, Math.min(tt.cols - 1, col));
        screenRow = Math.max(0, Math.min(tt.rows - 1, screenRow));
        const row = tt.buffer.active.viewportY + screenRow;
        return { col, row };
      };

      const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length !== 1) { lastTouchY = null; return; }
        // Suppress xterm auto-focus on touch so the mobile IME doesn't pop and
        // shift layout mid-drag. Quick taps re-focus manually in onTouchEnd.
        e.preventDefault();
        lastTouchY = e.touches[0].clientY;
        touchAccum = 0;
        // Arm long-press selection
        if (!inTouchSelection) {
          const t = e.touches[0];
          touchSelectStart = { x: t.clientX, y: t.clientY };
          touchSelectStartedAt = Date.now();
          touchSelectDidMove = false;
          if (touchSelectTimer) clearTimeout(touchSelectTimer);
          touchSelectTimer = setTimeout(() => {
            touchSelectTimer = null;
            if (!touchSelectStart) return;
            const tt = termRef.current;
            if (!tt) return;
            const cell = cellFromXY(touchSelectStart.x, touchSelectStart.y);
            if (!cell) return;
            inTouchSelection = true;
            touchSelectStartCell = cell;
            tt.clearSelection();
            tt.select(cell.col, cell.row, 1);
            if (navigator.vibrate) { try { navigator.vibrate(30); } catch { /* ignore */ } }
          }, 350);
        }
      };
      const onTouchMove = (e: TouchEvent) => {
        // Selection-drag path: update selection, suppress scroll
        if (inTouchSelection) {
          if (e.touches.length !== 1 || !touchSelectStartCell) return;
          touchSelectDidMove = true;
          e.preventDefault();
          const tt = termRef.current;
          if (!tt) return;
          const t = e.touches[0];
          const cell = cellFromXY(t.clientX, t.clientY);
          if (!cell) return;
          const cols = tt.cols;
          const startIdx = touchSelectStartCell.row * cols + touchSelectStartCell.col;
          const endIdx = cell.row * cols + cell.col;
          if (endIdx >= startIdx) {
            tt.select(touchSelectStartCell.col, touchSelectStartCell.row, endIdx - startIdx + 1);
          } else {
            tt.select(cell.col, cell.row, startIdx - endIdx + 1);
          }
          return;
        }
        // Cancel long-press intent if the user moved enough to mean "scroll"
        if (touchSelectTimer && touchSelectStart) {
          const t = e.touches[0];
          const dx = t.clientX - touchSelectStart.x;
          const dy = t.clientY - touchSelectStart.y;
          if (dx * dx + dy * dy > 64) {
            touchSelectDidMove = true;
            clearTimeout(touchSelectTimer);
            touchSelectTimer = null;
            touchSelectStart = null;
          }
        }
        // Normal scroll path
        if (lastTouchY === null || e.touches.length !== 1) return;
        const y = e.touches[0].clientY;
        const delta = lastTouchY - y;
        lastTouchY = y;
        touchAccum += delta;
        const ticks = Math.trunc(touchAccum / PX_PER_TICK);
        if (ticks === 0) return;
        touchAccum -= ticks * PX_PER_TICK;

        const tt = termRef.current;
        if (!tt) return;
        const isAlt = tt.buffer.active.type === "alternate";
        if (useTmuxScrollRef.current) {
          // Codex (or other inline TUIs we host): route touch scroll to the
          // server's tmux copy-mode handler so the chat history actually
          // shows.
          e.preventDefault();
          wsRef.current?.sendScroll(-ticks * WHEEL_LINES_PER_TICK);
          return;
        }
        if (isAlt) {
          // Forward as SGR mouse wheel — Claude TUI scrolls its own history.
          // ticks > 0 (finger moved up) = newer = wheel-down (button 65).
          // ticks < 0 (finger moved down) = older = wheel-up (button 64).
          const button = ticks > 0 ? 65 : 64;
          const col = Math.max(1, Math.floor(tt.cols / 2));
          const row = Math.max(1, Math.floor(tt.rows / 2));
          const n = Math.abs(ticks) * WHEEL_LINES_PER_TICK;
          let seq = "";
          for (let i = 0; i < n; i++) seq += `\x1b[<${button};${col};${row}M`;
          wsRef.current?.sendInput(seq);
        } else {
          // Normal screen: xterm has its own scrollback.
          tt.scrollLines(-ticks * WHEEL_LINES_PER_TICK);
        }
        e.preventDefault();
      };
      const onTouchEnd = () => {
        const wasQuickTap =
          !inTouchSelection && !touchSelectDidMove && (Date.now() - touchSelectStartedAt) < 300;
        lastTouchY = null;
        touchAccum = 0;
        if (touchSelectTimer) { clearTimeout(touchSelectTimer); touchSelectTimer = null; }
        touchSelectStart = null;
        if (inTouchSelection) {
          inTouchSelection = false;
          touchSelectStartCell = null;
          const tt = termRef.current;
          if (!tt) return;
          const sel = tt.getSelection();
          if (sel) {
            copyToClipboard(sel).then(() => showCopyToast());
            // Keep highlight briefly so the user sees what was copied. Do NOT
            // re-focus — that would pop the IME and shift layout.
            setTimeout(() => { tt.clearSelection(); }, 700);
          }
          return;
        }
        // Quick tap: user wants to type. Manually focus to bring up the IME.
        if (wasQuickTap) {
          const tt = termRef.current;
          if (tt) { try { tt.focus(); } catch { /* ignore */ } }
        }
      };

      el.addEventListener("touchstart", onTouchStart, { passive: true });
      el.addEventListener("touchmove", onTouchMove, { passive: false });
      el.addEventListener("touchend", onTouchEnd, { passive: true });
      el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    }

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Effect 2: update theme on prop change ────────────────────────────────
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme =
      theme === "light" ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK;
  }, [theme]);

  // ── Effect 3: WebSocket connection (reruns when wsUrl changes) ───────────
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    // Append initial PTY size so the backend attaches at the correct dimensions
    const sep = wsUrl.includes("?") ? "&" : "?";
    const url  = `${wsUrl}${sep}cols=${term.cols}&rows=${term.rows}`;

    const ws = new WsClient({
      url,
      onOpen: () => {
        try { fitRef.current?.fit(); } catch { /* ok */ }
        ws.sendResize(term.cols, term.rows);
      },
      onOutput: (data) => term.write(data),
      onState: (state) => {
        if (state.status === "terminated") {
          term.write("\r\n\x1b[31m[Session terminated]\x1b[0m\r\n");
          ws.close();
        }
      },
      onClose: () => {},
    });
    wsRef.current = ws;

    // Forward all keyboard (and mouse tracking) input to the PTY
    const dataDisp = term.onData((data) => ws.sendInput(data));

    const pingInterval = setInterval(() => ws.sendPing(), 30_000);

    if (scrollToBottomRef) {
      // No-op: xterm's native scrollback handles this and Claude TUI's alt-screen
      // doesn't expose a "jump to bottom" we can trigger from here.
      scrollToBottomRef.current = () => {};
    }
    if (sendRawRef) {
      sendRawRef.current = (data: string) => ws.sendInput(data);
    }

    return () => {
      clearInterval(pingInterval);
      dataDisp.dispose();
      ws.close();
      wsRef.current = null;
      if (sendRawRef) sendRawRef.current = null;
    };
  }, [wsUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div
        ref={containerRef}
        style={{
          width: "100%", height: "100%",
          overflowX: wideMode ? "auto" : "hidden",
          overflowY: "hidden",
        }}
      />
      {copyToast && (
        <div style={{
          position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)",
          background: "rgba(0,0,0,0.75)", color: "#fff", fontSize: 12,
          padding: "4px 12px", borderRadius: 6, pointerEvents: "none", whiteSpace: "nowrap",
        }}>
          Copied
        </div>
      )}
      {showPageBtns && (
        <div style={{
          position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
          display: "flex", flexDirection: "column", gap: 8, zIndex: 5,
        }}>
          <button
            type="button"
            aria-label="Page up"
            onPointerDown={(e) => { e.preventDefault(); pageScroll("up"); }}
            style={{
              width: 36, height: 36, borderRadius: 18, border: "none",
              background: "rgba(0,0,0,0.35)", color: "rgba(255,255,255,0.85)",
              fontSize: 18, lineHeight: 1, cursor: "pointer",
              backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
              userSelect: "none", touchAction: "manipulation",
            }}
          >▲</button>
          <button
            type="button"
            aria-label="Page down"
            onPointerDown={(e) => { e.preventDefault(); pageScroll("down"); }}
            style={{
              width: 36, height: 36, borderRadius: 18, border: "none",
              background: "rgba(0,0,0,0.35)", color: "rgba(255,255,255,0.85)",
              fontSize: 18, lineHeight: 1, cursor: "pointer",
              backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
              userSelect: "none", touchAction: "manipulation",
            }}
          >▼</button>
          <button
            type="button"
            aria-label={wideMode ? "Fit terminal to viewport" : "Switch to wide terminal mode"}
            title={wideMode ? "Fit to viewport" : `Wide mode (${WIDE_COLS} cols)`}
            onPointerDown={(e) => { e.preventDefault(); setWideMode((v) => !v); }}
            style={{
              width: 36, height: 36, borderRadius: 18, border: "none",
              background: wideMode ? "rgba(88,166,255,0.55)" : "rgba(0,0,0,0.35)",
              color: "rgba(255,255,255,0.95)",
              fontSize: 11, fontWeight: 700, lineHeight: 1, cursor: "pointer",
              backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
              userSelect: "none", touchAction: "manipulation",
              fontFamily: "monospace",
            }}
          >{wideMode ? "FIT" : "80"}</button>
        </div>
      )}
    </div>
  );
}
