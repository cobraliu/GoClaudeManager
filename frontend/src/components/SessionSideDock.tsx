import { useEffect, useRef, useState, useCallback } from "react";
import {
  listSessionAuqs,
  type AuqEntry,
  type Goal,
  type TodoItem,
  type TodoPlan,
} from "../api/sessionApi";

const COLLAPSE_KEY = "sideDockCollapsed";
const SORT_KEY = "auqsPanelSort";
// AUQ history is a dock-only view (the user-blocking AUQ prompt itself is
// driven in real time by the status poll's tui_auq_data, not by this list), so
// a slow refresh is fine and keeps request volume down.
const AUQ_POLL_MS = 30000;

type SectionKey = "auqs" | "tasks" | "goals";
type SortOrder = "asc" | "desc";

interface Props {
  sessionId: string;
  sessionName: string;
  isCursor: boolean;
  /** Which sections are currently open (toggled by parent's bottom buttons). */
  open: { auqs: boolean; tasks: boolean; goals: boolean };
  /** Closes a section entirely (parent flips its open flag off). */
  onClose: (key: SectionKey) => void;
  /** Todo items from the latest TodoWrite tool_use in the session JSONL. */
  todos: TodoItem[];
  /** Completed Todo plans, most-recent first. */
  todoHistory: TodoPlan[];
  /** Active goal + history lifted to parent for the same reason. */
  activeGoal: Goal | null;
  goalHistory: Goal[];
  /** Triggered if the dock wants to force a refresh of todos. */
  onTodosChanged: () => void;
  /** Width in pixels; controlled by the parent via a drag handle. */
  width?: number;
}

function loadCollapsed(): Record<SectionKey, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        auqs: !!p.auqs,
        tasks: !!p.tasks,
        goals: !!p.goals,
      };
    }
  } catch { /* ignore */ }
  return { auqs: false, tasks: false, goals: false };
}

function loadSort(): SortOrder {
  return localStorage.getItem(SORT_KEY) === "desc" ? "desc" : "asc";
}

function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtTimeShort(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function SessionSideDock({
  sessionId, sessionName, isCursor,
  open, onClose,
  todos, todoHistory, activeGoal, goalHistory, onTodosChanged,
  width = 380,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>(loadCollapsed);

  const setSectionCollapsed = (key: SectionKey, value: boolean) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // Auto-expand a section the moment it transitions from closed → open.
  const prevOpen = useRef(open);
  useEffect(() => {
    const prev = prevOpen.current;
    prevOpen.current = open;
    (Object.keys(open) as SectionKey[]).forEach((key) => {
      if (open[key] && !prev[key]) {
        setSectionCollapsed(key, false);
      }
    });
  }, [open]);

  const anyOpen = open.auqs || open.tasks || open.goals;
  if (!anyOpen) return null;

  return (
    <div
      style={{
        width,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-surface)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontSize: 12,
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {open.auqs && !isCursor && (
          <AuqsSection
            sessionId={sessionId}
            sessionName={sessionName}
            collapsed={collapsed.auqs}
            onToggle={() => setSectionCollapsed("auqs", !collapsed.auqs)}
            onClose={() => onClose("auqs")}
          />
        )}
        {open.tasks && (
          <TasksSection
            todos={todos}
            history={todoHistory}
            collapsed={collapsed.tasks}
            onToggle={() => setSectionCollapsed("tasks", !collapsed.tasks)}
            onClose={() => onClose("tasks")}
            onRefresh={onTodosChanged}
          />
        )}
        {open.goals && !isCursor && (
          <GoalsSection
            activeGoal={activeGoal}
            history={goalHistory}
            collapsed={collapsed.goals}
            onToggle={() => setSectionCollapsed("goals", !collapsed.goals)}
            onClose={() => onClose("goals")}
          />
        )}
      </div>
    </div>
  );
}

function SectionHeader({
  title, badge, badgeColor, collapsed, onToggle, onClose,
}: {
  title: string;
  badge?: string;
  badgeColor?: string;
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        background: "var(--bg-hover)",
        borderBottom: "1px solid var(--border)",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <span style={{ color: "var(--text-faint)", fontSize: 10, width: 10 }}>
        {collapsed ? "▶" : "▼"}
      </span>
      <span style={{ fontWeight: 600, color: "var(--text-body)" }}>{title}</span>
      {badge && (
        <span style={{ fontSize: 10.5, color: badgeColor || "var(--text-faint)" }}>
          {badge}
        </span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="Hide section"
        style={{
          marginLeft: "auto",
          background: "transparent", border: "none",
          color: "var(--text-faint)", cursor: "pointer",
          fontSize: 13, padding: "0 4px", lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

/* ──────────────────────────── AUQs section ──────────────────────────── */

function AuqsSection({
  sessionId, sessionName, collapsed, onToggle, onClose,
}: {
  sessionId: string;
  sessionName: string;
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const [auqs, setAuqs] = useState<AuqEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sort, setSort] = useState<SortOrder>(loadSort);

  const refresh = useCallback(async () => {
    try {
      const items = await listSessionAuqs(sessionId);
      setAuqs(items);
    } catch { /* ignore */ }
    finally { setLoaded(true); }
  }, [sessionId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, AUQ_POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const toggleSort = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next: SortOrder = sort === "asc" ? "desc" : "asc";
    setSort(next);
    try { localStorage.setItem(SORT_KEY, next); } catch { /* ignore */ }
  };

  const sorted = [...auqs].sort((a, b) =>
    sort === "asc" ? a.ts - b.ts : b.ts - a.ts
  );

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "6px 10px",
          background: "var(--bg-hover)",
          borderBottom: collapsed ? "none" : "1px solid var(--border)",
          cursor: "pointer", userSelect: "none",
        }}
      >
        <span style={{ color: "var(--text-faint)", fontSize: 10, width: 10 }}>
          {collapsed ? "▶" : "▼"}
        </span>
        <span style={{ fontWeight: 600, color: "var(--text-body)" }}>AUQs</span>
        <span style={{ color: "var(--text-faint)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {sessionName} {loaded ? `(${auqs.length})` : ""}
        </span>
        {!collapsed && (
          <button
            onClick={toggleSort}
            title={sort === "asc" ? "Oldest first — click to reverse" : "Newest first — click to reverse"}
            style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 10.5, padding: "1px 6px", borderRadius: 3, fontFamily: "inherit" }}
          >
            {sort === "asc" ? "↑ Old→New" : "↓ New→Old"}
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          title="Hide section"
          style={{ background: "transparent", border: "none", color: "var(--text-faint)", cursor: "pointer", fontSize: 13, padding: "0 4px", lineHeight: 1 }}
        >
          ✕
        </button>
      </div>
      {!collapsed && (
        <div style={{ padding: "8px 10px" }}>
          {!loaded && <div style={{ color: "var(--text-faint)" }}>Loading…</div>}
          {loaded && auqs.length === 0 && (
            <div style={{ color: "var(--text-faint)", textAlign: "center", padding: "12px 0" }}>
              No AskUserQuestion rounds in this session yet.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sorted.map((a, idx) => (
              <AuqCard
                key={a.tool_use_id}
                auq={a}
                indexLabel={sort === "asc" ? idx + 1 : auqs.length - idx}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AuqCard({ auq, indexLabel }: { auq: AuqEntry; indexLabel: number }) {
  const pending = !auq.answers;
  return (
    <div
      style={{
        background: "var(--bg-base)",
        border: "1px solid " + (pending ? "rgba(245,158,11,0.4)" : "var(--border)"),
        borderRadius: 5,
        padding: "7px 9px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
          #{indexLabel} · {fmtTime(auq.ts)}
        </span>
        <span style={{ fontSize: 11, color: pending ? "#f59e0b" : "#5cb85c" }}>
          {pending ? "pending" : `answered @ ${fmtTime(auq.answered_ts || 0)}`}
        </span>
      </div>
      {auq.questions.map((q, qi) => {
        const answer = auq.answers?.[q.question];
        // For matching options against the answer, support both single-select
        // (exact label) and multi-select (comma- or newline-separated labels).
        const answerParts = answer
          ? answer.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
          : [];
        const isOptionChosen = (label: string) =>
          !!answer && (answerParts.includes(label) || answer.trim() === label);
        return (
          <div key={qi} style={{ marginTop: qi > 0 ? 6 : 0 }}>
            <div style={{ color: "var(--text-body)", fontSize: 12, lineHeight: 1.4, wordBreak: "break-word" }}>
              <span style={{ color: "var(--text-faint)", marginRight: 4 }}>Q:</span>
              {q.question}
            </div>
            {q.options && q.options.length > 0 && (
              <div style={{ marginTop: 3, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 2 }}>
                {q.options.map((opt, oi) => {
                  const chosen = isOptionChosen(opt.label);
                  return (
                    <div
                      key={oi}
                      style={{
                        fontSize: 11.5,
                        lineHeight: 1.4,
                        color: chosen ? "var(--accent-blue)" : "var(--text-secondary)",
                        fontWeight: chosen ? 600 : 400,
                        wordBreak: "break-word",
                      }}
                    >
                      <span style={{ color: "var(--text-faint)", marginRight: 4 }}>
                        {chosen ? "●" : "○"}
                      </span>
                      {opt.label}
                      {opt.description && (
                        <span style={{ color: "var(--text-faint)", marginLeft: 6, fontWeight: 400 }}>
                          — {opt.description}
                        </span>
                      )}
                      {opt.preview && (
                        <pre
                          style={{
                            margin: "4px 0 0",
                            padding: "5px 7px",
                            background: "var(--bg-deep)",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: 3,
                            fontSize: 10.5,
                            lineHeight: 1.35,
                            color: "var(--text-secondary)",
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                            overflow: "auto",
                            whiteSpace: "pre",
                          }}
                        >{opt.preview}</pre>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {answer ? (
              <div style={{ marginTop: 2, color: "var(--accent-blue)", fontSize: 12, lineHeight: 1.4, paddingLeft: 18, wordBreak: "break-word" }}>
                <span style={{ color: "var(--text-faint)", marginLeft: -18, marginRight: 4 }}>A:</span>
                {answer}
              </div>
            ) : (
              <div style={{ marginTop: 2, color: "var(--text-faint)", fontSize: 11, paddingLeft: 18, fontStyle: "italic" }}>
                waiting for answer…
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ──────────────────────────── Tasks section (TodoWrite from JSONL) ────── */

function TasksSection({
  todos, history, collapsed, onToggle, onClose, onRefresh,
}: {
  todos: TodoItem[];
  history: TodoPlan[];
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.filter((t) => t.status === "in_progress").length;
  const pending = total - done - active;
  const hasActive = total > 0;
  const hasHistory = history.length > 0;

  const badgeParts: string[] = [];
  if (total > 0) badgeParts.push(`${done}/${total}`);
  if (active > 0) badgeParts.push(`${active} active`);
  if (hasHistory) badgeParts.push(`${history.length} done`);
  const badgeColor = active > 0 ? "var(--accent-amber)" : total > 0 ? "var(--accent-blue)" : "var(--text-faint)";

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "6px 10px",
          background: "var(--bg-hover)",
          borderBottom: collapsed ? "none" : "1px solid var(--border)",
          cursor: "pointer", userSelect: "none",
        }}
      >
        <span style={{ color: "var(--text-faint)", fontSize: 10, width: 10 }}>
          {collapsed ? "▶" : "▼"}
        </span>
        <span style={{ fontWeight: 600, color: "var(--text-body)" }}>Tasks</span>
        {badgeParts.length > 0 && (
          <span style={{ fontSize: 10.5, color: badgeColor }}>{badgeParts.join(" · ")}</span>
        )}
        {!collapsed && (
          <button
            onClick={(e) => { e.stopPropagation(); onRefresh(); }}
            title="Refresh"
            style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 10.5, padding: "1px 6px", borderRadius: 3, fontFamily: "inherit" }}
          >
            ⟳
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          title="Hide section"
          style={{
            marginLeft: badgeParts.length > 0 ? 0 : "auto",
            background: "transparent", border: "none",
            color: "var(--text-faint)", cursor: "pointer",
            fontSize: 13, padding: "0 4px", lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>
      {!collapsed && (
        <div style={{ padding: "8px 10px" }}>
          {!hasActive && !hasHistory && (
            <div style={{ color: "var(--text-faint)", textAlign: "center", padding: "12px 0" }}>
              No tasks yet.
            </div>
          )}
          {hasActive && (
            <SubSection title="Active" color="var(--accent-blue)">
              <ActiveTodoList todos={todos} done={done} active={active} pending={pending} total={total} />
            </SubSection>
          )}
          {hasHistory && (
            <SubSection title={`History (${history.length})`} color="var(--text-faint)">
              {history.map((plan, i) => (
                <TodoHistoryRow key={`${plan.completed_ts}-${i}`} plan={plan} />
              ))}
            </SubSection>
          )}
        </div>
      )}
    </div>
  );
}

function ActiveTodoList({
  todos, done, active, pending, total,
}: {
  todos: TodoItem[];
  done: number;
  active: number;
  pending: number;
  total: number;
}) {
  const statusIcon = (s: TodoItem["status"]) =>
    s === "completed" ? "✓" : s === "in_progress" ? "▶" : "○";
  const statusColor = (s: TodoItem["status"]) =>
    s === "completed" ? "var(--accent-green)" : s === "in_progress" ? "var(--accent-amber)" : "var(--text-faint)";

  return (
    <>
      <div style={{ height: 5, borderRadius: 3, background: "var(--bg-hover)", overflow: "hidden", position: "relative", marginBottom: 8 }}>
        {done > 0 && <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${(done / total) * 100}%`, background: "var(--accent-green)" }} />}
        {active > 0 && <div style={{ position: "absolute", left: `${(done / total) * 100}%`, top: 0, height: "100%", width: `${(active / total) * 100}%`, background: "#f59e0b88" }} />}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 6 }}>
        {done} done · {active} in progress · {pending} pending
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {todos.map((t, i) => (
          <div
            key={t.id ?? i}
            style={{
              display: "flex", alignItems: "flex-start", gap: 7,
              padding: "4px 6px", borderRadius: 3,
              background: t.status === "in_progress" ? "rgba(245,158,11,0.08)" : "transparent",
              border: "1px solid " + (t.status === "in_progress" ? "rgba(245,158,11,0.3)" : "transparent"),
            }}
          >
            <span style={{ fontSize: 11, color: statusColor(t.status), flexShrink: 0, marginTop: 1, fontFamily: "monospace" }}>
              {statusIcon(t.status)}
            </span>
            <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{
                fontSize: 12, lineHeight: 1.45,
                color: t.status === "completed" ? "var(--text-faint)" : "var(--text-secondary)",
                wordBreak: "break-word",
              }}>
                {t.content}
              </span>
              {t.description && (
                <span style={{
                  fontSize: 11, lineHeight: 1.4, color: "var(--text-faint)",
                  wordBreak: "break-word",
                  opacity: t.status === "completed" ? 0.7 : 1,
                }}>
                  {t.description}
                </span>
              )}
            </span>
            {t.priority && (
              <span style={{ fontSize: 9, flexShrink: 0, padding: "1px 5px", borderRadius: 3, fontFamily: "monospace", fontWeight: 700, letterSpacing: "0.3px",
                background: t.priority === "high" ? "#7f1d1d40" : t.priority === "medium" ? "#78350f40" : "var(--bg-surface)",
                color: t.priority === "high" ? "#fca5a5" : t.priority === "medium" ? "#fcd34d" : "var(--text-faint)",
              }}>
                {t.priority[0].toUpperCase()}
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function TodoHistoryRow({ plan }: { plan: TodoPlan }) {
  const [expanded, setExpanded] = useState(false);
  const total = plan.todos.length;
  return (
    <div style={{
      background: "var(--bg-base)",
      border: "1px solid var(--border)",
      borderRadius: 4,
      padding: "6px 8px",
      opacity: 0.85,
    }}>
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }}
      >
        <span style={{ color: "var(--text-faint)", fontSize: 10, width: 10 }}>
          {expanded ? "▼" : "▶"}
        </span>
        <span style={{ color: "var(--accent-green)", fontSize: 11, flexShrink: 0, fontFamily: "monospace" }}>✓</span>
        <span style={{ flex: 1, fontSize: 11.5, color: "var(--text-secondary)" }}>
          {total} task{total === 1 ? "" : "s"} done
        </span>
        <span style={{ flexShrink: 0, fontSize: 10.5, color: "var(--text-faint)" }}>
          {fmtTimeShort(plan.created_ts)} → {fmtTimeShort(plan.completed_ts)}
        </span>
      </div>
      {expanded && (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 2 }}>
          {plan.todos.map((t, i) => (
            <div key={t.id ?? i} style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
              <span style={{ color: "var(--accent-green)", fontSize: 11, flexShrink: 0, marginTop: 1, fontFamily: "monospace" }}>✓</span>
              <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 11.5, lineHeight: 1.4, color: "var(--text-faint)", wordBreak: "break-word" }}>
                  {t.content}
                </span>
                {t.description && (
                  <span style={{ fontSize: 10.5, lineHeight: 1.4, color: "var(--text-faint)", opacity: 0.75, wordBreak: "break-word" }}>
                    {t.description}
                  </span>
                )}
              </span>
            </div>
          ))}
          <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--text-faint)" }}>
            Created {fmtTime(plan.created_ts)} · Completed {fmtTime(plan.completed_ts)}
          </div>
        </div>
      )}
    </div>
  );
}

function SubSection({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color, fontWeight: 600, marginBottom: 4, letterSpacing: 0.3 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{children}</div>
    </div>
  );
}

/* ──────────────────────────── Goals section ──────────────────────────── */

function GoalsSection({
  activeGoal, history, collapsed, onToggle, onClose,
}: {
  activeGoal: Goal | null;
  history: Goal[];
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const historyDesc = [...history].sort((a, b) => b.set_at - a.set_at);
  const badge = activeGoal ? "active" : undefined;
  const badgeColor = activeGoal ? "var(--accent-blue)" : undefined;

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <SectionHeader
        title="Goals"
        badge={badge}
        badgeColor={badgeColor}
        collapsed={collapsed}
        onToggle={onToggle}
        onClose={onClose}
      />
      {!collapsed && (
        <div style={{ padding: "8px 10px" }}>
          {!activeGoal && history.length === 0 && (
            <div style={{ color: "var(--text-faint)", textAlign: "center", padding: "12px 8px", lineHeight: 1.5 }}>
              No goals set yet.<br />
              <span style={{ fontSize: 11 }}>
                Use <code style={{ background: "var(--bg-base)", padding: "1px 4px", borderRadius: 3 }}>/goal &lt;condition&gt;</code> in the chat to set one.
              </span>
            </div>
          )}
          {activeGoal && (
            <SubSection title="Active" color="var(--accent-blue)">
              <GoalRow goal={activeGoal} status="active" />
            </SubSection>
          )}
          {historyDesc.length > 0 && (
            <SubSection title={`History (${historyDesc.length})`} color="var(--text-faint)">
              {historyDesc.map((g) => (
                <GoalRow
                  key={`${g.set_at}-${g.condition}`}
                  goal={g}
                  status={g.met ? "met" : g.replaced ? "replaced" : "closed"}
                />
              ))}
            </SubSection>
          )}
        </div>
      )}
    </div>
  );
}

function GoalRow({
  goal, status,
}: {
  goal: Goal;
  status: "active" | "met" | "replaced" | "closed";
}) {
  const muted = status !== "active";
  const struck = status === "met";
  const badge =
    status === "active" ? { text: `${goal.checks} check${goal.checks === 1 ? "" : "s"}`, color: "var(--accent-blue)" } :
    status === "met" ? { text: `met @ ${fmtTimeShort(goal.met_at || 0)}`, color: "#5cb85c" } :
    status === "replaced" ? { text: "replaced", color: "var(--text-faint)" } :
    { text: "closed", color: "var(--text-faint)" };

  return (
    <div
      style={{
        background: "var(--bg-base)",
        border: "1px solid " + (status === "active" ? "rgba(88,166,255,0.4)" : "var(--border)"),
        borderRadius: 4,
        padding: "6px 8px",
        opacity: muted ? 0.75 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <span
          style={{
            flex: 1, minWidth: 0,
            color: "var(--text-body)",
            fontSize: 12,
            textDecoration: struck ? "line-through" : "none",
            wordBreak: "break-word",
            lineHeight: 1.4,
          }}
        >
          {goal.condition}
        </span>
        <span style={{ flexShrink: 0, color: badge.color, fontSize: 10.5, marginTop: 1, whiteSpace: "nowrap" }}>
          {badge.text}
        </span>
      </div>
      {goal.last_reason && (
        <div style={{ marginTop: 3, color: "var(--text-faint)", fontSize: 11, lineHeight: 1.35, fontStyle: "italic" }}>
          {goal.last_reason}
        </div>
      )}
    </div>
  );
}
