// RemoteFilesPanel — read-only browser for directories on other machines,
// reached over SSH by the server (hosts come from its ~/.ssh/config). Lives in
// the file panel's toolbar as the "Remote" tool; files open in a modal viewer
// whose body the parent renders (so it reuses CodePane's viewers).
import { useCallback, useEffect, useState } from "react";
import { getRemoteHosts, listRemoteDir, getRemoteFile, remoteMediaUrl, remoteDownloadUrl, closeRemote, type RemoteEntry, type FileData } from "../api/sessionApi";
import { FileIcon } from "./FileIcon";
import { copyTextDetect } from "../lib/copyText";

const LAST_PATH_KEY = (host: string) => `remoteFiles.path.${host}`;

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// Files played / shown straight from the streaming endpoint instead of being
// read as text.
const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "mov", "m4v", "mkv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "svg"]);
type MediaKind = "video" | "audio" | "image";
function mediaKind(p: string): MediaKind | null {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  return null;
}

function parentOf(p: string): string {
  if (p === "/" || !p) return "/";
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-deep)", color: "var(--text)", border: "1px solid var(--text-faintest)",
  borderRadius: 3, fontSize: 11, padding: "3px 6px", outline: "none", minWidth: 0,
};
const iconBtn: React.CSSProperties = {
  background: "transparent", color: "var(--text-muted)", border: "1px solid var(--text-faintest)",
  borderRadius: 3, fontSize: 11, padding: "1px 6px", cursor: "pointer", flexShrink: 0,
};

export function RemoteFilesPanel({ showHidden, renderFile }: {
  showHidden: boolean;
  /** Renders an opened file's body inside the viewer modal. */
  renderFile: (data: FileData, path: string, host: string) => React.ReactNode;
}) {
  const [hosts, setHosts] = useState<string[] | null>(null);
  // Starts unselected every time: nothing connects until the user picks a host.
  const [host, setHost] = useState("");
  const [path, setPath] = useState("");        // current absolute dir (as resolved by the server)
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState("");
  const [opened, setOpened] = useState<{ path: string; data: FileData | null; media?: MediaKind; size?: number; error?: string } | null>(null);

  useEffect(() => {
    getRemoteHosts().then((r) => setHosts(r.hosts)).catch((e) => { setHosts([]); setError(String(e?.message ?? e)); });
  }, []);

  const load = useCallback((h: string, p: string) => {
    if (!h) return;
    setLoading(true);
    setError(null);
    listRemoteDir(h, p)
      .then((r) => {
        setPath(r.path);
        setPathInput(r.path);
        setEntries(r.entries);
        localStorage.setItem(LAST_PATH_KEY(h), r.path);
      })
      .catch((e) => { setError(String(e?.message ?? e)); setPathInput(p); })
      .finally(() => setLoading(false));
  }, []);

  // Connect only once the user has picked a host (opening at that host's last
  // directory). Switching host, unmounting (leaving the Remote tab or the
  // session) or closing the page closes that host's SSH connection, so no ssh
  // process lingers.
  useEffect(() => {
    if (!host) return;
    setEntries(null);
    load(host, localStorage.getItem(LAST_PATH_KEY(host)) ?? "");
    const onHide = () => closeRemote(host);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      setOpened(null);
      closeRemote(host);
    };
  }, [host, load]);

  // Esc closes the viewer.
  const isOpen = opened !== null;
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpened(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  const openFile = (p: string, size?: number) => {
    const media = mediaKind(p);
    if (media) { setOpened({ path: p, data: null, media, size }); return; }
    setOpened({ path: p, data: null });
    getRemoteFile(host, p)
      .then((d) => setOpened((o) => (o?.path === p ? { path: p, data: d } : o)))
      .catch((e) => setOpened((o) => (o?.path === p ? { path: p, data: null, error: String(e?.message ?? e) } : o)));
  };

  const join = (name: string) => (path === "/" ? `/${name}` : `${path}/${name}`);
  const visible = (entries ?? []).filter((e) => showHidden || !e.name.startsWith("."));

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ padding: "6px 8px 4px", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>SSH</span>
          <select
            value={host}
            onChange={(e) => setHost(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          >
            <option value="" disabled>{hosts === null ? "Loading hosts…" : hosts.length ? "Choose a host…" : "No hosts in ~/.ssh/config"}</option>
            {host && hosts && !hosts.includes(host) && <option value={host}>{host}</option>}
            {(hosts ?? []).map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <button title="Reload" disabled={!host || loading} onClick={() => load(host, path)} style={iconBtn}>⟳</button>
        </div>
        {host && (
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <button title="Parent directory" disabled={loading || path === "/"} onClick={() => load(host, parentOf(path))} style={iconBtn}>↑</button>
            <button title="Home directory" disabled={loading} onClick={() => load(host, "")} style={iconBtn}>⌂</button>
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); load(host, pathInput.trim()); } }}
              placeholder="/absolute/path (Enter)"
              style={{ ...inputStyle, flex: 1, fontFamily: "monospace" }}
            />
          </div>
        )}
        {error && <div style={{ fontSize: 10, color: "var(--accent-red)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{error}</div>}
      </div>

      {host && (
        <div style={{ overflowY: "auto", minHeight: 0, flex: 1 }}>
          {loading && entries === null ? (
            <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text-faint)" }}>Connecting…</div>
          ) : entries && visible.length === 0 ? (
            <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text-faint)" }}>Empty</div>
          ) : (
            visible.map((e) => (
              <div
                key={e.name}
                onClick={() => (e.type === "dir" ? load(host, join(e.name)) : openFile(join(e.name), e.size))}
                title={join(e.name)}
                style={{ padding: "3px 10px", fontSize: 12, cursor: "pointer", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 5, opacity: loading ? 0.6 : 1 }}
                onMouseEnter={(el) => { el.currentTarget.style.background = "var(--bg-surface)"; }}
                onMouseLeave={(el) => { el.currentTarget.style.background = "transparent"; }}
              >
                <FileIcon name={e.name} isDir={e.type === "dir"} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.name}{e.link ? " ↪" : ""}
                </span>
                {e.type === "file" && <span style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0 }}>{humanBytes(e.size)}</span>}
              </div>
            ))
          )}
        </div>
      )}

      {opened && (
        <div
          onClick={() => setOpened(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(1200px, 94vw)", height: "88vh", background: "var(--bg-base)", border: "1px solid var(--bg-hover)", borderRadius: 6, display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--bg-hover)", display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <span style={{ color: "var(--accent-green)", flexShrink: 0 }}>{host}:</span>
              <span style={{ flex: 1, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }} title={opened.path}>{opened.path}</span>
              {opened.media && opened.size != null && (
                <span style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0 }}>{humanBytes(opened.size)} · read-only</span>
              )}
              {opened.data && (
                <span style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0 }}>
                  {humanBytes(opened.data.size ?? 0)}
                  {opened.data.truncated ? ` · showing first ${(opened.data.displayed_lines ?? 0).toLocaleString()} lines` : ""}
                  {" · read-only"}
                </span>
              )}
              {opened.data && !opened.data.is_binary && (
                <button
                  onClick={async () => {
                    const ok = await copyTextDetect(opened.data!.content);
                    setCopyMsg(ok ? "Copied ✓" : "Copy failed");
                    setTimeout(() => setCopyMsg(""), 1500);
                  }}
                  title={opened.data.truncated
                    ? `Copy the ${(opened.data.displayed_lines ?? 0).toLocaleString()} lines shown (file is truncated — download for the full file)`
                    : "Copy the whole file"}
                  style={iconBtn}
                >{copyMsg || (opened.data.truncated ? "⧉ Copy shown" : "⧉ Copy")}</button>
              )}
              <a
                href={remoteDownloadUrl(host, opened.path)}
                download
                title="Download (relayed by the server over SSH)"
                style={{ ...iconBtn, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
              >⤓ Download</a>
              <button onClick={() => setOpened(null)} title="Close (Esc)" style={iconBtn}>✕</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {opened.media ? (
                <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "var(--bg-deep)" }}>
                  {opened.media === "video" && (
                    <video key={opened.path} src={remoteMediaUrl(host, opened.path)} controls autoPlay preload="metadata"
                      onError={() => setOpened((o) => (o && o.path === opened.path ? { ...o, media: undefined, error: "无法播放：文件读取失败，或浏览器不支持该视频编码（如 H.265 / 部分 mkv）。" } : o))}
                      style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 4, background: "#000" }} />
                  )}
                  {opened.media === "audio" && (
                    <audio key={opened.path} src={remoteMediaUrl(host, opened.path)} controls autoPlay preload="metadata" style={{ width: "100%", maxWidth: 600 }} />
                  )}
                  {opened.media === "image" && (
                    <img src={remoteMediaUrl(host, opened.path)} alt={opened.path} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 4 }} />
                  )}
                </div>
              ) : opened.error ? (
                <div style={{ padding: 16, fontSize: 12, color: "var(--accent-red)" }}>{opened.error}</div>
              ) : !opened.data ? (
                <div style={{ padding: 16, fontSize: 12, color: "var(--text-faint)" }}>Loading…</div>
              ) : opened.data.is_binary ? (
                <div style={{ padding: 16, fontSize: 12, color: "var(--text-faint)" }}>Binary file — preview not available.</div>
              ) : (
                renderFile(opened.data, opened.path, host)
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
