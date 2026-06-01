// Lazy-loaded Mermaid runtime + DOM observer.
//
// markdown.ts emits ```mermaid blocks as <div class="mermaid-block" data-src="<base64>">.
// This module imports `mermaid` on demand the first time a block appears,
// then watches the document for new blocks (so every call-site of
// renderMarkdown gets diagram rendering for free — no per-site changes).
//
// Caching: rendered SVG is memoized by source-base64. Streaming re-renders
// of the same content hit the cache and avoid re-invoking mermaid.render.

type MermaidApi = {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, src: string) => Promise<{ svg: string }>;
};

let _mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!_mermaidPromise) {
    _mermaidPromise = import("mermaid").then(m => m.default as unknown as MermaidApi);
  }
  return _mermaidPromise;
}

function detectTheme(): "dark" | "default" {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "default"
    : "dark";
}

let _currentTheme: string | null = null;

async function initIfThemeChanged(): Promise<MermaidApi> {
  const mermaid = await loadMermaid();
  const theme = detectTheme();
  if (theme !== _currentTheme) {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: "loose",
      fontFamily: "inherit",
    });
    _currentTheme = theme;
  }
  return mermaid;
}

function decodeSrc(b64: string): string {
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return "";
  }
}

// SVG cache keyed by (theme + base64 source). Theme is part of the key so
// theme switches don't serve a stale-themed SVG.
const _svgCache = new Map<string, string>();

let _idCounter = 0;
function nextId(): string {
  return `mmd-${Date.now().toString(36)}-${++_idCounter}`;
}

async function renderBlock(el: HTMLElement): Promise<void> {
  const b64 = el.dataset.src || "";
  if (!b64) return;
  const theme = detectTheme();
  const cacheKey = `${theme}:${b64}`;

  // Already rendered with current theme + source → nothing to do.
  if (el.dataset.rendered === cacheKey) return;

  const cached = _svgCache.get(cacheKey);
  if (cached) {
    el.innerHTML = cached;
    el.dataset.rendered = cacheKey;
    return;
  }

  // Mark in-flight so concurrent observer ticks don't double-render.
  if (el.dataset.rendered === "pending") return;
  el.dataset.rendered = "pending";

  const src = decodeSrc(b64);
  if (!src) {
    el.dataset.rendered = "";
    return;
  }

  try {
    const mermaid = await initIfThemeChanged();
    // mermaid.render requires the id NOT to be present in the DOM. We use
    // an off-DOM unique id; the SVG it returns is then injected into el.
    const { svg } = await mermaid.render(nextId(), src);
    _svgCache.set(cacheKey, svg);
    el.innerHTML = svg;
    el.dataset.rendered = cacheKey;
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    el.innerHTML = `<pre class="mermaid-error">Mermaid render failed: ${esc(msg)}\n\n${esc(src)}</pre>`;
    el.dataset.rendered = "";  // allow retry if source changes
  }
}

function scanAndRender(root: ParentNode = document): void {
  const els = root.querySelectorAll<HTMLElement>(".mermaid-block");
  els.forEach(el => { void renderBlock(el); });
}

let _started = false;

export function startMermaidObserver(): void {
  if (_started) return;
  _started = true;

  scanAndRender();

  // Coalesce mutations so streaming output doesn't trigger a render per
  // character. requestAnimationFrame batches to once per frame.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scanAndRender();
    });
  };

  // Only react when a mermaid block actually entered the DOM. Without this
  // guard the observer ran scanAndRender() — a full-document
  // querySelectorAll(".mermaid-block") — on EVERY mutation anywhere in the app
  // (streaming output, the 1.5s poll re-render, terminal output, typing,
  // scrolling). That scan grows with the page's DOM and fires up to ~60×/s
  // during activity, saturating the main thread over a long session (the
  // "everything is laggy until you refresh" symptom). The overwhelming common
  // case has no diagrams at all, so checking addedNodes lets us skip the scan
  // entirely; when a block does appear, querySelector is bounded by the small
  // newly-added subtree, not the whole document.
  const isOrHasMermaid = (node: Node): boolean => {
    if (node.nodeType !== 1) return false; // ELEMENT_NODE
    const el = node as Element;
    return el.classList.contains("mermaid-block") || el.querySelector(".mermaid-block") !== null;
  };
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (isOrHasMermaid(node)) { schedule(); return; }
      }
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Re-render all blocks when theme changes (data-theme on <html>).
  new MutationObserver(() => {
    const theme = detectTheme();
    if (theme === _currentTheme) return;
    // Force re-render: existing cache entries are keyed by theme so they
    // miss naturally, but we must reset data-rendered on visible blocks.
    document.querySelectorAll<HTMLElement>(".mermaid-block").forEach(el => {
      el.dataset.rendered = "";
    });
    scanAndRender();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

// Used by exportChat to inline SVGs for offline HTML export.
export async function renderMermaidToHtml(html: string): Promise<string> {
  if (!html.includes('class="mermaid-block"')) return html;

  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, "text/html");
  const root = doc.getElementById("r");
  if (!root) return html;
  const blocks = root.querySelectorAll<HTMLElement>(".mermaid-block");
  if (blocks.length === 0) return html;

  const mermaid = await loadMermaid();
  // Export uses neutral theme so the SVG looks reasonable in both light and
  // dark prefers-color-scheme. (Mermaid SVGs don't auto-invert.)
  mermaid.initialize({
    startOnLoad: false,
    theme: "neutral",
    securityLevel: "loose",
    fontFamily: "inherit",
  });
  // Mark _currentTheme as dirty so the in-app observer re-initializes
  // for its own theme on the next live render.
  _currentTheme = null;

  for (const el of Array.from(blocks)) {
    const src = decodeSrc(el.dataset.src || "");
    if (!src) continue;
    try {
      const { svg } = await mermaid.render(nextId(), src);
      const wrap = doc.createElement("div");
      wrap.className = "mermaid-rendered";
      wrap.innerHTML = svg;
      el.replaceWith(wrap);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      const pre = doc.createElement("pre");
      pre.className = "mermaid-error";
      pre.textContent = `Mermaid render failed: ${msg}\n\n${src}`;
      el.replaceWith(pre);
    }
  }

  return root.innerHTML;
}
