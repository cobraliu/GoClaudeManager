import { useEffect, useRef, useState } from "react";
import { getUsageInfo, type UsageInfo, type UsageWindow } from "../api/sessionApi";

function formatReset(isoTs: string): string {
  const d = new Date(isoTs);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function pctVal(w: UsageWindow): number {
  return w.utilization * 100;
}

function pctStr(v: number): string {
  return v.toFixed(1) + "%";
}

function pctColor(v: number): string {
  if (v >= 80) return "#f87171";
  if (v >= 50) return "#fbbf24";
  return "#4ade80";
}

function MiniBar({ v, col }: { v: number; col: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", width: 36, height: 5, background: "var(--bg-hover)", borderRadius: 3, overflow: "hidden" }}>
      <span style={{ width: `${Math.min(v, 100)}%`, height: "100%", background: col, borderRadius: 3, transition: "width 0.4s" }} />
    </span>
  );
}

function Item({ label, w }: { label: string; w: UsageWindow }) {
  const v = pctVal(w);
  const col = pctColor(v);
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{label}</span>
      <span style={{ color: col, fontWeight: 600, fontSize: 10 }}>{pctStr(v)}</span>
      <MiniBar v={v} col={col} />
      <span style={{ color: "var(--text-faintest)", fontSize: 10 }}>↻</span>
      <span style={{ color: "var(--text-faint)", fontSize: 10 }}>{formatReset(w.resets_at)}</span>
    </span>
  );
}

function useUsageInfo() {
  const [info, setInfo] = useState<UsageInfo | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const load = () => getUsageInfo().then(d => { setInfo(d); setUpdatedAt(new Date()); }).catch(() => {});
    load();
    timerRef.current = setInterval(load, 60_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);
  return { info, updatedAt };
}

function CenterRow({ label, w }: { label: string; w: UsageWindow }) {
  const v = pctVal(w);
  const col = pctColor(v);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 260 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{label}</span>
        <span style={{ color: col, fontWeight: 700, fontSize: 13 }}>{pctStr(v)}</span>
      </div>
      <div style={{ height: 6, background: "var(--bg-hover)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(v, 100)}%`, height: "100%", background: col, borderRadius: 4, transition: "width 0.4s" }} />
      </div>
      {w.resets_at && (
        <span style={{ color: "var(--text-faint)", fontSize: 11 }}>↻ resets {formatReset(w.resets_at)}</span>
      )}
    </div>
  );
}

export function UsageCenter() {
  const { info, updatedAt } = useUsageInfo();
  if (!info || (!info.five_hour && !info.seven_day)) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faintest)", fontSize: 14 }}>
        Select a session or create a new one
      </div>
    );
  }
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24 }}>
      {info.five_hour && <CenterRow label="Current session" w={info.five_hour} />}
      {info.seven_day && <CenterRow label="Current week (all models)" w={info.seven_day} />}
      {updatedAt && (
        <span style={{ color: "var(--text-faintest)", fontSize: 10 }}>
          updated {updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
        </span>
      )}
    </div>
  );
}

export function UsageBar() {
  const { info } = useUsageInfo();

  if (!info || (!info.five_hour && !info.seven_day)) return null;

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8, marginRight: "auto" }}>
      {info.five_hour && <Item label="Session" w={info.five_hour} />}
      {info.five_hour && info.seven_day && (
        <span style={{ color: "var(--bg-hover)", fontSize: 10 }}>·</span>
      )}
      {info.seven_day && <Item label="Week" w={info.seven_day} />}
    </span>
  );
}
