import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import hljs from "highlight.js/lib/common";
import { marked, renderMarkdown } from "../lib/markdown";
import { getRawMessages, getRawMessagesPage, attachSession, getSubAgents, getSubAgentLines, submitAuqAnswers, approveToolRequest, approvePlan, rewindSession, readClaudePlan, resolveCodexAuq, uploadAttachment, registerLostMessage, dismissLostMessage, type RawMessage, type RawContentBlock, type RawUsage, type SubAgentMeta, type UploadedAttachment, type LostMessage } from "../api/sessionApi";
import { WsClient } from "../lib/wsClient";
import { apiPath } from "../lib/baseUrl";
import {
  inputDrafts,
  loadDraft,
  loadDraftEditedAt,
  saveDraft,
  clearDraft,
  touchDraft,
  cleanupExpiredDrafts,
  loadInputHeight,
  startInputHeightDrag,
  inputHeightMax,
  INPUT_HEIGHT_MIN,
  DRAFT_HEARTBEAT_MS,
  DRAFT_CLEANUP_MS,
} from "../lib/sessionInputPersist";
import { PromptHistoryPopover } from "./PromptHistoryPopover";
import { copyTextDetect, selectElementContents } from "../lib/copyText";

const POLL_MS = 1500;
// Idle cadence: when the session is not streaming/compacting/waiting and no
// send is outstanding, nothing new can land between the status poll's
// hint-driven refresh and the next is_streaming flip, so a slow poll is safe
// and the change-token short-circuit makes each tick nearly free.
const IDLE_POLL_MS = 10000;
// Live polling always fetches just the last LIVE_TAIL raw entries (delta-merged).
// This window NEVER grows — older history is paged in separately and prepended,
// so a long session never re-reads the whole transcript on every poll.
const LIVE_TAIL = 100;
// Bounded older-history page size (raw entries) loaded on scroll-to-top / "Load
// more" and prepended to the head.
const HISTORY_PAGE = 200;
// Min gap between auto history loads, so a render-induced scroll change can't
// re-fire "load more" in a tight loop.
const LOAD_COOLDOWN_MS = 500;
// crypto.randomUUID() requires a secure context (HTTPS/localhost).
// Fall back to Math.random on plain HTTP local-network access.
const _randomId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
const JSON_FORMAT_THRESHOLD = 4096;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isCompactSummaryText(text: string): boolean {
  return text.trimStart().startsWith("This session is being continued from a previous conversation");
}

function getTextFromContent(content: RawContentBlock[] | string): string {
  if (typeof content === "string") return content;
  return content.filter((b) => b.type === "text").map((b) => b.text || "").join("");
}

function getBlocks(content: RawContentBlock[] | string): RawContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content || [];
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  if (name === "Agent" && input.description) return String(input.description);
  if ("command" in input) return String(input.command).split("\n")[0].slice(0, 120);
  if ("file_path" in input) return String(input.file_path);
  if ("pattern" in input) {
    const path = input.path ? ` in ${input.path}` : "";
    return `${input.pattern}${path}`;
  }
  if ("query" in input) return String(input.query).slice(0, 80);
  if ("url" in input) return String(input.url).slice(0, 80);
  if ("old_string" in input) return String(input.file_path || "");
  if ("content" in input && "file_path" in input) return String(input.file_path);
  return name;
}

function toolIcon(name: string): string {
  switch (name) {
    case "Bash": return "⌨";
    case "Read": return "📄";
    case "Write": return "✏";
    case "Edit": case "MultiEdit": return "✂";
    case "Glob": return "🔍";
    case "Grep": return "🔎";
    case "WebFetch": case "WebSearch": return "🌐";
    case "TodoWrite": case "TodoRead": return "📋";
    case "Task": return "⎇";
    case "Agent": return "🤖";
    default: return "⚙";
  }
}

function diffStats(name: string, input: Record<string, unknown>): { add: number; del: number } | null {
  if (name === "Edit" || name === "MultiEdit") {
    if ("old_string" in input && "new_string" in input) {
      const raw = lcsLineDiff(
        String(input.old_string || "").split("\n"),
        String(input.new_string || "").split("\n"),
      );
      return {
        del: raw.filter((l) => l.type === "removed").length,
        add: raw.filter((l) => l.type === "added").length,
      };
    }
  }
  if (name === "Write" && "content" in input) {
    return { add: String(input.content || "").split("\n").length, del: 0 };
  }
  return null;
}

function toolResultText(result: { content: string; isError: boolean } | undefined): string | null {
  if (!result?.content) return null;
  const t = result.content.trim();
  return t.length > 3 ? t : null;
}

function formatTs(iso: string | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const isToday = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    if (isToday) return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    // Non-today: drop year + seconds so the usage row fits one line on mobile.
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ""; }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function _innerXml(text: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  return text.match(re)?.[1].trim() || "";
}

function TaskNotificationBlock({ text, ts }: { text: string; ts?: string }) {
  const [expanded, setExpanded] = useState(false);
  const status = _innerXml(text, "status").toLowerCase();
  const summary = _innerXml(text, "summary");
  const taskId = _innerXml(text, "task-id");
  const toolUseId = _innerXml(text, "tool-use-id");
  const outputFile = _innerXml(text, "output-file");

  const colors = status === "failed"
    ? { bg: "#3d1f1f", border: "#7a3838", text: "#ffb4b4", badge: "#c94a4a", icon: "✗" }
    : status === "completed" || status === "success"
    ? { bg: "#1f3d2a", border: "#3d7a52", text: "#b4ffc8", badge: "#3fa050", icon: "✓" }
    : { bg: "#2a3142", border: "#3f4a66", text: "#cfd8ec", badge: "#4a72b8", icon: "●" };

  return (
    <div style={{ padding: "4px 16px", display: "flex", justifyContent: "center" }}>
      <div style={{
        maxWidth: 760, width: "100%",
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderLeft: `4px solid ${colors.badge}`,
        borderRadius: 6,
        overflow: "hidden",
      }}>
        <div
          onClick={() => setExpanded(e => !e)}
          style={{
            padding: "8px 12px",
            display: "flex", alignItems: "center", gap: 8,
            cursor: "pointer",
            color: colors.text,
            fontSize: 12,
          }}
        >
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 18, height: 18, borderRadius: 9,
            background: colors.badge, color: "#fff",
            fontSize: 11, flexShrink: 0,
          }}>{colors.icon}</span>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>Background Task</span>
          <span style={{
            fontSize: 10, padding: "1px 7px", borderRadius: 10,
            background: colors.badge, color: "#fff", flexShrink: 0,
            textTransform: "uppercase", letterSpacing: 0.5,
          }}>{status || "—"}</span>
          <span style={{ flex: 1, color: colors.text, opacity: 0.9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {summary}
          </span>
          <span style={{ fontSize: 10, color: colors.text, opacity: 0.6, flexShrink: 0 }}>
            {expanded ? "▾" : "▸"}
          </span>
        </div>
        {expanded && (
          <div style={{
            padding: "8px 12px 10px",
            borderTop: `1px solid ${colors.border}`,
            fontSize: 11, lineHeight: 1.6,
            color: colors.text, opacity: 0.85,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          }}>
            {taskId && <div><span style={{ opacity: 0.6 }}>task-id:</span> {taskId}</div>}
            {toolUseId && <div><span style={{ opacity: 0.6 }}>tool-use-id:</span> {toolUseId}</div>}
            {outputFile && <div style={{ wordBreak: "break-all" }}><span style={{ opacity: 0.6 }}>output:</span> {outputFile}</div>}
          </div>
        )}
        {ts && <div style={{ fontSize: 9, color: colors.text, opacity: 0.5, padding: "0 12px 5px" }}>{ts}</div>}
      </div>
    </div>
  );
}

function SystemReminderBlock({ text, ts }: { text: string; ts?: string }) {
  const [expanded, setExpanded] = useState(false);
  // Strip the wrapping <system-reminder>...</system-reminder> if present.
  const inner = _innerXml(text, "system-reminder") || text.replace(/^<system-reminder>|<\/system-reminder>$/g, "").trim();
  const isLong = inner.length > 220;
  const preview = isLong ? inner.slice(0, 220).replace(/\s+\S*$/, "") + "…" : inner;

  return (
    <div style={{ padding: "4px 16px", display: "flex", justifyContent: "center" }}>
      <div style={{
        maxWidth: 760, width: "100%",
        background: "#3a2f1a",
        border: "1px solid #6b5524",
        borderLeft: "4px solid #d4a843",
        borderRadius: 6,
        padding: "8px 12px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 18, height: 18, borderRadius: 9,
            background: "#d4a843", color: "#2a2010",
            fontSize: 12, fontWeight: 700, flexShrink: 0,
          }}>!</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#f5d990", flex: 1 }}>System Reminder</span>
          {isLong && (
            <button
              onClick={() => setExpanded(e => !e)}
              style={{
                background: "transparent", border: "1px solid #6b5524",
                color: "#f5d990", fontSize: 10, padding: "1px 8px", borderRadius: 10,
                cursor: "pointer",
              }}
            >
              {expanded ? "Collapse" : "Show full"}
            </button>
          )}
        </div>
        <div style={{
          fontSize: 12, lineHeight: 1.55, color: "#f3e3b8",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {expanded || !isLong ? inner : preview}
        </div>
        {ts && <div style={{ fontSize: 9, color: "#f5d990", opacity: 0.6, marginTop: 4 }}>{ts}</div>}
      </div>
    </div>
  );
}

function SlashCommandBubble({ cmd, args, ts }: { cmd: string; args: string; ts?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", padding: "2px 16px" }}>
      <div style={{ maxWidth: "85%", display: "inline-flex", alignItems: "flex-start", gap: 6, padding: "5px 10px", background: "rgba(88,166,255,0.08)", border: "1px solid rgba(88,166,255,0.3)", borderRadius: 10, fontSize: 12.5 }}>
        <span style={{ fontFamily: "monospace", color: "var(--accent-blue)", fontWeight: 600, flexShrink: 0 }}>{cmd}</span>
        {args && <span style={{ color: "var(--text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{args}</span>}
        {ts && <span style={{ fontSize: 9, color: "var(--text-faint)", marginLeft: 4, flexShrink: 0, alignSelf: "flex-end" }}>{ts}</span>}
      </div>
    </div>
  );
}

function parseSlashCommand(text: string): { cmd: string; args: string } | null {
  const m = text.match(/^<command-name>([^<]+)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
  if (!m) return null;
  return { cmd: m[1].trim(), args: (m[2] || "").trim() };
}

// Claude CLI uses `\r` (not `\n`) as the line separator in queue-merged user input
// and inside queued_command attachments. Browsers don't render `\r` as a line break
// under `white-space: pre-wrap`, so without this normalization multi-line prompts
// collapse onto one line in the chat bubble.
function normalizeBreaks(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

// Match `@<abs-path>` references that point at our upload directory. The
// 32-hex filename is the load-bearing match — it's what upload_image emits
// (uuid4().hex + ext). The path may live anywhere on disk; only the suffix
// `.claude/uploads/<stored_name>` matters for rebuilding the serve URL.
const UPLOADED_IMAGE_REF_RE = /^@(.+\/\.claude\/uploads\/([a-f0-9]{32}\.(?:png|jpg|jpeg|gif|webp)))\s*$/;

function buildUploadedAttachmentUrl(sessionId: string, storedName: string): string {
  const token = localStorage.getItem("token") || "";
  return apiPath(`/api/sessions/${sessionId}/uploaded-image/${storedName}?token=${encodeURIComponent(token)}`);
}

// Split a prompt body into text segments and inline image nodes. Each
// `@<path>` reference on its own line is converted to an <img>; everything
// else passes through untouched (joined with newlines so pre-wrap layout
// still works).
function renderPromptWithImages(text: string, sessionId: string): React.ReactNode {
  const lines = text.split("\n");
  const parts: React.ReactNode[] = [];
  let textBuf: string[] = [];
  const flushText = (keyHint: number) => {
    if (textBuf.length === 0) return;
    parts.push(<span key={`t${keyHint}`}>{textBuf.join("\n")}</span>);
    textBuf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const m = UPLOADED_IMAGE_REF_RE.exec(lines[i]);
    if (m) {
      flushText(i);
      const storedName = m[2];
      parts.push(
        <img
          key={`img${i}`}
          src={buildUploadedAttachmentUrl(sessionId, storedName)}
          alt="attached"
          style={{ display: "block", maxWidth: "100%", maxHeight: 300, borderRadius: 6, marginTop: parts.length > 0 ? 8 : 0 }}
        />
      );
    } else {
      // Preserve blank lines between text and images for spacing.
      textBuf.push(lines[i]);
    }
  }
  flushText(lines.length);
  return <>{parts}</>;
}

function UserBubble({ text, ts, sessionId, onRewind }: { text: string; ts?: string; sessionId?: string; onRewind?: () => void }) {
  const [hovered, setHovered] = useState(false);
  text = normalizeBreaks(text);
  return (
    <div
      style={{ padding: "0 16px 2px", textAlign: "right" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "inline-flex", alignItems: "flex-end", gap: 6, maxWidth: "75%" }}>
        {onRewind && hovered && (
          <button
            onClick={onRewind}
            title="Rewind to here"
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--text-faint)", fontSize: 13, padding: "2px 4px",
              borderRadius: 4, opacity: 0.7, flexShrink: 0,
              transition: "opacity 0.12s",
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={e => (e.currentTarget.style.opacity = "0.7")}
          >
            ↩
          </button>
        )}
        <div style={{
          padding: "9px 14px",
          borderRadius: "14px 14px 3px 14px",
          background: "#1c3a5e",
          border: "1px solid #1d4f8a",
          color: "#cce5ff",
          fontSize: "var(--conv-font, 13px)",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          textAlign: "left",
        }}>
          {sessionId ? renderPromptWithImages(text, sessionId) : text}
        </div>
      </div>
      {ts && <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2, paddingRight: 2 }}>{ts}</div>}
    </div>
  );
}

function ThinkingBlock({ thinking, isActive }: { thinking: string; isActive?: boolean }) {
  const [expanded, setExpanded] = useState(!!isActive);
  useEffect(() => { if (isActive) setExpanded(true); }, [isActive]);

  return (
    <div style={{ padding: "2px 16px" }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 6, background: "none",
          border: "none", cursor: "pointer", padding: "3px 0", color: isActive ? "#c9a227" : "var(--text-muted)",
          fontSize: "var(--conv-font, 12px)", fontStyle: "italic",
        }}
      >
        <span className={isActive ? "thinking-pulse" : ""} style={{ color: "var(--accent-amber)" }}>✦</span>
        <span>{isActive ? "Thinking…" : expanded ? "Thinking" : "Thinking…"}</span>
        <span style={{ fontSize: "var(--conv-font-xs, 10px)", color: "var(--text-faint)" }}>{expanded ? "▲" : "▶"}</span>
      </button>
      {expanded && (
        <div style={{
          marginTop: 4, padding: "8px 12px",
          background: "var(--bg-deep)", borderRadius: 6,
          border: `1px solid ${isActive ? "#2a2010" : "var(--bg-hover)"}`,
          color: "var(--text-muted)", fontSize: "var(--conv-font-sm, 11.5px)",
          fontStyle: "italic", lineHeight: 1.6,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 320, overflowY: "auto",
        }}>
          {thinking.slice(0, 6000)}{thinking.length > 6000 ? "\n…" : ""}
          {isActive && <span className="thinking-cursor">▌</span>}
        </div>
      )}
    </div>
  );
}

function ThinkingRedacted({ isActive, label }: { isActive?: boolean; label?: string }) {
  const text = label ?? (isActive ? "Thinking…" : "Thought");
  return (
    <div style={{ padding: "2px 16px" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        color: "var(--text-faintest)", fontSize: "var(--conv-font, 12px)", fontStyle: "italic",
      }}>
        <span className={isActive ? "thinking-pulse" : ""} style={{ color: isActive ? "var(--accent-amber)" : "var(--text-faint)" }}>✦</span>
        <span>{text}</span>
        {!isActive && <span style={{ fontSize: "var(--conv-font-xs, 10px)", color: "var(--text-muted)", background: "var(--bg-surface)", borderRadius: 3, padding: "0 5px" }}>content not stored</span>}
      </div>
    </div>
  );
}

// ── File-extension → hljs language ───────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin",
  json: "json", yaml: "yaml", yml: "yaml", toml: "ini",
  sh: "bash", bash: "bash", zsh: "bash",
  css: "css", html: "html", xml: "xml", svg: "xml",
  sql: "sql", md: "markdown", c: "c", cpp: "cpp", h: "cpp",
};

function extLang(filePath: string): string {
  return EXT_TO_LANG[filePath.split(".").pop()?.toLowerCase() ?? ""] ?? "";
}

// Search for `needle` in `haystack` and return the 1-indexed starting line, or null if not found.
// ── Line-level LCS diff ───────────────────────────────────────────────────────

type RawDiffLine = { type: "removed" | "added" | "unchanged"; text: string };

function lcsLineDiff(oldLines: string[], newLines: string[]): RawDiffLine[] {
  const m = oldLines.length, n = newLines.length;
  // Guard: skip LCS for very large inputs to avoid O(m*n) OOM
  if (m * n > 250_000) {
    return [
      ...oldLines.map((t) => ({ type: "removed" as const, text: t })),
      ...newLines.map((t) => ({ type: "added" as const, text: t })),
    ];
  }
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const result: RawDiffLine[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      result.push({ type: "unchanged", text: oldLines[i++] }); j++;
    } else if (i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1])) {
      result.push({ type: "removed", text: oldLines[i++] });
    } else {
      result.push({ type: "added", text: newLines[j++] });
    }
  }
  return result;
}

// ── Side-by-side diff view ────────────────────────────────────────────────────

interface SideRow {
  leftNo?: number; leftText?: string; leftType: "removed" | "unchanged" | "empty";
  rightNo?: number; rightText?: string; rightType: "added" | "unchanged" | "empty";
  isEllipsis?: boolean; ellipsisCount?: number;
}

function buildSideRows(raw: RawDiffLine[], context = 3): SideRow[] {
  // First compute line numbers
  let oldNo = 1, newNo = 1;
  const numbered = raw.map((l) => {
    if (l.type === "removed") return { ...l, oldNo: oldNo++ };
    if (l.type === "added") return { ...l, newNo: newNo++ };
    return { ...l, oldNo: oldNo++, newNo: newNo++ };
  }) as Array<RawDiffLine & { oldNo?: number; newNo?: number }>;

  // Which lines to show
  const show = new Uint8Array(numbered.length);
  for (let i = 0; i < numbered.length; i++) {
    if (numbered[i].type !== "unchanged") {
      const lo = Math.max(0, i - context);
      const hi = Math.min(numbered.length - 1, i + context);
      for (let k = lo; k <= hi; k++) show[k] = 1;
    }
  }

  // Pair up removed + added in change blocks → side-by-side rows
  const rows: SideRow[] = [];
  let ci = 0;
  while (ci < numbered.length) {
    const l = numbered[ci];
    if (!show[ci]) {
      // Collapsed section
      let count = 0;
      while (ci < numbered.length && !show[ci]) { count++; ci++; }
      rows.push({ leftType: "empty", rightType: "empty", isEllipsis: true, ellipsisCount: count });
      continue;
    }
    if (l.type === "unchanged") {
      rows.push({
        leftNo: l.oldNo, leftText: l.text, leftType: "unchanged",
        rightNo: l.newNo, rightText: l.text, rightType: "unchanged",
      });
      ci++;
    } else {
      // Collect a block of removes then adds
      const removes: typeof l[] = [];
      const adds: typeof l[] = [];
      const blockStart = ci;
      while (ci < numbered.length && show[ci] && numbered[ci].type === "removed") {
        removes.push(numbered[ci++]);
      }
      while (ci < numbered.length && show[ci] && numbered[ci].type === "added") {
        adds.push(numbered[ci++]);
      }
      // If we collected nothing (shouldn't happen) just advance
      if (removes.length === 0 && adds.length === 0) { ci = blockStart + 1; continue; }
      const maxLen = Math.max(removes.length, adds.length);
      for (let k = 0; k < maxLen; k++) {
        const rem = removes[k];
        const add = adds[k];
        rows.push({
          leftNo: rem?.oldNo, leftText: rem?.text, leftType: rem ? "removed" : "empty",
          rightNo: add?.newNo, rightText: add?.text, rightType: add ? "added" : "empty",
        });
      }
    }
  }
  return rows;
}

const CELL: React.CSSProperties = {
  padding: "1px 8px", fontFamily: '"Ubuntu Sans Mono", monospace',
  fontSize: "var(--conv-font-sm, 11.5px)",
  lineHeight: "1.55", whiteSpace: "pre-wrap", wordBreak: "break-all",
  verticalAlign: "top",
};
const LINENO: React.CSSProperties = {
  padding: "1px 6px", color: "var(--text-faintest)", textAlign: "right",
  userSelect: "none", fontSize: 10, verticalAlign: "top", minWidth: 28,
};

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const rows = useMemo(() => {
    const raw = lcsLineDiff(oldStr.split("\n"), newStr.split("\n"));
    return buildSideRows(raw, 3);
  }, [oldStr, newStr]);

  return (
    <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto", background: "var(--bg-base)", borderRadius: 4, border: "1px solid var(--border)" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: 32 }} /><col style={{ width: "50%" }} />
          <col style={{ width: 32 }} /><col style={{ width: "50%" }} />
        </colgroup>
        <tbody>
          {rows.map((row, i) => {
            if (row.isEllipsis) {
              return (
                <tr key={i}>
                  <td colSpan={4} style={{ padding: "2px 10px", textAlign: "center", color: "var(--text-faintest)", fontSize: 10, background: "var(--bg-base)", fontFamily: "monospace" }}>
                    ···{row.ellipsisCount} unchanged···
                  </td>
                </tr>
              );
            }
            const lBg = row.leftType === "removed" ? "var(--diff-del-bg)" : row.leftType === "empty" ? "var(--bg-deep)" : "transparent";
            const rBg = row.rightType === "added" ? "var(--diff-add-bg)" : row.rightType === "empty" ? "var(--bg-deep)" : "transparent";
            const lColor = row.leftType === "removed" ? "var(--diff-del-text)" : "var(--text-muted)";
            const rColor = row.rightType === "added" ? "var(--diff-add-text)" : "var(--text-muted)";
            const lPrefix = row.leftType === "removed" ? "−" : row.leftType === "unchanged" ? " " : "";
            const rPrefix = row.rightType === "added" ? "+" : row.rightType === "unchanged" ? " " : "";
            const leftNo = row.leftNo;
            const rightNo = row.rightNo;
            return (
              <tr key={i}>
                <td style={{ ...LINENO, background: lBg }}>{leftNo ?? ""}</td>
                <td style={{ ...CELL, background: lBg, color: lColor, borderRight: "1px solid var(--bg-surface)" }}>
                  {row.leftType !== "empty" && (
                    <><span style={{ color: row.leftType === "removed" ? "var(--diff-del-prefix)" : "var(--text-faintest)", userSelect: "none" }}>{lPrefix}</span>{row.leftText}</>
                  )}
                </td>
                <td style={{ ...LINENO, background: rBg }}>{rightNo ?? ""}</td>
                <td style={{ ...CELL, background: rBg, color: rColor }}>
                  {row.rightType !== "empty" && (
                    <><span style={{ color: row.rightType === "added" ? "var(--diff-add-prefix)" : "var(--text-faintest)", userSelect: "none" }}>{rPrefix}</span>{row.rightText}</>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Code highlighting helpers ─────────────────────────────────────────────────

function tryFormatJson(text: string): string | null {
  const t = text.trim();
  if (t[0] !== "{" && t[0] !== "[") return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

function yamlScalar(s: string, indent: number): string {
  if (s === "") return '""';
  if (s.includes("\n")) {
    const chomp = s.endsWith("\n") ? "" : "-";
    const pad = "  ".repeat(indent + 1);
    return `|${chomp}\n` + s.replace(/\n$/, "").split("\n").map((l) => pad + l).join("\n");
  }
  const plain = !/^[\s\-\[\]{},!|>&%@`'"?#]/.test(s) &&
    !s.includes(": ") && !s.includes(" #") &&
    !/^(true|false|null|~)$/.test(s) && !/^\d/.test(s) &&
    s !== "yes" && s !== "no" && s !== "on" && s !== "off";
  if (plain) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

function yamlValue(val: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  if (val === null) return "null";
  if (typeof val === "boolean" || typeof val === "number") return String(val);
  if (typeof val === "string") return yamlScalar(val, indent);
  if (Array.isArray(val)) {
    if (val.length === 0) return "[]";
    return val.map((v) => {
      const child = yamlValue(v, indent + 1);
      if (typeof v === "object" && v !== null) {
        const lines = child.split("\n");
        return `${pad}- ${lines[0].trimStart()}${lines.length > 1 ? "\n" + lines.slice(1).join("\n") : ""}`;
      }
      return `${pad}- ${child}`;
    }).join("\n");
  }
  if (typeof val === "object") {
    const entries = Object.entries(val as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries.map(([k, v]) => {
      const needsQ = k === "" || /[:\s#\[\]{},"'|>&*!%@`?]/.test(k) || /^\d/.test(k);
      const key = needsQ ? '"' + k.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"' : k;
      if (typeof v === "object" && v !== null) {
        if (Array.isArray(v) && v.length === 0) return `${pad}${key}: []`;
        if (!Array.isArray(v) && Object.keys(v as object).length === 0) return `${pad}${key}: {}`;
        return `${pad}${key}:\n${yamlValue(v, indent + 1)}`;
      }
      return `${pad}${key}: ${yamlValue(v, indent)}`;
    }).join("\n");
  }
  return String(val);
}

function tryJsonToYaml(text: string): string | null {
  const t = text.trim();
  if (t[0] !== "{" && t[0] !== "[") return null;
  try {
    return yamlValue(JSON.parse(t), 0);
  } catch {
    return null;
  }
}

function highlightCode(text: string, lang: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(text, { language: lang }).value;
    }
    return hljs.highlightAuto(text, ["json", "bash", "python", "typescript", "javascript", "yaml", "xml", "sql"]).value;
  } catch {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

const PRE_STYLE: React.CSSProperties = {
  margin: 0, padding: "6px 8px",
  background: "var(--bg-deep)", borderRadius: 4,
  fontFamily: '"Ubuntu Sans Mono", monospace',
  fontSize: "var(--conv-font-sm, 11.5px)",
  lineHeight: 1.5, overflowX: "auto",
  whiteSpace: "pre",
};

function FormatModal({ text, lang, allowMarkdown = false, onClose }: { text: string; lang: string; allowMarkdown?: boolean; onClose: () => void }) {
  const [mdMode, setMdMode] = useState(false);
  const codeHtml = useMemo(() => {
    const formatted = lang === "json" ? (tryFormatJson(text) ?? text) : text;
    return highlightCode(formatted, lang);
  }, [text, lang]);
  const mdHtml = useMemo(() => renderMarkdown(text), [text]);

  const tabBtn = (active: boolean, label: string, onClick: () => void) => (
    <button onClick={onClick} style={{
      fontSize: 11, padding: "2px 10px", borderRadius: 4,
      border: "none", cursor: "pointer",
      background: active ? "var(--bg-hover)" : "transparent",
      color: active ? "var(--text-primary)" : "var(--text-muted)",
      fontWeight: active ? 600 : 400,
    }}>{label}</button>
  );

  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--bg-base)", border: "1px solid var(--border)", borderRadius: 10, maxWidth: "85vw", width: "100%", maxHeight: "82vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {tabBtn(!mdMode, "Code", () => setMdMode(false))}
            {allowMarkdown && tabBtn(mdMode, "Markdown", () => setMdMode(true))}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 2px" }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
          {mdMode ? (
            <div
              className="conv-markdown"
              dangerouslySetInnerHTML={{ __html: mdHtml }}
              style={{ color: "var(--text-primary)", fontSize: 13, lineHeight: 1.7 }}
            />
          ) : (
            <pre style={{ ...PRE_STYLE, fontSize: 12.5, maxHeight: "none", background: "none" }}>
              <code className="hljs" dangerouslySetInnerHTML={{ __html: codeHtml }} />
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CopyButton({ getText }: { getText: () => string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const handleCopy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const btn = e.currentTarget;
    const ok = await copyTextDetect(getText());
    if (!ok) {
      // Copy unavailable (plain-HTTP mobile): select the adjacent code block so
      // the user can long-press the selection and copy manually.
      const target = btn.parentElement?.querySelector("pre") ?? btn.parentElement;
      if (target) selectElementContents(target as HTMLElement);
    }
    setState(ok ? "ok" : "fail");
    setTimeout(() => setState("idle"), ok ? 1200 : 3000);
  };
  return (
    <button
      onClick={handleCopy}
      title={state === "fail" ? "自动复制不可用——内容已全选，请长按选区复制" : "Copy"}
      style={{
        position: "absolute", top: 5, right: 6,
        background: "var(--bg-hover)", border: "1px solid var(--border)",
        borderRadius: 4,
        color: state === "ok" ? "#3fb950" : state === "fail" ? "#d29922" : "var(--text-faint)",
        fontSize: 11, fontFamily: "monospace", padding: "1px 7px",
        cursor: "pointer", lineHeight: 1.6, opacity: 0.85,
        transition: "opacity 0.12s, color 0.12s",
      }}
      onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
      onMouseLeave={e => (e.currentTarget.style.opacity = "0.85")}
    >
      {state === "ok" ? "✓" : state === "fail" ? "已全选" : "⧉"}
    </button>
  );
}

// Detect cat -n style numbered output: lines like "   42\tcontent"
const CAT_N_RE = /^ *\d+\t/;
function isNumberedOutput(text: string): boolean {
  const lines = text.split("\n").filter(l => l.length > 0).slice(0, 5);
  return lines.length >= 2 && lines.every(l => CAT_N_RE.test(l));
}

function NumberedLines({ text, isError, showAll, isLarge, lang }: { text: string; isError: boolean; showAll: boolean; isLarge: boolean; lang?: string }) {
  const display = isLarge && !showAll ? text.slice(0, 2000) : text;
  const lines = display.split("\n");
  // Pre-compute widest line number so every row's gutter has the same fixed width
  const maxNumLen = lines.reduce((max, line) => {
    const tab = line.indexOf("\t");
    return tab === -1 ? max : Math.max(max, line.slice(0, tab).trim().length);
  }, 4);
  const gutterW = `${maxNumLen}ch`;
  const useLang = lang && hljs.getLanguage(lang) ? lang : null;
  return (
    <div style={{
      ...PRE_STYLE, padding: "6px 0",
      color: isError ? "#f87171" : "var(--text-primary)",
      maxHeight: showAll ? 600 : 300, overflowY: "auto",
    }}>
      {lines.map((line, i) => {
        const tab = line.indexOf("\t");
        if (tab === -1) {
          return <div key={i} style={{ padding: "0 8px", whiteSpace: "pre" }}>{line || "\u00a0"}</div>;
        }
        const num = line.slice(0, tab);
        const content = line.slice(tab + 1);
        const html = useLang
          ? hljs.highlight(content, { language: useLang, ignoreIllegals: true }).value
          : content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return (
          <div key={i} style={{ display: "flex" }}>
            <span style={{
              flexShrink: 0, minWidth: gutterW, paddingLeft: "8px", paddingRight: "10px",
              textAlign: "right", color: "var(--text-faint)", userSelect: "none",
              whiteSpace: "nowrap",
            }}>{num.trim()}</span>
            <span
              className={useLang ? "hljs" : undefined}
              style={{ flex: 1, minWidth: 0, whiteSpace: "pre", paddingRight: "8px", background: "none" }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        );
      })}
      {isLarge && !showAll && <div style={{ padding: "0 8px", color: "var(--text-faint)" }}>…</div>}
    </div>
  );
}

function CodeBlock({ text, lang, isError = false, allowMarkdown = false }: { text: string; lang: string; isError?: boolean; allowMarkdown?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const isLarge = text.length > JSON_FORMAT_THRESHOLD;
  const numbered = isNumberedOutput(text);

  const html = useMemo(() => {
    if (numbered) return "";
    if (isLarge && !showAll) {
      const preview = text.slice(0, 2000);
      return preview.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    const display = lang === "json" ? (tryFormatJson(text) ?? text) : text;
    return highlightCode(display, lang);
  }, [text, lang, isLarge, showAll, numbered]);

  const btnStyle: React.CSSProperties = {
    background: "var(--bg-surface)", border: "1px solid var(--border)",
    borderRadius: 4, color: "var(--text-secondary)", fontSize: 10.5, fontFamily: "monospace",
    padding: "2px 10px", cursor: "pointer",
  };

  return (
    <div style={{ position: "relative" }}>
      <CopyButton getText={() => text} />
      {numbered
        ? <NumberedLines text={text} isError={isError} showAll={showAll} isLarge={isLarge} lang={lang} />
        : <pre style={{ ...PRE_STYLE, color: isError ? "#f87171" : "var(--text-primary)", maxHeight: showAll ? 600 : 300, overflowY: "auto" }}>
            <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
            {isLarge && !showAll && <span style={{ color: "var(--text-faint)" }}>{"\n…"}</span>}
          </pre>}

      {isLarge && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <button onClick={() => setShowAll((v) => !v)} style={btnStyle}>
            {showAll ? "▲ Collapse" : "All"}
          </button>
          <button onClick={() => setShowModal(true)} style={{ ...btnStyle, color: "var(--accent-blue)" }}>
            Pretty ↗
          </button>
        </div>
      )}
      {showModal && <FormatModal text={text} lang={lang} allowMarkdown={allowMarkdown} onClose={() => setShowModal(false)} />}
    </div>
  );
}

function AssistantMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelectorAll<HTMLPreElement>("pre.conv-code-block").forEach((pre) => {
      if (pre.querySelector(".md-copy-btn")) return;
      const code = pre.querySelector("code");
      if (!code) return;
      pre.style.position = "relative";
      const btn = document.createElement("button");
      btn.className = "md-copy-btn";
      btn.textContent = "⧉";
      btn.title = "Copy";
      btn.style.cssText = [
        "position:absolute", "top:5px", "right:6px",
        "background:var(--bg-hover)", "border:1px solid var(--border)",
        "border-radius:4px", "color:var(--text-faint)",
        "font-size:11px", "font-family:monospace", "padding:1px 7px",
        "cursor:pointer", "line-height:1.6", "opacity:0.85",
        "transition:opacity 0.12s,color 0.12s",
      ].join(";");
      btn.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
      btn.addEventListener("mouseleave", () => { btn.style.opacity = "0.85"; });
      btn.addEventListener("click", async () => {
        const ok = await copyTextDetect(code.textContent ?? "");
        if (ok) {
          btn.textContent = "✓";
          btn.style.color = "#3fb950";
        } else {
          // Copy unavailable (e.g. plain-HTTP mobile where even execCommand is
          // blocked): select the whole block so a long-press can copy it.
          selectElementContents(code);
          btn.textContent = "已全选";
          btn.style.color = "#d29922";
          btn.title = "自动复制不可用——代码已全选，请长按选区复制";
        }
        setTimeout(() => {
          btn.textContent = "⧉";
          btn.style.color = "var(--text-faint)";
          btn.title = "Copy";
        }, ok ? 1200 : 3000);
      });
      pre.appendChild(btn);
    });
  }, [html]);

  return (
    <div
      ref={ref}
      className="conv-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      style={{ padding: "2px 16px", color: "var(--text-primary)", fontSize: "var(--conv-font, 13px)", lineHeight: 1.7 }}
    />
  );
}

// ── Q&A reply block ───────────────────────────────────────────────────────────

/** Extract numbered questions (lines matching "N. ...?" or "N) ...?") from text. */
function parseQuestions(text: string): string[] {
  const qs: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\d+[.)]\s+(.+\?)\s*$/);
    if (m) qs.push(m[1].trim());
  }
  return qs;
}

const _dismissedQA = new Set<string>(); // entry UUIDs whose Q&A block was submitted

function QAReplyBlock({ entryId, questions, onSubmit }: {
  entryId: string;
  questions: string[];
  onSubmit: (text: string) => void;
}) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || _dismissedQA.has(entryId)) return null;

  const setAnswer = (i: number, val: string) => {
    setAnswers(prev => { const n = [...prev]; n[i] = val; return n; });
  };

  const submit = () => {
    const text = questions
      .map((q, i) => `${i + 1}. ${q}\n   ${answers[i].trim() || "(skipped)"}`)
      .join("\n\n");
    _dismissedQA.add(entryId);
    setDismissed(true);
    onSubmit(text);
  };

  return (
    <div style={{
      margin: "6px 16px 2px",
      padding: "10px 12px 12px",
      border: "1px solid var(--bg-hover)",
      borderRadius: 8,
      background: "var(--bg-surface)",
    }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        Answer the following
      </div>
      {questions.map((q, i) => (
        <div key={i} style={{ marginBottom: i < questions.length - 1 ? 10 : 12 }}>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, lineHeight: 1.5 }}>
            <span style={{ color: "var(--text-faint)", marginRight: 5 }}>{i + 1}.</span>{q}
          </div>
          <input
            ref={el => { inputRefs.current[i] = el; }}
            type="text"
            value={answers[i]}
            onChange={e => setAnswer(i, e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (i < questions.length - 1) inputRefs.current[i + 1]?.focus();
                else submit();
              } else if (e.key === "Tab") {
                e.preventDefault();
                const next = e.shiftKey ? i - 1 : i + 1;
                if (next >= 0 && next < questions.length) inputRefs.current[next]?.focus();
              }
            }}
            placeholder="Enter answer… (Enter for next)"
            style={{
              width: "100%", boxSizing: "border-box",
              background: "var(--bg-base)", border: "1px solid var(--text-faintest)",
              borderRadius: 4, padding: "5px 8px",
              color: "var(--text-body)", fontSize: 12, outline: "none",
            }}
          />
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={submit}
          style={{
            fontSize: 12, padding: "4px 16px",
            background: "#1e3a5f", color: "#93c5fd",
            border: "1px solid rgba(88,166,255,0.35)", borderRadius: 4, cursor: "pointer",
          }}
        >
          Submit ↵
        </button>
      </div>
    </div>
  );
}

// ── AskUserQuestion display (read-only, for history) ─────────────────────────

function AskUserQuestionDisplay({ questions, answer }: {
  questions: AskQuestion[];
  answer: string | null; // null = unanswered; non-null = the answer that was sent
}) {
  // Parse answer back to selected labels per question.
  // Claude Code formats the tool_result as:
  //   User has answered your questions: "Q1"="A1", "Q2"="A2", ...
  // Extract answer values in order (order matches questions array).
  const answeredLabels = useMemo((): Set<string>[] => {
    const sets = questions.map(() => new Set<string>());
    if (!answer) return sets;
    const pairRe = /"[^"]*"="([^"]+)"/g;
    let m: RegExpExecArray | null;
    let qi = 0;
    while ((m = pairRe.exec(answer)) !== null && qi < sets.length) {
      for (const part of m[1].split(",").map(s => s.trim())) {
        if (part) sets[qi].add(part);
      }
      qi++;
    }
    // Fallback for single-question plain text
    if (qi === 0 && questions.length === 1) {
      for (const part of answer.split(",").map(s => s.trim())) {
        if (part) sets[0].add(part);
      }
    }
    return sets;
  }, [answer, questions]);

  return (
    <div style={{
      margin: "4px 16px 2px",
      border: "1px solid var(--border-subtle)",
      borderRadius: 8,
      background: "var(--bg-deep)",
      overflow: "hidden",
      opacity: answer !== null ? 0.85 : 1,
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 10px",
        borderBottom: "1px solid var(--border-subtle)",
      }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span style={{ fontSize: 10.5, color: "var(--text-muted)", flex: 1 }}>
          {questions.length === 1 ? (questions[0]?.header || "Agent Question") : "Agent Question"}
        </span>
        {answer !== null && (
          <span style={{ fontSize: 10, color: "var(--accent-green)", display: "flex", alignItems: "center", gap: 3 }}>
            <span>✓</span> Answered
          </span>
        )}
      </div>

      {/* Questions */}
      <div style={{ padding: "8px 10px 10px", display: "flex", flexDirection: "column", gap: 10 }}>
        {questions.map((q, qi) => {
          // For answered AUQs we keep every option's description + preview visible
          // so the historical decision can be re-read in full context. Chosen options
          // get accent styling, others get muted styling to preserve the hierarchy.
          const optionsWithDescription = q.options.filter(o => o.description);
          const optionsWithPreview = q.options.filter(o => o.preview);
          return (
            <div key={qi}>
              {questions.length > 1 && q.header && (
                <div style={{ fontSize: 10, color: "var(--accent-blue)", fontWeight: 600, marginBottom: 2 }}>{q.header}</div>
              )}
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6, lineHeight: 1.5 }}>{q.question}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                {q.options.map(opt => {
                  const chosen = answeredLabels[qi]?.has(opt.label);
                  return (
                    <div
                      key={opt.label}
                      title={opt.description}
                      style={{
                        padding: "3px 9px",
                        borderRadius: 4,
                        fontSize: 11,
                        border: `1px solid ${chosen ? "var(--accent-blue)" : "var(--border)"}`,
                        background: chosen ? "rgba(83,155,245,0.12)" : "transparent",
                        color: chosen ? "var(--accent-blue)" : "var(--text-faint)",
                        fontWeight: chosen ? 600 : 400,
                      }}
                    >
                      {chosen && <span style={{ marginRight: 4 }}>✓</span>}
                      {opt.label}
                    </div>
                  );
                })}
                {answer !== null && (() => {
                  const custom = [...(answeredLabels[qi] ?? [])].filter(l => !q.options.find(o => o.label === l));
                  if (custom.length === 0) return null;
                  return (
                    <>
                      <span style={{ color: "var(--border-strong)", fontSize: 13, userSelect: "none", padding: "0 2px" }}>|</span>
                      <div style={{
                        padding: "3px 9px", borderRadius: 4, fontSize: 11,
                        border: "1px solid var(--accent-blue)",
                        background: "rgba(83,155,245,0.08)",
                        color: "var(--accent-blue)",
                      }}>
                        {custom.join(", ")}
                      </div>
                    </>
                  );
                })()}
              </div>
              {/* Descriptions for every option — chosen ones in accent blue,
                  others muted, so re-reading the history shows the full picture. */}
              {optionsWithDescription.map(opt => {
                const chosen = answeredLabels[qi]?.has(opt.label);
                return (
                  <div
                    key={opt.label}
                    style={{
                      marginTop: 4,
                      fontSize: 11,
                      color: chosen ? "var(--text-muted)" : "var(--text-faint)",
                      lineHeight: 1.5,
                      paddingLeft: 4,
                      borderLeft: `2px solid ${chosen ? "var(--accent-blue)" : "var(--border-subtle)"}`,
                      marginLeft: 2,
                    }}
                  >
                    <span style={{ color: chosen ? "var(--accent-blue)" : "var(--text-muted)", fontWeight: 600, marginRight: 4 }}>{opt.label}:</span>
                    {opt.description}
                  </div>
                );
              })}
              {/* Previews for every option — kept full-fidelity so unicode box art
                  / mockups stay legible in history. */}
              {optionsWithPreview.map(opt => {
                const chosen = answeredLabels[qi]?.has(opt.label);
                return (
                  <pre
                    key={opt.label}
                    style={{
                      marginTop: 6, marginBottom: 0,
                      padding: "6px 8px",
                      background: "var(--bg-deep)",
                      border: `1px solid ${chosen ? "var(--accent-blue)" : "var(--border-subtle)"}`,
                      borderRadius: 4,
                      fontSize: 10.5, lineHeight: 1.35,
                      color: chosen ? "var(--text-secondary)" : "var(--text-faint)",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                      overflow: "auto",
                      whiteSpace: "pre",
                      opacity: chosen ? 1 : 0.75,
                    }}
                  >{opt.preview}</pre>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── AskUserQuestion interactive block ────────────────────────────────────────

interface AskOption { label: string; description?: string; preview?: string }
interface AskQuestion { id?: string; header?: string; question: string; multiSelect?: boolean; options: AskOption[] }

// Persist dismissed block IDs in sessionStorage so page refreshes don't re-show
// answered questions while Claude Code is still processing the response.
//
// Both stores below are MODULE-LEVEL (shared by every ConversationPane mount).
// Without namespacing by sessionId, dismissing "Continue?" in session A would
// suppress the same-text AUQ in session B. The pending blockId itself
// ("__pending_auq__:" + question) also collides cross-session, so blockIds
// are namespaced the same way.
const _AUQ_SS_KEY = "cm_auq_dismissed";
function _auqLoadDismissed(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(_AUQ_SS_KEY) || "[]")); }
  catch { return new Set(); }
}
function _auqPersist(set: Set<string>) {
  try { sessionStorage.setItem(_AUQ_SS_KEY, JSON.stringify([...set])); } catch {}
}
const _dismissedAUQ = _auqLoadDismissed();
// Tracks recently dismissed AUQs so the JSONL widget and the hook-based
// pendingAuqData widget cross-suppress each other while the two signals
// settle. Cleared after a short window to avoid suppressing a future re-ask.
const _recentlyDismissedAuqQ = new Map<string, number>(); // nsKey → timestamp
const _AUQ_SUPPRESS_MS = 15000;
// U+0001 (SOH) is a control char that cannot appear in user-typed questions
// or tool_use ids. sessionStorage round-trips it as the JSON escape \u0001.
function _nsKey(sessionId: string, key: string): string {
  return sessionId + "" + key;
}
function _markAuqDismissed(sessionId: string, question: string) {
  _recentlyDismissedAuqQ.set(_nsKey(sessionId, question), Date.now());
}
function _isAuqRecentlyDismissed(sessionId: string, question: string): boolean {
  const k = _nsKey(sessionId, question);
  const t = _recentlyDismissedAuqQ.get(k);
  if (!t) return false;
  if (Date.now() - t > _AUQ_SUPPRESS_MS) {
    _recentlyDismissedAuqQ.delete(k);
    return false;
  }
  return true;
}
function _isAuqBlockDismissed(sessionId: string, blockId: string): boolean {
  return _dismissedAUQ.has(_nsKey(sessionId, blockId));
}
function _markAuqBlockDismissed(sessionId: string, blockId: string) {
  _dismissedAUQ.add(_nsKey(sessionId, blockId));
  _auqPersist(_dismissedAUQ);
}

// ── TodoWrite / TodoRead ──────────────────────────────────────────────────────

interface TodoItem { id?: string; content: string; description?: string; status: "pending" | "in_progress" | "completed"; priority?: "high" | "medium" | "low" }

function TodoListBlock({ block, result }: {
  block: RawContentBlock;
  result?: { content: string; isError: boolean };
}) {
  const [expanded, setExpanded] = useState(true);
  const input = (block.input as Record<string, unknown>) || {};
  const name = (block.name as string) || "TodoWrite";

  // TodoRead: show result todos if available; TodoWrite: show input todos
  let todos: TodoItem[] = [];
  if (name === "TodoRead" && result?.content) {
    try { todos = JSON.parse(result.content); } catch { todos = []; }
  } else if (Array.isArray(input.todos)) {
    todos = input.todos as TodoItem[];
  }

  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.filter((t) => t.status === "in_progress").length;
  const total = todos.length;

  const statusIcon = (s: TodoItem["status"]) =>
    s === "completed" ? "✓" : s === "in_progress" ? "▶" : "○";
  const statusColor = (s: TodoItem["status"]) =>
    s === "completed" ? "var(--accent-green)" : s === "in_progress" ? "var(--accent-amber)" : "var(--text-faint)";

  return (
    <div style={{ padding: "2px 16px" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", background: "var(--bg-surface)", border: "1px solid var(--bg-hover)",
          borderRadius: expanded ? "6px 6px 0 0" : 6, padding: "6px 10px",
          cursor: "pointer", gap: 8, textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: "var(--conv-font-sm, 11px)", marginRight: 1 }}>📋</span>
          <span style={{ fontFamily: "monospace", fontSize: "var(--conv-font, 12.5px)", fontWeight: 700, color: "var(--text-bright)", flexShrink: 0 }}>
            {name}
          </span>
          {total > 0 && (
            <>
              {/* Progress bar */}
              <div style={{ width: 48, height: 4, borderRadius: 2, background: "var(--bg-hover)", overflow: "hidden", flexShrink: 0, position: "relative" }}>
                {done > 0 && <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${(done / total) * 100}%`, background: "var(--accent-green)", borderRadius: 2 }} />}
                {active > 0 && <div style={{ position: "absolute", left: `${(done / total) * 100}%`, top: 0, height: "100%", width: `${(active / total) * 100}%`, background: "#f59e0b66", borderRadius: 2 }} />}
              </div>
              <span style={{ fontFamily: "monospace", fontSize: "var(--conv-font-sm, 11px)", color: "var(--text-muted)" }}>{done}/{total}</span>
              {active > 0 && <span style={{ fontSize: 10, color: "var(--accent-amber)", background: "#f59e0b18", border: "1px solid #f59e0b40", borderRadius: 3, padding: "0 5px" }}>{active} active</span>}
            </>
          )}
        </div>
        <span style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div style={{
          background: "var(--bg-base)", border: "1px solid var(--bg-hover)", borderTop: "none",
          borderRadius: "0 0 6px 6px", padding: "6px 10px", display: "flex", flexDirection: "column", gap: 1,
        }}>
          {todos.length === 0 ? (
            <div style={{ fontSize: "var(--conv-font-sm, 11px)", color: "var(--text-faint)", padding: "2px 0" }}>No todos</div>
          ) : todos.map((todo, i) => (
            <div key={todo.id ?? i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "3px 0" }}>
              <span style={{ fontSize: "var(--conv-font-sm, 11px)", color: statusColor(todo.status), flexShrink: 0, marginTop: 1, fontFamily: "monospace" }}>
                {statusIcon(todo.status)}
              </span>
              <span style={{
                fontSize: "var(--conv-font, 12.5px)", lineHeight: 1.5, flex: 1,
                color: todo.status === "completed" ? "var(--text-faint)" : "var(--text-secondary)",
              }}>
                {todo.content}
              </span>
              {todo.priority && (
                <span style={{ fontSize: 9, flexShrink: 0, padding: "1px 5px", borderRadius: 3, fontFamily: "monospace", fontWeight: 700, letterSpacing: "0.3px",
                  background: todo.priority === "high" ? "#7f1d1d40" : todo.priority === "medium" ? "#78350f40" : "var(--bg-surface)",
                  color: todo.priority === "high" ? "#fca5a5" : todo.priority === "medium" ? "#fcd34d" : "var(--text-faint)",
                }}>
                  {todo.priority[0].toUpperCase()}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── TaskCreate / TaskUpdate — task group ─────────────────────────────────────

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop", "TaskOutput"]);

interface TaskUpdateLog { status?: string; blockedBy?: string[]; subject?: string; description?: string }
interface TaskState {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  updates: TaskUpdateLog[];
}

function buildTaskStates(blocks: RawContentBlock[]): TaskState[] {
  const tasks: TaskState[] = [];
  let nextId = 1;
  for (const b of blocks) {
    const name = b.name as string;
    const inp = (b.input as Record<string, unknown>) || {};
    if (name === "TaskCreate") {
      tasks.push({
        id: String(nextId++),
        subject: String(inp.subject ?? inp.title ?? `Task ${tasks.length + 1}`),
        description: inp.description ? String(inp.description) : undefined,
        status: "pending",
        updates: [],
      });
    } else if (name === "TaskUpdate") {
      const tid = String(inp.taskId ?? "");
      const task = tasks.find((t) => t.id === tid);
      if (task) {
        const log: TaskUpdateLog = {};
        if (inp.status) { task.status = inp.status as TaskState["status"]; log.status = String(inp.status); }
        if (inp.subject) { task.subject = String(inp.subject); log.subject = String(inp.subject); }
        if (inp.description) { task.description = String(inp.description); log.description = String(inp.description); }
        if (Array.isArray(inp.addBlockedBy) && inp.addBlockedBy.length > 0) {
          log.blockedBy = (inp.addBlockedBy as unknown[]).map(String);
        }
        if (Object.keys(log).length > 0) task.updates.push(log);
      }
    }
  }
  return tasks;
}

function TaskUpdateEntry({ log }: { log: TaskUpdateLog }) {
  const [descExpanded, setDescExpanded] = useState(false);
  const DESC_PREVIEW = 120;

  const statusColor =
    log.status === "completed" ? "#4ade80"
    : log.status === "failed" ? "#f87171"
    : log.status === "in_progress" ? "#60a5fa"
    : "var(--text-faint)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, lineHeight: 1.4 }}>
      {log.status && (
        <div style={{ color: statusColor, fontFamily: "monospace" }}>→ {log.status}</div>
      )}
      {log.blockedBy && log.blockedBy.length > 0 && (
        <div style={{ color: "#fb923c" }}>blocked by: #{log.blockedBy.join(", #")}</div>
      )}
      {log.subject && (
        <div style={{ color: "var(--text-secondary)", wordBreak: "break-word" }}>
          <span style={{ color: "var(--text-faint)", marginRight: 4 }}>subject:</span>{log.subject}
        </div>
      )}
      {log.description && (
        <div style={{ color: "var(--text-faint)", wordBreak: "break-word" }}>
          <span style={{ marginRight: 4 }}>desc:</span>
          {log.description.length <= DESC_PREVIEW || descExpanded
            ? log.description
            : log.description.slice(0, DESC_PREVIEW) + "…"}
          {log.description.length > DESC_PREVIEW && (
            <button
              onClick={() => setDescExpanded(e => !e)}
              style={{ marginLeft: 4, fontSize: 10, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              {descExpanded ? "less" : "more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TaskGroupBlock({ blocks }: { blocks: RawContentBlock[] }) {
  const [expanded, setExpanded] = useState(false);
  const tasks = buildTaskStates(blocks);

  const done = tasks.filter((t) => t.status === "completed").length;
  const active = tasks.filter((t) => t.status === "in_progress").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const total = tasks.length;

  const updateOps = blocks.filter((b) => b.name === "TaskUpdate").length;

  const statusIcon = (s: TaskState["status"]) =>
    s === "completed" ? "✓" : s === "in_progress" ? "▶" : s === "failed" ? "✗" : "○";
  const statusColor = (s: TaskState["status"]) =>
    s === "completed" ? "var(--accent-green)"
    : s === "in_progress" ? "var(--accent-amber)"
    : s === "failed" ? "var(--accent-red)"
    : "var(--text-faint)";

  const summary = total > 0
    ? `${total} task${total > 1 ? "s" : ""}${done > 0 ? ` · ${done}/${total} done` : ""}${active > 0 ? ` · ${active} active` : ""}${failed > 0 ? ` · ${failed} failed` : ""}`
    : updateOps > 0
      ? `${updateOps} update${updateOps !== 1 ? "s" : ""}`
      : `${blocks.length} op${blocks.length !== 1 ? "s" : ""}`;

  return (
    <div style={{ padding: "2px 16px" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", background: "var(--bg-surface)", border: "1px solid var(--bg-hover)",
          borderRadius: expanded ? "6px 6px 0 0" : 6, padding: "6px 10px",
          cursor: "pointer", gap: 8, textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: "var(--conv-font-sm, 11px)", marginRight: 1 }}>⎇</span>
          <span style={{ fontFamily: "monospace", fontSize: "var(--conv-font, 12.5px)", fontWeight: 700, color: "var(--text-bright)", flexShrink: 0 }}>Tasks</span>
          {total > 0 && (
            <div style={{ width: 48, height: 4, borderRadius: 2, background: "var(--bg-hover)", overflow: "hidden", flexShrink: 0, position: "relative" }}>
              {done > 0 && <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${(done / total) * 100}%`, background: "var(--accent-green)", borderRadius: 2 }} />}
              {active > 0 && <div style={{ position: "absolute", left: `${(done / total) * 100}%`, top: 0, height: "100%", width: `${(active / total) * 100}%`, background: "#f59e0b66", borderRadius: 2 }} />}
              {failed > 0 && <div style={{ position: "absolute", right: 0, top: 0, height: "100%", width: `${(failed / total) * 100}%`, background: "#f8714866", borderRadius: 2 }} />}
            </div>
          )}
          <span style={{ fontFamily: "monospace", fontSize: "var(--conv-font-sm, 11px)", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {summary}
          </span>
        </div>
        <span style={{ fontSize: "var(--conv-font-xs, 10px)", color: "var(--text-faint)", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div style={{
          background: "var(--bg-base)", border: "1px solid var(--bg-hover)", borderTop: "none",
          borderRadius: "0 0 6px 6px", padding: "6px 10px", display: "flex", flexDirection: "column", gap: 1,
        }}>
          {tasks.length === 0 ? (
            blocks.map((b, i) => {
              const inp = (b.input as Record<string, unknown>) || {};
              if (b.name === "TaskUpdate") {
                const tid = String(inp.taskId ?? "?");
                const log: TaskUpdateLog = {};
                if (inp.status) log.status = String(inp.status);
                if (inp.subject) log.subject = String(inp.subject);
                if (inp.description) log.description = String(inp.description);
                if (Array.isArray(inp.addBlockedBy) && inp.addBlockedBy.length > 0)
                  log.blockedBy = (inp.addBlockedBy as unknown[]).map(String);
                return (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--bg-hover)" }}>
                    <span style={{ fontSize: "var(--conv-font-xs, 10px)", color: "var(--text-faint)", flexShrink: 0, marginTop: 3, fontFamily: "monospace", minWidth: 14, textAlign: "right" }}>
                      #{tid}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <TaskUpdateEntry log={log} />
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} style={{ fontSize: "var(--conv-font-sm, 11px)", color: "var(--text-muted)", padding: "2px 0", fontFamily: "monospace" }}>
                  {b.name as string}
                </div>
              );
            })
          ) : tasks.map((task) => (
            <div key={task.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--bg-hover)" }}>
              <span style={{ fontSize: "var(--conv-font-xs, 10px)", color: "var(--text-faint)", flexShrink: 0, marginTop: 3, fontFamily: "monospace", minWidth: 14, textAlign: "right" }}>
                {task.id}
              </span>
              <span style={{ fontSize: "var(--conv-font-sm, 11px)", color: statusColor(task.status), flexShrink: 0, marginTop: 2, fontFamily: "monospace" }}>
                {statusIcon(task.status)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: "var(--conv-font, 12.5px)", lineHeight: 1.5,
                  color: task.status === "completed" ? "var(--text-faint)" : "var(--text-secondary)",
                  wordBreak: "break-word",
                }}>
                  {task.subject}
                </div>
                {task.description && (
                  <div style={{ fontSize: "var(--conv-font-sm, 11px)", color: "var(--text-faint)", lineHeight: 1.4, marginTop: 1, wordBreak: "break-word", opacity: task.status === "completed" ? 0.75 : 1 }}>
                    {task.description}
                  </div>
                )}
                {task.updates.length > 0 && (
                  <div style={{ marginTop: 4, borderLeft: "2px solid var(--bg-hover)", paddingLeft: 6, display: "flex", flexDirection: "column", gap: 3 }}>
                    {task.updates.map((u, ui) => (
                      <TaskUpdateEntry key={ui} log={u} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ExitPlanMode — plan approval ──────────────────────────────────────────────

const _PLAN_SS_KEY = "cm_plan_dismissed";
function _planLoadDismissed(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(_PLAN_SS_KEY) || "[]")); }
  catch { return new Set(); }
}
function _planPersist(set: Set<string>) {
  try { sessionStorage.setItem(_PLAN_SS_KEY, JSON.stringify([...set])); } catch {}
}
const _dismissedPlan = _planLoadDismissed();

// Module-level cache for plan-file contents keyed by absolute path. Survives
// PlanApprovalBlock/PlanHistoryBlock remounts that happen when the
// displayEntries position briefly stops being `isLast` (e.g. a transient
// compact_boundary or stop-hook user entry lands after ExitPlanMode), so the
// body is shown immediately instead of cycling back to "Loading plan…".
const _planContentCache = new Map<string, string>();

function PlanHistoryBlock({ planText, planPath, approved, feedback }: {
  planText?: string;
  planPath?: string;
  approved: boolean;
  feedback?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fetched, setFetched] = useState<string | undefined>(
    planPath ? _planContentCache.get(planPath) : undefined,
  );
  // If the tool input didn't carry plan text, lazy-fetch from disk via the
  // file path captured when Claude wrote the plan. Fetch on first expand so
  // collapsed history rows don't fan out N requests.
  useEffect(() => {
    if (planText || fetched || !planPath || !expanded) return;
    let cancelled = false;
    readClaudePlan(planPath)
      .then(r => { if (!cancelled) { _planContentCache.set(planPath, r.content); setFetched(r.content); } })
      .catch(() => { if (!cancelled) setFetched(""); });
    return () => { cancelled = true; };
  }, [planText, planPath, expanded, fetched]);
  const body = planText ?? fetched;
  const hasPlan = !!planText || !!planPath;

  return (
    <div style={{ margin: "2px 16px", border: `1px solid ${approved ? "#166534" : "#7f1d1d"}`, borderRadius: 8, overflow: "hidden", background: "var(--bg-surface)" }}>
      <button
        onClick={() => hasPlan && setExpanded(!expanded)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 8,
          padding: "7px 14px", background: approved ? "#0a1f0a" : "#1a0808",
          border: "none", cursor: hasPlan ? "pointer" : "default", textAlign: "left",
        }}
      >
        <span style={{ color: approved ? "#4ade80" : "#f87171", fontSize: 14 }}>{approved ? "✓" : "✗"}</span>
        <span style={{ fontWeight: 600, fontSize: 13, color: approved ? "#86efac" : "#fca5a5", flex: 1 }}>
          Plan {approved ? "approved" : "rejected"}
        </span>
        {feedback && <span style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>{feedback}</span>}
        {hasPlan && <span style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>}
      </button>
      {expanded && (
        body ? (
          <div
            className="conv-markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
            style={{ padding: "12px 16px", maxHeight: "55vh", overflowY: "auto", fontSize: 13, lineHeight: 1.65, borderTop: `1px solid ${approved ? "#166534" : "#7f1d1d"}` }}
          />
        ) : (
          <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic", borderTop: `1px solid ${approved ? "#166534" : "#7f1d1d"}` }}>
            {planPath ? "Loading plan…" : "Plan body unavailable"}
          </div>
        )
      )}
    </div>
  );
}

// ── Tool Approval Block ──────────────────────────────────────────────────────
function ToolApprovalBlock({ sessionId, toolName, toolInput, onDone }: {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const decide = async (decision: "allow" | "deny") => {
    setBusy(true);
    try { await approveToolRequest(sessionId, decision); } catch {}
    setDismissed(true);
    onDone();
  };

  const toolIcons: Record<string, string> = {
    Bash: "⚡", Write: "✏️", Edit: "✏️", MultiEdit: "✏️",
    Read: "📄", WebFetch: "🌐", WebSearch: "🔍",
  };
  const icon = toolIcons[toolName] ?? "🔧";

  const detail = (() => {
    const input = (toolInput && typeof toolInput === "object") ? toolInput : {};
    if (toolName === "Bash") return String(input.command ?? "");
    if (toolName === "Write" || toolName === "Read") return String(input.file_path ?? "");
    if (toolName === "Edit" || toolName === "MultiEdit") return String(input.file_path ?? "");
    if (toolName === "WebFetch") return String(input.url ?? "");
    if (toolName === "WebSearch") return String(input.query ?? "");
    const first = Object.values(input)[0];
    return first != null ? String(first) : "";
  })();

  return (
    <div style={{
      margin: "8px 16px", borderRadius: 10,
      border: "1px solid rgba(234,179,8,0.35)",
      background: "rgba(234,179,8,0.06)",
      overflow: "hidden",
    }}>
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15 }}>{icon}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-body)" }}>
            Claude wants to {toolName === "Bash" ? "run a command" : toolName === "WebFetch" ? "fetch a URL" : toolName === "WebSearch" ? "search the web" : `use ${toolName}`}
          </span>
        </div>
        {detail && (
          <code style={{
            display: "block", fontSize: 12, fontFamily: "monospace",
            background: "var(--bg-main)", padding: "6px 10px", borderRadius: 6,
            color: "var(--text-secondary)", wordBreak: "break-all",
            maxHeight: 120, overflowY: "auto", whiteSpace: "pre-wrap",
          }}>
            {detail.length > 500 ? detail.slice(0, 500) + "…" : detail}
          </code>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            disabled={busy}
            onClick={() => decide("allow")}
            style={{
              flex: 1, padding: "7px 0", borderRadius: 7, fontSize: 13, fontWeight: 600,
              background: "rgba(34,197,94,0.15)", color: "#4ade80",
              border: "1px solid rgba(34,197,94,0.35)", cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            ✓ Allow
          </button>
          <button
            disabled={busy}
            onClick={() => decide("deny")}
            style={{
              flex: 1, padding: "7px 0", borderRadius: 7, fontSize: 13, fontWeight: 600,
              background: "rgba(239,68,68,0.1)", color: "#f87171",
              border: "1px solid rgba(239,68,68,0.3)", cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            ✕ Deny
          </button>
        </div>
      </div>
    </div>
  );
}

// PlanChoice is what PlanApprovalBlock asks the parent to send: either an
// explicit menu option (label/index, parsed live from the TUI) or the legacy
// approve/reject intent when no real options are available.
type PlanChoice = { decision?: "approve" | "reject"; label?: string; index?: number; feedback?: string };
type PlanMenuOption = { index: number; label: string; highlighted: boolean };

// isApproveLabel classifies a menu option as a "go ahead" (green) vs a decline
// (red) for button tinting — purely cosmetic; the backend matches by label.
const isApproveLabel = (l: string) => /^\s*yes\b|bypass|accept edits/i.test(l) && !/^\s*no\b/i.test(l);
// isTellClaudeLabel marks the option that opens a freeform "what to change" field
// — picking it should collect text from the user, not submit blank.
const isTellClaudeLabel = (l: string) => /tell claude/i.test(l);

function PlanApprovalBlock({ blockId, planText, planPath, options, onSubmit }: {
  blockId: string;
  planText?: string;
  planPath?: string;
  options?: PlanMenuOption[];
  onSubmit: (choice: PlanChoice) => Promise<void>;
}) {
  const [dismissed, setDismissed] = useState(false);
  // Two-stage confirmation: the first click parks the chosen option/intent in
  // `confirm` so a stray click can't fire a Claude CLI keystroke sequence; the
  // user must click the second confirm to actually send it.
  // confirm === null  → showing the option list / Approve-Reject buttons
  // confirm.kind="opt"→ awaiting confirm for a specific menu option
  // confirm.kind="legacy" → awaiting confirm for an approve/reject intent
  type Confirm =
    | null
    | { kind: "opt"; index: number; label: string }
    | { kind: "legacy"; decision: "approve" | "reject" };
  const [confirm, setConfirm] = useState<Confirm>(null);
  // Freeform "what to change" text, collected when the pending choice opens the
  // Tell-Claude field. Sent verbatim to the backend, which types it into the TUI.
  const [feedback, setFeedback] = useState("");
  const [fetched, setFetched] = useState<string | undefined>(
    planPath ? _planContentCache.get(planPath) : undefined,
  );
  const [fetchError, setFetchError] = useState<string | undefined>(undefined);
  // Fetch the plan body from disk when the tool input lacks it. This is the
  // common case now — ExitPlanMode no longer ships the plan text in its
  // arguments; the file path is the only handle.
  useEffect(() => {
    if (planText || fetched || !planPath) return;
    let cancelled = false;
    readClaudePlan(planPath)
      .then(r => { if (!cancelled) { _planContentCache.set(planPath, r.content); setFetched(r.content); } })
      .catch(e => { if (!cancelled) setFetchError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [planText, planPath, fetched]);
  const body = planText ?? fetched;

  if (dismissed || _dismissedPlan.has(blockId)) return null;

  const submit = (choice: PlanChoice) => {
    // Optimistically nothing: only dismiss the card once the backend confirms it
    // actually resolved the modal. On failure (e.g. 409 — the on-screen menu was
    // not a recognized ExitPlanMode prompt) keep the card so the user can retry
    // or fall back to the terminal; the parent surfaces the error as a toast.
    onSubmit(choice)
      .then(() => {
        _dismissedPlan.add(blockId);
        _planPersist(_dismissedPlan);
        setDismissed(true);
      })
      .catch(() => {
        setConfirm(null);
      });
  };

  const hasOptions = !!options && options.length > 0;

  const baseBtn: React.CSSProperties = {
    fontSize: 12, padding: "5px 14px", borderRadius: 5, cursor: "pointer", fontWeight: 600, border: "1px solid transparent",
  };

  return (
    <div style={{ margin: "4px 16px 8px", border: "1px solid #4c1d95", borderRadius: 8, overflow: "hidden", background: "var(--bg-surface)" }}>
      {/* Header */}
      <div style={{ padding: "7px 14px", borderBottom: "1px solid #2a1f3d", display: "flex", alignItems: "center", gap: 8, background: "#160c2a" }}>
        <span style={{ color: "#8b5cf6", fontSize: 14 }}>✓</span>
        <span style={{ fontWeight: 600, fontSize: 13, color: "#c4b5fd" }}>Plan ready for approval</span>
        <span style={{ fontSize: 10, color: "#6d28d9", marginLeft: "auto", fontFamily: "monospace" }}>ExitPlanMode</span>
      </div>
      {/* Plan content. Body resolves from the tool input (legacy) or, when
          absent, from the on-disk plan file fetched via planPath. */}
      {body && (
        <div
          className="conv-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
          style={{ padding: "12px 16px", maxHeight: "55vh", overflowY: "auto", fontSize: 13, lineHeight: 1.65, borderBottom: "1px solid #2a1f3d" }}
        />
      )}
      {!body && (
        <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic", borderBottom: "1px solid #2a1f3d" }}>
          {fetchError
            ? `Could not load plan file: ${fetchError}`
            : planPath
              ? "Loading plan…"
              : "Plan body not available — approve to view via tool result"}
        </div>
      )}
      {/* Actions. When the live TUI menu options are known (tui_plan_data) we
          render them verbatim, like AskUserQuestion — so the user can pick any
          real option, not just a binary approve/reject. Otherwise we fall back
          to the legacy Approve/Reject intent pair. */}
      <div style={{ padding: "8px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
        {/* Confirmation step (shared by option + legacy paths). When the pending
            choice opens the "Tell Claude what to change" field, collect freeform
            text and send it along; otherwise it's a simple confirm. */}
        {confirm !== null && (() => {
          const wantsFeedback = confirm.kind === "opt" ? isTellClaudeLabel(confirm.label) : confirm.decision === "reject";
          const payload: PlanChoice = confirm.kind === "opt"
            ? { label: confirm.label, index: confirm.index }
            : { decision: confirm.decision };
          if (wantsFeedback) payload.feedback = feedback.trim();
          const fire = () => submit(payload);
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {wantsFeedback
                  ? <>告诉 Claude 要改什么（留空则仅退回继续规划）：</>
                  : <>Send: <b style={{ color: "#c4b5fd" }}>{confirm.kind === "opt" ? confirm.label : confirm.decision === "approve" ? "Approve" : "Reject"}</b>?</>}
              </span>
              {wantsFeedback && (
                <textarea
                  autoFocus
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fire(); } }}
                  placeholder="例如：把缓存层换成 Redis，并补上失败重试…（⌘/Ctrl+Enter 发送）"
                  rows={3}
                  style={{
                    width: "100%", boxSizing: "border-box", resize: "vertical",
                    fontSize: 13, lineHeight: 1.5, padding: "7px 9px", borderRadius: 6,
                    background: "var(--bg-input, #0f0a1e)", color: "var(--text-primary)",
                    border: "1px solid #4c1d95", fontFamily: "inherit",
                  }}
                />
              )}
              {/* Left-aligned with Confirm first so the second click lands right
                  under the option you just picked — no travel to the far right. */}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-start" }}>
                <button onClick={fire} style={{ ...baseBtn, background: "#1a2a3a", color: "#93c5fd", borderColor: "#1e40af" }}>
                  {wantsFeedback ? "发送给 Claude" : "Confirm"}
                </button>
                <button onClick={() => setConfirm(null)} style={{ ...baseBtn, background: "var(--bg-hover)", color: "var(--text-secondary)", borderColor: "var(--border)" }}>Cancel</button>
              </div>
            </div>
          );
        })()}

        {/* Option list (real TUI menu) */}
        {confirm === null && hasOptions && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {options!.map((o) => {
              const approve = isApproveLabel(o.label);
              return (
                <button
                  key={o.index}
                  onClick={() => setConfirm({ kind: "opt", index: o.index, label: o.label })}
                  style={{
                    ...baseBtn,
                    textAlign: "left",
                    fontWeight: 500,
                    background: approve ? "#13240f" : "#241010",
                    color: approve ? "#86efac" : "#fca5a5",
                    borderColor: approve ? "#166534" : "#7f1d1d",
                  }}
                >
                  {o.highlighted ? "❯ " : ""}{o.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Legacy fallback when the live menu isn't available */}
        {confirm === null && !hasOptions && (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirm({ kind: "legacy", decision: "reject" })} style={{ ...baseBtn, background: "#3a1a1a", color: "#f87171", borderColor: "#7f1d1d" }}>Reject</button>
            <button onClick={() => setConfirm({ kind: "legacy", decision: "approve" })} style={{ ...baseBtn, background: "#1a3a1a", color: "#4ade80", borderColor: "#166534" }}>Approve ✓</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function AskUserQuestionBlock({ sessionId, blockId, questions, onSubmitAnswers, maxHeight }: {
  sessionId: string;
  blockId: string;
  questions: AskQuestion[];
  onSubmitAnswers: (answers: unknown[]) => void;
  // Cap for the whole card; the question body scrolls within it. Defaults to a
  // viewport-based limit, but the pinned mobile usage passes half the chat
  // pane's measured height so it can never bury the chat history behind it.
  maxHeight?: string | number;
}) {
  const total = questions.length;
  // step: which question we're on (wizard mode for multi-question)
  const [step, setStep] = useState(0);
  // per-question: selected option labels
  const [selections, setSelections] = useState<Set<string>[]>(() => questions.map(() => new Set()));
  // per-question: custom "Other / Type Something" free-text
  const [customs, setCustoms] = useState<string[]>(() => questions.map(() => ""));
  // per-question: user-forced multi-select override (for originally single-select questions)
  const [multiOverrides, setMultiOverrides] = useState<boolean[]>(() => questions.map(() => false));
  const [dismissed, setDismissed] = useState(false);
  const otherRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const q = questions[Math.min(step, total - 1)];
  const isLast = step === total - 1;
  const effectiveMulti = (q.multiSelect ?? false) || multiOverrides[step];
  const canToggleMode = !(q.multiSelect ?? false); // only when originally single-select

  const curSelections = selections[step] ?? new Set<string>();
  const curCustom = customs[step] ?? "";
  const hasAnswer = curSelections.size > 0 || curCustom.trim().length > 0;
  const allAnswered = questions.every((_, i) => (selections[i]?.size ?? 0) > 0 || (customs[i]?.trim().length ?? 0) > 0);

  const questionHtml = useMemo(() => renderMarkdown(q.question), [q.question]);

  // Cross-suppress between JSONL widget and hook-based pending widget (different
  // blockIds, same question). Without this a race surfaces an "unsubmitted" flash:
  // tool_result arrives in JSONL refresh (so hasUnansweredAuq flips false) before
  // the 3s tui status poll clears pendingAuqData → pending widget renders fresh.
  const _qText = questions[0]?.question ?? "";
  if (dismissed || _isAuqBlockDismissed(sessionId, blockId) || _isAuqRecentlyDismissed(sessionId, _qText)) return null;

  const toggleOption = (label: string) => {
    setSelections(prev => {
      const next = prev.map(s => new Set(s));
      if (effectiveMulti) {
        if (next[step].has(label)) next[step].delete(label); else next[step].add(label);
      } else {
        next[step] = new Set([label]);
      }
      return next;
    });
  };

  const setCustom = (val: string) => {
    setCustoms(prev => { const n = [...prev]; n[step] = val; return n; });
    // For single-select: typing in Other clears the previously selected option
    if (!effectiveMulti && val.trim()) {
      setSelections(prev => { const n = prev.map(s => new Set(s)); n[step] = new Set(); return n; });
    }
  };

  // Build answer for ONE question:
  //   single-select/text → string
  //   multi-select       → array of explicit TUI action objects, one per row, in order
  const buildAnswer = (qi: number, sels: Set<string>, custom: string) => {
    const q_i = questions[qi];
    const isMulti = (q_i.multiSelect ?? false) || multiOverrides[qi];
    if (isMulti) {
      return [
        ...q_i.options.map(opt => ({ type: "option" as const, click: sels.has(opt.label) })),
        { type: "type_something" as const, value: custom.trim() },
        { type: "submit" as const },
      ];
    }
    if (custom.trim()) return custom.trim();
    return [...sels][0] ?? q_i.options[0]?.label ?? "";
  };

  const _dismiss = () => {
    _markAuqBlockDismissed(sessionId, blockId);
    _markAuqDismissed(sessionId, _qText);
    setDismissed(true);
  };

  const doSubmit = () => {
    _dismiss();
    const answers = Array.from({ length: total }, (_, i) =>
      buildAnswer(i, selections[i] ?? new Set(), customs[i] ?? "")
    );
    onSubmitAnswers(answers);
  };

  const doDecline = () => {
    _dismiss();
    onSubmitAnswers(questions.map(q_i => q_i.options[0]?.label ?? ""));
  };

  // auto-resize "Other" textarea
  const resizeOther = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  // Click handler for option buttons
  const handleOptionClick = (label: string) => {
    if (!effectiveMulti && total === 1 && curCustom.trim() === "") {
      // Single-question single-select: immediate submit
      _dismiss();
      onSubmitAnswers([label]);
      return;
    }
    toggleOption(label);
    // Single-select non-last step: auto-advance the wizard UI only (answer sent on Submit)
    if (!effectiveMulti && step < total - 1) {
      setTimeout(() => setStep(s => s + 1), 120);
    }
  };

  return (
    <div style={{
      margin: "6px 16px 2px",
      border: "1px solid var(--border)",
      borderRadius: 8,
      background: "var(--bg-surface)",
      overflow: "hidden",
      // Huge AUQ bodies (long questions / many options with previews) must not
      // outgrow the viewport — this block is pinned OUTSIDE the chat scroll area,
      // so cap the card and let the question body scroll internally while the
      // header and action row stay visible.
      display: "flex", flexDirection: "column",
      maxHeight: maxHeight ?? "min(60vh, 640px)",
    }}>
      {/* Header bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px",
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--bg-deep)",
        flexShrink: 0,
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", flex: 1 }}>
          {total === 1 ? (q.header || "Select") : "Select"}
        </span>
        {/* Step indicator dots for multi-question */}
        {total > 1 && (
          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
            {questions.map((_, i) => {
              const done = selections[i].size > 0 || (customs[i]?.trim().length ?? 0) > 0;
              const active = i === step;
              return (
                <button
                  key={i}
                  onClick={() => setStep(i)}
                  style={{
                    width: active ? 16 : 7, height: 7,
                    borderRadius: 4, border: "none", padding: 0, cursor: "pointer",
                    background: active ? "var(--accent-blue)" : done ? "var(--accent-green)" : "var(--border-strong)",
                    transition: "width 0.15s, background 0.15s",
                  }}
                />
              );
            })}
            <span style={{ fontSize: 10, color: "var(--text-faint)", marginLeft: 2 }}>{step + 1}/{total}</span>
          </div>
        )}
        {/* Single/multi toggle */}
        {canToggleMode && (
          <button
            onClick={() => setMultiOverrides(prev => { const n = [...prev]; n[step] = !n[step]; return n; })}
            title="Toggle single/multi-select"
            style={{
              fontSize: 10, padding: "2px 7px", borderRadius: 3,
              border: `1px solid ${effectiveMulti ? "var(--accent-amber)" : "var(--border)"}`,
              background: effectiveMulti ? "rgba(198,144,38,0.12)" : "transparent",
              color: effectiveMulti ? "var(--accent-amber)" : "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            {effectiveMulti ? "Multi" : "Single"}
          </button>
        )}
      </div>

      {/* Question body — the only scrollable region of the card. overscrollBehavior
          keeps a touch scroll here from chaining into the chat behind it. */}
      <div style={{
        padding: "12px 14px 10px",
        flex: 1, minHeight: 0, overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        overscrollBehavior: "contain",
      }}>
        {/* Per-question sub-header (multi-question only) */}
        {total > 1 && q.header && (
          <div style={{ fontSize: 11, color: "var(--accent-blue)", fontWeight: 600, marginBottom: 4 }}>{q.header}</div>
        )}
        {/* Question text */}
        <div
          className="conv-markdown"
          dangerouslySetInnerHTML={{ __html: questionHtml }}
          style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 10, lineHeight: 1.6 }}
        />

        {(() => {
          // When any option has a preview or a description, force the vertical-card
          // layout even for single-select — inline chips have no room for either
          // and would silently drop them (TUI shows the description, so Chat must too).
          const hasPreview = q.options.some(o => o.preview);
          const hasDescription = q.options.some(o => o.description);
          const useCards = effectiveMulti || hasPreview || hasDescription;
          if (!useCards) return null;
          const isCheckbox = effectiveMulti;
          return (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 8 }}>
                {q.options.map((opt) => {
                  const selected = curSelections.has(opt.label);
                  return (
                    <button
                      key={opt.label}
                      onClick={() => handleOptionClick(opt.label)}
                      style={{
                        textAlign: "left", padding: "7px 10px",
                        border: `1px solid ${selected ? "var(--accent-blue)" : "var(--border)"}`,
                        borderRadius: 5, cursor: "pointer",
                        background: selected ? "rgba(83,155,245,0.12)" : "var(--bg-base)",
                        color: selected ? "var(--accent-blue)" : "var(--text-body)",
                        transition: "border-color 0.12s, background 0.12s",
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: selected ? 600 : 400, display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          width: 13, height: 13, borderRadius: isCheckbox ? 3 : 999, flexShrink: 0,
                          border: `1.5px solid ${selected ? "var(--accent-blue)" : "var(--border-strong)"}`,
                          background: selected ? "var(--accent-blue)" : "transparent",
                          fontSize: 9, color: "#fff",
                        }}>
                          {selected ? (isCheckbox ? "✓" : "●") : ""}
                        </span>
                        {opt.label}
                      </div>
                      {opt.description && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, paddingLeft: 19 }}>{opt.description}</div>
                      )}
                      {opt.preview && (
                        <pre style={{
                          marginTop: 6, marginBottom: 0, marginLeft: 19,
                          padding: "6px 8px",
                          background: "var(--bg-deep)",
                          border: "1px solid var(--border-subtle)",
                          borderRadius: 4,
                          fontSize: 10.5, lineHeight: 1.35,
                          color: "var(--text-secondary)",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                          overflow: "auto",
                          whiteSpace: "pre",
                        }}>{opt.preview}</pre>
                      )}
                    </button>
                  );
                })}
              </div>
              {/* Custom text area — multi-line, full width */}
              <div
                style={{
                  border: `1px solid ${curCustom.trim() ? "var(--accent-blue)" : "var(--border)"}`,
                  borderRadius: 5, overflow: "hidden",
                  background: "var(--bg-base)",
                  transition: "border-color 0.12s",
                  marginBottom: 8,
                }}
                onClick={() => otherRef.current?.focus()}
              >
                <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "5px 8px 0 8px" }}>Other / Custom</div>
                <textarea
                  ref={otherRef as React.RefObject<HTMLTextAreaElement>}
                  rows={1}
                  value={curCustom}
                  onChange={e => { setCustom(e.target.value); resizeOther(e.target); }}
                  onInput={e => resizeOther(e.currentTarget)}
                  placeholder="Enter custom answer…"
                  style={{
                    display: "block", width: "100%", resize: "none", overflow: "hidden",
                    background: "transparent", border: "none", outline: "none",
                    padding: "3px 8px 6px", color: "var(--text-body)", fontSize: 12,
                    fontFamily: "inherit", lineHeight: 1.5,
                  }}
                />
              </div>
            </>
          );
        })()}
        {!effectiveMulti && !q.options.some(o => o.preview) && !q.options.some(o => o.description) && (
          /* Single-select: inline chips + custom input at end separated by | */
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center", marginBottom: 10 }}>
            {q.options.map((opt) => {
              const selected = curSelections.has(opt.label);
              return (
                <button
                  key={opt.label}
                  onClick={() => handleOptionClick(opt.label)}
                  title={opt.description}
                  style={{
                    padding: "5px 10px",
                    border: `1px solid ${selected ? "var(--accent-blue)" : "var(--border)"}`,
                    borderRadius: 4, cursor: "pointer",
                    background: selected ? "rgba(83,155,245,0.12)" : "var(--bg-base)",
                    color: selected ? "var(--accent-blue)" : "var(--text-body)",
                    fontSize: 12, fontWeight: selected ? 600 : 400,
                    transition: "border-color 0.12s, background 0.12s",
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
            <span style={{ color: "var(--border-strong)", fontSize: 14, userSelect: "none" }}>|</span>
            <input
              ref={otherRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={curCustom}
              onChange={e => setCustom(e.target.value)}
              placeholder="Custom…"
              style={{
                background: "transparent", border: "none", outline: "none",
                borderBottom: `1px solid ${curCustom.trim() ? "var(--accent-blue)" : "var(--border)"}`,
                color: "var(--text-body)", fontSize: 12, padding: "4px 2px",
                minWidth: 72, flex: "1 1 72px",
                fontFamily: "inherit",
              }}
            />
          </div>
        )}

      </div>

      {/* Action row — pinned below the scrollable body so Skip/Prev/Next/Submit
          stay reachable even when a huge question body scrolls. */}
      <div style={{
        flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 14px 12px",
        borderTop: "1px solid var(--border-subtle)",
      }}>
          <button
            onClick={doDecline}
            style={{
              fontSize: 11, padding: "4px 12px",
              background: "transparent", color: "var(--text-faint)",
              border: "1px solid var(--border-subtle)", borderRadius: 4,
            }}
          >
            Skip
          </button>
          <div style={{ display: "flex", gap: 6 }}>
            {step > 0 && (
              <button
                onClick={() => setStep(s => s - 1)}
                style={{
                  fontSize: 11, padding: "4px 12px",
                  background: "transparent", color: "var(--text-secondary)",
                  border: "1px solid var(--border)", borderRadius: 4,
                }}
              >
                ← Prev
              </button>
            )}
            {!isLast ? (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={!hasAnswer}
                style={{
                  fontSize: 12, padding: "4px 16px",
                  background: hasAnswer ? "#1e3a5f" : "var(--bg-base)",
                  color: hasAnswer ? "#93c5fd" : "var(--text-faint)",
                  border: `1px solid ${hasAnswer ? "rgba(88,166,255,0.35)" : "var(--border)"}`,
                  borderRadius: 4, cursor: hasAnswer ? "pointer" : "not-allowed",
                }}
              >
                Next →
              </button>
            ) : (
              // On last step: show submit for multi-select, multi-question, or when custom text is entered
              (effectiveMulti || total > 1 || curCustom.trim()) && (
                <button
                  onClick={doSubmit}
                  disabled={!allAnswered}
                  style={{
                    fontSize: 12, padding: "4px 16px",
                    background: allAnswered ? "#1e3a5f" : "var(--bg-base)",
                    color: allAnswered ? "#93c5fd" : "var(--text-faint)",
                    border: `1px solid ${allAnswered ? "rgba(88,166,255,0.35)" : "var(--border)"}`,
                    borderRadius: 4, cursor: allAnswered ? "pointer" : "not-allowed",
                  }}
                >
                  Submit ↵
                </button>
              )
            )}
        </div>
      </div>
    </div>
  );
}

// ── SubAgent log modal ────────────────────────────────────────────────────────

type SubLogEntry =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; result?: { content: string; isError: boolean } };

function SubAgentToolRow({ name, input, result }: {
  name: string;
  input: Record<string, unknown>;
  result?: { content: string; isError: boolean };
}) {
  const [expanded, setExpanded] = useState(false);
  const isDone = !!result;
  const isError = result?.isError;
  const summary = toolSummary(name, input);
  const icon = toolIcon(name);
  const dotColor = !isDone ? "var(--accent-amber)" : isError ? "var(--accent-red)" : "var(--accent-green)";
  const resultText = result ? (result.content.length > 8000 ? result.content.slice(0, 8000) + "\n…(truncated)" : result.content) : "";

  return (
    <div style={{ padding: "1px 0" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", background: "var(--bg-surface)", border: "1px solid var(--bg-hover)",
          borderRadius: expanded ? "6px 6px 0 0" : 6, padding: "5px 10px", cursor: "pointer", gap: 8, textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: dotColor, display: "inline-block" }} />
          <span style={{ fontSize: "var(--conv-font-sm, 11px)" }}>{icon}</span>
          <span style={{ fontFamily: "monospace", fontSize: "var(--conv-font, 12px)", fontWeight: 700, color: "var(--text-bright)", flexShrink: 0 }}>{name}</span>
          {summary !== name && (
            <span style={{ fontFamily: "monospace", fontSize: "var(--conv-font-sm, 11px)", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {summary}
            </span>
          )}
        </div>
        <span style={{ fontSize: "var(--conv-font-xs, 10px)", color: "var(--text-faint)", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div style={{
          background: "var(--bg-deep)", border: "1px solid var(--bg-hover)", borderTop: "none",
          borderRadius: "0 0 6px 6px", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6,
        }}>
          {/* Input */}
          <div>
            <div style={{ fontSize: "var(--conv-font-xxs, 9px)", fontWeight: 700, fontFamily: "monospace", color: "var(--text-faint)", letterSpacing: "0.5px", marginBottom: 3 }}>
              {name === "Edit" || name === "MultiEdit" ? "DIFF" : name === "Write" ? "CONTENT" : "IN"}
            </div>
            {name === "Edit" && "old_string" in input && "new_string" in input ? (
              <DiffView oldStr={String(input.old_string ?? "")} newStr={String(input.new_string ?? "")} />
            ) : name === "MultiEdit" && Array.isArray(input.edits) ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(input.edits as Array<{ old_string?: string; new_string?: string }>).map((edit, idx) => (
                  <DiffView key={idx} oldStr={String(edit.old_string ?? "")} newStr={String(edit.new_string ?? "")} />
                ))}
              </div>
            ) : name === "Write" && "content" in input ? (
              <CodeBlock text={String(input.content ?? "")} lang={extLang(String(input.file_path ?? ""))} />
            ) : "command" in input ? (
              <CodeBlock text={String(input.command)} lang="bash" />
            ) : (
              <CodeBlock text={yamlValue(input, 0)} lang="yaml" />
            )}
          </div>
          {/* Output */}
          {resultText && (
            <div>
              <div style={{ fontSize: "var(--conv-font-xxs, 9px)", fontWeight: 700, fontFamily: "monospace", color: isError ? "var(--accent-red)" : "var(--text-faint)", letterSpacing: "0.5px", marginBottom: 3 }}>
                {isError ? "ERR" : "OUT"}
              </div>
              <CodeBlock text={resultText} lang={tryFormatJson(resultText) ? "json" : (name === "Read" ? extLang(String(input.file_path ?? "")) : "")} isError={isError} allowMarkdown={!isError} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SubAgentModal({ sessionId, agentId, isDone, onClose }: {
  sessionId: string;
  agentId: string;
  isDone: boolean;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchLines = useCallback(async () => {
    try {
      const res = await getSubAgentLines(sessionId, agentId, 0);
      setLines(res.lines);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [sessionId, agentId]);

  useEffect(() => {
    fetchLines();
    if (!isDone) {
      const id = setInterval(fetchLines, 1500);
      return () => clearInterval(id);
    }
  }, [fetchLines, isDone]);

  useEffect(() => {
    if (!isDone) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines, isDone]);

  const entries = useMemo((): SubLogEntry[] => {
    // Pass 1: collect tool_results from user messages (tool_result blocks)
    const toolResults = new Map<string, { content: string; isError: boolean }>();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const msg = obj.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== "user") continue;
        const blocks = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
        for (const b of blocks) {
          if (b.type === "tool_result" && b.tool_use_id) {
            const c = b.content;
            const text = typeof c === "string" ? c : Array.isArray(c) ? (c as Array<Record<string, unknown>>).map(x => String(x.text ?? "")).join("") : "";
            toolResults.set(String(b.tool_use_id), { content: text, isError: !!b.is_error });
          }
        }
      } catch { /* skip */ }
    }

    // Pass 2: build ordered entries from assistant messages
    const result: SubLogEntry[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const msg = obj.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== "assistant") continue;
        const stopReason = msg.stop_reason as string | null | undefined;
        if (stopReason === null || stopReason === undefined) continue; // skip streaming
        const blocks = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
        for (const b of blocks) {
          if (b.type === "text" && String(b.text ?? "").trim()) {
            result.push({ kind: "text", text: String(b.text) });
          } else if (b.type === "tool_use" && b.id) {
            result.push({
              kind: "tool",
              id: String(b.id),
              name: String(b.name ?? "tool"),
              input: (b.input ?? {}) as Record<string, unknown>,
              result: toolResults.get(String(b.id)),
            });
          }
        }
      } catch { /* skip */ }
    }
    return result;
  }, [lines]);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--bg-base)", border: "1px solid var(--border)",
          borderRadius: 10, width: "min(820px, 96vw)", maxHeight: "85vh",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "10px 16px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-bright)" }}>Sub-agent log</span>
            {!isDone && <span className="streaming-dot" title="Watching…" />}
            {isDone && <span style={{ fontSize: 10, color: "var(--accent-green)", fontFamily: "monospace" }}>done</span>}
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 18, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}
          >×</button>
        </div>
        {/* Content */}
        <div style={{ overflowY: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
          {loading ? (
            <div style={{ color: "var(--text-muted)", fontSize: 12, padding: 8 }}>Loading…</div>
          ) : entries.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 12, padding: 8 }}>{isDone ? "No output recorded." : "Waiting for output…"}</div>
          ) : entries.map((e, i) =>
            e.kind === "text" ? (
              <div
                key={i}
                className="conv-markdown"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(e.text) }}
                style={{ fontSize: 12.5, color: "var(--text-primary)", lineHeight: 1.7, padding: "2px 4px" }}
              />
            ) : (
              <SubAgentToolRow key={i} name={e.name} input={e.input} result={e.result} />
            )
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>,
    document.body
  );
}

function ToolCallBlock({
  block,
  result,
  sessionId,
  agentId,
}: {
  block: RawContentBlock;
  result?: { content: string; isError: boolean };
  sessionId?: string;
  agentId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAgentLog, setShowAgentLog] = useState(false);
  const [useYaml, setUseYaml] = useState(true);

  const name = (block.name as string) || "tool";
  const input = (block.input as Record<string, unknown>) || {};
  const summary = toolSummary(name, input);
  const icon = toolIcon(name);
  const diff = diffStats(name, input);
  const isDone = !!result;
  const isError = result?.isError;
  const resultText = toolResultText(result);
  const isAgent = name === "Agent" && !!sessionId && !!agentId;
  const yamlConversion = name === "Read" && resultText ? tryJsonToYaml(resultText) : null;

  const dotColor = !isDone ? "var(--accent-amber)" : isError ? "var(--accent-red)" : "var(--accent-green)";

  return (
    <div style={{ padding: "2px 16px" }}>
      {/* Header bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", background: "var(--bg-surface)", border: "1px solid var(--bg-hover)",
          borderRadius: 6, padding: "6px 10px", cursor: "pointer", gap: 8,
          textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0 }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
            background: dotColor, boxShadow: isDone ? `0 0 4px ${dotColor}60` : "none",
            display: "inline-block",
          }} />
          <span style={{ fontSize: "var(--conv-font-sm, 11px)", marginRight: 2 }}>{icon}</span>
          <span style={{ fontFamily: "monospace", fontSize: "var(--conv-font, 12.5px)", fontWeight: 700, color: "var(--text-bright)", flexShrink: 0 }}>
            {name}
          </span>
          {summary !== name && (
            <span style={{
              fontFamily: "monospace", fontSize: "var(--conv-font-sm, 11.5px)", color: "var(--text-muted)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
            }}>
              {summary}
            </span>
          )}
        </div>
        <span style={{ fontSize: "var(--conv-font-xs, 10px)", color: "var(--text-faint)", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
      </button>

      {/* Collapsed extras */}
      {!expanded && diff && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 12px", fontSize: "var(--conv-font-sm, 11px)", fontFamily: "monospace" }}>
          <span style={{ color: "var(--accent-red)" }}>−{diff.del}</span>
          <span style={{ color: "var(--accent-green)" }}>+{diff.add}</span>
        </div>
      )}
      {!expanded && !diff && resultText && (
        <div style={{ padding: "2px 12px", fontSize: "var(--conv-font-sm, 11px)", fontFamily: "monospace", color: "var(--text-faint)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
          {resultText.slice(0, 100)}
        </div>
      )}
      {/* Agent: Watch button in collapsed state (only if running and we have an agentId) */}
      {!expanded && isAgent && !isDone && (
        <div style={{ padding: "2px 12px" }}>
          <button
            onClick={e => { e.stopPropagation(); setShowAgentLog(true); }}
            style={{
              fontSize: "var(--conv-font-xs, 10px)", padding: "2px 8px",
              background: "var(--accent-amber)", color: "#000",
              border: "none", borderRadius: 3, cursor: "pointer", fontFamily: "monospace", fontWeight: 600,
            }}
          >
            Watch ▶
          </button>
        </div>
      )}
      {/* Agent log modal (can open from collapsed or expanded state) */}
      {showAgentLog && isAgent && (
        <SubAgentModal
          sessionId={sessionId!}
          agentId={agentId!}
          isDone={isDone}
          onClose={() => setShowAgentLog(false)}
        />
      )}

      {/* Expanded detail */}
      {expanded && (
        <div style={{
          marginTop: 2, background: "var(--bg-base)", border: "1px solid var(--bg-hover)",
          borderTop: "none", borderRadius: "0 0 6px 6px",
          padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6,
        }}>
          {/* Agent tool: custom prompt + markdown output */}
          {name === "Agent" ? (
            <>
              {/* Subagent type badge + prompt + log button */}
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <div style={{ fontSize: "var(--conv-font-xxs, 9px)", fontWeight: 700, fontFamily: "monospace", color: "var(--text-faint)", letterSpacing: "0.5px" }}>TASK</div>
                  {!!input.subagent_type && (
                    <span style={{ fontSize: "var(--conv-font-xs, 10px)", background: "var(--bg-hover)", color: "var(--text-secondary)", borderRadius: 3, padding: "1px 6px", fontFamily: "monospace" }}>
                      {String(input.subagent_type)}
                    </span>
                  )}
                  {!!input.run_in_background && (
                    <span style={{ fontSize: "var(--conv-font-xs, 10px)", background: "var(--bg-hover)", color: "var(--text-muted)", borderRadius: 3, padding: "1px 6px" }}>background</span>
                  )}
                  {isAgent && (
                    <button
                      onClick={e => { e.stopPropagation(); setShowAgentLog(true); }}
                      style={{
                        marginLeft: "auto", fontSize: "var(--conv-font-xs, 10px)", padding: "2px 8px",
                        background: isDone ? "var(--bg-hover)" : "var(--accent-amber)",
                        color: isDone ? "var(--text-secondary)" : "#000",
                        border: "none", borderRadius: 3, cursor: "pointer", fontFamily: "monospace", fontWeight: 600,
                      }}
                    >
                      {isDone ? "View Log" : "Watch ▶"}
                    </button>
                  )}
                </div>
                <div
                  className="conv-markdown"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(String(input.prompt ?? "")) }}
                  style={{ fontSize: "var(--conv-font, 12px)", color: "var(--text-primary)", lineHeight: 1.65, maxHeight: 300, overflowY: "auto" }}
                />
              </div>
              {/* Output rendered as markdown */}
              {resultText && (
                <div>
                  <div style={{ fontSize: "var(--conv-font-xxs, 9px)", fontWeight: 700, fontFamily: "monospace", color: isError ? "var(--accent-red)" : "var(--text-faint)", letterSpacing: "0.5px", marginBottom: 4 }}>
                    {isError ? "ERR" : "RESULT"}
                  </div>
                  {isError ? (
                    <CodeBlock text={resultText} lang="" isError />
                  ) : (
                    <div
                      className="conv-markdown"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(resultText) }}
                      style={{ fontSize: "var(--conv-font, 12.5px)", color: "var(--text-primary)", lineHeight: 1.7, maxHeight: 500, overflowY: "auto" }}
                    />
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {/* Input */}
              <div>
                <div style={{ fontSize: "var(--conv-font-xxs, 9px)", fontWeight: 700, fontFamily: "monospace", color: "var(--text-faint)", letterSpacing: "0.5px", marginBottom: 3 }}>
                  {name === "Edit" || name === "MultiEdit" ? "DIFF" : name === "Write" ? "CONTENT" : "IN"}
                </div>
                {(name === "Edit") && "old_string" in input && "new_string" in input ? (
                  <DiffView
                    oldStr={String(input.old_string ?? "")}
                    newStr={String(input.new_string ?? "")}
                  />
                ) : name === "MultiEdit" && Array.isArray(input.edits) ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {(input.edits as Array<{ old_string?: string; new_string?: string }>).map((edit, idx) => (
                      <div key={idx}>
                        {(input.edits as unknown[]).length > 1 && (
                          <div style={{ fontSize: "var(--conv-font-xxs, 9px)", color: "var(--text-faint)", fontFamily: "monospace", marginBottom: 2 }}>Edit {idx + 1}</div>
                        )}
                        <DiffView
                          oldStr={String(edit.old_string ?? "")}
                          newStr={String(edit.new_string ?? "")}
                        />
                      </div>
                    ))}
                  </div>
                ) : name === "Write" && "content" in input ? (
                  <CodeBlock text={String(input.content ?? "")} lang={extLang(String(input.file_path ?? ""))} />
                ) : "command" in input ? (
                  <CodeBlock text={String(input.command)} lang="bash" />
                ) : (
                  <CodeBlock text={yamlValue(input, 0)} lang="yaml" />
                )}
              </div>
              {/* Output */}
              {resultText && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    <div style={{ fontSize: "var(--conv-font-xxs, 9px)", fontWeight: 700, fontFamily: "monospace", color: isError ? "var(--accent-red)" : "var(--text-faint)", letterSpacing: "0.5px" }}>
                      {isError ? "ERR" : "OUT"}
                    </div>
                    {yamlConversion && !isError && (
                      <button
                        onClick={() => setUseYaml((v) => !v)}
                        style={{ fontSize: "var(--conv-font-xxs, 9px)", padding: "1px 5px", borderRadius: 3, border: "1px solid var(--border)", background: "var(--bg-surface)", color: "var(--text-muted)", cursor: "pointer", fontFamily: "monospace" }}
                      >
                        {useYaml ? "JSON" : "YAML"}
                      </button>
                    )}
                  </div>
                  <CodeBlock
                    text={useYaml && yamlConversion ? yamlConversion : resultText}
                    lang={useYaml && yamlConversion ? "yaml" : (tryFormatJson(resultText) ? "json" : (name === "Read" ? extLang(String(input.file_path ?? "")) : ""))}
                    isError={isError}
                    allowMarkdown={!isError && !yamlConversion}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CompactBoundaryBlock({ entry, summary, isNew }: { entry: RawMessage; summary?: string; isNew?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const meta = (entry as unknown as Record<string, unknown>).compactMetadata as {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
  } | undefined;

  const trigger = meta?.trigger === "manual" ? "manual" : "auto";
  const ts = formatTs(entry.timestamp);
  const summaryHtml = useMemo(() => summary ? renderMarkdown(summary) : "", [summary]);

  return (
    <div style={{ padding: "6px 16px" }}>
      {/* Divider line */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, height: 1, background: isNew ? "var(--diff-add-bg)" : "var(--bg-hover)", transition: "background 1s" }} />
        <button
          onClick={() => summary && setExpanded(!expanded)}
          className={isNew ? "compact-new" : undefined}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "var(--bg-surface)",
            border: `1px solid ${isNew ? "var(--accent-green)" : "var(--border)"}`,
            borderRadius: 20, padding: "3px 10px 3px 8px",
            cursor: summary ? "pointer" : "default",
            color: "var(--text-muted)",
            fontSize: 11.5, whiteSpace: "nowrap",
            transition: "border-color 1s",
          }}
        >
          <span style={{ fontSize: 13 }}>⊞</span>
          <span style={{ fontWeight: 600, color: isNew ? "var(--accent-green)" : undefined, transition: "color 1s" }}>Compact</span>
          {meta && (
            <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>
              {trigger} · {(meta.preTokens ?? 0).toLocaleString()} tok
              {meta.postTokens ? `→${meta.postTokens.toLocaleString()}` : ""}
            </span>
          )}
          {ts && <span style={{ color: "var(--text-faintest)", fontSize: 10 }}>{ts}</span>}
          {summary && (
            <span style={{ fontSize: 10, color: "var(--text-faint)", marginLeft: 2 }}>
              {expanded ? "▲" : "▼"}
            </span>
          )}
        </button>
        <div style={{ flex: 1, height: 1, background: isNew ? "var(--diff-add-bg)" : "var(--bg-hover)", transition: "background 1s" }} />
      </div>

      {/* Expanded summary */}
      {expanded && summary && (
        <div style={{
          marginTop: 6,
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-base)",
          overflow: "hidden",
        }}>
          {/* Toolbar */}
          <div style={{
            display: "flex", justifyContent: "flex-end",
            borderBottom: "1px solid var(--border)",
            padding: "3px 8px", gap: 2,
          }}>
            {(["preview", "raw"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setRawMode(mode === "raw")}
                style={{
                  fontSize: 10.5, padding: "2px 8px",
                  borderRadius: 4, border: "none", cursor: "pointer",
                  background: (rawMode ? mode === "raw" : mode === "preview") ? "var(--border)" : "transparent",
                  color: (rawMode ? mode === "raw" : mode === "preview") ? "var(--text-primary)" : "var(--text-muted)",
                  fontWeight: (rawMode ? mode === "raw" : mode === "preview") ? 600 : 400,
                }}
              >
                {mode === "preview" ? "Preview" : "Raw"}
              </button>
            ))}
          </div>
          {rawMode ? (
            <div style={{
              padding: "10px 14px",
              color: "var(--text-secondary)",
              fontSize: 12,
              lineHeight: 1.65,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 400,
              overflowY: "auto",
              fontFamily: "monospace",
            }}>
              {summary}
            </div>
          ) : (
            <div
              className="conv-markdown"
              dangerouslySetInnerHTML={{ __html: summaryHtml }}
              style={{
                padding: "10px 14px",
                color: "var(--text-primary)",
                fontSize: 13,
                lineHeight: 1.7,
                maxHeight: 400,
                overflowY: "auto",
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Message entry renderer ────────────────────────────────────────────────────

// ── Turn usage badge ──────────────────────────────────────────────────────────

function fmt(n: number | undefined): string {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function TurnUsage({ model, usage }: { model?: string; usage?: RawUsage }) {
  if (!model && !usage) return null;
  const inp = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
  const out = usage?.output_tokens ?? 0;
  const cached = usage?.cache_read_input_tokens ?? 0;
  const created = usage?.cache_creation_input_tokens ?? 0;
  const modelShort = model?.replace("claude-", "").replace(/-\d{8}$/, "") ?? "";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap", minWidth: 0 }}>
      {modelShort && (
        <span style={{ fontSize: 10, color: "var(--text-faintest)", fontFamily: "monospace", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 3, padding: "1px 6px", flexShrink: 0 }}>
          {modelShort}
        </span>
      )}
      {usage && (
        <span style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "monospace", whiteSpace: "nowrap" }}>
          <span title="input tokens">↑</span><span style={{ color: "var(--text-muted)" }}>{fmt(inp)}</span>
          {cached > 0 && <span style={{ color: "var(--text-faintest)" }} title="cache read">♻{fmt(cached)}</span>}
          {created > 0 && <span style={{ color: "var(--text-faintest)" }} title="cache write">+{fmt(created)}</span>}
          <span title="output tokens">·↓</span><span style={{ color: "var(--text-muted)" }}>{fmt(out)}</span>
        </span>
      )}
    </div>
  );
}

const INTERRUPTED_TEXT = "[Request interrupted by user]";

function CodexEncryptedReasoningBlock() {
  return (
    <div style={{ padding: "2px 16px" }}>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        fontSize: 11, padding: "3px 10px", borderRadius: 5,
        background: "var(--bg-surface)", border: "1px dashed var(--border)",
        color: "var(--text-muted)", fontStyle: "italic",
      }}>
        <span>💭</span>
        <span>reasoning (encrypted)</span>
      </div>
    </div>
  );
}

// Keys that are routing/plumbing noise — hide in expanded view by default.
const CODEX_TOOL_NOISE_KEYS = new Set([
  "yield_time_ms", "max_output_tokens", "sandbox_permissions",
  "prefix_rule", "session_id",
]);

function codexToolCallSummary(name: string, input: unknown): string {
  // String input (custom_tool_call like apply_patch): collapse to a short label.
  if (typeof input === "string") {
    if (name === "apply_patch") {
      const lineCount = input.split("\n").length;
      return `${lineCount} line${lineCount === 1 ? "" : "s"} of patch text`;
    }
    const oneLine = input.replace(/\s+/g, " ").trim();
    return oneLine.length > 120 ? oneLine.slice(0, 120) + "…" : oneLine;
  }
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Per-tool smart summaries
  if (name === "exec_command") {
    const cmd = typeof obj.cmd === "string" ? obj.cmd : "";
    return cmd || "(no command)";
  }
  if (name === "write_stdin") {
    const chars = typeof obj.chars === "string" ? obj.chars : "";
    const sid = obj.session_id;
    const sidStr = sid != null ? `→ session ${sid}` : "";
    const preview = chars ? `"${chars.replace(/\n/g, "↵").slice(0, 80)}${chars.length > 80 ? "…" : ""}"` : "(empty)";
    return [sidStr, preview].filter(Boolean).join(" ");
  }
  // Generic fallback: first meaningful string field.
  for (const k of ["command", "cmd", "path", "file_path", "query", "url", "input"]) {
    const v = obj[k];
    if (typeof v === "string" && v) {
      return v.length > 120 ? v.slice(0, 120) + "…" : v;
    }
    if (Array.isArray(v)) return v.map(String).join(" ");
  }
  // Last resort: comma-joined key list (no JSON dump).
  const keys = Object.keys(obj).filter((k) => !CODEX_TOOL_NOISE_KEYS.has(k));
  return keys.length > 0 ? `{${keys.join(", ")}}` : "";
}

function CodexToolCallBlock({ name, input, status, callId, pairedOutput }: {
  name: string; input: unknown; status: string; callId: string;
  /** When set: the matching codex_tool_result has been folded into this card
   *  (instead of rendering separately further down the chat) so the call and
   *  its output stay visually paired even when Codex batches multiple execs. */
  pairedOutput?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => codexToolCallSummary(name, input), [name, input]);
  const dotColor = status === "completed" ? "var(--accent-green)"
                : status === "failed" ? "var(--accent-red)"
                : "var(--accent-amber)";

  // Expanded view: render structured key/value list for object input, or raw
  // text in a <pre> block for string input (e.g. apply_patch). Skips noise keys.
  const expandedBody = useMemo(() => {
    if (typeof input === "string") {
      return (
        <pre style={{ margin: 0, fontFamily: "monospace", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)", maxHeight: 400, overflow: "auto" }}>
          {input}
        </pre>
      );
    }
    if (!input || typeof input !== "object") return null;
    const obj = input as Record<string, unknown>;
    const visible = Object.entries(obj).filter(([k]) => !CODEX_TOOL_NOISE_KEYS.has(k));
    const hidden = Object.entries(obj).filter(([k]) => CODEX_TOOL_NOISE_KEYS.has(k));
    return (
      <div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 11 }}>
          <tbody>
            {visible.map(([k, v]) => (
              <tr key={k}>
                <td style={{ verticalAlign: "top", padding: "2px 8px 2px 0", color: "var(--text-faintest)", whiteSpace: "nowrap" }}>{k}</td>
                <td style={{ padding: "2px 0", color: "var(--text-muted)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {typeof v === "string" ? v : JSON.stringify(v)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {hidden.length > 0 && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: "pointer", color: "var(--text-faintest)", fontSize: 10 }}>
              · {hidden.length} more (routing fields)
            </summary>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 11, marginTop: 4 }}>
              <tbody>
                {hidden.map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ padding: "2px 8px 2px 0", color: "var(--text-faintest)", whiteSpace: "nowrap" }}>{k}</td>
                    <td style={{ padding: "2px 0", color: "var(--text-faint)" }}>{typeof v === "string" ? v : JSON.stringify(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    );
  }, [input]);

  return (
    <div style={{ padding: "2px 16px" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", background: "var(--bg-surface)", border: "1px solid var(--bg-hover)",
          borderRadius: 6, padding: "6px 10px", cursor: "pointer", gap: 8, textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: dotColor }} />
          <span style={{ fontSize: 11 }}>🔧</span>
          <span style={{ fontFamily: "monospace", fontSize: "var(--conv-font, 12.5px)", fontWeight: 700, color: "var(--text-bright)", flexShrink: 0 }}>
            {name}
          </span>
          <span style={{
            fontFamily: "monospace", fontSize: "var(--conv-font-sm, 11.5px)", color: "var(--text-muted)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
          }}>
            {summary}
          </span>
        </div>
        <span style={{ fontSize: "var(--conv-font-xs, 10px)", color: "var(--text-faint)", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 4, padding: 8, background: "var(--bg-surface)", border: "1px solid var(--bg-hover)", borderRadius: 6, color: "var(--text-muted)" }}>
          {callId && <div style={{ color: "var(--text-faintest)", marginBottom: 6, fontFamily: "monospace", fontSize: 10 }}>call_id: {callId}</div>}
          {expandedBody}
        </div>
      )}
      {pairedOutput !== undefined && (
        <CodexToolResultBlock output={pairedOutput} callId={callId} />
      )}
    </div>
  );
}

// Codex's exec_command tool wraps output in structured headers:
//   "Chunk ID: <id>\nWall time: ...\nProcess exited with code N\n
//    Original token count: ...\nOutput:\n<actual output>"
// Note "Process exited with code N" has NO colon after "code" — needs its
// own regex. We split on the "Output:" line (everything after is the body)
// then scan the prefix for known header lines.
function parseCodexExecOutput(raw: string): {
  chunkId?: string;
  wallTime?: string;
  exitCode?: number;
  tokenCount?: number;
  body: string;
} {
  const lines = raw.split("\n");
  // Look for the "Output:" delimiter in the first ~10 lines (header block).
  let outputIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i] === "Output:") { outputIdx = i; break; }
  }
  if (outputIdx < 0) {
    return { body: raw.replace(/\n+$/, "") };
  }
  const headerLines = lines.slice(0, outputIdx);
  const body = lines.slice(outputIdx + 1).join("\n").replace(/\n+$/, "");
  const result: {
    chunkId?: string; wallTime?: string; exitCode?: number; tokenCount?: number; body: string;
  } = { body };
  for (const line of headerLines) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Chunk ID:\s*(.+)$/))) result.chunkId = m[1].trim();
    else if ((m = line.match(/^Wall time:\s*(.+)$/))) result.wallTime = m[1].trim();
    else if ((m = line.match(/^Process exited with code\s+(-?\d+)/))) result.exitCode = Number(m[1]);
    else if ((m = line.match(/^Original token count:\s*(\d+)/))) result.tokenCount = Number(m[1]);
  }
  return result;
}

function CodexToolResultBlock({ output, callId }: { output: string; callId: string }) {
  const [expanded, setExpanded] = useState(false);
  const trimmed = output.trim();
  const parsed = useMemo(() => parseCodexExecOutput(trimmed), [trimmed]);
  if (!trimmed) return null;
  const hasExecHeaders = parsed.exitCode !== undefined || parsed.chunkId !== undefined;
  const visibleBody = hasExecHeaders ? parsed.body : trimmed;
  const isMultiline = visibleBody.includes("\n");
  const firstLine = visibleBody.split("\n")[0] || (hasExecHeaders ? "(command produced no output)" : "(no output)");
  const preview = firstLine.length > 160 ? firstLine.slice(0, 160) + "…" : firstLine;

  const exitOk = parsed.exitCode === 0;
  const exitBadge = parsed.exitCode !== undefined && (
    <span style={{
      flexShrink: 0, fontSize: 10, fontFamily: "monospace", padding: "1px 5px", borderRadius: 3,
      background: exitOk ? "#064e3b" : "#4c1d1d",
      color: exitOk ? "#6ee7b7" : "#fca5a5",
      border: `1px solid ${exitOk ? "#065f46" : "#7f1d1d"}`,
    }}>
      exit {parsed.exitCode}
    </span>
  );

  return (
    <div style={{ padding: "2px 16px 2px 32px" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex", alignItems: "center", width: "100%",
          background: "transparent", border: "none", padding: "2px 0", cursor: isMultiline || hasExecHeaders ? "pointer" : "default",
          gap: 6, textAlign: "left", color: "var(--text-muted)", fontSize: 11, fontFamily: "monospace",
        }}
      >
        <span style={{ color: "var(--text-faintest)", flexShrink: 0 }}>↳</span>
        {exitBadge}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{preview}</span>
        {(isMultiline || hasExecHeaders) && <span style={{ color: "var(--text-faintest)", fontSize: 10 }}>{expanded ? "▲" : "▼"}</span>}
      </button>
      {expanded && (isMultiline || hasExecHeaders) && (
        <div style={{ marginTop: 2, padding: 8, background: "var(--bg-surface)", border: "1px solid var(--bg-hover)", borderRadius: 6, fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)", maxHeight: 400, overflow: "auto" }}>
          {visibleBody && (
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{visibleBody || "(empty output)"}</div>
          )}
          {(hasExecHeaders || callId) && (
            <div style={{ color: "var(--text-faintest)", marginTop: 6, borderTop: "1px solid var(--border)", paddingTop: 4, fontSize: 10 }}>
              {parsed.wallTime && <span style={{ marginRight: 10 }}>⏱ {parsed.wallTime}</span>}
              {parsed.tokenCount !== undefined && <span style={{ marginRight: 10 }}>{parsed.tokenCount} tok</span>}
              {parsed.chunkId && <span style={{ marginRight: 10 }}>chunk {parsed.chunkId}</span>}
              {callId && <span>call_id: {callId}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Render a single unified-diff body with per-line colored backgrounds.
function UnifiedDiffView({ diff, maxHeight }: { diff: string; maxHeight?: number }) {
  const lines = diff.split("\n");
  return (
    <pre style={{
      margin: 0, fontFamily: "monospace", fontSize: 11, lineHeight: 1.5,
      maxHeight: maxHeight ?? 400, overflow: "auto",
      background: "var(--bg-base)", border: "1px solid var(--border)", borderRadius: 4,
    }}>
      {lines.map((ln, i) => {
        let bg = "transparent";
        let color = "var(--text-muted)";
        if (ln.startsWith("+++") || ln.startsWith("---")) { color = "var(--text-faint)"; }
        else if (ln.startsWith("@@")) { color = "var(--accent-blue)"; bg = "var(--bg-surface)"; }
        else if (ln.startsWith("+")) { bg = "rgba(46, 160, 67, 0.15)"; color = "#7ee787"; }
        else if (ln.startsWith("-")) { bg = "rgba(248, 81, 73, 0.15)"; color = "#ffa198"; }
        return (
          <div key={i} style={{ background: bg, color, padding: "0 8px", whiteSpace: "pre" }}>
            {ln || " "}
          </div>
        );
      })}
    </pre>
  );
}

function CodexPatchFileRow({ path, info }: {
  path: string;
  info: { type?: string; content?: string; unified_diff?: string; move_path?: string };
}) {
  const [open, setOpen] = useState(false);
  const type = info.type || "update";
  const name = path.split("/").pop() || path;
  const dir = path.slice(0, path.length - name.length).replace(/\/$/, "");
  const typeStyle: Record<string, { sym: string; color: string; bg: string }> = {
    add: { sym: "+", color: "#7ee787", bg: "rgba(46, 160, 67, 0.12)" },
    update: { sym: "M", color: "var(--accent-blue)", bg: "transparent" },
    delete: { sym: "−", color: "#ffa198", bg: "rgba(248, 81, 73, 0.12)" },
  };
  const t = typeStyle[type] || typeStyle.update;
  // Compute +/− stats
  const stats = useMemo(() => {
    if (type === "add" && info.content) {
      return { add: info.content.split("\n").length, del: 0 };
    }
    if (type === "update" && info.unified_diff) {
      let add = 0, del = 0;
      for (const ln of info.unified_diff.split("\n")) {
        if (ln.startsWith("+") && !ln.startsWith("+++")) add++;
        else if (ln.startsWith("-") && !ln.startsWith("---")) del++;
      }
      return { add, del };
    }
    return { add: 0, del: 0 };
  }, [type, info.content, info.unified_diff]);
  const hasBody = (type === "add" && !!info.content) || (type === "update" && !!info.unified_diff);

  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <button
        onClick={() => hasBody && setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", width: "100%", gap: 8,
          padding: "4px 8px", background: t.bg, border: "none",
          cursor: hasBody ? "pointer" : "default", textAlign: "left",
          fontFamily: "monospace", fontSize: 11, color: t.color,
        }}
      >
        <span style={{ width: 12, textAlign: "center", flexShrink: 0, fontWeight: 700 }}>{t.sym}</span>
        <span style={{ flexShrink: 0, fontWeight: 600 }}>{name}</span>
        {dir && <span style={{ color: "var(--text-faintest)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dir}</span>}
        <span style={{ flex: 1 }} />
        {info.move_path && (
          <span style={{ color: "var(--text-faint)", fontSize: 10 }}>→ {info.move_path}</span>
        )}
        {(stats.add > 0 || stats.del > 0) && (
          <span style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0 }}>
            {stats.add > 0 && <span style={{ color: "#7ee787" }}>+{stats.add}</span>}
            {stats.add > 0 && stats.del > 0 && " "}
            {stats.del > 0 && <span style={{ color: "#ffa198" }}>−{stats.del}</span>}
          </span>
        )}
        {hasBody && (
          <span style={{ color: "var(--text-faintest)", fontSize: 10, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
        )}
      </button>
      {open && hasBody && (
        <div style={{ padding: "4px 8px 6px" }}>
          {type === "update" && info.unified_diff && <UnifiedDiffView diff={info.unified_diff} />}
          {type === "add" && info.content && (
            <UnifiedDiffView
              diff={info.content.split("\n").map((l) => "+" + l).join("\n")}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CodexPatchApplyBlock({ stdout, stderr, success, changes, status }: {
  stdout: string; stderr: string; success: boolean; changes: Record<string, unknown>; status: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const entries = useMemo(() => Object.entries(changes || {}), [changes]);
  const dotColor = success ? "var(--accent-green)" : "var(--accent-red)";
  const statusLabel = success ? "applied" : (status || "failed");
  const totals = useMemo(() => {
    let add = 0, del = 0;
    for (const [, info] of entries) {
      const i = (info as { type?: string; content?: string; unified_diff?: string });
      if (i.type === "add" && i.content) add += i.content.split("\n").length;
      else if (i.type === "update" && i.unified_diff) {
        for (const ln of i.unified_diff.split("\n")) {
          if (ln.startsWith("+") && !ln.startsWith("+++")) add++;
          else if (ln.startsWith("-") && !ln.startsWith("---")) del++;
        }
      }
    }
    return { add, del };
  }, [entries]);

  return (
    <div style={{ padding: "2px 16px" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", background: "var(--bg-surface)", border: "1px solid var(--bg-hover)",
          borderRadius: 6, padding: "6px 10px", cursor: "pointer", gap: 8, textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: dotColor }} />
          <span style={{ fontSize: 11 }}>📝</span>
          <span style={{ fontFamily: "monospace", fontSize: "var(--conv-font, 12.5px)", fontWeight: 700, color: "var(--text-bright)", flexShrink: 0 }}>
            patch_apply
          </span>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{statusLabel}</span>
          <span style={{
            fontFamily: "monospace", fontSize: "var(--conv-font-sm, 11.5px)", color: "var(--text-muted)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
          }}>
            {entries.length > 0
              ? `${entries.length} file${entries.length === 1 ? "" : "s"} · `
              : ""}
            {(totals.add > 0 || totals.del > 0) && (
              <>
                {totals.add > 0 && <span style={{ color: "#7ee787" }}>+{totals.add}</span>}
                {totals.add > 0 && totals.del > 0 && " "}
                {totals.del > 0 && <span style={{ color: "#ffa198" }}>−{totals.del}</span>}
              </>
            )}
          </span>
        </div>
        <span style={{ fontSize: "var(--conv-font-xs, 10px)", color: "var(--text-faint)", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 4, background: "var(--bg-surface)", border: "1px solid var(--bg-hover)", borderRadius: 6, overflow: "hidden" }}>
          {entries.map(([path, info]) => (
            <CodexPatchFileRow
              key={path}
              path={path}
              info={(info as { type?: string; content?: string; unified_diff?: string; move_path?: string }) || {}}
            />
          ))}
          {(stdout.trim() || stderr.trim()) && (
            <div style={{ padding: 8, borderTop: "1px solid var(--border)", fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" }}>
              {stdout.trim() && (
                <div style={{ marginBottom: stderr.trim() ? 6 : 0 }}>
                  <div style={{ color: "var(--text-faintest)", marginBottom: 2 }}>stdout:</div>
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflow: "auto" }}>{stdout}</div>
                </div>
              )}
              {stderr.trim() && (
                <div>
                  <div style={{ color: "var(--accent-red)", marginBottom: 2 }}>stderr:</div>
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--accent-red)", maxHeight: 200, overflow: "auto" }}>{stderr}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CodexLifecycleBlock({ subtype, durationMs, reason, modelContextWindow }: {
  subtype: string; durationMs: number | null; reason: string | null; modelContextWindow: number | null;
}) {
  const labels: Record<string, string> = {
    task_started: "▶ task started",
    task_complete: "✓ task complete",
    turn_aborted: "⊘ turn aborted",
    session_meta: "session start",
    turn_context: "turn context",
  };
  const label = labels[subtype] || subtype;
  const color = subtype === "turn_aborted" ? "var(--accent-red)"
              : subtype === "task_complete" ? "var(--accent-green)"
              : "var(--text-muted)";
  const parts: string[] = [];
  if (typeof durationMs === "number") {
    parts.push(durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`);
  }
  if (reason) parts.push(reason);
  if (typeof modelContextWindow === "number") parts.push(`ctx ${modelContextWindow}`);
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "2px 16px" }}>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 10px",
        background: "var(--bg-surface)", border: "1px solid var(--border)",
        borderRadius: 20, fontSize: 10, color, fontFamily: "monospace",
      }}>
        <span>{label}</span>
        {parts.length > 0 && <span style={{ color: "var(--text-faintest)" }}>· {parts.join(" · ")}</span>}
      </div>
    </div>
  );
}

function CodexTokenCountBlock({ info }: { info: Record<string, unknown> }) {
  const lastTokenUsage = (info.last_token_usage as Record<string, unknown>) || {};
  const totalTokenUsage = (info.total_token_usage as Record<string, unknown>) || {};
  const lastIn = Number(lastTokenUsage.input_tokens ?? 0) + Number(lastTokenUsage.cached_input_tokens ?? 0);
  const lastOut = Number(lastTokenUsage.output_tokens ?? 0);
  const totalIn = Number(totalTokenUsage.input_tokens ?? 0) + Number(totalTokenUsage.cached_input_tokens ?? 0);
  const totalOut = Number(totalTokenUsage.output_tokens ?? 0);
  if (!lastIn && !lastOut && !totalIn && !totalOut) return null;
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "1px 16px" }}>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "1px 8px",
        fontSize: 9, color: "var(--text-faintest)", fontFamily: "monospace",
      }}>
        <span title="this turn">↑{fmt(lastIn)} ↓{fmt(lastOut)}</span>
        <span>·</span>
        <span title="cumulative">Σ ↑{fmt(totalIn)} ↓{fmt(totalOut)}</span>
      </div>
    </div>
  );
}

// Memoized: the parent re-renders on every poll (1.5s) and on every keystroke
// in the input box. All object/function props below are referentially stable
// (useMemo on [messages]/[subagents], useCallback), and `entry` comes from a
// memoized list, so a shallow compare lets unchanged rows skip re-render — that
// is what keeps typing responsive when the transcript is long.
const MessageEntry = React.memo(function MessageEntry({
  entry,
  toolResults,
  codexToolResults,
  compactSummaries,
  isActiveThinking = false,
  isNewCompact = false,
  sessionId,
  subagentsByDesc,
  chatOnly = false,
  hideAuqDisplay = false,
  hideExitPlanBlock = false,
  planPathByExitBlockId,
  onRewindMessage,
}: {
  entry: RawMessage;
  toolResults: Map<string, { content: string; isError: boolean }>;
  codexToolResults?: Map<string, string>;
  compactSummaries: Map<string, string>;
  isActiveThinking?: boolean;
  isNewCompact?: boolean;
  sessionId?: string;
  subagentsByDesc?: Map<string, string>;
  chatOnly?: boolean;
  hideAuqDisplay?: boolean;
  hideExitPlanBlock?: boolean;
  planPathByExitBlockId?: Map<string, string>;
  onRewindMessage?: (uuid: string) => void;
}) {
  // In-flight streaming-preview snapshot (anthropic-proxy `kind: "snapshot"`,
  // merged in by mergeProxySnapshots as a synthetic `tap-…` assistant entry).
  // It is partial, not yet written to the JSONL, and churns/disappears as the
  // CLI flushes the real line — so it gets a muted, italic, boxed "preview"
  // treatment instead of looking like a committed message. ("final" snapshots
  // mirror a completed turn and render normally.)
  const _snapKind = (entry as unknown as Record<string, unknown>)._snapshot_kind;
  const isSnapshotPreview = _snapKind === "snapshot";

  // compact_boundary system entry
  if (entry.type === "system" && (entry as unknown as Record<string, unknown>).subtype === "compact_boundary") {
    const summary = compactSummaries.get(entry.uuid || "");
    return <CompactBoundaryBlock entry={entry} summary={summary} isNew={isNewCompact} />;
  }

  // local_command system entry — slash command executed locally (e.g. /model, /clear)
  if (entry.type === "system" && (entry as unknown as Record<string, unknown>).subtype === "local_command") {
    const content = String((entry as unknown as Record<string, unknown>).content || "");
    const cmdMatch = content.match(/<command-name>([^<]+)<\/command-name>/);
    const argsMatch = content.match(/<command-args>([^<]*)<\/command-args>/);
    const stdoutMatch = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
    const cmd = cmdMatch?.[1].trim() || "";
    const args = argsMatch?.[1].trim() || "";
    // Strip ANSI escape codes from stdout
    const rawStdout = stdoutMatch?.[1] || "";
    const stdout = rawStdout.replace(/\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!stdout) return null;
    const label = cmd ? `${cmd}${args ? " " + args : ""}` : "";
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "2px 16px" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 20, fontSize: 11, color: "var(--text-muted)", maxWidth: "80%" }}>
          {label && <span style={{ fontFamily: "monospace", color: "var(--accent-blue)", flexShrink: 0 }}>{label}</span>}
          {label && <span style={{ color: "var(--text-faintest)" }}>→</span>}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stdout}</span>
        </div>
      </div>
    );
  }

  // queue-operation enqueue — user prompt typed while Claude was responding.
  // Claude CLI logs these as a separate top-level entry, then promotes them to a
  // real user message on the next turn. Show them in chat as soon as they land.
  if (entry.type === "queue-operation") {
    const op = (entry as unknown as Record<string, unknown>).operation;
    const content = String((entry as unknown as Record<string, unknown>).content ?? "").trim();
    if (op !== "enqueue" || !content) return null;
    const ets = formatTs(entry.timestamp);
    if (content.startsWith("<task-notification>")) return <TaskNotificationBlock text={content} ts={ets} />;
    if (content.startsWith("<system-reminder>")) return <SystemReminderBlock text={content} ts={ets} />;
    return <UserBubble text={content} ts={ets} sessionId={sessionId} />;
  }

  // queued_command attachment — user prompt submitted mid-response, OR a system-
  // injected envelope (task-notification / system-reminder) Claude CLI queues as
  // pseudo-input. Route the envelopes to dedicated blocks; everything else stays
  // as a regular user bubble.
  if (entry.type === "attachment") {
    const att = (entry as unknown as Record<string, unknown>).attachment as Record<string, unknown> | undefined;
    if (att?.type === "queued_command") {
      const text = String(att.prompt ?? "").trim();
      if (!text) return null;
      const ets = formatTs(entry.timestamp);
      const mode = String(att.commandMode ?? "");
      if (mode === "task-notification" || text.startsWith("<task-notification>")) {
        return <TaskNotificationBlock text={text} ts={ets} />;
      }
      if (mode === "system-reminder" || text.startsWith("<system-reminder>")) {
        return <SystemReminderBlock text={text} ts={ets} />;
      }
      return <UserBubble text={text} ts={ets} sessionId={sessionId} />;
    }
    return null;
  }

  // Codex-specific top-level types (synthesized from rollout JSONL by backend).
  if (entry.type === "codex_reasoning") {
    const r = entry as unknown as Record<string, unknown>;
    const text = String(r.text || "").trim();
    const encrypted = !!r.encrypted;
    if (!text && !encrypted) return null;
    if (text) return <ThinkingBlock thinking={text} isActive={false} />;
    return <CodexEncryptedReasoningBlock />;
  }

  if (entry.type === "codex_tool_call") {
    const r = entry as unknown as Record<string, unknown>;
    const cid = String(r.call_id || "");
    const pairedOutput = cid ? codexToolResults?.get(cid) : undefined;
    return <CodexToolCallBlock
      name={String(r.name || "tool")}
      input={r.input}
      status={String(r.status || "")}
      callId={cid}
      pairedOutput={pairedOutput}
    />;
  }

  if (entry.type === "codex_tool_result") {
    const r = entry as unknown as Record<string, unknown>;
    return <CodexToolResultBlock
      output={String(r.output ?? "")}
      callId={String(r.call_id || "")}
    />;
  }

  if (entry.type === "codex_patch_apply") {
    const r = entry as unknown as Record<string, unknown>;
    return <CodexPatchApplyBlock
      stdout={String(r.stdout ?? "")}
      stderr={String(r.stderr ?? "")}
      success={!!r.success}
      changes={(r.changes as Record<string, unknown>) || {}}
      status={String(r.status || "")}
    />;
  }

  if (entry.type === "codex_lifecycle") {
    const r = entry as unknown as Record<string, unknown>;
    return <CodexLifecycleBlock
      subtype={String(r.subtype || "")}
      durationMs={typeof r.duration_ms === "number" ? r.duration_ms : null}
      reason={r.reason ? String(r.reason) : null}
      modelContextWindow={typeof r.model_context_window === "number" ? r.model_context_window : null}
    />;
  }

  if (entry.type === "codex_token_count") {
    const r = entry as unknown as Record<string, unknown>;
    return <CodexTokenCountBlock info={(r.info as Record<string, unknown>) || {}} />;
  }

  const msg = entry.message;
  if (!msg) return null;

  const blocks = getBlocks(msg.content as RawContentBlock[] | string);
  const ts = formatTs(entry.timestamp);

  if (msg.role === "user") {
    const textBlocks = blocks.filter((b) => b.type === "text" && b.text?.trim());
    if (textBlocks.length === 0) return null;
    const text = textBlocks.map((b) => b.text || "").join("\n").trim();
    // Skip auto-generated interruption messages
    if (text === INTERRUPTED_TEXT) return null;
    // Route system-injected envelopes (Claude CLI writes these into the user
    // channel but they're not user input) to dedicated visual blocks.
    if (text.startsWith("<task-notification>")) return <TaskNotificationBlock text={text} ts={ts} />;
    if (text.startsWith("<system-reminder>")) return <SystemReminderBlock text={text} ts={ts} />;
    const slash = text.startsWith("<command-name>") ? parseSlashCommand(text) : null;
    if (slash) return <SlashCommandBubble cmd={slash.cmd} args={slash.args} ts={ts} />;
    const handleRewind = chatOnly && onRewindMessage && entry.uuid
      ? () => onRewindMessage(entry.uuid!)
      : undefined;
    return <UserBubble text={text} ts={ts} sessionId={sessionId} onRewind={handleRewind} />;
  }

  if (msg.role === "assistant") {
    const segments: React.ReactElement[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === "thinking") {
        if (b.thinking) {
          segments.push(<ThinkingBlock key={i} thinking={b.thinking} isActive={isActiveThinking} />);
        } else if ((b as unknown as Record<string, unknown>).signature) {
          segments.push(<ThinkingRedacted key={i} isActive={isActiveThinking} />);
        }
      } else if (b.type === "text" && b.text?.trim()) {
        segments.push(<AssistantMarkdown key={i} text={b.text} />);
      } else if (b.type === "tool_use" && b.id) {
        if (b.name === "AskUserQuestion") {
          // Show read-only display unless the interactive block is already rendered below
          if (!hideAuqDisplay) {
            const inp = b.input as Record<string, unknown>;
            const rawQs = Array.isArray(inp?.questions) ? inp.questions as AskQuestion[] : [];
            // AskUserQuestion never writes tool_result to JSONL.
            // "Answered" is inferred: if there are messages after this one (not last),
            // or chatOnly is true and session has moved on, the question was answered.
            // We show the answer text only when available in toolResults (rare but possible in some versions).
            const result = toolResults.get(b.id);
            const answerText = result ? result.content : null;
            if (rawQs.length > 0) {
              segments.push(<AskUserQuestionDisplay key={i} questions={rawQs} answer={answerText} />);
            }
          }
        } else if (b.name === "TodoWrite" || b.name === "TodoRead") {
          const result = toolResults.get(b.id);
          segments.push(<TodoListBlock key={i} block={b} result={result} />);
        } else if (TASK_TOOL_NAMES.has(b.name as string)) {
          // Collect all consecutive Task* blocks into one group
          const taskBlocks: RawContentBlock[] = [b];
          while (i + 1 < blocks.length && blocks[i + 1].type === "tool_use" && TASK_TOOL_NAMES.has(blocks[i + 1].name as string)) {
            i++;
            taskBlocks.push(blocks[i]);
          }
          segments.push(<TaskGroupBlock key={i} blocks={taskBlocks} />);
        } else if (b.name === "ExitPlanMode") {
          const result = toolResults.get(b.id);
          if (result) {
            // The approval tool_result begins with a status line ("User has
            // approved your plan…") and then embeds the FULL plan body after a
            // "## Approved Plan:" / "Here is Claude's plan" marker. That body
            // can itself contain the word "reject" (e.g. a plan describing
            // reject→deny handling), which previously flipped an approved plan
            // to "rejected". Classify from the status portion only, excluding
            // the embedded plan body. A rejection result has no such marker, so
            // its whole text is scanned and "rejected" is still detected.
            const planMarker = result.content.search(/##\s*Approved Plan:|Here is Claude's plan/i);
            const statusPart = planMarker >= 0 ? result.content.slice(0, planMarker) : result.content;
            const approved = !statusPart.toLowerCase().includes("reject");
            const planInput = (b.input as Record<string, unknown>) || {};
            const planText = planInput.plan ? String(planInput.plan) : undefined;
            const planPath = b.id ? planPathByExitBlockId?.get(b.id) : undefined;
            const feedback = !approved ? statusPart.trim() : undefined;
            segments.push(<PlanHistoryBlock key={i} planText={planText} planPath={planPath} approved={approved} feedback={feedback} />);
          } else if (!hideExitPlanBlock) {
            // Pending and we're NOT already showing PlanApprovalBlock below — show a neutral indicator
            segments.push(
              <div key={i} style={{ padding: "2px 16px" }}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, padding: "3px 10px", borderRadius: 5, background: "#160c2a", border: "1px solid #4c1d95", color: "#c4b5fd" }}>
                  <span>📋</span>
                  <span>Awaiting plan approval…</span>
                </div>
              </div>
            );
          }
          // If hideExitPlanBlock=true, suppress entirely (PlanApprovalBlock renders below)
        } else {
          const result = toolResults.get(b.id);
          const desc = b.name === "Agent" ? String((b.input as Record<string, unknown>)?.description ?? "") : "";
          const agentId = desc && subagentsByDesc ? subagentsByDesc.get(desc) : undefined;
          segments.push(<ToolCallBlock key={i} block={b} result={result} sessionId={sessionId} agentId={agentId} />);
        }
      }
    }
    if (segments.length === 0) return null;
    const body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {segments}
        {(msg.usage || ts) && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1px 16px 2px", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap", flex: 1, minWidth: 0 }}>
              {msg.usage && <TurnUsage model={msg.model} usage={msg.usage} />}
            </div>
            {ts && <span style={{ fontSize: 10, color: "var(--text-faintest)", flexShrink: 0 }}>{ts}</span>}
          </div>
        )}
      </div>
    );
    if (!isSnapshotPreview) return body;
    // Streaming-preview wrapper: left accent bar + label + dimmed italic body.
    // No horizontal margin so the inner segments keep their own 16px padding
    // (avoids double-indenting); the accent bar sits flush at the edge.
    return (
      <div style={{ borderLeft: "3px solid #6d28d9", background: "var(--bg-surface)", opacity: 0.8, fontStyle: "italic", fontSize: "0.9em" }}>
        <div style={{ padding: "3px 16px 0", fontSize: 10, color: "#a78bfa", fontStyle: "normal" }}>⟳</div>
        {body}
      </div>
    );
  }

  return null;
});

// ── Main component ────────────────────────────────────────────────────────────

/** Unified AUQ data — supports both screen-parsed and hook formats. */
interface PendingAuqData {
  // Screen-parsed format (parse_auq_from_screen)
  question?: string;
  header?: string;
  multiSelect?: boolean;
  allowFreeform?: boolean;
  options?: { label: string; description?: string }[];
  // Hook format (raw tool_input from Claude Code) + codex request_user_input
  // (codex sets `id` per question; Claude's hook does not).
  questions?: Array<{
    id?: string;
    question: string;
    options?: Array<string | { label?: string; value?: string; description?: string; preview?: string }>;
    multiSelect?: boolean;
    header?: string;
  }>;
}

function extractCodexAuqAnswers(
  answers: unknown[],
  questions: AskQuestion[],
): Record<string, string[]> {
  // codex's ToolRequestUserInputResponse is keyed by question.id, value is
  // a string array of selected labels / typed text. AskUserQuestionBlock's
  // buildAnswer produces either a plain string (single-select) or an array
  // of {type, click?, value?} items (multi-select). Convert each per-question
  // entry into the string[] codex expects.
  const out: Record<string, string[]> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q.id) continue;  // codex always sets question.id; skip if missing
    const a = answers[i];
    const picks: string[] = [];
    if (typeof a === "string") {
      if (a) picks.push(a);
    } else if (Array.isArray(a)) {
      let optIdx = 0;
      for (const raw of a as Array<{ type?: string; click?: boolean; value?: string }>) {
        if (raw?.type === "option") {
          if (raw.click && q.options[optIdx]) picks.push(q.options[optIdx].label);
          optIdx++;
        } else if (
          raw?.type === "type_something" &&
          typeof raw.value === "string" &&
          raw.value.trim()
        ) {
          picks.push(raw.value.trim());
        }
      }
    } else if (a != null) {
      picks.push(String(a));
    }
    out[q.id] = picks;
  }
  return out;
}

function _normalizePendingAuq(data: PendingAuqData): AskQuestion[] {
  if (data.questions && data.questions.length > 0) {
    return data.questions.map(q => ({
      id: (q as { id?: string }).id,
      question: q.question ?? "",
      header: q.header,
      multiSelect: q.multiSelect,
      options: (q.options ?? []).map(o =>
        typeof o === "string"
          ? { label: o }
          : {
              label: o.label ?? o.value ?? String(o),
              description: o.description,
              preview: o.preview,
            }
      ),
    }));
  }
  return [{
    question: data.question ?? "",
    header: data.header,
    multiSelect: data.multiSelect,
    options: data.options ?? [],
  }];
}

interface Props {
  sessionId: string;
  tool?: "claude" | "cursor" | "codex";
  /** Codex transport, only meaningful when tool === "codex". "app_server" sessions
   *  have no tmux pane — the parent owns message submission via /codex-message and
   *  this pane must skip its terminal WS attach and hide its own textarea to avoid
   *  rendering a second, broken input alongside CodexChatInput. */
  codexTransport?: "tui" | "app_server";
  isStreaming?: boolean;
  /** True while claude is running its compaction pass — drives the bottom banner's compacting variant. */
  isCompacting?: boolean;
  /** Numeric percentage string ("0".."100") parsed from the TUI status line; null when unknown. */
  compactingProgress?: string | null;
  chatOnly?: boolean;
  /** Screen-parsed AUQ data from status poll — shown when JSONL hasn't been written yet. */
  pendingAuqData?: PendingAuqData | null;
  /** Tool approval data from hooks — shown when Claude is waiting for permission. */
  pendingApproveData?: { tool_name: string; tool_input: Record<string, unknown> } | null;
  /** Live ExitPlanMode menu options parsed from the screen — lets the plan card
   *  render the real menu items (like AUQ) instead of a binary Approve/Reject. */
  pendingPlanData?: { options?: PlanMenuOption[] } | null;
  /** When true, poll JSONL aggressively until an unanswered AUQ block appears. */
  isWaitingForAuq?: boolean;
  /** Server-synced "send failed" messages from the status poll. Rendered as
   *  red Resend/Dismiss bubbles on EVERY client (not just the sender tab). */
  lostMessages?: LostMessage[];
  /** Ref that receives a function to send Ctrl+C (interrupt current response). */
  stopRef?: React.MutableRefObject<(() => void) | null>;
  /** Ref that receives a function to immediately refresh the JSONL message list. */
  refreshRef?: React.MutableRefObject<(() => void) | null>;
}

interface OptimisticMsg {
  id: string;
  text: string;
  sentAt: number;
  status: "pending" | "lost";
  toastShown?: boolean;
}

type WsStatus = "connecting" | "connected" | "disconnected" | "error";

// In-flight streaming-preview entries (anthropic-proxy snapshots the server
// merges in). They are ephemeral: each poll carries the current set and they
// vanish once the CLI flushes the real assistant line, so a delta merge drops
// the old ones and re-adds whatever the new delta supplies.
function isSyntheticEntry(m: RawMessage): boolean {
  const r = m as unknown as Record<string, unknown>;
  return r._synthetic === true || (typeof m.uuid === "string" && m.uuid.startsWith("tap-"));
}

// Stable identity for an entry: its uuid, or a content hash for the rare uuid-less
// meta entry (those are static, so the content key stays stable across polls).
// Used only for React keys / dedupe display — NOT for delta-merge anchoring (see
// stableUuid below: content keys collide because meta entries recur verbatim).
function entryKey(m: RawMessage): string {
  return typeof m.uuid === "string" && m.uuid ? m.uuid : "noid:" + JSON.stringify(m);
}

// Never-rendered, uuid-less sidecar meta entries. Claude Code appends these as
// pure state markers (current mode, title, last prompt, file-history snapshot)
// with NO uuid and NO timestamp, and their content recurs verbatim hundreds of
// times across a transcript. The display filter (see displayEntries) already
// drops them, but they used to poison the delta merge: matching the delta/base
// overlap on their content hash chopped the window mid-history (the flicker
// bug). We strip them at ingestion so the message stream is built from real,
// uuid-bearing entries (+ the rendered uuid-less queue-operation) only.
const META_NOID_TYPES = new Set([
  "mode",
  "permission-mode",
  "ai-title",
  "last-prompt",
  "file-history-snapshot",
]);

// normalizeRaw drops the never-rendered sidecar meta entries from any raw-message
// payload (live full, live delta, or a history page) so every path that builds
// the stream sees the same shape. Applied once at ingestion.
function normalizeRaw(list: RawMessage[]): RawMessage[] {
  return list.filter((m) => !META_NOID_TYPES.has(m.type as string));
}

// stableUuid returns a real, persisted JSONL uuid, or null for anything that
// must NOT be used as a merge anchor: synthetic snapshots (tap-…) and uuid-less
// entries (queue-operation, any meta that slipped through). Anchoring the splice
// on a real uuid is collision-proof, unlike the old content-hash key.
function stableUuid(m: RawMessage): string | null {
  if (isSyntheticEntry(m)) return null;
  const u = m.uuid;
  return typeof u === "string" && u && !u.startsWith("tap-") ? u : null;
}

// mergeRawDelta folds a raw-messages payload (a live delta — the latest ~10 JSONL
// entries — OR a full live tail, plus the current streaming snapshots) into the
// existing chronological window, producing exactly what a full reload would.
//
// We splice on a stable uuid: find the first base entry whose uuid also appears
// in the payload, drop the base from there on, and append ALL of the payload's
// reals (verbatim, in the server's canonical effective-ts order) then the fresh
// snapshots. Because the anchor is a real uuid (never a recurring meta/queue
// content hash), the cut lands at the true overlap point — it can't chop the
// window mid-history. Taking the whole payload (not a slice of it) means a new,
// slightly-out-of-order entry is never dropped. A final uuid-dedupe pass guards
// against any double-include at the seam (uuid'd entries only; uuid-less and
// synthetic entries pass through untouched — the display layer dedupes those).
//
// Returns null to signal "cannot merge safely — caller should resync full":
//   • base empty   → no history to graft onto (initial load / session switch).
//   • no overlap   → no shared uuid, so contiguity can't be proven and a silent
//                     gap could open (e.g. a >window burst during a sparse poll).
// On null the caller keeps the current messages and forces a full next poll.
function mergeRawDelta(prev: RawMessage[], delta: RawMessage[]): RawMessage[] | null {
  const base = prev.filter((m) => !isSyntheticEntry(m));
  const snapshots = delta.filter((m) => isSyntheticEntry(m));
  const realDelta = delta.filter((m) => !isSyntheticEntry(m));
  if (base.length === 0) return null;
  // Snapshot-only delta (streaming preview churn, no new JSONL line): keep the
  // whole base, just refresh the trailing snapshots.
  if (realDelta.length === 0) return [...base, ...snapshots];

  const deltaUuids = new Set<string>();
  for (const m of realDelta) {
    const u = stableUuid(m);
    if (u !== null) deltaUuids.add(u);
  }
  if (deltaUuids.size === 0) return null; // nothing to anchor on → resync full

  let cut = -1;
  for (let i = 0; i < base.length; i++) {
    const u = stableUuid(base[i]);
    if (u !== null && deltaUuids.has(u)) { cut = i; break; }
  }
  if (cut === -1) return null; // no overlap → can't guarantee contiguity

  const merged = [...base.slice(0, cut), ...realDelta, ...snapshots];
  // Dedupe by real uuid (keep first); pass through uuid-less + synthetic.
  const seen = new Set<string>();
  const out: RawMessage[] = [];
  for (const m of merged) {
    const u = stableUuid(m);
    if (u !== null) {
      if (seen.has(u)) continue;
      seen.add(u);
    }
    out.push(m);
  }
  return out;
}

export function ConversationPane({ sessionId, tool, codexTransport, isStreaming, isCompacting = false, compactingProgress = null, chatOnly = false, pendingAuqData, pendingApproveData, pendingPlanData, isWaitingForAuq = false, lostMessages, stopRef, refreshRef }: Props) {
  // Codex app-server transport: no tmux, no terminal WS. The parent (SessionsPage)
  // owns input via CodexChatInput → POST /codex-message. We must short-circuit the
  // WS attach effect AND the internal textarea or the user sees two input bars
  // and the WS-based one attaches to a nonexistent tmux pane.
  const isCodexAppServer = tool === "codex" && codexTransport === "app_server";
  const agentDisplayName = tool === "cursor" ? "Cursor" : tool === "codex" ? "Codex" : "Claude";
  const [messages, setMessages] = useState<RawMessage[]>([]);
  // Raw file-start offset of the oldest entry currently loaded. After the first
  // live load it is max(0, total - LIVE_TAIL); each "load older" page lowers it
  // by HISTORY_PAGE until it reaches 0 (whole transcript loaded). State drives
  // the "Load more" button; the ref mirror gives synchronous reads in callbacks.
  const [oldestOffset, setOldestOffset] = useState(0);
  const oldestOffsetRef = useRef(0);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const lastLoadAtRef = useRef(0);
  const [input, setInput] = useState(() => {
    const inMem = inputDrafts.get(sessionId);
    if (inMem !== undefined) return inMem;
    const persisted = loadDraft(sessionId);
    if (persisted) inputDrafts.set(sessionId, persisted);
    return persisted;
  });
  // Mirror of `input` for callbacks that must read it without re-binding
  // (fetchMessages' draft reconcile), plus the draft's last REAL edit time —
  // a user entry in the transcript newer than this means the draft text was
  // actually delivered and the cache must be dropped (see fetchMessages).
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);
  const inputEditedAtRef = useRef<number>(loadDraftEditedAt(sessionId));
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");
  const [optimisticMsgs, setOptimisticMsgs] = useState<OptimisticMsg[]>([]);
  const [lostToast, setLostToast] = useState<string | null>(null);
  // Server-authoritative "send failed" bubbles, keyed by id. Reconciled from the
  // status poll (lostMessages prop) so dismiss/resend on ANY client propagates
  // here. pendingLostRef protects a just-registered entry from being dropped by
  // a poll that predates the server seeing it (grace window).
  const [serverLost, setServerLost] = useState<Map<string, LostMessage>>(new Map());
  const pendingLostRef = useRef<Map<string, { lm: LostMessage; at: number }>>(new Map());
  const registerLostRef = useRef<(text: string, sentAt: number) => void>(() => {});
  const [newCompactUuids, setNewCompactUuids] = useState<Set<string>>(new Set());
  const [subagents, setSubagents] = useState<SubAgentMeta[]>([]);
  // Pending image uploads — attached to the next prompt and rendered as
  // chips above the textarea. Cleared on send. Holds the upload response
  // so we have the absolute path that gets injected as `@<path>`.
  const [pendingAttachments, setPendingAttachments] = useState<UploadedAttachment[]>([]);
  const [attachmentUploadError, setAttachmentUploadError] = useState<string | null>(null);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const wsRef = useRef<WsClient | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Live height of the chat pane, used to cap the pinned AUQ at half of it.
  const [paneHeight, setPaneHeight] = useState(0);
  const stickToBottom = useRef(true);
  const loadMoreAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const paneContainerRef = useRef<HTMLDivElement>(null);
  // Track the chat pane's height so the pinned AUQ can be capped at half of it.
  useEffect(() => {
    const el = paneContainerRef.current;
    if (!el) return;
    setPaneHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setPaneHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [historyPopover, setHistoryPopover] = useState<{ rect: DOMRect | null; container: DOMRect | null } | null>(null);
  const seenCompactUuidsRef = useRef<Set<string>>(new Set());
  // Signature of the last fetched window — lets the 1.5s poll skip setMessages
  // (and the full re-render it triggers) when the server returned identical data.
  const prevMsgSigRef = useRef("");
  // Last raw-messages change token (JSONL+snapshot state). When unchanged, the
  // server returns {unchanged:true} with no payload and we skip the whole pass.
  // Reset to undefined on session/tail change so a wider window is never
  // short-circuited.
  const lastTokenRef = useRef<string | undefined>(undefined);
  // Mirror of "any optimistic bubble is in flight". While true we force a full
  // fetch (no token) so the reconcile/"lost"-timeout pass always has real data
  // to pair against — never short-circuited away while a send is outstanding.
  const pendingOptimisticRef = useRef(false);
  // Current sessionId, refreshed every render. An in-flight fetchMessages binds
  // the sessionId of the render that created it; after its await we compare to
  // this ref and bail if the session has since switched, so a stale (possibly
  // foreign-session) response can never mutate the new session's message list.
  const currentSidRef = useRef(sessionId);
  currentSidRef.current = sessionId;
  // Synchronous mirror of `messages`. The delta merge must read the *current*
  // window the instant a poll resolves, but a setMessages functional updater
  // may run lazily (React batches the updater into the render phase), so its
  // result isn't readable inline. We compute the merge from this ref instead
  // and keep it in lock-step on every render and every applied update.
  const messagesRef = useRef<RawMessage[]>([]);
  messagesRef.current = messages;
  // Input height resizable via top-edge grip (drag up to enlarge). The grip
  // sets the BASE height; on top of that the textarea auto-grows with content
  // (see the layout effect below) up to inputHeightMax().
  const [inputHeight, setInputHeight] = useState<number>(() => loadInputHeight(sessionId));
  // Effective (auto-grown) height — drives the button column layout.
  const [autoHeight, setAutoHeight] = useState(0);
  // Auto-grow: once the content wraps past the base height (~2 lines) the
  // textarea expands with it up to inputHeightMax(), and shrinks back as
  // content is removed. Height is written directly to the DOM (collapse to 0
  // → read scrollHeight → set) rather than through the style prop, so the
  // measurement never fights React. +2 = top/bottom borders (border-box).
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    const next = Math.max(inputHeight, Math.min(ta.scrollHeight + 2, inputHeightMax()));
    ta.style.height = `${next}px`;
    setAutoHeight(next);
  }, [input, inputHeight]);

  // ── Derived data ─────────────────────────────────────────────────────────

  const subagentsByDesc = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of subagents) map.set(s.description, s.agentId);
    return map;
  }, [subagents]);

  const toolResults = useMemo(() => {
    const map = new Map<string, { content: string; isError: boolean }>();
    for (const m of messages) {
      if (m.type !== "user" || !m.message) continue;
      const blocks = getBlocks(m.message.content as RawContentBlock[] | string);
      for (const b of blocks) {
        if (b.type === "tool_result" && b.tool_use_id) {
          const content = typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? (b.content as RawContentBlock[]).map((c) => c.text || "").join("")
              : "";
          map.set(b.tool_use_id, { content, isError: !!b.is_error });
        }
      }
    }
    return map;
  }, [messages]);

  // Codex emits exec call → exec output as two separate top-level events that
  // may be many messages apart (especially when several exec_commands are
  // batched in one turn). Build a call_id → output map so each
  // CodexToolCallBlock can render its result inline; the standalone
  // codex_tool_result entries are then filtered out of displayEntries below.
  const codexToolResults = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) {
      if (m.type !== "codex_tool_result") continue;
      const r = m as unknown as Record<string, unknown>;
      const callId = String(r.call_id || "");
      if (callId) map.set(callId, String(r.output ?? ""));
    }
    return map;
  }, [messages]);

  // Set of call_ids that have BOTH a codex_tool_call and a codex_tool_result.
  // Used to drop the standalone result rows since the call block embeds them.
  const codexPairedCallIds = useMemo(() => {
    const callIds = new Set<string>();
    for (const m of messages) {
      if (m.type !== "codex_tool_call") continue;
      const r = m as unknown as Record<string, unknown>;
      const cid = String(r.call_id || "");
      if (cid && codexToolResults.has(cid)) callIds.add(cid);
    }
    return callIds;
  }, [messages, codexToolResults]);

  // Used to dedup with `pendingAuqData` (the hook/screen-parsed fallback that
  // covers the gap before JSONL is written). The body-loop renders ANY
  // unanswered AUQ tool_use block from JSONL regardless of its position, so we
  // must report true whenever any such block exists — not just when it's the
  // last entry. Claude Code appends post-AUQ meta entries (last-prompt,
  // ai-title, permission-mode) automatically; a "last only" check would push
  // the AUQ out of last position and break dedup, producing two cards.
  const hasUnansweredAuq = useMemo(() => {
    for (const m of messages) {
      if (m.type !== "assistant" || !m.message) continue;
      const blocks = getBlocks(m.message.content as RawContentBlock[] | string);
      for (const b of blocks) {
        if (b.type === "tool_use" && b.name === "AskUserQuestion" && b.id && !toolResults.has(b.id)) {
          return true;
        }
      }
    }
    return false;
  }, [messages, toolResults]);

  // ── Pinned (sticky) AUQ ──────────────────────────────────────────────────
  // Compaction rewrites JSONL and can briefly empty both AUQ sources
  // (pendingAuqData → null, unanswered tool_use → gone or moved). If we only
  // render based on the live signal, the widget unmounts mid-flight and the
  // user cannot answer → deadlock. So we capture whichever question surfaces
  // first into stickyAuq and hold onto it across signal flickers. We render
  // it in a dedicated pinned container above the status banner so other
  // chat-area content can't push it off-screen or supersede it.
  const currentAuq = useMemo<{ blockId: string; questions: AskQuestion[]; key: string } | null>(() => {
    for (const m of messages) {
      if (m.type !== "assistant" || !m.message) continue;
      const blocks = getBlocks(m.message.content as RawContentBlock[] | string);
      for (const b of blocks) {
        if (b.type === "tool_use" && b.name === "AskUserQuestion" && b.id && !toolResults.has(b.id)) {
          const inp = b.input as Record<string, unknown>;
          const qs = Array.isArray(inp?.questions) ? inp.questions as AskQuestion[] : [];
          if (qs.length > 0 && qs[0].question) {
            return { blockId: b.id, questions: qs, key: qs[0].question };
          }
        }
      }
    }
    if (pendingAuqData) {
      const qs = _normalizePendingAuq(pendingAuqData);
      if (qs.length > 0 && qs[0].question) {
        return { blockId: "__pending_auq__:" + qs[0].question, questions: qs, key: qs[0].question };
      }
    }
    return null;
  }, [messages, toolResults, pendingAuqData]);

  const [stickyAuq, setStickyAuq] = useState<{ blockId: string; questions: AskQuestion[]; key: string } | null>(null);

  // Capture / replace stickyAuq from live sources. Never clear on null — that
  // is the whole point: survive compacting-induced source flickers.
  useEffect(() => {
    if (!currentAuq) return;
    if (_isAuqBlockDismissed(sessionId, currentAuq.blockId) || _isAuqRecentlyDismissed(sessionId, currentAuq.key)) return;
    setStickyAuq(prev => {
      if (!prev) return currentAuq;
      // Same question → keep, but upgrade pending-blockId to JSONL-blockId
      // once JSONL catches up (real blockId is needed for dedup against the
      // inline render path).
      if (prev.key === currentAuq.key) {
        if (prev.blockId.startsWith("__pending_auq__:") && !currentAuq.blockId.startsWith("__pending_auq__:")) {
          return { ...prev, blockId: currentAuq.blockId };
        }
        return prev;
      }
      // Different question — supersede.
      return currentAuq;
    });
  }, [currentAuq]);

  // Drop stickyAuq once it's marked dismissed elsewhere (e.g., another tab
  // answered, or the question is no longer surfacing from any source and
  // got recently dismissed).
  useEffect(() => {
    if (!stickyAuq) return;
    if (_isAuqBlockDismissed(sessionId, stickyAuq.blockId) || _isAuqRecentlyDismissed(sessionId, stickyAuq.key)) {
      setStickyAuq(null);
    }
  }, [stickyAuq, messages, pendingAuqData]);

  // Cross-client auto-clear: when no source reports the AUQ anymore (it was
  // answered on another client → backend tui_auq_data goes null AND the JSONL
  // gains the tool_result) AND we are NOT compacting, clear the pinned widget
  // after a short sustained-null debounce. The debounce (>1 poll past the 3s
  // cadence) rides out brief non-compaction flickers; isCompacting suppresses
  // the clear entirely, preserving stickyAuq's original "survive compaction
  // flicker" purpose. Same-tab answers clear instantly via setStickyAuq(null).
  const auqClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (currentAuq || isCompacting) {
      if (auqClearTimerRef.current) { clearTimeout(auqClearTimerRef.current); auqClearTimerRef.current = null; }
      return;
    }
    if (!stickyAuq || auqClearTimerRef.current) return;
    auqClearTimerRef.current = setTimeout(() => {
      auqClearTimerRef.current = null;
      setStickyAuq(null);
    }, 4500);
    return () => {
      if (auqClearTimerRef.current) { clearTimeout(auqClearTimerRef.current); auqClearTimerRef.current = null; }
    };
  }, [currentAuq, isCompacting, stickyAuq]);

  // Build map: compact_boundary uuid → compact summary text
  const compactSummaries = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) {
      if (m.type !== "user" || !m.message || !m.parentUuid) continue;
      const text = getTextFromContent(m.message.content as RawContentBlock[] | string);
      if (isCompactSummaryText(text)) {
        map.set(m.parentUuid, text);
      }
    }
    return map;
  }, [messages]);

  // Pair each ExitPlanMode tool_use with the most recent Write/Edit to a
  // `.claude/plans/*.md` file (the plan body the user is about to approve).
  // The current ExitPlanMode tool no longer carries the plan text in its
  // input — the body lives only on disk — so we look it up by file path.
  const planPathByExitBlockId = useMemo(() => {
    const map = new Map<string, string>();
    const PLAN_PATH_RE = /\/\.claude\/plans\/[^/]+\.md$/;
    let lastPlanPath: string | undefined;
    for (const m of messages) {
      if (m.type !== "assistant" || !m.message) continue;
      const content = m.message.content as RawContentBlock[] | string;
      if (typeof content === "string") continue;
      for (const b of content) {
        if (b.type !== "tool_use") continue;
        if (b.name === "Write" || b.name === "Edit" || b.name === "MultiEdit") {
          const fp = String((b.input as Record<string, unknown>)?.file_path ?? "");
          if (PLAN_PATH_RE.test(fp)) lastPlanPath = fp;
        } else if (b.name === "ExitPlanMode" && b.id && lastPlanPath) {
          map.set(b.id, lastPlanPath);
        }
      }
    }
    return map;
  }, [messages]);

  // UUIDs of user messages that are compact summaries (suppressed from display)
  const compactSummaryUuids = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) {
      if (m.type !== "user" || !m.message || !m.uuid) continue;
      const text = getTextFromContent(m.message.content as RawContentBlock[] | string);
      if (isCompactSummaryText(text)) set.add(m.uuid);
    }
    return set;
  }, [messages]);

  const displayEntries = useMemo(() => {
    const filtered = messages.filter((m) => {
      if (m.isMeta) return false;
      // Codex-specific top-level types — synthesized by backend from rollout JSONL.
      // Pass them through unchanged; MessageEntry has dedicated render branches.
      if (m.type === "codex_tool_result") {
        // Hide standalone result rows that have a matching call — the call
        // block embeds them so the two stay visually paired even when Codex
        // emits them many messages apart.
        const r = m as unknown as Record<string, unknown>;
        const cid = String(r.call_id || "");
        return !cid || !codexPairedCallIds.has(cid);
      }
      if (
        m.type === "codex_reasoning" ||
        m.type === "codex_tool_call" ||
        m.type === "codex_patch_apply" ||
        m.type === "codex_lifecycle" ||
        m.type === "codex_token_count"
      ) return true;
      if (m.type === "user" || m.type === "assistant") {
        if (compactSummaryUuids.has(m.uuid || "")) return false;
        // Skip local-command caveat and stdout-echo XML wrappers; keep
        // <command-name> entries — those are the user's actual slash-command
        // invocation (e.g. /goal …) and we render them as a chip below.
        if (m.type === "user" && m.message) {
          const c = m.message.content;
          if (typeof c === "string" && /^<(local-command-caveat|local-command-stdout)>/.test(c)) return false;
        }
        return true;
      }
      if (m.type === "system") {
        const sub = (m as unknown as Record<string, unknown>).subtype;
        if (sub === "compact_boundary") return true;
        if (sub === "local_command") {
          const content = String((m as unknown as Record<string, unknown>).content || "");
          const match = content.match(/<local-command-stdout>([^<]*)<\/local-command-stdout>/);
          return !!(match && match[1].trim());
        }
        return false;
      }
      if (m.type === "attachment") {
        const att = (m as unknown as Record<string, unknown>).attachment as Record<string, unknown> | undefined;
        if (att?.type !== "queued_command") return false;
        // Claude CLI writes the user's queued prompt as BOTH a queue-operation
        // enqueue (when typed) and a queued_command attachment (when consumed
        // on the next turn). The two carry identical text — render only one
        // bubble. Prefer the earlier queue-operation; suppress the attachment.
        const prompt = String(att.prompt ?? "").trim();
        if (prompt) {
          for (const n of messages) {
            if (n === m) continue;
            const r = n as unknown as Record<string, unknown>;
            if (r.type === "queue-operation" && r.operation === "enqueue" && typeof r.content === "string") {
              const c = (r.content as string).trim();
              if (c === prompt || c.includes(prompt)) return false;
            }
          }
        }
        return true;
      }
      // Queued prompts the user typed while Claude was responding. Claude CLI writes
      // these as {type:"queue-operation", operation:"enqueue", content:"..."} before
      // promoting them to real user messages on the next turn.
      //
      // Claude CLI merges queue contents: if you type while there's already a queued
      // prompt, the next enqueue contains the previous one concatenated with the new
      // text (separated by \r). Suppress earlier enqueues that are fully contained in
      // a later one so the same words don't render twice. Also suppress if the same
      // text has already been promoted to a real user message later in the file.
      if (m.type === "queue-operation") {
        const r = m as unknown as Record<string, unknown>;
        if (r.operation !== "enqueue" || typeof r.content !== "string") return false;
        const content = r.content.trim();
        if (!content) return false;
        const idx = messages.indexOf(m);
        // Queue-merge dedup: if a LATER queue-op enqueue's content already contains
        // this one (Claude CLI joins consecutive enqueues with \r), drop this one
        // so the same words don't render twice.
        for (let j = idx + 1; j < messages.length; j++) {
          const n = messages[j] as unknown as Record<string, unknown>;
          if (n.type === "queue-operation" && n.operation === "enqueue" && typeof n.content === "string") {
            if (n.content.includes(content)) return false;
          }
        }
        // Promotion dedup: when Claude CLI promotes a queue-op to a regular user-type
        // entry, that entry has IDENTICAL content. Scan ALL following user-type entries
        // (not just the first — stop-hook feedback / system messages can land between
        // the qop and its real promotion). Use EXACT match, not substring: compaction
        // summaries ("This session is being continued from…") incidentally contain old
        // queue-op text as substring but are NOT promotions, and treating them as such
        // silently drops legitimate user prompts.
        for (let j = idx + 1; j < messages.length; j++) {
          const n = messages[j] as unknown as Record<string, unknown>;
          if (n.type !== "user") continue;
          const um = n.message as Record<string, unknown> | undefined;
          const uc = um?.content;
          const text = typeof uc === "string" ? uc :
            Array.isArray(uc) ? uc.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text").map((b) => String(b.text || "")).join("") : "";
          if (text.trim() === content) return false;
        }
        return true;
      }
      return false;
    });
    return filtered;
  }, [messages, compactSummaryUuids, codexPairedCallIds]);

  // ── Task run grouping ─────────────────────────────────────────────────────
  // Pre-compute runs of consecutive Task* assistant messages so they render as one group.

  const taskRunMap = useMemo(() => {
    const map = new Map<string, { blocks: RawContentBlock[]; isStart: boolean }>();
    let i = 0;
    while (i < displayEntries.length) {
      const entry = displayEntries[i];
      const uid = entry.uuid || entryKey(entry);
      // Check if this is a task-only assistant message (single Task* tool_use, no text/thinking)
      const taskBlock = (() => {
        if (entry.type !== "assistant" || !entry.message) return null;
        const bs = getBlocks(entry.message.content as RawContentBlock[] | string);
        if (bs.some(b => (b.type === "text" && b.text?.trim()) || b.type === "thinking")) return null;
        const tb = bs.filter(b => b.type === "tool_use" && TASK_TOOL_NAMES.has(b.name as string));
        return tb.length === 1 ? tb[0] : null;
      })();

      if (!taskBlock) { i++; continue; }

      const runBlocks: RawContentBlock[] = [taskBlock];
      const runUids: string[] = [uid];
      let j = i + 1;

      while (j < displayEntries.length) {
        const next = displayEntries[j];
        const nextUid = next.uuid || String(j);
        // Skip tool_result-only user messages between task calls
        if (next.type === "user" && next.message) {
          const nb = getBlocks(next.message.content as RawContentBlock[] | string);
          if (nb.length > 0 && nb.every(b => b.type === "tool_result")) { j++; continue; }
        }
        // Accept next task-only assistant message
        const nextBlock = (() => {
          if (next.type !== "assistant" || !next.message) return null;
          const bs = getBlocks(next.message.content as RawContentBlock[] | string);
          if (bs.some(b => (b.type === "text" && b.text?.trim()) || b.type === "thinking")) return null;
          const tb = bs.filter(b => b.type === "tool_use" && TASK_TOOL_NAMES.has(b.name as string));
          return tb.length === 1 ? tb[0] : null;
        })();
        if (nextBlock) { runBlocks.push(nextBlock); runUids.push(nextUid); j++; continue; }
        break;
      }

      runUids.forEach((id, k) => map.set(id, { blocks: runBlocks, isStart: k === 0 }));
      i = j;
    }
    return map;
  }, [displayEntries]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scroll anchor: restore position after prepending older messages ────────
  useLayoutEffect(() => {
    const anchor = loadMoreAnchorRef.current;
    if (!anchor) return;
    const el = scrollRef.current;
    if (!el) return;
    loadMoreAnchorRef.current = null;
    el.scrollTop = el.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
  }, [messages]);

  // ── Scroll helpers ────────────────────────────────────────────────────────

  const isAtBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const scrollToBottom = useCallback((smooth = false) => {
    if (!stickToBottom.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const loadMoreRef = useRef<() => void>(() => {});

  const handleScroll = useCallback(() => {
    stickToBottom.current = isAtBottom();
    const el = scrollRef.current;
    if (!el) return;
    // Auto-load older history when the user scrolls near the top — but only on a
    // genuine scroll: never while a page is in flight, never if everything is
    // already loaded, and not within LOAD_COOLDOWN_MS of the last load (guards
    // against a render-induced scrollTop change re-triggering in a loop).
    if (loadingMoreRef.current) return;
    if (oldestOffsetRef.current <= 0) return;
    if (Date.now() - lastLoadAtRef.current < LOAD_COOLDOWN_MS) return;
    if (el.scrollTop < 150) loadMoreRef.current();
  }, []);

  // ── Polling ───────────────────────────────────────────────────────────────

  const fetchMessages = useCallback(async (currentTail: number) => {
    try {
      // While a send is outstanding, force a full fetch (no token) so the
      // reconcile/"lost"-timeout pass below always has real data. Otherwise use
      // the change token so an idle poll can short-circuit on the server.
      const tok = pendingOptimisticRef.current ? undefined : lastTokenRef.current;
      const data = await getRawMessages(sessionId, currentTail, tok);
      // Session switched while this request was in flight: drop the response so
      // it can't corrupt the now-current session's state (a stale delta would
      // otherwise merge foreign entries / collapse the freshly-reset list).
      if (sessionId !== currentSidRef.current) return;
      // Server short-circuit: the change token (JSONL size+mtime folded with
      // in-flight proxy-snapshot state) matches last poll, so the merged window
      // is provably unchanged. Keep current messages, skip the re-render and the
      // reconcile pass. Safe to skip reconcile here because we never send a
      // token while optimistic bubbles are pending (see tok above).
      if (data.unchanged) return;
      if (data.token !== undefined) lastTokenRef.current = data.token;
      const msgList = normalizeRaw(data.messages ?? []);
      const msgTotal = data.total ?? 0;
      // Incremental delta: the server sent only the latest ~10 JSONL entries plus
      // the current streaming snapshots (to save bandwidth). Merge it into the
      // existing window by uuid instead of replacing — otherwise the visible
      // history would collapse to 10. Full payloads (incremental false/absent —
      // first load, session switch, load-more, rewind, or an outstanding send)
      // still replace as before.
      const isDelta = data.incremental === true;
      // Skip the state update (and the full message-list re-render it forces)
      // when the server returned the same window as last poll. The signature is
      // total + count + an exact stringify of the last two entries — append,
      // truncate (rewind), streaming growth, and stop_reason all change one of
      // these; nothing earlier than the tail mutates in this append-only model
      // except rewind, which changes the count. For a delta this is computed over
      // the delta itself: `total` catches new real entries, the last-two catch
      // in-place growth and snapshot churn.
      const n = msgList.length;
      const sig = `${msgTotal}|${isDelta ? "d" : "f"}|${n}|${JSON.stringify(msgList.slice(Math.max(0, n - 2)))}`;
      const changed = sig !== prevMsgSigRef.current;
      if (changed) {
        const hasBase = messagesRef.current.some((m) => !isSyntheticEntry(m));
        if (!hasBase) {
          // Initial load / post-reset: the payload IS the authoritative window.
          // Anchor history paging at the raw start of this live tail.
          messagesRef.current = msgList;
          prevMsgSigRef.current = sig;
          setMessages(msgList);
          const off = Math.max(0, msgTotal - currentTail);
          oldestOffsetRef.current = off;
          setOldestOffset(off);
        } else {
          // Merge the payload (a delta OR a full live tail) into the existing
          // window by stable uuid. The same splice handles both, so the prepended
          // older history is never wiped by a full-window poll — and a recurring
          // meta/queue content hash can never chop the window mid-history.
          const merged = mergeRawDelta(messagesRef.current, msgList);
          if (merged === null) {
            if (isDelta) {
              // Can't splice a 10-entry delta safely (no uuid overlap): keep the
              // current window, force a full resync on the next poll.
              lastTokenRef.current = undefined; // next poll sends no token → full
              prevMsgSigRef.current = "";       // don't let the full result be skipped
              return;
            }
            // Full window with no overlap (a burst rotated the whole tail out of
            // view): replace with the authoritative window and re-anchor paging.
            messagesRef.current = msgList;
            prevMsgSigRef.current = sig;
            setMessages(msgList);
            const off = Math.max(0, msgTotal - currentTail);
            oldestOffsetRef.current = off;
            setOldestOffset(off);
          } else {
            messagesRef.current = merged;
            prevMsgSigRef.current = sig;
            setMessages(merged);
          }
        }
        setTotal(msgTotal);
        // Clamp the paging offset to the current total: a rewind/compaction can
        // shrink the transcript below where we'd paged to, so never offer to load
        // entries that no longer exist.
        const anchorOff = Math.max(0, msgTotal - currentTail);
        if (oldestOffsetRef.current > anchorOff) {
          oldestOffsetRef.current = anchorOff;
          setOldestOffset(anchorOff);
        }
        // Track newly-appeared compact_boundary entries so we can flash them.
        const freshUuids: string[] = [];
        for (const m of msgList) {
          if (m.type === "system" && (m as unknown as Record<string, unknown>).subtype === "compact_boundary" && m.uuid) {
            if (!seenCompactUuidsRef.current.has(m.uuid)) {
              seenCompactUuidsRef.current.add(m.uuid);
              freshUuids.push(m.uuid);
            }
          }
        }
        if (freshUuids.length > 0) {
          setNewCompactUuids((prev) => {
            const next = new Set(prev);
            freshUuids.forEach((id) => next.add(id));
            return next;
          });
          // Clear the flash after 3 seconds.
          setTimeout(() => {
            setNewCompactUuids((prev) => {
              const next = new Set(prev);
              freshUuids.forEach((id) => next.delete(id));
              return next;
            });
          }, 3000);
        }
      }
      // Reconcile: pair each pending optimistic bubble with a real user-input
      // entry in the JSONL. Exact text-equality is unreliable because Claude
      // wraps slash commands (<command-name>…</command-name>) and may append
      // system-reminder blocks, so we also pair by chronology: real entries
      // whose timestamp falls at/after the optimistic's sentAt (with a small
      // clock-skew slack) consume the earliest unmatched optimistic, in order.
      const now = Date.now();
      const realUserEntries: { text: string; ts: number }[] = [];
      const compactBoundaryTs: number[] = [];
      for (const m of msgList) {
        let text: string | null = null;
        if (m.type === "user" && m.message) {
          text = getTextFromContent(m.message.content as RawContentBlock[] | string).trim();
        } else if (m.type === "attachment") {
          const att = (m as unknown as Record<string, unknown>).attachment as Record<string, unknown> | undefined;
          if (att?.type === "queued_command" && att.prompt) text = String(att.prompt).trim();
        } else if (m.type === "queue-operation") {
          // Claude CLI logs user input typed mid-response as queue-operation enqueue.
          const r = m as unknown as Record<string, unknown>;
          if (r.operation === "enqueue" && typeof r.content === "string") text = r.content.trim();
        } else if (m.type === "system" && (m as unknown as Record<string, unknown>).subtype === "compact_boundary") {
          const tsParsed = m.timestamp ? Date.parse(m.timestamp) : NaN;
          if (!Number.isNaN(tsParsed)) compactBoundaryTs.push(tsParsed);
          continue;
        }
        if (text === null) continue;
        const tsParsed = m.timestamp ? Date.parse(m.timestamp) : NaN;
        realUserEntries.push({ text, ts: Number.isNaN(tsParsed) ? 0 : tsParsed });
      }
      // Draft hygiene: a real user entry whose text equals the cached draft and
      // whose timestamp is newer than the draft's last real edit means the draft
      // WAS delivered — via the Resend bubble, another tab/device, or typed
      // straight into the terminal — so drop the cache. Without this, the draft
      // outlives its own send and gets restored on every refresh (the heartbeat
      // keeps its TTL alive indefinitely).
      {
        const draftText = inputRef.current.trim();
        if (draftText && realUserEntries.some((e) => e.text === draftText && e.ts > inputEditedAtRef.current)) {
          setInput("");
          inputDrafts.delete(sessionId);
          clearDraft(sessionId);
        }
      }
      setOptimisticMsgs((prev) => {
        if (prev.length === 0) return prev;
        const sortedOpt = [...prev].sort((a, b) => a.sentAt - b.sentAt);
        const sortedReal = [...realUserEntries].sort((a, b) => a.ts - b.ts);
        const consumedRealIdx = new Set<number>();
        const resolvedOptIds = new Set<string>();
        // Pass 1: exact text match (preferred — disambiguates rapid sends).
        for (const o of sortedOpt) {
          for (let i = 0; i < sortedReal.length; i++) {
            if (consumedRealIdx.has(i)) continue;
            if (sortedReal[i].text === o.text) {
              consumedRealIdx.add(i);
              resolvedOptIds.add(o.id);
              break;
            }
          }
        }
        // Pass 2: chronological pairing — the earliest unmatched real entry
        // with ts >= sentAt (− 5s slack) resolves the earliest unmatched
        // optimistic. Handles wrapped slash commands and reminder injection.
        for (const o of sortedOpt) {
          if (resolvedOptIds.has(o.id)) continue;
          for (let i = 0; i < sortedReal.length; i++) {
            if (consumedRealIdx.has(i)) continue;
            if (sortedReal[i].ts >= o.sentAt - 5000) {
              consumedRealIdx.add(i);
              resolvedOptIds.add(o.id);
              break;
            }
          }
        }
        // Two-state transition (lost state now lives server-side):
        // - resolved (matched) → drop the optimistic entry
        // - still pending but compact_boundary appeared after sentAt → register
        //   a server-side "lost" (the prompt was likely consumed as the compact
        //   trigger and never reached the model), then drop the optimistic entry
        // - still pending but > 30s old → register lost (catch-all send timeout)
        const toRegister: { text: string; sentAt: number }[] = [];
        const next: OptimisticMsg[] = [];
        for (const o of prev) {
          if (resolvedOptIds.has(o.id)) continue;
          const hadCompactAfter = compactBoundaryTs.some((t) => t > o.sentAt);
          const timedOut = now - o.sentAt > 30_000;
          if (hadCompactAfter || timedOut) {
            toRegister.push({ text: o.text, sentAt: o.sentAt });
          } else {
            next.push(o);
          }
        }
        // Register losses outside the updater (side-effecting network call +
        // its own setState). The optimistic entry is dropped here; the loss
        // re-appears as a server-authoritative bubble via the reconcile effect.
        if (toRegister.length > 0) {
          queueMicrotask(() => toRegister.forEach((r) => registerLostRef.current(r.text, r.sentAt)));
        }
        return next;
      });
      requestAnimationFrame(() => scrollToBottom(false));
    } catch { /* ignore */ }
  }, [sessionId, scrollToBottom]);

  useEffect(() => {
    setMessages([]);
    messagesRef.current = [];
    setTotal(0);
    stickToBottom.current = true;
    // input is intentionally NOT cleared here — the draft cache restores it on remount
    oldestOffsetRef.current = 0;
    setOldestOffset(0);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setOptimisticMsgs([]);
    setServerLost(new Map());
    pendingLostRef.current.clear();
    setNewCompactUuids(new Set());
    seenCompactUuidsRef.current = new Set();
    prevMsgSigRef.current = "";
    setSubagents([]);
  }, [sessionId]);

  // Fetch sub-agents list periodically. New sub-agents only appear while the
  // session is actively running a Task tool, so poll fast (10s) only while
  // streaming and back off to 60s when idle. The effect re-runs on the
  // streaming transition, so a fresh fetch lands right when activity starts or
  // stops — the log-linking map stays current without polling a dormant
  // session every 10s.
  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const list = await getSubAgents(sessionId);
        if (!cancelled) setSubagents(list);
      } catch { /* ignore */ }
    };
    fetch();
    const id = setInterval(fetch, isStreaming ? 10_000 : 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [sessionId, isStreaming]);

  // "Active" = any state where new content can land continuously and must be
  // shown promptly: streaming, compacting, a pending AUQ/approval, or an
  // optimistic send still in flight. Anything here keeps the poll at 1.5s; only
  // a fully-idle session drops to IDLE_POLL_MS. This is a boolean so the poll
  // effect re-runs only on the active↔idle transition, not on every mutation.
  const pollActive =
    isStreaming || isCompacting || isWaitingForAuq ||
    !!pendingAuqData || !!pendingApproveData || optimisticMsgs.length > 0;

  useEffect(() => {
    // Session or active-state changed: drop the change token so the first fetch
    // returns a full payload (it must never be short-circuited). The live tail is
    // fixed (LIVE_TAIL) — it never grows, so polling stays cheap on long sessions.
    lastTokenRef.current = undefined;
    fetchMessages(LIVE_TAIL);
    pollRef.current = setInterval(() => fetchMessages(LIVE_TAIL), pollActive ? POLL_MS : IDLE_POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchMessages, pollActive]);

  // Load one bounded older-history page and PREPEND it. Fetches the raw slice
  // [newOffset, oldestOffset) via the static offset endpoint (no token/delta/
  // snapshots), dedupes by uuid at the seam, lowers the offset, and restores the
  // scroll position (loadMoreAnchorRef + the useLayoutEffect above). This is fully
  // independent of the live poll, so loading history never grows the live window.
  const loadOlder = useCallback(async () => {
    const oldest = oldestOffsetRef.current;
    if (oldest <= 0 || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    lastLoadAtRef.current = Date.now();
    const newOffset = Math.max(0, oldest - HISTORY_PAGE);
    const limit = oldest - newOffset;
    const el = scrollRef.current;
    if (el) loadMoreAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    stickToBottom.current = false;
    try {
      const data = await getRawMessagesPage(sessionId, newOffset, limit);
      if (sessionId !== currentSidRef.current) return;
      const page = normalizeRaw(data.messages ?? []);
      const existing = messagesRef.current;
      const existingUuids = new Set<string>();
      for (const m of existing) { const u = stableUuid(m); if (u !== null) existingUuids.add(u); }
      const fresh = page.filter((m) => { const u = stableUuid(m); return u === null || !existingUuids.has(u); });
      const next = [...fresh, ...existing];
      messagesRef.current = next;
      setMessages(next);
      oldestOffsetRef.current = newOffset;
      setOldestOffset(newOffset);
      if (typeof data.total === "number") setTotal(data.total);
    } catch { /* ignore — user can retry */ }
    finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
      lastLoadAtRef.current = Date.now();
    }
  }, [sessionId]);
  loadMoreRef.current = loadOlder;

  // ── WebSocket ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (chatOnly) return; // terminated sessions: no WS needed
    if (isCodexAppServer) return; // app-server transport: no tmux WS to attach to
    let ws: WsClient | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1500;
    let wsConnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      if (cancelled) return;
      if (wsConnectTimer) { clearTimeout(wsConnectTimer); wsConnectTimer = null; }
      try {
        setWsStatus("connecting");
        // Timeout so a hung fetch doesn't block retry indefinitely
        const res = await Promise.race([
          attachSession(sessionId),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("attach timeout")), 12000)),
        ]);
        if (cancelled) return;
        ws?.close();
        ws = new WsClient({
          url: res.ws_url,
          autoReconnect: false, // ConversationPane handles retry with fresh attachSession
          onOpen: () => {
            if (wsConnectTimer) { clearTimeout(wsConnectTimer); wsConnectTimer = null; }
            if (!cancelled) {
              setWsStatus("connected");
              retryDelay = 1500; // reset backoff on successful connect
            }
          },
          onOutput: () => { /* display handled by polling */ },
          onState: (state) => {
            if (state.status === "terminated" && !cancelled) setWsStatus("disconnected");
          },
          onPromptRejected: (_reason, text) => {
            if (cancelled) return;
            // Drop the most recent optimistic message — it never made it to Claude.
            setOptimisticMsgs((prev) => {
              const idx = [...prev].reverse().findIndex(m => m.text === text);
              if (idx === -1) return prev;
              const realIdx = prev.length - 1 - idx;
              return [...prev.slice(0, realIdx), ...prev.slice(realIdx + 1)];
            });
            // Restore the text into the input box so the user can edit/retry.
            // Don't clobber what they may have started typing in the meantime.
            setInput((cur) => cur ? cur : text);
            inputEditedAtRef.current = Date.now();
            if (text) { inputDrafts.set(sessionId, text); saveDraft(sessionId, text); }
          },
          onClose: () => {
            if (wsConnectTimer) { clearTimeout(wsConnectTimer); wsConnectTimer = null; }
            if (!cancelled) {
              setWsStatus("connecting");
              retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryDelay);
              retryDelay = Math.min(retryDelay * 2, 30000);
            }
          },
        });
        // If WS onopen hasn't fired within 10s, force a retry via the onClose path
        wsConnectTimer = setTimeout(() => { wsConnectTimer = null; ws?.close(); }, 10000);
        wsRef.current = ws;
      } catch {
        if (wsConnectTimer) { clearTimeout(wsConnectTimer); wsConnectTimer = null; }
        if (!cancelled) {
          setWsStatus("connecting");
          retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30000);
        }
      }
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (wsConnectTimer) { clearTimeout(wsConnectTimer); wsConnectTimer = null; }
      ws?.close();
      wsRef.current = null;
    };
  }, [sessionId, isCodexAppServer]);

  // ── Input draft persistence ───────────────────────────────────────────────

  // Heartbeat: while the tab is open and the draft is non-empty, periodically
  // bump the record's updatedAt so the TTL sweeper doesn't reap a draft the
  // user is still composing. touchDraft (not saveDraft) so a stale pane can't
  // resurrect a draft that a send elsewhere already cleared from storage.
  useEffect(() => {
    if (!input) return;
    const id = setInterval(() => { touchDraft(sessionId); }, DRAFT_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [sessionId, input]);

  // Periodic sweep of expired draft keys across all sessions in this origin.
  useEffect(() => {
    cleanupExpiredDrafts();
    const id = setInterval(cleanupExpiredDrafts, DRAFT_CLEANUP_MS);
    return () => clearInterval(id);
  }, []);

  // Keep the pending-optimistic mirror current so fetchMessages can decide
  // whether it's safe to use the change-token short-circuit (see lastTokenRef).
  useEffect(() => {
    pendingOptimisticRef.current = optimisticMsgs.length > 0;
  }, [optimisticMsgs]);

  // Reconcile the server-authoritative lost set from the status poll. The poll
  // is the source of truth (so a dismiss/resend on another client clears it
  // here too), but a freshly-registered entry may not be reflected yet — keep
  // those (tracked in pendingLostRef) for a short grace window so they don't
  // flicker out between registering and the next poll confirming them.
  useEffect(() => {
    const incoming = lostMessages ?? [];
    const incomingIds = new Set(incoming.map((l) => l.id));
    const now = Date.now();
    for (const [id, v] of pendingLostRef.current) {
      if (incomingIds.has(id) || now - v.at > 8000) pendingLostRef.current.delete(id);
    }
    const merged = new Map<string, LostMessage>();
    for (const lm of incoming) merged.set(lm.id, lm);
    for (const [id, v] of pendingLostRef.current) if (!merged.has(id)) merged.set(id, v.lm);
    setServerLost(merged);
  }, [lostMessages]);

  // ── Input / control ───────────────────────────────────────────────────────

  const sendPrompt = useCallback(() => {
    const textPart = input.trim();
    // Allow image-only sends: if user only attached images without typing,
    // still send so Claude has something to analyze.
    if (!textPart && pendingAttachments.length === 0) return;
    if (!wsRef.current || wsStatus !== "connected") return;
    if (hasUnansweredAuq) return;  // Ink would eat the keystrokes — see hasUnansweredAuq comment.
    // wsStatus is a React state set from onClose, so it lags real readyState
    // by a render. Without this check, a silently-closed WS lets us create
    // the optimistic bubble, clear the input, then drop the WS send — the
    // user sees "sending..." for 120s and loses their draft.
    if (!wsRef.current.isOpen()) return;
    // Append `@<abs-path>` references for any attached files. Claude CLI
    // parses the `@` syntax — for images it embeds an image content block;
    // for other files the model sees the path and uses the Read tool.
    const attachmentRefs = pendingAttachments.map((att) => `@${att.path}`).join("\n");
    const text = attachmentRefs
      ? (textPart ? `${textPart}\n\n${attachmentRefs}` : attachmentRefs)
      : textPart;
    // Optimistic: show immediately before JSONL poll confirms it
    setOptimisticMsgs((prev) => [
      ...prev,
      { id: _randomId(), text, sentAt: Date.now(), status: "pending" },
    ]);
    setInput("");
    setPendingAttachments([]);
    setAttachmentUploadError(null);
    inputDrafts.delete(sessionId);
    clearDraft(sessionId);
    wsRef.current.sendPrompt(text);
    stickToBottom.current = true;
    requestAnimationFrame(() => scrollToBottom(false));
  }, [input, wsStatus, hasUnansweredAuq, scrollToBottom, pendingAttachments, sessionId]);

  const stopResponse = useCallback(() => {
    if (!wsRef.current) return;
    wsRef.current.sendInput("\x03");
  }, []);

  const handlePickAttachment = useCallback(() => {
    attachmentInputRef.current?.click();
  }, []);

  const handleAttachmentFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttachmentUploadError(null);
    setIsUploadingAttachment(true);
    try {
      // Sequential upload — keeps the order of chips matching the user's
      // selection order, and small images are fast enough that parallel
      // upload isn't worth the complexity here.
      for (const f of Array.from(files)) {
        try {
          const uploaded = await uploadAttachment(sessionId, f);
          setPendingAttachments((prev) => [...prev, uploaded]);
        } catch (e) {
          setAttachmentUploadError(e instanceof Error ? e.message : String(e));
          break;
        }
      }
    } finally {
      setIsUploadingAttachment(false);
    }
  }, [sessionId]);

  const removePendingAttachment = useCallback((path: string) => {
    setPendingAttachments((prev) => prev.filter((p) => p.path !== path));
  }, []);

  // Transient top toast with its own auto-dismiss (independent of the
  // lost-transition effect's timer).
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTransientToast = useCallback((msg: string) => {
    setLostToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => { setLostToast(null); toastTimerRef.current = null; }, 3000);
  }, []);

  // registerLost records a detected send-failure server-side so the red bubble
  // shows on every client. It also fires the sender-local toast and inserts the
  // returned LostMessage optimistically (grace-protected) for instant feedback.
  const registerLost = useCallback((text: string, sentAt: number) => {
    showTransientToast("输入未发送成功，请到对话区点击 Resend");
    // sent_at in epoch SECONDS to match the backend dedup window (5s).
    registerLostMessage(sessionId, { text, sentAt: sentAt / 1000 })
      .then((lm) => {
        pendingLostRef.current.set(lm.id, { lm, at: Date.now() });
        setServerLost((prev) => {
          const n = new Map(prev);
          n.set(lm.id, lm);
          return n;
        });
      })
      .catch(() => { /* next poll will surface it if the server recorded it */ });
  }, [sessionId, showTransientToast]);
  useEffect(() => { registerLostRef.current = registerLost; }, [registerLost]);

  const resendLostMsg = useCallback((lostId: string, text: string) => {
    if (hasUnansweredAuq) { showTransientToast("请先回答上方的问题，再重发消息"); return; }
    // Weak-network reconnect window: the WS isn't OPEN, so sendPrompt would be
    // silently dropped. Tell the user instead of leaving the failed bubble
    // unchanged (which reads as "resend did nothing").
    if (!wsRef.current || !wsRef.current.isOpen()) {
      showTransientToast("连接已断开，正在重连，请稍后再试");
      return;
    }
    // Drop the lost bubble locally + server-side now. On successful delivery the
    // backend also clears any same-text lost on all clients; dismissing here
    // covers the case where this id lingers if delivery fails again.
    setServerLost((prev) => { const n = new Map(prev); n.delete(lostId); return n; });
    pendingLostRef.current.delete(lostId);
    dismissLostMessage(sessionId, lostId).catch(() => {});
    setOptimisticMsgs((prev) => [
      ...prev,
      { id: _randomId(), text, sentAt: Date.now(), status: "pending" },
    ]);
    wsRef.current.sendPrompt(text);
    // onPromptRejected restored this text into the input + draft cache when the
    // send was first lost; the resend delivers it, so clear the matching draft
    // (it used to survive forever and reappear on every refresh).
    if (inputRef.current.trim() === text.trim()) setInput("");
    if ((inputDrafts.get(sessionId) ?? "").trim() === text.trim()) {
      inputDrafts.delete(sessionId);
      clearDraft(sessionId);
    }
    stickToBottom.current = true;
    requestAnimationFrame(() => scrollToBottom(false));
  }, [hasUnansweredAuq, scrollToBottom, showTransientToast, sessionId]);

  const dismissLostMsg = useCallback((lostId: string) => {
    setServerLost((prev) => { const n = new Map(prev); n.delete(lostId); return n; });
    pendingLostRef.current.delete(lostId);
    dismissLostMessage(sessionId, lostId).catch(() => {});
  }, [sessionId]);
  useEffect(() => { if (stopRef) stopRef.current = stopResponse; }, [stopRef, stopResponse]);
  useEffect(() => { if (refreshRef) refreshRef.current = () => fetchMessages(LIVE_TAIL); }, [refreshRef, fetchMessages]);

  // When the backend signals Claude is waiting for AUQ but JSONL hasn't been
  // written yet, poll every 800ms until the AUQ block appears (max 30s).
  useEffect(() => {
    if (!isWaitingForAuq || hasUnansweredAuq) return;
    fetchMessages(LIVE_TAIL);
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed += 800;
      if (elapsed >= 30000) { clearInterval(id); return; }
      fetchMessages(LIVE_TAIL);
    }, 800);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWaitingForAuq, hasUnansweredAuq]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendPrompt();
    }
  };

  const [rewinding, setRewinding] = useState(false);
  const handleRewindMessage = useCallback(async (uuid: string) => {
    if (!window.confirm("Rewind to this message? Code file changes made after this point will be reverted and subsequent conversation will be deleted.")) return;
    setRewinding(true);
    try {
      await rewindSession(sessionId, uuid);
      await fetchMessages(LIVE_TAIL);
    } catch (e) {
      alert("Rewind failed: " + String(e));
    } finally {
      setRewinding(false);
    }
  }, [sessionId, fetchMessages]);

  const wsColor = wsStatus === "connected" ? "var(--accent-green)" : wsStatus === "connecting" ? "var(--accent-amber)" : "var(--accent-red)";
  const wsLabel = wsStatus === "connected" ? "Connected" : wsStatus === "connecting" ? "Reconnecting…" : "Disconnected";
  const canLoadMore = oldestOffset > 0;

  return (
    <div ref={paneContainerRef} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", background: "var(--bg-base)", position: "relative" }}>
      {/* Lost-prompt toast (appears once per lost transition; 3s auto-dismiss) */}
      {lostToast && (
        <div style={{
          position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
          background: "var(--accent-red, #c0392b)", color: "#fff",
          padding: "6px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600,
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          pointerEvents: "none", zIndex: 100,
        }}>{lostToast}</div>
      )}
      {/* Load more banner */}
      {canLoadMore && (
        <div style={{
          padding: "5px 12px", background: "var(--bg-surface)",
          borderBottom: "1px solid var(--bg-hover)",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          flexShrink: 0, fontSize: 12, color: "var(--text-muted)",
        }}>
          <span>{oldestOffset} earlier entries not shown</span>
          <button
            onClick={() => void loadOlder()}
            disabled={loadingMore}
            style={{ background: "var(--border)", color: loadingMore ? "var(--text-faint)" : "var(--text-secondary)", fontSize: 11, padding: "3px 12px", border: "1px solid var(--text-faintest)", borderRadius: 4, cursor: loadingMore ? "default" : "pointer", opacity: loadingMore ? 0.5 : 1 }}
          >
            {loadingMore ? "Loading…" : "↑ Load more"}
          </button>
        </div>
      )}

      {/* Scroll area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: "auto", paddingTop: 8, paddingBottom: 8, minHeight: 0 }}
      >
        {displayEntries.length === 0 && optimisticMsgs.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", minHeight: 120, color: "var(--text-faint)", fontSize: 13 }}>
            No conversation yet
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {displayEntries.map((entry, i) => {
              // The last assistant entry gets isActiveThinking when Claude is streaming
              const isLast = i === displayEntries.length - 1;
              const prevIsLast = i === displayEntries.length - 2;
              const uid = entry.uuid || entryKey(entry);

              // Task run grouping: render whole run at the start entry, suppress the rest
              const taskRun = taskRunMap.get(uid);
              if (taskRun) {
                if (!taskRun.isStart) return null;
                return <TaskGroupBlock key={uid} blocks={taskRun.blocks} />;
              }
              // Account for optimistic msg appearing after: last *real* assistant entry.
              // Gate on stop_reason: an assistant entry that already carries one is done,
              // even when backend is_streaming flips true from incidental tmux activity.
              // Without this guard, a finished message that follows a compact_boundary
              // gets re-rendered as the "Compacting…" placeholder every ~8s.
              const isFinishedAssistant = entry.type === "assistant" && !!entry.message?.stop_reason;
              const isActiveThinking = isStreaming && entry.type === "assistant" && !isFinishedAssistant && (isLast || (prevIsLast && optimisticMsgs.length > 0));
              // During compaction: the entry before the active assistant is the compact_boundary system message
              // (possibly with a compact-summary user message in between, so check 2 entries back)
              const prevEntry = i > 0 ? displayEntries[i - 1] as unknown as Record<string, unknown> : null;
              const pp = i >= 2 ? displayEntries[i - 2] as unknown as Record<string, unknown> : null;
              const isCompacting = isActiveThinking && (prevEntry?.subtype === "compact_boundary" || pp?.subtype === "compact_boundary");
              if (isCompacting) {
                return <ThinkingRedacted key={uid} isActive label="Compacting…" />;
              }
              // After the last complete assistant message, detect interactive reply blocks.
              // When stop_reason === "tool_use" Claude Code has definitely stopped and is
              // waiting for a tool result — show the block immediately without waiting for
              // isStreaming to clear (which takes ~2-4 s due to PTY idle + poll lag).
              const stopReason = entry.message?.stop_reason;
              const isWaitingForTool = stopReason === "tool_use";

              const sendAnswer = (text: string) => {
                setInput("");
                inputDrafts.delete(sessionId);
                clearDraft(sessionId);
                wsRef.current?.sendPrompt(text);
                stickToBottom.current = true;
                requestAnimationFrame(() => scrollToBottom(true));
              };

              // ExitPlanMode goes through a dedicated POST that drives the
              // tmux modal directly (Down × n + Enter). The previous chat-
              // channel path paste-buffered free text ("Approved"/"Rejected"),
              // which matched no option — the trailing Enter then submitted
              // the modal's default-highlighted option 1 (approve + bypass
              // perms), so Reject was silently approving.
              const submitPlanDecision = (choice: PlanChoice) => {
                return approvePlan(sessionId, choice)
                  .then(() => {
                    stickToBottom.current = true;
                    requestAnimationFrame(() => scrollToBottom(true));
                  })
                  .catch((e: unknown) => {
                    // Backend refused (e.g. 409: no recognized ExitPlanMode menu on
                    // screen). Surface it instead of silently swallowing, and rethrow
                    // so PlanApprovalBlock keeps the card visible for retry.
                    const msg = e instanceof Error ? e.message : String(e);
                    const what = choice.label ?? (choice.decision === "approve" ? "批准" : choice.decision === "reject" ? "拒绝" : "选项");
                    setLostToast(`Plan「${what}」失败：${msg}（请在终端中手动确认）`);
                    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
                    toastTimerRef.current = setTimeout(() => { setLostToast(null); toastTimerRef.current = null; }, 4000);
                    throw e;
                  });
              };

              // ExitPlanMode (unanswered) — show plan approval card. Runs
              // independently of isLast/isStreaming so transient entries
              // landing after the assistant's ExitPlanMode (compact_boundary,
              // stop-hook user entries, etc.) don't cycle the body back to
              // the "Loading plan…" / "Awaiting plan approval…" placeholder.
              if (entry.type === "assistant" && entry.message && !chatOnly) {
                const blocks = getBlocks(entry.message.content as RawContentBlock[] | string);
                const exitPlanBlock = blocks.find(b => b.type === "tool_use" && b.name === "ExitPlanMode" && !toolResults.has(b.id!));
                if (exitPlanBlock) {
                  const planInput = (exitPlanBlock.input as Record<string, unknown>) || {};
                  const planText = planInput.plan ? String(planInput.plan) : undefined;
                  const planPath = exitPlanBlock.id ? planPathByExitBlockId.get(exitPlanBlock.id) : undefined;
                  return (
                    <React.Fragment key={uid}>
                      {/* hideExitPlanBlock=true: PlanApprovalBlock below handles the UI */}
                      <MessageEntry
                        entry={entry}
                        toolResults={toolResults} codexToolResults={codexToolResults}
                        compactSummaries={compactSummaries}
                        isActiveThinking={isActiveThinking}
                        isNewCompact={newCompactUuids.has(entry.uuid || "")}
                        sessionId={sessionId}
                        subagentsByDesc={subagentsByDesc}
                        chatOnly={chatOnly}
                        hideExitPlanBlock
                        planPathByExitBlockId={planPathByExitBlockId}
                        onRewindMessage={handleRewindMessage}
                      />
                      <PlanApprovalBlock
                        blockId={exitPlanBlock.id!}
                        planText={planText}
                        planPath={planPath}
                        options={pendingPlanData?.options}
                        onSubmit={submitPlanDecision}
                      />
                    </React.Fragment>
                  );
                }
              }

              if (
                entry.type === "assistant" &&
                isLast &&
                (!isStreaming || isWaitingForTool) &&
                optimisticMsgs.length === 0 &&
                entry.message
              ) {
                const blocks = getBlocks(entry.message.content as RawContentBlock[] | string);

                // AskUserQuestion tool_use block (unanswered) — render the
                // surrounding message text only; the interactive widget is
                // pinned above the status banner so it survives compaction.
                const auqBlock = blocks.find(b => b.type === "tool_use" && b.name === "AskUserQuestion" && !toolResults.has(b.id!));
                if (auqBlock) {
                  const inp = auqBlock.input as Record<string, unknown>;
                  const rawQs = Array.isArray(inp?.questions) ? inp.questions as AskQuestion[] : [];
                  if (rawQs.length > 0) {
                    return (
                      <MessageEntry
                        key={uid}
                        entry={entry}
                        toolResults={toolResults} codexToolResults={codexToolResults}
                        compactSummaries={compactSummaries}
                        isActiveThinking={isActiveThinking}
                        isNewCompact={newCompactUuids.has(entry.uuid || "")}
                        sessionId={sessionId}
                        subagentsByDesc={subagentsByDesc}
                        chatOnly={chatOnly}
                        hideAuqDisplay
                        planPathByExitBlockId={planPathByExitBlockId}
                        onRewindMessage={handleRewindMessage}
                      />
                    );
                  }
                }

                // Numbered text questions
                const fullText = blocks.filter(b => b.type === "text").map(b => b.text || "").join("\n");
                const questions = parseQuestions(fullText);
                if (questions.length >= 2) {
                  return (
                    <React.Fragment key={uid}>
                      <MessageEntry
                        entry={entry}
                        toolResults={toolResults} codexToolResults={codexToolResults}
                        compactSummaries={compactSummaries}
                        isActiveThinking={isActiveThinking}
                        isNewCompact={newCompactUuids.has(entry.uuid || "")}
                        sessionId={sessionId}
                        subagentsByDesc={subagentsByDesc}
                        chatOnly={chatOnly}
                        planPathByExitBlockId={planPathByExitBlockId}
                        onRewindMessage={handleRewindMessage}
                      />
                      <QAReplyBlock
                        entryId={uid}
                        questions={questions}
                        onSubmit={sendAnswer}
                      />
                    </React.Fragment>
                  );
                }
              }
              return (
                <MessageEntry
                  key={uid}
                  entry={entry}
                  toolResults={toolResults} codexToolResults={codexToolResults}
                  compactSummaries={compactSummaries}
                  isActiveThinking={isActiveThinking}
                  isNewCompact={newCompactUuids.has(entry.uuid || "")}
                  sessionId={sessionId}
                  subagentsByDesc={subagentsByDesc}
                  chatOnly={chatOnly}
                  planPathByExitBlockId={planPathByExitBlockId}
                  onRewindMessage={handleRewindMessage}
                />
              );
            })}
            {/* Server-synced "send failed" bubbles — solid red with Resend/Dismiss.
                Driven by the status poll (serverLost), so they appear on every
                client and clear everywhere when dismissed or successfully resent. */}
            {[...serverLost.values()].sort((a, b) => a.created_at - b.created_at).map((lm) => (
              <div key={lm.id} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", padding: "0 16px 2px" }}>
                <div style={{
                  maxWidth: "75%", padding: "9px 14px",
                  borderRadius: "14px 14px 3px 14px",
                  background: "rgba(180, 60, 60, 0.18)", border: "1px solid var(--accent-red, #c0392b)",
                  color: "var(--text-default)", fontSize: 13, lineHeight: 1.6,
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                }}>
                  <span style={{ marginRight: 6 }}>⚠️</span>{renderPromptWithImages(lm.text, sessionId)}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, paddingRight: 2 }}>
                  <span style={{ fontSize: 10, color: "var(--accent-red, #c0392b)" }}>Send failed — likely eaten by auto-compact</span>
                  <button
                    onClick={() => resendLostMsg(lm.id, lm.text)}
                    style={{
                      fontSize: 11, padding: "2px 10px", borderRadius: 4,
                      background: "var(--accent-blue, #3498db)", color: "#fff",
                      border: "none", cursor: "pointer",
                    }}
                  >Resend</button>
                  <button
                    onClick={() => dismissLostMsg(lm.id)}
                    style={{
                      fontSize: 11, padding: "2px 10px", borderRadius: 4,
                      background: "transparent", color: "var(--text-faint)",
                      border: "1px solid var(--border-default)", cursor: "pointer",
                    }}
                  >Dismiss</button>
                </div>
              </div>
            ))}
            {/* Optimistic pending messages: dashed/blue while waiting JSONL confirm. */}
            {optimisticMsgs.map((o) => (
              <div key={o.id} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", padding: "0 16px 2px", opacity: 0.65 }}>
                <div style={{
                  maxWidth: "75%", padding: "9px 14px",
                  borderRadius: "14px 14px 3px 14px",
                  background: "#1c3a5e", border: "1px dashed #1d4f8a",
                  color: "#cce5ff", fontSize: 13, lineHeight: 1.6,
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                }}>
                  {renderPromptWithImages(o.text, sessionId)}
                </div>
                <span style={{ fontSize: 10, color: "var(--text-faintest)", marginTop: 2, paddingRight: 2 }}>sending…</span>
              </div>
            ))}
            {/* Pending tool approval from hooks — shown when Claude is waiting for permission */}
            {pendingApproveData && !optimisticMsgs.some((o) => o.status === "pending") && (
              <ToolApprovalBlock
                sessionId={sessionId}
                toolName={pendingApproveData.tool_name}
                toolInput={pendingApproveData.tool_input}
                onDone={() => {}}
              />
            )}
            {/* Thinking placeholder: shown when Claude is streaming but no assistant entry visible yet */}
            {isStreaming && displayEntries.length > 0 && displayEntries[displayEntries.length - 1].type !== "assistant" && (() => {
              const lastEntry = displayEntries[displayEntries.length - 1] as unknown as Record<string, unknown>;
              const prevToLast = displayEntries.length >= 2 ? displayEntries[displayEntries.length - 2] as unknown as Record<string, unknown> : null;
              const isAfterCompact = lastEntry.subtype === "compact_boundary" || prevToLast?.subtype === "compact_boundary";
              return <ThinkingRedacted isActive label={isAfterCompact ? "Compacting…" : undefined} />;
            })()}
          </div>
        )}
      </div>

      {/* Pinned AUQ — sits between the scrolling chat and the status banner.
          Sources can flicker during compaction; stickyAuq holds the question
          across those flickers so the user can always answer. flexShrink:0
          guarantees nothing else can squeeze it out of the column. */}
      {stickyAuq && (
        <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)", background: "var(--bg-surface)" }}>
          <AskUserQuestionBlock
            sessionId={sessionId}
            blockId={stickyAuq.blockId}
            questions={stickyAuq.questions}
            maxHeight={paneHeight > 0 ? Math.round(paneHeight / 2) : undefined}
            onSubmitAnswers={(answers) => {
              if (isCodexAppServer) {
                // codex expects {answers: {<qid>: {answers: [<str>, ...]}}};
                // collapse our per-question structured answers into the
                // string-array shape keyed by question.id.
                const byId = extractCodexAuqAnswers(answers, stickyAuq.questions);
                resolveCodexAuq(sessionId, byId).catch((err) => {
                  console.error("codex AUQ resolve failed", err);
                });
              } else {
                submitAuqAnswers(sessionId, answers, stickyAuq.questions);
              }
              setStickyAuq(null);
            }}
          />
        </div>
      )}

      {/* Status banner – three states: compacting (orange + progress) / responding (stop button) / idle (faint).
          Codex app-server mode has no terminal WS, so we gate on transport too — liveness is
          owned elsewhere (status poll + codex_appserver_manager). */}
      {!chatOnly && (wsStatus === "connected" || isCodexAppServer) && (() => {
        if (isStreaming && isCompacting) {
          const pctNum = compactingProgress ? parseInt(compactingProgress, 10) : NaN;
          const hasPct = Number.isFinite(pctNum) && pctNum >= 0 && pctNum <= 100;
          const filled = hasPct ? Math.max(0, Math.min(10, Math.round(pctNum / 10))) : 0;
          const bar = "▰".repeat(filled) + "▱".repeat(10 - filled);
          return (
            <div style={{
              flexShrink: 0,
              borderTop: "1px solid color-mix(in srgb, var(--accent-orange, #d59f00) 35%, transparent)",
              background: "color-mix(in srgb, var(--accent-orange, #d59f00) 14%, var(--bg-surface))",
              color: "var(--accent-orange, #d59f00)",
              padding: "5px 12px", display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
              fontSize: 11.5,
            }}>
              <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "var(--accent-orange, #d59f00)", animation: "cursor-blink 1s step-end infinite" }} />
              <span>Compacting conversation…</span>
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", letterSpacing: 1, opacity: hasPct ? 1 : 0.55 }}>{bar}</span>
              <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 32, textAlign: "right" }}>{hasPct ? `${pctNum}%` : "…"}</span>
            </div>
          );
        }
        if (isStreaming) {
          // A queue-operation:enqueue that hasn't been promoted to a real user
          // message is a user prompt waiting behind the active response.
          const hasQueuedPrompt = displayEntries.some((e) => {
            if (e.type !== "queue-operation") return false;
            const r = e as unknown as Record<string, unknown>;
            if (r.operation !== "enqueue") return false;
            const content = String(r.content ?? "").trim();
            return (
              content.length > 0 &&
              !content.startsWith("<task-notification>") &&
              !content.startsWith("<system-reminder>")
            );
          });
          return (
            <div style={{
              flexShrink: 0, borderTop: "1px solid var(--border)",
              background: "var(--bg-surface)",
              padding: "5px 12px", display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            }}>
              <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "var(--accent-blue, #58a6ff)", animation: "cursor-blink 1s step-end infinite" }} />
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{agentDisplayName} is responding…</span>
              <button
                onClick={stopResponse}
                style={{
                  background: "#7f1d1d", color: "#fca5a5",
                  border: "1px solid #991b1b", borderRadius: 5,
                  padding: "3px 12px", fontSize: 11.5, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 5,
                }}
                title={hasQueuedPrompt ? "Skip current response; queued prompt becomes active (Ctrl+C)" : "Stop (Ctrl+C)"}
              >
                <span style={{ fontSize: 10 }}>■</span> {hasQueuedPrompt ? "Stop / Skip" : "Stop"}
              </button>
            </div>
          );
        }
        // Idle — faint state so users can see the session is alive but waiting for input.
        return (
          <div style={{
            flexShrink: 0, borderTop: "1px solid var(--border)",
            background: "var(--bg-surface)",
            padding: "4px 12px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            opacity: 0.6,
          }}>
            <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", border: "1px solid var(--text-faint, #6e7681)" }} />
            <span style={{ fontSize: 11, color: "var(--text-faint, #6e7681)" }}>Idle · ready for input</span>
          </div>
        );
      })()}

      {/* Input bar – hidden in read-only chat mode AND in codex app-server mode
          (the parent renders CodexChatInput against /codex-message instead). */}
      {!chatOnly && !isCodexAppServer && <div style={{ flexShrink: 0, borderTop: "1px solid var(--bg-hover)", background: "var(--bg-surface)" }}>
        {/* Top grip: drag up to enlarge the input. The textarea sits at the bottom of
            the page, so resizing must extend upward, not from a corner. Pointer
            events + touch-action:none so the drag also works on mobile (capped
            at 3× there — see inputHeightMax); the hit area is taller than the
            visible bar to be finger-friendly. */}
        <div
          onPointerDown={(e) => {
            startInputHeightDrag({
              sessionId,
              startClientY: e.clientY,
              startHeight: inputHeight,
              maxHeight: inputHeightMax(),
              onChange: setInputHeight,
            });
          }}
          title="Drag to resize input"
          style={{
            height: 14, cursor: "ns-resize", display: "flex", alignItems: "center", justifyContent: "center",
            background: "transparent", touchAction: "none",
          }}
        >
          <div style={{ width: 40, height: 4, borderRadius: 2, background: "var(--text-faintest)" }} />
        </div>
        {/* Hidden file input for attachment upload — triggered by 📎 button below. */}
        <input
          ref={attachmentInputRef}
          type="file"
          accept="*/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = e.target.files;
            void handleAttachmentFiles(files);
            // Reset so selecting the same file again re-fires onChange
            if (e.target) e.target.value = "";
          }}
        />
        {(pendingAttachments.length > 0 || attachmentUploadError) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "0 10px 4px", alignItems: "center" }}>
            {pendingAttachments.map((att) => (
              <span
                key={att.path}
                title={`${att.filename} — ${att.path}`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: "var(--bg-hover)", border: "1px solid var(--text-faintest)",
                  borderRadius: 6, padding: "2px 4px 2px 4px", fontSize: 11,
                  color: "var(--text-body)", maxWidth: 240,
                }}
              >
                {att.is_image && att.url ? (
                  <img
                    src={buildUploadedAttachmentUrl(sessionId, att.stored_name)}
                    alt={att.filename}
                    style={{
                      width: 24, height: 24, objectFit: "cover", borderRadius: 4,
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <span
                    style={{
                      width: 24, height: 24, borderRadius: 4, flexShrink: 0,
                      background: "var(--bg-base)", border: "1px solid var(--text-faintest)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 13,
                    }}
                  >📄</span>
                )}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {att.filename}
                </span>
                <button
                  onClick={() => removePendingAttachment(att.path)}
                  title="Remove"
                  style={{
                    background: "transparent", border: "none", color: "var(--text-faint)",
                    cursor: "pointer", padding: "0 4px", fontSize: 13, lineHeight: 1,
                  }}
                >×</button>
              </span>
            ))}
            {attachmentUploadError && (
              <span style={{ fontSize: 11, color: "#f85149" }}>
                upload failed: {attachmentUploadError}
              </span>
            )}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end", padding: "2px 10px 8px" }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              const val = e.target.value;
              setInput(val);
              inputEditedAtRef.current = Date.now();
              if (val) { inputDrafts.set(sessionId, val); saveDraft(sessionId, val); }
              else { inputDrafts.delete(sessionId); clearDraft(sessionId); }
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              hasUnansweredAuq
                ? "Answer the question above before sending — typing is allowed"
                : wsStatus === "connected" ? "Type a prompt… (Ctrl+Enter to send)" : wsLabel
            }
            disabled={wsStatus !== "connected"}
            style={{
              flex: 1, background: "var(--bg-base)",
              border: "1px solid var(--text-faintest)", borderRadius: 8,
              padding: "7px 11px", color: "var(--text-body)",
              fontSize: 13, resize: "none", outline: "none",
              fontFamily: "inherit", lineHeight: 1.5,
              // height is managed by the auto-grow layout effect above.
              opacity: wsStatus !== "connected" ? 0.5 : 1,
            }}
          />
          {(() => {
            const sendDisabled =
              (!input.trim() && pendingAttachments.length === 0) ||
              wsStatus !== "connected" ||
              hasUnansweredAuq;
            const uploadDisabled = wsStatus !== "connected" || isUploadingAttachment;
            // PC: 32×32 paired buttons. Side-by-side when textarea is short;
            // stack vertically (attachment above send) once the textarea is
            // tall enough to host both buttons + gap (≥72px). Uses the
            // effective auto-grown height so typing past ~2 lines flips the
            // layout too, not just the drag grip.
            const stack = autoHeight >= 72;
            return (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <div style={{ display: "flex", flexDirection: stack ? "column" : "row", gap: 4 }}>
                  <button
                    ref={historyButtonRef}
                    onClick={() => {
                      const rect = historyButtonRef.current?.getBoundingClientRect() ?? null;
                      const container = paneContainerRef.current?.getBoundingClientRect() ?? null;
                      setHistoryPopover(historyPopover ? null : { rect, container });
                    }}
                    onPointerDown={(e) => e.preventDefault()}
                    style={{
                      background: "var(--bg-base)",
                      color: "var(--text-body)",
                      border: "1px solid var(--text-faintest)", borderRadius: 8,
                      width: 32, height: 32, fontSize: 14,
                      cursor: "pointer",
                      transition: "background 120ms",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-base)"; }}
                    title="Sent history — recover prompts the TUI ate"
                  >↺</button>
                  <button
                    onClick={handlePickAttachment}
                    onPointerDown={(e) => e.preventDefault()}
                    disabled={uploadDisabled}
                    style={{
                      background: "var(--bg-base)",
                      color: "var(--text-body)",
                      border: "1px solid var(--text-faintest)", borderRadius: 8,
                      width: 32, height: 32, fontSize: 14,
                      cursor: uploadDisabled ? "default" : "pointer",
                      opacity: uploadDisabled ? 0.45 : 1,
                      transition: "background 120ms",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                    onMouseEnter={(e) => { if (!uploadDisabled) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-base)"; }}
                    title={isUploadingAttachment ? "Uploading…" : "Attach file (any type, ≤50MB)"}
                  >{isUploadingAttachment ? "…" : "📎"}</button>
                  <button
                    onClick={sendPrompt}
                    onPointerDown={(e) => e.preventDefault()}
                    disabled={sendDisabled}
                    style={{
                      background: sendDisabled ? "var(--bg-hover)" : "#238636",
                      color: sendDisabled ? "var(--text-faint)" : "#fff",
                      border: sendDisabled ? "1px solid var(--text-faintest)" : "1px solid #238636",
                      borderRadius: 8,
                      width: 32, height: 32, fontSize: 14,
                      cursor: sendDisabled ? "default" : "pointer",
                      opacity: sendDisabled ? 0.6 : 1,
                      transition: "background 120ms",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                    onMouseEnter={(e) => { if (!sendDisabled) e.currentTarget.style.background = "#2ea043"; }}
                    onMouseLeave={(e) => { if (!sendDisabled) e.currentTarget.style.background = "#238636"; }}
                    title={hasUnansweredAuq ? "Answer the question above first" : "Send (Ctrl+Enter)"}
                  >↑</button>
                </div>
                <span style={{ fontSize: 9, color: wsColor }}>{wsLabel}</span>
              </div>
            );
          })()}
        </div>
      </div>}
      {historyPopover && (
        <PromptHistoryPopover
          sessionId={sessionId}
          anchorRect={historyPopover.rect}
          containerRect={historyPopover.container}
          mobile={typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches}
          onPick={(text) => {
            setInput(text);
            inputEditedAtRef.current = Date.now();
            try { inputDrafts.set(sessionId, text); saveDraft(sessionId, text); } catch {}
            textareaRef.current?.focus();
          }}
          onClose={() => setHistoryPopover(null)}
        />
      )}
    </div>
  );
}
