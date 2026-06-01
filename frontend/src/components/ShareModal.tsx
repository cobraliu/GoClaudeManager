import { useEffect, useState } from "react";
import {
  createShare,
  deleteShare,
  getAllRawMessages,
  listShares,
  type FileAccessSpec,
  type RawMessage,
  type SessionMeta,
  type ShareRecord,
  type ShareTheme,
  type ShareType,
} from "../api/sessionApi";
import { ShareFileSelector } from "./ShareFileSelector";

const PERMANENT_EXPIRES = 2147483647;
const DAY = 86400;

interface Props {
  session: SessionMeta;
  onClose: () => void;
}

type ExpiryPreset = "1d" | "7d" | "30d" | "permanent" | "custom";

function userText(m: RawMessage): string {
  const c = m.message?.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
  }
  return "";
}

function fmtTime(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleString();
}

function fmtExpiry(epochSec: number): string {
  return epochSec >= PERMANENT_EXPIRES ? "永久" : fmtTime(epochSec);
}

function absoluteUrl(url: string): string {
  return /^https?:/i.test(url) ? url : window.location.origin + url;
}

function shareTypeLabel(t: ShareType): string {
  return t === "full" ? "全程同步" : t === "chat" ? "Chat（可对话）" : "限制到截止点";
}

const labelStyle: React.CSSProperties = { fontSize: 12, color: "var(--text-secondary)", marginBottom: 6, display: "block" };
const fieldStyle: React.CSSProperties = {
  fontSize: 13, padding: "6px 10px", background: "var(--bg-surface)",
  color: "var(--text-body)", border: "1px solid var(--border)", borderRadius: 6,
};

export function ShareModal({ session, onClose }: Props) {
  const [tab, setTab] = useState<"create" | "history">("create");

  // ── create form state ──
  const [shareType, setShareType] = useState<ShareType>("full");
  const [defaultTheme, setDefaultTheme] = useState<ShareTheme>("light");
  const [fileAccess, setFileAccess] = useState<FileAccessSpec>({ full: [], files: [] });
  const [preset, setPreset] = useState<ExpiryPreset>("7d");
  const [customDt, setCustomDt] = useState("");
  const [userMsgs, setUserMsgs] = useState<RawMessage[]>([]);
  const [cutoffUuid, setCutoffUuid] = useState("");
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ShareRecord | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // ── history state ──
  const [history, setHistory] = useState<ShareRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [expandedCutoff, setExpandedCutoff] = useState<string | null>(null);

  // Load user messages once when limited is first selected.
  useEffect(() => {
    if (shareType !== "limited" || userMsgs.length > 0 || loadingMsgs) return;
    setLoadingMsgs(true);
    getAllRawMessages(session.id)
      .then((d) => setUserMsgs(d.messages.filter((m) => m.type === "user" && userText(m).length > 0)))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoadingMsgs(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareType]);

  const loadHistory = () => {
    setLoadingHistory(true);
    listShares(session.id)
      .then(setHistory)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoadingHistory(false));
  };

  useEffect(() => {
    if (tab === "history") loadHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const copy = (text: string, key: string) => {
    const done = () => { setCopiedKey(key); setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(done);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.top = "-1000px";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta); done();
    }
  };

  const handleCreate = async () => {
    setErr(null);
    if (shareType === "limited" && !cutoffUuid) { setErr("请选择截止消息"); return; }
    const permanent = preset === "permanent";
    let expires_at: number | undefined;
    if (!permanent) {
      if (preset === "custom") {
        if (!customDt) { setErr("请选择自定义失效时间"); return; }
        expires_at = Math.floor(new Date(customDt).getTime() / 1000);
        if (!expires_at || expires_at * 1000 <= Date.now()) { setErr("失效时间必须晚于当前"); return; }
      } else {
        const days = preset === "1d" ? 1 : preset === "7d" ? 7 : 30;
        expires_at = Math.floor(Date.now() / 1000) + days * DAY;
      }
    }
    setCreating(true);
    try {
      const hasFiles = fileAccess.full.length > 0 || fileAccess.files.length > 0;
      const rec = await createShare(session.id, {
        share_type: shareType,
        permanent,
        expires_at,
        cutoff_after_uuid: shareType === "limited" ? cutoffUuid : undefined,
        default_theme: defaultTheme,
        // chat shares always expose the whole project; the backend forces
        // file_access, so don't send a client value.
        file_access: shareType === "chat" ? undefined : (hasFiles ? fileAccess : undefined),
      });
      setCreated(rec);
      if (tab === "history") loadHistory();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (hash: string) => {
    if (!window.confirm("删除该分享链接？链接将立即失效。")) return;
    try {
      await deleteShare(session.id, hash);
      setHistory((h) => h.filter((r) => r.hash !== hash));
    } catch (e) { setErr(String(e)); }
  };

  const tabBtn = (id: "create" | "history", label: string) => (
    <button
      onClick={() => setTab(id)}
      style={{
        fontSize: 13, padding: "6px 14px", borderRadius: 6, cursor: "pointer",
        background: tab === id ? "var(--bg-hover)" : "transparent",
        color: tab === id ? "var(--text-body)" : "var(--text-faint)",
        border: "1px solid " + (tab === id ? "var(--text-faint)" : "transparent"),
      }}
    >{label}</button>
  );

  const linkRow = (rec: ShareRecord, key: string) => {
    const abs = absoluteUrl(rec.url);
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button onClick={() => copy(abs, key)} style={{ ...fieldStyle, cursor: "pointer", padding: "4px 8px", fontSize: 11 }}>
          {copiedKey === key ? "已复制" : "复制链接"}
        </button>
        <button onClick={() => window.open(rec.url, "_blank")} style={{ ...fieldStyle, cursor: "pointer", padding: "4px 8px", fontSize: 11 }}>
          打开
        </button>
      </div>
    );
  };

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 4000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(760px, 94vw)", maxHeight: "86vh", background: "var(--bg-base)", border: "1px solid var(--border-strong)", borderRadius: 10, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--bg-hover)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, background: "var(--bg-surface)" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-body)" }}>🔗 分享对话 · {session.name}</span>
          <button onClick={onClose} style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: 12, padding: "4px 10px" }}>✕</button>
        </div>

        <div style={{ display: "flex", gap: 8, padding: "10px 16px 0" }}>
          {tabBtn("create", "新建分享")}
          {tabBtn("history", "选择分享历史")}
        </div>

        <div style={{ overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
          {err && <div style={{ color: "var(--accent-red, #e05260)", fontSize: 12 }}>{err}</div>}

          {tab === "create" && (
            <>
              <div>
                <label style={labelStyle}>分享类型</label>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <label style={{ fontSize: 13, color: "var(--text-body)", cursor: "pointer" }}>
                    <input type="radio" checked={shareType === "full"} onChange={() => setShareType("full")} /> 全程同步（后续对话持续可见）
                  </label>
                  <label style={{ fontSize: 13, color: "var(--text-body)", cursor: "pointer" }}>
                    <input type="radio" checked={shareType === "limited"} onChange={() => setShareType("limited")} /> 限制到截止点
                  </label>
                  <label style={{ fontSize: 13, color: "var(--text-body)", cursor: "pointer" }}>
                    <input type="radio" checked={shareType === "chat"} onChange={() => setShareType("chat")} /> Chat
                  </label>
                </div>
              </div>

              {shareType === "chat" && (
                <div style={{ border: "1px solid #e05260", background: "rgba(224,82,96,0.10)", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.6, color: "#e05260" }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠️ 高危：可对话分享</div>
                  任何拿到此链接的人都能<b>向该活跃会话发送对话指令</b>（Claude 可执行命令、修改文件），并<b>只读浏览整个项目的全部文件</b>。链接即权限，请仅分享给可信任的人。
                </div>
              )}

              <div>
                <label style={labelStyle}>失效时间</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {([["1d", "1 天"], ["7d", "7 天"], ["30d", "30 天"], ["permanent", "永久"], ["custom", "自定义"]] as [ExpiryPreset, string][]).map(([id, lbl]) => (
                    <button key={id} onClick={() => setPreset(id)} style={{ ...fieldStyle, cursor: "pointer", borderColor: preset === id ? "var(--accent-blue)" : "var(--border)", color: preset === id ? "var(--accent-blue)" : "var(--text-body)" }}>{lbl}</button>
                  ))}
                  {preset === "custom" && (
                    <input type="datetime-local" value={customDt} onChange={(e) => setCustomDt(e.target.value)} style={fieldStyle} />
                  )}
                </div>
              </div>

              <div>
                <label style={labelStyle}>默认主题（查看者仍可切换）</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {([["light", "☀️ 浅色"], ["dark", "🌙 深色"]] as [ShareTheme, string][]).map(([id, lbl]) => (
                    <button key={id} onClick={() => setDefaultTheme(id)} style={{ ...fieldStyle, cursor: "pointer", borderColor: defaultTheme === id ? "var(--accent-blue)" : "var(--border)", color: defaultTheme === id ? "var(--accent-blue)" : "var(--text-body)" }}>{lbl}</button>
                  ))}
                </div>
              </div>

              {shareType === "chat" ? (
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  📁 Chat 分享自动开放整个项目（只读，自动排除 .git / node_modules 等），无需单独勾选文件。
                </div>
              ) : (
                <div>
                  <label style={labelStyle}>可公开查看的文件（可选 · 勾选后分享页出现 Files 标签）</label>
                  <ShareFileSelector sessionId={session.id} value={fileAccess} onChange={setFileAccess} />
                </div>
              )}

              {shareType === "limited" && (
                <div>
                  <label style={labelStyle}>选择截止消息（取该用户消息后第一条 turn 完成时刻）</label>
                  {loadingMsgs ? (
                    <div style={{ fontSize: 12, color: "var(--text-faint)" }}>加载消息中…</div>
                  ) : (
                    <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
                      {userMsgs.length === 0 && <div style={{ fontSize: 12, color: "var(--text-faint)", padding: 10 }}>无可选用户消息</div>}
                      {userMsgs.map((m) => {
                        const uuid = m.uuid || "";
                        const sel = uuid === cutoffUuid;
                        const txt = userText(m);
                        return (
                          <div
                            key={uuid}
                            onClick={() => setCutoffUuid(uuid)}
                            style={{ padding: "6px 10px", cursor: "pointer", fontSize: 12, background: sel ? "var(--bg-hover)" : "transparent", color: sel ? "var(--accent-blue)" : "var(--text-body)", borderBottom: "1px solid var(--bg-hover)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                            title={txt}
                          >
                            {sel ? "● " : "○ "}{m.timestamp ? `[${new Date(m.timestamp).toLocaleString()}] ` : ""}{txt.slice(0, 80)}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div>
                <button onClick={handleCreate} disabled={creating} style={{ ...fieldStyle, cursor: "pointer", background: "var(--accent-blue)", color: "#fff", borderColor: "var(--accent-blue)", padding: "8px 18px", fontSize: 13 }}>
                  {creating ? "生成中…" : "生成分享链接"}
                </button>
              </div>

              {created && (
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {shareTypeLabel(created.share_type)} · 失效：{fmtExpiry(created.expires_at)}
                  </div>
                  <input readOnly value={absoluteUrl(created.url)} style={{ ...fieldStyle, fontFamily: "monospace" }} onFocus={(e) => e.currentTarget.select()} />
                  {linkRow(created, "created")}
                </div>
              )}
            </>
          )}

          {tab === "history" && (
            <>
              {loadingHistory ? (
                <div style={{ fontSize: 12, color: "var(--text-faint)" }}>加载中…</div>
              ) : history.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-faint)" }}>暂无分享记录</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: "var(--text-faint)", textAlign: "left" }}>
                      <th style={{ padding: "6px 8px" }}>创建时间</th>
                      <th style={{ padding: "6px 8px" }}>失效时间</th>
                      <th style={{ padding: "6px 8px" }}>截止用户消息输入</th>
                      <th style={{ padding: "6px 8px" }}>链接</th>
                      <th style={{ padding: "6px 8px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((rec) => {
                      const full = rec.cutoff_msg_text || "";
                      const isExpanded = expandedCutoff === rec.hash;
                      return (
                        <tr key={rec.hash} style={{ borderTop: "1px solid var(--bg-hover)", color: "var(--text-body)" }}>
                          <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{fmtTime(rec.created_at)}</td>
                          <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{fmtExpiry(rec.expires_at)}</td>
                          <td style={{ padding: "6px 8px", maxWidth: 220 }}>
                            {rec.share_type === "limited" && full ? (
                              <span
                                onClick={() => setExpandedCutoff(isExpanded ? null : rec.hash)}
                                style={{ cursor: "pointer", color: "var(--accent-blue)" }}
                                title="点击展开/收起全文"
                              >
                                {isExpanded ? full : full.slice(0, 32) + (full.length > 32 ? "…" : "")}
                              </span>
                            ) : (
                              <span style={{ color: "var(--text-faint)" }}>—（{shareTypeLabel(rec.share_type)}）</span>
                            )}
                          </td>
                          <td style={{ padding: "6px 8px" }}>{linkRow(rec, rec.hash)}</td>
                          <td style={{ padding: "6px 8px" }}>
                            <button onClick={() => handleDelete(rec.hash)} style={{ ...fieldStyle, cursor: "pointer", padding: "4px 8px", fontSize: 11, color: "var(--accent-red, #e05260)" }}>删除</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
