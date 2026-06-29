import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { parseJsonlFile } from "../api/sessionApi";
import { IconSun, IconMoon } from "../components/icons";
import { renderConversationBody, LIGHT_STYLE, DARK_STYLE } from "../lib/exportChat";
import { attachInteractions } from "../lib/chatInteractions";

type Theme = "dark" | "light";

interface Props {
  onBack: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

const PAGE_BG: Record<Theme, string> = { light: "#fafafa", dark: "#1a1a1a" };
const PAGE_MAX = 1920;
const TOOLBAR_H = 48;

type Status = "idle" | "parsing" | "done" | "error";

/** Standalone utility: upload a .jsonl transcript and render it as the system's
 *  Chat view. Parsing happens server-side (POST /api/tools/jsonl-parse, which
 *  reuses the same parser a live session uses), so ordering/shape match exactly;
 *  rendering reuses renderConversationBody (same engine as the share viewer). */
export function JsonlChatToolPage({ onBack, theme, onToggleTheme }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [bodyHtml, setBodyHtml] = useState("");
  const [fileName, setFileName] = useState("");
  const [total, setTotal] = useState(0);
  const [rendered, setRendered] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const dark = theme === "dark";
  const c = {
    bg: dark ? "rgba(26,26,26,0.97)" : "rgba(255,255,255,0.97)",
    border: dark ? "#444" : "#ddd",
    text: dark ? "#ddd" : "#333",
    muted: dark ? "#888" : "#999",
    accent: dark ? "#58a6ff" : "#2563eb",
    accentBg: dark ? "rgba(88,166,255,0.15)" : "rgba(37,99,235,0.08)",
    err: dark ? "#ff7b72" : "#c0392b",
  };

  // Inject the chat CSS + free the global fixed layout so the transcript scrolls
  // as a normal page; cleaned up on unmount (returns the app to its own layout).
  useEffect(() => {
    const style = document.createElement("style");
    style.setAttribute("data-jsonl-tool", "");
    const themeCss = dark ? DARK_STYLE : LIGHT_STYLE;
    style.textContent =
      `html,body,#root{height:auto!important;overflow:visible!important;}\n` +
      `${themeCss}\n` +
      `html,#root{background:${PAGE_BG[theme]}!important;}\n` +
      `body{max-width:${PAGE_MAX}px!important;}\n` +
      `:root{color-scheme:${theme};}`;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, [theme, dark]);

  // Re-wire copy buttons whenever the rendered body changes.
  useEffect(() => {
    if (!bodyRef.current) return;
    return attachInteractions(bodyRef.current);
  }, [bodyHtml]);

  const handleFile = useCallback(async (file: File) => {
    setStatus("parsing");
    setError(null);
    setFileName(file.name);
    setBodyHtml("");
    try {
      const { messages, total } = await parseJsonlFile(file);
      const html = await renderConversationBody(messages);
      setTotal(total);
      setRendered(messages.length);
      setBodyHtml(html);
      setStatus("done");
    } catch (e) {
      setError(String((e as Error)?.message || e || "解析失败"));
      setStatus("error");
    }
  }, []);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleFile(f);
    e.target.value = ""; // allow re-selecting the same file
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  const btn = (primary?: boolean): CSSProperties => ({
    fontSize: 13, padding: "6px 14px", borderRadius: 6, cursor: "pointer",
    border: `1px solid ${primary ? c.accent : c.border}`,
    background: primary ? c.accentBg : "transparent",
    color: primary ? c.accent : c.text,
    whiteSpace: "nowrap", fontFamily: "sans-serif",
  });

  return (
    <div>
      {/* Sticky toolbar — inline static colors so it doesn't depend on app CSS
          vars (the injected chat CSS owns :root while this page is shown). */}
      <div style={{
        position: "sticky", top: 0, height: TOOLBAR_H, zIndex: 60,
        display: "flex", alignItems: "center", gap: 8, padding: "0 12px",
        borderBottom: `1px solid ${c.border}`, background: c.bg,
        backdropFilter: "blur(6px)", boxShadow: "0 1px 4px rgba(0,0,0,0.10)",
        fontFamily: "sans-serif", boxSizing: "border-box",
      }}>
        <button type="button" style={btn()} onClick={onBack}>← 返回</button>
        <span style={{ fontWeight: 600, color: c.text }}>JSONL → Chat 预览</span>
        {status === "done" && (
          <span style={{ fontSize: 12, color: c.muted }}>
            {fileName} · 共 {total} 条 / 渲染 {rendered} 条
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button type="button" style={btn(true)} onClick={() => fileInputRef.current?.click()}>
          {status === "done" || status === "error" ? "重新上传" : "选择 .jsonl 文件"}
        </button>
        <button type="button" style={btn()} onClick={onToggleTheme} title="切换深色 / 浅色">
          {dark ? <><IconSun style={{ verticalAlign: "-0.15em" }} /> 浅色</> : <><IconMoon style={{ verticalAlign: "-0.15em" }} /> 深色</>}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".jsonl,.json,application/jsonl"
          style={{ display: "none" }}
          onChange={onPick}
        />
      </div>

      {/* Content */}
      {status === "idle" && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            margin: "40px auto", maxWidth: 560, padding: "48px 24px",
            border: `2px dashed ${dragOver ? c.accent : c.border}`,
            borderRadius: 12, textAlign: "center", cursor: "pointer",
            background: dragOver ? c.accentBg : "transparent",
            color: c.muted, fontFamily: "sans-serif",
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 10 }}>🧩</div>
          <div style={{ fontSize: 15, color: c.text, marginBottom: 6 }}>拖入或点击选择 .jsonl 文件</div>
          <div style={{ fontSize: 12 }}>会按本系统 Chat 模式渲染会话记录（只读，不保存）</div>
        </div>
      )}
      {status === "parsing" && (
        <div style={{ textAlign: "center", padding: "60px 20px", color: c.muted, fontFamily: "sans-serif", fontSize: 14 }}>
          解析并渲染中…
        </div>
      )}
      {status === "error" && (
        <div style={{ maxWidth: 560, margin: "40px auto", padding: "20px", color: c.err, fontFamily: "sans-serif", fontSize: 14, textAlign: "center" }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>解析失败</div>
          <div style={{ fontSize: 13 }}>{error}</div>
        </div>
      )}
      {status === "done" && rendered === 0 && (
        <div style={{ textAlign: "center", padding: "60px 20px", color: c.muted, fontFamily: "sans-serif", fontSize: 14 }}>
          没有可渲染的消息（文件为空或不是有效的 JSONL 会话记录）。
        </div>
      )}
      {status === "done" && rendered > 0 && (
        <div ref={bodyRef} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      )}
    </div>
  );
}
