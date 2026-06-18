import { useEffect, useState, useCallback, useRef, Fragment } from "react";
import {
  listUsers,
  createUser,
  changePassword,
  deleteUser,
  setUserIsAdmin,
  listAllSessions,
  getConfig,
  setWorkspace,
  setClaudeBin,
  setStructuredBin,
  setProxy,
  setFileViewer,
  setUploadMaxSize,
  setDownloadMaxSize,
  setEnabledTools,
  setSkipDirs,
  setClaudeModels,
  restartServer,
  getMonitorStats,
  type UserInfo,
  type SessionMeta,
  type ProxyMode,
  type FileViewerMode,
  type MonitorStats,
} from "../api/sessionApi";
import { SessionCard } from "../components/SessionCard";
import { EmbeddedTerminalPanel, useAdminTerminalApi } from "../components/EmbeddedTerminalPanel";
import ClaudeLoginModal from "../components/ClaudeLoginModal";
import { apiPath } from "../lib/baseUrl";

const PAGE_SIZE = 30;

interface Props {
  onLogout: () => void;
  onBack?: () => void;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
}

export function AdminPage({ onLogout, onBack, theme, onToggleTheme }: Props) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "user">("user");
  const [pwUser, setPwUser] = useState("");
  const [pwValue, setPwValue] = useState("");
  const [tab, setTab] = useState<"sessions" | "users" | "config" | "terminal" | "monitoring">("config");
  const [monitor, setMonitor] = useState<MonitorStats | null>(null);
  const [monSort, setMonSort] = useState<"cpu" | "mem">("cpu");
  const [monLimit, setMonLimit] = useState(20);
  const adminTerminalApi = useAdminTerminalApi();
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [workspace, setWorkspaceVal] = useState("");
  const [workspaceInput, setWorkspaceInput] = useState("");
  const [claudeBin, setClaudeBinVal] = useState("");
  const [claudeBinInput, setClaudeBinInput] = useState("");
  const [structuredBin, setStructuredBinVal] = useState("");
  const [structuredBinInput, setStructuredBinInput] = useState("");
  const [structuredBinResolved, setStructuredBinResolved] = useState("");
  const [sdkAvailable, setSdkAvailable] = useState(false);
  const [proxy, setProxyVal] = useState("");
  const [proxyInput, setProxyInput] = useState("");
  const [proxyMode, setProxyModeVal] = useState<ProxyMode>("tap_upstream");
  const [proxyModeInput, setProxyModeInput] = useState<ProxyMode>("tap_upstream");
  // Read-only: the tap proxy's upstream (set at proxy launch, ops-level).
  const [tapUpstream, setTapUpstream] = useState("");
  const [fvMode, setFvMode] = useState<FileViewerMode>("lines");
  const [fvMaxLines, setFvMaxLines] = useState<number>(3000);
  const [fvMaxBytesMb, setFvMaxBytesMb] = useState<number>(1);
  const [fvModeSaved, setFvModeSaved] = useState<FileViewerMode>("lines");
  const [fvMaxLinesSaved, setFvMaxLinesSaved] = useState<number>(3000);
  const [fvMaxBytesMbSaved, setFvMaxBytesMbSaved] = useState<number>(1);
  const [uploadMaxMb, setUploadMaxMb] = useState<number>(8);
  const [uploadMaxMbSaved, setUploadMaxMbSaved] = useState<number>(8);
  const [downloadMaxMb, setDownloadMaxMb] = useState<number>(128);
  const [downloadMaxMbSaved, setDownloadMaxMbSaved] = useState<number>(128);
  const [enabledTools, setEnabledToolsState] = useState<string[]>(["claude"]);
  const [enabledToolsSaved, setEnabledToolsSaved] = useState<string[]>(["claude"]);
  const [skipDirsInput, setSkipDirsInput] = useState("");
  const [skipDirsSaved, setSkipDirsSaved] = useState("");
  const [claudeModelsInput, setClaudeModelsInput] = useState("");
  const [claudeModelsSaved, setClaudeModelsSaved] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [restarting, setRestarting] = useState(false);

  const handleRestart = async () => {
    if (!window.confirm("Restart server? All current connections will be disconnected.")) return;
    setRestarting(true);
    try { await restartServer(); } catch { /* server may disconnect before responding */ }
    const poll = setInterval(async () => {
      try { const r = await fetch(apiPath("/health")); if (r.ok) { clearInterval(poll); setRestarting(false); } } catch {}
    }, 1500);
    setTimeout(() => { clearInterval(poll); setRestarting(false); }, 30000);
  };

  const refreshUsers = useCallback(async () => {
    try {
      setUsers(await listUsers());
    } catch {}
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      const c = await getConfig();
      setWorkspaceVal(c.workspace);
      setWorkspaceInput(c.workspace);
      setClaudeBinVal(c.claude_bin);
      setClaudeBinInput(c.claude_bin);
      setStructuredBinVal(c.structured_bin);
      setStructuredBinInput(c.structured_bin);
      setStructuredBinResolved(c.structured_bin_resolved);
      setSdkAvailable(c.sdk_available);
      setProxyVal(c.proxy);
      setProxyInput(c.proxy);
      setProxyModeVal(c.proxy_mode);
      setProxyModeInput(c.proxy_mode);
      setTapUpstream(c.tap_upstream);
      setFvMode(c.file_viewer_mode);
      setFvModeSaved(c.file_viewer_mode);
      setFvMaxLines(c.file_viewer_max_lines);
      setFvMaxLinesSaved(c.file_viewer_max_lines);
      const mb = Math.max(0.1, Math.round((c.file_viewer_max_bytes / (1024 * 1024)) * 100) / 100);
      setFvMaxBytesMb(mb);
      setFvMaxBytesMbSaved(mb);
      const upMb = Math.max(0.01, Math.round((c.upload_max_size / (1024 * 1024)) * 100) / 100);
      setUploadMaxMb(upMb);
      setUploadMaxMbSaved(upMb);
      const dlMb = Math.max(0.01, Math.round((c.download_max_size / (1024 * 1024)) * 100) / 100);
      setDownloadMaxMb(dlMb);
      setDownloadMaxMbSaved(dlMb);
      setEnabledToolsState(c.enabled_tools);
      setEnabledToolsSaved(c.enabled_tools);
      const sd = c.skip_dirs.join(", ");
      setSkipDirsInput(sd);
      setSkipDirsSaved(sd);
      const cm = c.claude_models.join(", ");
      setClaudeModelsInput(cm);
      setClaudeModelsSaved(cm);
    } catch {}
  }, []);

  const parseSkipDirs = (raw: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tok of raw.split(/[\s,]+/)) {
      const name = tok.trim();
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) continue;
      if (!seen.has(name)) { seen.add(name); out.push(name); }
    }
    return out;
  };

  // Model ids/aliases may contain hyphens (e.g. claude-opus-4-8), so unlike
  // parseSkipDirs we only split on commas/whitespace and trim — no path filtering.
  const parseClaudeModels = (raw: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tok of raw.split(/[\s,]+/)) {
      const id = tok.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id); out.push(id);
    }
    return out;
  };

  const searchRef2 = useRef(search);
  searchRef2.current = search;

  const refreshSessions = useCallback(async (q?: string) => {
    try {
      const res = await listAllSessions(q || undefined);
      setSessions(res.items);
    } catch {}
  }, []);

  useEffect(() => {
    refreshUsers();
    refreshConfig();
    let id: ReturnType<typeof setInterval>;
    const start = () => {
      refreshSessions(searchRef2.current);
      id = setInterval(() => refreshSessions(searchRef2.current), 5000);
    };
    const stop = () => clearInterval(id);
    const onVis = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [refreshUsers, refreshSessions]);

  // Monitoring poll — only while the Monitor tab is active, so /proc isn't
  // sampled when nobody is looking. Pauses when the tab is backgrounded.
  // Re-runs (and re-fetches immediately) when the sort key or row limit change.
  useEffect(() => {
    if (tab !== "monitoring") return;
    let id: ReturnType<typeof setInterval>;
    const tick = () => getMonitorStats(monSort, monLimit).then(setMonitor).catch(() => {});
    const start = () => { tick(); id = setInterval(tick, 2500); };
    const stop = () => clearInterval(id);
    const onVis = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [tab, monSort, monLimit]);

  // Debounced search
  useEffect(() => {
    setPage(0);
    const timer = setTimeout(() => refreshSessions(search), 300);
    return () => clearTimeout(timer);
  }, [search, refreshSessions]);

  const totalPages = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = sessions.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE
  );

  const handleCreateUser = async () => {
    if (!newUsername || !newPassword) return;
    try {
      await createUser(newUsername, newPassword, newRole);
      setNewUsername("");
      setNewPassword("");
      setMsg(`User "${newUsername}" created`);
      await refreshUsers();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const handleChangePassword = async () => {
    if (!pwUser || !pwValue) return;
    try {
      await changePassword(pwUser, pwValue);
      setPwUser("");
      setPwValue("");
      setMsg(`Password updated for "${pwUser}"`);
    } catch (e) {
      setMsg(String(e));
    }
  };

  const handleDeleteUser = async (username: string) => {
    if (!confirm(`Delete user "${username}"?`)) return;
    try {
      await deleteUser(username);
      setMsg(`User "${username}" deleted`);
      await refreshUsers();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const handleToggleIsAdmin = async (u: UserInfo) => {
    try {
      const updated = await setUserIsAdmin(u.username, !u.is_admin);
      setUsers((prev) => prev.map((x) => x.username === u.username ? updated : x));
      setMsg(`"${u.username}" is_admin → ${updated.is_admin}`);
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <div
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--bg-sidebar)",
      }}
    >
      {/* header */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--bg-hover)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 15, whiteSpace: "nowrap" }}>Admin Panel</h2>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <TabBtn active={tab === "config"} label="Config" onClick={() => setTab("config")} />
            <TabBtn active={tab === "users"} label={`Users (${users.length})`} onClick={() => setTab("users")} />
            <TabBtn active={tab === "sessions"} label={`Sessions (${sessions.length})`} onClick={() => setTab("sessions")} />
            <TabBtn active={tab === "terminal"} label="Terminal" onClick={() => setTab("terminal")} />
            <TabBtn active={tab === "monitoring"} label="Monitor" onClick={() => setTab("monitoring")} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {onBack && (
            <button
              onClick={onBack}
              style={{ background: "var(--bg-hover)", color: "var(--accent-blue)", fontSize: 12, padding: "5px 12px", border: "1px solid var(--text-faintest)", borderRadius: 4 }}
            >
              ← Sessions
            </button>
          )}
          <button
            onClick={handleRestart}
            disabled={restarting}
            style={{ background: restarting ? "var(--bg-hover)" : "#4c1d95", color: restarting ? "var(--text-muted)" : "#c4b5fd", fontSize: 12, padding: "5px 12px", border: "1px solid #6d28d9", borderRadius: 4, cursor: restarting ? "not-allowed" : "pointer" }}
          >
            {restarting ? "Restarting…" : "⟳ Restart"}
          </button>
          <button
            onClick={onToggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            style={{
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "4px 8px",
              cursor: "pointer",
              fontSize: 14,
              color: "var(--text-muted)",
              marginRight: 8,
            }}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button
            onClick={onLogout}
            style={{ background: "var(--bg-hover)", color: "var(--text-body)", fontSize: 12, padding: "5px 12px" }}
          >
            Logout
          </button>
        </div>
      </div>

      {msg && (
        <div
          style={{
            padding: "8px 16px",
            background: "#1e3a5f",
            fontSize: 13,
            display: "flex",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          {msg}
          <button onClick={() => setMsg("")} style={{ background: "transparent", color: "#cce5ff", padding: "2px 8px", fontSize: 11 }}>
            x
          </button>
        </div>
      )}

      {/* body */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {tab === "sessions" && (
          <div style={{ padding: "12px 16px" }}>
            <input
              placeholder="Search by owner, project, cwd, session ID, prompt..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ ...inputStyle, width: "100%", marginBottom: 12, boxSizing: "border-box" }}
            />
            <div style={{ columns: "minmax(260px, 1fr)", columnGap: 10 }}>
              {pageItems.map((s) => (
                <SessionCard key={s.id} session={s} showOwner />
              ))}
            </div>
            {sessions.length === 0 && (
              <p style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", marginTop: 40 }}>
                {search ? "No matching sessions." : "No sessions."}
              </p>
            )}
            {totalPages > 1 && (
              <div style={{ marginTop: 12, display: "flex", justifyContent: "center", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-secondary)" }}>
                <PgBtn disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} label="Prev" />
                <span>{safePage + 1}/{totalPages} ({sessions.length} total)</span>
                <PgBtn disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => p + 1)} label="Next" />
              </div>
            )}
          </div>
        )}

        {tab === "config" && (
          <div style={{ padding: "12px 16px", maxWidth: 600 }}>
            {/* Workspace */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Workspace Base Directory</h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                Users can only create sessions under <code style={{ color: "var(--text-secondary)" }}>{workspace}/{"<uid>"}/</code>.
                This value is saved to config.yaml.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={workspaceInput}
                  onChange={(e) => setWorkspaceInput(e.target.value)}
                  placeholder="~/Projs"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  disabled={!workspaceInput.trim() || workspaceInput.trim() === workspace}
                  onClick={async () => {
                    try {
                      const c = await setWorkspace(workspaceInput.trim());
                      setWorkspaceVal(c.workspace);
                      setMsg("Workspace updated.");
                    } catch (e) { setMsg(String(e)); }
                  }}
                  style={{ background: "#58a6ff", color: "#fff" }}
                >
                  Save
                </button>
              </div>
            </div>

            {/* Claude Binary */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Claude Binary Path</h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                Path to the <code style={{ color: "var(--text-secondary)" }}>claude</code> CLI binary.
                If an absolute path is given, its directory is prepended to PATH in each session.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={claudeBinInput}
                  onChange={(e) => setClaudeBinInput(e.target.value)}
                  placeholder="~/.local/bin/claude"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  disabled={!claudeBinInput.trim() || claudeBinInput.trim() === claudeBin}
                  onClick={async () => {
                    try {
                      const c = await setClaudeBin(claudeBinInput.trim());
                      setClaudeBinVal(c.claude_bin);
                      setMsg("Claude binary path updated. Restart the server to apply.");
                    } catch (e) { setMsg(String(e)); }
                  }}
                  style={{ background: "#58a6ff", color: "#fff" }}
                >
                  Save
                </button>
              </div>
            </div>

            {/* claude-structured wrapper (SDK transport) */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 4, fontSize: 15 }}>
                SDK Transport Binary (claude-structured)
                <span
                  style={{
                    marginLeft: 10, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10,
                    background: sdkAvailable ? "#13240f" : "#241010",
                    color: sdkAvailable ? "#86efac" : "#fca5a5",
                    border: `1px solid ${sdkAvailable ? "#166534" : "#7f1d1d"}`,
                  }}
                >
                  {sdkAvailable ? "可用" : "不可用"}
                </span>
              </h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                <code style={{ color: "var(--text-secondary)" }}>claude-structured</code> wrapper 的路径，
                供 SDK transport 会话使用。留空则使用默认（服务端二进制同目录）。
                文件不存在或不可执行时，创建会话的 SDK 选项不可用。
                <br />当前解析路径：<code style={{ color: "var(--text-secondary)" }}>{structuredBinResolved || "(unknown)"}</code>
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={structuredBinInput}
                  onChange={(e) => setStructuredBinInput(e.target.value)}
                  placeholder={structuredBinResolved || "默认：服务端二进制同目录/claude-structured"}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  disabled={structuredBinInput.trim() === structuredBin}
                  onClick={async () => {
                    try {
                      const c = await setStructuredBin(structuredBinInput.trim());
                      setStructuredBinVal(c.structured_bin);
                      setStructuredBinResolved(c.structured_bin_resolved);
                      setSdkAvailable(c.sdk_available);
                      setMsg(c.sdk_available
                        ? "SDK wrapper 路径已更新，立即生效。"
                        : "已保存，但该路径下没有可执行的 claude-structured —— SDK transport 暂不可用。");
                    } catch (e) { setMsg(String(e)); }
                  }}
                  style={{ background: "#58a6ff", color: "#fff" }}
                >
                  Save
                </button>
              </div>
            </div>

            {/* Claude Login (assisted) */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Claude 登录 (assisted)</h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                通过 Web 驱动 <code style={{ color: "var(--text-secondary)" }}>claude /login</code> OAuth 流程，
                更新所有 session 共享的登录凭据。当 token 过期、session 报错时使用。
              </p>
              <button
                onClick={() => setLoginModalOpen(true)}
                style={{ background: "#58a6ff", color: "#fff" }}
              >
                打开登录
              </button>
            </div>

            {/* Proxy */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Proxy Settings</h3>

              {/* Mode — decides which path requests take */}
              <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>
                Mode <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>— 决定请求走哪条路径</span>
              </label>
              <select
                value={proxyModeInput}
                onChange={(e) => setProxyModeInput(e.target.value as ProxyMode)}
                style={{ ...inputStyle, width: "100%", cursor: "pointer", marginBottom: 6 }}
              >
                <option value="tap_upstream">Tap upstream — 走本地录制代理 (recording ON)</option>
                <option value="real">Real proxy — 直连，绕过录制 (recording OFF)</option>
              </select>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 14px" }}>
                <b>Tap upstream</b>: Claude CLI → 本地 19098 (录制 SSE) → <i>Tap 上游代理</i> → api.anthropic.com<br />
                <b>Real proxy</b>: Claude CLI → <i>会话代理</i> (HTTPS_PROXY) → api.anthropic.com（绕过 19098，不录制）
              </p>

              {/* Config 1 — Tap upstream (read-only, ops-level) */}
              <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>
                Tap 上游代理 <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>(只读)</span>
              </label>
              <input
                value={tapUpstream || "(直连 api.anthropic.com)"}
                readOnly
                disabled
                style={{ ...inputStyle, width: "100%", marginBottom: 4, opacity: 0.7, cursor: "not-allowed" }}
              />
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 14px" }}>
                本地录制代理 (127.0.0.1:19098) 访问外网的出口，仅 <b>Tap upstream</b> 模式生效。
                在 proxy 启动时通过 <code>PROXY_UPSTREAM</code> (restart.sh) / <code>--upstream-proxy</code> 设置，
                留空 = 直连。此处不可编辑（运维级配置）。
              </p>

              {/* Config 2 — session http_proxy (editable, DB-backed) */}
              <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>
                会话代理 (http_proxy)
              </label>
              <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                <input
                  value={proxyInput}
                  onChange={(e) => setProxyInput(e.target.value)}
                  placeholder="http://proxy:port（留空 = 不注入）"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  disabled={proxyInput === proxy && proxyModeInput === proxyMode}
                  onClick={async () => {
                    try {
                      const c = await setProxy(proxyInput.trim(), proxyModeInput);
                      setProxyVal(c.proxy);
                      setProxyModeVal(c.proxy_mode);
                      setMsg("Proxy settings updated. New Claude sessions will use the new mode.");
                    } catch (e) { setMsg(String(e)); }
                  }}
                  style={{ background: "#58a6ff", color: "#fff" }}
                >
                  Save
                </button>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
                注入到会话进程的 <code>http_proxy</code>/<code>https_proxy</code>。
                <b>Real</b> 模式下作为 Claude CLI 直连 anthropic 的代理；
                <b>Tap</b> 模式下仅覆盖会话的非 Anthropic 流量（Anthropic 走上面的 Tap 路径）。
                Save 同时保存 Mode 与此地址。
              </p>
            </div>

            {/* File Viewer */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>File Viewer</h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                Cap how much of a file the Code pane returns. Pick <b>unlimited</b> for no truncation,
                <b> lines</b> to cap by line count, or <b>size</b> to cap by file size (in MB).
              </p>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  value={fvMode}
                  onChange={(e) => setFvMode(e.target.value as FileViewerMode)}
                  style={{ ...inputStyle, width: 180, cursor: "pointer" }}
                >
                  <option value="unlimited">Unlimited (no cap)</option>
                  <option value="lines">Limit by lines</option>
                  <option value="bytes">Limit by size</option>
                </select>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: fvMode === "lines" ? "var(--text-bright)" : "var(--text-faint)" }}>
                  Lines:
                  <input
                    type="number"
                    min={100}
                    max={1000000}
                    step={100}
                    value={fvMaxLines}
                    onChange={(e) => setFvMaxLines(Math.max(100, Number(e.target.value) || 0))}
                    disabled={fvMode !== "lines"}
                    style={{ ...inputStyle, width: 110 }}
                  />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: fvMode === "bytes" ? "var(--text-bright)" : "var(--text-faint)" }}>
                  Size (MB):
                  <input
                    type="number"
                    min={0.01}
                    max={1024}
                    step={0.5}
                    value={fvMaxBytesMb}
                    onChange={(e) => setFvMaxBytesMb(Math.max(0.01, Number(e.target.value) || 0))}
                    disabled={fvMode !== "bytes"}
                    style={{ ...inputStyle, width: 110 }}
                  />
                </label>
                <button
                  disabled={
                    fvMode === fvModeSaved &&
                    fvMaxLines === fvMaxLinesSaved &&
                    fvMaxBytesMb === fvMaxBytesMbSaved
                  }
                  onClick={async () => {
                    try {
                      const bytes = Math.max(4096, Math.round(fvMaxBytesMb * 1024 * 1024));
                      const c = await setFileViewer(fvMode, fvMaxLines, bytes);
                      setFvModeSaved(c.file_viewer_mode);
                      setFvMaxLinesSaved(c.file_viewer_max_lines);
                      const mb = Math.round((c.file_viewer_max_bytes / (1024 * 1024)) * 100) / 100;
                      setFvMaxBytesMbSaved(mb);
                      setFvMaxBytesMb(mb);
                      setMsg("File viewer limit updated.");
                    } catch (e) { setMsg(String(e)); }
                  }}
                  style={{ background: "#58a6ff", color: "#fff" }}
                >
                  Save
                </button>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
                Lines mode minimum: 100. Size mode minimum: 4 KB. Unlimited returns the entire file
                — beware of OOM on multi-GB files.
              </p>
            </div>

            {/* Transfer limits (upload / download size caps) */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Transfer Limits</h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                Size caps for the FILES panel. <b>Upload</b> is enforced per file; <b>Download</b>
                caps single-file and folder-zip downloads. Set independently (in MB).
              </p>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-bright)" }}>
                  Upload (MB):
                  <input
                    type="number"
                    min={0.01}
                    max={102400}
                    step={1}
                    value={uploadMaxMb}
                    onChange={(e) => setUploadMaxMb(Math.max(0.01, Number(e.target.value) || 0))}
                    style={{ ...inputStyle, width: 110 }}
                  />
                </label>
                <button
                  disabled={uploadMaxMb === uploadMaxMbSaved}
                  onClick={async () => {
                    try {
                      const c = await setUploadMaxSize(Math.max(4096, Math.round(uploadMaxMb * 1024 * 1024)));
                      const mb = Math.round((c.upload_max_size / (1024 * 1024)) * 100) / 100;
                      setUploadMaxMb(mb);
                      setUploadMaxMbSaved(mb);
                      setMsg("Upload limit updated.");
                    } catch (e) { setMsg(String(e)); }
                  }}
                  style={{ background: "#58a6ff", color: "#fff" }}
                >
                  Save
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-bright)" }}>
                  Download (MB):
                  <input
                    type="number"
                    min={0.01}
                    max={102400}
                    step={1}
                    value={downloadMaxMb}
                    onChange={(e) => setDownloadMaxMb(Math.max(0.01, Number(e.target.value) || 0))}
                    style={{ ...inputStyle, width: 110 }}
                  />
                </label>
                <button
                  disabled={downloadMaxMb === downloadMaxMbSaved}
                  onClick={async () => {
                    try {
                      const c = await setDownloadMaxSize(Math.max(4096, Math.round(downloadMaxMb * 1024 * 1024)));
                      const mb = Math.round((c.download_max_size / (1024 * 1024)) * 100) / 100;
                      setDownloadMaxMb(mb);
                      setDownloadMaxMbSaved(mb);
                      setMsg("Download limit updated.");
                    } catch (e) { setMsg(String(e)); }
                  }}
                  style={{ background: "#58a6ff", color: "#fff" }}
                >
                  Save
                </button>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
                Minimum 4 KB each. Defaults: upload 8 MB, download 128 MB. Media playback streams
                separately and is not affected by the download cap.
              </p>
            </div>

            {/* Enabled coding tools */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Enabled Coding Tools</h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                Which coding agents are available to users. Sessions whose tool is disabled are
                hidden from the session list and from new-session / load-session pickers.
                <code style={{ color: "var(--text-secondary)" }}> claude</code> is the default.
              </p>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 8 }}>
                {(["claude", "codex", "cursor"] as const).map((t) => {
                  const checked = enabledTools.includes(t);
                  return (
                    <label key={t} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-body)", cursor: "pointer", userSelect: "none" }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setEnabledToolsState((prev) => {
                            const set = new Set(prev);
                            if (set.has(t)) set.delete(t); else set.add(t);
                            return ["claude", "codex", "cursor"].filter((x) => set.has(x));
                          });
                        }}
                      />
                      <span style={{ textTransform: "capitalize" }}>{t}</span>
                    </label>
                  );
                })}
                <button
                  disabled={
                    enabledTools.length === 0 ||
                    (enabledTools.length === enabledToolsSaved.length &&
                      enabledTools.every((t, i) => t === enabledToolsSaved[i]))
                  }
                  onClick={async () => {
                    try {
                      const c = await setEnabledTools(enabledTools);
                      setEnabledToolsSaved(c.enabled_tools);
                      setEnabledToolsState(c.enabled_tools);
                      setMsg("Enabled tools updated.");
                    } catch (e) { setMsg(String(e)); }
                  }}
                  style={{ background: "#58a6ff", color: "#fff", marginLeft: "auto" }}
                >
                  Save
                </button>
              </div>
              {enabledTools.length === 0 && (
                <p style={{ fontSize: 11, color: "var(--accent-red)", margin: 0 }}>
                  At least one tool must remain enabled.
                </p>
              )}
            </div>

            {/* Directory scan blacklist */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Directory Scan Blacklist</h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                Directory names skipped entirely when listing, searching, or sharing files — their
                contents are never scanned. Useful for large dependency/cache folders like
                <code style={{ color: "var(--text-secondary)" }}> node_modules</code>. Bare names
                only (no paths), separated by commas or spaces. Leave empty to disable.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input
                  value={skipDirsInput}
                  onChange={(e) => setSkipDirsInput(e.target.value)}
                  placeholder="node_modules, venv, .venv"
                  style={{ ...inputStyle, flex: 1, minWidth: 240 }}
                />
                <button
                  disabled={parseSkipDirs(skipDirsInput).join(", ") === skipDirsSaved}
                  onClick={async () => {
                    try {
                      const c = await setSkipDirs(parseSkipDirs(skipDirsInput));
                      const sd = c.skip_dirs.join(", ");
                      setSkipDirsSaved(sd);
                      setSkipDirsInput(sd);
                      setMsg("Directory blacklist updated.");
                    } catch (e) { setMsg(String(e)); }
                  }}
                  style={{ background: "#58a6ff", color: "#fff" }}
                >
                  Save
                </button>
              </div>
            </div>

            {/* Claude model picker list */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Claude Models</h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                Entries shown in the session model picker, passed verbatim to
                <code style={{ color: "var(--text-secondary)" }}> claude --model</code>. Aliases like
                <code style={{ color: "var(--text-secondary)" }}> default sonnet haiku opus</code> always
                resolve to the latest model, so they never go stale; full ids
                (<code style={{ color: "var(--text-secondary)" }}>claude-opus-4-8</code>) also work.
                Separated by commas or spaces. Leave empty to restore the defaults.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input
                  value={claudeModelsInput}
                  onChange={(e) => setClaudeModelsInput(e.target.value)}
                  placeholder="default, sonnet, haiku, opus"
                  style={{ ...inputStyle, flex: 1, minWidth: 240 }}
                />
                <button
                  disabled={parseClaudeModels(claudeModelsInput).join(", ") === claudeModelsSaved}
                  onClick={async () => {
                    try {
                      const c = await setClaudeModels(parseClaudeModels(claudeModelsInput));
                      const cm = c.claude_models.join(", ");
                      setClaudeModelsSaved(cm);
                      setClaudeModelsInput(cm);
                      setMsg("Claude models updated.");
                    } catch (e) { setMsg(String(e)); }
                  }}
                  style={{ background: "#58a6ff", color: "#fff" }}
                >
                  Save
                </button>
              </div>
            </div>

          </div>
        )}

        {tab === "users" && (
          <div style={{ padding: "12px 16px", maxWidth: 700 }}>
            {/* Create User */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Create User</h3>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input placeholder="Username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} style={inputStyle} />
                <input type="password" placeholder="Password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} />
                <select value={newRole} onChange={(e) => setNewRole(e.target.value as "admin" | "user")} style={{ ...inputStyle, cursor: "pointer", width: "auto" }}>
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
                <button onClick={handleCreateUser} disabled={!newUsername || !newPassword} style={{ background: "#5cb85c", color: "#fff" }}>
                  Create
                </button>
              </div>
            </div>

            {/* Change Password */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Change Password</h3>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select value={pwUser} onChange={(e) => setPwUser(e.target.value)} style={{ ...inputStyle, cursor: "pointer", width: "auto" }}>
                  <option value="">-- select user --</option>
                  {users.map((u) => <option key={u.username} value={u.username}>{u.username}</option>)}
                </select>
                <input type="password" placeholder="New password" value={pwValue} onChange={(e) => setPwValue(e.target.value)} style={inputStyle} />
                <button onClick={handleChangePassword} disabled={!pwUser || !pwValue} style={{ background: "#f0ad4e", color: "#fff" }}>
                  Update
                </button>
              </div>
            </div>

            {/* User List */}
            <div style={cardStyle}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Users</h3>
              <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                    <th style={{ padding: "6px 10px" }}>Username</th>
                    <th style={{ padding: "6px 10px" }}>Role</th>
                    <th style={{ padding: "6px 10px" }}>is_admin</th>
                    <th style={{ padding: "6px 10px" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.username} style={{ borderTop: "1px solid var(--bg-hover)" }}>
                      <td style={{ padding: "8px 10px" }}>{u.username}</td>
                      <td style={{ padding: "8px 10px" }}>
                        <span style={{ color: u.role === "admin" ? "#f0ad4e" : "#5bc0de", fontWeight: 600 }}>
                          {u.role}
                        </span>
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        <button
                          onClick={() => handleToggleIsAdmin(u)}
                          title="Toggle admin panel access"
                          style={{
                            background: u.is_admin ? "#4c1d95" : "var(--bg-hover)",
                            color: u.is_admin ? "#c4b5fd" : "var(--text-muted)",
                            fontSize: 11,
                            padding: "3px 10px",
                            border: `1px solid ${u.is_admin ? "#6d28d9" : "var(--text-faintest)"}`,
                            borderRadius: 4,
                            cursor: "pointer",
                          }}
                        >
                          {u.is_admin ? "✓ on" : "off"}
                        </button>
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        <button
                          onClick={() => handleDeleteUser(u.username)}
                          style={{ background: "#d9534f", color: "#fff", fontSize: 11, padding: "3px 10px" }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "terminal" && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--bg-hover)", fontSize: 12, color: "var(--text-muted)" }}>
              Run background tasks / scripts here. Save (💾) the current terminal to give it a name and prevent auto-close. Same lifecycle as session terminals: ephemerals auto-close after idle; running child processes keep the terminal alive.
            </div>
            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
              <EmbeddedTerminalPanel
                instanceKey="__admin__"
                api={adminTerminalApi}
                cwd={workspace || "/"}
                theme={theme ?? "dark"}
                open={true}
                onOpenChange={() => {}}
                height={0}
                onHeightChange={() => {}}
                fill
                emptyHint="Loading admin terminal…"
              />
            </div>
          </div>
        )}

        {tab === "monitoring" && (
          <MonitorTab
            stats={monitor}
            sort={monSort}
            limit={monLimit}
            onSortChange={setMonSort}
            onLimitChange={setMonLimit}
          />
        )}
      </div>

      <ClaudeLoginModal open={loginModalOpen} onClose={() => setLoginModalOpen(false)} />
    </div>
  );
}

function TabBtn({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ background: active ? "var(--accent-blue)" : "var(--text-faintest)", color: "#fff", fontSize: 12, padding: "4px 10px" }}>
      {label}
    </button>
  );
}

function PgBtn({ disabled, onClick, label }: { disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button disabled={disabled} onClick={onClick} style={{ background: "var(--text-faintest)", color: "var(--text-body)", fontSize: 11, padding: "4px 10px" }}>
      {label}
    </button>
  );
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + " GiB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(0) + " MiB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KiB";
  return n + " B";
}

// barColor: green under 60%, amber 60–85%, red above.
function barColor(pct: number): string {
  if (pct >= 85) return "var(--accent-red)";
  if (pct >= 60) return "var(--accent-amber)";
  return "var(--accent-green)";
}

function StatCard({ label, value, sub, pct }: { label: string; value: string; sub?: string; pct?: number }) {
  return (
    <div style={{ flex: "1 1 160px", minWidth: 160, padding: 14, background: "var(--bg-modal)", borderRadius: 8, border: "1px solid var(--border-subtle)" }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: "var(--text-bright)", fontFamily: "monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{sub}</div>}
      {pct !== undefined && (
        <div style={{ marginTop: 8, height: 4, borderRadius: 2, background: "var(--bg-hover)", overflow: "hidden" }}>
          <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: barColor(pct) }} />
        </div>
      )}
    </div>
  );
}

const MON_LIMITS = [10, 20, 50, 100, 200];

function MonitorTab({ stats, sort, limit, onSortChange, onLimitChange }: {
  stats: MonitorStats | null;
  sort: "cpu" | "mem";
  limit: number;
  onSortChange: (s: "cpu" | "mem") => void;
  onLimitChange: (n: number) => void;
}) {
  // Tapped/clicked process whose full command line is expanded inline. Works as
  // the touch equivalent of the desktop hover tooltip (title attr).
  const [expanded, setExpanded] = useState<number | null>(null);

  const o = stats?.overall;
  const thCol: React.CSSProperties = { textAlign: "right", padding: "6px 10px", color: "var(--text-muted)", fontWeight: 500, whiteSpace: "nowrap" };
  const tdNum: React.CSSProperties = { textAlign: "right", padding: "5px 10px", fontFamily: "monospace", color: "var(--text-body)", whiteSpace: "nowrap" };
  const sortBtn = (key: "cpu" | "mem"): React.CSSProperties => ({
    background: sort === key ? "var(--accent-blue)" : "var(--bg-hover)",
    color: sort === key ? "#fff" : "var(--text-body)",
    fontSize: 12, padding: "4px 12px", borderRadius: 6, border: "none", cursor: "pointer",
  });

  return (
    <div style={{ padding: 16, overflow: "auto" }}>
      {o && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
          <StatCard label="CPU (whole machine)" value={o.cpu_percent.toFixed(1) + "%"} sub={`${o.num_cpu} cores`} pct={o.cpu_percent} />
          <StatCard label="Memory" value={o.mem_percent.toFixed(1) + "%"} sub={`${fmtBytes(o.mem_used)} / ${fmtBytes(o.mem_total)}`} pct={o.mem_percent} />
          <StatCard label="Load average" value={o.load1.toFixed(2)} sub={`5m ${o.load5.toFixed(2)} · 15m ${o.load15.toFixed(2)}`} />
        </div>
      )}

      {/* Controls: sort key + row count */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Sort by</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={sortBtn("cpu")} onClick={() => onSortChange("cpu")}>CPU</button>
          <button style={sortBtn("mem")} onClick={() => onSortChange("mem")}>Memory</button>
        </div>
        <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 8 }}>Show</span>
        <select
          value={limit}
          onChange={(e) => onLimitChange(Number(e.target.value))}
          style={{ background: "var(--bg-base)", color: "var(--text-body)", border: "1px solid var(--text-faintest)", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}
        >
          {MON_LIMITS.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {!stats || !stats.ready ? (
        <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
          {stats ? "Warming up… (collecting first CPU sample)" : "Loading…"}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
            Top {stats.processes.length} processes by {sort === "mem" ? "memory" : "CPU"}.
            CPU% is per-core (100% = 1 core; this host has {o?.num_cpu}). Tap a row for the full command.
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ ...thCol, textAlign: "right", width: 72 }}>PID</th>
                <th style={{ ...thCol, textAlign: "left" }}>Command</th>
                <th style={{ ...thCol, width: 90 }}>CPU%</th>
                <th style={{ ...thCol, width: 80 }}>Mem%</th>
                <th style={{ ...thCol, width: 100 }}>RSS</th>
              </tr>
            </thead>
            <tbody>
              {stats.processes.map((p) => {
                const isOpen = expanded === p.pid;
                return (
                  <Fragment key={p.pid}>
                    <tr
                      title={p.cmdline}
                      onClick={() => setExpanded(isOpen ? null : p.pid)}
                      style={{ borderBottom: isOpen ? "none" : "1px solid var(--border-subtle)", cursor: "pointer" }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <td style={tdNum}>{p.pid}</td>
                      <td style={{ padding: "5px 10px", fontFamily: "monospace", color: "var(--text-bright)", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ color: "var(--text-faint)", marginRight: 6 }}>{isOpen ? "▾" : "▸"}</span>{p.comm}
                      </td>
                      <td style={{ ...tdNum, color: p.cpu_percent >= 50 ? "var(--accent-amber)" : "var(--text-body)" }}>{p.cpu_percent.toFixed(1)}</td>
                      <td style={tdNum}>{p.mem_percent.toFixed(1)}</td>
                      <td style={tdNum}>{fmtBytes(p.rss_bytes)}</td>
                    </tr>
                    {isOpen && (
                      <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                        <td colSpan={5} style={{ padding: "2px 10px 8px 34px", background: "var(--bg-base)" }}>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>Full command</div>
                          <code style={{ fontSize: 12, color: "var(--text-body)", wordBreak: "break-all", whiteSpace: "pre-wrap", display: "block" }}>{p.cmdline || "(unavailable)"}</code>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-base)",
  border: "1px solid var(--text-faintest)",
  borderRadius: 6,
  padding: "8px 12px",
  color: "var(--text-body)",
  fontSize: 13,
  outline: "none",
};

const cardStyle: React.CSSProperties = {
  padding: 16,
  background: "var(--bg-modal)",
  borderRadius: 8,
  marginBottom: 16,
};
