import { useState, useEffect, useMemo } from "react";
import { readFile } from "../api/sessionApi";

// ── HTML Viewer ───────────────────────────────────────────────────────────
// Renders pure HTML in a sandboxed iframe. We include allow-same-origin so
// prototypes that touch localStorage / sessionStorage / IndexedDB (theme
// persistence, client state, most React/Vue scaffolds) render instead of
// throwing SecurityError on an opaque origin. The tradeoff: with srcDoc, the
// frame then shares the host app's origin and can in principle reach our
// localStorage/API — acceptable here because these are the user's own
// in-session prototype files. The PUBLIC share viewer (ShareFilesTab) keeps the
// stricter allow-scripts-only sandbox precisely because its content is exposed
// to untrusted viewers.
// An injected script intercepts <a> clicks and postMessages the href to the
// parent; relative paths are resolved against the current path's dir and pushed
// onto an internal back stack.
//
// Shared between desktop (CodePane) and mobile (MobilePage) so the two stay
// in sync. The nav bar uses tap-friendly sizing that's also fine on desktop.

function htmlDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function resolveHtmlRel(dir: string, href: string): string {
  const clean = href.split("#")[0].split("?")[0];
  if (!clean) return "";
  const base = clean.startsWith("/") ? "" : dir;
  const parts = (base ? base.split("/") : []).concat(clean.replace(/^\//, "").split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") { out.pop(); continue; }
    out.push(p);
  }
  return out.join("/");
}

const HTML_NAV_SCRIPT = `<script>(function(){document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a');if(!a)return;var h=a.getAttribute('href');if(!h)return;if(h.charAt(0)==='#')return;e.preventDefault();var abs=/^[a-z][a-z0-9+.-]*:/i.test(h)||h.indexOf('//')===0;if(abs){window.parent.postMessage({type:'cm-html-extern',href:h},'*');}else{window.parent.postMessage({type:'cm-html-nav',href:h},'*');}},true);})();<\/script>`;

function injectHtmlNav(html: string): string {
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, HTML_NAV_SCRIPT + "</body>");
  return html + HTML_NAV_SCRIPT;
}

export function HtmlViewer({ sessionId, path, initialContent }: {
  sessionId: string;
  path: string;
  initialContent: string;
}) {
  const [navStack, setNavStack] = useState<string[]>([path]);
  const currentPath = navStack[navStack.length - 1];
  const [content, setContent] = useState<string | null>(initialContent);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [maxd, setMaxd] = useState(false); // fill the viewport in place

  useEffect(() => {
    if (!maxd) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMaxd(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maxd]);

  useEffect(() => {
    if (currentPath === path) {
      setContent(initialContent);
      setLoadError(null);
      return;
    }
    let mounted = true;
    setContent(null);
    setLoadError(null);
    readFile(sessionId, currentPath)
      .then(r => { if (mounted) setContent(r.content); })
      .catch(e => { if (mounted) setLoadError(String(e)); });
    return () => { mounted = false; };
  }, [sessionId, currentPath, path, initialContent]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "cm-html-extern" && typeof d.href === "string") {
        window.open(d.href, "_blank", "noopener,noreferrer");
      } else if (d.type === "cm-html-nav" && typeof d.href === "string") {
        const resolved = resolveHtmlRel(htmlDirname(currentPath), d.href);
        if (resolved) setNavStack(s => [...s, resolved]);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [currentPath]);

  const injected = useMemo(
    () => (content === null ? null : injectHtmlNav(content)),
    [content],
  );

  const canBack = navStack.length > 1;
  const goBack = () => setNavStack(s => s.length > 1 ? s.slice(0, -1) : s);
  const goHome = () => setNavStack([path]);

  return (
    <div style={maxd
      ? { position: "fixed", inset: 0, zIndex: 9999, display: "flex", flexDirection: "column", background: "var(--bg-base)" }
      : { flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, background: "var(--bg-base)" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "3px 10px", fontSize: 11, color: "var(--text-faint)",
        background: "var(--bg-elev)", borderBottom: "1px solid var(--bg-hover)", minHeight: 22, flexShrink: 0,
      }}>
        <button
          onClick={goBack}
          disabled={!canBack}
          title="Back"
          style={{
            fontSize: 10, padding: "1px 7px",
            background: canBack ? "var(--bg-hover)" : "transparent",
            color: canBack ? "var(--text-muted)" : "var(--text-faintest)",
            border: "1px solid var(--text-faintest)",
            borderRadius: 3, cursor: canBack ? "pointer" : "default",
          }}
        >← Back</button>
        {canBack && (
          <button
            onClick={goHome}
            title="Return to original file"
            style={{
              fontSize: 10, padding: "1px 7px",
              background: "var(--bg-hover)", color: "var(--text-muted)",
              border: "1px solid var(--text-faintest)", borderRadius: 3, cursor: "pointer",
            }}
          >Home</button>
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{currentPath}</span>
        {canBack && (
          <span style={{ color: "var(--text-faintest)" }}>{navStack.length - 1} deep</span>
        )}
        <button
          onClick={() => setMaxd(v => !v)}
          title={maxd ? "还原 (Esc)" : "最大化"}
          style={{
            fontSize: 10, padding: "1px 7px",
            background: "var(--bg-hover)", color: "var(--text-muted)",
            border: "1px solid var(--text-faintest)", borderRadius: 3,
            cursor: "pointer", flexShrink: 0,
          }}
        >{maxd ? "⤡ 还原" : "⤢ 最大化"}</button>
      </div>
      {loadError ? (
        <div style={{ padding: 24, color: "var(--accent-red)", fontSize: 13 }}>{loadError}</div>
      ) : injected === null ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
      ) : (
        <iframe
          key={currentPath}
          sandbox="allow-scripts allow-same-origin"
          srcDoc={injected}
          style={{ flex: 1, border: "none", background: "white", minHeight: 0 }}
          title={currentPath}
        />
      )}
    </div>
  );
}
