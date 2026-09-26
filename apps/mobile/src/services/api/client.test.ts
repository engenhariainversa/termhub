import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, fromB64url, fromUtf8, utf8 } from '../crypto/encoding';
import { SoftwareDeviceKey } from '../key/software';
import type { VaultKey } from '../vault';
import { createHttpMobileApi } from './client';
import type { Transport } from './transport';
import { socketWake } from './wake';

function scripted(answers: Array<{ status: number; headers?: Record<string, string>; body?: unknown; text?: string }>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  const transport: Transport = {
    fetch: async (req) => {
      calls.push(req);
      const a = answers.shift()!;
      return {
        status: a.status,
        headers: { date: new Date(NOW * 1000).toUTCString(), ...(a.headers ?? {}) },
        text: a.text ?? JSON.stringify(a.body),
      };
    },
    connect: () => {
      throw new Error('not in this test');
    },
  };
  return { transport, calls };
}

/** A transport whose `fetch` never resolves on its own: the test drives exactly when each
 * request's response arrives, by index, so a renewal race can be staged deterministically
 * instead of relying on incidental microtask ordering. */
function deferredTransport() {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  const resolvers: Array<(r: { status: number; headers: Record<string, string>; text: string }) => void> = [];
  const transport: Transport = {
    fetch: (req) =>
      new Promise((resolve) => {
        calls.push(req);
        resolvers.push(resolve);
      }),
    connect: () => {
      throw new Error('not in this test');
    },
  };
  const respond = (index: number, answer: { status: number; headers?: Record<string, string>; body?: unknown }) => {
    const resolve = resolvers[index];
    if (!resolve) throw new Error(`no fetch call at index ${index} yet`);
    resolve({ status: answer.status, headers: { date: new Date(NOW * 1000).toUTCString(), ...(answer.headers ?? {}) }, text: JSON.stringify(answer.body) });
  };
  return { transport, calls, respond };
}

const tick = () => new Promise<void>((resolve) => setImmediate(() => resolve()));
/** Polls `cond` a few ticks at a time — used to wait for async work (proof signing, ...) to reach
 * `deferredTransport`'s `fetch` before the test decides which response to release next. */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  if (!cond()) throw new Error('condition never became true');
}

const NOW = 1_800_000_000;
// Any vault slot works under the fake secure store; `key.create()` below seeds it.
const key = new SoftwareDeviceKey('pin.salt' as VaultKey);

beforeAll(async () => {
  await key.create();
});

const make = (t: Transport, onTokenExpired = jest.fn(async () => null as string | null)) =>
  createHttpMobileApi({ transport: t, baseUrl: 'https://termhub.dev', app: 'ios/0.1.0+1', key, onTokenExpired, now: () => NOW * 1000 });

const dpopPayload = (dpop: string) => JSON.parse(fromUtf8(fromB64url(dpop.split('.')[1]!))) as Record<string, unknown>;

it('sends the app header, bearer and a DPoP proof bound to method, canonical url and token hash', async () => {
  const { transport, calls } = scripted([{ status: 200, body: { projects: [] } }]);
  const api = make(transport);
  await api.chatProjects({ accessToken: 'tok' });
  expect(calls[0]!.headers['X-Termhub-App']).toBe('ios/0.1.0+1');
  expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
  const payload = dpopPayload(calls[0]!.headers.DPoP!);
  expect(payload).toMatchObject({ htm: 'GET', htu: 'https://termhub.dev/api/m/v1/chat/projects', ath: b64url(sha256(utf8('tok'))) });
  expect(calls[0]!.url).toBe('https://termhub.dev/api/m/v1/chat/projects');
});

it('corrects iat by the skew learned from the Date header', async () => {
  const { transport, calls } = scripted([
    { status: 200, headers: { date: new Date((NOW + 180) * 1000).toUTCString() }, body: { projects: [] } },
    { status: 200, headers: { date: new Date((NOW + 180) * 1000).toUTCString() }, body: { projects: [] } },
    { status: 200, body: { projects: [] } },
  ]);
  const api = make(transport);
  await api.chatProjects({ accessToken: 'tok' });
  await api.chatProjects({ accessToken: 'tok' });
  const second = dpopPayload(calls[1]!.headers.DPoP!);
  expect(second.iat).toBe(NOW + 180);
  expect(api.skewSeconds).toBe(180);
  // The latest response wins: a later reply carrying the device's own (unskewed) time brings the
  // estimate back down, rather than being pinned to the largest correction ever observed.
  await api.chatProjects({ accessToken: 'tok' });
  expect(api.skewSeconds).toBe(0);
});

it('renews once on TOKEN_EXPIRED and retries with the new token; a second 401 surfaces', async () => {
  const { transport, calls } = scripted([
    { status: 401, body: { error: 'x', code: 'TOKEN_EXPIRED' } },
    { status: 200, body: { projects: [] } },
  ]);
  const renew = jest.fn(async () => 'tok2');
  await make(transport, renew).chatProjects({ accessToken: 'tok' });
  expect(renew).toHaveBeenCalledTimes(1);
  expect(calls[1]!.headers.Authorization).toBe('Bearer tok2');
});

it('only TOKEN_EXPIRED triggers renewal: DEVICE_REVOKED, PROOF_REPLAYED, PROOF_INVALID and APP_TOO_OLD surface untouched', async () => {
  for (const [status, code] of [
    [401, 'DEVICE_REVOKED'],
    [401, 'PROOF_REPLAYED'],
    [401, 'PROOF_INVALID'],
    [426, 'APP_TOO_OLD'],
  ] as const) {
    const renew = jest.fn(async () => 'tok2');
    const { transport } = scripted([{ status, body: { error: 'x', code } }]);
    await expect(make(transport, renew).chatProjects({ accessToken: 'tok' })).rejects.toMatchObject({ status, code });
    expect(renew).not.toHaveBeenCalled();
  }
});

it('refuses a body that does not match the contract', async () => {
  const { transport } = scripted([{ status: 200, body: { nope: 1 } }]);
  await expect(make(transport).chatProjects({ accessToken: 'tok' })).rejects.toMatchObject({ status: 502, code: 'BAD_RESPONSE' });
});

it('refuses a non-JSON 2xx body as BAD_RESPONSE instead of surfacing the raw parse error', async () => {
  const { transport } = scripted([{ status: 200, text: '<html>' }]);
  await expect(make(transport).chatProjects({ accessToken: 'tok' })).rejects.toMatchObject({ status: 502, code: 'BAD_RESPONSE' });
});

it('a second 401 on the retry surfaces without a second renew', async () => {
  const { transport } = scripted([
    { status: 401, body: { error: 'x', code: 'TOKEN_EXPIRED' } },
    { status: 401, body: { error: 'y', code: 'TOKEN_EXPIRED' } },
  ]);
  const renew = jest.fn(async () => 'tok2');
  await expect(make(transport, renew).chatProjects({ accessToken: 'tok' })).rejects.toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' });
  expect(renew).toHaveBeenCalledTimes(1);
});

it('renewer returns null: the original TOKEN_EXPIRED error surfaces', async () => {
  const { transport } = scripted([{ status: 401, body: { error: 'x', code: 'TOKEN_EXPIRED' } }]);
  const renew = jest.fn(async () => null as string | null);
  await expect(make(transport, renew).chatProjects({ accessToken: 'tok' })).rejects.toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' });
  expect(renew).toHaveBeenCalledTimes(1);
});

it('two parallel calls that both fail with TOKEN_EXPIRED renew only once, even when the second call\'s 401 arrives after the first has already renewed and cleared the in-flight renewal', async () => {
  const { transport, calls, respond } = deferredTransport();
  const renew = jest.fn(async () => 'tok2');
  const api = make(transport, renew);

  const p1 = api.chatProjects({ accessToken: 'tok' });
  const p2 = api.chatProjects({ accessToken: 'tok' });

  // Both calls' first attempts are in flight, both still holding the stale token.
  await waitFor(() => calls.length === 2);

  // A's attempt fails and its whole renew-then-retry cycle completes, clearing the single-flight.
  respond(0, { status: 401, body: { error: 'x', code: 'TOKEN_EXPIRED' } });
  await waitFor(() => calls.length === 3);
  respond(2, { status: 200, body: { projects: [] } });
  await p1;

  // Only now does B's 401 get answered — `renewing` is already back to null.
  respond(1, { status: 401, body: { error: 'x', code: 'TOKEN_EXPIRED' } });
  await waitFor(() => calls.length === 4);
  respond(3, { status: 200, body: { projects: [] } });
  await p2;

  expect(renew).toHaveBeenCalledTimes(1);
  expect(calls[2]!.headers.Authorization).toBe('Bearer tok2');
  expect(calls[3]!.headers.Authorization).toBe('Bearer tok2');
});

it('forgetTokens drops the renewed token: a later TOKEN_EXPIRED renews again instead of reusing it', async () => {
  const { transport, calls } = scripted([
    { status: 401, body: { error: 'x', code: 'TOKEN_EXPIRED' } },
    { status: 200, body: { projects: [] } },
    { status: 401, body: { error: 'x', code: 'TOKEN_EXPIRED' } },
    { status: 200, body: { projects: [] } },
  ]);
  const renew = jest.fn<Promise<string | null>, []>().mockResolvedValueOnce('tok2').mockResolvedValueOnce('tok3');
  const api = make(transport, renew);
  await api.chatProjects({ accessToken: 'tok' });
  api.forgetTokens();
  await api.chatProjects({ accessToken: 'tok' });
  expect(renew).toHaveBeenCalledTimes(2);
  expect(calls[3]!.headers.Authorization).toBe('Bearer tok3');
});

it('activate and token carry no ath; token carries chal', async () => {
  const { transport, calls } = scripted([
    { status: 200, body: { device_id: 'd1', pin_secret: 'ps', access_token: 'at1', expires_in: 900 } },
    { status: 200, body: { access_token: 'at2', expires_in: 900 } },
  ]);
  const api = make(transport);

  await api.activate({ request_id: 'r1', request_secret: 's1' });
  const activatePayload = dpopPayload(calls[0]!.headers.DPoP!);
  expect(activatePayload.ath).toBeUndefined();
  expect(activatePayload.chal).toBeUndefined();
  expect(calls[0]!.headers.Authorization).toBeUndefined();

  await api.token({ device_id: 'd1', challenge: 'chal123', pin_proof: 'proof123' });
  const tokenPayload = dpopPayload(calls[1]!.headers.DPoP!);
  expect(tokenPayload.ath).toBeUndefined();
  expect(tokenPayload.chal).toBe('chal123');
  expect(calls[1]!.headers.Authorization).toBeUndefined();
});

describe('events()', () => {
  function connectableTransport() {
    const connects: Array<{ url: string; headers: Record<string, string> }> = [];
    let handlers: import('./transport').TransportSocketHandlers | undefined;
    const close = jest.fn();
    const transport: Transport = {
      fetch: () => {
        throw new Error('not in this test');
      },
      connect: (url, headers, h) => {
        connects.push({ url, headers });
        handlers = h;
        return { close };
      },
    };
    return { transport, connects, close, handlers: () => handlers! };
  }

  const hello = (server_time: string) => JSON.stringify({ type: 'hello', protocol: 1, server_time });

  it('connects to the ws url derived from baseUrl, with Authorization and a DPoP proof for GET /ws/m/chat carrying ath', async () => {
    const { transport, connects } = connectableTransport();
    const api = make(transport);
    const close = api.events({ accessToken: 'tok' }, { onEvent: jest.fn(), onReconnect: jest.fn(), onClose: jest.fn() });
    await waitFor(() => connects.length > 0);

    expect(connects[0]!.url).toBe('wss://termhub.dev/ws/m/chat?v=1');
    expect(connects[0]!.headers.Authorization).toBe('Bearer tok');
    const payload = dpopPayload(connects[0]!.headers.DPoP!);
    expect(payload).toMatchObject({ htm: 'GET', htu: 'https://termhub.dev/ws/m/chat', ath: b64url(sha256(utf8('tok'))) });
    close();
  });

  it("feeds hello.server_time into the client's skew, delivers later frames, and passes onReconnect/onClose through", async () => {
    const { transport, connects, handlers } = connectableTransport();
    const api = make(transport);
    const onEvent = jest.fn();
    const onReconnect = jest.fn();
    const onClose = jest.fn();
    const close = api.events({ accessToken: 'tok' }, { onEvent, onReconnect, onClose });
    await waitFor(() => connects.length > 0);

    handlers().onOpen();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    handlers().onMessage(hello(new Date((NOW + 42) * 1000).toISOString()));
    expect(api.skewSeconds).toBe(42);

    handlers().onMessage(
      JSON.stringify({
        type: 'message',
        user_id: 'u1',
        conversation_id: 'c1',
        message: { id: 'm1', conversation_id: 'c1', role: 'assistant', text: 'oi', usage: null, error_code: null, created_at: '2026-09-24T00:00:00.000Z' },
      }),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]![0]).toMatchObject({ type: 'message' });

    handlers().onClose(4401);
    expect(onClose).toHaveBeenCalledWith(4401, true);

    close();
  });

  it('reads the current token from an auth factory on every connect', async () => {
    const { transport, connects, handlers } = connectableTransport();
    const api = make(transport);
    let token = 'tok-1';
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const close = api.events(() => ({ accessToken: token }), { onEvent: jest.fn(), onReconnect: jest.fn(), onClose: jest.fn() });
      await waitFor(() => connects.length > 0);
      expect(connects[0]!.headers.Authorization).toBe('Bearer tok-1');

      token = 'tok-2';
      handlers().onClose(1006);
      await jest.advanceTimersByTimeAsync(1000);
      await waitFor(() => connects.length > 1);
      expect(connects[1]!.headers.Authorization).toBe('Bearer tok-2');
      close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a 1008 close renews the token once before the next attempt, which carries the new bearer', async () => {
    const { transport, connects, handlers } = connectableTransport();
    const onTokenExpired = jest.fn(async () => 'fresh' as string | null);
    const api = make(transport, onTokenExpired);
    const onClose = jest.fn();
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const close = api.events({ accessToken: 'stale' }, { onEvent: jest.fn(), onReconnect: jest.fn(), onClose });
      await waitFor(() => connects.length > 0);

      handlers().onClose(1008);
      expect(onClose).toHaveBeenCalledWith(1008, false);
      await jest.advanceTimersByTimeAsync(1000);
      await waitFor(() => connects.length > 1);
      expect(onTokenExpired).toHaveBeenCalledTimes(1);
      expect(connects[1]!.headers.Authorization).toBe('Bearer fresh');
      close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a 1008 close with no renewal (locked) keeps backing off and never reports a final close', async () => {
    const { transport, connects, handlers } = connectableTransport();
    const onTokenExpired = jest.fn(async () => null as string | null);
    const api = make(transport, onTokenExpired);
    const onClose = jest.fn();
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const close = api.events({ accessToken: 'stale' }, { onEvent: jest.fn(), onReconnect: jest.fn(), onClose });
      await waitFor(() => connects.length > 0);
      handlers().onClose(1008);
      await jest.advanceTimersByTimeAsync(1000);
      await waitFor(() => connects.length > 1);
      expect(onTokenExpired).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalledWith(expect.anything(), true);
      close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a close before the socket ever opened (a refused upgrade) renews the token once before the next attempt', async () => {
    const { transport, connects, handlers } = connectableTransport();
    const onTokenExpired = jest.fn(async () => 'fresh' as string | null);
    const api = make(transport, onTokenExpired);
    const onClose = jest.fn();
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const close = api.events({ accessToken: 'stale' }, { onEvent: jest.fn(), onReconnect: jest.fn(), onClose });
      await waitFor(() => connects.length > 0);

      handlers().onClose(1006); // never opened: the server answered the upgrade with a 401
      expect(onClose).toHaveBeenCalledWith(1006, false);
      await jest.advanceTimersByTimeAsync(1000);
      await waitFor(() => connects.length > 1);
      expect(onTokenExpired).toHaveBeenCalledTimes(1);
      expect(connects[1]!.headers.Authorization).toBe('Bearer fresh');
      close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a refused upgrade with a fresh token only backs off: no renewal', async () => {
    const { transport, connects, handlers } = connectableTransport();
    const onTokenExpired = jest.fn(async () => 'fresh' as string | null);
    const api = createHttpMobileApi({
      transport,
      baseUrl: 'https://termhub.dev',
      app: 'ios/0.1.0+1',
      key,
      onTokenExpired,
      now: () => NOW * 1000,
      tokenStale: () => false,
    });
    const onClose = jest.fn();
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const close = api.events({ accessToken: 'stale' }, { onEvent: jest.fn(), onReconnect: jest.fn(), onClose });
      await waitFor(() => connects.length > 0);

      handlers().onClose(1006); // never opened: the server answered the upgrade with a 401
      expect(onClose).toHaveBeenCalledWith(1006, false);
      await jest.advanceTimersByTimeAsync(1000);
      await waitFor(() => connects.length > 1);
      expect(onTokenExpired).not.toHaveBeenCalled();
      expect(connects[1]!.headers.Authorization).toBe('Bearer stale');
      close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a refused upgrade with a stale token renews before the next attempt', async () => {
    const { transport, connects, handlers } = connectableTransport();
    const onTokenExpired = jest.fn(async () => 'fresh' as string | null);
    const api = createHttpMobileApi({
      transport,
      baseUrl: 'https://termhub.dev',
      app: 'ios/0.1.0+1',
      key,
      onTokenExpired,
      now: () => NOW * 1000,
      tokenStale: () => true,
    });
    const onClose = jest.fn();
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const close = api.events({ accessToken: 'stale' }, { onEvent: jest.fn(), onReconnect: jest.fn(), onClose });
      await waitFor(() => connects.length > 0);

      handlers().onClose(1006); // never opened: the server answered the upgrade with a 401
      expect(onClose).toHaveBeenCalledWith(1006, false);
      await jest.advanceTimersByTimeAsync(1000);
      await waitFor(() => connects.length > 1);
      expect(onTokenExpired).toHaveBeenCalledTimes(1);
      expect(connects[1]!.headers.Authorization).toBe('Bearer fresh');
      close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a 1008 close with a fresh token only backs off: no renewal', async () => {
    const { transport, connects, handlers } = connectableTransport();
    const onTokenExpired = jest.fn(async () => 'fresh' as string | null);
    const api = createHttpMobileApi({
      transport,
      baseUrl: 'https://termhub.dev',
      app: 'ios/0.1.0+1',
      key,
      onTokenExpired,
      now: () => NOW * 1000,
      tokenStale: () => false,
    });
    const onClose = jest.fn();
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const close = api.events({ accessToken: 'stale' }, { onEvent: jest.fn(), onReconnect: jest.fn(), onClose });
      await waitFor(() => connects.length > 0);

      handlers().onClose(1008);
      expect(onClose).toHaveBeenCalledWith(1008, false);
      await jest.advanceTimersByTimeAsync(1000);
      await waitFor(() => connects.length > 1);
      expect(onTokenExpired).not.toHaveBeenCalled();
      expect(connects[1]!.headers.Authorization).toBe('Bearer stale');
      close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a 1008 close with a stale token renews once before the next attempt, which carries the new bearer', async () => {
    const { transport, connects, handlers } = connectableTransport();
    const onTokenExpired = jest.fn(async () => 'fresh' as string | null);
    const api = createHttpMobileApi({
      transport,
      baseUrl: 'https://termhub.dev',
      app: 'ios/0.1.0+1',
      key,
      onTokenExpired,
      now: () => NOW * 1000,
      tokenStale: () => true,
    });
    const onClose = jest.fn();
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const close = api.events({ accessToken: 'stale' }, { onEvent: jest.fn(), onReconnect: jest.fn(), onClose });
      await waitFor(() => connects.length > 0);

      handlers().onClose(1008);
      expect(onClose).toHaveBeenCalledWith(1008, false);
      await jest.advanceTimersByTimeAsync(1000);
      await waitFor(() => connects.length > 1);
      expect(onTokenExpired).toHaveBeenCalledTimes(1);
      expect(connects[1]!.headers.Authorization).toBe('Bearer fresh');
      close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a close after the socket opened does not renew the token', async () => {
    const { transport, connects, handlers } = connectableTransport();
    const onTokenExpired = jest.fn(async () => 'fresh' as string | null);
    const api = make(transport, onTokenExpired);
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const close = api.events({ accessToken: 'tok' }, { onEvent: jest.fn(), onReconnect: jest.fn(), onClose: jest.fn() });
      await waitFor(() => connects.length > 0);
      handlers().onOpen();
      handlers().onClose(1006);
      await jest.advanceTimersByTimeAsync(1000);
      await waitFor(() => connects.length > 1);
      expect(onTokenExpired).not.toHaveBeenCalled();
      expect(connects[1]!.headers.Authorization).toBe('Bearer tok');
      close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('refused upgrades with no renewal (locked) renew once per attempt and keep backing off', async () => {
    const { transport, connects, handlers } = connectableTransport();
    const onTokenExpired = jest.fn(async () => null as string | null);
    const api = make(transport, onTokenExpired);
    const onClose = jest.fn();
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const close = api.events({ accessToken: 'stale' }, { onEvent: jest.fn(), onReconnect: jest.fn(), onClose });
      await waitFor(() => connects.length > 0);
      handlers().onClose(1006);
      await jest.advanceTimersByTimeAsync(1000);
      await waitFor(() => connects.length > 1);
      handlers().onClose(1006);
      await jest.advanceTimersByTimeAsync(2000);
      await waitFor(() => connects.length > 2);
      expect(onTokenExpired).toHaveBeenCalledTimes(2);
      expect(connects[2]!.headers.Authorization).toBe('Bearer stale');
      expect(onClose).not.toHaveBeenCalledWith(expect.anything(), true);
      close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('the foreground option reaches the socket: a socketWake while closed reconnects at once, without waiting out the backoff', async () => {
    const { transport, connects, handlers } = connectableTransport();
    const api = createHttpMobileApi({
      transport,
      baseUrl: 'https://termhub.dev',
      app: 'ios/0.1.0+1',
      key,
      onTokenExpired: async () => null,
      now: () => NOW * 1000,
      backoff: { min: 60_000, max: 60_000 },
      foreground: { subscribe: socketWake.subscribe },
    });
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const close = api.events({ accessToken: 'tok' }, { onEvent: jest.fn(), onReconnect: jest.fn(), onClose: jest.fn() });
      await waitFor(() => connects.length > 0);
      handlers().onClose(1006);
      await jest.advanceTimersByTimeAsync(1000);
      expect(connects).toHaveLength(1); // still backing off (60 s)

      socketWake.emit();
      await waitFor(() => connects.length > 1);
      expect(connects).toHaveLength(2);
      close();
      socketWake.emit(); // closed: the subscription is gone
      await tick();
      expect(connects).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
