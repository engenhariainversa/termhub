// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatorConnection, type ClientMessage } from './simulator-connection';

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = '';
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { CONNECTING: 0, OPEN: 1 }));
});
afterEach(() => vi.unstubAllGlobals());

const ACTING: ClientMessage[] = [
  { type: 'tap', x: 1, y: 2 },
  { type: 'drag', points: [{ x: 1, y: 2, t: 0 }] },
  { type: 'keys', text: 'oi' },
  { type: 'key', name: 'Enter' },
  { type: 'button', name: 'home' },
  { type: 'rotate', orientation: 'landscape' },
];
const VIEWING: ClientMessage[] = [{ type: 'pause' }, { type: 'resume' }, { type: 'settings', scale: 50, quality: 50 }, { type: 'ping' }];

function open() {
  const conn = new SimulatorConnection('t1', { onFrame: () => {}, onStatus: () => {}, onScreen: () => {}, onToast: () => {} });
  conn.connect();
  const ws = FakeSocket.all[0];
  ws.open();
  return { conn, ws };
}

// TER-576: acting on a simulator requires terminals:write; watching it does not.
describe('SimulatorConnection read-only', () => {
  it('sends taps, drags, keys, buttons and rotation while writable', () => {
    const { conn, ws } = open();
    for (const m of ACTING) conn.send(m);
    expect(ws.sent.map((d) => JSON.parse(d).type)).toEqual(ACTING.map((m) => m.type));
  });

  it('drops them when read-only but keeps the per-viewer stream messages', () => {
    const { conn, ws } = open();
    conn.setWritable(false);
    for (const m of [...ACTING, ...VIEWING]) conn.send(m);
    expect(ws.sent.map((d) => JSON.parse(d).type)).toEqual(VIEWING.map((m) => m.type));
  });
});
