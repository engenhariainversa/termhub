import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { CLOSE, CONTROL_CHANNEL, MAX_FRAME, PROTOCOL_VERSION, decodeFrame, encodeFrame, proofMessage } from '@termhub/agent-protocol';
import type { AuthContext } from '../auth/index.js';
import { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { hashAgentToken } from './token.js';
import { AgentRegistry } from './registry.js';
import { registerAgentWs } from './ws.js';

const GOOD = 'thb_ag_' + 'a'.repeat(43);
const PAIRING = 'thb_ag_' + 'p'.repeat(43);
const deviceKeys = generateKeyPairSync('ed25519');
const devicePublic = deviceKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const machine = { id: 'm1', name: 'mini', type: 'agent' } as unknown as Machine;

function fakeLog(): FastifyBaseLogger {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => log),
    level: 'info',
  };
  return log as unknown as FastifyBaseLogger;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function shutdown(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** Control messages each socket received, collected from the start: the server's `challenge` can land
 *  before `open()` resolves and a listener attached after it would miss it. */
const inbox = new WeakMap<WebSocket, Record<string, unknown>[]>();

function open(url: string, headers?: Record<string, string>): Promise<{ ws?: WebSocket; statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const received: Record<string, unknown>[] = [];
    inbox.set(ws, received);
    ws.on('message', (data: Buffer) => received.push(JSON.parse(decodeFrame(data).payload.toString('utf8'))));
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout waiting for upgrade response'));
    }, 2000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      ws.terminate();
      resolve({ statusCode: res.statusCode });
    });
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ ws });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe('registerAgentWs', () => {
  let server: http.Server;
  let repos: {
    machines: {
      findByAgentTokenHash: ReturnType<typeof vi.fn>;
      findByPairingHash: ReturnType<typeof vi.fn>;
      completeAgentPairing: ReturnType<typeof vi.fn>;
      findDeviceKey: ReturnType<typeof vi.fn>;
      findById: ReturnType<typeof vi.fn>;
      touchAgent: ReturnType<typeof vi.fn>;
    };
  };
  let registry: AgentRegistry;
  let port: number;
  let log: FastifyBaseLogger;

  function start(opts: { helloTimeoutMs?: number } = {}) {
    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    log = fakeLog();
    registerAgentWs(router, {
      repos: repos as unknown as Repositories,
      log,
      registry,
      ...opts,
    });
    return listen(server).then((p) => (port = p));
  }

  beforeEach(() => {
    repos = {
      machines: {
        findByAgentTokenHash: vi.fn(async (h: string) => (h === hashAgentToken(GOOD) ? machine : undefined)),
        findByPairingHash: vi.fn(async (h: string) => (h === hashAgentToken(PAIRING) ? machine : undefined)),
        completeAgentPairing: vi.fn(async () => true),
        findDeviceKey: vi.fn(async (id: string) => (id === 'm1' ? { machine, publicKey: devicePublic } : undefined)),
        findById: vi.fn(async () => machine),
        touchAgent: vi.fn(async () => {}),
      },
    };
    registry = new AgentRegistry();
  });

  afterEach(async () => {
    if (server) await shutdown(server);
  });

  it('no Authorization header → 401', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`);
    expect(res.statusCode).toBe(401);
    expect(repos.machines.findByAgentTokenHash).not.toHaveBeenCalled();
  });

  it('bearer token that hashes to no machine → 401', async () => {
    await start();
    // Well-formed (matches AGENT_TOKEN_RE) but distinct from GOOD, so this actually exercises
    // the findByAgentTokenHash() miss path rather than the regex check above it.
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer thb_ag_${'b'.repeat(43)}` });
    expect(res.statusCode).toBe(401);
    expect(repos.machines.findByAgentTokenHash).toHaveBeenCalled();
  });

  it('valid token: upgrade succeeds, hello marks the machine online and touches it', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    expect(res.statusCode).toBeUndefined();
    const ws = res.ws!;
    const hello = {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      agent_version: '0.1.0',
      os: 'linux',
      arch: 'x64',
      hostname: 'box',
      tmux: true,
      tools: ['tmux'],
    };
    ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(hello)));

    await vi.waitFor(() => expect(registry.isOnline('m1')).toBe(true));
    await vi.waitFor(() =>
      expect(repos.machines.touchAgent).toHaveBeenCalledWith('m1', {
        version: '0.1.0',
        os: 'linux',
        capabilities: ['tmux'],
        lastSeenAt: expect.any(Date),
      }),
    );
    ws.terminate();
  });

  it('touches the machine again when the agent disconnects, so the last-seen time reflects when it left', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    const ws = res.ws!;
    const hello = {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      agent_version: '0.1.0',
      os: 'linux',
      arch: 'x64',
      hostname: 'box',
      tmux: true,
      tools: ['tmux'],
    };
    ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(hello)));
    await vi.waitFor(() => expect(repos.machines.touchAgent).toHaveBeenCalledTimes(1));

    ws.terminate();

    await vi.waitFor(() => expect(repos.machines.touchAgent).toHaveBeenCalledTimes(2));
    expect(repos.machines.touchAgent).toHaveBeenLastCalledWith('m1', { lastSeenAt: expect.any(Date) });
  });

  it('valid token but no hello within the timeout → closed 1008', async () => {
    await start({ helloTimeoutMs: 200 });
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    const ws = res.ws!;
    const closed = await waitClose(ws);
    expect(closed.code).toBe(1008);
  });

  it('hello with a newer protocol version → closed 4409 "protocol"', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    const ws = res.ws!;
    const hello = {
      type: 'hello',
      protocol: 99,
      agent_version: '0.1.0',
      os: 'linux',
      arch: 'x64',
      hostname: 'box',
      tmux: true,
      tools: [],
    };
    ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(hello)));
    const closed = await waitClose(ws);
    expect(closed.code).toBe(CLOSE.CONFLICT);
    expect(closed.reason).toBe('protocol');
    expect(registry.isOnline('m1')).toBe(false);
  });

  const goodHello = {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    agent_version: '0.1.0',
    os: 'linux',
    arch: 'x64',
    hostname: 'box',
    tmux: true,
    tools: ['tmux'],
  };

  it('probe hello is answered with close 1000 "probe-ok" without attaching or touching', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    const ws = res.ws!;
    ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ ...goodHello, probe: true })));
    const closed = await waitClose(ws);
    expect(closed).toEqual({ code: 1000, reason: 'probe-ok' });
    expect(registry.isOnline('m1')).toBe(false);
    expect(repos.machines.touchAgent).not.toHaveBeenCalled();
  });

  it('a live attached connection survives a probe from the same token', async () => {
    await start();
    const live = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` })).ws!;
    const liveClosed = waitClose(live);
    live.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(goodHello)));
    await vi.waitFor(() => expect(registry.isOnline('m1')).toBe(true));

    const probe = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` })).ws!;
    probe.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ ...goodHello, probe: true })));
    expect(await waitClose(probe)).toEqual({ code: 1000, reason: 'probe-ok' });

    // The probe must not have replaced (4409) the real session.
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.isOnline('m1')).toBe(true);
    expect(live.readyState).toBe(WebSocket.OPEN);
    live.terminate();
    await liveClosed;
  });

  it('probe hello with a newer protocol version is still refused with 4409 "protocol"', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    const ws = res.ws!;
    ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ ...goodHello, protocol: 99, probe: true })));
    const closed = await waitClose(ws);
    expect(closed.code).toBe(CLOSE.CONFLICT);
    expect(closed.reason).toBe('protocol');
    expect(registry.isOnline('m1')).toBe(false);
  });

  it('an agent frame above MAX_FRAME (1 MiB) is refused by ws with 1009; one at the limit reaches the protocol layer', async () => {
    await start();
    // Both frames target an unknown channel, so a frame that *is* delivered ends in the
    // protocol layer's 1008 — which is how we tell "accepted by ws" from "1009 too big".
    const attempt = async (payloadBytes: number) => {
      const ws = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` })).ws!;
      ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(goodHello)));
      await vi.waitFor(() => expect(registry.isOnline('m1')).toBe(true));
      const closed = waitClose(ws);
      ws.send(encodeFrame(42, Buffer.alloc(payloadBytes, 0x20)));
      const info = await closed;
      await vi.waitFor(() => expect(registry.isOnline('m1')).toBe(false));
      return info.code;
    };
    expect(await attempt(MAX_FRAME - 4)).toBe(CLOSE.VIOLATION); // exactly 1 MiB on the wire: delivered
    expect(await attempt(MAX_FRAME - 3)).toBe(1009); // one byte more: ws "Max payload size exceeded"
  });

  it('connection closing while the initial touch() is still in flight leaves no dangling interval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      await start();
      const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
      const ws = res.ws!;

      // Hold the initial touchAgent() call pending so we can close the socket while it's
      // still in flight — the exact race the fix (registering conn.on('close', ...) before
      // the await) has to survive.
      let releaseTouch: (() => void) | undefined;
      const firstTouchCalled = new Promise<void>((resolve) => {
        repos.machines.touchAgent.mockImplementationOnce(() => {
          resolve();
          return new Promise<void>((r) => {
            releaseTouch = r;
          });
        });
      });

      const hello = {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        agent_version: '0.1.0',
        os: 'linux',
        arch: 'x64',
        hostname: 'box',
        tmux: true,
        tools: ['tmux'],
      };
      ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(hello)));
      await firstTouchCalled;

      const offline = new Promise<void>((resolve) => registry.once('offline', () => resolve()));
      ws.terminate();
      await offline; // server processed the close while the initial touch() was still pending

      releaseTouch?.(); // let the in-flight touch() resolve now that the connection is closed
      await vi.advanceTimersByTimeAsync(70_000); // past both the 20s heartbeat and 60s touch intervals

      // The initial hello touch (still pending when the socket closed) plus the touch-on-disconnect —
      // and no more: had an interval been left dangling, this would keep growing.
      expect(repos.machines.touchAgent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Observability: an agent that vanishes (the mac mini, 2026-09-19) left no trace on the server
  // side — neither why the socket closed nor whether it tried to come back and was refused.
  it('logs the close code and reason when an attached agent disconnects', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    const ws = res.ws!;
    const hello = { type: 'hello', protocol: PROTOCOL_VERSION, agent_version: '0.1.6', os: 'macos', arch: 'arm64', hostname: 'mini', tmux: true, tools: ['tmux'] };
    ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(hello)));
    await vi.waitFor(() => expect(registry.isOnline('m1')).toBe(true));

    const offline = new Promise<void>((resolve) => registry.once('offline', () => resolve()));
    ws.close(1001, 'going away');
    await offline;

    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ machineId: 'm1', code: 1001, reason: 'going away', connectedMs: expect.any(Number) }),
        'agent disconnected',
      ),
    );
  });

  it('logs a refused upgrade (unknown token) without the token itself', async () => {
    await start();
    const bad = `thb_ag_${'b'.repeat(43)}`;
    await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${bad}` });

    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unknown-token', ip: '127.0.0.1' }), 'agent upgrade rejected'));
    const calls = (log.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.stringify(c));
    expect(calls.join('\n')).not.toContain(bad);
  });

  it('logs a refused upgrade with a malformed or missing token', async () => {
    await start();
    await open(`ws://127.0.0.1:${port}/agent/ws`);
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'malformed-token' }), 'agent upgrade rejected'));
  });

  describe('pairing token and device key (TER-1017)', () => {
    /** The first control message the server sends, parsed. */
    const nextControl = async (ws: WebSocket): Promise<Record<string, unknown>> => {
      const received = inbox.get(ws)!;
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
      return received.shift()!;
    };

    it('a pairing dial trades the token for the key, answers paired and hangs up 1000 "paired"', async () => {
      await start();
      const ws = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${PAIRING}` })).ws!;
      const reply = nextControl(ws);
      const closed = waitClose(ws);
      ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ ...goodHello, probe: true, pair: { public_key: devicePublic } })));
      expect(await reply).toEqual({ type: 'paired', machine_id: 'm1', machine_name: 'mini' });
      expect(await closed).toEqual({ code: 1000, reason: 'paired' });
      expect(repos.machines.completeAgentPairing).toHaveBeenCalledWith('m1', hashAgentToken(PAIRING), devicePublic);
      expect(registry.isOnline('m1')).toBe(false);
    });

    it('a pairing token whose burn loses (used, expired, rotated) → 4401 "pairing"', async () => {
      repos.machines.completeAgentPairing.mockResolvedValueOnce(false);
      await start();
      const ws = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${PAIRING}` })).ws!;
      ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ ...goodHello, pair: { public_key: devicePublic } })));
      expect(await waitClose(ws)).toEqual({ code: CLOSE.UNAUTHORIZED, reason: 'pairing' });
    });

    it('an old agent dialing with a pairing token is told to update (4409 "protocol") and the token stays unused', async () => {
      await start();
      const ws = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${PAIRING}` })).ws!;
      ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(goodHello)));
      expect(await waitClose(ws)).toEqual({ code: CLOSE.CONFLICT, reason: 'protocol' });
      expect(repos.machines.completeAgentPairing).not.toHaveBeenCalled();
      expect(registry.isOnline('m1')).toBe(false);
    });

    it('a pairing hello with something other than an Ed25519 key is refused', async () => {
      await start();
      const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      const ws = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${PAIRING}` })).ws!;
      ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ ...goodHello, pair: { public_key: rsa.slice(0, 200) } })));
      expect((await waitClose(ws)).code).toBe(CLOSE.VIOLATION);
      expect(repos.machines.completeAgentPairing).not.toHaveBeenCalled();
    });

    const deviceDial = async (sigFor: (nonce: string, ts: number) => string, machineId = 'm1') => {
      const ws = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `TermhubDevice ${machineId}` })).ws!;
      const challenge = await nextControl(ws);
      expect(challenge.type).toBe('challenge');
      const ts = Date.now();
      ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ ...goodHello, proof: { machine_id: machineId, ts, sig: sigFor(challenge.nonce as string, ts) } })));
      return ws;
    };
    const goodSig = (nonce: string, ts: number) => sign(null, proofMessage(nonce, 'm1', ts), deviceKeys.privateKey).toString('base64');

    it('a device dial that signs the challenge attaches the machine', async () => {
      await start();
      const ws = await deviceDial(goodSig);
      await vi.waitFor(() => expect(registry.isOnline('m1')).toBe(true));
      expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'm1', credential: 'key' }), 'agent connected');
      ws.terminate();
    });

    it('a signature from another key → 4401 "proof", never attached', async () => {
      await start();
      const other = generateKeyPairSync('ed25519').privateKey;
      const ws = await deviceDial((nonce, ts) => sign(null, proofMessage(nonce, 'm1', ts), other).toString('base64'));
      expect(await waitClose(ws)).toEqual({ code: CLOSE.UNAUTHORIZED, reason: 'proof' });
      expect(registry.isOnline('m1')).toBe(false);
    });

    it('a signature over another nonce (a replayed proof) → 4401 "proof"', async () => {
      await start();
      const ws = await deviceDial((_nonce, ts) => goodSig('some-earlier-nonce-value', ts));
      expect(await waitClose(ws)).toEqual({ code: CLOSE.UNAUTHORIZED, reason: 'proof' });
    });

    it('a device dial with no proof in the hello → 4401 "proof"', async () => {
      await start();
      const ws = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: 'TermhubDevice m1' })).ws!;
      await nextControl(ws);
      ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(goodHello)));
      expect(await waitClose(ws)).toEqual({ code: CLOSE.UNAUTHORIZED, reason: 'proof' });
    });

    it('a machine with no device key (revoked by "pair again") is refused at the upgrade', async () => {
      await start();
      const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: 'TermhubDevice m2' });
      expect(res.statusCode).toBe(401);
      await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unknown-device' }), 'agent upgrade rejected'));
    });

    it('a device probe answers probe-ok without attaching', async () => {
      await start();
      const ws = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: 'TermhubDevice m1' })).ws!;
      const challenge = await nextControl(ws);
      const ts = Date.now();
      ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ ...goodHello, probe: true, proof: { machine_id: 'm1', ts, sig: goodSig(challenge.nonce as string, ts) } })));
      expect(await waitClose(ws)).toEqual({ code: 1000, reason: 'probe-ok' });
      expect(registry.isOnline('m1')).toBe(false);
    });
  });
});
