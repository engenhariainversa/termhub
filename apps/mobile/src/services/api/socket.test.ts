import { createChatSocket } from './socket';
import type { Transport, TransportSocketHandlers } from './transport';

type Connection = { url: string; headers: Record<string, string>; handlers: TransportSocketHandlers; close: jest.Mock };

/** Captures every `connect()` call instead of simulating a real socket: tests drive `onOpen`,
 * `onMessage` and `onClose` by hand, exactly as the design brief's fake transport does.
 *
 * `close()` mirrors a real `WebSocket`: it always fires that same connection's own `onclose`
 * again, later and asynchronously — even when the app itself initiated the close — so tests can
 * verify `socket.ts` ignores that stale echo instead of acting on it a second time. */
function fakeTransport() {
  const connections: Connection[] = [];
  const transport: Transport = {
    fetch: () => {
      throw new Error('socket tests never call fetch');
    },
    upload: () => {
      throw new Error('socket tests never call upload');
    },
    connect: (url, headers, handlers) => {
      const close = jest.fn(() => {
        setTimeout(() => handlers.onClose(1005), 0);
      });
      connections.push({ url, headers, handlers, close });
      return { close };
    },
  };
  return { transport, connections };
}

const hello = (server_time: string) => JSON.stringify({ type: 'hello', protocol: 1, server_time });
const messageEvent = (id: string) =>
  JSON.stringify({
    type: 'message',
    user_id: 'u1',
    conversation_id: 'c1',
    message: { id, conversation_id: 'c1', role: 'assistant', text: 'oi', usage: null, error_code: null, created_at: '2026-09-24T00:00:00.000Z' },
  });

/** Flushes the microtask queue (`await o.headers()` inside `open()`) without advancing fake
 * timers — timers only fake `setTimeout`/`setInterval`, never promise microtasks. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function harness(overrides: Partial<Parameters<typeof createChatSocket>[0]> = {}) {
  const { transport, connections } = fakeTransport();
  const headers = jest.fn(async () => ({ Authorization: 'Bearer tok', DPoP: 'proof' }));
  const onEvent = jest.fn();
  const onReconnect = jest.fn();
  const onClose = jest.fn();
  const onServerTime = jest.fn();
  let foregroundListener: (() => void) | null = null;
  const foreground = {
    subscribe: jest.fn((fn: () => void) => {
      foregroundListener = fn;
      return () => {
        foregroundListener = null;
      };
    }),
  };

  const socket = createChatSocket({
    transport,
    url: 'wss://termhub.dev/ws/m/chat?v=1',
    headers,
    onEvent,
    onReconnect,
    onClose,
    onServerTime,
    backoff: { min: 1000, max: 30000 },
    foreground,
    ...overrides,
  });

  return { socket, connections, headers, onEvent, onReconnect, onClose, onServerTime, emitForeground: () => foregroundListener?.() };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('feeds hello.server_time to onServerTime and does not treat it as a chat event', async () => {
  const { connections, onServerTime, onEvent, socket } = harness();
  await flush();
  connections[0]!.handlers.onOpen();
  connections[0]!.handlers.onMessage(hello('2026-09-24T12:00:00.000Z'));

  expect(onServerTime).toHaveBeenCalledWith('2026-09-24T12:00:00.000Z');
  expect(onEvent).not.toHaveBeenCalled();
  socket.close();
});

it('delivers every later frame parsed with chatEventSchema', async () => {
  const { connections, onEvent, socket } = harness();
  await flush();
  connections[0]!.handlers.onOpen();
  connections[0]!.handlers.onMessage(hello('2026-09-24T12:00:00.000Z'));
  connections[0]!.handlers.onMessage(messageEvent('m1'));

  expect(onEvent).toHaveBeenCalledTimes(1);
  expect(onEvent.mock.calls[0]![0]).toMatchObject({ type: 'message', message: { id: 'm1' } });
  socket.close();
});

it('drops an unparsable frame silently instead of failing', async () => {
  const { connections, onEvent, socket } = harness();
  await flush();
  connections[0]!.handlers.onOpen();
  connections[0]!.handlers.onMessage(hello('2026-09-24T12:00:00.000Z'));

  expect(() => connections[0]!.handlers.onMessage('not json')).not.toThrow();
  expect(() => connections[0]!.handlers.onMessage(JSON.stringify({ type: 'not-a-real-type' }))).not.toThrow();
  expect(onEvent).not.toHaveBeenCalled();

  // the connection survives: a good frame right after is still delivered
  connections[0]!.handlers.onMessage(messageEvent('m1'));
  expect(onEvent).toHaveBeenCalledTimes(1);
  socket.close();
});

it('closes and reconnects when the first frame is not hello', async () => {
  const { connections, onEvent, onServerTime, socket } = harness();
  await flush();
  connections[0]!.handlers.onOpen();
  connections[0]!.handlers.onMessage(messageEvent('m1'));

  expect(connections[0]!.close).toHaveBeenCalledTimes(1);
  expect(onEvent).not.toHaveBeenCalled();
  expect(onServerTime).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(1000);
  expect(connections).toHaveLength(2);
  socket.close();
});

it('fires onReconnect on every open', async () => {
  const { connections, onReconnect, socket } = harness();
  await flush();
  connections[0]!.handlers.onOpen();
  expect(onReconnect).toHaveBeenCalledTimes(1);

  connections[0]!.handlers.onClose(1006);
  await jest.advanceTimersByTimeAsync(1000);
  expect(connections).toHaveLength(2);
  connections[1]!.handlers.onOpen();
  expect(onReconnect).toHaveBeenCalledTimes(2);
  socket.close();
});

it('reconnects a 1006 close with doubling backoff, capped at max, reset after a successful open', async () => {
  const { connections, headers, socket } = harness({ backoff: { min: 1000, max: 3000 } });
  await flush();

  // first connection never opens successfully
  connections[0]!.handlers.onClose(1006);
  await jest.advanceTimersByTimeAsync(999);
  expect(connections).toHaveLength(1); // not yet
  await jest.advanceTimersByTimeAsync(1);
  expect(connections).toHaveLength(2); // after `min`

  connections[1]!.handlers.onClose(1006);
  await jest.advanceTimersByTimeAsync(1999);
  expect(connections).toHaveLength(2); // not yet (min*2)
  await jest.advanceTimersByTimeAsync(1);
  expect(connections).toHaveLength(3); // after min*2

  connections[2]!.handlers.onClose(1006);
  await jest.advanceTimersByTimeAsync(3000); // would be min*4 = 4000 uncapped, but max is 3000
  expect(connections).toHaveLength(4);

  // a successful open resets the backoff
  await flush();
  connections[3]!.handlers.onOpen();
  connections[3]!.handlers.onClose(1006);
  await jest.advanceTimersByTimeAsync(999);
  expect(connections).toHaveLength(4);
  await jest.advanceTimersByTimeAsync(1);
  expect(connections).toHaveLength(5); // back to `min`

  expect(headers).toHaveBeenCalledTimes(5); // fresh headers (and so a fresh proof) every attempt
  socket.close();
});

it('4400 closes with final=true and never reconnects', async () => {
  const { connections, onClose, socket } = harness();
  await flush();
  connections[0]!.handlers.onClose(4400);

  expect(onClose).toHaveBeenCalledWith(4400, true);
  await jest.advanceTimersByTimeAsync(60000);
  expect(connections).toHaveLength(1);
  socket.close();
});

it('4401 closes with final=true and never reconnects', async () => {
  const { connections, onClose, socket } = harness();
  await flush();
  connections[0]!.handlers.onClose(4401);

  expect(onClose).toHaveBeenCalledWith(4401, true);
  await jest.advanceTimersByTimeAsync(60000);
  expect(connections).toHaveLength(1);
  socket.close();
});

it('a 1008 close (expired token or bad proof) is not final: the next attempt builds fresh headers', async () => {
  let n = 0;
  const headers = jest.fn(async () => ({ Authorization: `Bearer tok-${++n}`, DPoP: `proof-${n}` }));
  const { connections, onClose, socket } = harness({ headers });
  await flush();
  connections[0]!.handlers.onClose(1008);

  expect(onClose).toHaveBeenCalledWith(1008, false);
  await jest.advanceTimersByTimeAsync(1000);
  expect(headers).toHaveBeenCalledTimes(2);
  expect(connections).toHaveLength(2);
  expect(connections[1]!.headers).toEqual({ Authorization: 'Bearer tok-2', DPoP: 'proof-2' });
  socket.close();
});

it('a close before the connection ever opened reports onRefused, then onClose, and reconnects', async () => {
  // The real server refuses a bad upgrade with an HTTP status (401/403) before switching
  // protocols; React Native reports that as a 1006 close with no open.
  const onRefused = jest.fn();
  const { connections, onClose, socket } = harness({ onRefused });
  await flush();
  connections[0]!.handlers.onClose(1006);

  expect(onRefused).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledWith(1006, false);
  expect(onRefused.mock.invocationCallOrder[0]!).toBeLessThan(onClose.mock.invocationCallOrder[0]!);
  await jest.advanceTimersByTimeAsync(1000);
  expect(connections).toHaveLength(2);
  socket.close();
});

it('a close after the connection opened is not a refusal', async () => {
  const onRefused = jest.fn();
  const { connections, onClose, socket } = harness({ onRefused });
  await flush();
  connections[0]!.handlers.onOpen();
  connections[0]!.handlers.onClose(1006);

  expect(onClose).toHaveBeenCalledWith(1006, false);
  expect(onRefused).not.toHaveBeenCalled();
  socket.close();
});

it('a final close before open (4400, 4401) is not a refusal either', async () => {
  const onRefused = jest.fn();
  const { connections, onClose, socket } = harness({ onRefused });
  await flush();
  connections[0]!.handlers.onClose(4401);

  expect(onClose).toHaveBeenCalledWith(4401, true);
  expect(onRefused).not.toHaveBeenCalled();
  socket.close();
});

it('a non-terminal close reports onClose(code, false) before scheduling a reconnect', async () => {
  const { connections, onClose, socket } = harness();
  await flush();
  connections[0]!.handlers.onClose(1006);

  expect(onClose).toHaveBeenCalledWith(1006, false);
  socket.close();
});

it('reconnects at once on a foreground signal while closed', async () => {
  const { connections, emitForeground, socket } = harness();
  await flush();
  connections[0]!.handlers.onClose(1006);
  expect(connections).toHaveLength(1);

  emitForeground();
  await flush();
  expect(connections).toHaveLength(2); // no need to wait for the backoff timer

  socket.close();
});

it('a foreground signal while already connected is a no-op', async () => {
  const { connections, emitForeground, socket } = harness();
  await flush();
  connections[0]!.handlers.onOpen();

  emitForeground();
  await flush();
  expect(connections).toHaveLength(1);
  socket.close();
});

it('close() stops everything: no reconnect timer survives it', async () => {
  const { connections, socket } = harness();
  await flush();
  connections[0]!.handlers.onClose(1006);
  expect(jest.getTimerCount()).toBeGreaterThan(0);

  socket.close();
  expect(jest.getTimerCount()).toBe(0);
  expect(connections[0]!.close).toHaveBeenCalledTimes(0); // already closed by the server

  await jest.advanceTimersByTimeAsync(60000);
  expect(connections).toHaveLength(1);
});

it('close() closes the live socket and unsubscribes from foreground', async () => {
  const { connections, socket, emitForeground } = harness();
  await flush();
  connections[0]!.handlers.onOpen();

  socket.close();
  expect(connections[0]!.close).toHaveBeenCalledTimes(1);

  emitForeground(); // the harness' listener ref was cleared by unsubscribe
  await flush();
  expect(connections).toHaveLength(1);
});

it('a stale close from a connection it abandoned itself never reaches the consumer, never double-reconnects, and never clobbers the connection that replaced it', async () => {
  const { connections, onClose, socket, emitForeground } = harness();
  await flush();
  connections[0]!.handlers.onOpen();
  // not hello: socket.ts abandons this connection itself (calls its `close()`, which — per
  // `fakeTransport` above — schedules a stale `onClose(1005)` on the very same handlers).
  connections[0]!.handlers.onMessage(messageEvent('m1'));
  expect(connections[0]!.close).toHaveBeenCalledTimes(1);

  // advancing past both the stale onClose(1005) (scheduled at 0ms) and the reconnect (at `min`)
  await jest.advanceTimersByTimeAsync(1000);

  expect(onClose).not.toHaveBeenCalled(); // the stale close never reaches the consumer
  expect(connections).toHaveLength(2); // exactly one reconnect, not two

  // the new connection is now live; the stale close from the abandoned one must not have nulled
  // it out — a foreground signal must find a live socket and stay a no-op (no third connection).
  connections[1]!.handlers.onOpen();
  emitForeground();
  await flush();
  expect(connections).toHaveLength(2);

  socket.close();
});

it('a headers() rejection schedules a reconnect instead of leaking an unhandled rejection', async () => {
  const { transport, connections } = fakeTransport();
  const onEvent = jest.fn();
  const onReconnect = jest.fn();
  const onClose = jest.fn();
  const onServerTime = jest.fn();
  let attempts = 0;
  const headers = jest.fn(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('key unavailable');
    return { Authorization: 'Bearer tok', DPoP: 'proof' };
  });

  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);

  const socket = createChatSocket({
    transport,
    url: 'wss://termhub.dev/ws/m/chat?v=1',
    headers,
    onEvent,
    onReconnect,
    onClose,
    onServerTime,
    backoff: { min: 1000, max: 30000 },
  });

  await flush();
  expect(connections).toHaveLength(0); // the first attempt's headers() rejected before connect()

  await jest.advanceTimersByTimeAsync(1000);
  expect(connections).toHaveLength(1); // the retried attempt connects

  await flush();
  process.off('unhandledRejection', onUnhandledRejection);
  expect(rejections).toEqual([]);

  socket.close();
});
