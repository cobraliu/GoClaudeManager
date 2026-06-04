import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { Theme } from "../main";

// Fixed PTY size used when fit mode is off.
const FIXED_COLS = 200;
const FIXED_ROWS = 50;
// Wide-mode column count for the user-toggled "80" mode (mobile).
const WIDE_COLS = 80;
import "@xterm/xterm/css/xterm.css";
import { WsClient } from "../lib/wsClient";

const TERMINAL_THEME = {
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

const TERMINAL_FONT_FAMILY_DEFAULT = '"Ubuntu Sans Mono", "WenQuanYi Micro Hei Mono", "WenQuanYi Zen Hei Mono", monospace';


function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  return ok;
}

interface Props {
  wsUrl: string;
  sessionId: string;
  scrollMode?: "tmux" | "pty";  // tmux = send scroll msgs for copy mode; pty = xterm scrollLines
  onDisconnect?: (reason: string) => void;
  /** When true: ignores global fit mode, hides the Fit button, and does NOT
   *  append cols/rows to the WS URL.  Use for non-tmux shells (SSH terminal). */
  disableFit?: boolean;
  /** When true: start in fit mode by default (unless user previously set it to off). */
  defaultFit?: boolean;
  /** When true (fit mode only): keep cursor at the vertical center of the terminal instead of the bottom row. */
  centerCursor?: boolean;
  /** When true: terminal is view-only; keyboard input is not forwarded to the session. */
  readOnly?: boolean;
  /** Ref that receives a function to send a prompt to this terminal's session. */
  sendPromptRef?: React.MutableRefObject<((text: string) => void) | null>;
  /** Ref that receives a function to send raw input bytes. */
  sendRawRef?: React.MutableRefObject<((data: string) => void) | null>;
  /** Ref that receives a function to exit tmux copy mode safely (no input sent to app). */
  exitCopyModeRef?: React.MutableRefObject<(() => void) | null>;
  /** Ref that receives a function to scroll xterm.js viewport to the bottom. */
  scrollToBottomRef?: React.MutableRefObject<(() => void) | null>;
  theme?: Theme;
  /** Override the terminal font family. Falls back to the built-in default. */
  fontFamily?: string;
  /** When true: show an overlay toggle to switch between fit-to-viewport and a fixed 80-col mode
   *  with horizontal scroll (intended for mobile bash shells). */
  showWideToggle?: boolean;
}

export function TerminalPane({ wsUrl, sessionId, scrollMode = "pty", onDisconnect, disableFit = false, defaultFit = false, centerCursor = false, readOnly = false, sendPromptRef, sendRawRef, exitCopyModeRef, scrollToBottomRef, theme = "dark" as Theme, fontFamily, showWideToggle = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // User-toggled wide mode (80 cols + horizontal scroll). Persisted to localStorage so it survives reloads.
  const [wideMode, setWideMode] = useState<boolean>(
    () => showWideToggle && typeof window !== "undefined" && window.localStorage.getItem("terminalWideMode") === "1",
  );
  useEffect(() => {
    try { window.localStorage.setItem("terminalWideMode", wideMode ? "1" : "0"); } catch { /* ignore */ }
  }, [wideMode]);
  // Effective fit: a non-fit prop or active wideMode both disable native fitting.
  const fitMode = !disableFit && (defaultFit !== false) && !wideMode;
  // Keep refs so closures inside the main useEffect can read latest values
  const fitModeRef = useRef(fitMode);
  const centerCursorRef = useRef(centerCursor);
  useEffect(() => { centerCursorRef.current = centerCursor; }, [centerCursor]);
  useEffect(() => { fitModeRef.current = fitMode; }, [fitMode]);

  const [terminated, setTerminated] = useState(false);
  // Scroll position tracking for TUI pane — updated via wheel events and polling
  const [scrolledUp, setScrolledUp] = useState(false);
  const scrolledUpRef = useRef(false);
  // Tracks net upward scroll depth in tmux mode (for overlay button visibility)
  const mouseScrollDepthRef = useRef(0);
  const [copyToast, setCopyToast] = useState(false);
  // Touch devices get on-screen ▲▼ page buttons (a swipe alone is easy to miss,
  // and tmux-mode history lives server-side). pageScrollRef is populated inside
  // the main effect so the buttons can reach `ws`/`term`.
  const isTouch = typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0);
  const pageScrollRef = useRef<((dir: "up" | "down") => void) | null>(null);


  const showCopyToast = () => {
    setCopyToast(true);
    setTimeout(() => setCopyToast(false), 1500);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // xterm.js detects Mac via navigator.platform to decide how to force selection:
    //   non-Mac → shiftKey bypasses application mouse events
    //   Mac     → altKey + macOptionClickForcesSelection:true
    const isMac = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(navigator.platform);

    const term = new Terminal({
      cols: FIXED_COLS,
      rows: FIXED_ROWS,
      cursorBlink: true,
      fontSize: 14,
      // Must use a single typeface covering both ASCII and CJK so that
      // charWidth (measured from ASCII glyphs) equals exactly half the CJK
      // glyph advance-width — mixing two fonts breaks this invariant.
      // "Noto Sans Mono CJK SC" ships inside NotoSansCJK-Regular.ttc and is
      // explicitly designed with CJK = 2 × ASCII advance-width.
      fontFamily: fontFamily || TERMINAL_FONT_FAMILY_DEFAULT,
      fontWeight: "400",
      fontWeightBold: "700",
      // Draw box-drawing, block-element and Braille characters on canvas
      // rather than relying on the font's glyph metrics — this ensures table
      // borders always fill exactly one cell regardless of font fallback or
      // bold rendering widening a glyph.
      customGlyphs: true,
      theme: theme === "light" ? TERMINAL_THEME_LIGHT : TERMINAL_THEME,
      convertEol: false,
      scrollback: 10000,
      wordSeparator: " ()[]{}',\"`|;:@#$%^&*+=<>/\\~",
      macOptionClickForcesSelection: true,
      allowProposedApi: true,
    });

    // Completely block right-click context menu in the terminal area
    el.addEventListener("contextmenu", (e) => e.preventDefault(), true);

    // Intercept wheel events before xterm.js so they always scroll the viewport
    // rather than being forwarded to the terminal application (which bash/readline
    // could interpret as up/down arrow keys navigating command history).
    const updateScrolledUp = () => {
      const buf = term.buffer.active;
      const isUp = buf.viewportY < buf.baseY;
      // Debug: in tmux alternate-screen mode viewportY/baseY are always 0 so isUp is always false

      if (isUp !== scrolledUpRef.current) {
        scrolledUpRef.current = isUp;
        setScrolledUp(isUp);
      }
    };

    el.addEventListener("wheel", (e) => {
      // Always prevent browser CSS-scroll of the outer container — the outer
      // container must not scroll independently of xterm.js.
      e.preventDefault();
      if (scrollMode === "tmux") {
        // Use server-side tmux copy mode (via scroll WS messages) instead of
        // forwarding mouse escape sequences. This makes exit-copy-mode reliable
        // because send-keys -X cancel works for server-side copy mode, unlike
        // per-client copy mode entered via mouse events.
        e.stopPropagation(); // prevent xterm.js from generating mouse escape sequences
        const lines = Math.round(e.deltaY / 40) || (e.deltaY > 0 ? 1 : -1);
        ws.sendScroll(lines);
        if (lines < 0) {
          mouseScrollDepthRef.current += Math.abs(lines);
          if (!scrolledUpRef.current) {
            scrolledUpRef.current = true;
            setScrolledUp(true);
          }
        } else if (lines > 0 && mouseScrollDepthRef.current > 0) {
          mouseScrollDepthRef.current = Math.max(0, mouseScrollDepthRef.current - lines);
          if (mouseScrollDepthRef.current === 0) {
            scrolledUpRef.current = false;
            setScrolledUp(false);
          }
        }
        return;
      }
      // pty mode: if the terminal is in alternate screen (e.g. Claude Code TUI with
      // mouse tracking enabled), let xterm.js handle the event naturally — it will
      // forward the wheel as mouse tracking escape sequences to the application.
      // Only take over scrolling on the main screen (bash/readline), where we want
      // viewport scroll instead of arrow-key generation.
      if (term.buffer.active.type === "alternate") {
        return; // no stopPropagation — xterm.js sees the event and forwards it
      }
      e.stopPropagation();
      const lines = Math.round(e.deltaY / 40) || (e.deltaY > 0 ? 1 : -1);
      term.scrollLines(lines);
      requestAnimationFrame(updateScrolledUp);
    }, { passive: false, capture: true });

    // Touch state shared by scroll handler and long-press selection.
    let touchStartY = 0;
    let touchLastY = 0;
    let inTouchSelection = false;
    let touchSelectTimer: ReturnType<typeof setTimeout> | null = null;
    let touchSelectStart: { x: number; y: number } | null = null;
    let touchSelectStartCell: { col: number; row: number } | null = null;
    let touchSelectStartedAt = 0;
    let touchSelectDidMove = false;

    el.addEventListener("touchstart", (e) => {
      touchStartY = e.touches[0].clientY;
      touchLastY = touchStartY;
    }, { passive: true });
    // Apply a scroll of `lines` (negative = up/into history). In tmux mode the
    // history lives server-side, so we send copy-mode scroll messages exactly
    // like the wheel handler; in pty mode xterm's own scrollback is used.
    const applyScroll = (lines: number) => {
      if (lines === 0) return;
      if (scrollMode === "tmux") {
        ws.sendScroll(lines);
        if (lines < 0) {
          mouseScrollDepthRef.current += Math.abs(lines);
          if (!scrolledUpRef.current) { scrolledUpRef.current = true; setScrolledUp(true); }
        } else if (mouseScrollDepthRef.current > 0) {
          mouseScrollDepthRef.current = Math.max(0, mouseScrollDepthRef.current - lines);
          if (mouseScrollDepthRef.current === 0) { scrolledUpRef.current = false; setScrolledUp(false); }
        }
      } else {
        term.scrollLines(lines);
        requestAnimationFrame(updateScrolledUp);
      }
    };
    // One-screen page scroll, used by the ▲▼ touch buttons.
    pageScrollRef.current = (dir) => applyScroll((dir === "up" ? -1 : 1) * Math.max(1, term.rows - 2));

    el.addEventListener("touchmove", (e) => {
      if (inTouchSelection) return; // selection drag — handled by capture-phase listener below
      e.preventDefault();
      const y = e.touches[0].clientY;
      const delta = touchLastY - y;
      touchLastY = y;
      if (Math.abs(delta) < 2) return;
      // Swipe down (delta<0) reveals older history (scroll up), matching native feel.
      applyScroll(Math.round(delta / 20) || (delta > 0 ? 1 : -1));
    }, { passive: false });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.open(el);
    termRef.current = term;

    // Calculate initial PTY size: if fit mode is on, measure container now
    // so the backend attaches at the correct size immediately (no layout jump).
    // MIN_COLS/MIN_ROWS guard against transient tiny container sizes (panel
    // animations, hidden tabs) that would otherwise force tmux to reflow
    // Claude's TUI into a corrupted 5-col-wide state.
    const MIN_COLS = 40;
    const MIN_ROWS = 10;
    let initCols = FIXED_COLS;
    let initRows = FIXED_ROWS;
    if (fitModeRef.current) {
      try {
        fitAddon.fit();
        if (term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
          initCols = term.cols;
          initRows = term.rows;
        }
      } catch { /* container not ready, fall back to fixed */ }
    }

    // Scroll outer container to bottom so the prompt row is visible on load
    requestAnimationFrame(() => {
      term.focus();
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    });

    // --- Write buffering: pause during selection so data doesn't clear it ---
    let writePaused = false;
    let writeBuffer: string[] = [];
    let bufferTimeout: ReturnType<typeof setTimeout> | null = null;
    // Scroll the outer div to bottom so the prompt (last row) is always visible.
    // Coalesced with rAF so many rapid writes only trigger one DOM layout per frame.
    let scrollPending = false;
    // Debounced cursor centering: fires 400ms after output settles so we don't
    // fight xterm's auto-scroll on every character (which would cause flickering).
    let centerTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleCenterCursor = () => {
      if (centerTimer) clearTimeout(centerTimer);
      centerTimer = setTimeout(() => {
        if (!fitModeRef.current || !centerCursorRef.current) return;
        const buf = term.buffer.active;
        const cursorY = buf.cursorY;       // absolute position in scrollback buffer
        const viewportY = buf.viewportY;   // buffer line where viewport top is
        // Only center when viewport is already at the bottom (user hasn't scrolled up)
        if (cursorY - viewportY > term.rows - 1) return;
        const half = Math.floor(term.rows / 2);
        // scrollToLine: viewport starts at this buffer line → cursor lands at row `half`
        term.scrollToLine(Math.max(0, cursorY - half));
      }, 400);
    };
    const scrollToBottom = () => {
      if (scrollPending) return;
      scrollPending = true;
      requestAnimationFrame(() => {
        scrollPending = false;
        if (fitModeRef.current) {
          // xterm auto-scrolls natively; apply centering only after output settles.
          if (centerCursorRef.current) scheduleCenterCursor();
        } else if (scrollMode !== "tmux") {
          // In tmux mode the TUI controls its own viewport via cursor addressing —
          // snapping the CSS container to bottom would fight the TUI's scroll.
          const sc = scrollContainerRef.current;
          if (sc) sc.scrollTop = sc.scrollHeight;
        }
      });
    };
    const termWrite = (data: string) => {
      if (writePaused) {
        writeBuffer.push(data);
      } else {
        term.write(data);
        scrollToBottom();
      }
    };
    const flushWrites = () => {
      writePaused = false;
      if (bufferTimeout) { clearTimeout(bufferTimeout); bufferTimeout = null; }
      if (writeBuffer.length > 0) {
        term.write(writeBuffer.join(""));
        writeBuffer = [];
        scrollToBottom();
      }
    };
    const pauseWrites = () => {
      writePaused = true;
      if (bufferTimeout) clearTimeout(bufferTimeout);
      bufferTimeout = setTimeout(flushWrites, 10000);
    };

    // --- Selection + copy-on-select ---
    // pty/bash: xterm.js native selection works — just copy on mouseup.
    // tmux: mouse-tracking is active, xterm.js forwards clicks to the app.
    //   We trick xterm.js into selection mode by faking the key it checks:
    //   non-Mac → shiftKey;  Mac → altKey (+ macOptionClickForcesSelection:true above).
    const forceKeyProp = isMac ? "altKey" : "shiftKey";
    const origKeyDesc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, forceKeyProp)
                     ?? Object.getOwnPropertyDescriptor(UIEvent.prototype, forceKeyProp);
    let forceKey = false;
    if (scrollMode === "tmux" && origKeyDesc) {
      Object.defineProperty(MouseEvent.prototype, forceKeyProp, {
        get() {
          if (forceKey) return true;
          return origKeyDesc.get!.call(this);
        },
        configurable: true,
      });
    }

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
      // Only force shift/alt when xterm.js would otherwise forward the click
      // to the application (mouse-tracking active, e.g. Claude TUI). When
      // mouse-tracking is off (bash + `tmux mouse off`), xterm.js's selection
      // service is enabled and reads shiftKey as "extend existing selection"
      // via _handleIncrementalClick — forcing it here makes the first drag a
      // no-op because there's no prior selection to extend.
      if (scrollMode === "tmux" && term.modes.mouseTrackingMode !== "none") {
        forceKey = true;
      }
      pauseWrites();
      isMouseDown = true;
    }, true);

    // mouseup uses bubble phase (no capture) so xterm.js processes the event first.
    // With capture:true we would clear forceKey before xterm.js sees the mouseup,
    // causing xterm.js to read shiftKey/altKey=false and discard the selection.
    el.addEventListener("mouseup", (e) => {
      if (!isMouseDown || e.button !== 0) return;
      forceKey = false;   // safe: xterm.js already handled mouseup above us
      isMouseDown = false;
      // Read selection BEFORE flushing writes: flushing can re-render the terminal
      // and trigger onSelectionChange with empty selection, burning the debounce slot.
      setTimeout(() => { copySelection(); flushWrites(); }, 50);
    });

    // dblclick: xterm.js selects the word, then onSelectionChange fires
    // onSelectionChange also handles keyboard selection (Shift+arrow etc.)
    term.onSelectionChange(() => {
      if (isMouseDown || inTouchSelection) return; // drag in progress — wait for mouseup/touchend
      copySelection();
    });

    // ── Long-press touch selection ──────────────────────────────────────────
    // On touch devices, press-and-hold for 350ms then drag to select; release
    // copies the selection to the clipboard. Uses term.select() directly so it
    // works in tmux mode too (no mouse-tracking interference).
    const isTouchDeviceForSelect = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    if (isTouchDeviceForSelect) {
      const cellFromXY = (clientX: number, clientY: number): { col: number; row: number } | null => {
        const screen = el.querySelector(".xterm-screen") as HTMLElement | null;
        if (!screen) return null;
        const rect = screen.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || term.cols <= 0 || term.rows <= 0) return null;
        const cellW = rect.width / term.cols;
        const cellH = rect.height / term.rows;
        let col = Math.floor((clientX - rect.left) / cellW);
        let screenRow = Math.floor((clientY - rect.top) / cellH);
        col = Math.max(0, Math.min(term.cols - 1, col));
        screenRow = Math.max(0, Math.min(term.rows - 1, screenRow));
        const row = term.buffer.active.viewportY + screenRow;
        return { col, row };
      };

      el.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1 || inTouchSelection) return;
        // Suppress xterm's auto-focus on touch — otherwise the mobile IME pops up
        // mid-drag and shifts layout, breaking selection coordinates. Quick taps
        // re-focus manually in endTouchSelection.
        e.preventDefault();
        const t = e.touches[0];
        touchSelectStart = { x: t.clientX, y: t.clientY };
        touchSelectStartedAt = Date.now();
        touchSelectDidMove = false;
        if (touchSelectTimer) clearTimeout(touchSelectTimer);
        touchSelectTimer = setTimeout(() => {
          touchSelectTimer = null;
          if (!touchSelectStart) return;
          const cell = cellFromXY(touchSelectStart.x, touchSelectStart.y);
          if (!cell) return;
          inTouchSelection = true;
          touchSelectStartCell = cell;
          term.clearSelection();
          term.select(cell.col, cell.row, 1);
          if (navigator.vibrate) { try { navigator.vibrate(30); } catch { /* ignore */ } }
        }, 350);
      }, { passive: false });

      el.addEventListener("touchmove", (e) => {
        // While waiting for the long-press timer: cancel if the user moved enough that
        // they clearly intended to scroll instead of selecting.
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
          return;
        }
        if (!inTouchSelection || !touchSelectStartCell || e.touches.length !== 1) return;
        touchSelectDidMove = true;
        e.preventDefault();
        e.stopImmediatePropagation();
        const t = e.touches[0];
        const cell = cellFromXY(t.clientX, t.clientY);
        if (!cell) return;
        const cols = term.cols;
        const startIdx = touchSelectStartCell.row * cols + touchSelectStartCell.col;
        const endIdx = cell.row * cols + cell.col;
        if (endIdx >= startIdx) {
          term.select(touchSelectStartCell.col, touchSelectStartCell.row, endIdx - startIdx + 1);
        } else {
          term.select(cell.col, cell.row, startIdx - endIdx + 1);
        }
      }, { passive: false, capture: true });

      const endTouchSelection = () => {
        const wasQuickTap =
          !inTouchSelection && !touchSelectDidMove && (Date.now() - touchSelectStartedAt) < 300;
        if (touchSelectTimer) { clearTimeout(touchSelectTimer); touchSelectTimer = null; }
        touchSelectStart = null;
        if (inTouchSelection) {
          inTouchSelection = false;
          touchSelectStartCell = null;
          const sel = term.getSelection();
          if (sel) {
            copyToClipboard(sel).then(() => showCopyToast());
            // Keep highlight briefly so the user sees what was copied. Do NOT
            // re-focus the terminal — that would pop the IME and shift layout.
            setTimeout(() => { term.clearSelection(); }, 700);
          }
          return;
        }
        // Quick tap: user wants to type. Manually focus to bring up the IME.
        if (wasQuickTap) {
          try { term.focus(); } catch { /* ignore */ }
        }
      };
      el.addEventListener("touchend", endTouchSelection);
      el.addEventListener("touchcancel", endTouchSelection);
    }

    // --- WebSocket ---
    // Append initial PTY size to URL for tmux sessions so the backend attaches
    // at the correct size immediately.  Skipped for disableFit (SSH shell) since
    // that WS endpoint does not use these params.
    let wsUrlFinal = wsUrl;
    if (!disableFit) {
      const sep = wsUrl.includes("?") ? "&" : "?";
      wsUrlFinal = `${wsUrl}${sep}cols=${initCols}&rows=${initRows}`;
    }
    const ws = new WsClient({
      url: wsUrlFinal,
      onOpen: () => {
        // If fit mode is globally enabled, apply it immediately on connect.
        if (fitModeRef.current && fitAddonRef.current) {
          try {
            fitAddonRef.current.fit();
            if (term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
              ws.sendResize(term.cols, term.rows);
            }
          } catch { /* container not ready yet */ }
        }
      },
      onOutput: (data) => termWrite(data),
      onState: (state) => {
        if (state.status === "terminated") {
          term.write("\r\n\x1b[31m[Session terminated]\x1b[0m\r\n");
          ws.close();
          setTerminated(true);
        }
      },
      onCopyModeExited: () => {
        // Server detected a stale copy-mode (user cancelled via Enter/Escape/q).
        // Clear the scroll-up depth so the "back to bottom" overlay disappears.
        mouseScrollDepthRef.current = 0;
        if (scrolledUpRef.current) {
          scrolledUpRef.current = false;
          setScrolledUp(false);
        }
      },
      onClose: (reason) => onDisconnect?.(reason),
    });
    wsRef.current = ws;
    if (sendPromptRef) sendPromptRef.current = (text) => ws.sendPrompt(text);
    if (sendRawRef) sendRawRef.current = (data) => ws.sendInput(data);
    if (exitCopyModeRef) exitCopyModeRef.current = () => {

      ws.sendExitCopyMode();
      mouseScrollDepthRef.current = 0;
      scrolledUpRef.current = false;
      setScrolledUp(false);
    };
    if (scrollToBottomRef) scrollToBottomRef.current = () => {

      ws.sendExitCopyMode();
      mouseScrollDepthRef.current = 0;
      scrolledUpRef.current = false;
      setScrolledUp(false);
    };

    // Ctrl+End: jump to bottom. Captured at DOM level so it works even in readOnly mode.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "End" && e.ctrlKey) {
        e.preventDefault();

        ws.sendExitCopyMode();
        mouseScrollDepthRef.current = 0;
        scrolledUpRef.current = false;
        setScrolledUp(false);
      }
    };
    el.addEventListener("keydown", onKeyDown);

    // Always register onData so mouse escape sequences (generated by xterm.js when
    // tmux mouse mode is on) are forwarded even in readOnly mode.  In readOnly mode,
    // keyboard input is blocked; only X10 / SGR mouse sequences are passed through.
    term.onData((data) => {
      if (readOnly && !data.startsWith("\x1b[M") && !data.startsWith("\x1b[<")) return;
      ws.sendInput(data);
    });

    // Line number gutter
    const pingInterval = setInterval(() => ws.sendPing(), 30_000);

    return () => {
      if (bufferTimeout) clearTimeout(bufferTimeout);
      if (centerTimer) clearTimeout(centerTimer);
      clearInterval(pingInterval);
      el.removeEventListener("keydown", onKeyDown);
      ws.close();
      term.dispose();
      if (scrollMode === "tmux" && origKeyDesc) {
        Object.defineProperty(MouseEvent.prototype, forceKeyProp, { ...origKeyDesc, configurable: true });
      }
    };
  }, [wsUrl, fontFamily]);

  // Update xterm theme when the theme prop changes on an already-open terminal
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = theme === "light" ? TERMINAL_THEME_LIGHT : TERMINAL_THEME;
  }, [theme]);

  // Apply / remove fit mode whenever the toggle changes
  useEffect(() => {
    const term = termRef.current;
    const ws = wsRef.current;
    const fitAddon = fitAddonRef.current;
    const sc = scrollContainerRef.current;
    if (!term || !ws || !fitAddon || !sc) return;

    if (!fitMode) {
      if (wideMode) {
        // Wide mode: fixed 80 cols, rows derived from current container so the
        // visible viewport matches available height (no large blank bottom).
        let rows = FIXED_ROWS;
        try {
          const dims = fitAddon.proposeDimensions();
          if (dims?.rows && dims.rows >= 10) rows = dims.rows;
        } catch { /* fall back to FIXED_ROWS */ }
        term.resize(WIDE_COLS, rows);
        ws.sendResize(WIDE_COLS, rows);
        // Re-evaluate rows on container resize so the visible region tracks viewport height.
        const ro = new ResizeObserver(() => {
          try {
            const dims = fitAddon.proposeDimensions();
            const r = dims?.rows && dims.rows >= 10 ? dims.rows : term.rows;
            if (r !== term.rows) {
              term.resize(WIDE_COLS, r);
              ws.sendResize(WIDE_COLS, r);
            }
          } catch { /* ignore */ }
        });
        ro.observe(sc);
        return () => ro.disconnect();
      }
      // Back to fixed size
      term.resize(FIXED_COLS, FIXED_ROWS);
      ws.sendResize(FIXED_COLS, FIXED_ROWS);
      return;
    }

    // Minimum sane terminal size — anything smaller almost always comes from a
    // transient layout glitch (panel collapsing, container hidden, etc.) and
    // would force tmux to reflow Claude's TUI into a corrupted state.
    const MIN_COLS = 40;
    const MIN_ROWS = 10;
    let lastSent: { cols: number; rows: number } | null = null;
    const doFit = () => {
      try {
        fitAddon.fit();
        const c = term.cols;
        const r = term.rows;
        if (c < MIN_COLS || r < MIN_ROWS) return;
        if (lastSent && lastSent.cols === c && lastSent.rows === r) return;
        lastSent = { cols: c, rows: r };
        ws.sendResize(c, r);
      } catch { /* container not visible yet */ }
    };

    // Debounce ResizeObserver: layout transitions can fire many sizes per second;
    // only send the final stable size to avoid resize storms.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFit = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doFit, 80);
    };

    // Force an initial canvas render by resizing to current dimensions.
    // Without this, xterm may never paint if fitAddon.fit() returns early
    // (proposeDimensions returns undefined when font metrics aren't ready yet).
    // Immediate fit attempt + retries after browser paints layout.
    doFit();
    const rafId = requestAnimationFrame(doFit);
    const tid = setTimeout(doFit, 150);
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(sc);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(tid);
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
    };
  }, [fitMode, wideMode]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      {/* Terminal — fit mode fills container; fixed mode is scrollable */}
      <div
        ref={scrollContainerRef}
        style={{
          flex: 1,
          overflow: fitMode ? "hidden" : "auto",
          minHeight: 0,
          minWidth: 0,
          background: "var(--bg-base)",
          position: "relative",
        }}
      >
        <div
          ref={containerRef}
          style={fitMode
            ? { position: "absolute", inset: 0 }
            : { display: "inline-block", background: "var(--bg-base)" }}
        />
        {terminated && (
          <div style={terminatedStyle}>SESSION TERMINATED</div>
        )}
        {copyToast && (
          <div style={toastStyle}>Copied</div>
        )}
        {isTouch && (
          <div style={{
            position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
            display: "flex", flexDirection: "column", gap: 8, zIndex: 10,
          }}>
            {([["up", "▲"], ["down", "▼"]] as const).map(([dir, glyph]) => (
              <button
                key={dir}
                onPointerDown={(e) => { e.preventDefault(); pageScrollRef.current?.(dir); }}
                aria-label={dir === "up" ? "Scroll up one screen" : "Scroll down one screen"}
                style={{
                  width: 36, height: 36, borderRadius: 18,
                  background: "rgba(0,0,0,0.4)", color: "rgba(255,255,255,0.95)",
                  border: "1px solid rgba(255,255,255,0.18)", fontSize: 14,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: 0, cursor: "pointer", userSelect: "none",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
                }}
              >{glyph}</button>
            ))}
          </div>
        )}
        {showWideToggle && !disableFit && (
          <button
            onPointerDown={(e) => { e.preventDefault(); setWideMode((v) => !v); }}
            title={wideMode ? "Fit to viewport" : "Switch to 80-col mode (horizontal scroll)"}
            style={{
              position: "absolute",
              right: 10,
              bottom: 10,
              width: 40,
              height: 40,
              borderRadius: 20,
              background: wideMode ? "rgba(88,166,255,0.55)" : "rgba(0,0,0,0.4)",
              color: "rgba(255,255,255,0.95)",
              border: "1px solid rgba(255,255,255,0.18)",
              fontSize: 11,
              fontWeight: 700,
              fontFamily: "monospace",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              cursor: "pointer",
              userSelect: "none",
              boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
              zIndex: 10,
            }}
          >
            {wideMode ? "FIT" : "80"}
          </button>
        )}
      </div>
    </div>
  );
}

const terminatedStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 0, left: 0, right: 0,
  background: "rgba(217, 83, 79, 0.9)",
  color: "#fff",
  textAlign: "center",
  padding: "8px 0",
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: 1,
};

const toastStyle: React.CSSProperties = {
  position: "absolute",
  top: 8, right: 12,
  background: "rgba(92, 184, 92, 0.9)",
  color: "#fff",
  padding: "4px 12px",
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 600,
  pointerEvents: "none",
};
