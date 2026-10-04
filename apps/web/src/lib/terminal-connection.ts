import { terminalGate, type ConnectGate, type GateTicket } from './connect-gate';
import { RESTART_CLOSE, reconnectDelay } from './reconnect';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'closed';

export interface TerminalConnectionHandlers {
  onData: (data: Uint8Array) => void;
  onState: (state: ConnectionState, attempt: number) => void;
  onExit?: (code: number) => void;
  /** what the server said went wrong (e.g. the machine could not start the terminal) */
  onError?: (message: string) => void;
}

const MAX_ATTEMPTS = 8;
/** Most lines one scroll message may carry (the server refuses more). */
const SCROLL_MAX_LINES = 500;
const BASE_DELAY = 500;
const MAX_DELAY = 15_000;
/** A handshake still pending after this is abandoned and retried: it would otherwise hold its slot in the gate. */
const HANDSHAKE_TIMEOUT = 10_000;

/**
 * WebSocket de um terminal com reconexão automática (backoff exponencial + jitter).
 * Binário = dados do terminal; texto = mensagens de controle em JSON.
 */
export class TerminalConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private size = { cols: 80, rows: 24 };
  private encoder = new TextEncoder();
  private exited = false;
  /** set when the last close was a 1012 (deploy/agent reconnecting): keep showing "Reconectando…" instead of "Conectando…" */
  private restarting = false;
  state: ConnectionState = 'connecting';
  /**
   * The server scrolls the tmux pane on a wheel (TER-465): set from `ready` on every connection, false
   * until then and for an older server or agent — the wheel then stays with xterm.js, as before.
   */
  canScroll = false;
  /** Our place in the handshake gate (TER-902): waiting for a slot, or holding one until the handshake settles. */
  private ticket: GateTicket | null = null;
  /** The terminal is on screen: its handshake goes ahead of the hidden ones. */
  private priority = false;

  constructor(
    private tabId: string,
    private handlers: TerminalConnectionHandlers,
    private gate: ConnectGate = terminalGate,
  ) {}

  /** Visible terminals connect first; set it as the tab shows or hides. */
  setPriority(visible: boolean) {
    this.priority = visible;
  }

  private dropTicket() {
    this.ticket?.release();
    this.ticket = null;
  }

  private setState(s: ConnectionState) {
    this.state = s;
    this.handlers.onState(s, this.attempt);
  }

  connect(size?: { cols: number; rows: number }) {
    if (size) this.size = size;
    this.stopped = false;
    this.open();
  }

  /** Waits for a slot in the gate (Chromium handshakes one socket per host at a time anyway), then opens. */
  private open() {
    if (this.stopped) return;
    this.canScroll = false;
    this.setState(this.attempt === 0 && !this.restarting ? 'connecting' : 'reconnecting');
    this.dropTicket();
    let ticket: GateTicket | null = null;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      ticket?.release();
      if (this.ticket === ticket) this.ticket = null;
    };
    ticket = this.gate.enqueue(() => this.openSocket(settle), () => this.priority);
    // the gate may have started (and settled) the socket before enqueue returned
    if (settled) ticket.release();
    else this.ticket = ticket;
  }

  private openSocket(settle: () => void) {
    if (this.stopped) {
      settle();
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/tabs/${this.tabId}?cols=${this.size.cols}&rows=${this.size.rows}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    const handshake = setTimeout(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.CONNECTING) return;
      this.ws = null;
      settle();
      ws.close();
      this.scheduleReconnect();
    }, HANDSHAKE_TIMEOUT);

    // The socket opens before the server has started the terminal, which can still fail on the
    // machine: only `ready` counts as connected and resets the backoff. Resetting on open made a
    // terminal that never starts retry about once a second, forever. The handshake is over, though:
    // the next terminal may start its own.
    ws.onopen = () => {
      clearTimeout(handshake);
      settle();
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.handlers.onData(new Uint8Array(ev.data));
        return;
      }
      try {
        const msg = JSON.parse(String(ev.data)) as { type: string; code?: number; message?: string; scroll?: boolean };
        if (msg.type === 'ready') {
          this.canScroll = msg.scroll === true;
          this.attempt = 0;
          this.restarting = false;
          this.setState('connected');
          this.sendResize(this.size.cols, this.size.rows);
        } else if (msg.type === 'error' && msg.message) {
          this.handlers.onError?.(msg.message);
        } else if (msg.type === 'exit') {
          // O processo do terminal terminou (tmux detach/exit, ssh falhou, tmux ausente...).
          // Não reconecta sozinho: o usuário decide com o botão "Reconectar".
          this.exited = true;
          this.handlers.onExit?.(msg.code ?? 0);
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = (ev) => {
      clearTimeout(handshake);
      settle();
      if (this.ws !== ws) return;
      this.ws = null;
      this.canScroll = false;
      if (this.stopped) return;
      if (this.exited) {
        this.setState('closed');
        return;
      }
      // 1008/4001 = não autorizado — não insiste.
      if (ev.code === 1008 || ev.code === 4001) {
        this.setState('offline');
        return;
      }
      // A deploy or an agent reconnecting (1012): not a failure — come back right away and keep the attempts.
      if (ev.code === RESTART_CLOSE) {
        this.attempt = 0;
        this.restarting = true;
        this.setState('reconnecting');
        this.timer = setTimeout(() => this.open(), reconnectDelay(ev.code, 0));
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose cuida */
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.attempt >= MAX_ATTEMPTS) {
      this.setState('offline');
      return;
    }
    this.attempt += 1;
    const delay = Math.min(BASE_DELAY * 2 ** (this.attempt - 1), MAX_DELAY) * (0.7 + Math.random() * 0.6);
    this.setState('reconnecting');
    this.timer = setTimeout(() => this.open(), delay);
  }

  /** Reinicia o ciclo de tentativas (botão "reconectar" ou volta de foco/online). */
  retryNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.exited = false;
    this.restarting = false;
    this.dropTicket();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.open();
  }

  send(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.encoder.encode(data));
  }

  sendResize(cols: number, rows: number) {
    this.size = { cols, rows };
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  /** Scrolls the tab's tmux pane by `lines` (< 0 up, > 0 down); does nothing unless `canScroll`. */
  sendScroll(lines: number) {
    if (!this.canScroll || lines === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    const capped = Math.max(-SCROLL_MAX_LINES, Math.min(SCROLL_MAX_LINES, Math.trunc(lines)));
    if (capped !== 0) this.ws.send(JSON.stringify({ type: 'scroll', lines: capped }));
  }

  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dropTicket();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState('closed');
  }
}
