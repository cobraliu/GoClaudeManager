import { useCallback, useEffect, useRef, useState } from "react";
import {
  startClaudeLogin,
  claudeLoginStatus,
  submitClaudeLoginCode,
  cancelClaudeLogin,
  type ClaudeLoginStatus,
} from "../api/sessionApi";

interface Props {
  open: boolean;
  onClose: () => void;
}

// Assisted Claude CLI login (/login OAuth). Drives the singleton `claude-login`
// tmux session on the server: start → scrape auth URL → user opens it & pastes
// the code → we send it back → detect success. Admin-only (rewrites the shared
// ~/.claude/.credentials.json).
export default function ClaudeLoginModal({ open, onClose }: Props) {
  const [status, setStatus] = useState<ClaudeLoginStatus>({ state: "idle" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showScreen, setShowScreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPoll = useCallback(() => {
    stopPoll();
    pollRef.current = window.setInterval(async () => {
      try {
        const s = await claudeLoginStatus();
        setStatus(s);
        if (s.state === "success" || s.state === "error" || s.state === "idle") {
          stopPoll();
        }
      } catch {
        /* transient — keep polling */
      }
    }, 1500);
  }, [stopPoll]);

  // Reset + stop polling when closed.
  useEffect(() => {
    if (!open) {
      stopPoll();
      setStatus({ state: "idle" });
      setCode("");
      setErr("");
      setBusy(false);
      setShowScreen(false);
      setCopied(false);
    }
    return stopPoll;
  }, [open, stopPoll]);

  const handleStart = async () => {
    setBusy(true);
    setErr("");
    try {
      const s = await startClaudeLogin();
      setStatus(s);
      if (s.state !== "success" && s.state !== "error") startPoll();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitCode = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setErr("");
    stopPoll();
    try {
      const s = await submitClaudeLoginCode(code.trim());
      setStatus(s);
      if (s.state !== "success" && s.state !== "error") startPoll();
    } catch (e) {
      setErr(String(e));
      startPoll();
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    stopPoll();
    setBusy(true);
    try {
      await cancelClaudeLogin();
    } catch {
      /* ignore */
    }
    setStatus({ state: "idle" });
    setCode("");
    setBusy(false);
  };

  const copyUrl = async () => {
    if (!status.url) return;
    try {
      await navigator.clipboard.writeText(status.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };

  if (!open) return null;

  const stateLabel: Record<ClaudeLoginStatus["state"], string> = {
    idle: "未开始",
    starting: "启动中…",
    awaiting_code: "等待授权码",
    success: "登录成功",
    error: "出错",
  };
  const stateColor: Record<ClaudeLoginStatus["state"], string> = {
    idle: "var(--text-muted)",
    starting: "var(--text-secondary)",
    awaiting_code: "#d29922",
    success: "#3fb950",
    error: "#f85149",
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
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 94vw)", maxHeight: "88vh",
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
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-body)" }}>
            🔑 Claude 登录 (assisted)
          </span>
          <button onClick={onClose} style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: 12, padding: "4px 10px" }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: "var(--text-secondary)" }}>
            驱动服务器上的 <code>claude /login</code> OAuth 流程，更新所有 session 共享的登录凭据。
            点击「开始登录」后会获得一个授权链接，在浏览器中完成登录拿到 code，粘贴回此处即可。
          </p>

          {/* State badge */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <span style={{ color: "var(--text-muted)" }}>状态：</span>
            <span style={{ color: stateColor[status.state], fontWeight: 600 }}>
              {stateLabel[status.state]}
            </span>
          </div>

          {/* Start button (idle) */}
          {(status.state === "idle" || status.state === "error") && (
            <button
              onClick={handleStart}
              disabled={busy}
              style={{
                alignSelf: "flex-start", background: "var(--accent, #2f81f7)", color: "#fff",
                fontSize: 13, fontWeight: 600, padding: "8px 18px", borderRadius: 6,
                opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "请稍候…" : status.state === "error" ? "重新登录" : "开始登录"}
            </button>
          )}

          {/* Auth URL + code input (awaiting_code) */}
          {status.state === "awaiting_code" && status.url && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>1. 打开授权链接并登录：</div>
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                background: "var(--bg-surface)", border: "1px solid var(--bg-hover)",
                borderRadius: 6, padding: "6px 8px",
              }}>
                <a
                  href={status.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    flex: 1, fontSize: 11.5, color: "#58a6ff", wordBreak: "break-all",
                    fontFamily: "monospace", lineHeight: 1.4,
                  }}
                >
                  {status.url}
                </a>
                <button
                  onClick={copyUrl}
                  style={{ flexShrink: 0, background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: 11, padding: "4px 10px" }}
                >
                  {copied ? "已复制" : "复制"}
                </button>
              </div>

              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>2. 粘贴授权码：</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSubmitCode(); }}
                  placeholder="粘贴 auth code"
                  autoFocus
                  style={{
                    flex: 1, background: "var(--bg-surface)", border: "1px solid var(--bg-hover)",
                    borderRadius: 6, padding: "7px 10px", color: "var(--text-body)", fontSize: 12.5,
                    fontFamily: "monospace",
                  }}
                />
                <button
                  onClick={handleSubmitCode}
                  disabled={busy || !code.trim()}
                  style={{
                    background: "var(--accent, #2f81f7)", color: "#fff", fontSize: 13, fontWeight: 600,
                    padding: "7px 16px", borderRadius: 6, opacity: (busy || !code.trim()) ? 0.6 : 1,
                    cursor: (busy || !code.trim()) ? "default" : "pointer",
                  }}
                >
                  提交
                </button>
              </div>
            </div>
          )}

          {/* Success */}
          {status.state === "success" && (
            <div style={{ fontSize: 13, color: "#3fb950", fontWeight: 600 }}>
              ✓ {status.message || "登录成功，凭据已更新。"}
            </div>
          )}

          {/* Error / message */}
          {status.state === "error" && status.message && (
            <div style={{ fontSize: 12.5, color: "#f85149" }}>{status.message}</div>
          )}
          {err && <div style={{ fontSize: 12, color: "#f85149" }}>{err}</div>}

          {/* Terminal output (debug) */}
          {status.screen && (
            <div>
              <button
                onClick={() => setShowScreen((v) => !v)}
                style={{ background: "transparent", color: "var(--text-muted)", fontSize: 11.5, padding: 0 }}
              >
                {showScreen ? "▾ 隐藏终端输出" : "▸ 终端输出"}
              </button>
              {showScreen && (
                <pre style={{
                  margin: "8px 0 0", maxHeight: 220, overflow: "auto",
                  background: "#0d1117", color: "#c9d1d9", fontSize: 10.5, lineHeight: 1.45,
                  padding: 10, borderRadius: 6, whiteSpace: "pre-wrap", wordBreak: "break-all",
                }}>
                  {status.screen}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "10px 16px", borderTop: "1px solid var(--bg-hover)",
          display: "flex", justifyContent: "flex-end", gap: 8, flexShrink: 0,
          background: "var(--bg-surface)",
        }}>
          {(status.state === "starting" || status.state === "awaiting_code") && (
            <button
              onClick={handleCancel}
              disabled={busy}
              style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: 12, padding: "6px 14px" }}
            >
              取消登录
            </button>
          )}
          <button onClick={onClose} style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: 12, padding: "6px 14px" }}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
