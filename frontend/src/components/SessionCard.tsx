import { useState, useEffect, useRef } from "react";
import type { SessionMeta, ScheduledTask } from "../api/sessionApi";
import { createTask, cancelTask, updateTaskCommand, renameSession } from "../api/sessionApi";
import { usePageVisible } from "../hooks/usePageVisible";
import scheduleIcon from "../assets/schedule.svg";

function _relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Clear "last prompt" timestamp: a chip whose colour encodes recency so it
// stands out from the prompt text — recent activity is brightest/green and it
// fades as it ages. Full date/time on hover.
function LastPromptTime({ iso }: { iso: string }) {
  const ageSec = (Date.now() - new Date(iso).getTime()) / 1000;
  // Recency tiers → colour + emphasis. All theme-aware CSS vars.
  let color = "var(--text-muted)";
  let weight = 500;
  if (ageSec < 300) { color = "var(--accent-green)"; weight = 600; }        // <5min: live
  else if (ageSec < 3600) { color = "var(--accent-blue)"; }                 // <1h: recent
  else if (ageSec < 86400) { color = "var(--text-secondary)"; }             // <1d
  return (
    <span
      title={`Last prompt: ${new Date(iso).toLocaleString()}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 10,
        fontWeight: weight,
        color,
        background: "var(--bg-hover)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        padding: "1px 6px",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {_relTime(iso)}
    </span>
  );
}

const STATUS_COLORS: Record<string, string> = {
  creating: "#f0ad4e",
  running: "#5cb85c",
  detached: "#5bc0de",
  archived: "#777",
  terminated: "#d9534f",
};

export type AttentionKind = "plan" | "auq" | "approve";

interface Props {
  session: SessionMeta;
  isActive?: boolean;
  showOwner?: boolean;
  // When set, the card shows a prominent attention badge. Provided by the
  // SessionsPage poll loop from the per-session tui_* status fields.
  attentionKind?: AttentionKind | null;
  onAttach?: () => void;
  onViewChat?: () => void;
  onTerminate?: () => void;
  onResume?: () => void;
  onDelete?: () => void;
  onTaskChange?: () => void;
  onRename?: () => void;
  loading?: boolean;
}

export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  plan: "APPROVE PLAN",
  auq: "ANSWER QUESTION",
  approve: "APPROVE TOOL",
};

function formatRemaining(runAt: string): string {
  const ms = new Date(runAt).getTime() - Date.now();
  if (ms <= 0) return "due";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

type DelayUnit = "seconds" | "minutes" | "hours";

const _UNIT_SECS: Record<DelayUnit, number> = { seconds: 1, minutes: 60, hours: 3600 };

function _toSeconds(value: string, unit: DelayUnit): number {
  return Math.max(1, parseInt(value, 10) || 1) * _UNIT_SECS[unit];
}

function ScheduleForm({
  sessionId,
  onCreated,
  onClose,
}: {
  sessionId: string;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [command, setCommand] = useState("");
  const [delayValue, setDelayValue] = useState("5");
  const [delayUnit, setDelayUnit] = useState<DelayUnit>("minutes");
  const [loopEnabled, setLoopEnabled] = useState(false);
  // Loop fields are user-editable but track After-side defaults until the
  // user manually edits them — see effect below.
  const [loopValue, setLoopValue] = useState("5");
  const [loopUnit, setLoopUnit] = useState<DelayUnit>("minutes");
  const [loopValueTouched, setLoopValueTouched] = useState(false);
  const [loopUnitTouched, setLoopUnitTouched] = useState(false);
  const [loading, setLoading] = useState(false);

  // Keep loop value/unit synced with After until user explicitly edits them.
  useEffect(() => { if (!loopValueTouched) setLoopValue(delayValue); }, [delayValue, loopValueTouched]);
  useEffect(() => { if (!loopUnitTouched) setLoopUnit(delayUnit); }, [delayUnit, loopUnitTouched]);

  const submit = async () => {
    if (!command.trim()) return;
    const delay_seconds = _toSeconds(delayValue, delayUnit);
    const loop_seconds = loopEnabled ? _toSeconds(loopValue, loopUnit) : null;
    setLoading(true);
    try {
      await createTask(sessionId, command.trim(), delay_seconds, loop_seconds);
      onCreated();
      onClose();
    } catch (e) {
      alert(String(e));
    } finally {
      setLoading(false);
    }
  };

  const unitSelectStyle: React.CSSProperties = {
    background: "var(--bg-hover)",
    border: "1px solid var(--text-faintest)",
    borderRadius: 4,
    color: "var(--text-body)",
    fontSize: 11,
    padding: "5px 6px",
    cursor: "pointer",
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 10000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-modal)",
          border: "1px solid var(--text-faintest)",
          borderRadius: 8,
          padding: 16,
          width: "min(440px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 600 }}>Schedule Command</div>
          <button onClick={onClose} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 11, padding: "2px 8px" }}>✕</button>
        </div>
        <textarea
          autoFocus
          placeholder="Command to send…  (Enter for newline, ⌘/Ctrl+Enter to schedule)"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
          rows={4}
          style={{ ...inputStyle, resize: "vertical", minHeight: 64, lineHeight: 1.5, fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", width: 44, flexShrink: 0 }}>After</span>
          <input
            type="number"
            min={1}
            value={delayValue}
            onChange={(e) => setDelayValue(e.target.value)}
            style={{ ...inputStyle, width: 72, padding: "6px 8px", textAlign: "right" }}
          />
          <select
            value={delayUnit}
            onChange={(e) => setDelayUnit(e.target.value as DelayUnit)}
            style={unitSelectStyle}
          >
            <option value="seconds">seconds</option>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
          <label
            title="Repeat this command at a fixed interval after each fire"
            style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: "auto", cursor: "pointer", fontSize: 12, color: loopEnabled ? "#a78bfa" : "var(--text-muted)" }}
          >
            <input
              type="checkbox"
              checked={loopEnabled}
              onChange={(e) => setLoopEnabled(e.target.checked)}
              style={{ cursor: "pointer", margin: 0 }}
            />
            <span>↻ Loop</span>
          </label>
        </div>
        {loopEnabled && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#a78bfa", width: 44, flexShrink: 0 }}>Every</span>
            <input
              type="number"
              min={1}
              value={loopValue}
              onChange={(e) => { setLoopValue(e.target.value); setLoopValueTouched(true); }}
              style={{ ...inputStyle, width: 72, padding: "6px 8px", textAlign: "right", borderColor: "#7c3aed" }}
            />
            <select
              value={loopUnit}
              onChange={(e) => { setLoopUnit(e.target.value as DelayUnit); setLoopUnitTouched(true); }}
              style={{ ...unitSelectStyle, borderColor: "#7c3aed" }}
            >
              <option value="seconds">seconds</option>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
            <span style={{ fontSize: 10, color: "var(--text-faint)", marginLeft: "auto" }}>after each fire</span>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <button
            disabled={loading || !command.trim()}
            onClick={submit}
            style={{ background: "var(--accent-blue)", color: "#fff", fontSize: 12, padding: "6px 14px", marginLeft: "auto" }}
          >
            {loading ? "..." : (loopEnabled ? "Set loop" : "Set")}
          </button>
          <button onClick={onClose} style={{ background: "var(--text-faintest)", color: "var(--text-secondary)", fontSize: 12, padding: "6px 12px" }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function _formatInterval(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return s === 0 ? `${m}m` : `${m}m${s}s`;
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function TaskChip({ task, sessionId, onCancel }: { task: ScheduledTask; sessionId: string; onCancel: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  // none = collapsed, view = read-only full command, edit = textarea editor.
  const [mode, setMode] = useState<"none" | "view" | "edit">("none");
  const [draft, setDraft] = useState(task.command);
  const [saving, setSaving] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [, setTick] = useState(0);
  const cmdRef = useRef<HTMLSpanElement>(null);
  const pageVisible = usePageVisible();

  // Update countdown every second locally without waiting for server poll.
  // Pause while the tab is hidden — a backgrounded list shouldn't re-render a
  // countdown nobody can see; one tick on re-show resyncs it.
  useEffect(() => {
    if (!pageVisible) return;
    setTick((t) => t + 1);
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [pageVisible]);

  // Show the ▶/▼ "view full" toggle only when the one-line command is actually
  // clipped — measured live (chip width varies), not guessed from char count.
  useEffect(() => {
    const el = cmdRef.current;
    if (!el) return;
    const measure = () => setTruncated(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [task.command]);

  // Re-sync the editor draft when the task's command changes server-side (e.g. a
  // loop fired and the next pending row carries the edited text), but only while
  // not editing so an in-progress edit isn't clobbered by a poll.
  useEffect(() => {
    if (mode !== "edit") setDraft(task.command);
  }, [task.command, mode]);

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setCancelling(true);
    try {
      await cancelTask(sessionId, task.id);
      onCancel();
    } catch {
      setCancelling(false);
    }
  };

  const dirty = draft.trim() !== "" && draft.trim() !== task.command;

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!dirty) {
      setMode("none");
      return;
    }
    setSaving(true);
    try {
      await updateTaskCommand(sessionId, task.id, draft.trim());
      setMode("none");
      onCancel(); // reuse the parent's task-refresh callback
    } finally {
      setSaving(false);
    }
  };

  const remaining = formatRemaining(task.run_at);
  const isLoop = !!task.loop_seconds;
  const intervalLabel = isLoop ? _formatInterval(task.loop_seconds!) : null;
  // The view caret is only useful when the one-line command is actually clipped.
  const canView = truncated;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        background: isLoop ? "rgba(124,58,237,0.18)" : "var(--bg-hover)",
        border: isLoop ? "1px solid #7c3aed" : "1px solid transparent",
        borderRadius: 4,
        padding: "3px 8px",
        fontSize: 11,
        minWidth: 0,
      }}
      onClick={(e) => e.stopPropagation()}
      title={`${task.command}${isLoop ? ` (repeats every ${intervalLabel})` : ""}`}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {isLoop ? (
          <span style={{ color: "#a78bfa", fontSize: 13, flexShrink: 0, lineHeight: 1 }}>↻</span>
        ) : (
          <img src={scheduleIcon} style={{ width: 12, height: 12, flexShrink: 0, filter: "invert(0.7) sepia(1) saturate(3) hue-rotate(10deg)" }} />
        )}
        {isLoop && (
          <span style={{ color: "#a78bfa", fontFamily: "monospace", fontSize: 10, flexShrink: 0, fontWeight: 600 }}>
            /{intervalLabel}
          </span>
        )}
        <span ref={cmdRef} style={{ color: isLoop ? "#ddd6fe" : "var(--text-secondary)", fontFamily: "monospace", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {task.command}
        </span>
        {canView && (
          <button
            onClick={(e) => { e.stopPropagation(); setMode((m) => (m === "view" ? "none" : "view")); }}
            style={{ background: "transparent", color: mode === "view" ? "var(--accent-blue)" : "var(--text-faint)", fontSize: 9, padding: "0 2px", lineHeight: 1, flexShrink: 0 }}
            title={mode === "view" ? "Collapse" : "Show full command"}
          >
            {mode === "view" ? "▼" : "▶"}
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); setMode((m) => (m === "edit" ? "none" : "edit")); }}
          style={{ background: "transparent", color: mode === "edit" ? "var(--accent-blue)" : "var(--text-faint)", fontSize: 11, padding: "0 2px", lineHeight: 1, flexShrink: 0 }}
          title={mode === "edit" ? "Close editor" : "Edit command"}
        >
          ✎
        </button>
        <span style={{ color: remaining === "due" ? "#f59e0b" : (isLoop ? "#c4b5fd" : "var(--text-muted)"), flexShrink: 0 }}>{remaining}</span>
        <button
          disabled={cancelling}
          onClick={handleCancel}
          style={{ background: "transparent", color: "var(--text-faint)", fontSize: 12, padding: "0 2px", lineHeight: 1, flexShrink: 0 }}
          title={isLoop ? "Cancel next iteration (loop stops)" : "Cancel task"}
        >
          ✕
        </button>
      </div>
      {mode === "view" && (
        <div style={{
          fontFamily: "monospace",
          fontSize: 11,
          lineHeight: 1.45,
          color: isLoop ? "#ddd6fe" : "var(--text-secondary)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          background: "var(--bg-base)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          padding: "5px 7px",
          maxHeight: 220,
          overflowY: "auto",
        }}>
          {task.command}
        </div>
      )}
      {mode === "edit" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }} onClick={(e) => e.stopPropagation()}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(12, Math.max(2, draft.split("\n").length))}
            spellCheck={false}
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              lineHeight: 1.45,
              color: isLoop ? "#ddd6fe" : "var(--text-secondary)",
              background: "var(--bg-base)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "5px 7px",
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: "var(--text-faint)" }}>
              {isLoop ? "Applies to the next run and all later loops" : "Next run uses the new command"}
            </span>
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              style={{
                marginLeft: "auto",
                background: dirty ? "var(--accent-blue)" : "var(--bg-hover)",
                color: dirty ? "#fff" : "var(--text-faint)",
                border: "none", borderRadius: 3, fontSize: 10.5, padding: "2px 12px",
                cursor: saving || !dirty ? "default" : "pointer", fontFamily: "inherit",
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setDraft(task.command); setMode("none"); }}
              style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)", borderRadius: 3, fontSize: 10.5, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SessionCard({
  session: s,
  isActive,
  showOwner,
  attentionKind,
  onAttach,
  onViewChat,
  onTerminate,
  onResume,
  onDelete,
  onTaskChange,
  onRename,
  loading,
}: Props) {
  const canAttach = s.status === "running" || s.status === "detached";
  const canResume = s.status === "terminated";
  const canDelete = s.status === "terminated";
  const canSchedule = s.status === "running" || s.status === "detached";
  const [showSchedule, setShowSchedule] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(s.project);
  const editRef = useRef<HTMLInputElement>(null);

  const pendingTasks = s.scheduled_tasks?.filter((t) => t.status === "pending") ?? [];

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditName(s.project);
    setEditing(true);
    setTimeout(() => { editRef.current?.select(); }, 0);
  };

  const submitRename = async () => {
    const trimmed = editName.trim();
    setEditing(false);
    if (!trimmed || trimmed === s.project) return;
    try {
      await renameSession(s.id, trimmed);
      onRename?.();
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      style={{
        padding: "10px 12px",
        // Attention overrides background tint with a dim red so the card is
        // visibly different from the rest of the list even without the badge.
        background: attentionKind
          ? "rgba(220,38,38,0.10)"
          : isActive
          ? "rgba(88,166,255,0.12)"
          : "var(--bg-modal)",
        borderRadius: 8,
        // Attention also overrides the outer border so it remains conspicuous
        // when the session also happens to be the active one.
        border: attentionKind
          ? "1px solid #dc2626"
          : isActive ? "1px solid var(--accent-blue)" : "1px solid var(--bg-hover)",
        // Attention beats every other left-rail signal — it's the most user-
        // blocking state we can convey, and a thick red rail makes scanning
        // the list trivial.
        borderLeft: attentionKind
          ? "4px solid #dc2626"
          : isActive
          ? "3px solid var(--accent-blue)"
          : s.is_streaming
          ? "3px solid #22c55e"
          : s.has_new_output
          ? "3px solid var(--accent-red)"
          : "1px solid var(--bg-hover)",
        cursor: (canAttach && onAttach) || (canResume && onViewChat) ? "pointer" : "default",
        breakInside: "avoid",
        minWidth: 0,
        // `clip` (not `hidden`) — same visual clipping, but unlike `hidden`
        // it does NOT reset the box's automatic min-size to 0. With `hidden`,
        // grid-auto-rows: auto resolves to minmax(0, max-content), so when
        // the flex-constrained grid container can't fit every row at its
        // max-content height (e.g., "Showing all sessions" with many items
        // in a narrow single-column layout), the browser compresses rows
        // toward 0 and overflow:hidden silently clips most of the card.
        overflow: "clip",
      }}
      onClick={() => {
        if (canAttach && onAttach) { onAttach(); }
        else if (canResume && onViewChat) { onViewChat(); }
      }}
    >
      {/* attention banner: only when the session has work awaiting user input.
          Placed above row 1 so it reads as the first thing in the card and
          never gets pushed below the fold by long project names or prompts. */}
      {attentionKind && (
        <div
          className="attention-banner"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
            margin: "-4px -6px 8px",
            borderRadius: 5,
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.4,
          }}
        >
          <span style={{ fontSize: 13 }}>⚠</span>
          <span>NEEDS ATTENTION · {ATTENTION_LABEL[attentionKind]}</span>
        </div>
      )}
      {/* row 1: owner? + project + status */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: "1 1 auto" }}>
          {showOwner && (
            <span style={{ fontSize: 10, background: "var(--text-faintest)", padding: "1px 5px", borderRadius: 3, color: "var(--text-secondary)" }}>
              {s.owner_id}
            </span>
          )}
          {editing ? (
            <input
              ref={editRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitRename(); } if (e.key === "Escape") setEditing(false); }}
              onClick={(e) => e.stopPropagation()}
              style={{ fontSize: 13, fontWeight: 600, background: "var(--bg-base)", border: "1px solid var(--accent-blue)", borderRadius: 3, color: "var(--text-body)", padding: "1px 4px", outline: "none", width: 160 }}
              autoFocus
            />
          ) : (
            <strong style={{ fontSize: 13, cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title="Click to rename" onClick={startEdit}>{s.project}</strong>
          )}
          {s.is_streaming && <span className="streaming-dot" title="Terminal is outputting" />}
          {!s.is_streaming && s.has_new_output && <span className="new-output-dot" title="New output since last view" />}
          {s.tool === "cursor" ? (
            <span style={{ fontSize: 9, background: "#4c1d95", color: "#c4b5fd", padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>
              CURSOR
            </span>
          ) : s.tool === "codex" ? (
            <span style={{ fontSize: 9, background: "#064e3b", color: "#6ee7b7", padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>
              CODEX
            </span>
          ) : (
            <span style={{ fontSize: 9, background: "#78350f", color: "#fcd34d", padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>
              CLAUDE
            </span>
          )}
        </div>
        <span style={{ fontSize: 10, color: STATUS_COLORS[s.status] || "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", flexShrink: 0, whiteSpace: "nowrap" }}>
          {s.status}
        </span>
      </div>

      {/* row 2: cwd */}
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>{s.cwd}</div>

      {/* row 3: agent session id + title */}
      {s.agent_session_id && (
        <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
          <span style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}>{s.agent_session_id.slice(0, 8)}</span>
          {s.claude_title && <span style={{ marginLeft: 6, color: "var(--text-muted)" }}>{s.claude_title}</span>}
        </div>
      )}

      {/* row 4: prompts + last input time */}
      {s.prompts && s.prompts.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5 }}>
          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.prompts[0]}>
            <span style={{ color: "var(--text-faintest)", fontFamily: "monospace" }}>#0</span>{" "}<PromptText text={s.prompts[0]} />
          </div>
          {s.prompts.length >= 2 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }} title={s.prompts[s.prompts.length - 1]}>
                <span style={{ color: "var(--text-faintest)", fontFamily: "monospace" }}>#-1</span>{" "}<PromptText text={s.prompts[s.prompts.length - 1]} />
              </div>
              {s.last_user_input_at && <LastPromptTime iso={s.last_user_input_at} />}
            </div>
          )}
          {s.prompts.length < 2 && s.last_user_input_at && (
            <div style={{ marginTop: 2, display: "flex", justifyContent: "flex-end" }}><LastPromptTime iso={s.last_user_input_at} /></div>
          )}
        </div>
      )}

      {/* row 5: time + model + actions */}
      {/* No `gap` on the parent: marginLeft:auto on the buttons div handles the
          spacing — when the row is wide there's a large auto-margin between
          time and buttons; as the panel narrows the auto-margin shrinks to 0
          and time/buttons touch; even narrower, buttons wrap to their own
          line and stay right-aligned (auto-margin consumes left-side space). */}
      <div style={{ display: "flex", alignItems: "center", marginTop: 6, flexWrap: "wrap", rowGap: 4 }}>
        <span style={{ fontSize: 10, color: "var(--text-faint)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {new Date(s.created_at).toLocaleString()}
          {s.model && ` · ${s.model.replace("claude-", "").replace(/-\d{8}$/, "")}`}
        </span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end", marginLeft: "auto" }}>
          {canSchedule && (
            <Btn
              color={showSchedule ? "var(--accent-blue)" : "var(--btn-icon-bg)"}
              label={<img src={scheduleIcon} style={{ width: 12, height: 12, display: "block", filter: "invert(1)" }} />}
              title="Schedule a command"
              onClick={(e) => { e.stopPropagation(); setShowSchedule((v) => !v); }}
            />
          )}
          {s.status === "running" && onTerminate && (
            <Btn color="#d9534f" label="⏹" title="Terminate session" onClick={onTerminate} />
          )}
          {canResume && onResume && (
            <Btn color="#5cb85c" label="▶" title="Resume session" disabled={loading} onClick={onResume} />
          )}
          {canDelete && onDelete && (
            <Btn color="var(--btn-icon-bg)" label="🗑" title="Delete session" onClick={onDelete} />
          )}
        </div>
      </div>

      {/* scheduled tasks */}
      {pendingTasks.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
          {pendingTasks.map((t) => (
            <TaskChip key={t.id} task={t} sessionId={s.id} onCancel={() => onTaskChange?.()} />
          ))}
        </div>
      )}

      {/* schedule form */}
      {showSchedule && (
        <ScheduleForm
          sessionId={s.id}
          onCreated={() => { onTaskChange?.(); }}
          onClose={() => setShowSchedule(false)}
        />
      )}
    </div>
  );
}

export function PromptText({ text }: { text: string }) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("/")) {
    // Slash-command prompt: split "/cmd <rest>" and render with a "cmd" badge.
    const sp = trimmed.indexOf(" ");
    const cmd = sp === -1 ? trimmed : trimmed.slice(0, sp);
    const rest = sp === -1 ? "" : trimmed.slice(sp + 1);
    return (
      <>
        <span
          style={{
            display: "inline-block",
            fontSize: 9,
            background: "#4c1d95",
            color: "#c4b5fd",
            padding: "0 4px",
            borderRadius: 3,
            fontWeight: 600,
            marginRight: 4,
            verticalAlign: "1px",
            letterSpacing: 0.5,
          }}
        >
          cmd
        </span>
        <span style={{ color: "#c4b5fd", fontFamily: "monospace" }}>{cmd}</span>
        {rest && <span style={{ color: "var(--text-faint)" }}>{" "}{rest}</span>}
      </>
    );
  }
  return <>{text}</>;
}

function Btn({
  color,
  label,
  title,
  disabled,
  onClick,
}: {
  color: string;
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      style={{ fontSize: 10, padding: "2px 8px", background: color, color: "#fff" }}
    >
      {label}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-hover)",
  border: "1px solid var(--text-faintest)",
  borderRadius: 4,
  padding: "6px 8px",
  color: "var(--text-body)",
  fontSize: 12,
  outline: "none",
  width: "100%",
};
