import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { IconSun, IconMoon } from "./icons";
import {
  getPublicShareMeta,
  getPublicShareMessages,
  postPublicSharePrompt,
  type RawMessage,
  type ShareType,
} from "../api/sessionApi";
import { renderConversationBody, LIGHT_STYLE, DARK_STYLE } from "../lib/exportChat";
import { attachInteractions } from "../lib/chatInteractions";
import { ShareFilesTab } from "./ShareFilesTab";

const PERMANENT_EXPIRES = 2147483647;
/* Live shares (full / chat) poll the tail for new messages. 5s is plenty for a
 * read-along view, and the poll is additionally gated on the reader actually
 * being on the last page (see the polling effect), so we don't refetch the tail
 * while someone is scrolled up reading history. */
const POLL_MS = 5000;
const PAGE = 100;
const NEAR_BOTTOM_PX = 600;
const NEAR_TOP_PX = 600;
/* Strict "reader is genuinely at the latest message" threshold for gating the
 * live poll. Much tighter than NEAR_BOTTOM_PX (which only governs the
 * jump-button and follow-scroll snap), but not zero: it absorbs sub-pixel
 * scroll metrics (fractional scrollY/innerHeight at fractional zoom / HiDPI),
 * the fixed chat composer's blurred bar, and browser bottom insets — any of
 * which can leave a few residual pixels even when scrolled fully down. */
const AT_BOTTOM_PX = 80;
/* Minimum gap between two scroll-triggered page loads. The pause lets a fetched
 * page actually render (so the next at-edge measurement reflects the grown
 * content) and prevents a burst of back-to-back page requests when the reader is
 * parked at an edge. */
const LOAD_COOLDOWN_MS = 400;
type Theme = "light" | "dark";
/* asc = top-anchored, oldest first, scroll DOWN for newer (default full/limited).
 * desc = bottom-anchored chat-style: still chronological, but opens at the latest
 * message and scrolls UP for older (default for chat shares). */
type Order = "asc" | "desc";

/* Page-frame background for the area outside the centered content column
 * (index.css paints html/#root with the app's dark var; override per theme). */
const PAGE_BG: Record<Theme, string> = { light: "#fafafa", dark: "#1a1a1a" };

/* Per-share key: a reader's manual toggle overrides the creator-set
 * default_theme, but only for that share. */
const themeKey = (hash: string) => `cm_share_theme:${hash}`;

function savedTheme(hash: string): Theme | null {
  const s = localStorage.getItem(themeKey(hash));
  return s === "light" || s === "dark" ? s : null;
}

/* Per-share reading order, same override semantics as theme. */
const orderKey = (hash: string) => `cm_share_order:${hash}`;

function savedOrder(hash: string): Order | null {
  const s = localStorage.getItem(orderKey(hash));
  return s === "asc" || s === "desc" ? s : null;
}

/* Widen the page cap past exportChat's 1080px reading column — mainly so the
 * Files tab gets room on PC. body is block-level, so max-width:1920 resolves to
 * min(1920px, viewport width). */
const PAGE_MAX = 1920;

interface Props {
  hash: string;
  shareType: ShareType;
}

function fmtTime(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleString();
}

function fmtExpiry(epochSec: number): string {
  if (epochSec >= PERMANENT_EXPIRES) return "永久有效";
  return `失效于 ${fmtTime(epochSec)}`;
}

/* Pixels between the bottom of the viewport and the end of the document. The
 * share viewer frees the global fixed layout (html/body/#root height:auto,
 * overflow:visible), so the whole page scrolls and window scroll metrics are
 * authoritative — the fixed composer/toolbar overlay the viewport but do NOT
 * change scrollHeight, and the content's paddingBottom keeps the last message
 * clear of the composer, so a full scroll-down still reaches scrollHeight.
 * Can be slightly negative (overscroll); callers use <= thresholds. */
function bottomGap(): number {
  return document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
}

/* Generous: jump-button visibility + follow-scroll snap. */
function nearBottom(): boolean {
  return bottomGap() <= NEAR_BOTTOM_PX;
}

/* Strict: reader is genuinely parked at the latest message. Gates the live poll. */
function atBottom(): boolean {
  return bottomGap() <= AT_BOTTOM_PX;
}

/* Bottom composer for chat shares — injects a chat-mode prompt into the live
 * session. No optimistic bubble: the 1.5s poll pulls the real message back, so
 * a successful send just clears the box and waits. Uses viewer-static colors
 * (not app CSS vars) since the share viewer runs outside <App>. */
function ShareChatComposer({ hash, theme, sessionAlive }: { hash: string; theme: Theme; sessionAlive: boolean }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const dark = theme === "dark";
  const c = {
    barBg: dark ? "rgba(26,26,26,0.96)" : "rgba(250,250,250,0.96)",
    border: dark ? "#444" : "#ddd",
    inputBg: dark ? "#0d1117" : "#fff",
    inputText: dark ? "#e6e6e6" : "#222",
    accent: dark ? "#58a6ff" : "#2563eb",
    accentText: "#fff",
    muted: dark ? "#888" : "#999",
    err: dark ? "#ff7b72" : "#c0392b",
  };

  const disabled = !sessionAlive;

  const send = useCallback(async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setHint(null);
    try {
      await postPublicSharePrompt(hash, value);
      setText("");
      if (taRef.current) taRef.current.style.height = "auto";
    } catch (e) {
      const msg = String((e as Error)?.message || e || "");
      if (msg.includes("auq_pending")) setHint("会话正在等待确认，请稍后再试");
      else if (msg.includes("offline")) setHint("会话已离线");
      else setHint("发送失败，请重试");
    } finally {
      setSending(false);
    }
  }, [text, sending, hash]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div
      style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 50,
        background: c.barBg, borderTop: `1px solid ${c.border}`,
        backdropFilter: "blur(6px)",
        padding: "10px 12px",
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>
        {hint && (
          <div style={{ fontSize: 12, color: c.err, marginBottom: 6, fontFamily: "sans-serif" }}>{hint}</div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            ref={taRef}
            value={text}
            disabled={disabled || sending}
            onChange={(e) => { setText(e.target.value); autoGrow(e.target); }}
            onKeyDown={onKeyDown}
            placeholder={disabled ? "会话已离线，无法发送" : "输入消息，Enter 发送 / Shift+Enter 换行"}
            rows={1}
            style={{
              flex: 1, resize: "none", minHeight: 38, maxHeight: 160,
              padding: "8px 10px", borderRadius: 8,
              border: `1px solid ${c.border}`, background: c.inputBg, color: c.inputText,
              fontSize: 14, lineHeight: 1.4, fontFamily: "sans-serif",
              outline: "none", boxSizing: "border-box",
              opacity: disabled ? 0.6 : 1,
            }}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={disabled || sending || text.trim().length === 0}
            style={{
              flex: "0 0 auto", height: 38, padding: "0 18px", borderRadius: 8,
              border: "none", cursor: disabled || sending || text.trim().length === 0 ? "default" : "pointer",
              background: disabled || sending || text.trim().length === 0 ? c.muted : c.accent,
              color: c.accentText, fontSize: 14, fontFamily: "sans-serif", whiteSpace: "nowrap",
            }}
          >
            {sending ? "发送中…" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* Height (px) of the fixed top toolbar; the page content is padded by this so
 * nothing renders underneath it. */
const TOOLBAR_H = 48;

/* Second-layer menu bar — sits directly below the title/meta header and above
 * the chat transcript / files view, and sticks to the top of the viewport once
 * the header scrolls past, so it always stays above the content. Holds the
 * controls that used to live in the header row: Chat/Files tabs, reading-order
 * toggle, theme toggle. Runs outside <App>, so colors are static per theme
 * rather than CSS vars. */
function ShareToolBar({
  theme, order, hasFiles, activeTab,
  onToggleTheme, onToggleOrder, onSelectTab,
}: {
  theme: Theme;
  order: Order;
  hasFiles: boolean;
  activeTab: "chat" | "files";
  onToggleTheme: () => void;
  onToggleOrder: () => void;
  onSelectTab: (t: "chat" | "files") => void;
}) {
  const dark = theme === "dark";
  const c = {
    bg: dark ? "rgba(26,26,26,0.97)" : "rgba(255,255,255,0.97)",
    border: dark ? "#444" : "#ddd",
    text: dark ? "#aaa" : "#666",
    accent: dark ? "#58a6ff" : "#2563eb",
    accentBg: dark ? "rgba(88,166,255,0.15)" : "rgba(37,99,235,0.08)",
  };
  const btn = (on: boolean): CSSProperties => ({
    fontSize: 13, padding: "6px 14px", borderRadius: 6, cursor: "pointer",
    border: `1px solid ${on ? c.accent : c.border}`,
    background: on ? c.accentBg : "transparent",
    color: on ? c.accent : c.text,
    whiteSpace: "nowrap", fontFamily: "sans-serif",
  });

  return (
    <div
      style={{
        position: "sticky", top: 0, height: TOOLBAR_H, zIndex: 60,
        display: "flex", alignItems: "center", gap: 8, padding: "0 12px",
        marginBottom: 12,
        borderBottom: `1px solid ${c.border}`, background: c.bg,
        backdropFilter: "blur(6px)", boxShadow: "0 1px 4px rgba(0,0,0,0.10)",
        fontFamily: "sans-serif", boxSizing: "border-box",
      }}
    >
      {hasFiles && (["chat", "files"] as const).map((id) => (
        <button key={id} type="button" style={btn(activeTab === id)} onClick={() => onSelectTab(id)}>
          {id === "chat" ? "💬 Chat" : "📁 Files"}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <button type="button" style={btn(false)} onClick={onToggleOrder} title="切换阅读顺序">
        {order === "desc" ? "🔽 最新在下" : "🔼 最早在上"}
      </button>
      <button type="button" style={btn(false)} onClick={onToggleTheme} title="切换深色 / 浅色">
        {theme === "dark" ? <><IconSun style={{ verticalAlign: "-0.15em" }} /> 浅色</> : <><IconMoon style={{ verticalAlign: "-0.15em" }} /> 深色</>}
      </button>
    </div>
  );
}

export function ShareViewer({ hash, shareType }: Props) {
  const [title, setTitle] = useState("Shared conversation");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [cutoffTs, setCutoffTs] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const [bodyHtml, setBodyHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => savedTheme(hash) ?? "light");
  const themeOverriddenRef = useRef(savedTheme(hash) !== null);
  const [hasFiles, setHasFiles] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "files">("chat");
  const [sessionAlive, setSessionAlive] = useState(true);
  // Reading order: desc (chat-style, opens at latest) defaults for chat shares,
  // asc (oldest-first, opens at top) for full/limited. Reader override persists.
  const [order, setOrder] = useState<Order>(() => savedOrder(hash) ?? (shareType === "chat" ? "desc" : "asc"));
  const [showJumpBtn, setShowJumpBtn] = useState(false);

  // chat shares are live (poll for new messages, follow bottom) like full,
  // and additionally expose a composer that injects prompts into the session.
  const isChat = shareType === "chat";
  const live = shareType === "full" || shareType === "chat";

  const bodyRef = useRef<HTMLDivElement | null>(null);
  // loadedRef is ALWAYS chronological (oldest→newest); `order` only changes which
  // end we open at and which direction we paginate. headOffsetRef is the absolute
  // index of loadedRef[0] in the full list, so we can window from either end:
  // loadNewer appends from (headOffset+len), loadOlder prepends down to 0.
  const loadedRef = useRef<RawMessage[]>([]);
  const headOffsetRef = useRef(0);
  const totalRef = useRef(0);
  const busyRef = useRef(false);
  // Scroll-position anchor: scrollHeight captured just before a prepend so we can
  // keep the reader's viewport fixed over the same content after older messages
  // are inserted above (window-scrolled, so we adjust window scroll by the delta).
  const prependAnchorRef = useRef<number | null>(null);
  // Live-follow only kicks in after the reader scrolls once, so an asc page opens
  // at the top instead of being yanked to the latest message.
  const userScrolledRef = useRef(false);
  // Timestamp of the last scroll-triggered page append; the scroll handler waits
  // out LOAD_COOLDOWN_MS before requesting the next page so each fetched page can
  // render before we measure the edge again (avoids back-to-back page bursts).
  const lastPageLoadAtRef = useRef(0);

  // Free the global fixed-viewport layout (index.css pins html/body/#root to
  // height:100%;overflow:hidden) so the transcript scrolls as a normal page,
  // and inject the chosen light/dark theme. Re-runs when the reader toggles.
  useEffect(() => {
    const style = document.createElement("style");
    style.setAttribute("data-share-viewer", "");
    const themeCss = theme === "dark" ? DARK_STYLE : LIGHT_STYLE;
    style.textContent =
      `html,body,#root{height:auto!important;overflow:visible!important;}\n` +
      `${themeCss}\n` +
      `html,#root{background:${PAGE_BG[theme]}!important;}\n` +
      `body{max-width:${PAGE_MAX}px!important;}\n` +
      `:root{color-scheme:${theme};}`;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, [theme]);

  // One-time meta (cutoff for the limited badge; title/expiry also come from
  // messages). Seeds the viewer theme from the share's creator-set default,
  // unless this reader already toggled it for this share.
  useEffect(() => {
    let cancelled = false;
    getPublicShareMeta(hash)
      .then((m) => {
        if (cancelled) return;
        setTitle(m.title || "Shared conversation");
        setExpiresAt(m.expires_at);
        setCutoffTs(m.cutoff_ts ?? null);
        setHasFiles(Boolean(m.has_files));
        if (typeof m.session_alive === "boolean") setSessionAlive(m.session_alive);
        if (!themeOverriddenRef.current && (m.default_theme === "light" || m.default_theme === "dark")) {
          setTheme(m.default_theme);
        }
      })
      .catch(() => { /* messages fetch surfaces the real error */ });
    return () => { cancelled = true; };
  }, [hash]);

  // Append the next forward page (toward newer) and follow the bottom if the
  // reader is already there. `force` re-checks the server even when the newest
  // end is fully loaded (used by the live poll to pick up new arrivals).
  const loadNewer = useCallback(async (force: boolean): Promise<void> => {
    if (busyRef.current) return;
    const nextOffset = headOffsetRef.current + loadedRef.current.length;
    if (!force && totalRef.current > 0 && nextOffset >= totalRef.current) return;
    // Were we already at the newest end before this fetch? Only then is this a
    // live tail append where following the bottom is wanted. During forward
    // pagination through the middle we must NOT yank to the bottom — that
    // programmatic scroll re-fires onScroll → nearBottom → loadNewer, chaining
    // through every remaining page until the end.
    const wasAtNewestEnd = totalRef.current === 0 || nextOffset >= totalRef.current;
    busyRef.current = true;
    try {
      const data = await getPublicShareMessages(hash, nextOffset, PAGE);
      totalRef.current = data.total;
      setTotal(data.total);
      setTitle((prev) => data.title || prev);
      setExpiresAt(data.expires_at);
      if (typeof data.session_alive === "boolean") setSessionAlive(data.session_alive);
      if (data.messages.length > 0) {
        const wasAtBottom = nearBottom();
        loadedRef.current = loadedRef.current.concat(data.messages);
        setLoadedCount(loadedRef.current.length);
        const html = await renderConversationBody(loadedRef.current);
        setBodyHtml(html);
        lastPageLoadAtRef.current = Date.now();
        if (live && wasAtNewestEnd && wasAtBottom && userScrolledRef.current) {
          requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
        }
      }
    } finally {
      busyRef.current = false;
    }
  }, [hash, live]);

  // Prepend the previous page (toward older) and pin the viewport over the same
  // content via prependAnchorRef (restored in the layout effect below).
  const loadOlder = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    const head = headOffsetRef.current;
    if (head <= 0) return;
    busyRef.current = true;
    try {
      const start = Math.max(0, head - PAGE);
      const data = await getPublicShareMessages(hash, start, head - start);
      totalRef.current = data.total;
      setTotal(data.total);
      if (data.messages.length > 0) {
        prependAnchorRef.current = document.documentElement.scrollHeight;
        loadedRef.current = data.messages.concat(loadedRef.current);
        headOffsetRef.current = start;
        setLoadedCount(loadedRef.current.length);
        const html = await renderConversationBody(loadedRef.current);
        setBodyHtml(html);
        lastPageLoadAtRef.current = Date.now();
      }
    } finally {
      busyRef.current = false;
    }
  }, [hash]);

  // Initial load — re-runs when hash or order changes. desc opens at the latest
  // message (tail fetch, scrolled to bottom); asc opens at the top (offset 0).
  useEffect(() => {
    let cancelled = false;
    loadedRef.current = [];
    headOffsetRef.current = 0;
    totalRef.current = 0;
    userScrolledRef.current = false;
    setLoadedCount(0);
    setBodyHtml("");
    setLoading(true);
    setError(null);
    const run = async () => {
      if (order === "desc") {
        const data = await getPublicShareMessages(hash, 0, PAGE, true);
        if (cancelled) return;
        totalRef.current = data.total;
        setTotal(data.total);
        setTitle((prev) => data.title || prev);
        setExpiresAt(data.expires_at);
        if (typeof data.session_alive === "boolean") setSessionAlive(data.session_alive);
        loadedRef.current = data.messages;
        headOffsetRef.current = Math.max(0, data.total - data.messages.length);
        setLoadedCount(data.messages.length);
        const html = await renderConversationBody(loadedRef.current);
        if (cancelled) return;
        setBodyHtml(html);
        requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
      } else {
        await loadNewer(true);
      }
    };
    run()
      .catch((e) => { if (!cancelled) setError(String(e?.message || e || "加载失败")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, order]);

  // Infinite scroll in both directions: near the bottom pulls newer, near the
  // top pulls older. Also drives the jump-to-bottom button's visibility.
  useEffect(() => {
    if (error) return;
    const onScroll = () => {
      userScrolledRef.current = true;
      setShowJumpBtn(!nearBottom());
      // Pace paginated loads: wait out the cooldown after each appended page so
      // its content has rendered before we measure the edge and request again.
      // Without this, parking at an edge fires a burst of consecutive page
      // requests before the first one lands.
      if (Date.now() - lastPageLoadAtRef.current < LOAD_COOLDOWN_MS) return;
      if (nearBottom()) void loadNewer(false);
      else if (window.scrollY < NEAR_TOP_PX) void loadOlder();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [error, loadNewer, loadOlder]);

  // Live polling — pick up newly appended messages (full + chat; limited shares
  // are frozen). Three gates keep request volume low:
  //   1. Tab visibility — a hidden/background tab polls nothing; returning to
  //      the tab fires one immediate catch-up fetch instead of waiting a tick.
  //   2. Newest end loaded — skip if the reader has paged back through older
  //      messages (the window's tail isn't the latest).
  //   3. Near bottom — skip if they've scrolled up to read history.
  // Only when all three hold does a request go out, at most once per POLL_MS.
  useEffect(() => {
    if (!live || error) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      const atNewestEnd =
        totalRef.current === 0 ||
        headOffsetRef.current + loadedRef.current.length >= totalRef.current;
      if (atNewestEnd && atBottom()) void loadNewer(true);
    };
    const id = window.setInterval(tick, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, error, loadNewer]);

  // Restore scroll position after a prepend so the reader doesn't jump.
  useLayoutEffect(() => {
    if (prependAnchorRef.current != null) {
      const delta = document.documentElement.scrollHeight - prependAnchorRef.current;
      if (delta !== 0) window.scrollBy(0, delta);
      prependAnchorRef.current = null;
    }
  }, [bodyHtml]);

  // Re-wire copy/expand interactions whenever the rendered body changes.
  useEffect(() => {
    if (!bodyRef.current) return;
    return attachInteractions(bodyRef.current);
  }, [bodyHtml]);

  // Auto-fill: if a freshly rendered page doesn't fill the viewport (so the
  // reader can't scroll to trigger the next one), keep loading toward the
  // open end until it does — older for desc, newer for asc. Strictly gated on
  // the page not being scrollable (NOT nearBottom — that's onScroll's job and
  // would chain-load every page), and paced by the same cooldown: if we're
  // still within it, reschedule instead of firing, so each page renders first.
  useEffect(() => {
    if (error || loading) return;
    let timer = 0;
    let raf = 0;
    const attempt = () => {
      const notScrollable = document.documentElement.scrollHeight <= window.innerHeight + 50;
      if (!notScrollable) return;
      const moreNewer = headOffsetRef.current + loadedRef.current.length < totalRef.current;
      const want = order === "desc" ? headOffsetRef.current > 0 : moreNewer;
      if (!want) return;
      const wait = LOAD_COOLDOWN_MS - (Date.now() - lastPageLoadAtRef.current);
      if (wait > 0) { timer = window.setTimeout(attempt, wait); return; }
      if (order === "desc") void loadOlder();
      else void loadNewer(false);
    };
    raf = requestAnimationFrame(attempt);
    return () => { cancelAnimationFrame(raf); if (timer) window.clearTimeout(timer); };
  }, [bodyHtml, error, loading, order, loadNewer, loadOlder]);

  const toggleTheme = () => setTheme((t) => {
    const next = t === "dark" ? "light" : "dark";
    themeOverriddenRef.current = true;
    try { localStorage.setItem(themeKey(hash), next); } catch { /* ignore */ }
    return next;
  });

  const toggleOrder = () => setOrder((o) => {
    const next = o === "asc" ? "desc" : "asc";
    try { localStorage.setItem(orderKey(hash), next); } catch { /* ignore */ }
    return next;
  });

  const jumpToBottom = () => {
    void loadNewer(true);
    requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
  };

  if (error) {
    return (
      <div style={{ maxWidth: 920, margin: "0 auto", padding: "80px 20px", textAlign: "center", color: "#888", fontFamily: "sans-serif" }}>
        <h1 style={{ fontSize: 18, color: "#c0392b" }}>分享已失效或不存在</h1>
        <p style={{ fontSize: 13 }}>This share link is invalid or has expired.</p>
      </div>
    );
  }

  // olderRemaining = messages above the loaded window (toward the start).
  // newerRemaining = messages below it (toward the latest).
  const olderRemaining = headOffsetRef.current;
  const newerRemaining = Math.max(0, total - headOffsetRef.current - loadedCount);

  return (
    <div>
      <header>
        <h1>{title}</h1>
        <div className="meta">
          {isChat ? (
            <span>💬 Chat · 可对话{sessionAlive ? "" : "（会话已离线）"}</span>
          ) : shareType === "full" ? (
            <span>🟢 实时同步</span>
          ) : (
            <span>⏸ 截止于 {cutoffTs ? fmtTime(cutoffTs) : "—"}</span>
          )}
          {expiresAt != null && <span> · {fmtExpiry(expiresAt)}</span>}
          {total > 0 && <span> · 共 {total} 条</span>}
        </div>
      </header>

      <ShareToolBar
        theme={theme}
        order={order}
        hasFiles={hasFiles}
        activeTab={activeTab}
        onToggleTheme={toggleTheme}
        onToggleOrder={toggleOrder}
        onSelectTab={setActiveTab}
      />

      <div style={{ display: hasFiles && activeTab === "files" ? "block" : "none" }}>
        {hasFiles && activeTab === "files" && <ShareFilesTab hash={hash} theme={theme} />}
      </div>

      <div style={{ display: hasFiles && activeTab === "files" ? "none" : "block", paddingBottom: isChat ? 88 : 0 }}>
        {loading && !bodyHtml ? (
          <div style={{ color: "#888", fontSize: 13, fontFamily: "sans-serif" }}>加载中…</div>
        ) : (
          <>
            {olderRemaining > 0 && (
              <div style={{ textAlign: "center", color: "#888", fontSize: 12, padding: "16px 0", fontFamily: "sans-serif" }}>
                上滑加载更早（剩余 {olderRemaining} 条）…
              </div>
            )}
            <div ref={bodyRef} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
            {newerRemaining > 0 && (
              <div style={{ textAlign: "center", color: "#888", fontSize: 12, padding: "16px 0", fontFamily: "sans-serif" }}>
                下滑加载更多（剩余 {newerRemaining} 条）…
              </div>
            )}
          </>
        )}
      </div>

      {showJumpBtn && (!hasFiles || activeTab === "chat") && (
        <button
          type="button"
          onClick={jumpToBottom}
          title="回到最新"
          style={{
            position: "fixed", right: 16, bottom: isChat ? 96 : 20, zIndex: 55,
            width: 40, height: 40, borderRadius: "50%", cursor: "pointer",
            border: `1px solid ${theme === "dark" ? "#444" : "#ddd"}`,
            background: theme === "dark" ? "#1f2428" : "#fff",
            color: theme === "dark" ? "#aaa" : "#666",
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)", fontSize: 16,
          }}
        >
          ↓
        </button>
      )}

      {isChat && activeTab === "chat" && (
        <ShareChatComposer hash={hash} theme={theme} sessionAlive={sessionAlive} />
      )}
    </div>
  );
}
