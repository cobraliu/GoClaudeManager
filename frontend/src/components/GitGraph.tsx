import { useMemo } from "react";
import type { GitGraphCommit } from "../api/sessionApi";

const LANE_W = 14;
const ROW_H = 26;
const NODE_R = 4;

const LANE_COLORS = [
  "#58a6ff", "#3fb950", "#d29922", "#bc8cff",
  "#ff7b72", "#79c0ff", "#56d364", "#e3b341",
];

function laneColor(idx: number): string {
  return LANE_COLORS[idx % LANE_COLORS.length];
}

interface LaidRow {
  commit: GitGraphCommit;
  lane: number;
  lanesBefore: (string | null)[];
  lanesAfter: (string | null)[];
  incoming: number[]; // other lanes that merged into this commit
  outgoing: { fromLane: number; toLane: number }[]; // parent placements (toLane is fromLane for first parent)
}

function layout(commits: GitGraphCommit[]): { rows: LaidRow[]; maxLanes: number } {
  let lanes: (string | null)[] = [];
  let maxLanes = 0;
  const rows: LaidRow[] = [];

  for (const c of commits) {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) {
      const slot = lanes.indexOf(null);
      if (slot === -1) { lane = lanes.length; lanes.push(null); }
      else lane = slot;
    }

    const incoming: number[] = [];
    lanes.forEach((h, i) => { if (i !== lane && h === c.hash) incoming.push(i); });

    const lanesBefore = [...lanes];

    // Consume incoming lanes
    incoming.forEach(i => { lanes[i] = null; });

    const outgoing: { fromLane: number; toLane: number }[] = [];
    if (c.parents.length === 0) {
      lanes[lane] = null;
    } else {
      // First parent stays on the same lane (continuation).
      lanes[lane] = c.parents[0];
      outgoing.push({ fromLane: lane, toLane: lane });
      // Additional parents land in the first empty lane (or a new one).
      for (let pi = 1; pi < c.parents.length; pi++) {
        const p = c.parents[pi];
        // Prefer a lane that's already expecting this parent (rare but possible for octopus merges).
        let slot = lanes.indexOf(p);
        if (slot === -1) {
          slot = lanes.indexOf(null);
          if (slot === -1) { slot = lanes.length; lanes.push(p); }
          else lanes[slot] = p;
        }
        outgoing.push({ fromLane: lane, toLane: slot });
      }
    }

    // Trim trailing nulls so the lane array doesn't grow forever
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    rows.push({ commit: c, lane, lanesBefore, lanesAfter: [...lanes], incoming, outgoing });
    maxLanes = Math.max(maxLanes, lanesBefore.length, lanes.length);
  }

  return { rows, maxLanes };
}

function laneX(lane: number): number {
  return lane * LANE_W + LANE_W / 2;
}

function curvePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

function RowGraphCell({ row }: { row: LaidRow }) {
  const width = (Math.max(row.lanesBefore.length, row.lanesAfter.length, row.lane + 1)) * LANE_W;
  const cx = laneX(row.lane);
  const cy = ROW_H / 2;

  const elements: React.ReactNode[] = [];

  // Pass-through lanes: lanes that have a value before AND after at the same slot AND are not this row's lane and not incoming.
  for (let i = 0; i < Math.max(row.lanesBefore.length, row.lanesAfter.length); i++) {
    const before = row.lanesBefore[i] ?? null;
    const after = row.lanesAfter[i] ?? null;
    if (i === row.lane) continue;
    if (row.incoming.includes(i)) continue;
    const isOutgoingNew = row.outgoing.some(o => o.toLane === i && o.fromLane !== o.toLane);
    if (before !== null && after !== null && !isOutgoingNew) {
      elements.push(
        <line key={`pt-${i}`} x1={laneX(i)} y1={0} x2={laneX(i)} y2={ROW_H} stroke={laneColor(i)} strokeWidth={1.5} />
      );
    } else if (before !== null) {
      // line from top to row-middle only (lane terminates here visually)
      elements.push(
        <line key={`pt-top-${i}`} x1={laneX(i)} y1={0} x2={laneX(i)} y2={cy} stroke={laneColor(i)} strokeWidth={1.5} />
      );
    } else if (after !== null) {
      // line from row-middle to bottom only (handled below as outgoing curve)
    }
  }

  // Incoming merge curves: from (laneX(i), 0) to commit node
  for (const i of row.incoming) {
    elements.push(
      <path key={`in-${i}`} d={curvePath(laneX(i), 0, cx, cy)} stroke={laneColor(i)} strokeWidth={1.5} fill="none" />
    );
  }

  // Current lane top half (line from above into the node)
  if (row.lanesBefore[row.lane] != null) {
    elements.push(
      <line key="cur-top" x1={cx} y1={0} x2={cx} y2={cy} stroke={laneColor(row.lane)} strokeWidth={1.5} />
    );
  }

  // Outgoing parent edges: from node to each parent lane at bottom
  for (const o of row.outgoing) {
    const toX = laneX(o.toLane);
    elements.push(
      <path key={`out-${o.toLane}`} d={curvePath(cx, cy, toX, ROW_H)} stroke={laneColor(o.toLane)} strokeWidth={1.5} fill="none" />
    );
  }

  // The commit node
  elements.push(
    <circle key="node" cx={cx} cy={cy} r={NODE_R} fill={laneColor(row.lane)} stroke="var(--bg-base)" strokeWidth={1.5} />
  );

  return (
    <svg width={width} height={ROW_H} style={{ flexShrink: 0, display: "block" }}>
      {elements}
    </svg>
  );
}

interface Props {
  commits: GitGraphCommit[];
  onCommitClick?: (commit: GitGraphCommit) => void;
  onRevert?: (commit: GitGraphCommit) => void;
  selectedHashes?: string[];
  onToggleCheck?: (hash: string) => void;
  checkDisabled?: (hash: string) => boolean;
  busyHash?: string | null;
  /** Hash of the very first row (newest), so we suppress the Revert button on it. */
  latestHash?: string | null;
}

export function GitGraph({
  commits, onCommitClick, onRevert, selectedHashes = [],
  onToggleCheck, checkDisabled, busyHash, latestHash,
}: Props) {
  const { rows, maxLanes } = useMemo(() => layout(commits), [commits]);
  const graphWidth = (maxLanes + 1) * LANE_W;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map((row) => {
        const c = row.commit;
        const checked = selectedHashes.includes(c.hash);
        const disabled = checkDisabled?.(c.hash) ?? false;
        const d = new Date(c.date);
        const pad = (n: number) => String(n).padStart(2, "0");
        const dateStr = `${d.getMonth()+1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        return (
          <div
            key={c.hash}
            style={{
              display: "flex", alignItems: "stretch", borderBottom: "1px solid var(--bg-hover)",
              background: checked ? "rgba(88,166,255,0.08)" : "transparent",
              minHeight: ROW_H,
            }}
          >
            <div style={{ width: graphWidth, flexShrink: 0, background: "var(--bg-sidebar)" }}>
              <RowGraphCell row={row} />
            </div>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, padding: "0 8px", minWidth: 0 }}>
              {onToggleCheck && (
                <input type="checkbox" checked={checked} disabled={disabled}
                  onChange={() => onToggleCheck(c.hash)}
                  style={{ flexShrink: 0, margin: 0, cursor: disabled ? "not-allowed" : "pointer" }}
                  title={disabled ? "Already 2 commits selected" : "Select for diff"} />
              )}
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--accent-blue)", flexShrink: 0 }}>{c.short_hash}</span>
              {c.refs.map(ref => (
                <span key={ref} style={{
                  fontSize: 10, padding: "1px 5px", borderRadius: 3,
                  background: ref.startsWith("HEAD") ? "var(--accent-blue)" : ref.startsWith("tag:") ? "var(--accent-amber)" : "var(--bg-hover)",
                  color: ref.startsWith("HEAD") || ref.startsWith("tag:") ? "#fff" : "var(--text-secondary)",
                  fontFamily: "monospace", flexShrink: 0, whiteSpace: "nowrap",
                }}>{ref.replace(/^tag: /, "")}</span>
              ))}
              <span
                style={{ flex: 1, fontSize: 12, color: "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: onCommitClick ? "pointer" : "default" }}
                title={c.subject}
                onClick={() => onCommitClick?.(c)}
              >{c.subject}</span>
              <span style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0, whiteSpace: "nowrap" }}>{c.author}</span>
              <span style={{ fontSize: 10, color: "var(--text-faintest)", flexShrink: 0, whiteSpace: "nowrap" }}>{dateStr}</span>
              {onRevert && c.hash !== latestHash && (
                <button
                  disabled={busyHash === c.hash}
                  onClick={(e) => { e.stopPropagation(); onRevert(c); }}
                  title="Rollback to this commit"
                  style={{ background: "var(--bg-hover)", color: "var(--accent-amber)", fontSize: 10, padding: "2px 6px", flexShrink: 0, border: "1px solid var(--border)" }}
                >
                  {busyHash === c.hash ? "..." : "Revert"}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {rows.length === 0 && (
        <div style={{ padding: "20px 12px", fontSize: 12, color: "var(--text-faint)", textAlign: "center" }}>No commits.</div>
      )}
    </div>
  );
}
