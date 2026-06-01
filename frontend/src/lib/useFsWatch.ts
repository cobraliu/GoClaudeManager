import { useEffect, useRef } from "react";
import { apiPath } from "./baseUrl";

export interface FsChange {
  type: "add" | "modify" | "delete";
  path: string;
  dir: string;
  is_dir: boolean;
}

/** Subscribe to the backend's filesystem watcher for a session.
 *
 *  Wraps the `/api/sessions/{id}/fs/watch` WebSocket. The backend batches
 *  changes with a ~150ms debounce so handlers see at most one callback per
 *  burst of edits. Automatically reconnects on close after a 3s backoff.
 *  Pass `null` as sessionId to disable (e.g. before a session is active).
 */
export function useFsWatch(
  sessionId: string | null,
  onChanges: (changes: FsChange[]) => void,
): void {
  const onChangesRef = useRef(onChanges);
  onChangesRef.current = onChanges;

  useEffect(() => {
    if (!sessionId) return;
    const token = localStorage.getItem("token");
    if (!token) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}${apiPath(`/api/sessions/${sessionId}/fs/watch?token=${encodeURIComponent(token)}`)}`;
    let ws: WebSocket | null = null;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(url);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { changes: FsChange[] };
          if (msg.changes?.length) onChangesRef.current(msg.changes);
        } catch {
          // Ignore malformed frames — the backend only ever sends well-formed
          // JSON; a parse failure means something else snuck onto the socket.
        }
      };
      ws.onclose = () => {
        if (!stopped) retryTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, [sessionId]);
}
