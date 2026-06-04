// Shared per-session input persistence for the ConversationPane and
// CodexChatInput textareas:
//   1. Draft text  — survives accidental tab close / refresh, TTL 10 min
//   2. Input height — survives session switch (ConversationPane remounts on
//      sessionId key change), no TTL because UI prefs shouldn't expire
//
// Both are keyed per-session so different sessions don't stomp each other.

// ── Drafts ──────────────────────────────────────────────────────────────────

// In-memory mirror for instant session-switch UX. localStorage is the fallback
// for cross-tab / cross-refresh persistence.
export const inputDrafts = new Map<string, string>();

const DRAFT_PREFIX = "convInputDraft:v1:";
const DRAFT_TTL_MS = 10 * 60 * 1000;
const DRAFT_MAX_BYTES = 4096;
export const DRAFT_HEARTBEAT_MS = 60 * 1000;
export const DRAFT_CLEANUP_MS = 60 * 1000;

function draftKey(sessionId: string): string { return DRAFT_PREFIX + sessionId; }

export function loadDraft(sessionId: string): string {
  try {
    const raw = localStorage.getItem(draftKey(sessionId));
    if (!raw) return "";
    const obj = JSON.parse(raw);
    if (typeof obj?.text !== "string" || typeof obj?.updatedAt !== "number") return "";
    if (Date.now() - obj.updatedAt > DRAFT_TTL_MS) {
      try { localStorage.removeItem(draftKey(sessionId)); } catch { /* ignore */ }
      return "";
    }
    return obj.text;
  } catch { return ""; }
}

// Last REAL edit time (keystroke / restore), as opposed to updatedAt which the
// heartbeat keeps bumping for TTL freshness. Used to decide whether a user
// message appearing in the transcript is newer than the draft — i.e. the draft
// was actually sent and the cache should be dropped. Falls back to updatedAt
// for records written before editedAt existed.
export function loadDraftEditedAt(sessionId: string): number {
  try {
    const raw = localStorage.getItem(draftKey(sessionId));
    if (!raw) return 0;
    const obj = JSON.parse(raw);
    if (typeof obj?.editedAt === "number") return obj.editedAt;
    if (typeof obj?.updatedAt === "number") return obj.updatedAt;
    return 0;
  } catch { return 0; }
}

export function saveDraft(sessionId: string, text: string): void {
  if (!text) { clearDraft(sessionId); return; }
  let bytes: number;
  try { bytes = new TextEncoder().encode(text).length; } catch { bytes = text.length * 4; }
  if (bytes > DRAFT_MAX_BYTES) {
    try { localStorage.removeItem(draftKey(sessionId)); } catch { /* ignore */ }
    return;
  }
  try {
    const now = Date.now();
    localStorage.setItem(draftKey(sessionId), JSON.stringify({ text, updatedAt: now, editedAt: now }));
  } catch { /* quota or disabled — ignore */ }
}

// TTL keep-alive for the heartbeat: bump updatedAt of an EXISTING record only.
// Deliberately a no-op when the record is gone — the old heartbeat re-wrote the
// full draft from React state, which resurrected drafts that another tab (or a
// successful send) had just cleared, making them effectively immortal.
export function touchDraft(sessionId: string): void {
  try {
    const raw = localStorage.getItem(draftKey(sessionId));
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (typeof obj?.text !== "string") return;
    obj.updatedAt = Date.now();
    localStorage.setItem(draftKey(sessionId), JSON.stringify(obj));
  } catch { /* ignore */ }
}

export function clearDraft(sessionId: string): void {
  try { localStorage.removeItem(draftKey(sessionId)); } catch { /* ignore */ }
}

export function cleanupExpiredDrafts(): void {
  try {
    const now = Date.now();
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(DRAFT_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) { toRemove.push(key); continue; }
      try {
        const obj = JSON.parse(raw);
        if (typeof obj?.updatedAt !== "number" || now - obj.updatedAt > DRAFT_TTL_MS) {
          toRemove.push(key);
        }
      } catch { toRemove.push(key); }
    }
    for (const k of toRemove) {
      try { localStorage.removeItem(k); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ── Input height ────────────────────────────────────────────────────────────

const HEIGHT_PREFIX = "convInputHeight:v1:";
export const INPUT_HEIGHT_MIN = 44;

function heightKey(sessionId: string): string { return HEIGHT_PREFIX + sessionId; }

export function loadInputHeight(sessionId: string, fallback: number = INPUT_HEIGHT_MIN): number {
  try {
    const v = parseInt(localStorage.getItem(heightKey(sessionId)) || "", 10);
    return isFinite(v) && v >= INPUT_HEIGHT_MIN ? v : fallback;
  } catch { return fallback; }
}

export function saveInputHeight(sessionId: string, h: number): void {
  try {
    localStorage.setItem(heightKey(sessionId), String(Math.round(h)));
  } catch { /* ignore */ }
}

// Drag-resize helper: attach window-level mousemove/mouseup listeners that
// adjust `setHeight` based on cursor delta from the grip's mousedown point.
// Returns nothing; cleans up its own listeners. Saves the final height to
// localStorage on mouseup — uses an internal ref so the saved value is the
// last dragged-to value, not the value captured at mousedown.
export function startInputHeightDrag(opts: {
  sessionId: string;
  startClientY: number;
  startHeight: number;
  maxHeight: number;
  onChange: (h: number) => void;
}): void {
  const state = { currentH: opts.startHeight };
  const onMove = (ev: MouseEvent) => {
    const next = Math.max(
      INPUT_HEIGHT_MIN,
      Math.min(opts.maxHeight, opts.startHeight + (opts.startClientY - ev.clientY)),
    );
    state.currentH = next;
    opts.onChange(next);
  };
  const onUp = () => {
    saveInputHeight(opts.sessionId, state.currentH);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
