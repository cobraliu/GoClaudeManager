import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { sendCodexMessage } from "../api/sessionApi";
import {
  inputDrafts,
  loadDraft,
  saveDraft,
  clearDraft,
  touchDraft,
  loadInputHeight,
  startInputHeightDrag,
  inputHeightMax,
  INPUT_HEIGHT_MIN,
  DRAFT_HEARTBEAT_MS,
} from "../lib/sessionInputPersist";

type Props = {
  sessionId: string;
  onSent?: () => void;
};

export default function CodexChatInput({ sessionId, onSent }: Props) {
  const [text, setText] = useState(() => {
    const inMem = inputDrafts.get(sessionId);
    if (inMem !== undefined) return inMem;
    const persisted = loadDraft(sessionId);
    if (persisted) inputDrafts.set(sessionId, persisted);
    return persisted;
  });
  const [inputHeight, setInputHeight] = useState<number>(() => loadInputHeight(sessionId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: mirror of ConversationPane — the textarea expands with content
  // past the base height up to inputHeightMax(), shrinking back as content is
  // removed. Height is written directly to the DOM so measurement (collapse →
  // scrollHeight) doesn't fight React. +2 = borders (border-box).
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.max(inputHeight, Math.min(ta.scrollHeight + 2, inputHeightMax()))}px`;
  }, [text, inputHeight]);

  // Heartbeat: refresh updatedAt while the user stares at a draft so a
  // long-running compose doesn't get reaped at 10min boundary. touchDraft (not
  // saveDraft) so a stale pane can't resurrect a draft cleared elsewhere.
  useEffect(() => {
    if (!text) return;
    const id = setInterval(() => { touchDraft(sessionId); }, DRAFT_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [sessionId, text]);

  const submit = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendCodexMessage(sessionId, t);
      setText("");
      inputDrafts.delete(sessionId);
      clearDraft(sessionId);
      onSent?.();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  const onChange = (val: string) => {
    setText(val);
    if (val) {
      inputDrafts.set(sessionId, val);
      saveDraft(sessionId, val);
    } else {
      inputDrafts.delete(sessionId);
      clearDraft(sessionId);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-panel)",
        borderTop: "1px solid var(--border)",
      }}
    >
      {/* Top grip: mirror of ConversationPane's drag-to-resize handle (pointer
          events + touch-action:none so it also works on mobile, 3× cap there). */}
      <div
        onPointerDown={(e) => {
          startInputHeightDrag({
            sessionId,
            startClientY: e.clientY,
            startHeight: inputHeight,
            maxHeight: inputHeightMax(),
            onChange: setInputHeight,
          });
        }}
        title="Drag to resize input"
        style={{
          height: 14, cursor: "ns-resize", display: "flex", alignItems: "center", justifyContent: "center",
          background: "transparent", touchAction: "none",
        }}
      >
        <div style={{ width: 40, height: 4, borderRadius: 2, background: "var(--text-faintest)" }} />
      </div>
      {error && (
        <div style={{ fontSize: 11, color: "#ef4444", padding: "0 8px 4px" }}>{error}</div>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end", padding: "2px 8px 8px" }}>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          placeholder="Message Codex (Ctrl/⌘+Enter to send)…"
          style={{
            flex: 1,
            resize: "none",
            background: "var(--bg-main)",
            color: "var(--text-body)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            padding: "6px 8px",
            fontSize: 13,
            fontFamily: "inherit",
            outline: "none",
            // height is managed by the auto-grow layout effect above.
            minHeight: INPUT_HEIGHT_MIN,
          }}
        />
        <button
          onClick={submit}
          disabled={sending || !text.trim()}
          style={{
            background: "var(--accent-blue)",
            color: "#fff",
            border: "none",
            padding: "8px 14px",
            borderRadius: 5,
            cursor: sending || !text.trim() ? "not-allowed" : "pointer",
            opacity: sending || !text.trim() ? 0.5 : 1,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
