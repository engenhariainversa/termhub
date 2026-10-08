import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import {
  CLOSE,
  CONTROL_CHANNEL,
  HEADER_BYTES,
  MAX_FRAME,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  serverMessage,
  type AgentMessage,
  type HelloMessage,
  type ServerMessage,
} from '@termhub/agent-protocol';
import { proxyConnection, proxyFor } from './proxy.js';

export interface ClientOptions {
  url: string;
  token: string;
  hello: Omit<HelloMessage, 'type' | 'protocol'>;
  onServerMessage(msg: ServerMessage, conn: AgentSocket): void;
  onStream(ch: number, data: Buffer): void;
  log: (msg: string, meta?: object) => void;
  backoff?: { minMs: number; maxMs: number };
  maxUnauthorized?: number;
  /**
   * Called by `runForever()` once per session, right after `closed` resolves (or the connect
   * attempt itself fails) — before the next reconnect attempt. Used by the CLI (`run.ts`) to
   * drop any PTY channels left over from the ended session (`pty.closeAll()`); optional so
   * `connectOnce()` callers and tests that don't care about this can omit it.
   */
  onDisconnect?(): void;
  /**
   * Called right after the hello goes out, once per session. `run.ts` uses it to put the monitor
   * hooks back in place (`heal()`), so a config dir created since the install starts notifying.
   */
  onConnect?(): void;
  /** Liveness ping period (default 20 s); a ping left unanswered by the next tick terminates the socket. Tests shorten it. */
  pingIntervalMs?: number;
  /**
   * How long the opening handshake may take (default 15 s). `ws` sets no limit of its own, and the
   * liveness ping only starts once the socket is open: an upgrade request that never gets an answer
   * would leave `connectOnce()` pending and `runForever()` stuck on it. Tests shorten it.
   */
  handshakeTimeoutMs?: number;
  /** Where the proxy variables (`HTTPS_PROXY`, `NO_PROXY`, …) are read; defaults to `process.env`. Tests pass their own. */
  env?: Record<string, string | undefined>;
}

export interface AgentSocket {
  sendControl(msg: AgentMessage): void;
  /** Sends `data` on channel `ch`, sliced so no single frame exceeds MAX_FRAME (the server closes the
   *  whole socket with 1009 above that, taking every terminal on the machine with it). */
  sendStream(ch: number, data: Buffer): void;
  /** Bytes queued on the WebSocket and not yet handed to the kernel; the tcp manager's flow control
   *  reads it. Optional so test doubles built before it existed keep compiling (they read as 0). */
  bufferedAmount?(): number;
}

/** Largest stream payload one frame may carry: the frame limit minus the channel header. */
export const MAX_STREAM_PAYLOAD = MAX_FRAME - HEADER_BYTES;

export interface CloseInfo {
  code: number;
  reason: string;
}

/** Thrown by runForever() after `maxUnauthorized` consecutive 4401 closes — the token was revoked. */
export class RevokedError extends Error {}

/** Thrown by runForever() when the server closes 4409 with reason 'protocol' — versions cannot talk. */
export class ProtocolMismatchError extends Error {}

/**
 * connectOnce() rejects with this when the server refuses the WebSocket upgrade itself (an
 * HTTP-level `unexpected-response`, e.g. 401 for a bad/unknown token before any hello — the
 * real server only sends a WS close 4401 for a token revoked *after* it was already connected).
 */
export class UpgradeRejectedError extends Error {
  constructor(public readonly status: number) {
    super(`upgrade rejected: HTTP ${status}`);
  }
}

const DEFAULT_BACKOFF = { minMs: 1_000, maxMs: 30_000 };
const DEFAULT_PING_INTERVAL_MS = 20_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_UNAUTHORIZED = 3;
/** A session shorter than this (and with no server message) doesn't count as "successful" for backoff/unauthorized resets. */
const SESSION_OK_MS = 5_000;

/** `https://app.x` → `wss://app.x/agent/ws`; `http://localhost:3000` → `ws://localhost:3000/agent/ws`. */
function deriveWsUrl(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/agent/ws`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/**
 * Connects once; resolves with the socket after the WebSocket opens and the hello frame is
 * sent. Rejects if the handshake itself fails (bad-status upgrade response — surfaced as
 * `UpgradeRejectedError` — a network error, or an upgrade left unanswered for `handshakeTimeoutMs`) — once open, later outcomes (including a
 * 4401/4409 close) are reported via `closed`, not by rejecting this promise.
 *
 * `signal`, if given, tears the connection down immediately (graceful close if already open,
 * `terminate()` otherwise) instead of waiting for the server — used by runForever() so an
 * abort mid-session doesn't have to wait for the far end to close first.
 */
export function connectOnce(
  opts: ClientOptions,
  signal?: AbortSignal,
): Promise<{ socket: AgentSocket; closed: Promise<CloseInfo> }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const wsUrl = deriveWsUrl(opts.url);
    let proxy: URL | undefined;
    try {
      proxy = proxyFor(new URL(wsUrl), opts.env);
    } catch (err) {
      reject(err);
      return;
    }
    // `handshakeTimeout` makes `ws` abort with the error "Opening handshake has timed out", which the
    // 'error' handler below turns into a rejection, so runForever() backs off and tries again.
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${opts.token}` },
      handshakeTimeout: opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      // An explicit proxy (HTTPS_PROXY): the request goes out over a CONNECT tunnel instead of a direct socket.
      ...(proxy ? { createConnection: proxyConnection(proxy, wsUrl.startsWith('wss:')) as never } : {}),
    });
    let opened = false;
    let socket: AgentSocket | undefined;

    const onAbort = () => {
      if (opened) ws.close(1000, 'aborted');
      else ws.terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const stopWatchingAbort = () => signal?.removeEventListener('abort', onAbort);

    let resolveClosed!: (info: CloseInfo) => void;
    const closed = new Promise<CloseInfo>((res) => {
      resolveClosed = res;
    });

    // Liveness from our side too: the server pings every 20 s, but a half-open TCP path (NAT
    // timeout, laptop lid, Wi-Fi hop) can leave this end believing it is connected for the
    // kernel's full keepalive window while the server has already marked the machine offline.
    // A ping that the next tick finds unanswered means the path is dead: terminate, so
    // runForever() reconnects right away instead of minutes later.
    let liveness: ReturnType<typeof setInterval> | undefined;
    let pongSeen = true;
    ws.on('pong', () => {
      pongSeen = true;
    });

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      stopWatchingAbort();
      if (liveness) clearInterval(liveness);
      const info = { code, reason: reasonBuf.toString() };
      resolveClosed(info);
      if (!opened) reject(new Error(`connection closed before open (code ${code})`));
    });

    ws.on('unexpected-response', (_req, res) => {
      stopWatchingAbort();
      const statusCode = res.statusCode ?? 0;
      res.resume();
      ws.terminate();
      reject(new UpgradeRejectedError(statusCode));
    });

    ws.on('error', (err: Error) => {
      if (!opened) {
        stopWatchingAbort();
        reject(err);
      } else {
        opts.log('agent socket error', { error: err.message });
      }
    });

    ws.on('open', () => {
      opened = true;
      liveness = setInterval(() => {
        if (!pongSeen) {
          opts.log('agent liveness ping unanswered, terminating');
          ws.terminate();
          return;
        }
        pongSeen = false;
        ws.ping();
      }, opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
      socket = {
        sendControl: (msg) => ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(msg))),
        sendStream: (ch, data) => {
          if (data.length <= MAX_STREAM_PAYLOAD) {
            ws.send(encodeFrame(ch, data));
            return;
          }
          for (let off = 0; off < data.length; off += MAX_STREAM_PAYLOAD) ws.send(encodeFrame(ch, data.subarray(off, off + MAX_STREAM_PAYLOAD)));
        },
        bufferedAmount: () => ws.bufferedAmount,
      };
      const hello: HelloMessage = { type: 'hello', protocol: PROTOCOL_VERSION, ...opts.hello };
      socket.sendControl(hello);
      opts.onConnect?.();
      resolve({ socket, closed });
    });

    ws.on('message', (data: RawData) => {
      if (!socket) return; // messages cannot arrive before 'open', but keep TS and defense-in-depth happy
      let frame: { ch: number; payload: Buffer };
      try {
        frame = decodeFrame(toBuffer(data));
      } catch (err) {
        opts.log('dropped malformed frame', { error: (err as Error).message });
        return;
      }

      if (frame.ch === CONTROL_CHANNEL) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          opts.log('dropped non-JSON control message');
          return;
        }
        const result = serverMessage.safeParse(parsed);
        if (!result.success) {
          opts.log('dropped invalid server message', { issues: result.error.issues.length });
          return;
        }
        opts.onServerMessage(result.data, socket);
      } else {
        opts.onStream(frame.ch, frame.payload);
      }
    });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `base = min(prev * 2, max)`, then ±20 % jitter, clamped to `[min, max]`. */
export function nextBackoff(prevMs: number, min: number, max: number, rand: () => number = Math.random): number {
  const base = Math.min(prevMs * 2, max);
  const jittered = base * (0.8 + 0.4 * rand());
  return Math.min(max, Math.max(min, jittered));
}

/**
 * Connects forever, reconnecting with backoff on every disconnect. Resolves cleanly when
 * `signal` aborts; rejects with RevokedError after `maxUnauthorized` consecutive 4401 closes,
 * or with ProtocolMismatchError on a 4409 'protocol' close (both are terminal — no more retries).
 */
export async function runForever(opts: ClientOptions, signal?: AbortSignal): Promise<void> {
  const min = opts.backoff?.minMs ?? DEFAULT_BACKOFF.minMs;
  const max = opts.backoff?.maxMs ?? DEFAULT_BACKOFF.maxMs;
  const maxUnauthorized = opts.maxUnauthorized ?? DEFAULT_MAX_UNAUTHORIZED;

  let unauthorized = 0;
  let backoff = min;

  while (!signal?.aborted) {
    let sessionOk = false;
    let closeInfo: CloseInfo | undefined;
    let upgradeRejectedStatus: number | undefined;

    const innerOpts: ClientOptions = {
      ...opts,
      onServerMessage: (msg, conn) => {
        sessionOk = true;
        opts.onServerMessage(msg, conn);
      },
    };

    try {
      const { closed } = await connectOnce(innerOpts, signal);
      const startedAt = Date.now();
      closeInfo = await closed;
      if (Date.now() - startedAt > SESSION_OK_MS) sessionOk = true;
      opts.log('agent connection closed', { code: closeInfo.code, reason: closeInfo.reason });
    } catch (err) {
      if (err instanceof UpgradeRejectedError) {
        upgradeRejectedStatus = err.status;
        opts.log('agent upgrade rejected', { status: err.status });
      } else {
        opts.log('agent connect failed', { error: (err as Error).message });
      }
    }

    opts.onDisconnect?.();

    if (closeInfo?.code === CLOSE.UNAUTHORIZED || upgradeRejectedStatus === 401) {
      unauthorized += 1;
      opts.log('agent unauthorized', { attempt: unauthorized, maxUnauthorized });
      if (unauthorized >= maxUnauthorized) {
        throw new RevokedError(`token rejected ${unauthorized} times in a row`);
      }
    } else if (closeInfo?.code === CLOSE.CONFLICT && closeInfo.reason === 'protocol') {
      throw new ProtocolMismatchError('server rejected the agent protocol version');
    } else if (sessionOk) {
      unauthorized = 0;
      backoff = min;
    }

    if (signal?.aborted) return;

    const wait = nextBackoff(backoff, min, max);
    opts.log('reconnecting', { inMs: Math.round(wait) });
    await sleep(wait, signal);
    backoff = wait;
  }
}
