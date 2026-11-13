import { useEffect, useMemo, useRef, useState } from "react";
import { getUsageHistory, type UsageSample } from "../api/sessionApi";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const H = 190;
const PAD = { l: 34, r: 10, t: 10, b: 22 };
const C5 = "var(--accent-blue)";
const C7 = "var(--accent-amber)";

type Range = "this" | "last";

/** End of the current 7-day window (ms): the latest seven_reset seen, else the
 *  coming Monday 00:00 local so the chart still has a sensible frame. */
function weekEnd(samples: UsageSample[]): number {
  for (let i = samples.length - 1; i >= 0; i--) {
    const r = samples[i].seven_reset;
    if (r) return r * 1000;
  }
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return d.getTime();
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" }) + " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function UsageChart({ width: fixedWidth }: { width?: number }) {
  const [samples, setSamples] = useState<UsageSample[] | null>(null);
  const [interval, setIntervalS] = useState(300);
  const [range, setRange] = useState<Range>("this");
  const [hover, setHover] = useState<number | null>(null);
  const [boxRef, measured] = useWidth<HTMLDivElement>();
  const W = fixedWidth ?? measured;

  useEffect(() => {
    let alive = true;
    const load = () => getUsageHistory()
      .then(d => { if (alive) { setSamples(d.samples); setIntervalS(d.interval || 300); } })
      .catch(() => {});
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const view = useMemo(() => {
    if (!samples) return null;
    const end0 = weekEnd(samples);
    const x1 = range === "this" ? end0 : end0 - WEEK;
    const x0 = x1 - WEEK;
    const pts = samples.filter(s => s.ts * 1000 >= x0 && s.ts * 1000 <= x1);
    const now = Date.now();
    const resets = new Set<number>();
    for (const s of pts) {
      const r = s.five_reset ? s.five_reset * 1000 : 0;
      if (r > x0 && r < x1 && r <= now) resets.add(r);
    }
    return { x0, x1, pts, resets: [...resets] };
  }, [samples, range]);

  const iw = Math.max(0, W - PAD.l - PAD.r);
  const ih = H - PAD.t - PAD.b;
  const sx = (ms: number) => view ? PAD.l + ((ms - view.x0) / (view.x1 - view.x0)) * iw : 0;
  const sy = (v: number) => PAD.t + ih - Math.min(Math.max(v, 0), 1) * ih;

  // Polyline path, broken wherever samples are missing (server down etc.).
  const path = (key: "five_hour" | "seven_day") => {
    if (!view) return "";
    const gap = interval * 3 * 1000;
    let d = "", prev = -Infinity;
    for (const s of view.pts) {
      const v = s[key];
      if (v == null) { prev = -Infinity; continue; }
      const t = s.ts * 1000;
      d += (t - prev > gap ? "M" : "L") + sx(t).toFixed(1) + "," + sy(v).toFixed(1);
      prev = t;
    }
    return d;
  };

  const days: number[] = [];
  if (view) {
    const d = new Date(view.x0);
    d.setHours(0, 0, 0, 0);
    for (let t = d.getTime() + DAY; t < view.x1; ) {
      days.push(t);
      const n = new Date(t); n.setDate(n.getDate() + 1); t = n.getTime();
    }
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!view || view.pts.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ms = view.x0 + ((e.clientX - rect.left - PAD.l) / iw) * (view.x1 - view.x0);
    let best = 0, bd = Infinity;
    view.pts.forEach((s, i) => { const dd = Math.abs(s.ts * 1000 - ms); if (dd < bd) { bd = dd; best = i; } });
    setHover(bd < interval * 3 * 1000 ? best : null);
  };

  const hs = hover != null && view ? view.pts[hover] : null;
  const tab = (r: Range, label: string) => (
    <button
      onClick={() => { setRange(r); setHover(null); }}
      style={{
        background: range === r ? "var(--bg-hover)" : "transparent", border: "1px solid var(--border-subtle)",
        color: range === r ? "var(--text-bright)" : "var(--text-muted)", fontSize: 11, padding: "2px 8px",
        borderRadius: 4, cursor: "pointer",
      }}
    >{label}</button>
  );

  return (
    <div ref={boxRef} style={{ width: fixedWidth ?? "100%", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
        {tab("this", "This week")}
        {tab("last", "Last week")}
        <span style={{ marginLeft: "auto", display: "flex", gap: 10, color: "var(--text-muted)" }}>
          <span><span style={{ display: "inline-block", width: 10, height: 2, background: C5, verticalAlign: "middle", marginRight: 4 }} />5h</span>
          <span><span style={{ display: "inline-block", width: 10, height: 2, background: C7, verticalAlign: "middle", marginRight: 4 }} />Week</span>
        </span>
      </div>
      {W > 0 && view && (
        <div style={{ position: "relative" }}>
          <svg width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
            {[0, 0.25, 0.5, 0.75, 1].map(v => (
              <g key={v}>
                <line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} stroke="var(--border-subtle)" strokeWidth={1} />
                <text x={PAD.l - 4} y={sy(v) + 3} textAnchor="end" fontSize={9} fill="var(--text-faintest)">{v * 100}%</text>
              </g>
            ))}
            {days.map(t => (
              <g key={t}>
                <line x1={sx(t)} x2={sx(t)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--border-subtle)" strokeWidth={1} opacity={0.6} />
                <text x={sx(t)} y={H - 6} textAnchor="middle" fontSize={9} fill="var(--text-faintest)">
                  {new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric" })}
                </text>
              </g>
            ))}
            {view.resets.map(t => (
              <line key={"r" + t} x1={sx(t)} x2={sx(t)} y1={PAD.t} y2={PAD.t + ih}
                stroke={C5} strokeWidth={1} strokeDasharray="2 3" opacity={0.35} />
            ))}
            {range === "this" && Date.now() < view.x1 && (
              <line x1={sx(Date.now())} x2={sx(Date.now())} y1={PAD.t} y2={PAD.t + ih}
                stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="4 3" />
            )}
            <path d={path("seven_day")} fill="none" stroke={C7} strokeWidth={1.8} strokeLinejoin="round" />
            <path d={path("five_hour")} fill="none" stroke={C5} strokeWidth={1.5} strokeLinejoin="round" />
            {hs && (
              <g>
                <line x1={sx(hs.ts * 1000)} x2={sx(hs.ts * 1000)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--text-faint)" strokeWidth={1} />
                {hs.five_hour != null && <circle cx={sx(hs.ts * 1000)} cy={sy(hs.five_hour)} r={3} fill={C5} />}
                {hs.seven_day != null && <circle cx={sx(hs.ts * 1000)} cy={sy(hs.seven_day)} r={3} fill={C7} />}
              </g>
            )}
          </svg>
          {view.pts.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faintest)", fontSize: 11, pointerEvents: "none" }}>
              No samples yet (recorded every {Math.round(interval / 60)} min)
            </div>
          )}
          {hs && (
            <div style={{
              position: "absolute", top: 4, pointerEvents: "none", whiteSpace: "nowrap",
              ...(sx(hs.ts * 1000) > W / 2 ? { right: W - sx(hs.ts * 1000) + 8 } : { left: sx(hs.ts * 1000) + 8 }),
              background: "var(--bg-modal)", border: "1px solid var(--border)", borderRadius: 4,
              padding: "4px 6px", fontSize: 10, color: "var(--text-body)", lineHeight: 1.5,
            }}>
              <div style={{ color: "var(--text-faint)" }}>{fmtTime(hs.ts * 1000)}</div>
              {hs.five_hour != null && <div><span style={{ color: C5 }}>●</span> 5h {(hs.five_hour * 100).toFixed(1)}%</div>}
              {hs.seven_day != null && <div><span style={{ color: C7 }}>●</span> Week {(hs.seven_day * 100).toFixed(1)}%</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
