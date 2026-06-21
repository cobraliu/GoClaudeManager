import { apiPath } from "../lib/baseUrl";

export interface ScheduledTask {
  id: string;
  command: string;
  run_at: string;
  status: string;
  created_at: string;
  loop_seconds?: number | null;
}

export interface SessionMeta {
  id: string;
  owner_id: string;
  name: string;
  project: string;
  cwd: string;
  status: string;
  created_at: string;
  attached_clients: number;
  model: string | null;
  resume_session_id: string | null;
  agent_session_id: string | null;
  claude_title: string | null;
  prompts: string[];
  last_user_input_at?: string | null;
  has_new_output: boolean;
  is_streaming: boolean;
  scheduled_tasks: ScheduledTask[];
  git_auto_commit: boolean;
  git_repo_url: string | null;
  tool: "claude" | "cursor" | "codex";
  codex_transport?: "tui" | "app_server";
  /** How the server drives a claude session: tmux send-keys (default) or the
   *  claude-structured SDK wrapper over json-in/json-out. */
  transport?: "tmux" | "sdk";
}

export interface SessionListResponse {
  items: SessionMeta[];
  total: number;
}

export interface AttachResponse {
  session_id: string;
  ws_token: string;
  ws_url: string;
  status: string;
}

export interface LoginResponse {
  token: string;
  username: string;
  role: "admin" | "user";
  is_admin: boolean;
}

export interface UserInfo {
  username: string;
  role: "admin" | "user";
  is_admin: boolean;
}

function getToken(): string {
  return localStorage.getItem("token") || "";
}

async function request<T>(
  path: string,
  init?: RequestInit,
  skipAuth?: boolean
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (!skipAuth) {
    const token = getToken();
    if (!token) {
      throw new Error("not logged in");
    }
    headers["Authorization"] = `Bearer ${token}`;
  }
  const resp = await fetch(apiPath(path), { ...init, headers });
  if (resp.status === 401 && !skipAuth) {
    localStorage.removeItem("token");
    localStorage.removeItem("username");
    localStorage.removeItem("role");
    window.location.reload();
    throw new Error("unauthorized");
  }
  if (!resp.ok) {
    const text = await resp.text();
    let msg = text;
    try {
      const j = JSON.parse(text);
      if (typeof j?.detail === "string") msg = j.detail;
      else if (Array.isArray(j?.detail)) msg = j.detail.map((d: { msg?: string }) => d?.msg).filter(Boolean).join("; ") || text;
    } catch { /* not JSON, use raw text */ }
    throw new Error(msg || `HTTP ${resp.status}`);
  }
  if (resp.status === 204) return undefined as unknown as T;
  return resp.json();
}

// AskUserQuestion structured answer
export interface AuqAnswerItem {
  option_idx: number | null;
  option_indices: number[] | null;
  n_options: number;
  custom_text: string | null;
  is_multi: boolean;
}

export function answerAuq(
  sessionId: string,
  answers: AuqAnswerItem[],
  submitConfirmIdx?: number,
): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${sessionId}/answer-auq`, {
    method: "POST",
    body: JSON.stringify({
      answers,
      submit_confirm_idx: submitConfirmIdx ?? null,
    }),
  });
}

export function submitAuqAnswers(
  sessionId: string,
  answers: unknown[],
  questions: object[],
  singleShot = false,
): Promise<{ ok: boolean; via?: string }> {
  return request(`/api/sessions/${sessionId}/auq/submit`, {
    method: "POST",
    body: JSON.stringify({ answers, questions, single_shot: singleShot }),
  });
}

export interface PromptHistoryEntry {
  id: number;
  text: string;
  sent_at: number;
  pane: string | null;
}

export interface PromptHistoryPage {
  entries: PromptHistoryEntry[];
  total: number;
}

export function getPromptHistory(
  sessionId: string,
  opts: { limit?: number; offset?: number; query?: string } = {},
): Promise<PromptHistoryPage> {
  const { limit = 20, offset = 0, query } = opts;
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (query && query.trim()) qs.set("q", query.trim());
  return request(
    `/api/sessions/${sessionId}/prompt-history?${qs.toString()}`,
  );
}

export function deletePromptHistoryEntry(
  sessionId: string,
  entryId: number,
): Promise<void> {
  return request(
    `/api/sessions/${sessionId}/prompt-history/${entryId}`,
    { method: "DELETE" },
  );
}

export function rewindSession(
  sessionId: string,
  messageUuid: string,
): Promise<{ ok: boolean; restored_files: string[]; kept_lines: number }> {
  return request(`/api/sessions/${sessionId}/rewind`, {
    method: "POST",
    body: JSON.stringify({ message_uuid: messageUuid }),
  });
}

// Auth
export function login(
  username: string,
  password: string
): Promise<LoginResponse> {
  return request(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ username, password }) },
    true
  );
}

export function getGoogleClientId(): Promise<{ client_id: string }> {
  return request("/api/auth/google-client-id", {}, true);
}

export function loginWithGoogle(credential: string): Promise<LoginResponse> {
  return request(
    "/api/auth/google",
    { method: "POST", body: JSON.stringify({ credential }) },
    true
  );
}

export function listUsers(): Promise<UserInfo[]> {
  return request("/api/auth/users");
}

export function createUser(
  username: string,
  password: string,
  role: "admin" | "user"
): Promise<UserInfo> {
  return request("/api/auth/users", {
    method: "POST",
    body: JSON.stringify({ username, password, role }),
  });
}

export function changePassword(
  username: string,
  password: string
): Promise<void> {
  return request(`/api/auth/users/${username}/password`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
}

export function deleteUser(username: string): Promise<void> {
  return request(`/api/auth/users/${username}`, { method: "DELETE" });
}

export function setUserIsAdmin(username: string, is_admin: boolean): Promise<UserInfo> {
  return request(`/api/auth/users/${username}/is_admin`, {
    method: "PUT",
    body: JSON.stringify({ is_admin }),
  });
}

// Config
export type ProxyMode = "tap_upstream" | "real";

export type FileViewerMode = "unlimited" | "lines" | "bytes";

export interface ConfigView {
  workspace: string;
  claude_bin: string;
  /** claude-structured wrapper path as configured ("" = default next to the server binary). */
  structured_bin: string;
  /** The wrapper path actually used (configured value, or the default). */
  structured_bin_resolved: string;
  /** Whether the resolved wrapper exists and is executable → SDK transport available. */
  sdk_available: boolean;
  cursor_bin: string;
  proxy: string;
  proxy_mode: ProxyMode;
  /** Read-only: the tap proxy's upstream, set at proxy launch (PROXY_UPSTREAM /
   *  --upstream-proxy). Empty = the tap connects directly to api.anthropic.com. */
  tap_upstream: string;
  terminal_font: string;
  term_idle_grace_seconds: number;
  term_standby_grace_seconds: number;
  file_viewer_mode: FileViewerMode;
  file_viewer_max_lines: number;
  file_viewer_max_bytes: number;
  /** Per-file upload size cap in bytes (admin-configurable; default 8MB). */
  upload_max_size: number;
  /** Single-file/zip download size cap in bytes (admin-configurable; default 128MB). */
  download_max_size: number;
  enabled_tools: string[];
  skip_dirs: string[];
  claude_models: string[];
}

export interface FontInfo {
  family: string;
  recommended: boolean;
}

export function getSystemFonts(): Promise<FontInfo[]> {
  return request("/api/config/fonts");
}

export function setTerminalFont(font: string): Promise<ConfigView> {
  return request("/api/config/terminal-font", {
    method: "PUT",
    body: JSON.stringify({ font }),
  });
}

export function getConfig(): Promise<ConfigView> {
  return request("/api/config");
}

export function setWorkspace(workspace: string): Promise<ConfigView> {
  return request("/api/config/workspace", {
    method: "PUT",
    body: JSON.stringify({ workspace }),
  });
}

export function setClaudeBin(claude_bin: string): Promise<ConfigView> {
  return request("/api/config/claude-bin", {
    method: "PUT",
    body: JSON.stringify({ claude_bin }),
  });
}

export function setStructuredBin(structured_bin: string): Promise<ConfigView> {
  return request("/api/config/structured-bin", {
    method: "PUT",
    body: JSON.stringify({ structured_bin }),
  });
}

export function setCursorBin(cursor_bin: string): Promise<ConfigView> {
  return request("/api/config/cursor-bin", {
    method: "PUT",
    body: JSON.stringify({ cursor_bin }),
  });
}

export function setProxy(
  proxy: string,
  proxy_mode: ProxyMode = "tap_upstream",
): Promise<ConfigView> {
  return request("/api/config/proxy", {
    method: "PUT",
    body: JSON.stringify({ proxy, proxy_mode }),
  });
}

export function setTermLifecycle(
  idle_grace_seconds: number,
  standby_grace_seconds: number,
): Promise<ConfigView> {
  return request("/api/config/term-lifecycle", {
    method: "PUT",
    body: JSON.stringify({ idle_grace_seconds, standby_grace_seconds }),
  });
}

export function setFileViewer(
  mode: FileViewerMode,
  max_lines: number,
  max_bytes: number,
): Promise<ConfigView> {
  return request("/api/config/file-viewer", {
    method: "PUT",
    body: JSON.stringify({ mode, max_lines, max_bytes }),
  });
}

export function setUploadMaxSize(upload_max_size: number): Promise<ConfigView> {
  return request("/api/config/upload-max-size", {
    method: "PUT",
    body: JSON.stringify({ upload_max_size }),
  });
}

export function setDownloadMaxSize(download_max_size: number): Promise<ConfigView> {
  return request("/api/config/download-max-size", {
    method: "PUT",
    body: JSON.stringify({ download_max_size }),
  });
}

export function restartServer(): Promise<void> {
  return request("/api/config/restart", { method: "POST" });
}

export function setEnabledTools(tools: string[]): Promise<ConfigView> {
  return request("/api/config/enabled-tools", {
    method: "PUT",
    body: JSON.stringify({ tools }),
  });
}

export function setSkipDirs(skip_dirs: string[]): Promise<ConfigView> {
  return request("/api/config/skip-dirs", {
    method: "PUT",
    body: JSON.stringify({ skip_dirs }),
  });
}

export function setClaudeModels(models: string[]): Promise<ConfigView> {
  return request("/api/config/claude-models", {
    method: "PUT",
    body: JSON.stringify({ models }),
  });
}

export function getAvailableTools(): Promise<{ claude: boolean; cursor: boolean; claude_sdk?: boolean }> {
  return request("/api/config/available-tools");
}

// Filesystem
export function listDirs(path: string): Promise<string[]> {
  return request(`/api/fs/dirs?path=${encodeURIComponent(path)}`);
}

// Sessions
export function listSessions(q?: string): Promise<SessionListResponse> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return request(`/api/sessions${qs}`);
}

export function getSession(sessionId: string): Promise<SessionMeta> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function listAllSessions(q?: string): Promise<SessionListResponse> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return request(`/api/sessions/all${qs}`);
}

export interface TuiAuqData {
  // Screen-parsed format
  question?: string;
  header?: string;
  multiSelect?: boolean;
  allowFreeform?: boolean;
  options?: { label: string; description?: string }[];
  // Hook format (raw tool_input)
  questions?: Array<{
    question: string;
    options?: Array<string | { label?: string; value?: string; description?: string; preview?: string }>;
    multiSelect?: boolean;
    header?: string;
  }>;
}

export interface TuiApproveData {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface TuiPlanOption {
  index: number;
  label: string;
  highlighted: boolean;
}

export interface TuiPlanData {
  options?: TuiPlanOption[];
  highlighted?: number;
}

export interface SessionStatusItem {
  id: string;
  status: string;
  attached_clients: number;
  has_new_output: boolean;
  is_streaming: boolean;
  is_compacting?: boolean;
  compacting_progress?: string | null;
  scheduled_tasks: ScheduledTask[];
  tui_hint?: string | null;
  tui_auq_data?: TuiAuqData | null;
  tui_approve_data?: TuiApproveData | null;
  tui_plan_pending?: boolean;
  tui_plan_data?: TuiPlanData | null;
  lost_messages?: LostMessage[];
}

// LostMessage is a "send failed" indicator synced server-side so it shows on,
// and can be dismissed from, every connected client (not just the sender tab).
// Mirrors model.LostMessage. Ephemeral: the server keeps these in memory only.
export interface LostMessage {
  id: string;
  text: string;
  sent_at: number;
  created_at: number;
}

// registerLostMessage records a detected send failure server-side so the bubble
// appears on all clients via the next status poll. Returns the (possibly
// deduped) LostMessage.
export function registerLostMessage(
  sessionId: string,
  body: { text: string; sentAt: number },
): Promise<LostMessage> {
  return request(`/api/sessions/${sessionId}/lost-messages`, {
    method: "POST",
    body: JSON.stringify({ text: body.text, sent_at: body.sentAt }),
  });
}

// dismissLostMessage removes a single lost message by id (manual dismiss);
// clears on all clients next poll.
export function dismissLostMessage(sessionId: string, lostId: string): Promise<void> {
  return request(`/api/sessions/${sessionId}/lost-messages/${encodeURIComponent(lostId)}`, {
    method: "DELETE",
  });
}

export function approveToolRequest(sessionId: string, decision: "allow" | "deny"): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${sessionId}/tool-approve`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
}

// PlanDecision drives the ExitPlanMode menu. Prefer an explicit option (label is
// matched against the live screen; index is the 0-based fallback) so the UI can
// pick any real menu item; decision is the legacy approve/reject intent fallback.
export interface PlanDecision {
  label?: string;
  index?: number;
  decision?: "approve" | "reject";
  // Text typed into the "Tell Claude what to change" field before submitting.
  // Ignored for any other option.
  feedback?: string;
}

export function approvePlan(
  sessionId: string,
  choice: "approve" | "reject" | PlanDecision,
): Promise<{ ok: boolean; chosen?: string }> {
  const body: PlanDecision = typeof choice === "string" ? { decision: choice } : choice;
  return request(`/api/sessions/${sessionId}/plan-approve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface SessionStatusListResponse {
  items: SessionStatusItem[];
  total: number;
}

export function listSessionsStatus(scope: "all" | "active" = "all"): Promise<SessionStatusListResponse> {
  const q = scope === "active" ? "?scope=active" : "";
  return request(`/api/sessions/status${q}`);
}


export function createSession(body: {
  project: string;
  cwd?: string;
  model?: string;
  resume_session_id?: string;
  git_repo_url?: string;
  tool?: "claude" | "cursor" | "codex";
  codex_transport?: "tui" | "app_server";
  transport?: "tmux" | "sdk";
}): Promise<SessionMeta> {
  return request("/api/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function sendCodexMessage(sessionId: string, text: string): Promise<{ ok: boolean; result?: unknown }> {
  return request(`/api/sessions/${sessionId}/codex-message`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function resolveCodexAuq(
  sessionId: string,
  answers: Record<string, string[]>,
): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${sessionId}/codex-auq`, {
    method: "POST",
    body: JSON.stringify({ answers }),
  });
}

export function resolveCodexApproval(
  sessionId: string,
  allow: boolean,
  feedback?: string | null
): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${sessionId}/codex-approve`, {
    method: "POST",
    body: JSON.stringify({ allow, feedback: feedback ?? null }),
  });
}

export function attachSession(sessionId: string): Promise<AttachResponse> {
  return request(`/api/sessions/${sessionId}/attach`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function detachSession(sessionId: string): Promise<void> {
  return request(`/api/sessions/${sessionId}/detach`, { method: "POST" });
}

export function terminateSession(sessionId: string): Promise<void> {
  return request(`/api/sessions/${sessionId}/terminate`, { method: "POST" });
}

export function resumeSession(sessionId: string): Promise<SessionMeta> {
  return request(`/api/sessions/${sessionId}/resume`, { method: "POST" });
}

export interface AvailableClaudeSession {
  agent_session_id: string;
  mtime: number;
  title: string | null;
}

export function listAvailableClaudeSessions(sessionId: string): Promise<AvailableClaudeSession[]> {
  return request(`/api/sessions/${sessionId}/available-claude-sessions`);
}

export function setClaudeSessionId(sessionId: string, agentSessionId: string): Promise<void> {
  return request(`/api/sessions/${sessionId}/claude-session-id`, {
    method: "PUT",
    body: JSON.stringify({ agent_session_id: agentSessionId }),
  });
}

export interface SearchResult {
  line: number;
  text: string;
  context: string;
}

export function searchSession(
  sessionId: string,
  q: string
): Promise<SearchResult[]> {
  return request(`/api/sessions/${sessionId}/search?q=${encodeURIComponent(q)}`);
}

export function deleteSession(sessionId: string): Promise<void> {
  return request(`/api/sessions/${sessionId}`, { method: "DELETE" });
}

export function renameSession(sessionId: string, name: string): Promise<SessionMeta> {
  return request(`/api/sessions/${sessionId}/name`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

// File browser
export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number | null;
  is_text: boolean;
  is_skipped: boolean;
  is_sqlite: boolean;
  is_archive: boolean;
}

export function searchFiles(
  sessionId: string,
  q: string,
  hidden?: boolean,
): Promise<{ entries: FileEntry[]; path: string }> {
  const params = new URLSearchParams({ q });
  if (hidden) params.set("hidden", "true");
  return request(`/api/sessions/${sessionId}/fs/search?${params.toString()}`);
}

export function listFiles(
  sessionId: string,
  path?: string,
  hidden?: boolean,
): Promise<{ entries: FileEntry[]; path: string }> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (hidden) params.set("hidden", "true");
  const qs = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/sessions/${sessionId}/fs/list${qs}`);
}

// dirStat returns the mtime (Unix nanoseconds) of each given directory WITHOUT
// reading its contents — a cheap change probe for the file tree. Omitted paths
// are gone/non-dirs. The file tree polls this for its expanded directories and
// only re-fetches the full listing for ones whose mtime changed.
export function dirStat(
  sessionId: string,
  paths: string[],
): Promise<{ stats: Record<string, number> }> {
  return request(`/api/sessions/${sessionId}/fs/dirstat`, {
    method: "POST",
    body: JSON.stringify({ paths }),
  });
}

export interface SqliteInfo {
  tables: string[];
  columns: string[];
  rows: unknown[][];
  total: number;
  path: string;
}

export function sqliteQuery(
  sessionId: string,
  path: string,
  table?: string,
  limit = 100,
  offset = 0,
): Promise<SqliteInfo> {
  const params = new URLSearchParams({ path });
  if (table) params.set("table", table);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return request(`/api/sessions/${sessionId}/fs/sqlite?${params.toString()}`);
}

export interface SqliteExecResult {
  columns: string[];
  rows: unknown[][];
  affected: number;
  message: string;
}

export function sqliteExec(
  sessionId: string,
  path: string,
  sql: string,
): Promise<SqliteExecResult> {
  return request(`/api/sessions/${sessionId}/fs/sqlite/exec`, {
    method: "POST",
    body: JSON.stringify({ path, sql }),
  });
}

export function readFile(
  sessionId: string,
  path: string
): Promise<{ path: string; content: string }> {
  return request(
    `/api/sessions/${sessionId}/fs/read?path=${encodeURIComponent(path)}`
  );
}

// Direct streaming URL for inline <video>/<audio> playback. The fs/media route
// is served outside RequireUser and authenticates this query token itself
// (media tags can't send an Authorization header). http.ServeContent gives
// Range/seeking + browser caching, so this is a plain URL, not a blob.
export function mediaFileUrl(sessionId: string, path: string): string {
  const token = localStorage.getItem("token") || "";
  return apiPath(`/api/sessions/${sessionId}/fs/media?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`);
}

export async function fetchRawFileBlob(
  sessionId: string,
  path: string
): Promise<string> {
  const token = localStorage.getItem("token") || "";
  const resp = await fetch(
    apiPath(`/api/sessions/${sessionId}/fs/raw?path=${encodeURIComponent(path)}`),
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

export async function downloadFile(sessionId: string, path: string): Promise<void> {
  const token = localStorage.getItem("token") || "";
  const resp = await fetch(
    apiPath(`/api/sessions/${sessionId}/fs/raw?path=${encodeURIComponent(path)}&download=true`),
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (resp.status === 401) { localStorage.removeItem("token"); window.location.reload(); throw new Error("unauthorized"); }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() || "download";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Upload one or more files to `dirPath` (relative to the session cwd). Each
 * file is sent as a `file` part with a parallel `relpath` part; pass
 * `webkitRelativePath` in `relpaths` to recreate a folder's structure on the
 * server, or omit it to drop every file directly into `dirPath`.
 */
export async function uploadFiles(
  sessionId: string,
  dirPath: string,
  files: File[],
  relpaths?: string[],
): Promise<void> {
  const token = localStorage.getItem("token") || "";
  const form = new FormData();
  form.append("path", dirPath);
  files.forEach((file, i) => {
    form.append("file", file);
    form.append("relpath", relpaths?.[i] || file.name);
  });
  const resp = await fetch(apiPath(`/api/sessions/${sessionId}/fs/upload`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (resp.status === 401) { localStorage.removeItem("token"); window.location.reload(); throw new Error("unauthorized"); }
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 413) throw new Error(text || "file too large");
    throw new Error(text || `HTTP ${resp.status}`);
  }
}

export function uploadFile(
  sessionId: string,
  dirPath: string,
  file: File
): Promise<void> {
  return uploadFiles(sessionId, dirPath, [file]);
}

export interface UploadedAttachment {
  /** Absolute path on the server; gets injected as `@<path>` into the prompt. */
  path: string;
  /** Original filename from the upload (display only). */
  filename: string;
  /** Stored filename (uuid + ext); used to reconstruct the serve URL. */
  stored_name: string;
  size: number;
  /** True for png/jpg/jpeg/gif/webp; drives thumbnail rendering. */
  is_image: boolean;
  /** Relative API path for <img src> — only present when is_image; caller appends `?token=<jwt>`. */
  url?: string;
}

export async function uploadAttachment(
  sessionId: string,
  file: File
): Promise<UploadedAttachment> {
  const token = localStorage.getItem("token") || "";
  const form = new FormData();
  form.append("file", file);
  const resp = await fetch(apiPath(`/api/sessions/${sessionId}/upload-attachment`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (resp.status === 401) { localStorage.removeItem("token"); window.location.reload(); throw new Error("unauthorized"); }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `HTTP ${resp.status}`);
  }
  return (await resp.json()) as UploadedAttachment;
}

// parseJsonlFile uploads an arbitrary JSONL transcript and returns it parsed
// into the same {messages, total} shape the session /raw-messages endpoint
// produces — for the standalone "JSONL → Chat" viewer tool. Not tied to any
// session; the backend parses a throwaway temp copy and discards it.
export async function parseJsonlFile(
  file: File,
): Promise<{ messages: RawMessage[]; total: number }> {
  const token = localStorage.getItem("token") || "";
  const form = new FormData();
  form.append("file", file);
  const resp = await fetch(apiPath(`/api/tools/jsonl-parse`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (resp.status === 401) { localStorage.removeItem("token"); window.location.reload(); throw new Error("unauthorized"); }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `HTTP ${resp.status}`);
  }
  return (await resp.json()) as { messages: RawMessage[]; total: number };
}

export interface DirInfoItem {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
}

export interface DirInfoResponse {
  total_size: number;
  items: DirInfoItem[];
}

export function getDirInfo(
  sessionId: string,
  path: string,
  withSizes = true,
): Promise<DirInfoResponse> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (!withSizes) params.set("with_sizes", "false");
  const qs = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/sessions/${sessionId}/fs/dir-info${qs}`);
}

async function _triggerZipDownload(resp: Response, fallbackName: string): Promise<void> {
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const cd = resp.headers.get("Content-Disposition") || "";
  const match = cd.match(/filename="([^"]+)"/);
  a.download = match ? match[1] : fallbackName + ".zip";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadDirZip(sessionId: string, path: string, exclude: string[] = [], compress = true): Promise<void> {
  const token = localStorage.getItem("token") || "";
  const resp = await fetch(apiPath(`/api/sessions/${sessionId}/fs/download-zip`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, exclude, compress }),
  });
  if (resp.status === 401) { localStorage.removeItem("token"); window.location.reload(); throw new Error("unauthorized"); }
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); msg = j.detail || msg; } catch { msg = await resp.text().catch(() => msg); }
    throw new Error(msg);
  }
  await _triggerZipDownload(resp, path.split("/").pop() || "workspace");
}

export function createDir(sessionId: string, path: string): Promise<void> {
  return request(`/api/sessions/${sessionId}/fs/mkdir`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export function renameEntry(
  sessionId: string,
  path: string,
  newName: string,
): Promise<void> {
  return request(`/api/sessions/${sessionId}/fs/rename`, {
    method: "POST",
    body: JSON.stringify({ path, new_name: newName }),
  });
}

export function moveEntry(
  sessionId: string,
  path: string,
  destDir: string,
): Promise<void> {
  return request(`/api/sessions/${sessionId}/fs/move`, {
    method: "POST",
    body: JSON.stringify({ path, dest_dir: destDir }),
  });
}

export function deleteEntry(
  sessionId: string,
  path: string,
  recursive = false,
): Promise<void> {
  return request(`/api/sessions/${sessionId}/fs/delete`, {
    method: "POST",
    body: JSON.stringify({ path, recursive }),
  });
}

export interface ArchiveListResult {
  entries: string[];
  total: number;
}

export function listArchive(
  sessionId: string,
  path: string,
): Promise<ArchiveListResult> {
  return request(`/api/sessions/${sessionId}/fs/archive-list?path=${encodeURIComponent(path)}`);
}

export interface ExtractResult {
  output_dir: string;
}

export function extractArchive(
  sessionId: string,
  path: string,
): Promise<ExtractResult> {
  return request(`/api/sessions/${sessionId}/fs/extract`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function extractToDir(targetDir: string, file: File): Promise<{ path: string }> {
  const token = localStorage.getItem("token") || "";
  const form = new FormData();
  form.append("target_dir", targetDir);
  form.append("file", file);
  const resp = await fetch(apiPath("/api/fs/extract-to"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (resp.status === 401) { localStorage.removeItem("token"); window.location.reload(); throw new Error("unauthorized"); }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export class FileWriteConflictError extends Error {
  current_mtime: number | null;
  expected_mtime: number | null;
  constructor(currentMtime: number | null, expectedMtime: number | null, message?: string) {
    super(message || "file was modified externally since editing began");
    this.current_mtime = currentMtime;
    this.expected_mtime = expectedMtime;
  }
}

export async function writeFile(
  sessionId: string,
  path: string,
  content: string,
  opts?: { expectedMtime?: number | null; force?: boolean },
): Promise<{ mtime: number | null }> {
  const token = getToken();
  const resp = await fetch(apiPath(`/api/sessions/${sessionId}/fs/write`), {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      path,
      content,
      expected_mtime: opts?.expectedMtime ?? null,
      force: !!opts?.force,
    }),
  });
  if (resp.status === 401) {
    localStorage.removeItem("token");
    window.location.reload();
    throw new Error("unauthorized");
  }
  if (resp.status === 409) {
    const body = await resp.json().catch(() => ({}));
    const d = body?.detail;
    if (d && typeof d === "object") {
      throw new FileWriteConflictError(d.current_mtime ?? null, d.expected_mtime ?? null, d.message);
    }
    throw new FileWriteConflictError(null, null);
  }
  if (!resp.ok) {
    const text = await resp.text();
    let msg = text;
    try {
      const j = JSON.parse(text);
      if (typeof j?.detail === "string") msg = j.detail;
    } catch { /* */ }
    throw new Error(msg || `HTTP ${resp.status}`);
  }
  const out = await resp.json().catch(() => ({}));
  return { mtime: out?.mtime ?? null };
}

// Scheduled Tasks
export function createTask(
  sessionId: string,
  command: string,
  delay_seconds: number,
  loop_seconds?: number | null,
): Promise<ScheduledTask> {
  return request(`/api/sessions/${sessionId}/tasks`, {
    method: "POST",
    body: JSON.stringify({ command, delay_seconds, loop_seconds: loop_seconds ?? null }),
  });
}

export function cancelTask(sessionId: string, taskId: string): Promise<void> {
  return request(`/api/sessions/${sessionId}/tasks/${taskId}`, { method: "DELETE" });
}

export function listTasks(sessionId: string): Promise<ScheduledTask[]> {
  return request(`/api/sessions/${sessionId}/tasks`);
}

// /goal history
export interface Goal {
  condition: string;
  set_at: number;
  met: boolean;
  met_at: number | null;
  last_reason: string | null;
  checks: number;
  replaced: boolean;
}
export interface GoalsResponse {
  active: Goal | null;
  history: Goal[];
}
export function listGoals(sessionId: string): Promise<GoalsResponse> {
  return request(`/api/sessions/${sessionId}/goals`);
}

// AUQ history
export interface AuqQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string; preview?: string }>;
}
export interface AuqEntry {
  tool_use_id: string;
  ts: number;
  answered_ts: number | null;
  questions: AuqQuestion[];
  answers: Record<string, string> | null;
}
export function listSessionAuqs(sessionId: string): Promise<AuqEntry[]> {
  return request(`/api/sessions/${sessionId}/auqs`);
}

export interface TodoItem {
  id?: string;
  content: string;
  description?: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

export interface TodoPlan {
  todos: TodoItem[];
  created_ts: number;
  completed_ts: number;
}

export interface TodoPlansResponse {
  active: TodoItem[];
  history: TodoPlan[];
}

export function listSessionTodos(sessionId: string): Promise<TodoPlansResponse> {
  return request(`/api/sessions/${sessionId}/todos`);
}

// Active-only todos + goal, combined into one request for the high-frequency
// bottom-toolbar poll. History is fetched separately (listSessionTodos/listGoals)
// only when a dock section is open.
export interface StatusBarResponse {
  todos_active: TodoItem[];
  goal_active: Goal | null;
}
export function getStatusBar(sessionId: string): Promise<StatusBarResponse> {
  return request(`/api/sessions/${sessionId}/status-bar`);
}

export function openShell(sessionId: string): Promise<AttachResponse> {
  return request(`/api/sessions/${sessionId}/shell`, { method: "POST", body: JSON.stringify({}) });
}

// ── Bash terminals (tmux-backed) ────────────────────────────────────────────

export interface TerminalInfo {
  term_id: string;
  session_id: string;
  name: string | null;
  cwd: string;
  is_named: boolean;
  attach_count: number;
  created_at: number;
  kept?: boolean;
}

export interface TerminalHeartbeatResponse {
  term_id: string;
  is_named: boolean;
  kept: boolean;
  attach_count: number;
}

export interface CreateTerminalResponse {
  term_id: string;
  name: string | null;
  is_named: boolean;
  ws_token: string;
  ws_url: string;
}

export interface IssueTerminalTokenResponse {
  term_id: string;
  ws_token: string;
  ws_url: string;
  name?: string | null;
  is_named?: boolean;
  kept?: boolean;
}

export function listTerminals(sessionId: string): Promise<{ items: TerminalInfo[] }> {
  return request(`/api/sessions/${sessionId}/terminals`);
}

export function createTerminal(
  sessionId: string,
  opts: { name?: string | null; cwd?: string } = {},
): Promise<CreateTerminalResponse> {
  return request(`/api/sessions/${sessionId}/terminals`, {
    method: "POST",
    body: JSON.stringify({ name: opts.name ?? null, cwd: opts.cwd ?? null }),
  });
}

export function issueTerminalToken(
  sessionId: string,
  termId: string,
): Promise<IssueTerminalTokenResponse> {
  return request(`/api/sessions/${sessionId}/terminals/${termId}/token`, { method: "POST" });
}

export function renameTerminal(
  sessionId: string,
  termId: string,
  name: string | null,
): Promise<TerminalInfo> {
  return request(`/api/sessions/${sessionId}/terminals/${termId}/rename`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function deleteTerminal(sessionId: string, termId: string): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${sessionId}/terminals/${termId}`, { method: "DELETE" });
}

/** Refresh "still alive" timestamp for a cached ephemeral terminal.
 *  Throws if the terminal has been swept (HTTP 410) — caller should treat
 *  that as "cached term_id is stale; spawn a fresh one." */
export function heartbeatTerminal(
  sessionId: string,
  termId: string,
): Promise<TerminalHeartbeatResponse> {
  return request(`/api/sessions/${sessionId}/terminals/${termId}/heartbeat`, { method: "POST" });
}

// Admin-scoped terminals (not tied to a session). Identical lifecycle to
// session terminals — same TerminalManager, same idle/standby/kept rules,
// same active-child detection. Just a different URL prefix + admin auth.
export function listAdminTerminals(): Promise<{ items: TerminalInfo[] }> {
  return request(`/api/admin/terminals`);
}

export function createAdminTerminal(
  opts: { name?: string | null; cwd: string },
): Promise<CreateTerminalResponse> {
  return request(`/api/admin/terminals`, {
    method: "POST",
    body: JSON.stringify({ name: opts.name ?? null, cwd: opts.cwd }),
  });
}

export function issueAdminTerminalToken(termId: string): Promise<IssueTerminalTokenResponse> {
  return request(`/api/admin/terminals/${termId}/token`, { method: "POST" });
}

export function renameAdminTerminal(termId: string, name: string | null): Promise<TerminalInfo> {
  return request(`/api/admin/terminals/${termId}/rename`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function deleteAdminTerminal(termId: string): Promise<{ ok: boolean }> {
  return request(`/api/admin/terminals/${termId}`, { method: "DELETE" });
}

export function heartbeatAdminTerminal(termId: string): Promise<TerminalHeartbeatResponse> {
  return request(`/api/admin/terminals/${termId}/heartbeat`, { method: "POST" });
}

// Assisted Claude CLI login (/login OAuth, admin-only)
export type ClaudeLoginState =
  | "idle"
  | "starting"
  | "awaiting_code"
  | "success"
  | "error";

export interface ClaudeLoginStatus {
  state: ClaudeLoginState;
  url?: string;
  message?: string;
  screen?: string;
}

export function startClaudeLogin(): Promise<ClaudeLoginStatus> {
  return request(`/api/admin/claude-login/start`, { method: "POST" });
}

export function claudeLoginStatus(): Promise<ClaudeLoginStatus> {
  return request(`/api/admin/claude-login/status`);
}

export function submitClaudeLoginCode(code: string): Promise<ClaudeLoginStatus> {
  return request(`/api/admin/claude-login/code`, {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export function cancelClaudeLogin(): Promise<{ ok: boolean }> {
  return request(`/api/admin/claude-login/cancel`, { method: "POST" });
}

// Git
export interface GitLogEntry {
  hash: string;
  short_hash: string;
  subject: string;
  author: string;
  date: string;
  context?: string; // only present in deep-search results
}

export interface GitInfo {
  is_repo: boolean;
  log: GitLogEntry[];  // full history, pagination done client-side
  gitignore: string;
  remote: string;
}

// ── Shadow-git rewind system ──────────────────────────────────────────────────
export interface RewindPoint {
  hash: string;
  short_hash: string;
  subject: string;
  body: string;
  ts: number;       // unix seconds
  prompt: string;   // best-effort user prompt for this point
  session: string;  // session id that produced it
}

export interface ShadowRestoreResult {
  ok: boolean;
  restored_from: string; // the rewind point that was restored
  new_hash: string;      // new point capturing the restored state
  before_hash: string;   // point capturing the pre-restore state (use to "go back")
}

export interface ShadowFileChange {
  status: string;
  path: string;
}

export interface ShadowPreview {
  hash: string;
  files: ShadowFileChange[];
  diff: string;
}

export interface GitDiffFile {
  path: string;
  old_content: string;
  new_content: string;
}

export interface GitDiffResult {
  files: GitDiffFile[];
  old_hash: string;
  new_hash: string;
}

export function getGitInfo(sessionId: string): Promise<GitInfo> {
  return request(`/api/sessions/${sessionId}/git`);
}

export function searchGitCommits(sessionId: string, q: string): Promise<GitLogEntry[]> {
  return request(`/api/sessions/${sessionId}/git/search?q=${encodeURIComponent(q)}`);
}

export function gitInit(sessionId: string): Promise<{ output: string }> {
  return request(`/api/sessions/${sessionId}/git/init`, { method: "POST" });
}

export function gitManualCommit(sessionId: string, message: string): Promise<{ committed: boolean; output: string }> {
  return request(`/api/sessions/${sessionId}/git/commit`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export function shadowLog(sessionId: string, limit = 200): Promise<{ branch: string; points: RewindPoint[] }> {
  return request(`/api/sessions/${sessionId}/shadow/log?limit=${limit}`);
}

export function shadowShow(sessionId: string, hash: string): Promise<{ hash: string; message: string; files: { status: string; path: string }[] }> {
  return request(`/api/sessions/${sessionId}/shadow/show/${hash}`);
}

export interface ShadowCommitDetail {
  hash: string;
  message: string;
  files: GitDiffFile[]; // per-file old/new content, for the side-by-side diff modal
}

export function shadowCommitDetail(sessionId: string, hash: string): Promise<ShadowCommitDetail> {
  return request(`/api/sessions/${sessionId}/shadow/commit/${hash}`);
}

export function shadowDiff(sessionId: string, hash: string, path?: string): Promise<{ diff: string; hash: string }> {
  const q = path ? `&path=${encodeURIComponent(path)}` : "";
  return request(`/api/sessions/${sessionId}/shadow/diff?hash=${hash}${q}`);
}

export function shadowRestorePreview(sessionId: string, hash: string): Promise<ShadowPreview> {
  return request(`/api/sessions/${sessionId}/shadow/restore-preview?hash=${hash}`);
}

export function shadowRestore(sessionId: string, hash: string): Promise<ShadowRestoreResult> {
  return request(`/api/sessions/${sessionId}/shadow/restore`, {
    method: "POST",
    body: JSON.stringify({ hash }),
  });
}

export function shadowSnapshot(sessionId: string): Promise<{ committed: boolean; hash: string; branch: string }> {
  return request(`/api/sessions/${sessionId}/shadow/snapshot`, { method: "POST" });
}

export function gitRollback(sessionId: string, commit_hash: string): Promise<{ output: string }> {
  return request(`/api/sessions/${sessionId}/git/rollback`, {
    method: "POST",
    body: JSON.stringify({ commit_hash }),
  });
}

export function saveGitignore(sessionId: string, content: string): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${sessionId}/git/gitignore`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

export function gitSetRemote(sessionId: string, url: string): Promise<{ ok: boolean; remote: string }> {
  return request(`/api/sessions/${sessionId}/git/remote`, {
    method: "PUT",
    body: JSON.stringify({ url }),
  });
}

export function gitPush(sessionId: string): Promise<{ ok: boolean; output: string }> {
  return request(`/api/sessions/${sessionId}/git/push`, { method: "POST" });
}

export function gitPull(sessionId: string): Promise<{ ok: boolean; output: string }> {
  return request(`/api/sessions/${sessionId}/git/pull`, { method: "POST" });
}

// ── Merge (with VSCode-style conflict resolution) ────────────────────────

export interface MergeStatus {
  in_progress: boolean;
  conflicted_files: string[];
  merge_head: string;
  current_branch: string;
}

export interface MergeStartResult {
  ok: true;
  clean?: boolean;
  up_to_date?: boolean;
  conflicted_files?: string[];
  output?: string;
  /** Backup branch created at target's pre-merge HEAD; absent when up-to-date. */
  backup_branch?: string;
}

export interface ConflictFileVersions {
  path: string;
  base: string;
  ours: string;
  theirs: string;
  working: string;
}

export function getMergeStatus(sessionId: string): Promise<MergeStatus> {
  return request(`/api/sessions/${sessionId}/git/merge/status`);
}

export interface MergePreviewCommit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

export interface MergePreview {
  merge_kind: "up_to_date" | "fast_forward" | "clean" | "conflict" | "error";
  ahead?: number;
  behind?: number;
  commits?: MergePreviewCommit[];
  changed_files?: Array<{ path: string; status: string }>;
  conflicting_files?: string[];
  error?: string;
}

export function getMergePreview(
  sessionId: string, source: string, target: string,
): Promise<MergePreview> {
  const q = `source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`;
  return request(`/api/sessions/${sessionId}/git/merge/preview?${q}`);
}

export function getMergeFileDiff(
  sessionId: string, source: string, target: string, path: string,
): Promise<{ diff: string; error?: string }> {
  const q = `source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}&path=${encodeURIComponent(path)}`;
  return request(`/api/sessions/${sessionId}/git/merge/file-diff?${q}`);
}

export function gitMergeStart(sessionId: string, source: string, target: string): Promise<MergeStartResult> {
  return request(`/api/sessions/${sessionId}/git/merge/start`, {
    method: "POST",
    body: JSON.stringify({ source, target }),
  });
}

export function getMergeConflictFile(sessionId: string, path: string): Promise<ConflictFileVersions> {
  return request(`/api/sessions/${sessionId}/git/merge/file?path=${encodeURIComponent(path)}`);
}

export function gitResolveFile(
  sessionId: string, path: string, content: string,
): Promise<{ ok: boolean; status: MergeStatus }> {
  return request(`/api/sessions/${sessionId}/git/merge/resolve`, {
    method: "POST",
    body: JSON.stringify({ path, content }),
  });
}

export function gitMergeContinue(sessionId: string, message?: string): Promise<{ ok: boolean; output: string }> {
  return request(`/api/sessions/${sessionId}/git/merge/continue`, {
    method: "POST",
    body: JSON.stringify({ message: message ?? null }),
  });
}

export function gitMergeAbort(sessionId: string): Promise<{ ok: boolean; output: string }> {
  return request(`/api/sessions/${sessionId}/git/merge/abort`, { method: "POST" });
}

export interface CommitDetail {
  message: string;
  files: GitDiffFile[];
}

export interface GitBranchInfo {
  current: string;
  local: string[];
  /** Per-branch last-commit Unix timestamps. Aligned with `local`; backend
   * may omit this field on older deployments (treat as absent → no recency). */
  local_with_dates?: { name: string; committerdate: number }[];
  remote_only?: string[];
  dirty?: boolean;
}

export interface GitGraphCommit {
  hash: string;
  short_hash: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  refs: string[];
}

export interface ActiveCwdSession {
  id: string;
  name: string;
  status: string;
  tool: string;
  last_activity_at: string | null;
}

export function getGitBranches(sessionId: string): Promise<GitBranchInfo> {
  return request(`/api/sessions/${sessionId}/git/branches`);
}

export function getGitGraph(sessionId: string, scope = "current", n = 500): Promise<GitGraphCommit[]> {
  return request(`/api/sessions/${sessionId}/git/graph?scope=${encodeURIComponent(scope)}&n=${n}`);
}

export function getActiveCwdSessions(sessionId: string): Promise<{ sessions: ActiveCwdSession[] }> {
  return request(`/api/sessions/${sessionId}/git/active-cwd-sessions`);
}

export interface GitCheckoutConflict {
  code: "conflict";
  message: string;
  conflicting_files: string[];
}

export class GitCheckoutConflictError extends Error {
  conflict: GitCheckoutConflict;
  constructor(c: GitCheckoutConflict) {
    super(c.message);
    this.conflict = c;
  }
}

export async function gitCheckoutBranch(
  sessionId: string,
  branch: string,
  opts: { stash?: boolean; remote?: boolean } = {},
): Promise<{ ok: boolean; branch: string; output: string; stashed?: boolean }> {
  const token = getToken();
  const resp = await fetch(apiPath(`/api/sessions/${sessionId}/git/checkout`), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ branch, stash: opts.stash ?? false, remote: opts.remote ?? false }),
  });
  if (resp.status === 409) {
    const body = await resp.json().catch(() => ({}));
    const detail = body?.detail;
    if (detail && typeof detail === "object" && detail.code === "conflict") {
      throw new GitCheckoutConflictError(detail as GitCheckoutConflict);
    }
    throw new Error(typeof detail === "string" ? detail : "checkout conflict");
  }
  if (!resp.ok) {
    const text = await resp.text();
    let msg = text;
    try {
      const j = JSON.parse(text);
      if (typeof j?.detail === "string") msg = j.detail;
    } catch { /* */ }
    throw new Error(msg || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export function getCommitDetail(sessionId: string, commitHash: string): Promise<CommitDetail> {
  return request(`/api/sessions/${sessionId}/git/show/${commitHash}`);
}

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
  ts: number;      // seconds since epoch from turn_duration; 0 for in-progress turns
  pending?: boolean; // true = unconfirmed (no turn_duration yet); replace not append
  compacting?: boolean; // true while the model is generating a compact summary
}

export interface JsonlPageResponse {
  lines: string[];
  total: number;
  page: number;
  page_size: number;
}

export async function getConversationJsonl(
  sessionId: string,
  page = 0,
  page_size = 200,
): Promise<JsonlPageResponse> {
  const token = localStorage.getItem("token") || "";
  const params = new URLSearchParams({ page: String(page), page_size: String(page_size) });
  const resp = await fetch(apiPath(`/api/sessions/${sessionId}/conversation/jsonl?${params}`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 401) { localStorage.removeItem("token"); window.location.reload(); throw new Error("unauthorized"); }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export function getConversation(sessionId: string, fromTs = 0, tail?: number): Promise<ConversationTurn[]> {
  const params = new URLSearchParams();
  if (fromTs > 0) params.set("from_ts", String(fromTs));
  if (tail !== undefined) params.set("tail", String(tail));
  const qs = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/sessions/${sessionId}/conversation${qs}`);
}

export function gitDiff(sessionId: string, old_hash: string, new_hash: string): Promise<GitDiffResult> {
  return request(`/api/sessions/${sessionId}/git/diff`, {
    method: "POST",
    body: JSON.stringify({ old_hash, new_hash }),
  });
}

export async function getFileGitLog(sessionId: string, path: string, n = 50): Promise<Array<{hash: string; short_hash: string; subject: string; author: string; date: string}>> {
  return request(`/api/sessions/${sessionId}/git/file-log?path=${encodeURIComponent(path)}&n=${n}`);
}

export async function getFileGitShow(sessionId: string, path: string, commit: string): Promise<{content: string; commit: string; path: string}> {
  return request(`/api/sessions/${sessionId}/git/file-show?path=${encodeURIComponent(path)}&commit=${encodeURIComponent(commit)}`);
}

export async function getFileGitDiff(sessionId: string, path: string, commit: string): Promise<{diff: string; commit: string; path: string}> {
  return request(`/api/sessions/${sessionId}/git/file-diff?path=${encodeURIComponent(path)}&commit=${encodeURIComponent(commit)}`);
}

// ── Code viewer ───────────────────────────────────────────────────────────

export interface ChangedFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";
  added?: number;
  removed?: number;
  /** Set when the entry stands in for a collapsed-but-skipped untracked dir
   *  (see ChangedFilesWarning). The frontend renders it as a non-expandable
   *  row so the user knows changes exist but isn't allowed to drill in. */
  is_skipped_dir?: boolean;
}

export interface ChangedFilesWarning {
  /** "large_untracked_dir": dir exceeded size/file-count probe threshold.
   *  "bare_git_repo": dir looks like a bare git repository (HEAD+objects+refs).
   */
  kind: "large_untracked_dir" | "bare_git_repo";
  path: string;
  file_count?: number;
  approx_size_bytes?: number;
  is_bare_repo?: boolean;
  /** A line to append to .gitignore that would suppress this warning. */
  suggested_ignore: string;
}

export interface ChangedFilesResponse {
  files: ChangedFile[];
  warnings: ChangedFilesWarning[];
}

export interface FileData {
  path: string;
  content: string;
  language: string;
  added_lines: number[];
  removed_lines: number[];
  truncated: boolean;
  truncated_by?: "lines" | "bytes" | null;
  displayed_lines?: number;
  diff_raw?: string;
  is_binary?: boolean;
  size?: number;
  mtime?: number;
  total_lines?: number;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  /** undefined = not a dir or empty dir; null = has content but not loaded yet */
  children?: TreeNode[] | null;
}

export function getCodeChangedFiles(sessionId: string): Promise<ChangedFilesResponse> {
  return request(`/api/sessions/${sessionId}/code/changed-files`);
}

export function getCodeFile(
  sessionId: string,
  path: string,
  opts?: { metaOnly?: boolean },
): Promise<FileData> {
  const qs = opts?.metaOnly ? "&meta_only=true" : "";
  return request(`/api/sessions/${sessionId}/code/file?path=${encodeURIComponent(path)}${qs}`);
}

export function getCodeTree(sessionId: string, depth = 2, path = ""): Promise<TreeNode> {
  const params = new URLSearchParams({ depth: String(depth) });
  if (path) params.set("path", path);
  return request(`/api/sessions/${sessionId}/code/tree?${params}`);
}

export function getCodeSubdirs(sessionId: string, path = ""): Promise<{ path: string; dirs: string[] }> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return request(`/api/sessions/${sessionId}/code/dirs${qs}`);
}

export function checkCodePathExists(sessionId: string, path: string): Promise<{ exists: boolean; is_file: boolean }> {
  return request(`/api/sessions/${sessionId}/code/exists?path=${encodeURIComponent(path)}`);
}

export interface UsageWindow {
  utilization: number;  // 0..1
  resets_at: string;    // ISO timestamp
}

export interface UsageInfo {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  seven_day_sonnet?: UsageWindow;
}

export function getUsageInfo(): Promise<UsageInfo> {
  return request<UsageInfo>("/api/usage");
}

export function getPaneHistory(sessionId: string, lines = 20000): Promise<{ content: string }> {
  return request<{ content: string }>(`/api/sessions/${sessionId}/pane-history?lines=${lines}`);
}

export interface RawUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  [key: string]: unknown;
}

export interface RawMessage {
  type: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  message?: {
    role: string;
    content: RawContentBlock[] | string;
    stop_reason?: string | null;
    model?: string;
    usage?: RawUsage;
  };
  [key: string]: unknown;
}

export interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | RawContentBlock[];
  is_error?: boolean;
  [key: string]: unknown;
}

export interface RawMessagesResp {
  messages?: RawMessage[];
  total?: number;
  token?: string;
  unchanged?: boolean;
  // When true, `messages` is a delta (the latest ~10 JSONL entries + current
  // streaming snapshots), NOT the full window — the client must merge it into
  // its existing list by uuid rather than replacing. See ConversationPane.
  incremental?: boolean;
}

export function getRawMessages(
  sessionId: string,
  tail = 500,
  sinceToken?: string,
): Promise<RawMessagesResp> {
  const q = sinceToken ? `&since_token=${encodeURIComponent(sinceToken)}` : "";
  return request<RawMessagesResp>(`/api/sessions/${sessionId}/raw-messages?tail=${tail}${q}`);
}

// History paging: fetch a bounded, static older slice [offset, offset+limit) in
// raw eligible-entry space (matching `total`), to PREPEND to the live window.
// No since_token / delta / snapshots — old history is already flushed to JSONL.
export function getRawMessagesPage(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<RawMessagesResp> {
  return request<RawMessagesResp>(
    `/api/sessions/${sessionId}/raw-messages?offset=${offset}&limit=${limit}`,
  );
}

export function getAllRawMessages(sessionId: string): Promise<{ messages: RawMessage[]; total: number }> {
  return request<{ messages: RawMessage[]; total: number }>(`/api/sessions/${sessionId}/raw-messages/all`);
}

// ── Conversation shares ─────────────────────────────────────────────────────

export type ShareType = "full" | "limited" | "chat";
export type ShareTheme = "light" | "dark";

// Public file-viewing spec. Paths are relative to the session cwd. `full` dirs
// grant their entire subtree recursively; `files` are individual grants.
export interface FileAccessSpec {
  full: string[];
  files: string[];
}

export interface ShareRecord {
  hash: string;
  share_type: ShareType;
  url: string;
  created_at: number;       // epoch seconds
  expires_at: number;       // epoch seconds; 2147483647 = permanent
  cutoff_ts?: number | null;
  cutoff_msg_text?: string | null;
  default_theme?: ShareTheme;
  has_files?: boolean;
}

export interface ShareCreateBody {
  share_type: ShareType;
  expires_at?: number;       // epoch seconds; ignored when permanent
  permanent?: boolean;
  cutoff_after_uuid?: string;  // required for limited
  default_theme?: ShareTheme;  // viewer's initial theme (default light)
  file_access?: FileAccessSpec;  // optional public files for the Files tab
}

export function createShare(sessionId: string, body: ShareCreateBody): Promise<ShareRecord> {
  return request<ShareRecord>(`/api/sessions/${sessionId}/shares`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listShares(sessionId: string): Promise<ShareRecord[]> {
  return request<ShareRecord[]>(`/api/sessions/${sessionId}/shares`);
}

export function deleteShare(sessionId: string, hash: string): Promise<void> {
  return request<void>(`/api/sessions/${sessionId}/shares/${hash}`, { method: "DELETE" });
}

export interface ShareMeta {
  hash: string;
  share_type: ShareType;
  title: string;
  created_at: number;
  expires_at: number;
  cutoff_ts?: number | null;
  default_theme?: ShareTheme;
  has_files?: boolean;
  session_alive?: boolean;  // chat shares: whether the session can receive input
}

// Public (no auth) — used by the share viewer.
export function getPublicShareMeta(hash: string): Promise<ShareMeta> {
  return request<ShareMeta>(`/api/public/share/${hash}`, undefined, true);
}

export function getPublicShareMessages(
  hash: string,
  offset = 0,
  limit = 100,
  tail = false,
): Promise<{ messages: RawMessage[]; total: number; title: string; share_type: ShareType; expires_at: number; session_alive?: boolean }> {
  const q = `offset=${offset}&limit=${limit}${tail ? "&tail=true" : ""}`;
  return request(`/api/public/share/${hash}/messages?${q}`, undefined, true);
}

// Public (no auth) — send a chat-mode prompt to the live session behind a chat
// share. Throws Error(detail) on 4xx/5xx (e.g. "auq_pending", "offline").
export function postPublicSharePrompt(hash: string, text: string): Promise<{ ok: boolean }> {
  return request(
    `/api/public/share/${hash}/prompt`,
    { method: "POST", body: JSON.stringify({ text }) },
    true,
  );
}

// ── Public share files (no auth) — back the viewer's Files tab. ──────────────
export interface ShareFileEntry {
  name: string;
  path: string;             // relative to session cwd
  type: "file" | "dir";
  size?: number | null;
  is_text?: boolean;
  is_skipped?: boolean;
  is_sqlite?: boolean;
  is_archive?: boolean;
}

export interface ShareFilesResponse {
  entries: ShareFileEntry[];
  path: string;             // current dir relative to cwd
}

export interface ShareFileContent {
  path: string;
  content: string;
  is_text: boolean;
  too_large: boolean;
}

export function getPublicShareFiles(hash: string, path = ""): Promise<ShareFilesResponse> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return request<ShareFilesResponse>(`/api/public/share/${hash}/files${qs}`, undefined, true);
}

export function getPublicShareFileContent(hash: string, path: string): Promise<ShareFileContent> {
  return request<ShareFileContent>(
    `/api/public/share/${hash}/file?path=${encodeURIComponent(path)}`,
    undefined,
    true,
  );
}

// Direct URL for inline <img> rendering of a granted image file. Goes through
// apiPath so it respects any ROOT_PATH prefix.
export function publicShareRawUrl(hash: string, path: string): string {
  return apiPath(`/api/public/share/${hash}/raw?path=${encodeURIComponent(path)}`);
}

export interface SubAgentMeta {
  agentId: string;
  description: string;
  agentType: string;
  mtime: number;
  // Enriched fields (backend ListSubagentSummaries). All optional so older
  // payloads and non-Claude tools keep parsing.
  model?: string;
  status?: "running" | "done" | "failed";
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  toolUses?: number;
  startedTs?: number;
  endedTs?: number;
  durationSec?: number;
  outputPreview?: string;
}

// formatTokens renders a token count compactly: 950 → "950", 12480 → "12.5k",
// 1_921_638 → "1.9M".
export function formatTokens(n: number | undefined): string {
  const v = n ?? 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0) + "k";
  return (v / 1_000_000).toFixed(1) + "M";
}

// formatDuration renders seconds as "45s", "3m12s", or "1h4m".
export function formatDuration(sec: number | undefined): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function getSubAgents(sessionId: string): Promise<SubAgentMeta[]> {
  return request<SubAgentMeta[]>(`/api/sessions/${sessionId}/subagents`);
}

export function getSubAgentLines(sessionId: string, agentId: string, fromLine = 0): Promise<{ lines: string[]; total: number }> {
  return request<{ lines: string[]; total: number }>(`/api/sessions/${sessionId}/subagents/${agentId}?from_line=${fromLine}`);
}

export interface ExternalSession {
  agent_session_id: string;
  mtime: number;
  title: string | null;
  prompts: string[];
  cwd: string;
}

export interface ExternalSessionGroup {
  dir: string;
  dir_exists: boolean;
  sessions: ExternalSession[];
  latest_mtime: number;
}

export function browseExternalSessions(): Promise<ExternalSessionGroup[]> {
  return request<ExternalSessionGroup[]>("/api/sessions/external");
}

export function browseCursorSessions(): Promise<ExternalSessionGroup[]> {
  return request<ExternalSessionGroup[]>("/api/sessions/external-cursor");
}

export function browseCodexSessions(): Promise<ExternalSessionGroup[]> {
  return request<ExternalSessionGroup[]>("/api/sessions/external-codex");
}

export interface ExternalPreview {
  turns: Array<{ role: string; text: string; ts: number }>;
  total: number;
  truncated_before: number;
}

export function getExternalPreview(agent_session_id: string, cwd: string, tool = "claude"): Promise<ExternalPreview> {
  return request<ExternalPreview>(
    `/api/sessions/external-preview?agent_session_id=${encodeURIComponent(agent_session_id)}&cwd=${encodeURIComponent(cwd)}&tool=${encodeURIComponent(tool)}`
  );
}

export interface ModelInfo {
  id: string;
  name: string;
}

export function listModels(tool: string = "claude"): Promise<ModelInfo[]> {
  return request<ModelInfo[]>(`/api/models?tool=${encodeURIComponent(tool)}`);
}

export function setSessionModel(sessionId: string, model: string | null): Promise<SessionMeta> {
  return request<SessionMeta>(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
}

// ── Claude Capability Management ─────────────────────────────────────────────

export interface CapItem {
  relpath: string;
  name: string;
  description: string;
  exists: boolean;
  size: number;
}

export interface CapSection {
  id: string;
  title: string;
  items: CapItem[];
  new_template: string | null;
  new_dir: string | null;
}

export interface CapListResponse {
  scope_root: string;
  sections: CapSection[];
}

export function listClaudeCaps(scope: "global" | "project", cwd?: string): Promise<CapListResponse> {
  const params = new URLSearchParams({ scope });
  if (cwd) params.set("cwd", cwd);
  return request<CapListResponse>(`/api/claude-caps/list?${params}`);
}

export function readClaudeCapFile(scope: "global" | "project", relpath: string, cwd?: string): Promise<{ content: string; exists: boolean }> {
  const params = new URLSearchParams({ scope, relpath });
  if (cwd) params.set("cwd", cwd);
  return request<{ content: string; exists: boolean }>(`/api/claude-caps/file?${params}`);
}

export function writeClaudeCapFile(scope: "global" | "project", relpath: string, content: string, cwd?: string): Promise<void> {
  return request<void>(`/api/claude-caps/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, relpath, content, cwd }),
  });
}

export function deleteClaudeCapFile(scope: "global" | "project", relpath: string, cwd?: string): Promise<void> {
  const params = new URLSearchParams({ scope, relpath });
  if (cwd) params.set("cwd", cwd);
  return request<void>(`/api/claude-caps/file?${params}`, { method: "DELETE" });
}

export interface CapVersion {
  version_id: string;
  saved_at: string;
  size: number;
  preview: string;
}

export interface CapVersionsResponse {
  versions: CapVersion[];
}

export function listCapVersions(scope: "global" | "project", relpath: string, cwd?: string): Promise<CapVersionsResponse> {
  const params = new URLSearchParams({ scope, relpath });
  if (cwd) params.set("cwd", cwd);
  return request<CapVersionsResponse>(`/api/claude-caps/versions?${params}`);
}

export function rollbackCapVersion(scope: "global" | "project", relpath: string, version_id: string, cwd?: string): Promise<void> {
  return request<void>(`/api/claude-caps/rollback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, relpath, version_id, cwd }),
  });
}

export function readCapVersionContent(scope: "global" | "project", relpath: string, version_id: string, cwd?: string): Promise<{ content: string }> {
  const params = new URLSearchParams({ scope, relpath, version_id });
  if (cwd) params.set("cwd", cwd);
  return request<{ content: string }>(`/api/claude-caps/version-content?${params}`);
}

export function readClaudePlan(path: string): Promise<{ path: string; content: string }> {
  const params = new URLSearchParams({ path });
  return request<{ path: string; content: string }>(`/api/claude-caps/plan?${params}`);
}

export interface MemoryFile {
  name: string;
  size: number;
  mtime: number;
}

export interface MemoryListResp {
  dir: string | null;
  files: MemoryFile[];
}

export function listMemory(sessionId: string): Promise<MemoryListResp> {
  return request<MemoryListResp>(`/api/sessions/${sessionId}/memory/list`);
}

export function readMemory(sessionId: string, name: string): Promise<{ name: string; content: string; size: number; mtime: number }> {
  const params = new URLSearchParams({ name });
  return request(`/api/sessions/${sessionId}/memory/read?${params.toString()}`);
}

// ── Admin server monitoring (top-like) ─────────────────────────────────────

export interface MonitorOverall {
  cpu_percent: number;   // whole-machine 0..100
  mem_total: number;     // bytes
  mem_used: number;      // bytes
  mem_percent: number;
  load1: number;
  load5: number;
  load15: number;
  num_cpu: number;
}

export interface MonitorProc {
  pid: number;
  comm: string;
  cmdline: string;       // full launch command; "[comm]" for kernel threads
  cpu_percent: number;   // per-core scale: 100 == one full core
  mem_percent: number;
  rss_bytes: number;
}

export interface MonitorStats {
  overall: MonitorOverall;
  processes: MonitorProc[];
  timestamp: string;
  ready: boolean;
}

export function getMonitorStats(sort: "cpu" | "mem" = "cpu", limit = 20): Promise<MonitorStats> {
  const params = new URLSearchParams({ sort, limit: String(limit) });
  return request<MonitorStats>(`/api/admin/monitoring/stats?${params}`);
}

