import type { Screen } from './types';

export type SimState = 'connecting' | 'booting' | 'starting' | 'ready' | 'no_device' | 'error' | 'offline' | 'closed';

export type ClientMessage =
  | { type: 'tap'; x: number; y: number }
  | { type: 'drag'; points: { x: number; y: number; t: number }[] }
  | { type: 'keys'; text: string }
  | { type: 'key'; name: string }
  | { type: 'button'; name: 'home' | 'lock' | 'volumeUp' | 'volumeDown' }
  | { type: 'rotate'; orientation: 'portrait' | 'landscape' }
  | { type: 'settings'; scale: number; quality: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'ping' };

/** Messages that act on the device (TER-576): only sent when the user holds terminals:write; the server drops them otherwise. */
const ACTING: ReadonlySet<ClientMessage['type']> = new Set(['tap', 'drag', 'keys', 'key', 'button', 'rotate']);

export interface SimulatorHandlers {
  onFrame: (frame: Blob) => void;
  onStatus: (state: SimState, message?: string, tail?: string[]) => void;
  onScreen: (screen: Screen) => void;
  onToast: (message: string) => void;
}

const MAX_ATTEMPTS = 8;
const BASE_DELAY = 500;
const MAX_DELAY = 15_000;

/** WS do simulador: binário = frame JPEG; texto = JSON de controle. Reconecta com backoff, exceto após `error`. */
export class SimulatorConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private halted = false; // recebeu 'error' do servidor: só reconecta no retryNow()
  state: SimState = 'connecting';
  /** false when the user lacks terminals:write: the stream still plays, but nothing acts on the device */
  private writable = true;

  constructor(
    private tabId: string,
    private handlers: SimulatorHandlers,
  ) {}

  private setState(s: SimState, message?: string, tail?: string[]) {
    this.state = s;
    this.handlers.onStatus(s, message, tail);
  }

  connect() {
    this.stopped = false;
    this.open();
  }

  private open() {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/sim/${this.tabId}`);
    ws.binaryType = 'blob';
    this.ws = ws;
    this.setState('connecting');
    ws.onopen = () => {
      this.attempt = 0;
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof Blob) {
        this.handlers.onFrame(ev.data);
        return;
      }
      let msg: { type: string; state?: SimState; message?: string; tail?: string[]; width?: number; height?: number; orientation?: 'portrait' | 'landscape' };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'status' && msg.state) {
        if (msg.state === 'error') this.halted = true;
        this.setState(msg.state, msg.message, msg.tail);
      } else if (msg.type === 'screen' && typeof msg.width === 'number' && typeof msg.height === 'number' && msg.orientation) {
        this.handlers.onScreen({ width: msg.width, height: msg.height, orientation: msg.orientation });
      } else if (msg.type === 'toast' && msg.message) {
        this.handlers.onToast(msg.message);
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      if (ev.code === 4100) {
        // servidor fechou porque a tab trocou de aparelho: reconecta já, mesmo que um status 'error' tenha chegado antes
        this.attempt = 0;
        this.halted = false;
        this.open();
        return;
      }
      if (this.halted) {
        this.setState('error');
        return;
      }
      if (ev.code === 1008 || ev.code === 4001) {
        this.setState('offline');
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  private scheduleReconnect() {
    if (this.attempt >= MAX_ATTEMPTS) {
      this.setState('offline');
      return;
    }
    this.attempt += 1;
    const delay = Math.min(BASE_DELAY * 2 ** (this.attempt - 1), MAX_DELAY) * (0.7 + Math.random() * 0.6);
    this.timer = setTimeout(() => this.open(), delay);
  }

  retryNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.halted = false;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.open();
  }

  setWritable(writable: boolean) {
    this.writable = writable;
  }

  send(msg: ClientMessage) {
    if (!this.writable && ACTING.has(msg.type)) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState('closed');
  }
}
