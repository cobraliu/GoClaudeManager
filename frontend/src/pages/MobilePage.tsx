import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import hljs from "highlight.js/lib/common";
import { marked } from "../lib/markdown";
import {
  listSessions,
  listSessionsStatus,
  getSession,
  createSession,
  attachSession,
  resumeSession,
  terminateSession,
  deleteSession,
  getConfig,
  getConversation,
  getGitInfo,
  getGitBranches,
  getGitGraph,
  gitCheckoutBranch,
  GitCheckoutConflictError,
  gitPull,
  gitRollback,
  gitManualCommit,
  getCommitDetail,
  renameSession,
  createTask,
  cancelTask,
  restartServer,
  saveGitignore,
  gitSetRemote,
  listFiles,
  searchFiles,
  createDir,
  uploadFile,
  renameEntry,
  moveEntry,
  deleteEntry,
  listDirs,
  writeFile,
  getFileGitLog,
  getFileGitShow,
  getFileGitDiff,
  getDirInfo,
  downloadDirZip,
  readFile,
  sqliteQuery,
  sqliteExec,
  createTerminal,
  deleteTerminal,
  heartbeatTerminal,
  issueTerminalToken,
  listTerminals,
  renameTerminal,
  type TerminalInfo,
  listAvailableClaudeSessions,
  setClaudeSessionId,
  fetchRawFileBlob,
  browseExternalSessions,
  browseCodexSessions,
  browseCursorSessions,
  getExternalPreview,
  type ExternalPreview,
  getMergeStatus,
  getMergePreview,
  getMergeFileDiff,
  gitMergeStart,
  gitMergeAbort,
  gitMergeContinue,
  getMergeConflictFile,
  gitResolveFile,
  type MergeStatus,
  type MergePreview,
  type ConflictFileVersions,
  listModels,
  setSessionModel,
  getSystemFonts,
  setTerminalFont,
  type FontInfo,
  listSessionTodos,
  listGoals,
  listSessionAuqs,
  type TodoItem,
  type TodoPlan,
  type Goal,
  type AuqEntry,
  type ExternalSession,
  type ExternalSessionGroup,
  type SessionMeta,
  type ModelInfo,
  type ConversationTurn,
  type GitLogEntry,
  type GitBranchInfo,
  type GitGraphCommit,
  type GitDiffFile,
  type ScheduledTask,
  type FileEntry,
  type SqliteInfo,
  type AvailableClaudeSession,
  type UsageInfo,
  type TuiAuqData,
  type TuiApproveData,
  type TuiPlanData,
  type LostMessage,
  getUsageInfo,
  createShare,
  listShares,
  deleteShare,
  getAllRawMessages,
  getAvailableTools,
  type RawMessage,
  type ShareRecord,
  type ShareTheme,
  type ShareType,
  type FileAccessSpec,
} from "../api/sessionApi";
import { ShareFileSelector } from "../components/ShareFileSelector";
import gitIcon from "../assets/git.svg";
import terminalIcon from "../assets/terminal.svg";
import scheduleIcon from "../assets/schedule.svg";
import { ConfigFormatToggle } from "../components/ConfigFormatToggle";
import { ConfigCheckButton } from "../components/ConfigCheckButton";
import { ConfigValidationBanner } from "../components/ConfigValidationBanner";
import { detectFormat, convert, extFor, type ConfigFormat } from "../lib/configConvert";
import { ShadowRewindSection } from "../components/ShadowRewindSection";
import { TerminalPane } from "../components/TerminalPane";
import { TuiPane } from "../components/TuiPane";
import { ConversationPane } from "../components/ConversationPane";
import { PromptText } from "../components/SessionCard";
import { UsageBar } from "../components/UsageBar";
import { WsClient } from "../lib/wsClient";
import { ClaudeCapsModal } from "../components/ClaudeCapsModal";
import { JsonlPreviewModal } from "../components/JsonlPreviewModal";
import { MemoryPanel } from "../components/MemoryPanel";
import { downloadConversationHtml } from "../lib/exportChat";
import { DownloadExclusionModal } from "../components/DownloadExclusionModal";
import { GitGraph } from "../components/GitGraph";
import { FileIcon, NewFolderIcon } from "../components/FileIcon";
import { HtmlViewer } from "../components/HtmlViewer";
import CodexChatInput from "../components/CodexChatInput";
import { useFsWatch } from "../lib/useFsWatch";
import { apiPath } from "../lib/baseUrl";
import type { DirInfoResponse } from "../api/sessionApi";

const MOBILE_PAGE_SIZE = 10;
const POLL_INTERVAL = 1000;

/* ══════════════════════════════════════════════════
   Terminal line buffer — handles ANSI + \r overwrite
   ══════════════════════════════════════════════════ */
class TerminalLineBuffer {
  private lines: string[] = [""];
  private row = 0;
  private col = 0;

  feed(raw: string): void {
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];

      // ESC sequences
      if (ch === "\x1B") {
        i++;
        if (i >= raw.length) break;
        if (raw[i] === "[") {
          // CSI: ESC [ <params> <cmd>
          i++;
          let params = "";
          while (i < raw.length && !this.isCsiEnd(raw[i])) params += raw[i++];
          if (i < raw.length) { this.handleCsi(raw[i], params); i++; }
        } else if (raw[i] === "]") {
          // OSC: ESC ] … BEL or ST
          i++;
          while (i < raw.length && raw[i] !== "\x07" && raw[i] !== "\x1B") i++;
          if (i < raw.length && raw[i] === "\x07") i++;
          else if (i < raw.length && raw[i] === "\x1B") i += 2;
        } else {
          // Two-char escape — skip
          i++;
        }
        continue;
      }

      // Control characters
      if (ch === "\r") {
        this.col = 0;
      } else if (ch === "\n") {
        this.row++;
        this.col = 0;
        if (this.lines.length <= this.row) this.lines.push("");
      } else if (ch === "\b") {
        this.col = Math.max(0, this.col - 1);
      } else if (ch >= " ") {
        // Printable
        while (this.lines.length <= this.row) this.lines.push("");
        while (this.lines[this.row].length < this.col) this.lines[this.row] += " ";
        this.lines[this.row] =
          this.lines[this.row].slice(0, this.col) +
          ch +
          this.lines[this.row].slice(this.col + 1);
        this.col++;
      }
      i++;
    }
  }

  private isCsiEnd(ch: string): boolean {
    const c = ch.charCodeAt(0);
    return c >= 0x40 && c <= 0x7e;
  }

  private handleCsi(cmd: string, params: string): void {
    const ns = params.split(";").map((p) => parseInt(p) || 0);
    const n = ns[0] || 1;
    switch (cmd) {
      case "A": this.row = Math.max(0, this.row - n); break;
      case "B": this.row += n; while (this.lines.length <= this.row) this.lines.push(""); break;
      case "C": this.col += n; break;
      case "D": this.col = Math.max(0, this.col - n); break;
      case "H": case "f":
        this.row = Math.max(0, (ns[0] || 1) - 1);
        this.col = Math.max(0, (ns[1] || 1) - 1);
        while (this.lines.length <= this.row) this.lines.push("");
        break;
      case "J":
        if (ns[0] === 2 || ns[0] === 3) { this.lines = [""]; this.row = 0; this.col = 0; }
        else if (ns[0] === 0) { this.lines[this.row] = this.lines[this.row].slice(0, this.col); this.lines.splice(this.row + 1); }
        break;
      case "K":
        if (ns[0] === 0) this.lines[this.row] = (this.lines[this.row] || "").slice(0, this.col);
        else if (ns[0] === 2) { this.lines[this.row] = ""; this.col = 0; }
        break;
    }
  }

  reset(): void { this.lines = [""]; this.row = 0; this.col = 0; }

  getText(): string {
    let end = this.lines.length - 1;
    while (end > 0 && !this.lines[end].trim()) end--;
    return this.lines.slice(0, end + 1).join("\n");
  }
}

/* ─── Mobile Usage Row ─── */
function MobileUsageRow() {
  return (
    <div style={{
      padding: "6px 14px",
      background: "var(--bg-surface)",
      borderBottom: "1px solid var(--border-subtle)",
      flexShrink: 0,
    }}>
      <UsageBar />
    </div>
  );
}

/* ─── Create Session Modal ─── */
function CreateModal({
  workspaceBase, username, enabledTools, onClose, onCreate,
}: { workspaceBase: string; username: string; enabledTools: string[]; onClose: () => void; onCreate: (s: SessionMeta) => void }) {
  const [project, setProject] = useState("");
  const [suffix, setSuffix] = useState("");
  const toolOptions = (["claude", "codex"] as const).filter((t) => enabledTools.includes(t));
  const initialTool: "claude" | "codex" = (toolOptions[0] as "claude" | "codex" | undefined) ?? "claude";
  const [tool, setTool] = useState<"claude" | "codex">(initialTool);
  const [codexTransport, setCodexTransport] = useState<"tui" | "app_server">("tui");
  const [claudeTransport, setClaudeTransport] = useState<"tmux" | "sdk">("tmux");
  const [sdkAvailable, setSdkAvailable] = useState(false);
  useEffect(() => {
    getAvailableTools().then((t) => setSdkAvailable(!!t.claude_sdk)).catch(() => setSdkAvailable(false));
  }, []);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const prefix = `${workspaceBase}/${username}/`;

  const submit = async () => {
    if (!project.trim()) return;
    setLoading(true); setErr("");
    try {
      const cwd = suffix.trim() ? prefix + suffix.trim() : undefined;
      const params = {
        project: project.trim(),
        cwd,
        tool,
        ...(tool === "codex" ? { codex_transport: codexTransport } : {}),
        ...(tool === "claude" && claudeTransport === "sdk" ? { transport: "sdk" as const } : {}),
      };
      onCreate(await createSession(params));
    } catch (e) { setErr(String(e)); } finally { setLoading(false); }
  };

  const pillBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "8px 10px",
    fontSize: 13,
    borderRadius: 6,
    border: "1px solid " + (active ? "var(--accent-blue)" : "var(--border)"),
    background: active ? "rgba(88,166,255,0.15)" : "var(--bg-main)",
    color: active ? "var(--text-body)" : "var(--text-secondary)",
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    textTransform: "capitalize" as const,
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "flex-end" }} onClick={onClose}>
      <div style={{ width: "100%", background: "var(--bg-surface)", borderRadius: "16px 16px 0 0", padding: "20px 16px 36px", display: "flex", flexDirection: "column", gap: 12 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ width: 36, height: 4, background: "var(--border)", borderRadius: 2, margin: "0 auto 4px" }} />
        <h3 style={{ margin: 0, fontSize: 16, color: "var(--text-primary)" }}>New Session</h3>
        <input placeholder="Project name *" value={project} onChange={(e) => setProject(e.target.value)} autoFocus style={inp} />
        {toolOptions.length > 1 && (
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Agent</div>
            <div style={{ display: "flex", gap: 6 }}>
              {toolOptions.map(k => (
                <button key={k} onClick={() => setTool(k)} style={pillBtn(tool === k)}>{k}</button>
              ))}
            </div>
          </div>
        )}
        {tool === "codex" && (
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Transport</div>
            <div style={{ display: "flex", gap: 6 }}>
              {(["tui", "app_server"] as const).map(k => (
                <button key={k} onClick={() => setCodexTransport(k)} style={pillBtn(codexTransport === k)}>
                  {k === "tui" ? "TUI (default)" : "App-server"}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>
              {codexTransport === "tui"
                ? "Interactive terminal — full chat + paste support."
                : "Programmatic JSON-RPC — chat in app, live AUQ/approval."}
            </div>
          </div>
        )}
        {tool === "claude" && (
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Transport</div>
            <div style={{ display: "flex", gap: 6 }}>
              {(["tmux", "sdk"] as const).map(k => {
                const disabled = k === "sdk" && !sdkAvailable;
                return (
                  <button
                    key={k}
                    onClick={() => !disabled && setClaudeTransport(k)}
                    disabled={disabled}
                    style={{ ...pillBtn(claudeTransport === k), ...(disabled ? { opacity: 0.5, cursor: "not-allowed" } : {}), textTransform: "none" as const }}
                  >
                    {k === "tmux" ? "tmux (默认)" : "SDK"}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>
              {claudeTransport === "tmux"
                ? "tmux send-keys 屏幕驱动（默认）。"
                : "claude-structured NDJSON 协议 — 自动放行工具权限，AUQ/计划仍在 Chat 确认。"}
              {!sdkAvailable && "（SDK 不可用：未找到 claude-structured binary）"}
            </div>
          </div>
        )}
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>Working directory (optional)</div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "monospace", marginBottom: 4 }}>{prefix}</div>
          <input placeholder="subdir" value={suffix} onChange={(e) => setSuffix(e.target.value)} style={inp} />
        </div>
        {err && <div style={{ fontSize: 12, color: "var(--accent-red)" }}>{err}</div>}
        <button onClick={submit} disabled={loading || !project.trim()} style={{ ...btn, background: "var(--accent-green)", color: "#fff", opacity: loading || !project.trim() ? 0.5 : 1 }}>
          {loading ? "Creating…" : "Create Session"}
        </button>
        <button onClick={onClose} style={{ ...btn, background: "var(--bg-hover)", color: "var(--text-secondary)" }}>Cancel</button>
      </div>
    </div>
  );
}

/* ─── Browse External Sessions Panel (mobile) ─── */
function relativeTime(mtime: number): string {
  const diff = Date.now() / 1000 - mtime;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(mtime * 1000).toLocaleDateString();
}

function MobileSessionPreviewModal({
  session, tool, onClose,
}: { session: ExternalSession; tool: "claude" | "codex" | "cursor"; onClose: () => void }) {
  const [preview, setPreview] = useState<ExternalPreview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getExternalPreview(session.agent_session_id, session.cwd, tool)
      .then(setPreview)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [session.agent_session_id, session.cwd, tool]);

  const turns = preview?.turns ?? [];
  const splitAt = preview && preview.truncated_before > 0 ? 100 : turns.length;

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 500, display: "flex", flexDirection: "column" }}>
      <div style={{ flexShrink: 0, background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1, flexShrink: 0 }}>‹</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.title || "No title"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.cwd}
          </div>
        </div>
        {preview && (
          <span style={{ fontSize: 11, color: "var(--text-faint)", flexShrink: 0 }}>{preview.total} turns</span>
        )}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        {loading && <div style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", marginTop: 32 }}>Loading…</div>}
        {!loading && !preview && <div style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", marginTop: 32 }}>Failed to load preview.</div>}
        {preview && (
          <>
            {turns.slice(0, splitAt).map((t, i) => (
              <PreviewTurnBubble key={`head-${i}`} turn={t} />
            ))}
            {preview.truncated_before > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0" }}>
                <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                <span style={{ fontSize: 11, color: "var(--text-faint)", flexShrink: 0, padding: "2px 10px", background: "var(--bg-surface)", borderRadius: 12, border: "1px solid var(--border)" }}>
                  … {preview.truncated_before} messages omitted …
                </span>
                <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              </div>
            )}
            {preview.truncated_before > 0 && turns.slice(100).map((t, i) => (
              <PreviewTurnBubble key={`tail-${i}`} turn={t} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function PreviewTurnBubble({ turn }: { turn: { role: string; text: string; ts: number } }) {
  const isUser = turn.role === "user";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
      <div style={{
        maxWidth: "90%", padding: "8px 12px", borderRadius: 10, fontSize: 13, lineHeight: 1.5,
        background: isUser ? "var(--accent-blue)" : "var(--bg-surface)",
        color: isUser ? "#fff" : "var(--text-body)",
        border: isUser ? "none" : "1px solid var(--border)",
        whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}>
        {turn.text.length > 600 ? turn.text.slice(0, 600) + "…" : turn.text}
      </div>
    </div>
  );
}

type ExternalTool = "claude" | "codex" | "cursor";

function MobileBrowseExternalPanel({
  onClose, onLoad, enabledTools,
}: { onClose: () => void; onLoad: (ext: ExternalSession, tool: ExternalTool) => Promise<void>; enabledTools: string[] }) {
  const tabOptions = (["claude", "codex", "cursor"] as const).filter((t) => enabledTools.includes(t)) as ExternalTool[];
  const initialTab: ExternalTool = tabOptions[0] ?? "claude";
  const [tool, setTool] = useState<ExternalTool>(initialTab);
  const [groups, setGroups] = useState<ExternalSessionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [previewSession, setPreviewSession] = useState<ExternalSession | null>(null);

  useEffect(() => {
    setLoading(true);
    setGroups([]);
    const fetcher = tool === "cursor"
      ? browseCursorSessions
      : tool === "codex"
        ? browseCodexSessions
        : browseExternalSessions;
    fetcher().then((data) => setGroups(data)).catch(() => {}).finally(() => setLoading(false));
  }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = search.toLowerCase();

  // Filter groups: empty sessions out, apply search, sort (dir_exists first, then by latest_mtime desc)
  const filteredGroups = useMemo(() => {
    return groups
      .map((g) => {
        const nonEmpty = g.sessions.filter((s) => s.title || s.prompts.length > 0);
        const visible = nonEmpty.filter((s) =>
          !q ||
          g.dir.toLowerCase().includes(q) ||
          (s.title?.toLowerCase().includes(q)) ||
          s.prompts.some((p) => p.toLowerCase().includes(q))
        );
        return { ...g, sessions: visible };
      })
      .filter((g) => g.sessions.length > 0)
      .sort((a, b) => {
        if (a.dir_exists !== b.dir_exists) return a.dir_exists ? -1 : 1;
        return b.latest_mtime - a.latest_mtime;
      });
  }, [groups, q]);

  const toggleCollapse = (dir: string) =>
    setCollapsed((prev) => { const next = new Set(prev); next.has(dir) ? next.delete(dir) : next.add(dir); return next; });

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 400, display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ flexShrink: 0, background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1, flexShrink: 0 }}>‹</button>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Browse External Sessions</span>
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
          {tabOptions.map((t) => (
            <button
              key={t}
              onClick={() => setTool(t)}
              style={{ padding: "4px 10px", fontSize: 12, background: tool === t ? "var(--bg-hover)" : "transparent", color: tool === t ? "var(--text-body)" : "var(--text-muted)", border: "none", cursor: "pointer", textTransform: "capitalize" }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {/* Search */}
      <div style={{ flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid var(--border-subtle)" }}>
        <input
          placeholder="Search sessions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...inp, fontSize: 14 }}
        />
      </div>
      {/* Grouped list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading && <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>}
        {!loading && filteredGroups.length === 0 && (
          <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>{q ? "No matches" : "No external sessions found"}</div>
        )}
        {filteredGroups.map((g) => {
          const dirName = g.dir.split("/").filter(Boolean).pop() || g.dir;
          const isCollapsed = collapsed.has(g.dir);
          return (
            <div key={g.dir}>
              {/* Dir header */}
              <div
                onClick={() => toggleCollapse(g.dir)}
                style={{ padding: "8px 14px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
              >
                <span style={{ fontSize: 12, color: "var(--text-muted)", transition: "transform 0.1s", display: "inline-block", transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>▾</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: g.dir_exists ? "var(--text-primary)" : "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {dirName}
                    </span>
                    {!g.dir_exists && (
                      <span style={{ fontSize: 10, color: "var(--accent-red)", background: "rgba(248,81,73,0.1)", border: "1px solid rgba(248,81,73,0.3)", borderRadius: 3, padding: "0 4px", flexShrink: 0 }}>
                        missing
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {g.sessions.length} session{g.sessions.length !== 1 ? "s" : ""} · {relativeTime(g.latest_mtime)}
                  </div>
                </div>
              </div>
              {/* Sessions under this dir */}
              {!isCollapsed && g.sessions.map((s) => {
                const canLoad = g.dir_exists;
                const isLoadingThis = loadingId === s.agent_session_id;
                return (
                  <div key={s.agent_session_id} style={{ padding: "10px 14px 10px 28px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "flex-start", gap: 10, background: "var(--bg-base)" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                        {s.title || <span style={{ color: "var(--text-faint)", fontStyle: "italic" }}>No title</span>}
                      </div>
                      {s.prompts.length > 0 && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <PromptText text={s.prompts[s.prompts.length - 1]} />
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2, display: "flex", gap: 8, alignItems: "center" }}>
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
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button
                        onClick={() => setPreviewSession(s)}
                        style={{
                          background: "var(--bg-hover)", color: "var(--text-secondary)",
                          border: "1px solid var(--border)", borderRadius: 6,
                          padding: "6px 10px", fontSize: 12, cursor: "pointer",
                        }}
                      >
                        View
                      </button>
                      <button
                        disabled={!canLoad || isLoadingThis}
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={async () => {
                          if (!canLoad) return;
                          setLoadingId(s.agent_session_id);
                          try { await onLoad(s, tool); } finally { setLoadingId(null); }
                        }}
                        style={{
                          background: canLoad ? "var(--accent-blue)" : "var(--bg-hover)",
                          color: canLoad ? "#fff" : "var(--text-faint)",
                          border: "none", borderRadius: 6,
                          padding: "6px 14px", fontSize: 13,
                          cursor: canLoad ? "pointer" : "not-allowed",
                          opacity: isLoadingThis ? 0.6 : 1,
                        }}
                      >
                        {isLoadingThis ? "…" : "Load"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {previewSession && (
        <MobileSessionPreviewModal
          session={previewSession}
          tool={tool}
          onClose={() => setPreviewSession(null)}
        />
      )}
    </div>
  );
}

/* ─── Session List ─── */
// Cache the latest mobile session list in localStorage so reopen feels instant.
// We rehydrate immediately on mount, then refresh in the background.
const MOBILE_LIST_CACHE_KEY = "mobileSessionListCache";
function _readListCache(): { items: SessionMeta[]; total: number } | null {
  try {
    const raw = localStorage.getItem(MOBILE_LIST_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return { items: parsed.items as SessionMeta[], total: Number(parsed.total) || 0 };
  } catch { return null; }
}
function _writeListCache(items: SessionMeta[], total: number) {
  try {
    localStorage.setItem(MOBILE_LIST_CACHE_KEY, JSON.stringify({ items, total }));
  } catch { /* quota — ignore */ }
}

function ListView({ username, onLogout, onOpen, onSwitchToAdmin, onOpenTool, theme, onToggleTheme, terminalFont, onTerminalFontChange }: { username: string; onLogout: () => void; onOpen: (s: SessionMeta) => void; onSwitchToAdmin?: () => void; onOpenTool?: () => void; theme?: "dark" | "light"; onToggleTheme?: () => void; terminalFont?: string; onTerminalFontChange?: (font: string) => void }) {
  const isAdmin = localStorage.getItem("role") === "admin";
  const cached = _readListCache();
  const [sessions, setSessions] = useState<SessionMeta[]>(cached?.items ?? []);
  const [total, setTotal] = useState(cached?.total ?? 0);
  const [page, setPage] = useState(0);
  // If we have cached items we can skip the loading spinner — the user sees
  // the previous list instantly and it updates a moment later from the API.
  const [loading, setLoading] = useState(!cached);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [workspaceBase, setWorkspaceBase] = useState("/workspace");
  const [enabledTools, setEnabledTools] = useState<string[]>(["claude", "codex", "cursor"]);
  const [restarting, setRestarting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState<boolean>(
    () => localStorage.getItem("mobileShowAllSessions") === "1",
  );
  useEffect(() => {
    localStorage.setItem("mobileShowAllSessions", showAllSessions ? "1" : "0");
  }, [showAllSessions]);

  useEffect(() => { getConfig().then((c) => { setWorkspaceBase(c.workspace); setEnabledTools(c.enabled_tools); }).catch(() => {}); }, []);

  const fetchSessions = useCallback(async (p: number, showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const res = await listSessions();
      const isActive = (s: SessionMeta) => s.status === "running" || s.status === "detached";
      const visible = showAllSessions ? res.items : res.items.filter(isActive);
      const effectiveTotal = showAllSessions ? res.total : visible.length;
      setTotal(effectiveTotal);
      const pageItems = visible.slice(p * MOBILE_PAGE_SIZE, (p + 1) * MOBILE_PAGE_SIZE);
      const ordered = [...pageItems.filter(isActive), ...pageItems.filter((s) => !isActive(s))];
      setSessions(ordered);
      if (p === 0) _writeListCache(ordered, effectiveTotal);
    } catch { /* keep prior cached list rather than wiping it */ } finally { if (showLoading) setLoading(false); }
  }, [showAllSessions]);

  // Lightweight status-only refresh: merge status fields without touching title/prompts
  const refreshStatus = useCallback(async () => {
    try {
      const res = await listSessionsStatus();
      const statusById = new Map(res.items.map((s) => [s.id, s]));
      setSessions((prev) => prev.map((s) => {
        const st = statusById.get(s.id);
        if (!st) return s;
        return { ...s, status: st.status, attached_clients: st.attached_clients, has_new_output: st.has_new_output, is_streaming: st.is_streaming, scheduled_tasks: st.scheduled_tasks };
      }));
    } catch {}
  }, []);

  // Initial load (with spinner) + full refresh every 30s + status refresh every 3s
  useEffect(() => {
    fetchSessions(page, true);
    const fullTimer = setInterval(() => fetchSessions(page, false), 30000);
    const statusTimer = setInterval(refreshStatus, 3000);
    return () => { clearInterval(fullTimer); clearInterval(statusTimer); };
  }, [page, fetchSessions, refreshStatus]);

  const totalPages = Math.max(1, Math.ceil(total / MOBILE_PAGE_SIZE));

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm("Delete this session?")) return;
    setDeletingId(id);
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setTotal((t) => t - 1);
    } catch { alert("Failed to delete"); } finally { setDeletingId(null); }
  };

  const [resumingId, setResumingId] = useState<string | null>(null);
  const handleResume = async (e: React.MouseEvent, s: SessionMeta) => {
    e.stopPropagation();
    setResumingId(s.id);
    try {
      await resumeSession(s.id);
      await fetchSessions(page, false);
      onOpen({ ...s, status: "running" });
    } catch (err) { alert(String(err)); } finally { setResumingId(null); }
  };

  const handleRestart = async () => {
    if (!window.confirm("Restart server? All connections will be disconnected.")) return;
    setRestarting(true);
    try {
      await restartServer();
    } catch {
      // Server may disconnect before responding — that's expected
    }
    const poll = setInterval(async () => {
      try {
        const r = await fetch(apiPath("/health"));
        if (r.ok) { clearInterval(poll); setRestarting(false); }
      } catch {}
    }, 1500);
    setTimeout(() => { clearInterval(poll); setRestarting(false); }, 30000);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", position: "fixed", inset: 0, background: "var(--bg-base)" }}>
      <div style={{ padding: "14px 16px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: "var(--text-bright)" }}>Claude Manager</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--text-faint)" }}>{username}</span>
          {onToggleTheme && (
            <button onClick={onToggleTheme} title="Toggle theme"
              style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", fontSize: 14, padding: "4px 7px", cursor: "pointer" }}>
              {theme === "light" ? "🌙" : "☀️"}
            </button>
          )}
          <button onClick={() => setShowSettings(true)} title="Settings"
            style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", fontSize: 14, padding: "4px 7px", cursor: "pointer" }}>
            ⚙
          </button>
          {onOpenTool && (
            <button onClick={onOpenTool} title="渲染本地 JSONL 文件为 Chat 视图"
              style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", fontSize: 14, padding: "4px 7px", cursor: "pointer" }}>
              🧩
            </button>
          )}
          {onSwitchToAdmin && (
            <button onClick={onSwitchToAdmin}
              style={{ fontSize: 12, padding: "5px 10px", background: "rgba(88,166,255,0.12)", color: "var(--accent-blue)", border: "1px solid rgba(88,166,255,0.3)", borderRadius: 6 }}>
              Admin
            </button>
          )}
          {isAdmin && (
            <button onClick={handleRestart} disabled={restarting}
              style={{ fontSize: 12, padding: "5px 10px", background: restarting ? "var(--bg-hover)" : "var(--bg-hover)", color: restarting ? "var(--text-muted)" : "var(--text-secondary)", border: "1px solid var(--border)", borderRadius: 6, cursor: restarting ? "not-allowed" : "pointer" }}>
              {restarting ? "Restarting…" : "⟳ Restart"}
            </button>
          )}
          <button onClick={onLogout}
            style={{ fontSize: 12, padding: "5px 10px", background: "var(--bg-hover)", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 6 }}>
            Logout
          </button>
        </div>
      </div>

      {/* Token usage — 5h session + weekly */}
      <MobileUsageRow />

      <div style={{ padding: "6px 10px 4px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
        <button
          onClick={() => { setShowAllSessions((v) => !v); setPage(0); }}
          style={{
            width: "100%", padding: "5px 10px", borderRadius: 5, fontSize: 12,
            background: showAllSessions ? "var(--bg-hover)" : "rgba(88,166,255,0.1)",
            border: `1px solid ${showAllSessions ? "var(--border)" : "rgba(88,166,255,0.3)"}`,
            color: showAllSessions ? "var(--text-muted)" : "var(--accent-blue)",
            cursor: "pointer", textAlign: "left",
          }}
        >
          {showAllSessions ? "Showing all sessions" : "Active sessions only"}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {(() => {
          const visibleSessions = sessions.filter((s) => enabledTools.includes(s.tool));
          if (loading) return <div style={{ textAlign: "center", padding: 48, color: "var(--text-faint)" }}>Loading…</div>;
          if (visibleSessions.length === 0) return <div style={{ textAlign: "center", padding: 48, color: "var(--text-faint)" }}>{showAllSessions ? "No sessions yet" : "No active sessions"}</div>;
          return visibleSessions.map((s) => (
              <div key={s.id} onClick={() => onOpen(s)}
                style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: "50%", background: statusDot(s.status), flexShrink: 0, display: "inline-block",
                    animation: s.is_streaming ? "cursor-blink 0.8s step-end infinite" : undefined,
                  }} />
                  <span style={{ fontSize: 15, color: "var(--text-bright)", fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.project}
                  </span>
                  {s.is_streaming ? (
                    <span style={{ fontSize: 10, color: "var(--accent-blue)", background: "rgba(88,166,255,0.1)", border: "1px solid rgba(88,166,255,0.3)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>responding</span>
                  ) : s.has_new_output ? (
                    <span style={{ fontSize: 10, color: "var(--accent-green)", background: "rgba(63,185,80,0.1)", border: "1px solid rgba(63,185,80,0.3)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>unread</span>
                  ) : s.status === "terminated" ? (
                    <span style={{ fontSize: 10, color: "var(--accent-red)", background: "rgba(248,81,73,0.1)", border: "1px solid rgba(248,81,73,0.25)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>terminated</span>
                  ) : s.status === "detached" ? (
                    <span style={{ fontSize: 10, color: "var(--text-muted)", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>detached</span>
                  ) : null}
                  {s.status === "terminated" && (
                    <>
                      <button
                        onClick={(e) => handleResume(e, s)}
                        disabled={resumingId === s.id}
                        style={{ background: "transparent", border: "none", color: resumingId === s.id ? "var(--text-faintest)" : "var(--accent-green)", fontSize: 15, padding: "2px 4px", cursor: "pointer", flexShrink: 0, lineHeight: 1 }}
                        title="Resume"
                      >{resumingId === s.id ? "…" : "▶"}</button>
                      <button
                        onClick={(e) => handleDelete(e, s.id)}
                        disabled={deletingId === s.id}
                        style={{ background: "transparent", border: "none", color: deletingId === s.id ? "var(--text-faintest)" : "var(--text-faint)", fontSize: 16, padding: "2px 4px", cursor: "pointer", flexShrink: 0, lineHeight: 1 }}
                        title="Delete"
                      >🗑</button>
                    </>
                  )}
                  <span style={{ fontSize: 13, color: "var(--text-faint)" }}>›</span>
                </div>
                {s.prompts?.[0] && <div style={{ fontSize: 13, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingLeft: 15 }}><PromptText text={s.prompts[0]} /></div>}
                {s.prompts && s.prompts.length >= 2 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 15 }}>
                    <span style={{ fontSize: 12, color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><PromptText text={s.prompts[s.prompts.length - 1]} /></span>
                    {s.last_user_input_at && <span style={{ fontSize: 10, color: "var(--text-faintest)", flexShrink: 0 }}>{relTime(s.last_user_input_at)}</span>}
                  </div>
                )}
                {(!s.prompts || s.prompts.length < 2) && s.last_user_input_at && (
                  <div style={{ fontSize: 10, color: "var(--text-faintest)", paddingLeft: 15 }}>{relTime(s.last_user_input_at)}</div>
                )}
                <div style={{ fontSize: 11, color: "var(--text-faintest)", paddingLeft: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.cwd}</div>
              </div>
            ));
        })()}
      </div>

      {totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-surface)", flexShrink: 0 }}>
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={{ ...btn, padding: "6px 20px", opacity: page === 0 ? 0.35 : 1, background: "var(--bg-hover)", color: "var(--text-muted)" }}>‹ Prev</button>
          <span style={{ fontSize: 12, color: "var(--text-faint)" }}>{page + 1} / {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{ ...btn, padding: "6px 20px", opacity: page >= totalPages - 1 ? 0.35 : 1, background: "var(--bg-hover)", color: "var(--text-muted)" }}>Next ›</button>
        </div>
      )}

      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-surface)", flexShrink: 0, display: "flex", gap: 8 }}>
        <button onClick={() => setShowCreate(true)} style={{ ...btn, flex: 1, background: "var(--accent-green)", color: "#fff", fontSize: 15, padding: "12px" }}>+ New Session</button>
        <button onClick={() => setShowImport(true)} style={{ ...btn, background: "rgba(88,166,255,0.1)", color: "var(--accent-blue)", border: "1px solid rgba(88,166,255,0.3)", fontSize: 15, padding: "12px 16px" }}>⬆ Import</button>
      </div>

      {showCreate && (
        <CreateModal workspaceBase={workspaceBase} username={username} enabledTools={enabledTools}
          onClose={() => setShowCreate(false)}
          onCreate={(s) => { setShowCreate(false); onOpen(s); }} />
      )}
      {showImport && (
        <MobileBrowseExternalPanel
          enabledTools={enabledTools}
          onClose={() => setShowImport(false)}
          onLoad={async (ext, tool) => {
            const dirName = ext.cwd.split("/").filter(Boolean).pop() || ext.cwd;
            const newSession = await createSession({ project: dirName, cwd: ext.cwd, resume_session_id: ext.agent_session_id, tool });
            setShowImport(false);
            onOpen(newSession);
          }}
        />
      )}
      <MobileSettingsPanel
        open={showSettings} onClose={() => setShowSettings(false)}
        theme={theme} onToggleTheme={onToggleTheme}
        terminalFont={terminalFont} onTerminalFontChange={onTerminalFontChange}
      />
    </div>
  );
}

/* ─── Chat bubble ─── */
function _fmtTs(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function Bubble({ turn }: { turn: ConversationTurn & { streaming?: boolean } }) {
  const isUser = turn.role === "user";
  const ts = _fmtTs(turn.ts);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start", marginBottom: 10, padding: "0 12px" }}>
      <div style={{
        maxWidth: "86%",
        padding: "10px 13px",
        borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
        background: isUser ? "color-mix(in srgb, var(--accent-blue) 18%, var(--bg-base))" : "var(--bg-hover)",
        color: isUser ? "var(--text-bright)" : "var(--text-primary)",
        fontSize: 14,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        {turn.text}
      </div>
      {ts && <span style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2, paddingLeft: 2, paddingRight: 2 }}>{ts}</span>}
    </div>
  );
}

/* ─── Streaming bubble (live terminal output) ─── */
function StreamingBubble({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 10, padding: "0 12px" }}>
      <div style={{
        maxWidth: "92%",
        padding: "10px 13px",
        borderRadius: "16px 16px 16px 4px",
        background: "var(--bg-deep)",
        border: "1px solid var(--border-subtle)",
        color: "var(--text-secondary)",
        fontSize: 12,
        lineHeight: 1.5,
        fontFamily: '"Cascadia Code", Menlo, Monaco, "Courier New", monospace',
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}>
        {text}
        <span style={{ display: "inline-block", marginLeft: 3, color: "var(--accent-blue)", animation: "cursor-blink 0.8s step-end infinite" }}>▍</span>
      </div>
    </div>
  );
}

/* ─── Unified diff helpers ─── */
type _EditType = "same" | "removed" | "added";
interface _Edit { type: _EditType; text: string; oldLine: number; newLine: number; }

function _lcsEdits(oldL: string[], newL: string[]): _Edit[] {
  const m = oldL.length, n = newL.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldL[i-1] === newL[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const edits: _Edit[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldL[i-1] === newL[j-1]) { edits.push({ type: "same", text: oldL[i-1], oldLine: i, newLine: j }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { edits.push({ type: "added", text: newL[j-1], oldLine: i, newLine: j }); j--; }
    else { edits.push({ type: "removed", text: oldL[i-1], oldLine: i, newLine: j }); i--; }
  }
  return edits.reverse();
}

interface _ULine { type: _EditType | "hunk"; text: string; lineNo?: number; }

function _computeUnifiedDiff(oldContent: string, newContent: string, ctx = 3): _ULine[] {
  const edits = _lcsEdits(oldContent.split("\n"), newContent.split("\n"));
  if (!edits.length) return [];

  // Mark visible indices (changed ± ctx)
  const visible = new Set<number>();
  edits.forEach((e, i) => {
    if (e.type !== "same") {
      for (let k = Math.max(0, i - ctx); k < Math.min(edits.length, i + ctx + 1); k++) visible.add(k);
    }
  });
  if (!visible.size) return [{ type: "hunk", text: "No changes" }];

  const result: _ULine[] = [];
  let prev = -2;
  for (let i = 0; i < edits.length; i++) {
    if (!visible.has(i)) continue;
    if (i !== prev + 1) {
      const e = edits[i];
      result.push({ type: "hunk", text: `@@ -${e.oldLine} +${e.newLine} @@` });
    }
    const e = edits[i];
    const lineNo = e.type === "added" ? e.newLine : e.oldLine;
    result.push({ type: e.type, text: e.text, lineNo });
    prev = i;
  }
  return result;
}

function MobileFileDiff({ file, onClose }: { file: GitDiffFile; onClose: () => void }) {
  const lines = useMemo(() => _computeUnifiedDiff(file.old_content, file.new_content), [file]);
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 400, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 14px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
        <span style={{ fontSize: 12, color: "var(--text-bright)", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.path}</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", fontFamily: "monospace", fontSize: 11, lineHeight: "18px" }}>
        {lines.map((line, i) => {
          if (line.type === "hunk") {
            return (
              <div key={i} style={{ background: "var(--bg-surface)", color: "var(--accent-blue)", padding: "2px 8px", borderTop: i > 0 ? "1px solid var(--border)" : undefined }}>
                {line.text}
              </div>
            );
          }
          const bg = line.type === "removed" ? "var(--diff-del-bg)" : line.type === "added" ? "var(--diff-add-bg)" : "transparent";
          const sigil = line.type === "removed" ? "-" : line.type === "added" ? "+" : " ";
          const sigilColor = line.type === "removed" ? "var(--diff-del-text)" : line.type === "added" ? "var(--diff-add-text)" : "var(--text-faint)";
          const textColor = line.type === "removed" ? "var(--diff-del-text)" : line.type === "added" ? "var(--diff-add-text)" : "var(--text-body)";
          return (
            <div key={i} style={{ display: "flex", background: bg, minHeight: 18 }}>
              <span style={{ width: 30, flexShrink: 0, textAlign: "right", paddingRight: 5, color: "var(--text-faint)", userSelect: "none", borderRight: "1px solid var(--border)" }}>{line.lineNo}</span>
              <span style={{ width: 14, flexShrink: 0, textAlign: "center", color: sigilColor, userSelect: "none" }}>{sigil}</span>
              <span style={{ flex: 1, color: textColor, whiteSpace: "pre-wrap", wordBreak: "break-all", paddingRight: 6 }}>{line.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Mobile Git Panel ─── */
const GIT_PAGE_SIZE = 15;

function MobileGitPullButton({ sessionId, onPulled }: { sessionId: string; onPulled?: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    setToast(null);
    try {
      const r = await gitPull(sessionId);
      const msg = r.output?.split("\n")[0] || "Up to date";
      setToast({ kind: "ok", text: msg });
      await onPulled?.();
    } catch (e) {
      setToast({ kind: "err", text: String(e).replace(/^Error:\s*/, "") });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  return (
    <div style={{ position: "relative", display: "inline-block", flexShrink: 0 }}>
      <button
        onClick={handleClick}
        disabled={busy}
        title={busy ? "Pulling…" : "git pull --ff-only"}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          fontSize: 11, padding: "3px 10px",
          background: "var(--bg-hover)", border: "1px solid var(--text-faintest)",
          color: "var(--text-secondary)", borderRadius: 11,
          cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
        }}
      >
        <svg width={10} height={10} viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}>
          <path d="M7.78 12.53a.75.75 0 01-1.06 0L2.47 8.28a.75.75 0 011.06-1.06l2.72 2.72V2.75a.75.75 0 011.5 0v7.19l2.72-2.72a.75.75 0 111.06 1.06l-4.25 4.25zM2.75 14a.75.75 0 000 1.5h10.5a.75.75 0 000-1.5H2.75z" />
        </svg>
        <span>{busy ? "Pulling…" : "Pull"}</span>
      </button>
      {toast && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200,
            background: toast.kind === "ok" ? "rgba(46,160,67,0.95)" : "rgba(248,81,73,0.95)",
            color: "#fff", fontSize: 11, padding: "4px 8px", borderRadius: 4,
            maxWidth: 280, whiteSpace: "pre-wrap", wordBreak: "break-word",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function MobileGitPanel({ sessionId, session, onSessionChange, onClose }: { sessionId: string; session: SessionMeta; onSessionChange: (s: SessionMeta) => void; onClose: () => void }) {
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRepo, setIsRepo] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo>({ current: "", local: [] });
  const [scope, setScope] = useState<string>("current");
  const [scopedLog, setScopedLog] = useState<GitLogEntry[]>([]);
  const [scopedLoading, setScopedLoading] = useState(false);
  const [showBranchSheet, setShowBranchSheet] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "graph">("list");
  const [graphCommits, setGraphCommits] = useState<GitGraphCommit[] | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [showCommit, setShowCommit] = useState(false);
  const [commitSubject, setCommitSubject] = useState("");
  const [commitBody, setCommitBody] = useState("");
  const [gitignore, setGitignore] = useState("");
  const [gitignoreDraft, setGitignoreDraft] = useState("");
  const [editingGitignore, setEditingGitignore] = useState(false);
  const [remote, setRemote] = useState("");
  const [remoteInput, setRemoteInput] = useState("");
  const [editingRemote, setEditingRemote] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [revertHash, setRevertHash] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [detailHash, setDetailHash] = useState<string | null>(null);
  const [detailMsg, setDetailMsg] = useState<string>("");
  const [detailFiles, setDetailFiles] = useState<GitDiffFile[]>([]);
  const [diffFile, setDiffFile] = useState<GitDiffFile | null>(null);
  const [committing, setCommitting] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [mergeStatus, setMergeStatus] = useState<MergeStatus | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getGitInfo(sessionId).catch(() => null),
      getGitBranches(sessionId).catch(() => ({ current: "", local: [] }) as GitBranchInfo),
      getMergeStatus(sessionId).catch(() => null),
    ])
      .then(([info, br, ms]) => {
        if (info) {
          setIsRepo(info.is_repo); setLog(info.log);
          setGitignore(info.gitignore ?? ""); setGitignoreDraft(info.gitignore ?? "");
          setRemote(info.remote ?? ""); setRemoteInput(info.remote ?? "");
        }
        setBranches(br);
        setMergeStatus(ms);
      })
      .finally(() => setLoading(false));
  }, [sessionId]);

  // Fetch scoped graph when scope is not "current"
  useEffect(() => {
    if (scope === "current") return;
    setScopedLoading(true);
    getGitGraph(sessionId, scope, 500)
      .then((commits) => {
        setScopedLog(commits.map((c) => ({
          hash: c.hash, short_hash: c.short_hash, subject: c.subject,
          author: c.author, date: c.date,
        })));
      })
      .catch(() => setScopedLog([]))
      .finally(() => setScopedLoading(false));
  }, [sessionId, scope]);

  // Fetch raw graph commits when in graph view
  useEffect(() => {
    if (viewMode !== "graph") return;
    setGraphLoading(true);
    getGitGraph(sessionId, scope, 500)
      .then(setGraphCommits)
      .catch(() => setGraphCommits([]))
      .finally(() => setGraphLoading(false));
  }, [sessionId, scope, viewMode]);

  const activeLog: GitLogEntry[] = scope === "current" ? log : scopedLog;
  const activeLoading = scope === "current" ? loading : scopedLoading;

  const doCheckout = async (branch: string, remote: boolean) => {
    if (checkoutBusy) return;
    setCheckoutBusy(branch);
    try {
      const res = await gitCheckoutBranch(sessionId, branch, { remote });
      setMsg({ text: res.stashed ? `Switched to ${res.branch} (changes stashed)` : `Switched to ${res.branch}`, ok: true });
      setShowBranchSheet(false);
      setScope("current");
      // Refresh info + branches
      const [info, br] = await Promise.all([
        getGitInfo(sessionId).catch(() => null),
        getGitBranches(sessionId).catch(() => branches),
      ]);
      if (info) setLog(info.log);
      setBranches(br);
    } catch (e) {
      if (e instanceof GitCheckoutConflictError) {
        const stash = window.confirm(`${e.conflict.message}\n\nStash local changes and retry?`);
        if (stash) {
          try {
            const res = await gitCheckoutBranch(sessionId, branch, { remote, stash: true });
            setMsg({ text: `Switched to ${res.branch} (changes stashed)`, ok: true });
            setShowBranchSheet(false);
            setScope("current");
            const [info, br] = await Promise.all([
              getGitInfo(sessionId).catch(() => null),
              getGitBranches(sessionId).catch(() => branches),
            ]);
            if (info) setLog(info.log);
            setBranches(br);
          } catch (e2) { setMsg({ text: String(e2), ok: false }); }
        }
      } else {
        setMsg({ text: String(e), ok: false });
      }
    } finally { setCheckoutBusy(null); }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return activeLog;
    const q = search.toLowerCase();
    return activeLog.filter((e) => e.subject.toLowerCase().includes(q) || e.short_hash.includes(q));
  }, [activeLog, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / GIT_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageLog = filtered.slice(safePage * GIT_PAGE_SIZE, (safePage + 1) * GIT_PAGE_SIZE);

  const doRevert = async () => {
    if (!revertHash) return;
    setReverting(true);
    try {
      const res = await gitRollback(sessionId, revertHash);
      setMsg({ text: res.output || "Rolled back", ok: true });
      // Refresh log
      const info = await getGitInfo(sessionId);
      setLog(info.log);
    } catch (e) {
      setMsg({ text: String(e), ok: false });
    } finally {
      setReverting(false);
      setRevertHash(null);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 200, display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        {/* Row 1: title + branch */}
        <div style={{ padding: "10px 14px 6px 10px", display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Git</span>
          {branches.current && (
            <button
              onClick={() => setShowBranchSheet(true)}
              style={{ fontSize: 11, padding: "3px 10px", background: "rgba(88,166,255,0.12)", border: "1px solid rgba(88,166,255,0.3)", color: "var(--accent-blue)", borderRadius: 11, fontFamily: "monospace", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}
            >⎇ {branches.current}</button>
          )}
          {isRepo && (
            <MobileGitPullButton
              sessionId={sessionId}
              onPulled={async () => {
                const [info, br, ms] = await Promise.all([
                  getGitInfo(sessionId).catch(() => null),
                  getGitBranches(sessionId).catch(() => branches),
                  getMergeStatus(sessionId).catch(() => null),
                ]);
                if (info) setLog(info.log);
                setBranches(br);
                setMergeStatus(ms);
              }}
            />
          )}
          <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: "auto", flexShrink: 0 }}>{filtered.length} commits</span>
        </div>

        {/* Row 2: action buttons */}
        {isRepo && (
          <div style={{ padding: "0 12px 10px 12px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => setShowCommit(v => !v)}
              style={{ fontSize: 11, padding: "4px 12px", background: "var(--bg-hover)", color: "var(--accent-green)", border: "1px solid #2d5a2d", borderRadius: 5 }}
            >
              {showCommit ? "Cancel" : "Commit"}
            </button>
            <button
              onClick={() => setEditingGitignore(true)}
              style={{ fontSize: 11, padding: "4px 10px", background: "var(--bg-hover)", color: "var(--text-secondary)", border: "1px solid #374151", borderRadius: 5 }}
            >
              .gitignore
            </button>
            <button
              onClick={() => setShowMerge(true)}
              style={{ fontSize: 11, padding: "4px 10px", background: "var(--bg-hover)", color: "var(--accent-amber)", border: "1px solid #5a4527", borderRadius: 5 }}
            >
              Merge
            </button>
          </div>
        )}

        {/* Commit form (subject required, body optional) */}
        {isRepo && showCommit && (
          <div style={{ padding: "0 12px 10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
            <input
              value={commitSubject}
              onChange={(e) => setCommitSubject(e.target.value)}
              placeholder="Commit subject (required)"
              style={{ fontSize: 13, padding: "7px 9px", background: "var(--bg-base)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-primary)" }}
            />
            <textarea
              value={commitBody}
              onChange={(e) => setCommitBody(e.target.value)}
              placeholder="Body (optional)"
              rows={3}
              style={{ fontSize: 12, padding: "7px 9px", background: "var(--bg-base)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-primary)", resize: "vertical", fontFamily: "inherit" }}
            />
            <button
              disabled={committing || !commitSubject.trim()}
              onClick={async () => {
                const subject = commitSubject.trim();
                if (!subject) return;
                setCommitting(true);
                try {
                  const body = commitBody.trim();
                  const message = body ? `${subject}\n\n${body}` : subject;
                  const res = await gitManualCommit(sessionId, message);
                  setMsg({ text: res.committed ? res.output || "Committed" : "Nothing to commit", ok: res.committed });
                  if (res.committed) {
                    const info = await getGitInfo(sessionId); setLog(info.log);
                    setCommitSubject(""); setCommitBody(""); setShowCommit(false);
                  }
                } catch (e) { setMsg({ text: String(e), ok: false }); }
                finally { setCommitting(false); }
              }}
              style={{ fontSize: 12, padding: "8px 12px", background: "var(--accent-blue)", color: "#fff", border: "none", borderRadius: 6, opacity: commitSubject.trim() ? 1 : 0.5 }}
            >
              {committing ? "…" : "Commit now"}
            </button>
          </div>
        )}

        {/* Rewind points (shadow git — independent of the real .git) */}
        {isRepo && (
          <div style={{ padding: "0 12px 10px 12px" }}>
            <ShadowRewindSection sessionId={sessionId} />
          </div>
        )}
      </div>

      {!isRepo && !loading && (
        <div style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>Not a git repository</div>
      )}

      {isRepo && (
        <>
          {mergeStatus?.in_progress && (
            <div style={{ padding: "10px 12px", background: "rgba(248,81,73,0.12)", borderBottom: "1px solid var(--accent-red)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ color: "var(--accent-red)", fontSize: 14, flexShrink: 0 }}>⚠</span>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text-body)" }}>
                <div>Merge in progress — <span style={{ fontFamily: "monospace", color: "var(--accent-amber)" }}>{mergeStatus.merge_head}</span> → <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{mergeStatus.current_branch}</span></div>
                {mergeStatus.conflicted_files.length > 0 && (
                  <div style={{ color: "var(--text-muted)", marginTop: 2 }}>
                    {mergeStatus.conflicted_files.length} file{mergeStatus.conflicted_files.length === 1 ? "" : "s"} with conflicts
                  </div>
                )}
              </div>
              <button
                onClick={() => setShowMerge(true)}
                style={{ background: "var(--accent-red)", color: "#fff", fontSize: 11, padding: "5px 12px", border: "none", borderRadius: 6, flexShrink: 0 }}
              >Resolve →</button>
            </div>
          )}
          {/* Remote URL bar */}
          <div
            onClick={() => { setRemoteInput(remote); setEditingRemote(true); }}
            style={{ padding: "7px 14px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexShrink: 0, background: "var(--bg-base)" }}
          >
            <span style={{ fontSize: 11, color: "var(--text-faint)", flexShrink: 0 }}>Remote</span>
            <span style={{ fontSize: 12, color: remote ? "var(--accent-blue)" : "var(--text-muted)", fontFamily: remote ? "monospace" : undefined, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {loading ? "…" : remote || "Not set — tap to configure"}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-faint)", flexShrink: 0 }}>›</span>
          </div>

          {/* Scope pills + view-mode toggle */}
          {branches.local.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
              <div style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none", flex: 1, minWidth: 0 }}>
                {[{ id: "current", label: `● ${branches.current}` }, { id: "all", label: "all" }, ...branches.local.filter(b => b !== branches.current).map(b => ({ id: b, label: b }))].map(p => {
                  const active = scope === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => { setScope(p.id); setPage(0); }}
                      style={{ flex: "0 0 auto", fontSize: 11, padding: "4px 10px", background: active ? "var(--accent-blue)" : "var(--bg-hover)", color: active ? "#fff" : "var(--text-muted)", border: "1px solid " + (active ? "var(--accent-blue)" : "var(--border)"), borderRadius: 12, fontFamily: "monospace", whiteSpace: "nowrap" }}
                    >{p.label}</button>
                  );
                })}
              </div>
              <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
                {(["list", "graph"] as const).map(m => (
                  <button key={m} onClick={() => setViewMode(m)}
                    style={{ padding: "4px 8px", fontSize: 11, background: viewMode === m ? "var(--bg-hover)" : "transparent", color: viewMode === m ? "var(--text-body)" : "var(--text-muted)", border: "none" }}
                  >{m === "list" ? "List" : "Graph"}</button>
                ))}
              </div>
            </div>
          )}

          {/* Search */}
          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
            <input
              placeholder="Search commits…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              style={{ ...inp, fontSize: 14 }}
            />
          </div>

          {/* Commit list */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {viewMode === "graph" ? (
              graphLoading ? (
                <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>Loading graph…</div>
              ) : (graphCommits ?? []).length === 0 ? (
                <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>No commits found</div>
              ) : (
                <div style={{ overflowX: "auto", padding: "8px 0" }}>
                  <GitGraph
                    commits={graphCommits ?? []}
                    latestHash={(graphCommits ?? [])[0]?.hash ?? null}
                    onCommitClick={async (c) => {
                      setDetailHash(c.hash);
                      setDetailMsg("Loading…");
                      setDetailFiles([]);
                      try {
                        const d = await getCommitDetail(sessionId, c.hash);
                        setDetailMsg(d.message);
                        setDetailFiles(d.files ?? []);
                      } catch {
                        setDetailMsg("Failed to load commit detail.");
                      }
                    }}
                    onRevert={scope === "current" ? (c) => setRevertHash(c.hash) : undefined}
                  />
                </div>
              )
            ) : activeLoading
              ? <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>Loading…</div>
              : pageLog.length === 0
                ? <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>No commits found</div>
                : pageLog.map((entry) => {
                  const isLatest = entry.hash === activeLog[0]?.hash;
                  return (
                    <div key={entry.hash} style={{ padding: "12px 14px", borderBottom: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                        <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--accent-blue)", flexShrink: 0, marginTop: 2 }}>{entry.short_hash}</span>
                        <span style={{ fontSize: 13, color: "var(--text-primary)", flex: 1, lineHeight: 1.4 }}>{entry.subject}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{entry.author} · {new Date(entry.date).toLocaleString()}</span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            onClick={async () => {
                              setDetailHash(entry.hash);
                              setDetailMsg("Loading…");
                              setDetailFiles([]);
                              try {
                                const d = await getCommitDetail(sessionId, entry.hash);
                                setDetailMsg(d.message);
                                setDetailFiles(d.files ?? []);
                              } catch {
                                setDetailMsg("Failed to load commit detail.");
                              }
                            }}
                            style={{ fontSize: 11, padding: "3px 10px", background: "var(--bg-hover)", color: "var(--accent-blue)", border: "1px solid #1d3557", borderRadius: 5 }}
                          >
                            Detail
                          </button>
                          {!isLatest && scope === "current" && (
                            <button
                              onClick={() => setRevertHash(entry.hash)}
                              style={{ fontSize: 11, padding: "3px 10px", background: "var(--bg-hover)", color: "var(--accent-amber)", border: "1px solid var(--border)", borderRadius: 5 }}
                            >
                              Revert
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
            }
          </div>

          {/* Pagination */}
          {viewMode === "list" && totalPages > 1 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, padding: "10px 16px", borderTop: "1px solid var(--border-subtle)", background: "var(--bg-base)", flexShrink: 0 }}>
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}
                style={{ ...btn, padding: "5px 18px", opacity: safePage === 0 ? 0.35 : 1, background: "var(--bg-hover)", color: "var(--text-secondary)" }}>‹</button>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{safePage + 1} / {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}
                style={{ ...btn, padding: "5px 18px", opacity: safePage >= totalPages - 1 ? 0.35 : 1, background: "var(--bg-hover)", color: "var(--text-secondary)" }}>›</button>
            </div>
          )}
        </>
      )}

      {/* Branch checkout sheet */}
      {showBranchSheet && (
        <div onClick={() => setShowBranchSheet(false)} style={{ position: "absolute", inset: 0, zIndex: 250, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-end" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxHeight: "70vh", background: "var(--bg-surface)", borderRadius: "12px 12px 0 0", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)" }}>⎇ Switch branch</span>
              <button onClick={() => setShowBranchSheet(false)} style={{ background: "var(--bg-hover)", border: "none", color: "var(--text-secondary)", fontSize: 13, padding: "4px 12px", borderRadius: 6, cursor: "pointer" }}>✕</button>
            </div>
            <div style={{ overflowY: "auto" }}>
              {branches.local.length === 0 && (!branches.remote_only || branches.remote_only.length === 0) && (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No branches</div>
              )}
              {branches.local.map(b => {
                const isCurrent = b === branches.current;
                const busy = checkoutBusy === b;
                return (
                  <button
                    key={b}
                    onClick={() => { if (!isCurrent) doCheckout(b, false); }}
                    disabled={isCurrent || !!checkoutBusy}
                    style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "transparent", border: "none", borderBottom: "1px solid var(--border-subtle)", color: isCurrent ? "var(--accent-blue)" : "var(--text-bright)", fontSize: 14, cursor: isCurrent ? "default" : "pointer", textAlign: "left", fontFamily: "monospace" }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      {isCurrent && <span style={{ color: "var(--accent-blue)" }}>●</span>}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b}</span>
                    </span>
                    {busy && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>…</span>}
                  </button>
                );
              })}
              {branches.remote_only && branches.remote_only.length > 0 && (
                <>
                  <div style={{ padding: "10px 16px 6px", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-faint)", fontWeight: 600, background: "var(--bg-base)" }}>Remote-only</div>
                  {branches.remote_only.map(b => {
                    const busy = checkoutBusy === b;
                    return (
                      <button
                        key={b}
                        onClick={() => doCheckout(b, true)}
                        disabled={!!checkoutBusy}
                        style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "transparent", border: "none", borderBottom: "1px solid var(--border-subtle)", color: "var(--text-bright)", fontSize: 14, cursor: "pointer", textAlign: "left", fontFamily: "monospace" }}
                      >
                        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <span style={{ color: "var(--text-faint)" }}>↓</span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b}</span>
                        </span>
                        {busy && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>…</span>}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Toast message */}
      {msg && (
        <div style={{ position: "absolute", bottom: 80, left: 16, right: 16, background: msg.ok ? "var(--bg-hover)" : "var(--bg-hover)", border: `1px solid ${msg.ok ? "var(--accent-green)" : "var(--accent-red)"}`, borderRadius: 8, padding: "10px 14px", color: msg.ok ? "var(--accent-green)" : "var(--accent-red)", fontSize: 13 }}
          onClick={() => setMsg(null)}>
          {msg.text}
        </div>
      )}

      {/* Commit detail bottom sheet */}
      {detailHash && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 300, display: "flex", alignItems: "flex-end" }}
          onClick={() => setDetailHash(null)}>
          <div style={{ width: "100%", background: "var(--bg-surface)", borderRadius: "16px 16px 0 0", padding: "16px 16px 28px", display: "flex", flexDirection: "column", maxHeight: "80vh" }}
            onClick={(e) => e.stopPropagation()}>
            {/* drag handle + hash */}
            <div style={{ width: 36, height: 4, background: "var(--border)", borderRadius: 2, margin: "0 auto 12px" }} />
            <div style={{ fontSize: 13, color: "var(--accent-blue)", fontFamily: "monospace", marginBottom: 8, flexShrink: 0 }}>{detailHash.slice(0, 8)}</div>
            {/* scrollable body: message + files */}
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }}>
              <pre style={{ fontSize: 12, color: "var(--text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: "0 0 12px", fontFamily: "monospace", lineHeight: 1.5 }}>
                {detailMsg}
              </pre>
              {detailFiles.length > 0 && (
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>{detailFiles.length} file{detailFiles.length !== 1 ? "s" : ""} changed</div>
                  {detailFiles.map((f) => (
                    <button key={f.path} onClick={() => { setDiffFile(f); }}
                      style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-base)", border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "8px 10px", marginBottom: 6, cursor: "pointer", textAlign: "left", width: "100%" }}>
                      <span style={{ fontSize: 11, color: "var(--accent-blue)" }}>±</span>
                      <span style={{ fontSize: 12, color: "var(--text-primary)", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                      <span style={{ fontSize: 11, color: "var(--text-faint)" }}>›</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* close always visible at bottom */}
            <button onClick={() => setDetailHash(null)} style={{ ...btn, background: "var(--bg-hover)", color: "var(--text-secondary)", marginTop: 12, flexShrink: 0 }}>Close</button>
          </div>
        </div>
      )}

      {/* File diff full-screen view */}
      {diffFile && (
        <MobileFileDiff file={diffFile} onClose={() => setDiffFile(null)} />
      )}

      {/* Revert confirmation */}
      {revertHash && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 300, display: "flex", alignItems: "flex-end" }}>
          <div style={{ width: "100%", background: "var(--bg-surface)", borderRadius: "16px 16px 0 0", padding: "20px 16px 36px", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ width: 36, height: 4, background: "var(--border)", borderRadius: 2, margin: "0 auto 4px" }} />
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Revert to this commit?</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              This will restore all files to <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{revertHash.slice(0, 8)}</span> and create a new commit. The history is preserved.
            </div>
            <button onClick={doRevert} disabled={reverting}
              style={{ ...btn, background: "var(--accent-red)", color: "var(--text-primary)", border: "1px solid var(--accent-red)", opacity: reverting ? 0.6 : 1 }}>
              {reverting ? "Reverting…" : "Confirm Revert"}
            </button>
            <button onClick={() => setRevertHash(null)} style={{ ...btn, background: "var(--bg-hover)", color: "var(--text-secondary)" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Remote URL editor bottom sheet */}
      {editingRemote && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 300, display: "flex", alignItems: "flex-end" }}
          onClick={() => setEditingRemote(false)}>
          <div style={{ width: "100%", background: "var(--bg-surface)", borderRadius: "16px 16px 0 0", padding: "16px 16px 32px", display: "flex", flexDirection: "column", gap: 10 }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ width: 36, height: 4, background: "var(--border)", borderRadius: 2, margin: "0 auto 4px" }} />
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Git Remote URL</div>
            <input
              value={remoteInput}
              onChange={(e) => setRemoteInput(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              style={{ ...inp, fontSize: 13, fontFamily: "monospace" }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={async () => {
                  try {
                    const res = await gitSetRemote(sessionId, remoteInput.trim());
                    setRemote(res.remote);
                    setMsg({ text: "Remote URL saved", ok: true });
                    setEditingRemote(false);
                  } catch (e) { setMsg({ text: String(e), ok: false }); }
                }}
                disabled={!remoteInput.trim() || remoteInput.trim() === remote}
                style={{ ...btn, flex: 1, background: "var(--accent-green)", color: "#fff", opacity: (!remoteInput.trim() || remoteInput.trim() === remote) ? 0.5 : 1 }}
              >Save</button>
              <button onClick={() => { setRemoteInput(remote); setEditingRemote(false); }}
                style={{ ...btn, flex: 1, background: "var(--bg-hover)", color: "var(--text-secondary)" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* .gitignore editor bottom sheet */}
      {editingGitignore && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 300, display: "flex", alignItems: "flex-end" }}
          onClick={() => setEditingGitignore(false)}>
          <div style={{ width: "100%", background: "var(--bg-surface)", borderRadius: "16px 16px 0 0", padding: "16px 16px 32px", display: "flex", flexDirection: "column", gap: 10, maxHeight: "75vh" }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ width: 36, height: 4, background: "var(--border)", borderRadius: 2, margin: "0 auto 4px" }} />
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>.gitignore</div>
            <textarea
              value={gitignoreDraft}
              onChange={(e) => setGitignoreDraft(e.target.value)}
              style={{ flex: 1, minHeight: 220, background: "var(--bg-base)", border: "1px solid #374151", borderRadius: 6, color: "var(--text-primary)", fontSize: 12, fontFamily: "monospace", padding: "8px 10px", outline: "none", resize: "none" }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={async () => {
                  try {
                    await saveGitignore(sessionId, gitignoreDraft);
                    setGitignore(gitignoreDraft);
                    setMsg({ text: ".gitignore saved", ok: true });
                    setEditingGitignore(false);
                  } catch (e) { setMsg({ text: String(e), ok: false }); }
                }}
                disabled={gitignoreDraft === gitignore}
                style={{ ...btn, flex: 1, background: "var(--accent-green)", color: "#fff", opacity: gitignoreDraft === gitignore ? 0.5 : 1 }}
              >Save</button>
              <button onClick={() => { setGitignoreDraft(gitignore); setEditingGitignore(false); }}
                style={{ ...btn, flex: 1, background: "var(--bg-hover)", color: "var(--text-secondary)" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showMerge && (
        <MobileMergePanel
          sessionId={sessionId}
          branches={branches}
          onClose={() => setShowMerge(false)}
          onCompleted={async () => {
            // Refresh log + branches + merge status after a successful merge/abort
            try {
              const [info, br, ms] = await Promise.all([
                getGitInfo(sessionId).catch(() => null),
                getGitBranches(sessionId).catch(() => branches),
                getMergeStatus(sessionId).catch(() => null),
              ]);
              if (info) setLog(info.log);
              setBranches(br);
              setMergeStatus(ms);
            } catch {}
          }}
        />
      )}
    </div>
  );
}

/* ─── Mobile Merge Panel ─── */

interface ConflictHunk {
  startLine: number;
  endLine: number;
  ours: string[];
  theirs: string[];
}

function parseConflictHunks(content: string): ConflictHunk[] {
  const lines = content.split("\n");
  const hunks: ConflictHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      const startLine = i;
      const ours: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("=======") && !lines[i].startsWith(">>>>>>>")) {
        ours.push(lines[i]); i++;
      }
      const theirs: string[] = [];
      if (i < lines.length && lines[i].startsWith("=======")) {
        i++;
        while (i < lines.length && !lines[i].startsWith(">>>>>>>")) { theirs.push(lines[i]); i++; }
      }
      if (i < lines.length && lines[i].startsWith(">>>>>>>")) {
        hunks.push({ startLine, endLine: i, ours, theirs }); i++;
      }
    } else { i++; }
  }
  return hunks;
}

function replaceLines(content: string, startLine: number, endLine: number, replacement: string[]): string {
  const lines = content.split("\n");
  lines.splice(startLine, endLine - startLine + 1, ...replacement);
  return lines.join("\n");
}

function MobileMergePanel({
  sessionId, branches, onClose, onCompleted,
}: {
  sessionId: string;
  branches: GitBranchInfo;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [status, setStatus] = useState<MergeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<string>("");
  const [target, setTarget] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [backupBranch, setBackupBranch] = useState<string | null>(null);

  const refresh = useCallback(() =>
    getMergeStatus(sessionId).then(s => { setStatus(s); return s; }).catch(e => { setErr(String(e)); return null; }),
  [sessionId]);

  useEffect(() => { refresh().finally(() => setLoading(false)); }, [refresh]);

  useEffect(() => {
    if (target || !branches.local.length) return;
    const def = branches.local.includes("main") ? "main"
      : branches.local.includes("master") ? "master"
      : branches.current || branches.local[0];
    setTarget(def);
  }, [target, branches]);

  // Debounced preview fetch.
  useEffect(() => {
    if (!source || !target || source === target) { setPreview(null); return; }
    let cancelled = false;
    setPreviewLoading(true);
    const handle = setTimeout(async () => {
      try {
        const p = await getMergePreview(sessionId, source, target);
        if (!cancelled) setPreview(p);
      } catch (e) {
        if (!cancelled) setPreview({ merge_kind: "error", error: String(e) });
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [sessionId, source, target]);

  const handleStart = async () => {
    if (!source || !target) return;
    if (source === target) { setErr("Source and target must be different branches."); return; }
    setStarting(true); setErr(null);
    try {
      const r = await gitMergeStart(sessionId, source, target);
      if (r.up_to_date) { setMsg({ text: `${target} is already up to date with ${source}.`, ok: true }); onCompleted(); return; }
      if (r.clean) {
        const bk = r.backup_branch ? ` Backup: ${r.backup_branch}` : "";
        setMsg({ text: `Merged ${source} into ${target} cleanly.${bk}`, ok: true });
        onCompleted();
        return;
      }
      setBackupBranch(r.backup_branch ?? null);
      await refresh();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally { setStarting(false); }
  };

  const selectStyle: React.CSSProperties = {
    background: "var(--bg-surface)", color: "var(--text-body)",
    border: "1px solid var(--border)", borderRadius: 6,
    padding: "8px 10px", fontSize: 14, fontFamily: "monospace", width: "100%",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 280, display: "flex", flexDirection: "column" }}>
      <div style={{ flexShrink: 0, background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Merge</span>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>Loading merge status…</div>
      ) : status?.in_progress ? (
        <MobileMergeResolver
          sessionId={sessionId}
          status={status}
          backupBranch={backupBranch}
          onStatusChange={setStatus}
          onCompleted={() => { setStatus(null); setBackupBranch(null); onCompleted(); onClose(); }}
          setMsg={setMsg}
        />
      ) : branches.local.length < 2 ? (
        <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 13 }}>Need at least 2 local branches to merge.</div>
      ) : (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Merge a source branch into a target branch.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Source</label>
            <select value={source} onChange={(e) => setSource(e.target.value)} style={selectStyle}>
              <option value="">— select source —</option>
              {branches.local.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Target</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)} style={selectStyle}>
              <option value="">— select target —</option>
              {branches.local.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          {source && target && source === target && (
            <div style={{ fontSize: 12, color: "var(--accent-amber)" }}>Source and target must differ.</div>
          )}
          {source && target && source !== target && (
            <MobileMergePreviewBlock
              sessionId={sessionId}
              preview={preview}
              loading={previewLoading}
              source={source}
              target={target}
            />
          )}
          <button
            disabled={!source || !target || source === target || starting}
            onClick={handleStart}
            style={{
              background: !source || !target || source === target ? "var(--bg-hover)" : "var(--accent-blue)",
              color: !source || !target || source === target ? "var(--text-faint)" : "#fff",
              fontSize: 14, padding: "10px 18px", borderRadius: 8, border: "none", marginTop: 4,
            }}
          >
            {starting ? "Merging…" : "Start Merge"}
          </button>
          <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
            Checks out <span style={{ fontFamily: "monospace" }}>{target || "<target>"}</span> (if not already), then runs
            {" "}<span style={{ fontFamily: "monospace" }}>git merge --no-ff --no-edit {source || "<source>"}</span>.
            On conflict, you'll get a per-file resolver.
          </div>
          {err && (
            <div style={{ background: "rgba(248,81,73,0.12)", border: "1px solid var(--accent-red)", borderRadius: 6, padding: "10px 12px", color: "var(--text-body)", fontSize: 12, whiteSpace: "pre-wrap" }}>
              {err}
            </div>
          )}
        </div>
      )}

      {msg && (
        <div onClick={() => setMsg(null)} style={{ position: "absolute", bottom: 16, left: 16, right: 16, background: "var(--bg-hover)", border: `1px solid ${msg.ok ? "var(--accent-green)" : "var(--accent-red)"}`, borderRadius: 8, padding: "10px 14px", color: msg.ok ? "var(--accent-green)" : "var(--accent-red)", fontSize: 13 }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

const _MERGE_STATUS_COLOR: Record<string, string> = {
  M: "var(--accent-amber)", A: "var(--accent-green)", D: "var(--accent-red)",
  R: "var(--accent-blue)", C: "var(--accent-blue)",
};

function _mobileStatusBadge(kind: MergePreview["merge_kind"], err?: string): { label: string; color: string; bg: string } {
  switch (kind) {
    case "up_to_date": return { label: "✓ Up to date", color: "var(--accent-green)", bg: "rgba(63,185,80,0.12)" };
    case "fast_forward": return { label: "→ Fast-forward", color: "var(--accent-blue)", bg: "rgba(88,166,255,0.12)" };
    case "clean": return { label: "✓ Clean merge", color: "var(--accent-green)", bg: "rgba(63,185,80,0.12)" };
    case "conflict": return { label: "⚠ Would conflict", color: "var(--accent-amber)", bg: "rgba(187,128,9,0.15)" };
    case "error": return { label: err ? `✕ ${err}` : "✕ Error", color: "var(--accent-red)", bg: "rgba(248,81,73,0.12)" };
  }
}

function MobileMergePreviewBlock({
  sessionId, preview, loading, source, target,
}: {
  sessionId: string;
  preview: MergePreview | null;
  loading: boolean;
  source: string;
  target: string;
}) {
  const [tab, setTab] = useState<"commits" | "diff">("commits");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const conflictSet = useMemo(
    () => new Set(preview?.conflicting_files ?? []),
    [preview],
  );

  useEffect(() => {
    const files = preview?.changed_files;
    if (!files || files.length === 0) { setSelectedFile(null); return; }
    if (!selectedFile || !files.find(f => f.path === selectedFile)) {
      setSelectedFile(files[0].path);
    }
  }, [preview, selectedFile]);

  useEffect(() => {
    if (tab !== "diff" || !selectedFile) { setDiff(""); setDiffError(null); return; }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    getMergeFileDiff(sessionId, source, target, selectedFile)
      .then(r => {
        if (cancelled) return;
        if (r.error) { setDiffError(r.error); setDiff(""); }
        else { setDiff(r.diff || ""); }
      })
      .catch(e => { if (!cancelled) { setDiffError(String(e)); setDiff(""); } })
      .finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, source, target, selectedFile, tab]);

  if (loading && !preview) {
    return (
      <div style={{ border: "1px solid var(--bg-hover)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-surface)", fontSize: 12, color: "var(--text-muted)" }}>
        Loading preview…
      </div>
    );
  }
  if (!preview) return null;
  const badge = _mobileStatusBadge(preview.merge_kind, preview.error);
  const commits = preview.commits ?? [];
  const files = preview.changed_files ?? [];
  const showTabs = preview.merge_kind !== "error" && preview.merge_kind !== "up_to_date";

  return (
    <div style={{ border: "1px solid var(--bg-hover)", borderRadius: 8, background: "var(--bg-surface)", display: "flex", flexDirection: "column", fontSize: 12 }}>
      <div style={{ padding: "8px 10px", borderBottom: showTabs ? "1px solid var(--bg-hover)" : "none" }}>
        <div style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, background: badge.bg, color: badge.color, fontWeight: 600, marginRight: 6 }}>
          {badge.label}
        </div>
        {preview.merge_kind !== "error" && (
          <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 11 }}>
            <span style={{ color: "var(--accent-blue)", fontFamily: "monospace" }}>{source}</span>:{" "}
            <span style={{ color: "var(--text-body)" }}>{preview.ahead ?? 0}</span> ahead /{" "}
            <span style={{ color: "var(--text-body)" }}>{preview.behind ?? 0}</span> behind{" "}
            <span style={{ color: "var(--accent-amber)", fontFamily: "monospace" }}>{target}</span>
            {loading && <span style={{ color: "var(--text-faint)", marginLeft: 6 }}>(refreshing…)</span>}
          </div>
        )}
      </div>

      {showTabs && (
        <>
          <div style={{ display: "flex", borderBottom: "1px solid var(--bg-hover)" }}>
            <_MobileMergeTabBtn active={tab === "commits"} onClick={() => setTab("commits")}>
              Commits{commits.length > 0 ? ` (${commits.length})` : ""}
            </_MobileMergeTabBtn>
            <_MobileMergeTabBtn active={tab === "diff"} onClick={() => setTab("diff")}>
              Code{files.length > 0 ? ` (${files.length})` : ""}
            </_MobileMergeTabBtn>
          </div>

          {tab === "commits" ? (
            commits.length === 0 ? (
              <div style={{ padding: "10px 12px", color: "var(--text-muted)" }}>(no commits)</div>
            ) : (
              <div style={{ maxHeight: 220, overflowY: "auto" }}>
                {commits.map(c => (
                  <div key={c.hash} style={{ padding: "6px 10px", borderBottom: "1px solid var(--bg-hover)" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                      <span style={{ fontFamily: "monospace", color: "var(--accent-amber)", fontSize: 11 }}>{c.short}</span>
                      <span style={{ color: "var(--text-faint)", fontSize: 10, marginLeft: "auto" }}>{c.author}</span>
                    </div>
                    <div style={{ color: "var(--text-body)", fontSize: 12, marginTop: 2, wordBreak: "break-word" }}>
                      {c.subject}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            <_MobileDiffTabBody
              files={files}
              conflictSet={conflictSet}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              diff={diff}
              diffLoading={diffLoading}
              diffError={diffError}
            />
          )}
        </>
      )}
    </div>
  );
}

function _MobileMergeTabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: active ? "var(--bg-base)" : "transparent",
        color: active ? "var(--accent-blue)" : "var(--text-secondary)",
        border: "none",
        borderBottom: active ? "2px solid var(--accent-blue)" : "2px solid transparent",
        padding: "8px 0", fontSize: 13, cursor: "pointer", fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}

function _MobileDiffTabBody({
  files, conflictSet, selectedFile, onSelectFile,
  diff, diffLoading, diffError,
}: {
  files: Array<{ path: string; status: string }>;
  conflictSet: Set<string>;
  selectedFile: string | null;
  onSelectFile: (p: string) => void;
  diff: string;
  diffLoading: boolean;
  diffError: string | null;
}) {
  if (files.length === 0) {
    return <div style={{ padding: "10px 12px", color: "var(--text-muted)" }}>(no file changes)</div>;
  }
  return (
    <div>
      {/* File chips, horizontally scrollable */}
      <div style={{ display: "flex", gap: 6, padding: "8px 10px", overflowX: "auto", borderBottom: "1px solid var(--bg-hover)" }}>
        {files.map(f => {
          const isConflict = conflictSet.has(f.path);
          const isActive = f.path === selectedFile;
          return (
            <button
              key={f.path}
              onClick={() => onSelectFile(f.path)}
              title={f.path}
              style={{
                flexShrink: 0, padding: "4px 8px", fontSize: 11, fontFamily: "monospace",
                border: isActive ? "1px solid var(--accent-blue)" : "1px solid var(--bg-hover)",
                background: isActive ? "rgba(88,166,255,0.15)" : "var(--bg-base)",
                color: isConflict ? "var(--accent-red)" : "var(--text-body)",
                borderRadius: 4, cursor: "pointer", maxWidth: 200,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              <span style={{ color: _MERGE_STATUS_COLOR[f.status] || "var(--text-muted)", marginRight: 4 }}>{f.status}</span>
              {f.path.split("/").pop()}
              {isConflict && <span style={{ marginLeft: 4 }}>⚠</span>}
            </button>
          );
        })}
      </div>
      {/* Diff viewer */}
      <div style={{ maxHeight: 280, overflow: "auto", background: "var(--bg-base)" }}>
        {diffLoading ? (
          <div style={{ padding: 12, color: "var(--text-muted)" }}>Loading diff…</div>
        ) : diffError ? (
          <div style={{ padding: 12, color: "var(--accent-red)" }}>{diffError}</div>
        ) : !diff ? (
          <div style={{ padding: 12, color: "var(--text-muted)" }}>(empty diff)</div>
        ) : (
          <pre style={{ margin: 0, padding: "6px 10px", fontSize: 11, fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,"Courier New",monospace', whiteSpace: "pre" }}>
            {diff.split("\n").map((ln, i) => {
              let color = "var(--text-body)"; let bg = "transparent";
              if (ln.startsWith("+++") || ln.startsWith("---")) color = "var(--text-faint)";
              else if (ln.startsWith("@@")) { color = "var(--accent-blue)"; bg = "rgba(88,166,255,0.08)"; }
              else if (ln.startsWith("+")) { color = "var(--accent-green)"; bg = "rgba(63,185,80,0.08)"; }
              else if (ln.startsWith("-")) { color = "var(--accent-red)"; bg = "rgba(248,81,73,0.08)"; }
              else if (ln.startsWith("diff --git")) color = "var(--text-faint)";
              return <div key={i} style={{ color, background: bg, whiteSpace: "pre" }}>{ln || " "}</div>;
            })}
          </pre>
        )}
      </div>
    </div>
  );
}

function MobileMergeResolver({
  sessionId, status, backupBranch, onStatusChange, onCompleted, setMsg,
}: {
  sessionId: string;
  status: MergeStatus;
  backupBranch: string | null;
  onStatusChange: (s: MergeStatus) => void;
  onCompleted: () => void;
  setMsg: (m: { text: string; ok: boolean } | null) => void;
}) {
  const files = status.conflicted_files;
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [busy, setBusy] = useState<"abort" | "continue" | null>(null);
  const [confirmAbort, setConfirmAbort] = useState(false);

  const handleContinue = async () => {
    setBusy("continue");
    try {
      const r = await gitMergeContinue(sessionId);
      setMsg({ text: r.output || "Merge completed.", ok: true });
      onCompleted();
    } catch (e) {
      setMsg({ text: String(e), ok: false });
    } finally { setBusy(null); }
  };
  const doAbort = async () => {
    setBusy("abort");
    try {
      const r = await gitMergeAbort(sessionId);
      setMsg({ text: r.output || "Merge aborted.", ok: true });
      onCompleted();
    } catch (e) {
      setMsg({ text: String(e), ok: false });
    } finally { setBusy(null); setConfirmAbort(false); }
  };

  const allResolved = files.length === 0;

  if (activeFile) {
    return (
      <MobileFileResolver
        sessionId={sessionId}
        path={activeFile}
        onBack={() => setActiveFile(null)}
        onResolved={(s) => { onStatusChange(s); setActiveFile(null); }}
        setMsg={setMsg}
      />
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {backupBranch && (
        <div style={{ padding: "6px 14px", fontSize: 11, background: "rgba(88,166,255,0.08)", borderBottom: "1px solid var(--border)", color: "var(--text-body)", display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
          <span><span style={{ color: "var(--accent-blue)" }}>💾 Backup:</span> <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{backupBranch}</span></span>
          <span style={{ color: "var(--text-muted)" }}>Roll back: <span style={{ fontFamily: "monospace" }}>git reset --hard {backupBranch}</span></span>
        </div>
      )}
      <div style={{ padding: "10px 14px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ fontSize: 13, color: "var(--text-body)" }}>
          Merging <span style={{ fontFamily: "monospace", color: "var(--accent-amber)" }}>{status.merge_head}</span> → <span style={{ fontFamily: "monospace", color: "var(--accent-blue)" }}>{status.current_branch}</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
          {allResolved ? "All conflicts resolved." : `${files.length} file${files.length === 1 ? "" : "s"} remaining`}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {files.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--accent-green)", fontSize: 14 }}>✓ All resolved — tap Continue Merge below.</div>
        ) : (
          files.map(f => (
            <button
              key={f}
              onClick={() => setActiveFile(f)}
              style={{
                display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between",
                padding: "14px 16px", background: "transparent", border: "none",
                borderBottom: "1px solid var(--border-subtle)",
                color: "var(--text-bright)", fontSize: 13, fontFamily: "monospace", textAlign: "left", cursor: "pointer",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{f}</span>
              <span style={{ fontSize: 16, color: "var(--text-muted)", flexShrink: 0, marginLeft: 8 }}>›</span>
            </button>
          ))
        )}
      </div>

      <div style={{ flexShrink: 0, padding: "12px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-surface)", display: "flex", gap: 8 }}>
        <button
          onClick={() => setConfirmAbort(true)} disabled={busy !== null}
          style={{ flex: 1, background: "var(--bg-hover)", color: "var(--accent-red)", border: "1px solid var(--accent-red)", borderRadius: 6, padding: "10px 14px", fontSize: 13 }}
        >
          {busy === "abort" ? "Aborting…" : "Abort"}
        </button>
        <button
          disabled={!allResolved || busy !== null}
          onClick={handleContinue}
          style={{
            flex: 1,
            background: allResolved && busy === null ? "var(--accent-green)" : "var(--bg-hover)",
            color: allResolved && busy === null ? "#fff" : "var(--text-faint)",
            border: "none", borderRadius: 6, padding: "10px 14px", fontSize: 13, fontWeight: 600,
          }}
        >
          {busy === "continue" ? "Committing…" : "Continue"}
        </button>
      </div>

      {confirmAbort && (
        <div onClick={busy ? undefined : () => setConfirmAbort(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 300, display: "flex", alignItems: "flex-end" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", background: "var(--bg-surface)", borderRadius: "16px 16px 0 0", padding: "16px 16px 28px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ width: 36, height: 4, background: "var(--border)", borderRadius: 2, margin: "0 auto 4px" }} />
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)" }}>Abort merge?</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              This restores the working tree to its state before the merge started. Any resolutions you've saved will be lost.
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={() => setConfirmAbort(false)} disabled={busy !== null}
                style={{ flex: 1, background: "var(--bg-hover)", color: "var(--text-secondary)", border: "none", borderRadius: 6, padding: "10px 14px", fontSize: 13 }}>Cancel</button>
              <button onClick={doAbort} disabled={busy !== null}
                style={{ flex: 1, background: "var(--accent-red)", color: "#fff", border: "none", borderRadius: 6, padding: "10px 14px", fontSize: 13, fontWeight: 600 }}>
                {busy === "abort" ? "Aborting…" : "Abort Merge"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MobileFileResolver({
  sessionId, path, onBack, onResolved, setMsg,
}: {
  sessionId: string;
  path: string;
  onBack: () => void;
  onResolved: (s: MergeStatus) => void;
  setMsg: (m: { text: string; ok: boolean } | null) => void;
}) {
  const [versions, setVersions] = useState<ConflictFileVersions | null>(null);
  const [result, setResult] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"result" | "ours" | "theirs">("result");

  useEffect(() => {
    setLoading(true);
    getMergeConflictFile(sessionId, path)
      .then(v => { setVersions(v); setResult(v.working); })
      .catch(e => setMsg({ text: String(e), ok: false }))
      .finally(() => setLoading(false));
  }, [sessionId, path, setMsg]);

  const hunks = useMemo(() => parseConflictHunks(result), [result]);
  const acceptHunk = (hunk: ConflictHunk, choice: "ours" | "theirs" | "both") => {
    const replacement = choice === "ours" ? hunk.ours : choice === "theirs" ? hunk.theirs : [...hunk.ours, ...hunk.theirs];
    setResult(prev => replaceLines(prev, hunk.startLine, hunk.endLine, replacement));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await gitResolveFile(sessionId, path, result);
      setMsg({ text: `Resolved ${path}`, ok: true });
      onResolved(r.status);
    } catch (e) {
      setMsg({ text: String(e), ok: false });
    } finally { setSaving(false); }
  };

  const hasMarkers = hunks.length > 0;
  const codeStyle: React.CSSProperties = {
    margin: 0, padding: "10px 12px", fontSize: 11, lineHeight: 1.5,
    fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,monospace',
    whiteSpace: "pre", color: "var(--text-body)", overflow: "auto",
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flexShrink: 0, background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={onBack} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 20, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: "monospace", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{path}</span>
      </div>

      <div style={{ flexShrink: 0, display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
        {([
          ["result", "Result", "var(--text-body)"],
          ["ours", "Ours", "var(--accent-blue)"],
          ["theirs", "Theirs", "var(--accent-amber)"],
        ] as const).map(([id, label, color]) => (
          <button
            key={id} onClick={() => setTab(id)}
            style={{
              flex: 1, background: "transparent", border: "none",
              borderBottom: tab === id ? `2px solid ${color}` : "2px solid transparent",
              color: tab === id ? color : "var(--text-faint)",
              fontSize: 12, fontWeight: 600, padding: "8px 0", cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto", background: "var(--bg-base)" }}>
        {loading || !versions ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
        ) : tab === "ours" ? (
          <pre style={codeStyle}>{versions.ours}</pre>
        ) : tab === "theirs" ? (
          <pre style={codeStyle}>{versions.theirs}</pre>
        ) : (
          <MobileResultHunkView content={result} hunks={hunks} onAccept={acceptHunk} />
        )}
      </div>

      <div style={{ flexShrink: 0, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-surface)", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}>
          {hasMarkers ? `${hunks.length} unresolved hunk${hunks.length === 1 ? "" : "s"}` : "No markers — ready"}
        </span>
        <button
          disabled={hasMarkers || saving}
          onClick={handleSave}
          style={{
            background: !hasMarkers && !saving ? "var(--accent-blue)" : "var(--bg-hover)",
            color: !hasMarkers && !saving ? "#fff" : "var(--text-faint)",
            border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 600,
          }}
        >
          {saving ? "Saving…" : "Mark Resolved"}
        </button>
      </div>
    </div>
  );
}

function MobileResultHunkView({
  content, hunks, onAccept,
}: {
  content: string;
  hunks: ConflictHunk[];
  onAccept: (h: ConflictHunk, choice: "ours" | "theirs" | "both") => void;
}) {
  const lines = content.split("\n");
  type Segment = { kind: "text"; text: string } | { kind: "hunk"; hunk: ConflictHunk };
  const segments: Segment[] = [];
  let cursor = 0;
  for (const h of hunks) {
    if (h.startLine > cursor) segments.push({ kind: "text", text: lines.slice(cursor, h.startLine).join("\n") });
    segments.push({ kind: "hunk", hunk: h });
    cursor = h.endLine + 1;
  }
  if (cursor < lines.length) segments.push({ kind: "text", text: lines.slice(cursor).join("\n") });

  const codeStyle: React.CSSProperties = {
    margin: 0, padding: "4px 12px", fontSize: 11, lineHeight: 1.5,
    fontFamily: '"Cascadia Code","Fira Code",Menlo,Monaco,monospace',
    whiteSpace: "pre", color: "var(--text-body)", overflow: "auto",
  };

  return (
    <div>
      {segments.length === 0 && (
        <div style={{ padding: 16, fontSize: 13, color: "var(--text-muted)" }}>(empty)</div>
      )}
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          if (!seg.text) return null;
          return <pre key={i} style={codeStyle}>{seg.text}</pre>;
        }
        const h = seg.hunk;
        return (
          <div key={i} style={{ margin: "8px 10px", border: "1px solid var(--accent-amber)", borderRadius: 6, overflow: "hidden", background: "var(--bg-surface)" }}>
            <div style={{ padding: "8px 10px", background: "rgba(187,128,9,0.15)", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 11, color: "var(--accent-amber)", fontWeight: 600 }}>Conflict</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => onAccept(h, "ours")} style={{ flex: 1, background: "var(--accent-blue)", color: "#fff", border: "none", borderRadius: 4, padding: "6px 0", fontSize: 11 }}>Ours</button>
                <button onClick={() => onAccept(h, "theirs")} style={{ flex: 1, background: "var(--accent-amber)", color: "#000", border: "none", borderRadius: 4, padding: "6px 0", fontSize: 11 }}>Theirs</button>
                <button onClick={() => onAccept(h, "both")} style={{ flex: 1, background: "var(--bg-hover)", color: "var(--text-body)", border: "1px solid var(--border)", borderRadius: 4, padding: "6px 0", fontSize: 11 }}>Both</button>
              </div>
            </div>
            <div style={{ borderTop: "1px solid var(--border-subtle)", background: "rgba(88,166,255,0.06)" }}>
              <div style={{ padding: "2px 10px", fontSize: 10, color: "var(--accent-blue)", background: "rgba(88,166,255,0.12)" }}>Ours</div>
              <pre style={codeStyle}>{h.ours.join("\n")}</pre>
            </div>
            <div style={{ borderTop: "1px solid var(--border-subtle)", background: "rgba(187,128,9,0.06)" }}>
              <div style={{ padding: "2px 10px", fontSize: 10, color: "var(--accent-amber)", background: "rgba(187,128,9,0.12)" }}>Theirs</div>
              <pre style={codeStyle}>{h.theirs.join("\n")}</pre>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Mobile Schedule Panel ─── */
type DelayUnit = "seconds" | "minutes" | "hours";
const _UNIT_SECS: Record<DelayUnit, number> = { seconds: 1, minutes: 60, hours: 3600 };
function _toSeconds(value: string, unit: DelayUnit): number {
  return Math.max(1, parseInt(value, 10) || 1) * _UNIT_SECS[unit];
}

function MobileSchedulePanel({
  sessionId, tasks, onTasksChange, onClose,
}: {
  sessionId: string;
  tasks: ScheduledTask[];
  onTasksChange: (tasks: ScheduledTask[]) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [delayValue, setDelayValue] = useState("5");
  const [delayUnit, setDelayUnit] = useState<DelayUnit>("minutes");
  const [loopEnabled, setLoopEnabled] = useState(false);
  // Loop value/unit mirror After until the user explicitly edits them
  // (same UX as the PC ScheduleForm).
  const [loopValue, setLoopValue] = useState("5");
  const [loopUnit, setLoopUnit] = useState<DelayUnit>("minutes");
  const [loopValueTouched, setLoopValueTouched] = useState(false);
  const [loopUnitTouched, setLoopUnitTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { if (!loopValueTouched) setLoopValue(delayValue); }, [delayValue, loopValueTouched]);
  useEffect(() => { if (!loopUnitTouched) setLoopUnit(delayUnit); }, [delayUnit, loopUnitTouched]);

  const pendingTasks = tasks.filter(t => t.status === "pending");

  const submit = async () => {
    if (!prompt.trim()) return;
    const delay = _toSeconds(delayValue, delayUnit);
    if (delay <= 0) { setErr("Delay must be > 0"); return; }
    let loop_seconds: number | null = null;
    if (loopEnabled) {
      loop_seconds = _toSeconds(loopValue, loopUnit);
      if (loop_seconds <= 0) { setErr("Loop interval must be > 0"); return; }
    }
    setSubmitting(true); setErr("");
    try {
      const t = await createTask(sessionId, prompt.trim(), delay, loop_seconds);
      onTasksChange([...tasks, t]);
      setPrompt(""); setDelayValue("5"); setDelayUnit("minutes");
      setLoopEnabled(false); setLoopValue("5"); setLoopUnit("minutes");
      setLoopValueTouched(false); setLoopUnitTouched(false);
    } catch (e) { setErr(String(e)); }
    finally { setSubmitting(false); }
  };

  const cancel = async (taskId: string) => {
    try {
      await cancelTask(sessionId, taskId);
      onTasksChange(tasks.filter(t => t.id !== taskId));
    } catch {}
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 200, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 16px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Scheduled Prompts</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 14px", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* New task form */}
        <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>New Scheduled Prompt</div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Prompt to send…"
            rows={3}
            style={{ background: "var(--bg-base)", border: "1px solid #374151", borderRadius: 8, padding: "8px 10px", color: "var(--text-primary)", fontSize: 14, resize: "none", outline: "none", width: "100%", boxSizing: "border-box", fontFamily: "inherit" }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)", width: 48, flexShrink: 0 }}>After</span>
            <input
              type="number" min={1} value={delayValue}
              onChange={(e) => setDelayValue(e.target.value)}
              style={{ width: 72, background: "var(--bg-base)", border: "1px solid #374151", borderRadius: 6, padding: "6px 8px", color: "var(--text-primary)", fontSize: 14, outline: "none", textAlign: "right" }}
            />
            <select
              value={delayUnit}
              onChange={(e) => setDelayUnit(e.target.value as DelayUnit)}
              style={{ background: "var(--bg-hover)", border: "1px solid #374151", borderRadius: 6, color: "var(--text-primary)", fontSize: 13, padding: "6px 8px", cursor: "pointer" }}
            >
              <option value="seconds">seconds</option>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
            <label
              title="Repeat this prompt at a fixed interval after each fire"
              style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", cursor: "pointer", fontSize: 13, color: loopEnabled ? "#a78bfa" : "var(--text-muted)" }}
            >
              <input
                type="checkbox"
                checked={loopEnabled}
                onChange={(e) => setLoopEnabled(e.target.checked)}
                style={{ cursor: "pointer", margin: 0, width: 16, height: 16 }}
              />
              <span>↻ Loop</span>
            </label>
          </div>
          {loopEnabled && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "#a78bfa", width: 48, flexShrink: 0 }}>Every</span>
              <input
                type="number" min={1} value={loopValue}
                onChange={(e) => { setLoopValue(e.target.value); setLoopValueTouched(true); }}
                style={{ width: 72, background: "var(--bg-base)", border: "1px solid #7c3aed", borderRadius: 6, padding: "6px 8px", color: "var(--text-primary)", fontSize: 14, outline: "none", textAlign: "right" }}
              />
              <select
                value={loopUnit}
                onChange={(e) => { setLoopUnit(e.target.value as DelayUnit); setLoopUnitTouched(true); }}
                style={{ background: "var(--bg-hover)", border: "1px solid #7c3aed", borderRadius: 6, color: "var(--text-primary)", fontSize: 13, padding: "6px 8px", cursor: "pointer" }}
              >
                <option value="seconds">seconds</option>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
              <span style={{ fontSize: 11, color: "var(--text-faint)", marginLeft: "auto" }}>after each fire</span>
            </div>
          )}
          {err && <div style={{ fontSize: 12, color: "var(--accent-red)" }}>{err}</div>}
          <button
            onClick={submit}
            disabled={submitting || !prompt.trim()}
            style={{ background: submitting || !prompt.trim() ? "var(--bg-hover)" : loopEnabled ? "#7c3aed" : "var(--accent-green)", color: submitting || !prompt.trim() ? "var(--text-faint)" : "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 14, cursor: submitting || !prompt.trim() ? "default" : "pointer" }}
          >
            {submitting ? "Scheduling…" : loopEnabled ? "Schedule loop" : "Schedule"}
          </button>
        </div>

        {/* Pending tasks */}
        {pendingTasks.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>Pending ({pendingTasks.length})</div>
            {pendingTasks.map((t) => {
              const runAt = new Date(t.run_at);
              const secondsLeft = Math.max(0, Math.round((runAt.getTime() - Date.now()) / 1000));
              const minsLeft = Math.floor(secondsLeft / 60);
              const secsLeft = secondsLeft % 60;
              const isLoop = !!t.loop_seconds;
              const loopSec = t.loop_seconds ?? 0;
              const loopLabel = loopSec < 60 ? `${loopSec}s` : loopSec < 3600 ? `${Math.floor(loopSec / 60)}m` : `${Math.floor(loopSec / 3600)}h`;
              return (
                <div key={t.id} style={{ background: isLoop ? "rgba(124,58,237,0.15)" : "var(--bg-surface)", border: isLoop ? "1px solid #7c3aed" : "1px solid var(--border-subtle)", borderRadius: 8, padding: "10px 12px", display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      {isLoop && <span style={{ color: "#a78bfa", fontSize: 12, fontWeight: 700 }}>↻ every {loopLabel}</span>}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 4, wordBreak: "break-word" }}>{t.command}</div>
                    <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                      Runs at {runAt.toLocaleTimeString()} · in {minsLeft > 0 ? `${minsLeft}m ` : ""}{secsLeft}s
                    </div>
                  </div>
                  <button
                    onClick={() => cancel(t.id)}
                    style={{ background: "var(--bg-hover)", border: "1px solid #6e3030", color: "var(--accent-red)", fontSize: 11, padding: "4px 8px", borderRadius: 6, flexShrink: 0, cursor: "pointer" }}
                  >Cancel</button>
                </div>
              );
            })}
          </div>
        )}

        {pendingTasks.length === 0 && (
          <div style={{ textAlign: "center", padding: 24, color: "var(--text-faint)", fontSize: 13 }}>No pending scheduled prompts</div>
        )}
      </div>
    </div>
  );
}

/* ─── Mobile Tasks Panel (TodoWrite / TaskCreate snapshots) ─── */
function MobileTasksPanel({
  sessionId, onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [active, setActive] = useState<TodoItem[]>([]);
  const [history, setHistory] = useState<TodoPlan[]>([]);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const data = await listSessionTodos(sessionId);
      setActive(data.active || []);
      setHistory(data.history || []);
    } catch { /* ignore */ }
    finally { setLoaded(true); }
  }, [sessionId]);
  useEffect(() => {
    refresh();
    // Full-screen panel, actively watched — poll at second-level (1.5s, matching
    // the Chat pane) so status transitions stay near-real-time instead of
    // lagging up to 5s.
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [refresh]);

  const total = active.length;
  const done = active.filter(t => t.status === "completed").length;
  const inProg = active.filter(t => t.status === "in_progress").length;
  const pending = total - done - inProg;
  const statusIcon = (s: TodoItem["status"]) => s === "completed" ? "✓" : s === "in_progress" ? "▶" : "○";
  const statusColor = (s: TodoItem["status"]) => s === "completed" ? "var(--accent-green)" : s === "in_progress" ? "var(--accent-amber)" : "var(--text-faint)";

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 200, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 16px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Tasks</span>
        <button onClick={refresh} title="Refresh" style={{ marginLeft: "auto", background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, padding: "2px 8px", borderRadius: 4 }}>⟳</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "14px", display: "flex", flexDirection: "column", gap: 14 }}>
        {!loaded && <div style={{ color: "var(--text-faint)", textAlign: "center", padding: 16 }}>Loading…</div>}
        {loaded && total === 0 && history.length === 0 && (
          <div style={{ color: "var(--text-faint)", textAlign: "center", padding: 24, fontSize: 13 }}>No tasks yet.</div>
        )}

        {total > 0 && (
          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-blue)", marginBottom: 6 }}>Active</div>
            <div style={{ height: 6, borderRadius: 3, background: "var(--bg-hover)", overflow: "hidden", position: "relative", marginBottom: 6 }}>
              {done > 0 && <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${(done / total) * 100}%`, background: "var(--accent-green)" }} />}
              {inProg > 0 && <div style={{ position: "absolute", left: `${(done / total) * 100}%`, top: 0, height: "100%", width: `${(inProg / total) * 100}%`, background: "#f59e0b88" }} />}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 10 }}>
              {done} done · {inProg} in progress · {pending} pending
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {active.map((t, i) => (
                <div key={t.id ?? i} style={{
                  display: "flex", alignItems: "flex-start", gap: 8,
                  padding: "6px 8px", borderRadius: 4,
                  background: t.status === "in_progress" ? "rgba(245,158,11,0.08)" : "transparent",
                  border: "1px solid " + (t.status === "in_progress" ? "rgba(245,158,11,0.3)" : "transparent"),
                }}>
                  <span style={{ fontSize: 12, color: statusColor(t.status), flexShrink: 0, marginTop: 2, fontFamily: "monospace" }}>{statusIcon(t.status)}</span>
                  <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span style={{
                      fontSize: 13, lineHeight: 1.45,
                      color: t.status === "completed" ? "var(--text-faint)" : "var(--text-secondary)",
                      wordBreak: "break-word",
                    }}>{t.content}</span>
                    {t.description && (
                      <span style={{
                        fontSize: 12, lineHeight: 1.4, color: "var(--text-faint)",
                        wordBreak: "break-word",
                        opacity: t.status === "completed" ? 0.7 : 1,
                      }}>{t.description}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-faint)" }}>History ({history.length})</div>
            {history.map((plan, i) => (
              <MobileTodoHistoryRow key={`${plan.completed_ts}-${i}`} plan={plan} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MobileTodoHistoryRow({ plan }: { plan: TodoPlan }) {
  const [expanded, setExpanded] = useState(false);
  const total = plan.todos.length;
  const fmt = (ts: number) => {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return (
    <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", opacity: 0.85 }}>
      <div onClick={() => setExpanded(v => !v)} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
        <span style={{ color: "var(--text-faint)", fontSize: 11, width: 10 }}>{expanded ? "▼" : "▶"}</span>
        <span style={{ color: "var(--accent-green)", fontSize: 12, flexShrink: 0, fontFamily: "monospace" }}>✓</span>
        <span style={{ flex: 1, fontSize: 12, color: "var(--text-secondary)" }}>{total} task{total === 1 ? "" : "s"} done</span>
        <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-faint)" }}>{fmt(plan.created_ts)} → {fmt(plan.completed_ts)}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 4 }}>
          {plan.todos.map((t, i) => (
            <div key={t.id ?? i} style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
              <span style={{ color: "var(--accent-green)", fontSize: 11, flexShrink: 0, marginTop: 2, fontFamily: "monospace" }}>✓</span>
              <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 12, lineHeight: 1.4, color: "var(--text-faint)", wordBreak: "break-word" }}>{t.content}</span>
                {t.description && (
                  <span style={{ fontSize: 11, lineHeight: 1.4, color: "var(--text-faint)", opacity: 0.75, wordBreak: "break-word" }}>{t.description}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Mobile Goals Panel (/goal history) ─── */
function MobileGoalsPanel({
  sessionId, onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [active, setActive] = useState<Goal | null>(null);
  const [history, setHistory] = useState<Goal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const data = await listGoals(sessionId);
      setActive(data.active);
      setHistory(data.history || []);
    } catch { /* ignore */ }
    finally { setLoaded(true); }
  }, [sessionId]);
  useEffect(() => {
    refresh();
    // Full-screen panel, actively watched — poll at second-level (1.5s, matching
    // the Chat pane) so status transitions stay near-real-time instead of
    // lagging up to 5s.
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [refresh]);

  const fmt = (ts: number) => {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const historyDesc = [...history].sort((a, b) => b.set_at - a.set_at);

  const renderRow = (g: Goal, status: "active" | "met" | "replaced" | "closed") => {
    const struck = status === "met";
    const badge =
      status === "active" ? { text: `${g.checks} check${g.checks === 1 ? "" : "s"}`, color: "var(--accent-blue)" } :
      status === "met" ? { text: `met @ ${fmt(g.met_at || 0)}`, color: "#5cb85c" } :
      status === "replaced" ? { text: "replaced", color: "var(--text-faint)" } :
      { text: "closed", color: "var(--text-faint)" };
    return (
      <div key={`${g.set_at}-${g.condition}`} style={{
        background: "var(--bg-surface)",
        border: "1px solid " + (status === "active" ? "rgba(88,166,255,0.4)" : "var(--border)"),
        borderRadius: 8, padding: "10px 12px", opacity: status === "active" ? 1 : 0.78,
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <span style={{
            flex: 1, minWidth: 0, color: "var(--text-body)", fontSize: 13,
            textDecoration: struck ? "line-through" : "none", wordBreak: "break-word", lineHeight: 1.45,
          }}>{g.condition}</span>
          <span style={{ flexShrink: 0, color: badge.color, fontSize: 11, marginTop: 2, whiteSpace: "nowrap" }}>{badge.text}</span>
        </div>
        {g.last_reason && (
          <div style={{ marginTop: 4, color: "var(--text-faint)", fontSize: 12, lineHeight: 1.4, fontStyle: "italic" }}>{g.last_reason}</div>
        )}
      </div>
    );
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 200, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 16px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Goals</span>
        <button onClick={refresh} title="Refresh" style={{ marginLeft: "auto", background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, padding: "2px 8px", borderRadius: 4 }}>⟳</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "14px", display: "flex", flexDirection: "column", gap: 14 }}>
        {!loaded && <div style={{ color: "var(--text-faint)", textAlign: "center", padding: 16 }}>Loading…</div>}
        {loaded && !active && historyDesc.length === 0 && (
          <div style={{ color: "var(--text-faint)", textAlign: "center", padding: 24, fontSize: 13, lineHeight: 1.5 }}>
            No goals set yet.<br />
            <span style={{ fontSize: 12 }}>
              Use <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 3 }}>/goal &lt;condition&gt;</code> in chat to set one.
            </span>
          </div>
        )}
        {active && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-blue)", marginBottom: 6 }}>Active</div>
            {renderRow(active, "active")}
          </div>
        )}
        {historyDesc.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-faint)" }}>History ({historyDesc.length})</div>
            {historyDesc.map(g => renderRow(g, g.met ? "met" : g.replaced ? "replaced" : "closed"))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Mobile AUQs Panel (AskUserQuestion history) ─── */
function MobileAuqsPanel({
  sessionId, onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [auqs, setAuqs] = useState<AuqEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sort, setSort] = useState<"asc" | "desc">(() => (localStorage.getItem("auqsPanelSort") === "desc" ? "desc" : "asc"));
  const [showOptions, setShowOptions] = useState<boolean>(() => localStorage.getItem("auqsPanelShowOptions") === "1");
  const refresh = useCallback(async () => {
    try { setAuqs(await listSessionAuqs(sessionId)); } catch { /* ignore */ }
    finally { setLoaded(true); }
  }, [sessionId]);
  useEffect(() => {
    refresh();
    // Full-screen panel, actively watched — poll at second-level (1.5s, matching
    // the Chat pane) so status transitions stay near-real-time instead of
    // lagging up to 5s.
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [refresh]);

  const fmt = (ts: number) => {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const toggleSort = () => {
    const next = sort === "asc" ? "desc" : "asc";
    setSort(next);
    try { localStorage.setItem("auqsPanelSort", next); } catch {}
  };
  const toggleShowOptions = () => {
    const next = !showOptions;
    setShowOptions(next);
    try { localStorage.setItem("auqsPanelShowOptions", next ? "1" : "0"); } catch {}
  };
  const sorted = [...auqs].sort((a, b) => sort === "asc" ? a.ts - b.ts : b.ts - a.ts);

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 200, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 16px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>AUQs {loaded ? `(${auqs.length})` : ""}</span>
        <button
          onClick={toggleShowOptions}
          title={showOptions ? "Show only Q + answer" : "Show all options"}
          style={{
            marginLeft: "auto",
            background: showOptions ? "color-mix(in srgb, var(--accent-blue) 18%, var(--bg-base))" : "transparent",
            border: "1px solid var(--border)",
            color: showOptions ? "var(--accent-blue)" : "var(--text-secondary)",
            cursor: "pointer", fontSize: 11, padding: "2px 8px", borderRadius: 4,
          }}
        >
          {showOptions ? "⊟ Options" : "⊞ Options"}
        </button>
        <button onClick={toggleSort} style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 11, padding: "2px 8px", borderRadius: 4 }}>
          {sort === "asc" ? "↑ Old→New" : "↓ New→Old"}
        </button>
        <button onClick={refresh} title="Refresh" style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, padding: "2px 8px", borderRadius: 4 }}>⟳</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "14px", display: "flex", flexDirection: "column", gap: 10 }}>
        {!loaded && <div style={{ color: "var(--text-faint)", textAlign: "center", padding: 16 }}>Loading…</div>}
        {loaded && auqs.length === 0 && (
          <div style={{ color: "var(--text-faint)", textAlign: "center", padding: 24, fontSize: 13 }}>No AskUserQuestion rounds in this session yet.</div>
        )}
        {sorted.map((a, idx) => {
          const pending = !a.answers;
          const indexLabel = sort === "asc" ? idx + 1 : auqs.length - idx;
          return (
            <div key={a.tool_use_id} style={{
              background: "var(--bg-surface)",
              border: "1px solid " + (pending ? "rgba(245,158,11,0.4)" : "var(--border)"),
              borderRadius: 8, padding: "10px 12px",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-faint)" }}>#{indexLabel} · {fmt(a.ts)}</span>
                <span style={{ fontSize: 11, color: pending ? "#f59e0b" : "#5cb85c" }}>
                  {pending ? "pending" : `answered @ ${fmt(a.answered_ts || 0)}`}
                </span>
              </div>
              {a.questions.map((q, qi) => {
                const answer = a.answers?.[q.question];
                const optionLabels = new Set((q.options ?? []).map((o) => o.label));
                const answerParts = (answer ?? "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                const isCustom =
                  !!answer && optionLabels.size > 0 &&
                  answerParts.some((p) => !optionLabels.has(p));
                return (
                  <div key={qi} style={{ marginTop: qi > 0 ? 8 : 0 }}>
                    <div style={{ color: "var(--text-body)", fontSize: 13, lineHeight: 1.4, wordBreak: "break-word" }}>
                      <span style={{ color: "var(--text-faint)", marginRight: 4 }}>Q:</span>{q.question}
                    </div>
                    {answer ? (
                      <div style={{ marginTop: 3, color: "var(--accent-blue)", fontSize: 13, lineHeight: 1.4, paddingLeft: 18, wordBreak: "break-word" }}>
                        <span style={{ color: "var(--text-faint)", marginLeft: -18, marginRight: 4 }}>A:</span>{answer}
                        {isCustom && (
                          <span
                            title="Free-form answer typed by user, not one of the provided options"
                            style={{
                              marginLeft: 6, fontSize: 10, padding: "1px 5px",
                              borderRadius: 3, background: "rgba(245,158,11,0.15)",
                              color: "#f59e0b", whiteSpace: "nowrap",
                              verticalAlign: 1,
                            }}
                          >✎ custom</span>
                        )}
                      </div>
                    ) : (
                      <div style={{ marginTop: 3, color: "var(--text-faint)", fontSize: 12, paddingLeft: 18, fontStyle: "italic" }}>waiting for answer…</div>
                    )}
                    {showOptions && q.options && q.options.length > 0 && (() => {
                      const picked = new Set(answerParts);
                      return (
                        <div style={{ marginTop: 6, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
                          {q.options!.map((opt, oi) => {
                            const isPicked = picked.has(opt.label);
                            return (
                              <div key={oi} style={{
                                fontSize: 12, lineHeight: 1.35,
                                color: isPicked ? "var(--accent-blue)" : "var(--text-faint)",
                                wordBreak: "break-word",
                              }}>
                                <span style={{ marginRight: 4 }}>{isPicked ? "●" : "○"}</span>
                                <span style={{ fontWeight: isPicked ? 600 : 400 }}>{opt.label}</span>
                                {opt.description && (
                                  <span style={{ color: "var(--text-faintest)", marginLeft: 6 }}>— {opt.description}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Mobile Shell Panel ─── */
function MobileResumeSelectPanel({
  sessionId,
  onClose,
  onDone,
}: {
  sessionId: string;
  onClose: () => void;
  onDone: (newSession: SessionMeta) => void;
}) {
  const [items, setItems] = useState<AvailableClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    listAvailableClaudeSessions(sessionId)
      .then(setItems)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const handleSelect = async (item: AvailableClaudeSession) => {
    setBusy(true);
    setErr("");
    try {
      await setClaudeSessionId(sessionId, item.agent_session_id);
      await terminateSession(sessionId);
      const resumed = await resumeSession(sessionId);
      onDone(resumed);
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 200, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 16px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
        <span style={{ fontSize: 14, color: "var(--text-primary)", fontWeight: 600 }}>Select Claude Session</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {loading && <div style={{ color: "var(--text-secondary)", fontSize: 14 }}>Loading…</div>}
        {!loading && items.length === 0 && !err && (
          <div style={{ color: "var(--text-secondary)", fontSize: 14 }}>No other sessions found in this project</div>
        )}
        {err && <div style={{ color: "var(--accent-red)", fontSize: 13, marginBottom: 8 }}>{err}</div>}
        {items.map((item) => (
          <button
            key={item.agent_session_id}
            disabled={busy}
            onClick={() => handleSelect(item)}
            style={{
              display: "block", width: "100%", textAlign: "left",
              background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8,
              padding: "10px 14px", marginBottom: 8, cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            <div style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.title || item.agent_session_id}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.agent_session_id}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              {new Date(item.mtime * 1000).toLocaleString()}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

const CTRL_COMMON = [
  { letter: "C", desc: "int",  title: "Ctrl+C — Interrupt" },
  { letter: "D", desc: "eof",  title: "Ctrl+D — EOF / logout" },
  { letter: "Z", desc: "sus",  title: "Ctrl+Z — Suspend" },
  { letter: "L", desc: "clr",  title: "Ctrl+L — Clear screen" },
  { letter: "A", desc: "home", title: "Ctrl+A — Beginning of line" },
  { letter: "E", desc: "end",  title: "Ctrl+E — End of line" },
  { letter: "U", desc: "kill", title: "Ctrl+U — Kill line" },
  { letter: "W", desc: "back", title: "Ctrl+W — Delete word back" },
  { letter: "R", desc: "hist", title: "Ctrl+R — History search" },
];

const ROW1_NAV = [
  { label: "ESC", seq: "\x1b",   title: "Escape" },
  { label: "TAB", seq: "\t",     title: "Tab" },
  { label: "←",   seq: "\x1b[D", title: "Arrow Left" },
  { label: "↑",   seq: "\x1b[A", title: "Arrow Up" },
  { label: "↓",   seq: "\x1b[B", title: "Arrow Down" },
  { label: "→",   seq: "\x1b[C", title: "Arrow Right" },
];

// Must match EmbeddedTerminalPanel so PC & mobile pick up the same cached
// term_id when the user switches viewports for the same session.
const MOBILE_TERM_CACHE_PREFIX = "cmTermLastTermId:v1:";
const mobileTermCacheKey = (sid: string) => MOBILE_TERM_CACHE_PREFIX + sid;
const MOBILE_TERM_HEARTBEAT_MS = 30_000;
const MOBILE_TERM_POLL_MS = 4000;

function MobileShellPanel({ sessionId, cwd, onClose, onMinimize, minimized, fontFamily }: { sessionId: string; cwd: string; onClose: () => void; onMinimize?: () => void; minimized?: boolean; fontFamily?: string }) {
  const sendRawRef = useRef<((data: string) => void) | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [ctrlActive, setCtrlActive] = useState(false);

  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [attached, setAttached] = useState<{ termId: string; wsUrl: string; name: string | null; isNamed: boolean } | null>(null);
  const [picking, setPicking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track visual viewport so the panel stays above the soft keyboard
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const el = containerRef.current;
      if (!el || minimized) return;
      el.style.top = `${vv.offsetTop}px`;
      el.style.height = `${vv.height}px`;
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, [minimized]);

  const refreshList = useCallback(async () => {
    try {
      const r = await listTerminals(sessionId);
      setTerminals(r.items);
    } catch { /* swallow */ }
  }, [sessionId]);

  const openEphemeral = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createTerminal(sessionId, {});
      setAttached({ termId: r.term_id, wsUrl: r.ws_url, name: r.name, isNamed: r.is_named });
      setPicking(false);
      await refreshList();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, busy, refreshList]);

  const attachExisting = useCallback(async (term: TerminalInfo) => {
    if (busy) return;
    if (attached && attached.termId === term.term_id) {
      setPicking(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await issueTerminalToken(sessionId, term.term_id);
      setAttached({ termId: term.term_id, wsUrl: t.ws_url, name: term.name, isNamed: term.is_named });
      setPicking(false);
      await refreshList();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, busy, attached, refreshList]);

  const saveAsNamed = useCallback(async (name: string) => {
    if (!attached || busy) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setRenameError(null);
    try {
      const r = await renameTerminal(sessionId, attached.termId, trimmed);
      setAttached((a) => (a ? { ...a, name: r.name, isNamed: r.is_named } : a));
      setRenaming(false);
      setRenameValue("");
      await refreshList();
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, attached, busy, refreshList]);

  const deleteCurrent = useCallback(async () => {
    if (!attached || busy) return;
    const label = attached.name ? `"${attached.name}"` : "this ephemeral terminal";
    if (!confirm(`Delete ${label}? Any running processes inside will be killed.`)) return;
    setBusy(true);
    try {
      await deleteTerminal(sessionId, attached.termId);
      setAttached(null);
      await refreshList();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, attached, busy, refreshList]);

  // Auto-attach: try cached term_id first, fall back to a fresh ephemeral.
  // Mirrors EmbeddedTerminalPanel so reopening the panel reattaches instead
  // of leaving an orphaned ephemeral behind.
  useEffect(() => {
    if (attached) return;
    let cancelled = false;
    (async () => {
      try {
        const cachedId = localStorage.getItem(mobileTermCacheKey(sessionId));
        if (cachedId) {
          try {
            const t = await issueTerminalToken(sessionId, cachedId);
            if (cancelled) return;
            setAttached({
              termId: t.term_id,
              wsUrl: t.ws_url,
              name: t.name ?? null,
              isNamed: !!t.is_named,
            });
            listTerminals(sessionId).then((rr) => { if (!cancelled) setTerminals(rr.items); }).catch(() => {});
            return;
          } catch {
            localStorage.removeItem(mobileTermCacheKey(sessionId));
          }
        }
        const r = await listTerminals(sessionId);
        if (cancelled) return;
        setTerminals(r.items);
        const c = await createTerminal(sessionId, {});
        if (cancelled) return;
        setAttached({ termId: c.term_id, wsUrl: c.ws_url, name: c.name, isNamed: c.is_named });
        listTerminals(sessionId).then((rr) => { if (!cancelled) setTerminals(rr.items); }).catch(() => {});
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, attached]);

  // Persist currently-attached term_id for next mount.
  useEffect(() => {
    if (!attached) return;
    try { localStorage.setItem(mobileTermCacheKey(sessionId), attached.termId); }
    catch { /* quota — ignore */ }
  }, [sessionId, attached]);

  // Heartbeat keepalive (also runs while minimized).
  useEffect(() => {
    if (!attached) return;
    const tick = async () => {
      try {
        await heartbeatTerminal(sessionId, attached.termId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/gone|404|410/i.test(msg)) {
          try { localStorage.removeItem(mobileTermCacheKey(sessionId)); } catch { /* ignore */ }
          setAttached(null);
        }
      }
    };
    const id = setInterval(tick, MOBILE_TERM_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [sessionId, attached]);

  // Periodic list refresh (for attach_count badges in picker).
  useEffect(() => {
    const id = setInterval(refreshList, MOBILE_TERM_POLL_MS);
    return () => clearInterval(id);
  }, [refreshList]);

  const sendKey = (seq: string) => sendRawRef.current?.(seq);
  const sendCtrlLetter = (letter: string) => {
    sendKey(String.fromCharCode(letter.charCodeAt(0) - 64));
    setCtrlActive(false);
  };

  const toolbarBtnBase: React.CSSProperties = {
    flex: 1, height: 44, background: "transparent", border: "none",
    borderRight: "1px solid var(--border-subtle)", color: "var(--text-primary)",
    fontSize: 13, fontFamily: "monospace", fontWeight: 600,
    cursor: "pointer", padding: 0, userSelect: "none",
  };

  const named = terminals.filter(t => t.is_named);
  const ephemeral = terminals.filter(t => !t.is_named);
  const currentLabel = attached
    ? (attached.name ? `📌 ${attached.name}` : `▶ ephemeral (${attached.termId.slice(0, 6)})`)
    : (busy ? "(connecting…)" : "(no terminal)");

  return (
    <div ref={containerRef} style={{ position: "fixed", left: 0, right: 0, top: 0, height: "100%", background: "var(--bg-base)", zIndex: 200, display: minimized ? "none" : "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "10px 12px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <button onClick={onClose} title="Close terminal" style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
        <button
          onClick={() => setPicking(p => !p)}
          title="Switch terminal"
          disabled={busy}
          style={{
            background: "var(--bg-hover)", color: "var(--text-body)",
            fontSize: 12, padding: "5px 10px", border: "none", borderRadius: 6,
            display: "flex", alignItems: "center", gap: 5, flex: 1, minWidth: 0,
            fontFamily: "monospace", cursor: busy ? "default" : "pointer",
          }}
        >
          <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentLabel}</span>
          <span style={{ fontSize: 9, color: "var(--text-muted)", flexShrink: 0 }}>▾</span>
        </button>
        {attached && !attached.isNamed && !renaming && (
          <button
            onClick={() => { setRenameValue(""); setRenameError(null); setRenaming(true); }}
            disabled={busy}
            title="Save (name) this terminal so it persists"
            style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 12, padding: "5px 9px", border: "none", borderRadius: 6, lineHeight: 1 }}
          >💾</button>
        )}
        {attached && (
          <button
            onClick={deleteCurrent}
            disabled={busy}
            title="Delete this terminal"
            style={{ background: "var(--bg-hover)", color: "var(--text-muted)", fontSize: 12, padding: "5px 9px", border: "none", borderRadius: 6, lineHeight: 1 }}
          >🗑</button>
        )}
        {onMinimize && (
          <button onClick={onMinimize} title="Minimize (keep alive)" style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)", fontSize: 16, padding: "2px 10px", cursor: "pointer", lineHeight: 1, borderRadius: 6 }}>
            ─
          </button>
        )}
      </div>

      {/* cwd */}
      <div style={{ padding: "4px 14px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--text-faint)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>
        &gt;_ {cwd}
      </div>

      {/* Rename form */}
      {attached && renaming && (
        <div style={{ padding: "8px 12px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border-subtle)", display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => { setRenameValue(e.target.value); if (renameError) setRenameError(null); }}
            onKeyDown={(e) => { if (e.key === "Escape") { setRenaming(false); setRenameError(null); } }}
            placeholder="terminal name"
            style={{
              flex: 1, fontSize: 13, padding: "6px 8px",
              background: "var(--bg-base)",
              border: `1px solid ${renameError ? "var(--accent-red, #f85149)" : "var(--border)"}`,
              color: "var(--text-body)",
              borderRadius: 4,
            }}
          />
          <button
            onClick={() => saveAsNamed(renameValue)}
            disabled={!renameValue.trim() || busy}
            style={{
              background: renameValue.trim() ? "var(--accent-blue)" : "var(--text-faintest)",
              color: "#fff", fontSize: 12, padding: "6px 12px", border: "none", borderRadius: 4, fontWeight: 600,
            }}
          >OK</button>
          <button
            onClick={() => { setRenaming(false); setRenameError(null); }}
            style={{ background: "var(--bg-hover)", color: "var(--text-muted)", fontSize: 12, padding: "6px 10px", border: "none", borderRadius: 4 }}
          >✕</button>
        </div>
      )}
      {renameError && (
        <div style={{ padding: "4px 14px 8px", fontSize: 11, color: "var(--accent-red, #f85149)", background: "var(--bg-surface)", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
          {renameError}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--accent-red, #f85149)", background: "var(--bg-surface)", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
          {error}
        </div>
      )}

      {/* Terminal */}
      <div style={{ flex: 1, overflow: "hidden", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {attached && (
          <TerminalPane
            key={attached.termId + attached.wsUrl + (fontFamily || "")}
            sessionId={attached.termId}
            wsUrl={attached.wsUrl}
            scrollMode="tmux"
            onDisconnect={() => setAttached(null)}
            defaultFit
            showWideToggle
            fontFamily={fontFamily}
            sendRawRef={sendRawRef}
          />
        )}
      </div>

      {/* Picker bottom sheet */}
      {picking && (
        <>
          <div onClick={() => setPicking(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 210 }} />
          <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, background: "var(--bg-surface)", borderTop: "1px solid var(--border-strong)", borderRadius: "12px 12px 0 0", padding: "12px 0 24px", zIndex: 211, maxHeight: "70%", overflowY: "auto", boxShadow: "0 -4px 16px rgba(0,0,0,0.4)" }}>
            <div style={{ width: 40, height: 4, background: "var(--text-faintest)", borderRadius: 2, margin: "0 auto 12px" }} />
            <div style={{ fontSize: 10, color: "var(--text-faint)", padding: "4px 16px", textTransform: "uppercase", letterSpacing: 0.6 }}>Named</div>
            {named.length === 0 && (
              <div style={{ padding: "6px 16px", fontSize: 12, color: "var(--text-muted)" }}>(none — save current to name it)</div>
            )}
            {named.map(t => (
              <button
                key={t.term_id}
                onClick={() => attachExisting(t)}
                style={{
                  display: "flex", width: "100%", textAlign: "left", padding: "10px 16px",
                  background: attached?.termId === t.term_id ? "rgba(88,166,255,0.12)" : "transparent",
                  color: attached?.termId === t.term_id ? "var(--accent-blue)" : "var(--text-body)",
                  border: "none", fontSize: 13, gap: 8, alignItems: "center",
                  cursor: "pointer", fontFamily: "monospace",
                }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📌 {t.name}</span>
                {t.attach_count > 0 && (
                  <span style={{ fontSize: 10, padding: "2px 6px", background: "rgba(34,197,94,0.18)", color: "#22c55e", borderRadius: 3 }}>
                    👥{t.attach_count}
                  </span>
                )}
              </button>
            ))}

            <div style={{ fontSize: 10, color: "var(--text-faint)", padding: "10px 16px 4px", textTransform: "uppercase", letterSpacing: 0.6 }}>Ephemeral</div>
            {ephemeral.length === 0 && (
              <div style={{ padding: "6px 16px", fontSize: 12, color: "var(--text-muted)" }}>(none)</div>
            )}
            {ephemeral.map(t => (
              <button
                key={t.term_id}
                onClick={() => attachExisting(t)}
                style={{
                  display: "flex", width: "100%", textAlign: "left", padding: "10px 16px",
                  background: attached?.termId === t.term_id ? "rgba(88,166,255,0.12)" : "transparent",
                  color: attached?.termId === t.term_id ? "var(--accent-blue)" : "var(--text-body)",
                  border: "none", fontSize: 13, gap: 8, alignItems: "center",
                  cursor: "pointer", fontFamily: "monospace",
                }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>▶ {t.term_id.slice(0, 8)}</span>
                {t.attach_count > 0 && (
                  <span style={{ fontSize: 10, padding: "2px 6px", background: "rgba(34,197,94,0.18)", color: "#22c55e", borderRadius: 3 }}>
                    👥{t.attach_count}
                  </span>
                )}
              </button>
            ))}

            <div style={{ borderTop: "1px solid var(--border-subtle)", marginTop: 8, paddingTop: 8 }}>
              <button
                onClick={() => openEphemeral()}
                disabled={busy}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 16px", background: "transparent", border: "none", color: "var(--accent-blue)", fontSize: 13, cursor: "pointer", fontFamily: "monospace" }}
              >+ New ephemeral terminal</button>
            </div>
          </div>
        </>
      )}
      {/* Toolbar — two rows, always above keyboard */}
      <div style={{ flexShrink: 0, background: "var(--bg-surface)", borderTop: "1px solid var(--border)" }}>
        {/* Row 1: CTRL toggle + navigation */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border-subtle)" }}>
          <button
            title="Ctrl modifier — tap to activate, then tap a letter"
            onPointerDown={(e) => { e.preventDefault(); setCtrlActive(v => !v); }}
            style={{
              ...toolbarBtnBase,
              background: ctrlActive ? "color-mix(in srgb, var(--accent-blue) 20%, var(--bg-base))" : "transparent",
              color: ctrlActive ? "var(--accent-blue)" : "var(--text-secondary)",
              borderRadius: 0,
              letterSpacing: 0.5,
            }}
          >
            CTRL
          </button>
          {ROW1_NAV.map((k) => (
            <button
              key={k.label}
              title={k.title}
              onPointerDown={(e) => { e.preventDefault(); sendKey(k.seq); }}
              style={{
                ...toolbarBtnBase,
                color: k.label.length === 1 && "←↑↓→".includes(k.label) ? "var(--text-primary)" : "var(--text-primary)",
                fontSize: k.label.length === 1 && "←↑↓→".includes(k.label) ? 18 : 13,
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
        {/* Row 2: only shown when CTRL is active */}
        {ctrlActive && <div style={{ display: "flex", overflowX: "auto", scrollbarWidth: "none", borderTop: "1px solid var(--border-subtle)" }}>
          {CTRL_COMMON.map(({ letter, desc, title }) => (
            <button
              key={letter}
              title={title}
              onPointerDown={(e) => { e.preventDefault(); sendCtrlLetter(letter); }}
              style={{
                flexShrink: 0, minWidth: 52, height: 44,
                background: "transparent", border: "none",
                borderRight: "1px solid var(--border-subtle)",
                cursor: "pointer", userSelect: "none",
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 1,
                padding: 0,
              }}
            >
              <span style={{ fontSize: 13, fontFamily: "monospace", fontWeight: 700, color: "var(--accent-blue)", lineHeight: 1 }}>^{letter}</span>
              <span style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1, letterSpacing: 0.3 }}>{desc}</span>
            </button>
          ))}
        </div>}
      </div>
    </div>
  );
}

/* ─── Mobile File Browser ─── */
const FILE_CODE_EXTS = new Set([
  "py","pyx","pyi","js","jsx","ts","tsx","mjs","cjs","css","scss","sass","less",
  "html","htm","xml","svg","sh","bash","zsh","fish","go","rs","java","kt","scala",
  "c","h","cpp","cc","cxx","hpp","rb","php","swift","cs","sql","graphql","proto",
  "tf","hcl","yaml","yml","toml","json","r","lua",
]);
function mobileFormatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes/1024).toFixed(1)}K`;
  return `${(bytes/1048576).toFixed(1)}M`;
}

type MobileFileKind = "code" | "markdown" | "csv" | "sqlite" | "pdf" | "image" | "html" | "text";
function getMobileFileKind(entry: FileEntry): MobileFileKind {
  if (entry.is_sqlite) return "sqlite";
  const ext = entry.name.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return "pdf";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (["png","jpg","jpeg","gif","webp","bmp","ico","svg","avif","tiff","tif","heic","heif"].includes(ext)) return "image";
  if (FILE_CODE_EXTS.has(ext)) return "code";
  return "text";
}

function MobileCodeViewer({ content, ext }: { content: string; ext: string }) {
  const html = useMemo(() => {
    try {
      const lang = hljs.getLanguage(ext) ? ext : undefined;
      const h = lang ? hljs.highlight(content, { language: lang }).value : hljs.highlightAuto(content).value;
      return h;
    } catch {
      return content.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }
  }, [content, ext]);
  const lines = content.split("\n").length;
  return (
    <div style={{ display: "flex", flex: 1, overflow: "auto", background: "var(--bg-base)" }}>
      <div style={{ padding: "12px 6px 12px 12px", textAlign: "right", color: "var(--text-faint)", fontSize: 12, lineHeight: 1.6, fontFamily: "monospace", userSelect: "none", flexShrink: 0, borderRight: "1px solid var(--border-subtle)", minWidth: 36 }}>
        {Array.from({ length: lines }, (_, i) => <div key={i}>{i+1}</div>)}
      </div>
      <pre style={{ flex: 1, margin: 0, padding: "12px", fontSize: 12, lineHeight: 1.6, fontFamily: "monospace", overflow: "visible" }}>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

function MobileCsvViewer({ content }: { content: string }) {
  const rows = useMemo(() => content.trim().split("\n").map(line => {
    const cells: string[] = []; let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) { if (ch==='"' && line[i+1]==='"') { cur+='"'; i++; } else if (ch==='"') inQ=false; else cur+=ch; }
      else { if (ch==='"') inQ=true; else if (ch===',') { cells.push(cur); cur=""; } else cur+=ch; }
    }
    cells.push(cur); return cells;
  }), [content]);
  if (!rows.length) return <div style={{ padding: 16, color: "var(--text-muted)" }}>Empty</div>;
  const hdrs = rows[0];
  return (
    <div style={{ overflow: "auto", flex: 1 }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%", whiteSpace: "nowrap" }}>
        <thead>
          <tr style={{ background: "var(--bg-surface)", position: "sticky", top: 0 }}>
            {hdrs.map((h, i) => <th key={i} style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)", textAlign: "left" }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((row, ri) => (
            <tr key={ri} style={{ background: ri%2===0?"transparent":"rgba(255,255,255,0.02)" }}>
              {hdrs.map((_,ci) => <td key={ci} style={{ padding: "4px 10px", borderBottom: "1px solid var(--border-subtle)", color: "var(--text-primary)", fontFamily: "monospace", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{row[ci]??""}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── SQL helpers for cell editing ─────────────────────────────────────────────
function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => _execCopy(text));
  } else {
    _execCopy(text);
  }
}
function _execCopy(text: string) {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed"; el.style.opacity = "0";
  document.body.appendChild(el);
  el.focus(); el.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(el);
}

function _sqlLiteral(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return String(val);
  return "'" + String(val).replace(/'/g, "''") + "'";
}
function _sqlWhere(columns: string[], rawValues: unknown[]): string {
  return columns.map((c, i) => {
    const v = rawValues[i];
    if (v === null || v === undefined) return `"${c}" IS NULL`;
    return `"${c}" = ${_sqlLiteral(v)}`;
  }).join(" AND ");
}
/** Convert user-typed text to a SQL literal, preserving original type affinity. */
function _sqlSetValue(newText: string, rawOriginal: unknown): string {
  if (newText === "" && (rawOriginal === null || rawOriginal === undefined)) return "NULL";
  if (typeof rawOriginal === "number") {
    const n = Number(newText);
    if (newText.trim() !== "" && !isNaN(n)) return String(n);
  }
  return "'" + newText.replace(/'/g, "''") + "'";
}

interface CellCtx {
  displayValue: string;
  rawValue: unknown;
  columnName: string;
  allColumns: string[];
  allRawValues: unknown[];
}

function MobileCellPopup({ ctx, tableName, onSave, onClose }: {
  ctx: CellCtx; tableName: string;
  onSave: (sql: string) => Promise<void>;
  onClose: () => void;
}) {
  const { displayValue, rawValue, columnName, allColumns, allRawValues } = ctx;
  const [formatted, setFormatted] = useState<string | null>(null);
  const [fmtErr, setFmtErr] = useState("");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(displayValue);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const tryFormat = () => {
    if (formatted !== null) { setFormatted(null); setFmtErr(""); return; }
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(displayValue.trim()); } catch {
        parsed = JSON.parse(displayValue.trim().replace(/,(\s*[}\]])/g, "$1"));
      }
      setFormatted(JSON.stringify(parsed, null, 2));
      setFmtErr("");
    } catch { setFmtErr("Invalid JSON"); }
  };

  const startEdit = () => {
    setEditText(displayValue);
    setSaveErr("");
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true); setSaveErr("");
    try {
      const setVal = _sqlSetValue(editText, rawValue);
      const where = _sqlWhere(allColumns, allRawValues);
      const sql = `UPDATE "${tableName}" SET "${columnName}" = ${setVal} WHERE ${where}`;
      await onSave(sql);
      onClose();
    } catch (e) { setSaveErr(String(e)); } finally { setSaving(false); }
  };

  const displayText = formatted ?? displayValue;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-end" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxHeight: "75vh", background: "var(--bg-surface)", borderRadius: "16px 16px 0 0", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ width: 36, height: 4, background: "var(--border)", borderRadius: 2, margin: "10px auto 0" }} />
        {/* Toolbar */}
        <div style={{ padding: "10px 16px 8px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border-subtle)", flexShrink: 0, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{columnName}</span>
          {!editing && (
            <>
              <button onClick={tryFormat}
                style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, background: formatted !== null ? "color-mix(in srgb, var(--accent-blue) 20%, var(--bg-base))" : "var(--border)", color: formatted !== null ? "var(--accent-blue)" : "var(--text-secondary)", border: "none" }}>
                {formatted !== null ? "Raw" : "Format JSON"}
              </button>
              {fmtErr && <span style={{ fontSize: 11, color: "var(--accent-red)" }}>Parse failed</span>}
              <button onClick={() => copyText(displayText)}
                style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, background: "var(--bg-hover)", color: "var(--accent-blue)", border: "1px solid var(--border)" }}>
                Copy
              </button>
              <button onClick={startEdit}
                style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, background: "var(--bg-hover)", color: "var(--accent-green)", border: "1px solid #2d5a2d" }}>
                Edit
              </button>
            </>
          )}
          {editing && (
            <>
              <button onClick={handleSave} disabled={saving}
                style={{ fontSize: 11, padding: "3px 12px", borderRadius: 4, background: saving ? "var(--bg-hover)" : "var(--accent-green)", color: saving ? "var(--text-muted)" : "#fff", border: "none" }}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button onClick={() => setEditing(false)}
                style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, background: "var(--border)", color: "var(--text-secondary)", border: "none" }}>
                Cancel
              </button>
              {saveErr && <span style={{ fontSize: 11, color: "var(--accent-red)", width: "100%" }}>{saveErr}</span>}
            </>
          )}
          <div style={{ marginLeft: "auto" }}>
            <button onClick={onClose} style={{ fontSize: 16, background: "transparent", border: "none", color: "var(--text-muted)", padding: "0 4px", cursor: "pointer" }}>✕</button>
          </div>
        </div>
        {/* Content / Editor */}
        {editing ? (
          <textarea
            autoFocus
            value={editText}
            onChange={e => setEditText(e.target.value)}
            style={{ flex: 1, margin: "12px 16px 24px", padding: "10px 12px", fontSize: 13, color: "var(--text-primary)", background: "var(--bg-base)", border: "1px solid #374151", borderRadius: 8, fontFamily: "monospace", lineHeight: 1.6, resize: "none", outline: "none" }}
          />
        ) : (
          <pre style={{ flex: 1, overflow: "auto", margin: 0, padding: "12px 16px 24px", fontSize: 13, color: formatted !== null ? "var(--accent-blue)" : "var(--text-primary)", fontFamily: "monospace", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {displayText}
          </pre>
        )}
      </div>
    </div>
  );
}

function MobileSqliteViewer({ sessionId, path }: { sessionId: string; path: string }) {
  const [info, setInfo] = useState<SqliteInfo | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [cellCtx, setCellCtx] = useState<CellCtx | null>(null);

  const loadTable = useCallback(async (tbl: string, p: string, sid: string) => {
    const r = await sqliteQuery(sid, p, tbl, 200, 0);
    setInfo(r); setTable(tbl);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await sqliteQuery(sessionId, path);
        if (res.tables.length > 0) {
          await loadTable(res.tables[0], path, sessionId);
        } else { setInfo(res); }
      } catch (e) { setErr(String(e)); } finally { setLoading(false); }
    })();
  }, [sessionId, path, loadTable]);

  const handleSave = useCallback(async (sql: string) => {
    await sqliteExec(sessionId, path, sql);
    if (table) await loadTable(table, path, sessionId);
  }, [sessionId, path, table, loadTable]);

  if (loading) return <div style={{ padding: 24, color: "var(--text-muted)", textAlign: "center" }}>Loading…</div>;
  if (err) return <div style={{ padding: 16, color: "var(--accent-red)", fontSize: 13 }}>{err}</div>;
  if (!info) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {cellCtx && table && (
        <MobileCellPopup ctx={cellCtx} tableName={table} onSave={handleSave} onClose={() => setCellCtx(null)} />
      )}
      {info.tables.length > 1 && (
        <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-subtle)", display: "flex", gap: 6, overflowX: "auto", flexShrink: 0 }}>
          {info.tables.map(t => (
            <button key={t} onClick={() => loadTable(t, path, sessionId)}
              style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, background: t===table?"color-mix(in srgb, var(--accent-blue) 20%, var(--bg-base))":"var(--bg-hover)", color: t===table?"var(--accent-blue)":"var(--text-secondary)", border: "1px solid "+(t===table?"var(--accent-blue)":"var(--border)"), whiteSpace: "nowrap" }}>
              {t}
            </button>
          ))}
        </div>
      )}
      <div style={{ overflow: "auto", flex: 1 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%", whiteSpace: "nowrap" }}>
          <thead>
            <tr style={{ background: "var(--bg-surface)", position: "sticky", top: 0 }}>
              {info.columns.map((c, i) => <th key={i} style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)", textAlign: "left" }}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {info.rows.map((row, ri) => (
              <tr key={ri} style={{ background: ri%2===0?"transparent":"rgba(255,255,255,0.02)" }}>
                {(row as unknown[]).map((cell, ci) => {
                  const s = cell == null ? "" : String(cell);
                  const long = s.length > 40;
                  return (
                    <td key={ci}
                      onClick={() => setCellCtx({
                        displayValue: s, rawValue: cell,
                        columnName: info.columns[ci],
                        allColumns: info.columns,
                        allRawValues: row as unknown[],
                      })}
                      style={{ padding: "4px 10px", borderBottom: "1px solid var(--border-subtle)", color: cell==null?"var(--text-faint)": long?"var(--accent-blue)":"var(--text-primary)", fontFamily: "monospace", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer" }}>
                      {s}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {info.total > 200 && <div style={{ padding: "8px 12px", color: "var(--text-muted)", fontSize: 11 }}>Showing 200 of {info.total} rows</div>}
      </div>
    </div>
  );
}

interface DirNodeState { entries: FileEntry[]; loaded: boolean; expanded: boolean; loading: boolean; }

type FileSheetKind =
  | null
  | "search"
  | "newFile"
  | "newFolder"
  | "upload"
  | "action"      // long-press action menu
  | "rename"
  | "move"
  | "deleteConfirm"
  | "gitHistory"
  | "gitCommit";  // viewing a single commit

function MobileFileBrowserPanel({
  sessionId, sessionCwd, onClose, onSetBackHandler,
}: {
  sessionId: string; sessionCwd: string;
  onClose: () => void;
  onSetBackHandler: (fn: (() => void) | null) => void;
}) {
  const [tree, setTree] = useState<Record<string, DirNodeState>>({});
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [rootLoading, setRootLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [previewEntry, setPreviewEntry] = useState<FileEntry | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [convertTarget, setConvertTarget] = useState<"raw" | ConfigFormat>("raw");

  // ── Toolbar / action-sheet state ─────────────────────────────────────────
  const [sheet, setSheet] = useState<FileSheetKind>(null);
  const [sheetTarget, setSheetTarget] = useState<FileEntry | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState("");

  // Search
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // New file / new folder
  const [newName, setNewName] = useState("");
  const [newParentDir, setNewParentDir] = useState("");
  const [newDirChoices, setNewDirChoices] = useState<string[]>([]);

  // Upload
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadDir, setUploadDir] = useState("");
  const [uploadFileObj, setUploadFileObj] = useState<File | null>(null);

  // Rename
  const [renameValue, setRenameValue] = useState("");

  // Move
  const [moveDest, setMoveDest] = useState("");
  const [moveDirChoices, setMoveDirChoices] = useState<string[]>([]);

  // Delete
  const [deleteRecursive, setDeleteRecursive] = useState(false);

  // Git history
  const [gitLog, setGitLog] = useState<Array<{ hash: string; short_hash: string; subject: string; author: string; date: string }>>([]);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitCommit, setGitCommit] = useState<{ hash: string; short_hash: string; subject: string } | null>(null);
  const [gitMode, setGitMode] = useState<"diff" | "full">("diff");
  const [gitDiff, setGitDiff] = useState("");
  const [gitFull, setGitFull] = useState("");
  const [gitDetailLoading, setGitDetailLoading] = useState(false);

  // Download zip
  const [zipBusy, setZipBusy] = useState(false);

  const loadDir = useCallback(async (path: string, hidden = false) => {
    setTree(t => ({ ...t, [path]: { ...t[path], loading: true } }));
    try {
      const res = await listFiles(sessionId, path, hidden);
      setTree(t => ({ ...t, [path]: { entries: res.entries, loaded: true, expanded: true, loading: false } }));
    } catch {
      setTree(t => ({ ...t, [path]: { ...t[path], loading: false } }));
    }
  }, [sessionId]);

  const reloadRoot = useCallback(async () => {
    setRootLoading(true);
    try {
      const res = await listFiles(sessionId, undefined, showHidden);
      setRootEntries(res.entries);
    } catch { setRootEntries([]); } finally { setRootLoading(false); }
  }, [sessionId, showHidden]);

  /** Reload the directory containing `path`, plus its parents up to root, so
   *  the tree reflects the change after a rename/move/delete/create. */
  const reloadAffected = useCallback(async (path: string) => {
    const parent = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
    if (parent === "") {
      await reloadRoot();
    } else {
      // Reload the parent dir node
      try {
        const res = await listFiles(sessionId, parent, showHidden);
        setTree(t => ({ ...t, [parent]: { entries: res.entries, loaded: true, expanded: true, loading: false } }));
      } catch { /* ignore */ }
    }
  }, [sessionId, showHidden, reloadRoot]);

  useEffect(() => {
    (async () => {
      setRootLoading(true);
      try {
        const res = await listFiles(sessionId, undefined, showHidden);
        setRootEntries(res.entries);
      } catch { setRootEntries([]); } finally { setRootLoading(false); }
    })();
  }, [sessionId, sessionCwd, showHidden]);

  // Stash latest tree snapshot so the fs/watch callback can read it without
  // re-subscribing on every keystroke.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  useFsWatch(sessionId, (changes) => {
    if (!changes.length) return;
    let needRoot = false;
    const dirs = new Set<string>();
    for (const c of changes) {
      // Backend emits dir relative to session cwd; "" means root.
      if (!c.dir) needRoot = true;
      else dirs.add(c.dir);
    }
    if (needRoot) void reloadRoot();
    // Only reload nested dirs we've actually expanded — otherwise we'd warm
    // up directories the user never opened.
    for (const d of dirs) {
      if (treeRef.current[d]?.loaded) {
        void reloadAffected(d + "/_");
      }
    }
  });

  // Reset sheet state when sheet changes
  useEffect(() => {
    setSheetError("");
    if (sheet === null) {
      setSheetTarget(null);
      setSheetBusy(false);
      setSearchQ(""); setSearchResults([]);
      setNewName(""); setNewParentDir(""); setNewDirChoices([]);
      setUploadDir(""); setUploadFileObj(null);
      setRenameValue("");
      setMoveDest(""); setMoveDirChoices([]);
      setDeleteRecursive(false);
      setGitLog([]); setGitCommit(null);
      setGitDiff(""); setGitFull("");
    }
  }, [sheet]);

  // Load dir choices for sheets that need a destination picker
  useEffect(() => {
    if (sheet === "newFile" || sheet === "newFolder" || sheet === "upload" || sheet === "move") {
      listDirs(sessionCwd).then(dirs => {
        const choices = ["", ...dirs.map(d => d.startsWith(sessionCwd + "/") ? d.substring(sessionCwd.length + 1) : "")].filter((v, i, a) => a.indexOf(v) === i);
        if (sheet === "move") setMoveDirChoices(choices); else setNewDirChoices(choices);
      }).catch(() => { /* ignore */ });
    }
  }, [sheet, sessionCwd]);

  // Sheet back handler — back closes the active sheet first
  useEffect(() => {
    if (sheet) {
      history.pushState({ mobileFilesSheet: sheet }, "");
      onSetBackHandler(() => setSheet(null));
    } else if (!previewEntry) {
      onSetBackHandler(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const doSearch = useCallback(async () => {
    if (!searchQ.trim()) { setSearchResults([]); return; }
    setSearchLoading(true);
    try {
      const res = await searchFiles(sessionId, searchQ.trim(), showHidden);
      setSearchResults(res.entries);
    } catch (e) { setSheetError(String(e)); }
    finally { setSearchLoading(false); }
  }, [sessionId, searchQ, showHidden]);

  const doCreateFile = useCallback(async () => {
    if (!newName.trim()) { setSheetError("file name required"); return; }
    if (/[/\\]/.test(newName)) { setSheetError("name cannot contain / or \\"); return; }
    setSheetBusy(true); setSheetError("");
    try {
      const fullPath = newParentDir ? `${newParentDir}/${newName.trim()}` : newName.trim();
      await writeFile(sessionId, fullPath, "");
      await reloadAffected(fullPath);
      setSheet(null);
    } catch (e) { setSheetError(String(e)); }
    finally { setSheetBusy(false); }
  }, [sessionId, newName, newParentDir, reloadAffected]);

  const doCreateFolder = useCallback(async () => {
    if (!newName.trim()) { setSheetError("folder name required"); return; }
    if (/[/\\]/.test(newName)) { setSheetError("name cannot contain / or \\"); return; }
    setSheetBusy(true); setSheetError("");
    try {
      const fullPath = newParentDir ? `${newParentDir}/${newName.trim()}` : newName.trim();
      await createDir(sessionId, fullPath);
      await reloadAffected(fullPath);
      setSheet(null);
    } catch (e) { setSheetError(String(e)); }
    finally { setSheetBusy(false); }
  }, [sessionId, newName, newParentDir, reloadAffected]);

  const doUpload = useCallback(async () => {
    if (!uploadFileObj) { setSheetError("pick a file first"); return; }
    setSheetBusy(true); setSheetError("");
    try {
      await uploadFile(sessionId, uploadDir, uploadFileObj);
      const dest = uploadDir ? `${uploadDir}/${uploadFileObj.name}` : uploadFileObj.name;
      await reloadAffected(dest);
      setSheet(null);
    } catch (e) { setSheetError(String(e)); }
    finally { setSheetBusy(false); }
  }, [sessionId, uploadDir, uploadFileObj, reloadAffected]);

  const doRename = useCallback(async () => {
    if (!sheetTarget) return;
    const v = renameValue.trim();
    if (!v) { setSheetError("new name required"); return; }
    if (/[/\\]/.test(v)) { setSheetError("name cannot contain / or \\"); return; }
    if (v === sheetTarget.name) { setSheet(null); return; }
    setSheetBusy(true); setSheetError("");
    try {
      await renameEntry(sessionId, sheetTarget.path, v);
      await reloadAffected(sheetTarget.path);
      setSheet(null);
    } catch (e) { setSheetError(String(e)); }
    finally { setSheetBusy(false); }
  }, [sessionId, sheetTarget, renameValue, reloadAffected]);

  const doMove = useCallback(async () => {
    if (!sheetTarget) return;
    if (moveDest === undefined) { setSheetError("destination required"); return; }
    setSheetBusy(true); setSheetError("");
    try {
      await moveEntry(sessionId, sheetTarget.path, moveDest);
      await reloadAffected(sheetTarget.path);
      // Also reload destination dir
      if (moveDest !== "") await reloadAffected(`${moveDest}/x`);
      else await reloadRoot();
      setSheet(null);
    } catch (e) { setSheetError(String(e)); }
    finally { setSheetBusy(false); }
  }, [sessionId, sheetTarget, moveDest, reloadAffected, reloadRoot]);

  const doDelete = useCallback(async () => {
    if (!sheetTarget) return;
    setSheetBusy(true); setSheetError("");
    try {
      await deleteEntry(sessionId, sheetTarget.path, deleteRecursive);
      await reloadAffected(sheetTarget.path);
      setSheet(null);
    } catch (e) { setSheetError(String(e)); }
    finally { setSheetBusy(false); }
  }, [sessionId, sheetTarget, deleteRecursive, reloadAffected]);

  const openGitHistory = useCallback(async (entry: FileEntry) => {
    setSheetTarget(entry); setSheet("gitHistory");
    setGitLoading(true); setGitLog([]);
    try {
      const log = await getFileGitLog(sessionId, entry.path, 50);
      setGitLog(log);
    } catch (e) { setSheetError(String(e)); }
    finally { setGitLoading(false); }
  }, [sessionId]);

  const openGitCommit = useCallback(async (commit: { hash: string; short_hash: string; subject: string }) => {
    if (!sheetTarget) return;
    setGitCommit(commit); setSheet("gitCommit");
    setGitMode("diff"); setGitDiff(""); setGitFull(""); setGitDetailLoading(true);
    try {
      const res = await getFileGitDiff(sessionId, sheetTarget.path, commit.hash);
      setGitDiff(res.diff);
    } catch (e) { setSheetError(String(e)); }
    finally { setGitDetailLoading(false); }
  }, [sessionId, sheetTarget]);

  const loadGitFullAtCommit = useCallback(async () => {
    if (!sheetTarget || !gitCommit) return;
    setGitDetailLoading(true);
    try {
      const res = await getFileGitShow(sessionId, sheetTarget.path, gitCommit.hash);
      setGitFull(res.content);
    } catch (e) { setSheetError(String(e)); }
    finally { setGitDetailLoading(false); }
  }, [sessionId, sheetTarget, gitCommit]);

  const [dlModalInfo, setDlModalInfo] = useState<DirInfoResponse | null>(null);
  const handleDownloadZip = useCallback(async () => {
    setZipBusy(true);
    try {
      const info = await getDirInfo(sessionId, "");
      if (info.total_size > 100 * 1024 * 1024) {
        setDlModalInfo(info);
      } else {
        const compress = info.total_size > 16 * 1024 * 1024;
        await downloadDirZip(sessionId, "", [], compress);
      }
    } catch (e) { alert(String(e)); }
    finally { setZipBusy(false); }
  }, [sessionId]);

  const openFile = useCallback(async (entry: FileEntry) => {
    setPreviewEntry(entry);
    setBlobUrl(null);
    setConvertTarget("raw");
    if (entry.is_sqlite) return;
    const kind = getMobileFileKind(entry);
    if (kind === "pdf" || kind === "image") {
      try {
        const url = await fetchRawFileBlob(sessionId, entry.path);
        setBlobUrl(url);
      } catch (e) { setFileError(String(e)); }
      return;
    }
    if (!entry.is_text) { setFileContent(""); setFileError("Binary file — cannot preview"); return; }
    setFileLoading(true); setFileError(""); setFileContent("");
    try {
      const res = await readFile(sessionId, entry.path);
      setFileContent(res.content);
    } catch (e) { setFileError(String(e)); } finally { setFileLoading(false); }
  }, [sessionId]);

  // Revoke blob URL when leaving a pdf/image preview
  useEffect(() => {
    if (!previewEntry && blobUrl) {
      URL.revokeObjectURL(blobUrl);
      setBlobUrl(null);
    }
  }, [previewEntry, blobUrl]);

  // Back handler: when preview is open, back closes it; otherwise parent handles
  useEffect(() => {
    if (previewEntry) {
      history.pushState({ mobileFilesPreview: true }, "");
      onSetBackHandler(() => setPreviewEntry(null));
    } else {
      onSetBackHandler(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewEntry]);

  const toggleDir = useCallback((path: string) => {
    const node = tree[path];
    if (!node?.loaded) { loadDir(path, showHidden); return; }
    setTree(t => ({ ...t, [path]: { ...t[path], expanded: !t[path].expanded } }));
  }, [tree, loadDir, showHidden]);

  // Long-press detection — fires after ~500ms hold without movement.
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);

  const onEntryTouchStart = useCallback((e: React.TouchEvent, entry: FileEntry) => {
    const t = e.touches[0];
    longPressFired.current = false;
    longPressStart.current = { x: t.clientX, y: t.clientY };
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      setSheetTarget(entry);
      setSheet("action");
      // Haptic feedback if supported
      try { (navigator as Navigator & { vibrate?: (p: number) => void }).vibrate?.(20); } catch { /* ignore */ }
    }, 500);
  }, []);

  const onEntryTouchMove = useCallback((e: React.TouchEvent) => {
    if (!longPressStart.current) return;
    const t = e.touches[0];
    const dx = t.clientX - longPressStart.current.x;
    const dy = t.clientY - longPressStart.current.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const onEntryTouchEnd = useCallback(() => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    longPressStart.current = null;
  }, []);

  function renderEntries(entries: FileEntry[], depth = 0): React.ReactNode {
    return entries.map(entry => {
      const indent = 12 + depth * 18;
      if (entry.type === "dir") {
        const node = tree[entry.path];
        const expanded = node?.expanded ?? false;
        const loading = node?.loading ?? false;
        return (
          <div key={entry.path}>
            <div
              onClick={() => { if (longPressFired.current) return; if (!entry.is_skipped) toggleDir(entry.path); }}
              onTouchStart={(e) => onEntryTouchStart(e, entry)}
              onTouchMove={onEntryTouchMove}
              onTouchEnd={onEntryTouchEnd}
              onTouchCancel={onEntryTouchEnd}
              style={{ padding: `10px 12px 10px ${indent}px`, display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border-subtle)", cursor: entry.is_skipped ? "default" : "pointer", userSelect: "none", WebkitTouchCallout: "none" }}>
              <span style={{ fontSize: 10, color: "var(--text-faint)", width: 10, flexShrink: 0 }}>{entry.is_skipped ? "" : expanded ? "▼" : "▶"}</span>
              <FileIcon isDir isOpen={expanded} size={16} />
              <span style={{ fontSize: 14, color: entry.is_skipped ? "var(--text-faint)" : "var(--text-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {entry.name}{entry.is_skipped && <span style={{ fontSize: 11, color: "var(--text-faint)" }}> (skipped)</span>}
              </span>
              {loading && <span style={{ fontSize: 11, color: "var(--text-faint)" }}>…</span>}
            </div>
            {expanded && node?.entries && renderEntries(node.entries, depth + 1)}
          </div>
        );
      }
      const clickable = entry.is_text || entry.is_sqlite || getMobileFileKind(entry) === "pdf" || getMobileFileKind(entry) === "image";
      return (
        <div key={entry.path}
          onClick={() => { if (longPressFired.current) return; if (clickable) openFile(entry); }}
          onTouchStart={(e) => onEntryTouchStart(e, entry)}
          onTouchMove={onEntryTouchMove}
          onTouchEnd={onEntryTouchEnd}
          onTouchCancel={onEntryTouchEnd}
          style={{ padding: `10px 12px 10px ${indent + 18}px`, display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border-subtle)", cursor: clickable ? "pointer" : "default", userSelect: "none", WebkitTouchCallout: "none" }}>
          <FileIcon name={entry.name} size={15} />
          <span style={{ fontSize: 14, color: clickable ? "var(--text-primary)" : "var(--text-faint)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
          {entry.size != null && <span style={{ fontSize: 11, color: "var(--text-faint)", flexShrink: 0 }}>{mobileFormatSize(entry.size)}</span>}
        </div>
      );
    });
  }

  // ── File preview ──────────────────────────────────────────────────────────
  if (previewEntry) {
    const kind = getMobileFileKind(previewEntry);
    const ext = previewEntry.name.split(".").pop()?.toLowerCase() || "";
    const rawUrl = `/api/sessions/${sessionId}/fs/raw?path=${encodeURIComponent(previewEntry.path)}`;
    const sourceFmt = detectFormat(previewEntry.name);
    const conversion = sourceFmt && convertTarget !== "raw"
      ? convert(fileContent, sourceFmt, convertTarget)
      : null;
    const displayContent = conversion?.ok ? conversion.content : fileContent;
    const displayExt = sourceFmt && convertTarget !== "raw" ? extFor(convertTarget) : ext;
    return (
      <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 210, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "12px 16px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <button onClick={() => history.back()} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{previewEntry.name}</span>
          <span style={{ fontSize: 11, color: "var(--text-faint)", flexShrink: 0 }}>{kind}</span>
        </div>
        {sourceFmt && !fileLoading && !fileError && (
          <div style={{ padding: "6px 12px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0, overflowX: "auto" }}>
            <ConfigFormatToggle
              source={sourceFmt}
              target={convertTarget}
              onChange={setConvertTarget}
              error={conversion && !conversion.ok ? conversion.error : null}
              compact
            />
            <ConfigCheckButton
              content={fileContent}
              format={sourceFmt}
              disabled={convertTarget !== "raw"}
              compact
            />
          </div>
        )}
        {sourceFmt && convertTarget === "raw" && !fileLoading && !fileError && (
          <ConfigValidationBanner content={fileContent} format={sourceFmt} compact />
        )}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {fileLoading && <div style={{ padding: 24, color: "var(--text-muted)", textAlign: "center" }}>Loading…</div>}
          {fileError && <div style={{ padding: 16, color: "var(--accent-red)", fontSize: 13 }}>{fileError}</div>}
          {!fileLoading && !fileError && (
            <>
              {kind === "code" && <MobileCodeViewer content={displayContent} ext={displayExt} />}
              {kind === "markdown" && (
                <div className="md-preview" dangerouslySetInnerHTML={{ __html: marked.parse(fileContent) as string }}
                  style={{ flex: 1, overflow: "auto", padding: "16px", color: "var(--text-primary)", fontSize: 14, lineHeight: 1.7 }} />
              )}
              {kind === "csv" && <MobileCsvViewer content={fileContent} />}
              {kind === "text" && (
                <pre style={{ flex: 1, overflow: "auto", margin: 0, padding: 16, fontSize: 13, color: "var(--text-primary)", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{fileContent}</pre>
              )}
              {kind === "sqlite" && <MobileSqliteViewer sessionId={sessionId} path={previewEntry.path} />}
              {kind === "pdf" && (
                blobUrl
                  ? <iframe src={blobUrl} style={{ flex: 1, border: "none" }} title={previewEntry.name} />
                  : <div style={{ padding: 24, color: "var(--text-muted)", textAlign: "center" }}>Loading PDF…</div>
              )}
              {kind === "image" && (
                <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "var(--bg-deep)" }}>
                  {blobUrl
                    ? <img src={blobUrl} alt={previewEntry.name} style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8, objectFit: "contain" }} />
                    : <div style={{ color: "var(--text-muted)" }}>Loading…</div>
                  }
                </div>
              )}
              {kind === "html" && (
                <HtmlViewer sessionId={sessionId} path={previewEntry.path} initialContent={fileContent} />
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Tree view ─────────────────────────────────────────────────────────────
  const toolbarBtnStyle: React.CSSProperties = {
    fontSize: 16, width: 32, height: 32, padding: 0, background: "transparent",
    border: "1px solid transparent", borderRadius: 6, color: "var(--text-secondary)",
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-base)", zIndex: 200, display: "flex", flexDirection: "column" }}>
      {/* Top row: back / title / cwd */}
      <div style={{ padding: "10px 12px 6px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 22, padding: "0 4px", cursor: "pointer", lineHeight: 1 }}>‹</button>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Files</span>
        <span style={{ fontSize: 11, color: "var(--text-faint)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sessionCwd}</span>
      </div>
      {/* Toolbar row: actions */}
      <div style={{ padding: "4px 8px 6px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 4, flexShrink: 0, overflowX: "auto" }}>
        <button title="Search" onClick={() => setSheet("search")} style={toolbarBtnStyle}>🔍</button>
        <button title="New file" onClick={() => setSheet("newFile")} style={toolbarBtnStyle}>✚</button>
        <button title="New folder" onClick={() => setSheet("newFolder")} style={{ ...toolbarBtnStyle, display: "flex", alignItems: "center", justifyContent: "center" }}><NewFolderIcon size={15} color="var(--text-body)" /></button>
        <button title="Upload" onClick={() => setSheet("upload")} style={toolbarBtnStyle}>⬆</button>
        <button title="Download workspace .zip" disabled={zipBusy} onClick={handleDownloadZip}
          style={{ ...toolbarBtnStyle, opacity: zipBusy ? 0.4 : 1 }}>{zipBusy ? "…" : "💾"}</button>
        <span style={{ flex: 1 }} />
        <button onClick={() => setShowHidden(h => !h)}
          style={{ fontSize: 11, padding: "4px 10px", background: showHidden ? "color-mix(in srgb, var(--accent-blue) 20%, var(--bg-base))" : "var(--bg-hover)", color: showHidden ? "var(--accent-blue)" : "var(--text-muted)", border: "1px solid " + (showHidden ? "var(--accent-blue)" : "var(--border)"), borderRadius: 5, flexShrink: 0 }}>
          {showHidden ? "hidden ✓" : "hidden"}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {rootLoading
          ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
          : rootEntries.length === 0
            ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>Empty directory</div>
            : renderEntries(rootEntries)
        }
      </div>
      {sheet !== null && (
        <MobileFileSheet
          kind={sheet}
          target={sheetTarget}
          busy={sheetBusy}
          error={sheetError}
          onClose={() => setSheet(null)}
          // search
          searchQ={searchQ} setSearchQ={setSearchQ}
          searchResults={searchResults} searchLoading={searchLoading}
          onSearch={doSearch} onPickSearchResult={(entry) => { setSheet(null); openFile(entry); }}
          // new file / folder
          newName={newName} setNewName={setNewName}
          newParentDir={newParentDir} setNewParentDir={setNewParentDir}
          newDirChoices={newDirChoices}
          onCreateFile={doCreateFile} onCreateFolder={doCreateFolder}
          // upload
          uploadDir={uploadDir} setUploadDir={setUploadDir}
          uploadFileObj={uploadFileObj} uploadInputRef={uploadInputRef}
          onPickUploadFile={(f) => setUploadFileObj(f)}
          onUpload={doUpload}
          // rename
          renameValue={renameValue} setRenameValue={setRenameValue} onRename={doRename}
          // move
          moveDest={moveDest} setMoveDest={setMoveDest}
          moveDirChoices={moveDirChoices} onMove={doMove}
          // delete
          deleteRecursive={deleteRecursive} setDeleteRecursive={setDeleteRecursive} onDelete={doDelete}
          // action menu navigation
          onOpenAction={(action) => {
            if (action === "view" && sheetTarget) { setSheet(null); openFile(sheetTarget); return; }
            if (action === "rename" && sheetTarget) { setRenameValue(sheetTarget.name); setSheet("rename"); return; }
            if (action === "move") { setMoveDest(""); setSheet("move"); return; }
            if (action === "delete") { setDeleteRecursive(sheetTarget?.type === "dir"); setSheet("deleteConfirm"); return; }
            if (action === "gitHistory" && sheetTarget) { openGitHistory(sheetTarget); return; }
          }}
          // git history
          gitLog={gitLog} gitLoading={gitLoading}
          gitCommit={gitCommit}
          gitMode={gitMode} setGitMode={(m) => { setGitMode(m); if (m === "full" && !gitFull) loadGitFullAtCommit(); }}
          gitDiff={gitDiff} gitFull={gitFull} gitDetailLoading={gitDetailLoading}
          onPickGitCommit={openGitCommit}
          onBackToGitHistory={() => setSheet("gitHistory")}
        />
      )}
      {dlModalInfo && (
        <DownloadExclusionModal
          sessionId={sessionId}
          basePath=""
          info={dlModalInfo}
          onClose={() => setDlModalInfo(null)}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// MobileFileSheet — bottom-sheet renderer for all file-browser actions
// ────────────────────────────────────────────────────────────────────────────
interface MobileFileSheetProps {
  kind: Exclude<FileSheetKind, null>;
  target: FileEntry | null;
  busy: boolean;
  error: string;
  onClose: () => void;
  // search
  searchQ: string; setSearchQ: (v: string) => void;
  searchResults: FileEntry[]; searchLoading: boolean;
  onSearch: () => void;
  onPickSearchResult: (entry: FileEntry) => void;
  // new file / folder
  newName: string; setNewName: (v: string) => void;
  newParentDir: string; setNewParentDir: (v: string) => void;
  newDirChoices: string[];
  onCreateFile: () => void; onCreateFolder: () => void;
  // upload
  uploadDir: string; setUploadDir: (v: string) => void;
  uploadFileObj: File | null;
  uploadInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onPickUploadFile: (f: File) => void;
  onUpload: () => void;
  // rename
  renameValue: string; setRenameValue: (v: string) => void;
  onRename: () => void;
  // move
  moveDest: string; setMoveDest: (v: string) => void;
  moveDirChoices: string[]; onMove: () => void;
  // delete
  deleteRecursive: boolean; setDeleteRecursive: (v: boolean) => void;
  onDelete: () => void;
  // action menu
  onOpenAction: (a: "view" | "rename" | "move" | "delete" | "gitHistory") => void;
  // git
  gitLog: Array<{ hash: string; short_hash: string; subject: string; author: string; date: string }>;
  gitLoading: boolean;
  gitCommit: { hash: string; short_hash: string; subject: string } | null;
  gitMode: "diff" | "full"; setGitMode: (m: "diff" | "full") => void;
  gitDiff: string; gitFull: string; gitDetailLoading: boolean;
  onPickGitCommit: (commit: { hash: string; short_hash: string; subject: string }) => void;
  onBackToGitHistory: () => void;
}

function MobileFileSheet(props: MobileFileSheetProps) {
  const { kind, target, busy, error, onClose } = props;

  const titleByKind: Record<Exclude<FileSheetKind, null>, string> = {
    search: "Search files",
    newFile: "New file",
    newFolder: "New folder",
    upload: "Upload file",
    action: target?.name || "Actions",
    rename: `Rename ${target?.name ?? ""}`,
    move: `Move ${target?.name ?? ""}`,
    deleteConfirm: `Delete ${target?.name ?? ""}`,
    gitHistory: `Git history — ${target?.name ?? ""}`,
    gitCommit: props.gitCommit?.short_hash ?? "Commit",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "10px 12px",
    fontSize: 14, color: "var(--text-primary)",
    background: "var(--bg-base)", border: "1px solid var(--border)",
    borderRadius: 6, outline: "none",
  };
  const primaryBtn: React.CSSProperties = {
    flex: 1, padding: "10px", fontSize: 14, fontWeight: 600,
    background: "var(--accent-blue)", color: "#fff",
    border: "none", borderRadius: 6, cursor: "pointer",
  };
  const secondaryBtn: React.CSSProperties = {
    flex: 1, padding: "10px", fontSize: 14,
    background: "var(--bg-hover)", color: "var(--text-secondary)",
    border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer",
  };
  const dangerBtn: React.CSSProperties = {
    ...primaryBtn, background: "var(--accent-red)",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase",
    letterSpacing: 0.5, marginBottom: 4, display: "block",
  };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 300, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--bg-surface)", borderTopLeftRadius: 12, borderTopRightRadius: 12,
                 maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
          {kind === "gitCommit" && (
            <button onClick={props.onBackToGitHistory}
              style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 18, padding: 0, cursor: "pointer" }}>‹</button>
          )}
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{titleByKind[kind]}</span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 18, padding: 0, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {error && <div style={{ marginBottom: 10, padding: "8px 10px", background: "rgba(248,81,73,0.15)", color: "var(--accent-red)", fontSize: 12, borderRadius: 4 }}>{error}</div>}

          {/* ── Search ─────────────────────────────────────────── */}
          {kind === "search" && (
            <>
              <div style={{ display: "flex", gap: 6 }}>
                <input autoFocus value={props.searchQ}
                  onChange={(e) => props.setSearchQ(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && props.onSearch()}
                  placeholder="filename / fragment" style={inputStyle} />
                <button onClick={props.onSearch} disabled={props.searchLoading} style={{ ...primaryBtn, flex: "none", padding: "0 14px" }}>{props.searchLoading ? "…" : "Go"}</button>
              </div>
              <div style={{ marginTop: 10 }}>
                {props.searchResults.length === 0 && !props.searchLoading && (
                  <div style={{ color: "var(--text-faint)", fontSize: 13, padding: "16px 0", textAlign: "center" }}>{props.searchQ ? "No matches" : "Enter a filename or fragment"}</div>
                )}
                {props.searchResults.map((entry) => (
                  <div key={entry.path}
                    onClick={() => props.onPickSearchResult(entry)}
                    style={{ padding: "8px 4px", borderBottom: "1px solid var(--border-subtle)", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
                    <FileIcon name={entry.name} isDir={entry.type === "dir"} size={14} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</div>
                      <div style={{ fontSize: 10, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.path}</div>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── New file / New folder ───────────────────────────── */}
          {(kind === "newFile" || kind === "newFolder") && (
            <>
              <label style={labelStyle}>Parent directory</label>
              <select value={props.newParentDir} onChange={(e) => props.setNewParentDir(e.target.value)} style={inputStyle}>
                <option value="">(root)</option>
                {props.newDirChoices.filter(d => d !== "").map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <label style={{ ...labelStyle, marginTop: 12 }}>{kind === "newFile" ? "File name" : "Folder name"}</label>
              <input autoFocus value={props.newName} onChange={(e) => props.setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (kind === "newFile" ? props.onCreateFile() : props.onCreateFolder())}
                placeholder={kind === "newFile" ? "untitled.txt" : "new-folder"} style={inputStyle} />
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button onClick={onClose} style={secondaryBtn}>Cancel</button>
                <button disabled={busy} onClick={kind === "newFile" ? props.onCreateFile : props.onCreateFolder} style={primaryBtn}>{busy ? "…" : "Create"}</button>
              </div>
            </>
          )}

          {/* ── Upload ──────────────────────────────────────────── */}
          {kind === "upload" && (
            <>
              <label style={labelStyle}>Target directory</label>
              <select value={props.uploadDir} onChange={(e) => props.setUploadDir(e.target.value)} style={inputStyle}>
                <option value="">(root)</option>
                {props.newDirChoices.filter(d => d !== "").map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <label style={{ ...labelStyle, marginTop: 12 }}>File</label>
              <input ref={props.uploadInputRef} type="file"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) props.onPickUploadFile(f); }}
                style={{ ...inputStyle, padding: "8px 10px" }} />
              {props.uploadFileObj && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>{props.uploadFileObj.name} · {mobileFormatSize(props.uploadFileObj.size)}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button onClick={onClose} style={secondaryBtn}>Cancel</button>
                <button disabled={busy || !props.uploadFileObj} onClick={props.onUpload} style={{ ...primaryBtn, opacity: !props.uploadFileObj ? 0.5 : 1 }}>{busy ? "…" : "Upload"}</button>
              </div>
            </>
          )}

          {/* ── Action menu ─────────────────────────────────────── */}
          {kind === "action" && target && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "6px 0 14px", fontSize: 11, color: "var(--text-faint)", wordBreak: "break-all" }}>{target.path}</div>
              {target.type === "file" && (
                <button onClick={() => props.onOpenAction("view")} style={{ ...secondaryBtn, marginBottom: 6, justifyContent: "flex-start", display: "flex", alignItems: "center", gap: 10 }}>
                  <span>👁</span><span>View</span>
                </button>
              )}
              <button onClick={() => props.onOpenAction("rename")} style={{ ...secondaryBtn, marginBottom: 6, justifyContent: "flex-start", display: "flex", alignItems: "center", gap: 10 }}>
                <span>✎</span><span>Rename</span>
              </button>
              <button onClick={() => props.onOpenAction("move")} style={{ ...secondaryBtn, marginBottom: 6, justifyContent: "flex-start", display: "flex", alignItems: "center", gap: 10 }}>
                <span>↗</span><span>Move</span>
              </button>
              {target.type === "file" && (
                <button onClick={() => props.onOpenAction("gitHistory")} style={{ ...secondaryBtn, marginBottom: 6, justifyContent: "flex-start", display: "flex", alignItems: "center", gap: 10 }}>
                  <span>🕒</span><span>Git history</span>
                </button>
              )}
              <button onClick={() => props.onOpenAction("delete")} style={{ ...secondaryBtn, marginBottom: 6, justifyContent: "flex-start", display: "flex", alignItems: "center", gap: 10, color: "var(--accent-red)", borderColor: "var(--accent-red)" }}>
                <span>🗑</span><span>Delete</span>
              </button>
            </div>
          )}

          {/* ── Rename ──────────────────────────────────────────── */}
          {kind === "rename" && target && (
            <>
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 8, wordBreak: "break-all" }}>{target.path}</div>
              <label style={labelStyle}>New name</label>
              <input autoFocus value={props.renameValue} onChange={(e) => props.setRenameValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && props.onRename()} style={inputStyle} />
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button onClick={onClose} style={secondaryBtn}>Cancel</button>
                <button disabled={busy} onClick={props.onRename} style={primaryBtn}>{busy ? "…" : "Rename"}</button>
              </div>
            </>
          )}

          {/* ── Move ────────────────────────────────────────────── */}
          {kind === "move" && target && (
            <>
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 8, wordBreak: "break-all" }}>{target.path}</div>
              <label style={labelStyle}>Move to directory</label>
              <select value={props.moveDest} onChange={(e) => props.setMoveDest(e.target.value)} style={inputStyle}>
                <option value="">(root)</option>
                {props.moveDirChoices.filter(d => d !== "").map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button onClick={onClose} style={secondaryBtn}>Cancel</button>
                <button disabled={busy} onClick={props.onMove} style={primaryBtn}>{busy ? "…" : "Move"}</button>
              </div>
            </>
          )}

          {/* ── Delete confirm ──────────────────────────────────── */}
          {kind === "deleteConfirm" && target && (
            <>
              <div style={{ fontSize: 14, color: "var(--text-primary)", marginBottom: 10 }}>
                Delete <strong>{target.name}</strong>?
              </div>
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 14, wordBreak: "break-all" }}>{target.path}</div>
              {target.type === "dir" && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", border: "1px solid var(--accent-red)", borderRadius: 6, background: "rgba(248,81,73,0.08)", marginBottom: 12, cursor: "pointer", fontSize: 13, color: "var(--text-primary)" }}>
                  <input type="checkbox" checked={props.deleteRecursive} onChange={(e) => props.setDeleteRecursive(e.target.checked)} />
                  <span>Recursive — delete folder and all contents</span>
                </label>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={onClose} style={secondaryBtn}>Cancel</button>
                <button disabled={busy} onClick={props.onDelete} style={dangerBtn}>{busy ? "…" : "Delete"}</button>
              </div>
            </>
          )}

          {/* ── Git history list ────────────────────────────────── */}
          {kind === "gitHistory" && target && (
            <>
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 10, wordBreak: "break-all" }}>{target.path}</div>
              {props.gitLoading && <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>}
              {!props.gitLoading && props.gitLog.length === 0 && (
                <div style={{ padding: 16, textAlign: "center", color: "var(--text-faint)", fontSize: 13 }}>No git history</div>
              )}
              {props.gitLog.map((c) => (
                <div key={c.hash} onClick={() => props.onPickGitCommit(c)}
                  style={{ padding: "10px 0", borderBottom: "1px solid var(--border-subtle)", cursor: "pointer" }}>
                  <div style={{ fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>{c.subject}</div>
                  <div style={{ fontSize: 11, color: "var(--text-faint)", display: "flex", gap: 8 }}>
                    <span style={{ fontFamily: "monospace" }}>{c.short_hash}</span>
                    <span>·</span>
                    <span>{c.author}</span>
                    <span>·</span>
                    <span>{c.date}</span>
                  </div>
                </div>
              ))}
            </>
          )}

          {/* ── Git single commit (diff/full) ──────────────────── */}
          {kind === "gitCommit" && target && props.gitCommit && (
            <>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{props.gitCommit.subject}</div>
              <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "monospace", marginBottom: 10 }}>{props.gitCommit.short_hash}</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                <button onClick={() => props.setGitMode("diff")}
                  style={{ flex: 1, padding: "6px", fontSize: 12, background: props.gitMode === "diff" ? "var(--accent-blue)" : "var(--bg-hover)", color: props.gitMode === "diff" ? "#fff" : "var(--text-muted)", border: "none", borderRadius: 4, cursor: "pointer" }}>Diff</button>
                <button onClick={() => props.setGitMode("full")}
                  style={{ flex: 1, padding: "6px", fontSize: 12, background: props.gitMode === "full" ? "var(--accent-blue)" : "var(--bg-hover)", color: props.gitMode === "full" ? "#fff" : "var(--text-muted)", border: "none", borderRadius: 4, cursor: "pointer" }}>Full file</button>
              </div>
              {props.gitDetailLoading
                ? <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
                : <pre style={{ margin: 0, padding: 8, background: "var(--bg-base)", border: "1px solid var(--border-subtle)", borderRadius: 4, fontSize: 11, color: "var(--text-primary)", overflow: "auto", maxHeight: "50vh", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace" }}>{props.gitMode === "diff" ? (props.gitDiff || "(empty diff)") : (props.gitFull || "(no content)")}</pre>
              }
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ScrollJumpBtn({ scrollRef, stickToBottom }: { scrollRef: React.RefObject<HTMLDivElement | null>; stickToBottom: React.MutableRefObject<boolean> }) {
  const btnStyle: React.CSSProperties = { width: 28, height: 28, borderRadius: "50%", background: "rgba(31,41,55,0.85)", border: "1px solid #374151", color: "var(--text-secondary)", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" };
  return (
    <div style={{ position: "absolute", right: 10, top: 10, display: "flex", flexDirection: "column", gap: 6, zIndex: 99 }}>
      <button onClick={() => { const el = scrollRef.current; if (!el) return; stickToBottom.current = false; el.scrollTo({ top: 0, behavior: "smooth" }); }} style={btnStyle}>↑</button>
      <button onClick={() => { const el = scrollRef.current; if (!el) return; stickToBottom.current = true; el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }} style={btnStyle}>↓</button>
    </div>
  );
}

/* ─── Inquirer prompt detection ─── */
function detectInquirerPrompt(text: string): { question: string; options: string[] } | null {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  // Find last line starting with "?" (inquirer question marker)
  let qIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("?")) { qIdx = i; break; }
  }
  if (qIdx < 0) return null;
  // Extract numbered options from lines after the question
  const opts: string[] = [];
  for (const l of lines.slice(qIdx + 1)) {
    const m = l.match(/^(?:❯\s*)?(\d+)[.)]\s+(.+)/);
    if (m) opts.push(m[2].trim());
  }
  if (opts.length < 2) return null;
  return { question: lines[qIdx].replace(/^\?\s*/, ""), options: opts };
}

/* ─── Session Detail ─── */
const statusDot = (s: string) =>
  s === "running" ? "var(--accent-green)" : s === "stopped" || s === "terminated" ? "var(--accent-red)" : "var(--text-secondary)";

function relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function SessionDrawer({
  open, onClose, onOpen, currentSession, onNewSession,
  onImport, onLogout, onSwitchToAdmin, theme, onToggleTheme, username, onOpenSettings,
}: {
  open: boolean; onClose: () => void;
  onOpen: (s: SessionMeta) => void;
  currentSession: SessionMeta;
  onNewSession: () => void;
  onImport: () => void;
  onLogout: () => void;
  onSwitchToAdmin?: () => void;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  username: string;
  onOpenSettings?: () => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [showAllSessions, setShowAllSessions] = useState<boolean>(
    () => localStorage.getItem("mobileShowAllSessions") === "1",
  );
  useEffect(() => {
    localStorage.setItem("mobileShowAllSessions", showAllSessions ? "1" : "0");
  }, [showAllSessions]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listSessions().then((r) => {
      const active = (s: SessionMeta) => s.status === "running" || s.status === "detached";
      setSessions([...r.items.filter(active), ...r.items.filter((s) => !active(s))]);
    }).catch(() => {}).finally(() => setLoading(false));
    getUsageInfo().then(setUsage).catch(() => {});
  }, [open]);

  const handleDrawerDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm("Delete this session?")) return;
    setDeletingId(id);
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch { alert("Failed to delete"); } finally { setDeletingId(null); }
  };

  const isActive = (s: SessionMeta) => s.status === "running" || s.status === "detached";
  const others = sessions
    .filter(s => s.id !== currentSession.id)
    .filter(s => showAllSessions || isActive(s));
  // Use fresh data from the fetched list when available
  const displayCurrent = sessions.find(s => s.id === currentSession.id) ?? currentSession;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 300,
          background: open ? "rgba(0,0,0,0.55)" : "transparent",
          pointerEvents: open ? "auto" : "none",
          transition: "background 0.22s",
        }}
      />
      {/* Panel */}
      <div style={{
        position: "fixed", top: 0, left: 0, bottom: 0,
        width: "86%", maxWidth: 340,
        background: "var(--bg-base)",
        borderRight: "1px solid var(--border)",
        zIndex: 301,
        display: "flex", flexDirection: "column",
        transform: open ? "translateX(0)" : "translateX(-100%)",
        transition: "transform 0.24s cubic-bezier(0.4,0,0.2,1)",
        willChange: "transform",
      }}>
        {/* ── Header ── */}
        <div style={{ padding: "14px 16px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-bright)", flex: 1 }}>Sessions</span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-faint)", fontSize: 22, lineHeight: 1, cursor: "pointer", padding: "0 2px" }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {/* ── Current session ── */}
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--text-faintest)", fontWeight: 600, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6 }}>Current</div>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%", flexShrink: 0, display: "inline-block",
                background: statusDot(displayCurrent.status),
                animation: displayCurrent.is_streaming ? "cursor-blink 0.8s step-end infinite" : undefined,
              }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-bright)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {displayCurrent.project}
              </span>
              {displayCurrent.is_streaming ? (
                <span style={{ fontSize: 9, color: "var(--accent-blue)", background: "rgba(88,166,255,0.12)", border: "1px solid rgba(88,166,255,0.3)", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>live</span>
              ) : displayCurrent.status === "terminated" ? (
                <span style={{ fontSize: 9, color: "var(--accent-red)", background: "rgba(248,81,73,0.1)", border: "1px solid rgba(248,81,73,0.25)", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>terminated</span>
              ) : displayCurrent.status === "detached" ? (
                <span style={{ fontSize: 9, color: "var(--text-muted)", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>detached</span>
              ) : null}
            </div>
            {displayCurrent.prompts?.[0] && <div style={{ fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingLeft: 14, marginTop: 3 }}><PromptText text={displayCurrent.prompts[0]} /></div>}
            {displayCurrent.prompts && displayCurrent.prompts.length >= 2 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 14, marginTop: 2 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><PromptText text={displayCurrent.prompts[displayCurrent.prompts.length - 1]} /></span>
                {displayCurrent.last_user_input_at && <span style={{ fontSize: 10, color: "var(--text-faintest)", flexShrink: 0 }}>{relTime(displayCurrent.last_user_input_at)}</span>}
              </div>
            )}
            {(!displayCurrent.prompts || displayCurrent.prompts.length < 2) && displayCurrent.last_user_input_at && (
              <div style={{ fontSize: 10, color: "var(--text-faintest)", paddingLeft: 14, marginTop: 2 }}>{relTime(displayCurrent.last_user_input_at)}</div>
            )}
          </div>

          {/* ── Other sessions ── */}
          <div style={{ padding: "10px 14px 4px" }}>
            <div style={{ fontSize: 10, color: "var(--text-faintest)", fontWeight: 600, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6 }}>Switch to</div>
            <button
              onClick={() => setShowAllSessions((v) => !v)}
              style={{
                width: "100%", padding: "5px 10px", borderRadius: 5, fontSize: 11,
                background: showAllSessions ? "var(--bg-hover)" : "rgba(88,166,255,0.1)",
                border: `1px solid ${showAllSessions ? "var(--border)" : "rgba(88,166,255,0.3)"}`,
                color: showAllSessions ? "var(--text-muted)" : "var(--accent-blue)",
                cursor: "pointer", textAlign: "left",
              }}
            >
              {showAllSessions ? "Showing all sessions" : "Active sessions only"}
            </button>
          </div>
          {loading
            ? <div style={{ textAlign: "center", padding: 20, color: "var(--text-faint)", fontSize: 13 }}>Loading…</div>
            : others.length === 0
              ? <div style={{ padding: "4px 14px 12px", fontSize: 12, color: "var(--text-faintest)" }}>{showAllSessions ? "No other sessions" : "No other active sessions"}</div>
              : others.map((s) => (
                <div
                  key={s.id}
                  onClick={() => { history.replaceState(null, "", `#/s/${s.id}`); onOpen(s); onClose(); }}
                  style={{ padding: "11px 14px", borderBottom: "1px solid var(--border-subtle)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 3 }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%", flexShrink: 0, display: "inline-block",
                      background: statusDot(s.status),
                      animation: s.is_streaming ? "cursor-blink 0.8s step-end infinite" : undefined,
                    }} />
                    <span style={{ fontSize: 14, fontWeight: 600, flex: 1, color: "var(--text-bright)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.project}</span>
                    {s.is_streaming ? (
                      <span style={{ fontSize: 9, color: "var(--accent-blue)", background: "rgba(88,166,255,0.1)", border: "1px solid rgba(88,166,255,0.3)", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>live</span>
                    ) : s.has_new_output ? (
                      <span style={{ fontSize: 9, color: "var(--accent-green)", background: "rgba(63,185,80,0.1)", border: "1px solid rgba(63,185,80,0.3)", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>new</span>
                    ) : s.status === "terminated" ? (
                      <span style={{ fontSize: 9, color: "var(--accent-red)", background: "rgba(248,81,73,0.1)", border: "1px solid rgba(248,81,73,0.25)", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>ended</span>
                    ) : s.status === "detached" ? (
                      <span style={{ fontSize: 9, color: "var(--text-muted)", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>detached</span>
                    ) : null}
                    {s.status === "terminated" && (
                      <button
                        onClick={(e) => handleDrawerDelete(e, s.id)}
                        disabled={deletingId === s.id}
                        style={{ background: "transparent", border: "none", color: deletingId === s.id ? "var(--text-faintest)" : "var(--text-faint)", fontSize: 15, padding: "1px 3px", cursor: "pointer", flexShrink: 0, lineHeight: 1 }}
                        title="Delete"
                      >{deletingId === s.id ? "…" : "🗑"}</button>
                    )}
                  </div>
                  {s.prompts?.[0] && <div style={{ fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingLeft: 13 }}><PromptText text={s.prompts[0]} /></div>}
                  {s.prompts && s.prompts.length >= 2 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 13 }}>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><PromptText text={s.prompts[s.prompts.length - 1]} /></span>
                      {s.last_user_input_at && <span style={{ fontSize: 10, color: "var(--text-faintest)", flexShrink: 0 }}>{relTime(s.last_user_input_at)}</span>}
                    </div>
                  )}
                  {(!s.prompts || s.prompts.length < 2) && s.last_user_input_at && (
                    <div style={{ fontSize: 10, color: "var(--text-faintest)", paddingLeft: 13 }}>{relTime(s.last_user_input_at)}</div>
                  )}
                </div>
              ))
          }
        </div>

        {/* ── Bottom actions ── */}
        <div style={{ padding: "12px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-surface)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Token usage — single row */}
          {usage && (usage.five_hour || usage.seven_day) && (() => {
            const fmt = (w: NonNullable<UsageInfo["five_hour"]>, week: boolean) => {
              const pct = +(w.utilization * 100).toFixed(1);
              const col = pct >= 80 ? "#f87171" : pct >= 50 ? "#fbbf24" : "#4ade80";
              const d = new Date(w.resets_at);
              const mm = String(d.getMonth() + 1).padStart(2, "0");
              const dd = String(d.getDate()).padStart(2, "0");
              const hhmm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
              const reset = week ? `${mm}-${dd} ${hhmm}` : hhmm;
              return { pct, col, reset };
            };
            const s = usage.five_hour ? fmt(usage.five_hour, false) : null;
            const w = usage.seven_day ? fmt(usage.seven_day, true) : null;
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                {s && <><span style={{ color: "var(--text-faintest)" }}>5h</span><span style={{ color: s.col, fontWeight: 700 }}>{s.pct}%</span><span style={{ color: "var(--text-faintest)" }}>↻{s.reset}</span></>}
                {s && w && <span style={{ color: "var(--border)", fontSize: 10 }}>|</span>}
                {w && <><span style={{ color: "var(--text-faintest)" }}>7d</span><span style={{ color: w.col, fontWeight: 700 }}>{w.pct}%</span><span style={{ color: "var(--text-faintest)" }}>↻{w.reset}</span></>}
              </div>
            );
          })()}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => { onNewSession(); onClose(); }}
              style={{ flex: 1, padding: "11px 0", background: "var(--accent-green)", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >+ New</button>
            <button
              onClick={() => { onImport(); onClose(); }}
              style={{ flex: 1, padding: "11px 0", background: "rgba(88,166,255,0.1)", color: "var(--accent-blue)", border: "1px solid rgba(88,166,255,0.3)", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >⬆ Import</button>
          </div>
          {/* Footer: user info + theme + admin + logout */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-faint)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{username}</span>
            {onToggleTheme && (
              <button onClick={onToggleTheme} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text-muted)", fontSize: 14, padding: "4px 8px", cursor: "pointer" }} title="Toggle theme">
                {theme === "light" ? "🌙" : "☀️"}
              </button>
            )}
            {onOpenSettings && (
              <button onClick={() => { onClose(); onOpenSettings(); }} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text-muted)", fontSize: 14, padding: "4px 8px", cursor: "pointer" }} title="Settings">⚙</button>
            )}
            {onSwitchToAdmin && (
              <button onClick={() => { onSwitchToAdmin(); onClose(); }} style={{ background: "rgba(88,166,255,0.12)", border: "1px solid rgba(88,166,255,0.3)", borderRadius: 7, color: "var(--accent-blue)", fontSize: 12, padding: "4px 10px", cursor: "pointer" }}>
                Admin
              </button>
            )}
            <button onClick={onLogout} style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text-muted)", fontSize: 12, padding: "4px 10px", cursor: "pointer" }}>
              Logout
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function DetailView({ session: initialSession, onBack, username, onLogout, onSwitchToAdmin, theme, onToggleTheme, terminalFont, onTerminalFontChange }: {
  session: SessionMeta; onBack: () => void; username: string;
  onLogout: () => void; onSwitchToAdmin?: () => void; theme?: "dark" | "light"; onToggleTheme?: () => void;
  terminalFont?: string; onTerminalFontChange?: (font: string) => void;
}) {
  const [session, setSession] = useState(initialSession);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCaps, setShowCaps] = useState(false);
  const [showJsonl, setShowJsonl] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [fontSize, setFontSize] = useState<number>(() => Number(localStorage.getItem("cm_mobile_font") || 13));
  const changeFontSize = (delta: number) => setFontSize(prev => {
    const next = Math.min(20, Math.max(10, prev + delta));
    localStorage.setItem("cm_mobile_font", String(next));
    return next;
  });
  const [showGit, setShowGit] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showGoals, setShowGoals] = useState(false);
  const [showAuqs, setShowAuqs] = useState(false);
  const [shellOpen, setShellOpen] = useState(false);
  const [shellMinimized, setShellMinimized] = useState(false);
  const [showResumeSelect, setShowResumeSelect] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settingModel, setSettingModel] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [workspaceBase, setWorkspaceBase] = useState("/workspace");
  const [enabledTools, setEnabledTools] = useState<string[]>(["claude", "codex", "cursor"]);
  useEffect(() => { getConfig().then((c) => { setWorkspaceBase(c.workspace); setEnabledTools(c.enabled_tools); }).catch(() => {}); }, []);

  // Codex app-server: no terminal, only chat input.
  const isCodexAppServer = session.tool === "codex" && session.codex_transport === "app_server";

  // ── TUI view ──────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<"chat" | "tui" | "memory">("chat");
  const [tuiWs, setTuiWs] = useState<{ url: string; token: string; sid: string } | null>(null);
  const [tuiLoading, setTuiLoading] = useState(false);
  const [tuiCtrlActive, setTuiCtrlActive] = useState(false);
  const [tuiHint, setTuiHint] = useState<string | null>(null);
  const [tuiHintDismissed, setTuiHintDismissed] = useState(false);
  const [tuiAuqData, setTuiAuqData] = useState<TuiAuqData | null>(null);
  const [tuiApproveData, setTuiApproveData] = useState<TuiApproveData | null>(null);
  const [tuiPlanData, setTuiPlanData] = useState<TuiPlanData | null>(null);
  const [lostMessages, setLostMessages] = useState<LostMessage[]>([]);
  const [compactingProgress, setCompactingProgress] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const tuiSendRawRef = useRef<((data: string) => void) | null>(null);
  const tuiScrollBottomRef = useRef<(() => void) | null>(null);

  const switchToTui = useCallback(() => {
    setTuiHintDismissed(true);
    setViewMode("tui");
  }, []);

  // Attach (or re-attach) the TUI websocket for the *currently active* session
  // whenever the TUI view is shown. DetailView keeps a single mounted instance
  // and swaps `session` in place (no remount), so without re-attaching on
  // session.id the first session's ws stays pinned and every session then shows
  // that first session's TUI. Keying the effect on session.id fixes that.
  useEffect(() => {
    if (viewMode !== "tui") return;
    if (tuiWs && tuiWs.sid === session.id) return; // already attached to this session
    let cancelled = false;
    setTuiLoading(true);
    attachSession(session.id)
      .then((res) => { if (!cancelled) setTuiWs({ url: res.ws_url, token: res.ws_token, sid: session.id }); })
      .catch((e) => { if (!cancelled) { alert(String(e)); setViewMode("chat"); } })
      .finally(() => { if (!cancelled) setTuiLoading(false); });
    return () => { cancelled = true; };
  }, [session.id, viewMode, tuiWs]);

  // ── History management ──────────────────────────────────────────
  const showGitRef = useRef(false);
  const showScheduleRef = useRef(false);
  const showFilesRef = useRef(false);
  const shellOpenRef = useRef(false);
  const filesBackHandlerRef = useRef<(() => void) | null>(null);
  const showResumeSelectRef = useRef(false);
  const showModelPickerRef = useRef(false);
  const showCapsRef = useRef(false);
  const showJsonlRef = useRef(false);
  const stopResponseRef = useRef<(() => void) | null>(null);
  const convRefreshRef = useRef<(() => void) | null>(null);
  const showTasksRef = useRef(false);
  const showGoalsRef = useRef(false);
  const showAuqsRef = useRef(false);
  showGitRef.current = showGit;
  showScheduleRef.current = showSchedule;
  showFilesRef.current = showFiles;
  showTasksRef.current = showTasks;
  showGoalsRef.current = showGoals;
  showAuqsRef.current = showAuqs;
  shellOpenRef.current = shellOpen;
  showResumeSelectRef.current = showResumeSelect;
  showModelPickerRef.current = showModelPicker;
  showCapsRef.current = showCaps;
  showJsonlRef.current = showJsonl;

  // Push history entry when this view mounts; handle all back navigation here.
  useEffect(() => {
    history.pushState({ mobileDetail: true }, "");
    const handlePop = () => {
      if (filesBackHandlerRef.current) { filesBackHandlerRef.current(); return; }
      if (showFilesRef.current) { setShowFiles(false); return; }
      if (showGitRef.current) { setShowGit(false); return; }
      if (showScheduleRef.current) { setShowSchedule(false); return; }
      if (showTasksRef.current) { setShowTasks(false); return; }
      if (showGoalsRef.current) { setShowGoals(false); return; }
      if (showAuqsRef.current) { setShowAuqs(false); return; }
      if (shellOpenRef.current) { setShellOpen(false); setShellMinimized(false); return; }
      if (showResumeSelectRef.current) { setShowResumeSelect(false); return; }
      if (showModelPickerRef.current) { setShowModelPicker(false); return; }
      if (showCapsRef.current) { setShowCaps(false); return; }
      if (showJsonlRef.current) { setShowJsonl(false); return; }
      onBack();
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push extra history entry whenever a sub-panel opens.
  useEffect(() => { if (showGit) history.pushState({ mobileDetail: true, sub: "git" }, ""); }, [showGit]);
  useEffect(() => { if (showSchedule) history.pushState({ mobileDetail: true, sub: "schedule" }, ""); }, [showSchedule]);
  useEffect(() => { if (showTasks) history.pushState({ mobileDetail: true, sub: "tasks" }, ""); }, [showTasks]);
  useEffect(() => { if (showGoals) history.pushState({ mobileDetail: true, sub: "goals" }, ""); }, [showGoals]);
  useEffect(() => { if (showAuqs) history.pushState({ mobileDetail: true, sub: "auqs" }, ""); }, [showAuqs]);
  useEffect(() => { if (showFiles) history.pushState({ mobileDetail: true, sub: "files" }, ""); }, [showFiles]);
  useEffect(() => { if (shellOpen) history.pushState({ mobileDetail: true, sub: "shell" }, ""); }, [shellOpen]);
  useEffect(() => { if (showResumeSelect) history.pushState({ mobileDetail: true, sub: "resumeSelect" }, ""); }, [showResumeSelect]);
  useEffect(() => { if (showModelPicker) history.pushState({ mobileDetail: true, sub: "modelPicker" }, ""); }, [showModelPicker]);
  useEffect(() => { if (showCaps) history.pushState({ mobileDetail: true, sub: "caps" }, ""); }, [showCaps]);
  useEffect(() => { if (showJsonl) history.pushState({ mobileDetail: true, sub: "jsonl" }, ""); }, [showJsonl]);

  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>(initialSession.scheduled_tasks ?? []);

  // Poll session status so is_streaming stays accurate (prevents QAReplyBlock
  // from appearing mid-stream when the stale prop still reads false).
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await listSessionsStatus();
        const st = res.items.find((s) => s.id === initialSession.id);
        if (st) {
          setSession((prev) => ({
            ...prev,
            status: st.status,
            is_streaming: st.is_streaming,
            has_new_output: st.has_new_output,
            attached_clients: st.attached_clients,
            scheduled_tasks: st.scheduled_tasks,
          }));
          setScheduledTasks(st.scheduled_tasks ?? []);
          setTuiHint((prev) => {
            const next = st.tui_hint ?? null;
            if (next !== prev) {
              setTuiHintDismissed(false);
              if (next && !prev) convRefreshRef.current?.();
            }
            return next;
          });
          setTuiAuqData(st.tui_auq_data ?? null);
          setTuiApproveData(st.tui_approve_data ?? null);
          setTuiPlanData(st.tui_plan_data ?? null);
          setLostMessages(st.lost_messages ?? []);
          setIsCompacting(!!st.is_compacting);
          setCompactingProgress(st.compacting_progress ?? null);
        }
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSession.id]);
  const [renamingDetail, setRenamingDetail] = useState(false);
  const [renameDetailValue, setRenameDetailValue] = useState("");

  // Lock container to visual viewport so the header stays visible when soft keyboard opens.
  // On Android Chrome, the keyboard shrinks visualViewport but may scroll layout viewport,
  // which pushes fixed elements off screen. We counteract that by tracking vv offset/height.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const el = containerRef.current;
      if (!el) return;
      el.style.top = `${vv.offsetTop}px`;
      el.style.height = `${vv.height}px`;
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, []);

  return (
    <div ref={containerRef} style={{ display: "flex", flexDirection: "column", position: "fixed", left: 0, right: 0, top: 0, height: "100%", overflow: "hidden", background: "var(--bg-base)" }}>
      {/* Header — 2 rows — flex-shrink:0 so it always occupies its natural height */}
      <div style={{ flexShrink: 0, background: "var(--bg-surface)", borderBottom: "1px solid var(--border)" }}>
        {/* Row 1: menu icon + session name (centered) */}
        <div style={{ padding: "8px 12px", display: "flex", alignItems: "center" }}>
          <button
            onClick={() => setDrawerOpen(true)}
            style={{ background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 20, padding: "0 4px", cursor: "pointer", lineHeight: 1, flexShrink: 0, width: 36 }}
            title="Sessions"
          >☰</button>
          <div style={{ flex: 1, minWidth: 0, textAlign: "center" }}>
            {renamingDetail ? (
              <input
                value={renameDetailValue}
                onChange={(e) => setRenameDetailValue(e.target.value)}
                onBlur={async () => {
                  const v = renameDetailValue.trim();
                  setRenamingDetail(false);
                  if (v && v !== session.project) {
                    try { const s = await renameSession(session.id, v); setSession(s); } catch {}
                  }
                }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenamingDetail(false); }}
                autoFocus
                style={{ fontSize: 14, fontWeight: 600, background: "var(--bg-base)", border: "1px solid #58a6ff", borderRadius: 4, color: "var(--text-bright)", padding: "2px 6px", outline: "none", width: "80%", textAlign: "center" }}
              />
            ) : (
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.project}</span>
                <button
                  onClick={() => { setRenameDetailValue(session.project); setRenamingDetail(true); }}
                  style={{ background: "transparent", border: "none", color: "var(--text-faint)", fontSize: 13, cursor: "pointer", padding: 0, flexShrink: 0 }}
                  title="Rename session"
                >✎</button>
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <button onClick={() => changeFontSize(-1)} disabled={fontSize <= 10} style={{ background: "transparent", border: "none", color: fontSize <= 10 ? "var(--text-faintest)" : "var(--text-muted)", fontSize: 13, padding: "2px 5px", cursor: "pointer", lineHeight: 1 }} title="Smaller text">A−</button>
            <button onClick={() => changeFontSize(1)} disabled={fontSize >= 20} style={{ background: "transparent", border: "none", color: fontSize >= 20 ? "var(--text-faintest)" : "var(--text-muted)", fontSize: 15, padding: "2px 5px", cursor: "pointer", lineHeight: 1 }} title="Larger text">A+</button>
          </div>
        </div>
        {/* Row 2: compact action icon bar */}
        {(() => {
          const pendingCount = scheduledTasks.filter(t => t.status === "pending").length;
          const isTerminated = session.status === "terminated";
          const isDark = theme !== "light";
          const svgFilter = isDark ? "invert(0.6)" : "invert(0.35)";
          const svgStyle = { width: 14, height: 14, display: "block", filter: svgFilter };
          const iconMuted = isDark ? "var(--text-secondary)" : "var(--text-faint)";
          const borderColor = isDark ? "var(--bg-hover)" : "var(--border)";
          const modelLabel = settingModel ? "…" : session.model
            ? (session.model.includes("opus") ? "Opus" : session.model.includes("haiku") ? "Haiku" : "Sonnet")
            : "M";
          type Btn = { icon: React.ReactNode; onClick: () => void; color: string; bg: string; title: string; disabled?: boolean };
          const canStop = !isTerminated && session.is_streaming;
          const btns: Btn[] = [
            { icon: <img src={terminalIcon} style={svgStyle} />, title: "Shell", onClick: () => {
                if (shellOpen) { setShellMinimized(false); return; }
                setShellOpen(true); setShellMinimized(false);
              }, color: shellOpen && shellMinimized ? "var(--accent-blue)" : iconMuted, bg: "transparent" },
            { icon: <FileIcon isDir size={14} />, title: "Files", onClick: () => setShowFiles(true), color: iconMuted, bg: "transparent" },
            { icon: <img src={gitIcon} style={svgStyle} />, title: "Git", onClick: () => setShowGit(true), color: iconMuted, bg: "transparent" },
            {
              icon: pendingCount > 0
                ? <span style={{ position: "relative", display: "inline-flex" }}><img src={scheduleIcon} style={svgStyle} /><span style={{ position: "absolute", top: -4, right: -5, fontSize: 8, background: "var(--accent-blue)", color: "#fff", borderRadius: 6, padding: "0 2px", lineHeight: "12px" }}>{pendingCount}</span></span>
                : <img src={scheduleIcon} style={{ ...svgStyle, filter: isTerminated ? (isDark ? "invert(0.25)" : "invert(0.65)") : svgFilter }} />,
              title: "Schedule", onClick: () => { if (!isTerminated) setShowSchedule(true); },
              color: isTerminated ? (isDark ? "var(--border)" : "var(--text-secondary)") : pendingCount > 0 ? "var(--accent-blue)" : iconMuted, bg: "transparent",
            },
            { icon: <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: -0.3 }}>☑</span>, title: "Tasks", onClick: () => setShowTasks(true), color: iconMuted, bg: "transparent" },
            { icon: <span style={{ fontSize: 11, fontWeight: 700 }}>◎</span>, title: "Goals", onClick: () => setShowGoals(true), color: iconMuted, bg: "transparent" },
            { icon: <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: -0.2 }}>Q?</span>, title: "AUQs", onClick: () => setShowAuqs(true), color: iconMuted, bg: "transparent" },
            {
              icon: <span style={{ fontSize: 10, fontWeight: 700 }}>{modelLabel}</span>,
              title: `Model: ${session.model || "default"}`,
              onClick: async () => {
                if (models.length === 0) { try { setModels(await listModels(session.tool || "claude")); } catch {} }
                setShowModelPicker(true);
              },
              color: session.model ? "var(--accent-blue)" : iconMuted, bg: "transparent",
            },
            { icon: "⇄", title: "Switch session", onClick: () => setShowResumeSelect(true), color: "var(--accent-blue)", bg: "transparent" },
            {
              icon: canStop
                ? <span className="stop-pulse" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 5, background: "#f97316", color: "#fff", fontSize: 11, fontWeight: 900 }}>■</span>
                : <span style={{ fontSize: 13, fontWeight: 700 }}>■</span>,
              title: "Stop reply",
              onClick: () => { if (canStop) stopResponseRef.current?.(); },
              color: "var(--text-faintest)", bg: "transparent",
              disabled: !canStop,
            },
            isTerminated
              ? { icon: "▶", title: "Resume", onClick: async () => { try { await resumeSession(session.id); setSession((s) => ({ ...s, status: "running" })); } catch (e) { alert(String(e)); } }, color: "var(--accent-green)", bg: "transparent" }
              : { icon: "⏹", title: "Terminate", onClick: async () => { try { await terminateSession(session.id); onBack(); } catch {} }, color: "var(--accent-red)", bg: "transparent" },
            { icon: "⚙", title: "Claude Capabilities", onClick: () => setShowCaps(true), color: iconMuted, bg: "transparent" },
            { icon: "🔗", title: "分享对话", onClick: () => setShowShare(true), color: iconMuted, bg: "transparent" },
            {
              icon: <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: -0.3 }}>HTML</span>,
              title: "Export chat as HTML",
              onClick: async () => { try { await downloadConversationHtml(session); } catch (e) { alert(String(e)); } },
              color: iconMuted, bg: "transparent",
            },
            ...(session.agent_session_id ? [{
              icon: <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: -0.3 }}>JSON</span>,
              title: "Preview conversation.jsonl",
              onClick: () => setShowJsonl(true),
              color: iconMuted, bg: "transparent",
            }] : []),
          ];
          // With 12+ buttons, even-grid would shrink each below tap-target size on narrow
          // phones. Use flex with a min-width per button and let it scroll horizontally
          // when it overflows — preserves the layout on roomy screens, stays usable on narrow.
          return (
            <div style={{ display: "flex", borderTop: `1px solid ${borderColor}`, overflowX: "auto", scrollbarWidth: "none" }}>
              {btns.map((b, i) => (
                <button key={i} onClick={b.onClick} title={b.title} disabled={b.disabled}
                  style={{ height: 34, flex: "1 0 auto", minWidth: 36, display: "flex", alignItems: "center", justifyContent: "center", background: b.bg, color: b.color, border: "none", borderRight: i < btns.length - 1 ? `1px solid ${borderColor}` : "none", cursor: b.disabled ? "default" : "pointer", padding: 0 }}>
                  {b.icon}
                </button>
              ))}
            </div>
          );
        })()}
      </div>

      <SessionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onOpen={(s) => setSession(s)}
        currentSession={session}
        onNewSession={() => setShowCreate(true)}
        onImport={() => setShowImport(true)}
        onLogout={onLogout}
        onSwitchToAdmin={onSwitchToAdmin}
        theme={theme}
        onToggleTheme={onToggleTheme}
        username={username}
        onOpenSettings={() => setShowSettings(true)}
      />
      <MobileSettingsPanel
        open={showSettings} onClose={() => setShowSettings(false)}
        theme={theme} onToggleTheme={onToggleTheme}
        terminalFont={terminalFont} onTerminalFontChange={onTerminalFontChange}
      />
      <MobileSharePanel open={showShare} onClose={() => setShowShare(false)} session={session} />

      {shellOpen && <MobileShellPanel sessionId={session.id} cwd={session.cwd} onClose={() => history.back()} onMinimize={() => setShellMinimized(true)} minimized={shellMinimized} fontFamily={terminalFont} />}
      {shellOpen && shellMinimized && (
        <button
          onClick={() => setShellMinimized(false)}
          title="Restore terminal"
          style={{
            position: "fixed", right: 14, bottom: 84, zIndex: 199,
            background: "var(--bg-surface)", border: "1px solid var(--accent-blue)",
            color: "var(--accent-blue)", borderRadius: 22, padding: "8px 14px",
            fontSize: 13, fontFamily: "monospace", fontWeight: 600,
            boxShadow: "0 4px 14px rgba(0,0,0,0.4)", cursor: "pointer",
            display: "flex", alignItems: "center", gap: 6,
          }}
        >
          <span>&gt;_</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}>Terminal</span>
        </button>
      )}
      {showFiles && (
        <MobileFileBrowserPanel
          sessionId={session.id}
          sessionCwd={session.cwd}
          onClose={() => history.back()}
          onSetBackHandler={(fn) => { filesBackHandlerRef.current = fn; }}
        />
      )}
      {showGit && <MobileGitPanel sessionId={session.id} session={session} onSessionChange={setSession} onClose={() => history.back()} />}
      {showResumeSelect && (
        <MobileResumeSelectPanel
          sessionId={session.id}
          onClose={() => history.back()}
          onDone={(newSession) => { setSession(newSession); history.back(); }}
        />
      )}
      {showSchedule && (
        <MobileSchedulePanel
          sessionId={session.id}
          tasks={scheduledTasks}
          onTasksChange={setScheduledTasks}
          onClose={() => history.back()}
        />
      )}
      {showTasks && <MobileTasksPanel sessionId={session.id} onClose={() => history.back()} />}
      {showGoals && <MobileGoalsPanel sessionId={session.id} onClose={() => history.back()} />}
      {showAuqs && <MobileAuqsPanel sessionId={session.id} onClose={() => history.back()} />}
      {showJsonl && (
        <div style={{ position: "fixed", inset: 0, zIndex: 3000, background: "var(--bg-base)", display: "flex", flexDirection: "column" }}>
          <JsonlPreviewModal
            inline
            sessionId={session.id}
            sessionTitle={session.project}
            onClose={() => history.back()}
          />
        </div>
      )}

      {showModelPicker && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-end" }}
          onClick={() => history.back()}>
          <div style={{ width: "100%", background: "var(--bg-surface)", borderRadius: "12px 12px 0 0", padding: "16px 0 32px" }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ textAlign: "center", fontSize: 12, color: "var(--text-faint)", marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
              Switch Model
            </div>
            {[{ id: null, name: "Default (server setting)" }, ...models].map((m, i) => {
              const isCurrent = m.id === null ? !session.model : session.model === m.id;
              return (
                <button
                  key={m.id ?? "__default__"}
                  onClick={() => {
                    history.back();
                    void (async () => {
                      setSettingModel(true);
                      try {
                        const updated = await setSessionModel(session.id, m.id);
                        setSession(updated);
                      } catch (e) { alert(String(e)); }
                      finally { setSettingModel(false); }
                    })();
                  }}
                  style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", padding: "14px 24px", background: "transparent", border: "none", color: isCurrent ? "var(--accent-blue)" : "var(--text-bright)", fontSize: 14, cursor: "pointer", borderTop: i === 0 ? "none" : "1px solid var(--border-subtle)" }}
                >
                  <span>{m.name}</span>
                  {isCurrent && <span style={{ color: "var(--accent-blue)" }}>✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {showCaps && (
        <ClaudeCapsModal cwd={session.cwd ?? null} onClose={() => history.back()} />
      )}

      {/* Chat / TUI / Memory tab strip — TUI hidden for Codex app-server (no terminal) */}
      <div style={{ display: "flex", background: "var(--bg-surface)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button
          onClick={() => setViewMode("chat")}
          style={{ flex: 1, height: 30, background: "transparent", border: "none", borderBottom: viewMode === "chat" ? "2px solid var(--accent-blue)" : "2px solid transparent", color: viewMode === "chat" ? "var(--accent-blue)" : "var(--text-faint)", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "color 0.15s" }}
        >💬 Chat</button>
        {!isCodexAppServer && (
          <button
            onClick={switchToTui}
            disabled={tuiLoading}
            style={{ flex: 1, height: 30, background: "transparent", border: "none", borderBottom: viewMode === "tui" ? "2px solid var(--accent-green)" : "2px solid transparent", color: viewMode === "tui" ? "var(--accent-green)" : tuiLoading ? "var(--text-faintest)" : "var(--text-faint)", fontSize: 12, fontWeight: 600, cursor: tuiLoading ? "default" : "pointer", transition: "color 0.15s" }}
          >{tuiLoading ? "Connecting…" : "TUI"}</button>
        )}
        <button
          onClick={() => setViewMode("memory")}
          style={{ flex: 1, height: 30, background: "transparent", border: "none", borderBottom: viewMode === "memory" ? "2px solid var(--accent-purple, #a78bfa)" : "2px solid transparent", color: viewMode === "memory" ? "var(--accent-purple, #a78bfa)" : "var(--text-faint)", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "color 0.15s" }}
        >🧠 Memory</button>
      </div>

      {/* Content area — both panes mounted, visibility toggled */}
      <div style={{
        flex: 1, minHeight: 0,
        display: viewMode === "chat" ? "flex" : "none",
        flexDirection: "column", overflow: "hidden",
        // Base + 3 derived sizes used by ConversationPane / ToolCallBlock /
        // ThinkingBlock so that tool-use modules also scale with font size.
        "--conv-font":     `${fontSize}px`,
        "--conv-font-sm":  `calc(${fontSize}px - 1.5px)`,
        "--conv-font-xs":  `calc(${fontSize}px - 2.5px)`,
        "--conv-font-xxs": `calc(${fontSize}px - 3.5px)`,
      } as React.CSSProperties}>
        <ConversationPane
          key={session.id}
          sessionId={session.id}
          tool={session.tool as "claude" | "cursor" | "codex" | undefined}
          codexTransport={session.codex_transport}
          isStreaming={session.is_streaming}
          isCompacting={isCompacting}
          compactingProgress={compactingProgress}
          isWaitingForAuq={!!tuiHint?.includes("asking a question")}
          pendingAuqData={tuiAuqData}
          pendingApproveData={tuiApproveData}
          pendingPlanData={tuiPlanData}
          lostMessages={lostMessages}
          stopRef={stopResponseRef}
          refreshRef={convRefreshRef}
        />
        {isCodexAppServer && (
          <CodexChatInput sessionId={session.id} onSent={() => convRefreshRef.current?.()} />
        )}
      </div>
      {tuiWs && tuiWs.sid === session.id && (
        <div style={{ flex: 1, minHeight: 0, display: viewMode === "tui" ? "flex" : "none", flexDirection: "column", overflow: "hidden" }}>
          <TuiPane
            key={tuiWs.sid + tuiWs.token + (terminalFont || "")}
            wsUrl={tuiWs.url}
            theme={theme}
            fontFamily={terminalFont}
            scrollToBottomRef={tuiScrollBottomRef}
            sendRawRef={tuiSendRawRef}
            useTmuxScroll={session.tool === "codex"}
          />
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: viewMode === "memory" ? "flex" : "none", flexDirection: "column", overflow: "hidden" }}>
        <MemoryPanel sessionId={session.id} compact fontSize={fontSize} />
      </div>

      {/* TUI keyboard toolbar */}
      {viewMode === "tui" && tuiWs && tuiWs.sid === session.id && (() => {
        const sendKey = (seq: string) => tuiSendRawRef.current?.(seq);
        const sendCtrl = (letter: string) => { sendKey(String.fromCharCode(letter.charCodeAt(0) - 64)); setTuiCtrlActive(false); };
        const tbBtn: React.CSSProperties = { flex: 1, height: 40, background: "transparent", border: "none", borderRight: "1px solid var(--border-subtle)", color: "var(--text-primary)", fontSize: 12, fontFamily: "monospace", fontWeight: 600, cursor: "pointer", padding: 0, userSelect: "none" };
        return (
          <div style={{ flexShrink: 0, background: "var(--bg-surface)", borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex" }}>
              <button
                onPointerDown={(e) => { e.preventDefault(); setTuiCtrlActive(v => !v); }}
                style={{ ...tbBtn, background: tuiCtrlActive ? "color-mix(in srgb, var(--accent-blue) 18%, var(--bg-base))" : "transparent", color: tuiCtrlActive ? "var(--accent-blue)" : "var(--text-secondary)", borderRadius: 0, letterSpacing: 0.5 }}
              >CTRL</button>
              {ROW1_NAV.map((k) => (
                <button key={k.label} onPointerDown={(e) => { e.preventDefault(); sendKey(k.seq); }}
                  style={{ ...tbBtn, fontSize: "←↑↓→".includes(k.label) ? 16 : 12 }}>{k.label}</button>
              ))}
              <button onPointerDown={(e) => { e.preventDefault(); tuiScrollBottomRef.current?.(); }}
                style={{ ...tbBtn, borderRight: "none", color: "var(--text-secondary)" }}>↓</button>
            </div>
            {tuiCtrlActive && (
              <div style={{ display: "flex", overflowX: "auto", scrollbarWidth: "none", borderTop: "1px solid var(--border-subtle)" }}>
                {CTRL_COMMON.map(({ letter, desc, title }) => (
                  <button key={letter} title={title} onPointerDown={(e) => { e.preventDefault(); sendCtrl(letter); }}
                    style={{ flexShrink: 0, minWidth: 48, height: 40, background: "transparent", border: "none", borderRight: "1px solid var(--border-subtle)", cursor: "pointer", userSelect: "none", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, padding: 0 }}>
                    <span style={{ fontSize: 12, fontFamily: "monospace", fontWeight: 700, color: "var(--accent-blue)", lineHeight: 1 }}>^{letter}</span>
                    <span style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1 }}>{desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {showCreate && (
        <CreateModal
          workspaceBase={workspaceBase}
          username={username}
          enabledTools={enabledTools}
          onClose={() => setShowCreate(false)}
          onCreate={(s) => { setShowCreate(false); setSession(s); }}
        />
      )}
      {showImport && (
        <MobileBrowseExternalPanel
          enabledTools={enabledTools}
          onClose={() => setShowImport(false)}
          onLoad={async (ext, tool) => {
            const dirName = ext.cwd.split("/").filter(Boolean).pop() || ext.cwd;
            const s = await createSession({ project: dirName, cwd: ext.cwd, resume_session_id: ext.agent_session_id, tool });
            setShowImport(false); setSession(s);
          }}
        />
      )}
    </div>
  );
}

const SESSION_HASH_RE = /^#\/s\/(.+)/;

function parseSessionHash(): string | null {
  const m = window.location.hash.match(SESSION_HASH_RE);
  return m ? m[1] : null;
}

/* ─── Top-level Mobile Page ─── */
// ────────────────────────────────────────────────────────────────────────────
// MobileSettingsPanel — bottom sheet for theme + terminal font
// ────────────────────────────────────────────────────────────────────────────
function MobileSettingsPanel({ open, onClose, theme, onToggleTheme, terminalFont, onTerminalFontChange }: {
  open: boolean; onClose: () => void;
  theme?: "dark" | "light"; onToggleTheme?: () => void;
  terminalFont?: string; onTerminalFontChange?: (font: string) => void;
}) {
  const [fontList, setFontList] = useState<FontInfo[]>([]);
  const [fontLoading, setFontLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || fontList.length > 0) return;
    setFontLoading(true);
    getSystemFonts().then(f => { setFontList(f); setFontLoading(false); }).catch(() => setFontLoading(false));
  }, [open, fontList.length]);

  if (!open) return null;

  const filtered = fontList.filter(f => !filter || f.family.toLowerCase().includes(filter.toLowerCase()));

  const applyFont = async (family: string) => {
    try {
      const c = await setTerminalFont(family);
      onTerminalFontChange?.(c.terminal_font);
      setMsg(`Set to "${family}". Reattach session to take full effect.`);
    } catch (e) { setMsg(String(e)); }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 3500, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-end" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxHeight: "85vh", background: "var(--bg-surface)", borderRadius: "12px 12px 0 0", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)" }}>⚙ Settings</span>
          <button onClick={onClose} style={{ background: "var(--bg-hover)", border: "none", color: "var(--text-secondary)", fontSize: 13, padding: "4px 12px", borderRadius: 6, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Theme */}
          {onToggleTheme && (
            <section>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-faint)", marginBottom: 8, fontWeight: 600 }}>Theme</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => { if (theme !== "dark") onToggleTheme(); }}
                  style={{ flex: 1, padding: "10px 12px", borderRadius: 8, fontSize: 13, border: `1px solid ${theme === "dark" ? "var(--accent-blue)" : "var(--border)"}`, background: theme === "dark" ? "rgba(88,166,255,0.12)" : "var(--bg-base)", color: theme === "dark" ? "var(--accent-blue)" : "var(--text-body)", cursor: "pointer" }}
                >🌙 Dark</button>
                <button
                  onClick={() => { if (theme !== "light") onToggleTheme(); }}
                  style={{ flex: 1, padding: "10px 12px", borderRadius: 8, fontSize: 13, border: `1px solid ${theme === "light" ? "var(--accent-blue)" : "var(--border)"}`, background: theme === "light" ? "rgba(88,166,255,0.12)" : "var(--bg-base)", color: theme === "light" ? "var(--accent-blue)" : "var(--text-body)", cursor: "pointer" }}
                >☀️ Light</button>
              </div>
            </section>
          )}
          {/* Terminal font */}
          <section>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-faint)", marginBottom: 8, fontWeight: 600 }}>Terminal Font</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
              Current: <code style={{ color: "var(--text-secondary)" }}>{terminalFont || "(default)"}</code>
            </div>
            <input
              placeholder="Filter fonts..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", marginBottom: 8, background: "var(--bg-base)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-body)", fontSize: 13, outline: "none" }}
            />
            <div style={{ maxHeight: "40vh", overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-base)" }}>
              {fontLoading && <div style={{ padding: 12, fontSize: 12, color: "var(--text-muted)" }}>Loading…</div>}
              {!fontLoading && filtered.length === 0 && (
                <div style={{ padding: 12, fontSize: 12, color: "var(--text-muted)" }}>No matching fonts.</div>
              )}
              {filtered.map(f => {
                const isActive = f.family === terminalFont;
                return (
                  <div
                    key={f.family}
                    onClick={() => applyFont(f.family)}
                    style={{ padding: "10px 12px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid var(--bg-hover)", background: isActive ? "rgba(88,166,255,0.1)" : "transparent", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      {f.recommended && (
                        <span style={{ fontSize: 10, padding: "1px 5px", background: "rgba(88,166,255,0.15)", color: "var(--accent-blue)", borderRadius: 3 }}>★</span>
                      )}
                      <span style={{ color: isActive ? "var(--accent-blue)" : "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.family}</span>
                    </span>
                    <span style={{ fontFamily: f.family, fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>AaBb 你好 123</span>
                  </div>
                );
              })}
            </div>
            {msg && <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)" }}>{msg}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}

const SHARE_PERMANENT = 2147483647;

function shareUserText(m: RawMessage): string {
  const c = m.message?.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) return c.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
  return "";
}

function fmtShareTime(s: number): string { return new Date(s * 1000).toLocaleString(); }
function fmtShareExpiry(s: number): string { return s >= SHARE_PERMANENT ? "永久" : fmtShareTime(s); }
function shareTypeLabel(t: ShareType): string { return t === "full" ? "全程同步" : t === "chat" ? "Chat" : "限制截止"; }
function shareAbsUrl(url: string): string { return /^https?:/i.test(url) ? url : window.location.origin + url; }

// Mobile share sheet — bottom sheet, stacked form + card-list history (no wide
// table), icon-light. Deliberately not a port of the desktop ShareModal.
function MobileSharePanel({ open, onClose, session }: { open: boolean; onClose: () => void; session: SessionMeta }) {
  const [tab, setTab] = useState<"create" | "history">("create");
  const [shareType, setShareType] = useState<ShareType>("full");
  const [defaultTheme, setDefaultTheme] = useState<ShareTheme>("light");
  const [preset, setPreset] = useState<"1d" | "7d" | "30d" | "permanent">("7d");
  const [fileAccess, setFileAccess] = useState<FileAccessSpec>({ full: [], files: [] });
  const [showFiles, setShowFiles] = useState(false);
  const [userMsgs, setUserMsgs] = useState<RawMessage[]>([]);
  const [cutoffUuid, setCutoffUuid] = useState("");
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ShareRecord | null>(null);
  const [history, setHistory] = useState<ShareRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open || shareType !== "limited" || userMsgs.length > 0 || loadingMsgs) return;
    setLoadingMsgs(true);
    getAllRawMessages(session.id)
      .then((d) => setUserMsgs(d.messages.filter((m) => m.type === "user" && shareUserText(m).length > 0)))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoadingMsgs(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shareType]);

  useEffect(() => {
    if (!open || tab !== "history") return;
    setLoadingHistory(true);
    listShares(session.id).then(setHistory).catch((e) => setErr(String(e))).finally(() => setLoadingHistory(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  if (!open) return null;

  const copy = (text: string, key: string) => {
    const done = () => { setCopied(key); setTimeout(() => setCopied((k) => (k === key ? null : k)), 1200); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done).catch(done);
    else { const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.top = "-1000px"; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch { /* ignore */ } document.body.removeChild(ta); done(); }
  };

  const create = async () => {
    setErr(null);
    if (shareType === "limited" && !cutoffUuid) { setErr("请选择截止消息"); return; }
    const permanent = preset === "permanent";
    const days = preset === "1d" ? 1 : preset === "7d" ? 7 : 30;
    setCreating(true);
    try {
      const hasFiles = fileAccess.full.length > 0 || fileAccess.files.length > 0;
      const rec = await createShare(session.id, {
        share_type: shareType,
        permanent,
        expires_at: permanent ? undefined : Math.floor(Date.now() / 1000) + days * 86400,
        cutoff_after_uuid: shareType === "limited" ? cutoffUuid : undefined,
        default_theme: defaultTheme,
        // chat shares always expose the whole project; the backend forces
        // file_access, so don't send a client value.
        file_access: shareType === "chat" ? undefined : (hasFiles ? fileAccess : undefined),
      });
      setCreated(rec);
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setCreating(false); }
  };

  const del = async (hash: string) => {
    if (!window.confirm("删除该分享链接？")) return;
    try { await deleteShare(session.id, hash); setHistory((h) => h.filter((r) => r.hash !== hash)); } catch (e) { setErr(String(e)); }
  };

  const chip = (active: boolean): React.CSSProperties => ({
    fontSize: 13, padding: "8px 12px", borderRadius: 8, cursor: "pointer", flex: "1 0 auto",
    border: `1px solid ${active ? "var(--accent-blue)" : "var(--border)"}`,
    background: active ? "rgba(88,166,255,0.12)" : "var(--bg-base)",
    color: active ? "var(--accent-blue)" : "var(--text-body)",
  });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 3500, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxHeight: "88vh", background: "var(--bg-surface)", borderRadius: "12px 12px 0 0", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)" }}>🔗 分享对话</span>
          <button onClick={onClose} style={{ background: "var(--bg-hover)", border: "none", color: "var(--text-secondary)", fontSize: 13, padding: "4px 12px", borderRadius: 6 }}>✕</button>
        </div>

        <div style={{ display: "flex", gap: 8, padding: "10px 16px 0" }}>
          {(["create", "history"] as const).map((id) => (
            <button key={id} onClick={() => setTab(id)} style={{ flex: 1, ...chip(tab === id) }}>{id === "create" ? "新建" : "历史"}</button>
          ))}
        </div>

        <div style={{ overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          {err && <div style={{ color: "var(--accent-red, #e05260)", fontSize: 12 }}>{err}</div>}

          {tab === "create" && (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => setShareType("full")} style={chip(shareType === "full")}>全程同步</button>
                <button onClick={() => setShareType("limited")} style={chip(shareType === "limited")}>限制截止</button>
                <button onClick={() => setShareType("chat")} style={chip(shareType === "chat")}>Chat</button>
              </div>
              {shareType === "chat" && (
                <div style={{ border: "1px solid #e05260", background: "rgba(224,82,96,0.10)", borderRadius: 8, padding: "10px 12px", fontSize: 12, lineHeight: 1.55, color: "#e05260" }}>
                  <div style={{ fontWeight: 700, marginBottom: 3 }}>⚠️ 高危：可对话分享</div>
                  拿到链接的人可<b>向该会话发指令</b>（Claude 可执行命令、改文件）并<b>只读全部文件</b>。仅分享给可信任的人。
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setDefaultTheme("light")} style={chip(defaultTheme === "light")}>☀️ 浅色</button>
                <button onClick={() => setDefaultTheme("dark")} style={chip(defaultTheme === "dark")}>🌙 深色</button>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {([["1d", "1天"], ["7d", "7天"], ["30d", "30天"], ["permanent", "永久"]] as const).map(([id, lbl]) => (
                  <button key={id} onClick={() => setPreset(id)} style={chip(preset === id)}>{lbl}</button>
                ))}
              </div>

              {shareType === "chat" ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>📁 Chat 自动开放整个项目（只读，排除 .git / node_modules 等），无需勾选文件。</div>
              ) : (
                <div>
                  <button
                    onClick={() => setShowFiles((v) => !v)}
                    style={{ width: "100%", textAlign: "left", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-base)", color: "var(--text-body)", fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  >
                    <span>📁 可查看的文件{fileAccess.full.length + fileAccess.files.length > 0 ? `（${fileAccess.full.length + fileAccess.files.length}）` : "（可选）"}</span>
                    <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{showFiles ? "▼" : "▶"}</span>
                  </button>
                  {showFiles && (
                    <div style={{ marginTop: 8 }}>
                      <ShareFileSelector sessionId={session.id} value={fileAccess} onChange={setFileAccess} compact />
                    </div>
                  )}
                </div>
              )}

              {shareType === "limited" && (
                <div>
                  <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 6 }}>选择截止消息</div>
                  {loadingMsgs ? <div style={{ fontSize: 12, color: "var(--text-muted)" }}>加载中…</div> : (
                    <div style={{ maxHeight: "32vh", overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
                      {userMsgs.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)", padding: 10 }}>无可选消息</div>}
                      {userMsgs.map((m) => {
                        const uuid = m.uuid || ""; const sel = uuid === cutoffUuid; const txt = shareUserText(m);
                        return (
                          <div key={uuid} onClick={() => setCutoffUuid(uuid)} title={txt}
                            style={{ padding: "8px 10px", fontSize: 12, cursor: "pointer", borderBottom: "1px solid var(--bg-hover)", background: sel ? "rgba(88,166,255,0.1)" : "transparent", color: sel ? "var(--accent-blue)" : "var(--text-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {sel ? "● " : "○ "}{txt.slice(0, 60)}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <button onClick={create} disabled={creating} style={{ padding: "11px", borderRadius: 8, border: "none", background: "var(--accent-blue)", color: "#fff", fontSize: 14, fontWeight: 600 }}>
                {creating ? "生成中…" : "生成分享链接"}
              </button>

              {created && (
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{shareTypeLabel(created.share_type)} · 失效 {fmtShareExpiry(created.expires_at)}</div>
                  <input readOnly value={shareAbsUrl(created.url)} onFocus={(e) => e.currentTarget.select()} style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", background: "var(--bg-base)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-body)", fontSize: 12, fontFamily: "monospace" }} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => copy(shareAbsUrl(created.url), "new")} style={{ flex: 1, padding: "9px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-base)", color: "var(--text-body)", fontSize: 13 }}>{copied === "new" ? "已复制" : "复制"}</button>
                    <button onClick={() => window.open(created.url, "_blank")} style={{ flex: 1, padding: "9px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-base)", color: "var(--text-body)", fontSize: 13 }}>打开</button>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "history" && (
            <>
              {loadingHistory ? <div style={{ fontSize: 12, color: "var(--text-muted)" }}>加载中…</div>
                : history.length === 0 ? <div style={{ fontSize: 12, color: "var(--text-muted)" }}>暂无分享记录</div>
                : history.map((rec) => (
                  <div key={rec.hash} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {shareTypeLabel(rec.share_type)} · 失效 {fmtShareExpiry(rec.expires_at)}
                    </div>
                    {rec.share_type === "limited" && rec.cutoff_msg_text && (
                      <div style={{ fontSize: 12, color: "var(--text-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={rec.cutoff_msg_text}>
                        截止：{rec.cutoff_msg_text.slice(0, 32)}{rec.cutoff_msg_text.length > 32 ? "…" : ""}
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: "var(--text-faint)" }}>创建 {fmtShareTime(rec.created_at)}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => copy(shareAbsUrl(rec.url), rec.hash)} style={{ flex: 1, padding: "8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-base)", color: "var(--text-body)", fontSize: 12 }}>{copied === rec.hash ? "已复制" : "复制"}</button>
                      <button onClick={() => window.open(rec.url, "_blank")} style={{ flex: 1, padding: "8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-base)", color: "var(--text-body)", fontSize: 12 }}>打开</button>
                      <button onClick={() => del(rec.hash)} style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-base)", color: "var(--accent-red, #e05260)", fontSize: 12 }}>删除</button>
                    </div>
                  </div>
                ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// AttentionKind mirrors SessionsPage's priority ordering (plan > auq > approve).
type MobileAttentionKind = "plan" | "auq" | "approve";
interface MobileAttentionItem { id: string; name: string; kind: MobileAttentionKind }

const _ATTENTION_LABEL: Record<MobileAttentionKind, string> = {
  plan: "Plan 待批准",
  auq: "待回答问题",
  approve: "待授权",
};

// MobileAttentionBanner is the cross-session jump notification: while operating
// session B, it surfaces that session A needs an answer and lets the user tap to
// jump there (rather than handling A's AUQ inline in B's page). It floats above
// the bottom of the screen in both ListView and DetailView.
function MobileAttentionBanner({ items, onJump }: { items: MobileAttentionItem[]; onJump: (id: string) => void }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, 3);
  const extra = items.length - shown.length;
  return (
    <div style={{
      position: "fixed", left: 8, right: 8, bottom: 8, zIndex: 9999,
      display: "flex", flexDirection: "column", gap: 4,
      pointerEvents: "none",
    }}>
      {shown.map((it) => (
        <button
          key={it.id}
          onClick={() => onJump(it.id)}
          style={{
            pointerEvents: "auto",
            display: "flex", alignItems: "center", gap: 8,
            width: "100%", textAlign: "left",
            padding: "10px 14px", borderRadius: 10,
            background: "color-mix(in srgb, var(--accent-orange, #d59f00) 22%, var(--bg-surface))",
            border: "1px solid color-mix(in srgb, var(--accent-orange, #d59f00) 55%, transparent)",
            color: "var(--text-default)", fontSize: 13, fontWeight: 600,
            cursor: "pointer", boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
          }}
        >
          <span>⚠️</span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {it.name} · {_ATTENTION_LABEL[it.kind]}
          </span>
          <span style={{ fontSize: 11, color: "var(--accent-orange, #d59f00)" }}>点击跳转 ›</span>
        </button>
      ))}
      {extra > 0 && (
        <div style={{
          pointerEvents: "auto", textAlign: "center", fontSize: 11,
          color: "var(--text-faint)", padding: "2px 0",
        }}>还有 {extra} 个会话需要处理</div>
      )}
    </div>
  );
}

export function MobilePage({ username, onLogout, onSwitchToAdmin, onOpenTool, theme, onToggleTheme }: { username: string; onLogout: () => void; onSwitchToAdmin?: () => void; onOpenTool?: () => void; theme?: "dark" | "light"; onToggleTheme?: () => void }) {
  const [openSession, setOpenSession] = useState<SessionMeta | null>(null);
  const [terminalFont, setTerminalFontState] = useState<string | undefined>(undefined);

  useEffect(() => {
    getConfig().then(c => setTerminalFontState(c.terminal_font || undefined)).catch(() => {});
  }, []);

  // On mount: if URL already has #/s/{id}, load that session directly
  useEffect(() => {
    const sid = parseSessionHash();
    if (!sid) return;
    getSession(sid)
      .then(s => setOpenSession(s))
      .catch(() => { history.replaceState(null, "", window.location.pathname); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep state in sync when hash changes externally (e.g. browser forward/back beyond our handlers)
  useEffect(() => {
    const onHashChange = () => {
      const sid = parseSessionHash();
      if (!sid) setOpenSession(null);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const openDetail = (s: SessionMeta) => {
    history.pushState(null, "", `#/s/${s.id}`);
    setOpenSession(s);
  };

  const closeDetail = () => {
    history.replaceState(null, "", window.location.pathname);
    setOpenSession(null);
  };

  // ── Cross-session attention banner ─────────────────────────────────────────
  // Poll all active sessions for pending plan/AUQ/approval and surface a tappable
  // jump notification for any session OTHER than the one currently open. Riding
  // the same 3s status poll means resolving on any client clears the banner here
  // (consistent with the desktop AttentionNotifier and Part B auto-clear).
  const [attention, setAttention] = useState<MobileAttentionItem[]>([]);
  const sessionNamesRef = useRef<Map<string, string>>(new Map());
  const openSessionIdRef = useRef<string | null>(null);
  useEffect(() => { openSessionIdRef.current = openSession?.id ?? null; }, [openSession]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await listSessionsStatus("active");
        if (cancelled) return;
        const pending: Array<{ id: string; kind: MobileAttentionKind }> = [];
        for (const item of res.items) {
          let kind: MobileAttentionKind | null = null;
          if (item.tui_plan_pending) kind = "plan";
          else if (item.tui_auq_data) kind = "auq";
          else if (item.tui_approve_data) kind = "approve";
          if (kind && item.id !== openSessionIdRef.current) pending.push({ id: item.id, kind });
        }
        // Resolve names; fetch the session list once if any id is unknown.
        const missing = pending.some((p) => !sessionNamesRef.current.has(p.id));
        if (missing) {
          try {
            const list = await listSessions();
            if (cancelled) return;
            for (const s of list.items) sessionNamesRef.current.set(s.id, s.name);
          } catch { /* ignore — fall back to id */ }
        }
        const next = pending.map((p) => ({
          id: p.id,
          kind: p.kind,
          name: sessionNamesRef.current.get(p.id) || p.id.slice(0, 8),
        }));
        setAttention((prev) => {
          if (prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.kind === next[i].kind)) {
            return prev;
          }
          return next;
        });
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const jumpToSession = (id: string) => {
    getSession(id).then((s) => openDetail(s)).catch(() => {});
  };

  // Re-filter at render so switching the open session hides its own banner item
  // immediately (before the next poll re-derives the list).
  const bannerItems = attention.filter((a) => a.id !== openSession?.id);

  return (
    <>
      {openSession
        // key forces a full remount when the attention banner jumps to ANOTHER
        // session while a DetailView is already open: DetailView seeds its
        // internal `session` state from the prop once on mount and never syncs
        // it afterwards, so without the key the jump changed openSession but
        // the UI stayed pinned on the old session.
        ? <DetailView key={openSession.id} session={openSession} onBack={closeDetail} username={username} onLogout={onLogout} onSwitchToAdmin={onSwitchToAdmin} theme={theme} onToggleTheme={onToggleTheme} terminalFont={terminalFont} onTerminalFontChange={setTerminalFontState} />
        : <ListView username={username} onLogout={onLogout} onOpen={openDetail} onSwitchToAdmin={onSwitchToAdmin} onOpenTool={onOpenTool} theme={theme} onToggleTheme={onToggleTheme} terminalFont={terminalFont} onTerminalFontChange={setTerminalFontState} />}
      <MobileAttentionBanner items={bannerItems} onJump={jumpToSession} />
    </>
  );
}

/* ─── Shared micro styles ─── */
const inp: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  background: "var(--bg-base)", border: "1px solid var(--border-strong)",
  borderRadius: 8, padding: "10px 12px", color: "var(--text-bright)", fontSize: 15, outline: "none",
};
const btn: React.CSSProperties = {
  border: "1px solid var(--border)", borderRadius: 8,
  padding: "10px 16px", fontSize: 14, cursor: "pointer", textAlign: "center",
};
