import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthContext } from '../auth/index.js';
import { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { newAgentToken } from '../agent/token.js';
import { registerAgentWs } from '../agent/ws.js';
import { agents } from '../agent/registry.js';
// Agent-side module, imported straight from the sibling package's source: this suite proves the
// whole chain (server tunnel <-> agent tcp channel <-> local WDA port) works end to end, so it
// needs the real agent runtime, not a mock of it. See apps/server/src/agent/e2e.test.ts for why
// this lives in the server test suite instead of in apps/agent.
import { runAgent } from '../../../agent/src/run.js';
import type { AgentConfig } from '../../../agent/src/config.js';
import { openTunnel } from './tunnel.js';

/** A WDA port from the allowed range; the stub answers one fixed HTTP response. */
const WDA_PORT = 8199;
const MJPEG_PORT = 9199;

function startStub(port: number): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      // Per-connection buffer: a request may arrive split across chunks, and the keep-alive
      // path in test 1 sends a second request on the same connection, so this must answer
      // exactly once per complete request header block, not once per 'data' event.
      let buf = '';
      sock.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let headerEnd: number;
        while ((headerEnd = buf.indexOf('\r\n\r\n')) !== -1) {
          buf = buf.slice(headerEnd + 4);
          sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 24\r\n\r\n{"value":{"ready":true}}');
        }
      });
    });
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`agent-tunnel.e2e.test: skipping, port ${port} is already in use`);
        resolve(null); // dev Mac with a real WDA on this port: skip below
        return;
      }
      reject(err); // any other listen failure should fail loudly, not silently pass 0 assertions
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

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

const { resolveUserMock, canAccessMock } = vi.hoisted(() => ({
  resolveUserMock: vi.fn(),
  canAccessMock: vi.fn(),
}));

// Same stubbing style as agent/e2e.test.ts: the cookie/permission plumbing isn't what this suite
// is about, only the real openTunnel -> agent registry -> tcp channel wiring is.
vi.mock('../auth/permissions.js', () => ({ canAccess: (...args: unknown[]) => canAccessMock(...args) }));
vi.mock('../auth/index.js', () => ({
  parseCookies: () => ({}),
  resolveUser: (...args: unknown[]) => resolveUserMock(...args),
}));

describe('agent e2e: server tunnel <-> agent tcp channel <-> local WDA port', () => {
  let server: http.Server;
  let port: number;
  let stub: net.Server | null;
  let agentController: AbortController;
  let agentRunPromise: Promise<void>;
  let machine: Machine;
  let agentHome: string;
  let prevHome: string | undefined;

  beforeAll(async () => {
    // `runAgent` heals the monitor hooks of the HOME it runs in (os.homedir() reads $HOME):
    // without a temporary one this suite rewrote the developer's real hooks (TER-491).
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thtest-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = agentHome;
    stub = await startStub(WDA_PORT);
    if (!stub) return;

    const { token, hash } = newAgentToken();

    machine = {
      id: 'm-sim',
      name: 'e2e-sim-agent',
      host: null,
      ssh_user: null,
      ssh_port: 22,
      type: 'agent',
      os: 'macos',
      capabilities: [],
      checked_at: null,
      agent_version: null,
      agent_last_seen_at: null,
      agent_auto_update: false,
      is_local: false,
      owner_id: 'u1',
      owner_name: null,
      created_at: new Date().toISOString(),
    } as unknown as Machine;

    const repos = {
      machines: {
        findById: vi.fn(async () => machine),
        findByAgentTokenHash: vi.fn(async (h: string) => (h === hash ? machine : undefined)),
        touchAgent: vi.fn(async () => {}),
      },
    } as unknown as Repositories;

    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    registerAgentWs(router, { repos, log: fakeLog() });
    port = await listen(server);

    const agentConfig: AgentConfig = {
      url: `http://127.0.0.1:${port}`,
      token,
      machine_id: '',
      machine_name: '',
      created_at: new Date().toISOString(),
    };
    agentController = new AbortController();
    agentRunPromise = runAgent(agentConfig, { signal: agentController.signal, log: () => {} }).catch((err) => {
      if (!agentController.signal.aborted) throw err;
    });

    await vi.waitFor(() => expect(agents.isOnline('m-sim')).toBe(true), { timeout: 10_000, interval: 100 });
  });

  afterAll(async () => {
    agentController?.abort();
    await agentRunPromise?.catch(() => {});
    if (server) await shutdown(server);
    if (stub) await new Promise<void>((r) => stub!.close(() => r()));
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    // the tmux shells killed above may still be writing their history into this HOME: retry ENOTEMPTY
    fs.rmSync(agentHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('reads the stub WDA /status through the tunnel, reusing one channel for two requests', { timeout: 20_000 }, async () => {
    if (!stub) return; // port taken on this machine
    const t = await openTunnel(machine, { wdaPort: WDA_PORT, mjpegPort: MJPEG_PORT });
    try {
      const res = await fetch(`http://127.0.0.1:${t.wdaPort}/status`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: { ready: true } });
      // undici frees the connection back to its pool on a later tick than the body-read promise
      // resolves; without yielding once here, a second fetch dispatched in the same tick races
      // that release and opens a fresh connection instead of reusing the idle one.
      await new Promise((r) => setImmediate(r));
      const channelsAfterFirst = agents.openChannels('m-sim');
      const res2 = await fetch(`http://127.0.0.1:${t.wdaPort}/status`);
      expect(res2.status).toBe(200);
      expect(agents.openChannels('m-sim')).toBeLessThanOrEqual(channelsAfterFirst); // keep-alive: no second channel
    } finally {
      t.close();
    }
    await vi.waitFor(() => expect(agents.openChannels('m-sim')).toBe(0), { timeout: 5_000, interval: 50 });
    expect(agents.isOnline('m-sim')).toBe(true);
  });

  it('an unreachable WDA port yields a failed request but keeps the agent connection', { timeout: 20_000 }, async () => {
    if (!stub) return;
    const t = await openTunnel(machine, { wdaPort: 8198, mjpegPort: 9198 }); // nothing listens there
    try {
      await expect(fetch(`http://127.0.0.1:${t.wdaPort}/status`)).rejects.toThrow();
    } finally {
      t.close();
    }
    expect(agents.isOnline('m-sim')).toBe(true);
  });
});
