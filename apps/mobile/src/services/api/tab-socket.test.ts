import { createTabSocket } from './tab-socket';
import type { Transport, TransportSocketHandlers } from './transport';

type Connection = { url: string; headers: Record<string, string>; handlers: TransportSocketHandlers; close: jest.Mock };

/** Captures every `connect()`; `close()` echoes its own `onclose` later, as a real WebSocket does. */
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

const hello = JSON.stringify({ type: 'hello', protocol: 1, server_time: '2026-10-01T12:00:00.000Z', availability: 'ready' });
const items = (live: string) => JSON.stringify({ type: 'items', items: [{ kind: 'assistant', id: `a-${live}`, at: '', text: 'oi' }], live, mode: null });

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function harness(overrides: Partial<Parameters<typeof createTabSocket>[0]> = {}) {
  const { transport, connections } = fakeTransport();
  let cursor: string | null = 's1.10';
  let token = 'tok-1';
  const headers = jest.fn(async () => ({ Authorization: `Bearer ${token}`, DPoP: 'proof' }));
  const onFrame = jest.fn();
  const onClose = jest.fn();
  const onServerTime = jest.fn();
  const socket = createTabSocket({
    transport,
    url: (after) => `wss://termhub.dev/ws/m/tabs/t1?v=1${after ? `&after=${after}` : ''}`,
    headers,
    after: () => cursor,
    onFrame,
    onClose,
    onServerTime,
    backoff: { min: 1000, max: 30000 },
    ...overrides,
  });
  return {
    socket,
    connections,
    headers,
    onFrame,
    onClose,
    onServerTime,
    setCursor: (c: string | null) => (cursor = c),
    setToken: (t: string) => (token = t),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('opens from the cursor the store holds', async () => {
  const { connections, socket } = harness();
  await flush();
  expect(connections[0]!.url).toBe('wss://termhub.dev/ws/m/tabs/t1?v=1&after=s1.10');
  socket.close();
});

it('feeds hello.server_time to onServerTime and hands hello and later frames to onFrame', async () => {
  const { connections, onServerTime, onFrame, socket } = harness();
  await flush();
  connections[0]!.handlers.onOpen();
  connections[0]!.handlers.onMessage(hello);
  connections[0]!.handlers.onMessage(items('s1.20'));
  expect(onServerTime).toHaveBeenCalledWith('2026-10-01T12:00:00.000Z');
  expect(onFrame.mock.calls.map((c) => c[0].type)).toEqual(['hello', 'items']);
  socket.close();
});

it('drops a frame that does not parse and stays open', async () => {
  const { connections, onFrame, onClose, socket } = harness();
  await flush();
  connections[0]!.handlers.onOpen();
  connections[0]!.handlers.onMessage(hello);
  connections[0]!.handlers.onMessage('not json');
  connections[0]!.handlers.onMessage(JSON.stringify({ type: 'later' }));
  connections[0]!.handlers.onMessage(items('s1.30'));
  expect(onFrame.mock.calls.map((c) => c[0].type)).toEqual(['hello', 'items']);
  expect(connections[0]!.close).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  socket.close();
});

it('a first frame that is not hello is a broken connection: closed and retried', async () => {
  const { connections, onFrame, socket } = harness();
  await flush();
  connections[0]!.handlers.onOpen();
  connections[0]!.handlers.onMessage(items('s1.20'));
  expect(onFrame).not.toHaveBeenCalled();
  expect(connections[0]!.close).toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1000);
  expect(connections).toHaveLength(2);
  socket.close();
});

it.each([4400, 4401, 4403, 4404])('%i is final: no reconnect', async (code) => {
  const { connections, onClose, socket } = harness();
  await flush();
  connections[0]!.handlers.onOpen();
  connections[0]!.handlers.onClose(code);
  expect(onClose).toHaveBeenCalledWith(code, true);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(connections).toHaveLength(1);
  socket.close();
});

it('any other close reconnects with backoff, fresh headers and the cursor the store holds then', async () => {
  const { connections, onClose, headers, setCursor, setToken, socket } = harness();
  await flush();
  connections[0]!.handlers.onOpen();
  connections[0]!.handlers.onMessage(hello);
  setCursor('s1.50');
  setToken('tok-2');
  connections[0]!.handlers.onClose(1006);
  expect(onClose).toHaveBeenCalledWith(1006, false);
  await jest.advanceTimersByTimeAsync(999);
  expect(connections).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(connections).toHaveLength(2);
  expect(connections[1]!.url).toBe('wss://termhub.dev/ws/m/tabs/t1?v=1&after=s1.50');
  expect(connections[1]!.headers.Authorization).toBe('Bearer tok-2');
  expect(headers).toHaveBeenCalledTimes(2);

  // A second drop without an open in between waits twice as long.
  connections[1]!.handlers.onClose(1006);
  await jest.advanceTimersByTimeAsync(1999);
  expect(connections).toHaveLength(2);
  await jest.advanceTimersByTimeAsync(1);
  expect(connections).toHaveLength(3);
  socket.close();
});

it('no cursor: opens without after', async () => {
  const { connections, socket, setCursor } = harness();
  setCursor(null);
  await flush();
  // The cursor is read once the headers are ready, right before connecting.
  expect(connections[0]!.url).toBe('wss://termhub.dev/ws/m/tabs/t1?v=1');
  socket.close();
});

it('close() while headers() is in flight opens nothing', async () => {
  let release: (h: Record<string, string>) => void = () => undefined;
  const { connections, socket } = harness({ headers: () => new Promise((resolve) => (release = resolve)) });
  socket.close();
  release({ Authorization: 'Bearer x' });
  await flush();
  expect(connections).toHaveLength(0);
});

it('a refused upgrade (a close that never opened) is reported to onRefused before onClose', async () => {
  const order: string[] = [];
  const { connections, socket } = harness({ onRefused: () => order.push('refused'), onClose: (code) => order.push(`close:${code}`) });
  await flush();
  connections[0]!.handlers.onClose(1006);
  expect(order).toEqual(['refused', 'close:1006']);
  socket.close();
});

it('reconnects at once on the foreground signal while disconnected', async () => {
  let wake: (() => void) | null = null;
  const { connections, socket } = harness({ foreground: { subscribe: (fn) => ((wake = fn), () => (wake = null)) } });
  await flush();
  connections[0]!.handlers.onOpen();
  connections[0]!.handlers.onClose(1006);
  wake!();
  await flush();
  expect(connections).toHaveLength(2);
  socket.close();
  expect(wake).toBeNull();
});
