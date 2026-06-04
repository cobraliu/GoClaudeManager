// Clipboard copy with HONEST success detection plus a manual-selection fallback.
//
// navigator.clipboard only exists in secure contexts (https / localhost). The
// mobile UI is typically served over plain HTTP on a LAN IP, where the direct
// `navigator.clipboard.writeText(...)` call throws and one-tap copy silently
// does nothing. Strategy:
//   1. async Clipboard API when available — the reliable path.
//   2. hidden-textarea + document.execCommand("copy") — works in most mobile
//      browsers even on http; its boolean return is our success signal.
//   3. If both fail, the caller should selectElementContents() the code block
//      so the user can long-press the already-made selection and copy manually.

export async function copyTextDetect(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* permission denied etc. — try the legacy path */ }
  }
  return execCommandCopy(text);
}

function execCommandCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // readonly prevents the mobile keyboard from popping up during the copy.
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
    document.body.appendChild(ta);
    // iOS needs an explicit selection range; plain select() is unreliable there.
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Select an element's entire contents so the user can long-press → Copy when
// programmatic copy is unavailable. Returns whether a selection was made.
export function selectElementContents(el: HTMLElement): boolean {
  try {
    const sel = window.getSelection();
    if (!sel) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.rangeCount > 0 && !sel.isCollapsed;
  } catch {
    return false;
  }
}
