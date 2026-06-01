import { marked } from "marked";
import markedKatex from "marked-katex-extension";
// Use the "common" subset (~35 most-used languages) instead of the full ~200.
// Cuts highlight.js bundle from ~950KB to ~430KB.
import hljs from "highlight.js/lib/common";

// ── KaTeX (LaTeX math) ────────────────────────────────────────────────────────
marked.use(markedKatex({ throwOnError: false, output: "html" }));

// Base64-encode a UTF-8 string for safe round-trip through HTML attributes.
// btoa() only handles latin-1, so we percent-encode first.
function encodeMermaidSrc(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

// Above this many chars, skip highlight.js language auto-detection (see below).
const AUTO_HL_MAX = 20000;

// ── Code highlighting + inline code styling ───────────────────────────────────
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code(token) {
      const lang = token.lang || "";
      if (lang === "mermaid") {
        // Emit a placeholder. lib/mermaid.ts has a MutationObserver that
        // finds these, decodes data-src, and replaces innerHTML with the
        // rendered SVG. Source is base64-encoded so Mermaid syntax
        // (-->, &, <, etc.) survives going through HTML.
        return `<div class="mermaid-block" data-src="${encodeMermaidSrc(token.text)}"></div>`;
      }
      let highlighted: string;
      try {
        if (lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(token.text, { language: lang }).value;
        } else if (token.text.length <= AUTO_HL_MAX) {
          highlighted = hljs.highlightAuto(token.text).value;
        } else {
          // highlightAuto scans every grammar; on a very large untagged block
          // that's hundreds of ms of synchronous work (a big contributor to the
          // freeze when many such blocks render at once on a session switch).
          // Not worth auto-coloring a giant blob — emit escaped plain text.
          highlighted = token.text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        }
      } catch {
        highlighted = token.text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      }
      return `<pre class="conv-code-block"><code class="hljs language-${lang}">${highlighted}</code></pre>`;
    },
    codespan(token) {
      const escaped = token.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<code class="conv-code-inline">${escaped}</code>`;
    },
  },
} as Parameters<typeof marked.use>[0]);

export { marked };

// Markdown rendering (parse + highlight + KaTeX) is pure for a given input, but
// costly. Cache by exact source text so re-renders, 1.5s polls, and re-opening
// a previously-viewed session reuse the HTML instead of re-parsing every block.
// LRU-capped so long sessions don't grow it unbounded.
const mdCache = new Map<string, string>();
const MD_CACHE_MAX = 500;

export function renderMarkdown(text: string): string {
  const hit = mdCache.get(text);
  if (hit !== undefined) {
    // Refresh recency (move to newest) so the eviction below stays LRU.
    mdCache.delete(text);
    mdCache.set(text, hit);
    return hit;
  }
  let html: string;
  try {
    html = marked.parse(text) as string;
  } catch {
    html = `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
  }
  mdCache.set(text, html);
  if (mdCache.size > MD_CACHE_MAX) {
    const oldest = mdCache.keys().next().value;
    if (oldest !== undefined) mdCache.delete(oldest);
  }
  return html;
}
