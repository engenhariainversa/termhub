// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectGate } from './connect-gate';
import { TerminalConnection, type ConnectionState } from './terminal-connection';

/** Minimal stand-in for the browser WebSocket: the test drives open/message/close by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = '';
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1];

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { CONNECTING: 0, OPEN: 1 }));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function start(gate = new ConnectGate(), tabId = 't1') {
  const states: [ConnectionState, number][] = [];
  const errors: string[] = [];
  const conn = new TerminalConnection(tabId, { onData: () => {}, onState: (s, a) => states.push([s, a]), onError: (m) => errors.push(m) }, gate);
  conn.connect({ cols: 80, rows: 24 });
  return { conn, states, errors };
}

const socketOf = (tabId: string) => FakeSocket.all.filter((s) => s.url.includes(`/ws/tabs/${tabId}?`));

/** The server accepts the socket, then the machine refuses to start the terminal. */
function failOpen(ws: FakeSocket) {
  ws.open();
  ws.message({ type: 'error', message: 'Falha ao iniciar terminal' });
  ws.serverClose(1011);
}

describe('TerminalConnection', () => {
  it('backs off and gives up when the socket opens but the terminal never starts', () => {
    const { states, errors } = start();
    for (let i = 0; i < 20 && FakeSocket.all.length <= 20; i++) {
      const ws = last();
      failOpen(ws);
      vi.advanceTimersByTime(60_000);
      if (last() === ws) break; // no new attempt: it stopped
    }
    // 1 first try + 8 retries, then offline — not one retry per second forever
    expect(FakeSocket.all).toHaveLength(9);
    expect(states[states.length - 1][0]).toBe('offline');
    expect(states.some(([s]) => s === 'connected')).toBe(false);
    expect(errors[errors.length - 1]).toBe('Falha ao iniciar terminal');
  });

  it('is connected only once the server says the terminal is ready, and then resets the attempts', () => {
    const { states } = start();
    failOpen(last());
    vi.advanceTimersByTime(60_000);
    const ws = last();
    ws.open();
    expect(states[states.length - 1][0]).toBe('reconnecting');
    ws.message({ type: 'ready' });
    expect(states[states.length - 1]).toEqual(['connected', 0]);
    expect(ws.sent).toContain(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  });

  it('reconnects quickly on 1012 without spending an attempt', () => {
    const { states } = start();
    last().open();
    last().message({ type: 'ready' });
    last().serverClose(1012);
    expect(states.at(-1)).toEqual(['reconnecting', 0]);
    vi.advanceTimersByTime(760);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('several 1012 in a row never reach offline', () => {
    const { states } = start();
    for (let i = 0; i < 12; i++) {
      last().serverClose(1012);
      vi.advanceTimersByTime(760);
    }
    expect(states.some(([s]) => s === 'offline')).toBe(false);
  });

  it('exit frame then 1012 stays closed', () => {
    const { states } = start();
    last().open();
    last().message({ type: 'exit', code: 0 });
    last().serverClose(1012);
    expect(states.at(-1)?.[0]).toBe('closed');
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  // TER-902: Chromium runs one WebSocket handshake per host at a time and delays each new socket more the more
  // are pending, so a page that opens every terminal of a project at once (or reconnects them all after a
  // deploy) left the tab on screen at the back of a queue of 1–5 s handshakes.
  describe('opening many terminals', () => {
    it('keeps at most two handshakes pending and opens the next as one completes', () => {
      const gate = new ConnectGate();
      for (const id of ['a', 'b', 'c', 'd']) start(gate, id);
      expect(FakeSocket.all.map((s) => s.url.split('/ws/tabs/')[1].split('?')[0])).toEqual(['a', 'b']);
      socketOf('a')[0].open();
      expect(socketOf('c')).toHaveLength(1);
      expect(socketOf('d')).toHaveLength(0);
    });

    it('the visible terminal skips the queue', () => {
      const gate = new ConnectGate();
      for (const id of ['a', 'b', 'c', 'd']) start(gate, id);
      const { conn: visible, states } = start(gate, 'shown');
      visible.setPriority(true);
      expect(states.at(-1)?.[0]).toBe('connecting');
      socketOf('a')[0].open();
      expect(socketOf('shown')).toHaveLength(1);
      expect(socketOf('c')).toHaveLength(0);
    });

    it('gives up on a handshake that never completes, frees its slot and tries again', () => {
      const gate = new ConnectGate(1);
      const { states } = start(gate, 'stuck');
      start(gate, 'next');
      expect(socketOf('next')).toHaveLength(0);
      vi.advanceTimersByTime(10_000);
      expect(socketOf('next')).toHaveLength(1);
      expect(states.at(-1)?.[0]).toBe('reconnecting');
      socketOf('next')[0].open();
      vi.advanceTimersByTime(2_000);
      expect(socketOf('stuck')).toHaveLength(2);
    });

    it('a terminal closed while waiting never opens a socket', () => {
      const gate = new ConnectGate(1);
      start(gate, 'a');
      const { conn } = start(gate, 'b');
      conn.close();
      socketOf('a')[0].open();
      expect(socketOf('b')).toHaveLength(0);
    });
  });

  describe('wheel scroll', () => {
    const scrollSent = (ws: FakeSocket) => ws.sent.filter((d) => typeof d === 'string' && d.includes('"scroll"'));

    it('can scroll only once ready says so, and sends the lines as a scroll message', () => {
      const { conn } = start();
      const ws = last();
      ws.open();
      expect(conn.canScroll).toBe(false);
      conn.sendScroll(-3); // not ready yet
      ws.message({ type: 'ready', scroll: true });
      expect(conn.canScroll).toBe(true);
      conn.sendScroll(-3);
      conn.sendScroll(0); // nothing to say
      expect(scrollSent(ws)).toEqual([JSON.stringify({ type: 'scroll', lines: -3 })]);
    });

    it('an older server (no scroll in ready) keeps the wheel with xterm.js', () => {
      const { conn } = start();
      last().open();
      last().message({ type: 'ready' });
      expect(conn.canScroll).toBe(false);
      conn.sendScroll(-3);
      expect(scrollSent(last())).toEqual([]);
    });

    it('caps a message at 500 lines either way', () => {
      const { conn } = start();
      last().open();
      last().message({ type: 'ready', scroll: true });
      conn.sendScroll(-9000);
      conn.sendScroll(9000);
      expect(scrollSent(last())).toEqual([JSON.stringify({ type: 'scroll', lines: -500 }), JSON.stringify({ type: 'scroll', lines: 500 })]);
    });

    it('forgets canScroll when the socket drops, until the next ready', () => {
      const { conn } = start();
      last().open();
      last().message({ type: 'ready', scroll: true });
      last().serverClose(1012);
      expect(conn.canScroll).toBe(false);
      vi.advanceTimersByTime(1000);
      last().open();
      last().message({ type: 'ready', scroll: false });
      expect(conn.canScroll).toBe(false);
    });
  });
});
