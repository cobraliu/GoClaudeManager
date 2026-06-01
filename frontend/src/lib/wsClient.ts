export type WsOutputHandler = (data: string) => void;
export type WsStateHandler = (state: Record<string, unknown>) => void;
export type WsCloseHandler = (reason: string) => void;
export type WsOpenHandler = () => void;

export type WsPromptRejectedHandler = (reason: string, text: string) => void;
export type WsCopyModeExitedHandler = () => void;

export interface WsClientOptions {
  url: string;
  onOutput: WsOutputHandler;
  onState?: WsStateHandler;
  onClose?: WsCloseHandler;
  onOpen?: WsOpenHandler;
  onPromptRejected?: WsPromptRejectedHandler;
  onCopyModeExited?: WsCopyModeExitedHandler;
  autoReconnect?: boolean; // default true
}

export class WsClient {
  private ws: WebSocket | null = null;
  private opts: WsClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
    this.connect();
  }

  private connect() {
    if (this.closed) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}${this.opts.url}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.opts.onOpen?.();
    };

    this.ws.onmessage = (ev) => {
      // Binary frame = raw terminal output (fast path)
      if (ev.data instanceof ArrayBuffer) {
        const text = new TextDecoder().decode(ev.data);
        this.opts.onOutput(text);
        return;
      }
      // Text frame = JSON control message
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "output" && msg.payload?.data) {
          this.opts.onOutput(msg.payload.data);
        } else if (msg.type === "state" && this.opts.onState) {
          this.opts.onState(msg.payload);
        } else if (msg.type === "prompt-rejected" && this.opts.onPromptRejected) {
          this.opts.onPromptRejected(msg.reason || "", msg.text || "");
        } else if (msg.type === "copy-mode-exited" && this.opts.onCopyModeExited) {
          this.opts.onCopyModeExited();
        }
      } catch {
        // might be plain text output fallback
        if (typeof ev.data === "string" && ev.data.length > 0) {
          this.opts.onOutput(ev.data);
        }
      }
    };

    this.ws.onclose = (ev) => {
      if (this.closed) return;
      this.opts.onClose?.(ev.reason || "disconnected");
      if (ev.code === 4001) return;
      if (this.opts.autoReconnect !== false) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  sendInput(data: string) {
    this.ws?.readyState === WebSocket.OPEN &&
      this.ws.send(JSON.stringify({ type: "input", data }));
  }

  /** Send a prompt directly to tmux pane 0 via send-keys, bypassing PTY active-pane routing.
   *  Use this for structured chat input so splits don't redirect it to a new shell pane. */
  sendPrompt(text: string) {
    this.ws?.readyState === WebSocket.OPEN &&
      this.ws.send(JSON.stringify({ type: "input", data: text + "\r", pane: "0" }));
  }

  sendResize(cols: number, rows: number) {
    this.ws?.readyState === WebSocket.OPEN &&
      this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  sendSearchInit(query: string) {
    this.ws?.readyState === WebSocket.OPEN &&
      this.ws.send(JSON.stringify({ type: "search-init", query }));
  }

  sendSearchNext() {
    this.ws?.readyState === WebSocket.OPEN &&
      this.ws.send(JSON.stringify({ type: "search-next" }));
  }

  sendPing() {
    this.ws?.readyState === WebSocket.OPEN &&
      this.ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
  }

  sendScroll(delta: number) {
    this.ws?.readyState === WebSocket.OPEN &&
      this.ws.send(JSON.stringify({ type: "scroll", delta }));
  }

  sendExitCopyMode() {
    this.ws?.readyState === WebSocket.OPEN &&
      this.ws.send(JSON.stringify({ type: "exit-copy-mode" }));
  }

  sendRefresh() {
    this.ws?.readyState === WebSocket.OPEN &&
      this.ws.send(JSON.stringify({ type: "refresh" }));
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
