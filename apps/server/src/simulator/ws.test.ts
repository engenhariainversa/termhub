import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthContext } from '../auth/index.js';
import { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import type { SimulatorSessionManager } from './session-manager.js';
import { registerSimulatorWs, commandErrorMessage, RECONNECTING_TOAST } from './ws.js';
import { WdaError } from './wda-client.js';

const { resolveUserMock, canAccessMock } = vi.hoisted(() => ({ resolveUserMock: vi.fn(), canAccessMock: vi.fn() }));

// The router's cookie/permission plumbing is stubbed the same way ws/router.test.ts does.
vi.mock('../auth/permissions.js', () => ({ canAccess: (...args: unknown[]) => canAccessMock(...args) }));
vi.mock('../auth/index.js', () => ({
  parseCookies: () => ({}),
  resolveUser: (...args: unknown[]) => resolveUserMock(...args),
}));
// Whether the machine can run a simulator is sim-gate.test.ts's business: here it always can.
vi.mock('./sim-gate.js', () => ({ simGateMessage: () => null }));

const machine = { id: 'm1', name: 'mac', type: 'agent', os: 'macos', owner_id: 'u1' } as unknown as Machine;
const project = { id: 'p1', owner_id: 'u1' } as unknown as Project;
const tab = {
  id: 't1',
  project_id: 'p1',
  machine_id: 'm1',
  name: 'sim',
  kind: 'simulator',
  tmux_session: null,
  simulator_udid: 'AAAAAAAA-0000-0000-0000-000000000001',
  position: 0,
  created_at: '',
} as unknown as Tab;

function fakeLog(): FastifyBaseLogger {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), silent: vi.fn(), child: vi.fn(() => log), level: 'info' };
  return log as unknown as FastifyBaseLogger;
}

function fakeRepos(): Repositories {
  return {
    tabs: { findById: vi.fn(async () => tab) },
    projects: { findById: vi.fn(async () => project) },
    projectMachines: { find: vi.fn(async () => ({ id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/x', position: 0, created_at: '' })) },
    machines: { findById: vi.fn(async () => machine) },
  } as unknown as Repositories;
}

/** A session whose WDA client records every action, standing in for the real manager. */
function fakeManager() {
  const client = {
    actions: vi.fn(async () => {}),
    keys: vi.fn(async () => {}),
    pressButton: vi.fn(async () => {}),
    setOrientation: vi.fn(async () => {}),
  };
  const handle = {
    client,
    screen: { width: 390, height: 844, orientation: 'portrait' },
    setSettings: vi.fn(async () => {}),
    refreshScreen: vi.fn(async () => ({})),
    setPaused: vi.fn(),
    release: vi.fn(),
  };
  const acquire = vi.fn(async () => handle);
  return { manager: { acquire } as unknown as SimulatorSessionManager, acquire, client, handle };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function shutdown(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

describe('commandErrorMessage', () => {
  it('turns undici "fetch failed" into a pt-BR toast', () => {
    expect(commandErrorMessage(new TypeError('fetch failed'))).toBe(RECONNECTING_TOAST);
    expect(RECONNECTING_TOAST).toBe('Simulador reconectando; tente de novo em instantes.');
  });
  it('keeps WDA errors and other messages as before', () => {
    expect(commandErrorMessage(new WdaError(500, 'boom'))).toBe('WDA: boom');
    expect(commandErrorMessage(new Error('outra coisa'))).toBe('outra coisa');
    expect(commandErrorMessage('x')).toBe('Comando falhou');
  });
});

describe('registerSimulatorWs', () => {
  let server: http.Server;
  let port: number;
  let sim: ReturnType<typeof fakeManager>;
  let closeWss: () => void;

  beforeEach(async () => {
    resolveUserMock.mockReset().mockResolvedValue({ id: 'u1' });
    canAccessMock.mockReset().mockResolvedValue(true);
    sim = fakeManager();
    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    const { wss } = registerSimulatorWs(router, { repos: fakeRepos(), manager: sim.manager, log: fakeLog() });
    closeWss = () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
    };
    port = await listen(server);
  });

  afterEach(async () => {
    closeWss();
    await shutdown(server);
  });

  /** Connects with the given terminals actions granted and waits until the session is acquired. */
  async function connect(grants: string[]) {
    canAccessMock.mockImplementation(async (_r: unknown, _u: unknown, _res: string, action: string) => grants.includes(action));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sim/t1`);
    const messages: { type?: string }[] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(data.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await vi.waitFor(() => expect(sim.acquire).toHaveBeenCalledTimes(1));
    // the acquire promise resolves on the next tick: let the handler see its handle
    await new Promise((r) => setTimeout(r, 20));
    return { ws, messages };
  }

  const actingMessages = [
    { type: 'tap', x: 10, y: 20 },
    { type: 'drag', points: [{ x: 1, y: 2, t: 0 }, { x: 3, y: 4, t: 100 }] },
    { type: 'keys', text: 'oi' },
    { type: 'key', name: 'Enter' },
    { type: 'button', name: 'home' },
    { type: 'rotate', orientation: 'landscape' },
  ];

  // TER-576: terminals:read lets someone watch the simulator; acting on it takes terminals:write.
  it('a read-only viewer is told so first, and its taps, drags, keys, buttons and rotations are dropped', async () => {
    const { ws, messages } = await connect(['read']);
    expect(messages[0]).toEqual({ type: 'readonly' });
    for (const m of actingMessages) ws.send(JSON.stringify(m));
    ws.send(JSON.stringify({ type: 'ping' }));
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'pong')).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(sim.client.actions).not.toHaveBeenCalled();
    expect(sim.client.keys).not.toHaveBeenCalled();
    expect(sim.client.pressButton).not.toHaveBeenCalled();
    expect(sim.client.setOrientation).not.toHaveBeenCalled();
    ws.close();
  });

  it('a read-only viewer still pauses, resumes and tunes its own stream', async () => {
    const { ws } = await connect(['read']);
    ws.send(JSON.stringify({ type: 'pause' }));
    ws.send(JSON.stringify({ type: 'settings', scale: 50, quality: 60 }));
    await vi.waitFor(() => expect(sim.handle.setPaused).toHaveBeenCalledWith(true));
    await vi.waitFor(() => expect(sim.handle.setSettings).toHaveBeenCalledWith(50, 60));
    ws.close();
  });

  it('a writer gets no readonly message and acts on the simulator', async () => {
    const { ws, messages } = await connect(['read', 'write']);
    for (const m of actingMessages) ws.send(JSON.stringify(m));
    await vi.waitFor(() => expect(sim.client.setOrientation).toHaveBeenCalledWith('landscape'));
    expect(sim.client.actions).toHaveBeenCalledTimes(2);
    expect(sim.client.keys).toHaveBeenCalledTimes(2);
    expect(sim.client.pressButton).toHaveBeenCalledWith('home');
    expect(messages.some((m) => m.type === 'readonly')).toBe(false);
    ws.close();
  });
});
