import { useEffect, useRef, useState } from "react";
import { listIdentityCandidates, type IdentityCandidate } from "../api/sessionApi";

function fmtAgo(sec: number): string {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(sec * 1000).toLocaleDateString();
}

function fmtSize(n?: number): string {
  if (!n) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / (1 << 20)).toFixed(1)}MB`;
}

/** Text input for a transcript id with a dropdown of the session's project
 *  transcripts, fetched fresh every time the dropdown opens. */
export function TranscriptPicker({
  sessionId, value, onChange, inputStyle,
}: {
  sessionId: string;
  value: string;
  onChange: (v: string) => void;
  inputStyle: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<IdentityCandidate[] | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const reqRef = useRef(0);

  const openList = () => {
    if (open) return;
    setOpen(true);
    setFilter("");
    setErr("");
    setItems(null);
    const n = ++reqRef.current;
    listIdentityCandidates(sessionId)
      .then(r => { if (n === reqRef.current) setItems(r.items); })
      .catch(e => { if (n === reqRef.current) setErr(String(e)); });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const q = filter.trim().toLowerCase();
  const shown = (items || []).filter(it => !q ||
    it.agent_session_id.toLowerCase().includes(q) ||
    (it.title || "").toLowerCase().includes(q) ||
    (it.prompts || []).some(p => p.toLowerCase().includes(q)));

  return (
    <div ref={wrapRef}>
      <div style={{ display: "flex", gap: 3 }}>
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          onClick={openList}
          placeholder="(empty = clear) — click to pick"
          spellCheck={false}
          style={{ ...inputStyle, flex: 1, minWidth: 0 }}
        />
        <button
          onClick={() => (open ? setOpen(false) : openList())}
          title="Pick a transcript from this project"
          style={{ fontSize: 10, background: "var(--btn-icon-bg)", color: "var(--text-secondary)", padding: "0 6px", borderRadius: 3 }}
        >{open ? "▲" : "▼"}</button>
      </div>
      {open && (
        <div style={{
          // In-flow (not a floating popover): the session card clips overflow.
          marginTop: 3, background: "var(--bg-modal)", border: "1px solid var(--border)", borderRadius: 4,
          maxHeight: 320, display: "flex", flexDirection: "column",
        }}>
          <input
            // No autofocus on touch screens: the keyboard would cover the list.
            autoFocus={!window.matchMedia("(pointer: coarse)").matches}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter by id / title / prompt"
            spellCheck={false}
            style={{ ...inputStyle, margin: 4, fontFamily: "inherit" }}
          />
          <div style={{ overflowY: "auto", flex: 1 }}>
            {err && <div style={{ padding: 8, fontSize: 11, color: "var(--accent-red)" }}>{err}</div>}
            {!err && items === null && <div style={{ padding: 8, fontSize: 11, color: "var(--text-faint)" }}>Loading…</div>}
            {items !== null && shown.length === 0 && (
              <div style={{ padding: 8, fontSize: 11, color: "var(--text-faint)" }}>
                {items.length === 0 ? "No transcripts in this project directory." : "No match."}
              </div>
            )}
            {shown.map(it => {
              const cur = it.agent_session_id === value.trim();
              const last = it.prompts && it.prompts.length > 1 ? it.prompts[it.prompts.length - 1] : "";
              return (
                <div
                  key={it.agent_session_id}
                  onClick={() => { onChange(it.agent_session_id); setOpen(false); }}
                  style={{
                    padding: "5px 8px", cursor: "pointer", borderTop: "1px solid var(--border-subtle)",
                    background: cur ? "var(--bg-hover)" : undefined,
                  }}
                  onMouseEnter={e => { if (!cur) e.currentTarget.style.background = "var(--bg-surface)"; }}
                  onMouseLeave={e => { if (!cur) e.currentTarget.style.background = ""; }}
                >
                  <div style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 11 }}>
                    <span style={{ fontFamily: "monospace", color: "var(--text-bright)" }}>{it.agent_session_id.slice(0, 8)}</span>
                    <span style={{ color: "var(--text-faint)" }}>{fmtAgo(it.mtime)}</span>
                    <span style={{ color: "var(--text-faintest)" }}>{fmtSize(it.size)}</span>
                    {cur && <span style={{ color: "var(--accent-green)" }}>current</span>}
                    {it.used_by && it.used_by.length > 0 && (
                      <span style={{ marginLeft: "auto", color: "var(--accent-amber)" }} title={it.used_by.join(", ")}>
                        in use: {it.used_by.join(", ")}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.title || ""}>
                    {it.title || <span style={{ color: "var(--text-faintest)" }}>(no prompt)</span>}
                  </div>
                  {last && (
                    <div style={{ fontSize: 10, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={last}>
                      last: {last}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
