/** Copy/expand interactions for the static chat HTML produced by
 *  renderConversationBody (exportChat.ts). The rendered body uses native
 *  <details> for collapsing, so only the copy buttons need wiring. Shared by the
 *  public ShareViewer and the JSONL → Chat tool page.
 *
 *  Returns a cleanup function that removes the listeners. */
export function attachInteractions(root: HTMLElement): () => void {
  const fallbackCopy = (text: string) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    document.body.removeChild(ta);
  };
  const copyText = (text: string) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  };
  const flash = (btn: HTMLElement) => {
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1100);
  };
  const preText = (pre: Element | null | undefined): string => {
    if (!pre) return "";
    // Numbered output: copy the code column only, dropping the line-number gutter.
    if (pre.classList.contains("numbered")) {
      return Array.from(pre.querySelectorAll(".num-code"))
        .map((c) => (c as HTMLElement).innerText)
        .join("\n");
    }
    return (pre as HTMLElement).innerText;
  };

  const onClick = (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (!t || !t.classList || !t.classList.contains("copy-btn")) return;
    e.preventDefault();
    e.stopPropagation();
    const src = t.getAttribute("data-copy-source");
    let text = "";
    if (src === "next-pre") {
      text = preText(t.parentElement?.parentElement?.querySelector("pre"));
    } else if (src === "next-md") {
      const md = t.parentElement?.parentElement?.querySelector(".md, .plan-body");
      if (md) text = (md as HTMLElement).innerText;
    } else if (src === "diff") {
      const block = t.closest(".diff-block");
      if (block) {
        const lines: string[] = [];
        block.querySelectorAll(".diff-table tr").forEach((tr) => {
          if (tr.classList.contains("diff-skip")) {
            lines.push("@@ " + (tr.textContent || "").trim() + " @@");
            return;
          }
          const td = tr.querySelector(".diff-text");
          if (!td) return;
          const sign = tr.classList.contains("diff-add") ? "+" : tr.classList.contains("diff-del") ? "-" : " ";
          let inner = td.textContent || "";
          if (inner.length > 0) inner = inner.slice(1);
          lines.push(sign + inner);
        });
        text = lines.join("\n");
      }
    } else {
      text = preText(t.closest("details, div")?.querySelector("pre"));
    }
    if (text) { copyText(text); flash(t); }
  };
  root.addEventListener("click", onClick);

  root.querySelectorAll("pre.conv-code-block").forEach((pre) => {
    if (pre.querySelector(".copy-btn")) return;
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.style.position = "absolute";
    btn.style.top = "4px";
    btn.style.right = "4px";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const code = pre.querySelector("code");
      const text = code ? (code as HTMLElement).innerText : (pre as HTMLElement).innerText;
      copyText(text);
      flash(btn);
    });
    pre.appendChild(btn);
  });

  return () => root.removeEventListener("click", onClick);
}
