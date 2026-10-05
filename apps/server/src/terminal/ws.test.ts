import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthContext } from '../auth/index.js';
import { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { AgentOfflineError } from '../agent/registry.js';
import { AgentRpcError } from '../agent/connection.js';
import { registerTerminalWs } from './ws.js';

const { resolveUserMock, canAccessMock, createPtySessionMock, awaitAgentMock, agentInfoMock, scrollSessionMock } = vi.hoisted(() => ({
  resolveUserMock: vi.fn(),
  canAccessMock: vi.fn(),
  createPtySessionMock: vi.fn(),
  awaitAgentMock: vi.fn(),
  agentInfoMock: vi.fn(),
  scrollSessionMock: vi.fn(),
}));

// The router's cookie/permission plumbing isn't what this suite is about — stub it open,
// the same way ws/router.test.ts does, and drive scenarios through createPtySession instead.
vi.mock('../auth/permissions.js', () => ({ canAccess: (...args: unknown[]) => canAccessMock(...args) }));
vi.mock('../auth/index.js', () => ({
  parseCookies: () => ({}),
  resolveUser: (...args: unknown[]) => resolveUserMock(...args),
}));
// Real LocalPtySession pulls in the native node-pty addon; this suite is only about the
// ws.ts <-> createPtySession wiring, so the whole module is replaced.
vi.mock('./pty-session.js', () => ({ createPtySession: (...args: unknown[]) => createPtySessionMock(...args) }));
// Only awaitAgent is exercised here; keep the module's real exports (AgentOfflineError) otherwise.
vi.mock('../agent/registry.js', async (orig) => {
  const mod = await orig<typeof import('../agent/registry.js')>();
  return { ...mod, agents: { awaitAgent: (...a: unknown[]) => awaitAgentMock(...a), info: (...a: unknown[]) => agentInfoMock(...a) } };
});
// The wheel reaches tmux through scrollSession; what it runs on the machine is session-ops.test.ts's business.
vi.mock('./session-ops.js', async (orig) => ({
  ...(await orig<typeof import('./session-ops.js')>()),
  scrollSession: (...a: unknown[]) => scrollSessionMock(...a),
}));

const machine: Machine = {
  id: 'm1',
  name: 'agent-machine',
  host: null,
  ssh_user: null,
  ssh_port: 22,
  type: 'agent',
  os: 'macos',
  capabilities: [],
  checked_at: null,
  agent_version: '0.1.0',
  agent_last_seen_at: null,
  agent_auto_update: false,
  is_local: false,
  owner_id: 'u1',
} as unknown as Machine;

const project: Project = {
  id: 'p1',
  owner_id: 'u1',
  key: 'PROJ',
  next_task_number: 1,
  name: 'proj',
  status: 'active',
  description: null,
  last_terminal_at: null,
  created_at: new Date().toISOString(),
};

const tab: Tab = {
  id: 't1',
  project_id: 'p1',
  machine_id: 'm1',
  name: 'main',
  kind: 'terminal',
  tmux_session: 'termhub-t1',
  simulator_udid: null,
  position: 0,
  created_at: new Date().toISOString(),
} as unknown as Tab;

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

function fakeRepos(): Repositories {
  return {
    tabs: { findById: vi.fn(async () => tab) },
    projects: { findById: vi.fn(async () => project), touchTerminal: vi.fn(async () => {}) },
    projectMachines: { find: vi.fn(async () => ({ id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/Users/x/proj', position: 0, created_at: '' })) },
    machines: { findById: vi.fn(async () => machine) },
  } as unknown as Repositories;
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

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

/** Connects a client to tab t1, collecting every JSON message and the eventual close. */
async function connectClient(port: number): Promise<{ ws: WebSocket; messages: unknown[]; closed: Promise<{ code: number; reason: string }> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tabs/t1`);
  const messages: unknown[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  const closed = waitClose(ws);
  await waitOpen(ws);
  return { ws, messages, closed };
}

/** Polls `messages` until one of the given type shows up. */
async function waitForMessage(messages: unknown[], type: string): Promise<void> {
  await vi.waitFor(() => expect(messages.some((m) => (m as { type?: string }).type === type)).toBe(true));
}

describe('registerTerminalWs', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    resolveUserMock.mockReset().mockResolvedValue({ id: 'u1' });
    canAccessMock.mockReset().mockResolvedValue(true);
    createPtySessionMock.mockReset();
    awaitAgentMock.mockReset().mockResolvedValue(true);
    agentInfoMock.mockReset().mockReturnValue({ agent_version: '0.12.0', os: 'macos', tools: [], connected_at: '' });
    scrollSessionMock.mockReset().mockResolvedValue(undefined);
    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    wss = registerTerminalWs(router, { repos: fakeRepos(), log: fakeLog() });
    port = await listen(server);
  });

  afterEach(async () => {
    wss.close();
    await shutdown(server);
  });

  it('agent offline: client gets "Agente desconectado" and the socket closes 1011', async () => {
    createPtySessionMock.mockRejectedValueOnce(new AgentOfflineError('agent offline: m1'));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tabs/t1`);
    const messages: unknown[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await waitOpen(ws);

    const closed = await waitClose(ws);

    expect(closed.code).toBe(1011);
    expect(messages).toContainEqual({ type: 'error', message: 'Agente desconectado' });
  });

  async function openError(err: unknown): Promise<unknown[]> {
    createPtySessionMock.mockRejectedValueOnce(err);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tabs/t1`);
    const messages: unknown[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await waitOpen(ws);
    expect((await waitClose(ws)).code).toBe(1011);
    return messages;
  }

  it('the agent could not start the terminal: says what to run on the machine', async () => {
    const messages = await openError(new AgentRpcError({ code: 'internal', message: 'failed to start pty' }));
    expect(messages).toContainEqual({ type: 'error', message: 'Esta máquina não conseguiu abrir o terminal. Rode termhub-agent doctor nela.' });
  });

  it('the agent has no tmux: says so', async () => {
    const messages = await openError(new AgentRpcError({ code: 'no_tmux', message: 'tmux not found' }));
    expect(messages).toContainEqual({ type: 'error', message: 'tmux não encontrado nesta máquina. Instale o tmux e tente de novo.' });
  });

  it('any other failure keeps the generic message', async () => {
    const messages = await openError(new Error('ssh: connect refused'));
    expect(messages).toContainEqual({ type: 'error', message: 'Falha ao iniciar terminal' });
  });

  it('kills a session whose browser socket closed while createPtySession() was still pending', async () => {
    let resolveSession!: (session: unknown) => void;
    const deferred = new Promise((resolve) => {
      resolveSession = resolve;
    });
    createPtySessionMock.mockReturnValueOnce(deferred);
    const kill = vi.fn();
    const fakeSession = { write: vi.fn(), resize: vi.fn(), kill, pid: null };

    let serverWs: WebSocket | undefined;
    wss.once('connection', (sock: WebSocket) => {
      serverWs = sock;
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tabs/t1`);
    await waitOpen(ws);

    // Wait until the server has actually started creating the session (and, by construction
    // of handleConnection, has already registered its early close/error listeners) before
    // triggering the disconnect — this is the exact race the fix has to survive.
    await vi.waitFor(() => expect(createPtySessionMock).toHaveBeenCalledTimes(1));
    expect(serverWs).toBeDefined();

    const serverSawClose = new Promise<void>((resolve) => serverWs!.once('close', () => resolve()));
    ws.close();
    await serverSawClose;

    // Only now does createPtySession() resolve — after the browser socket is already gone.
    resolveSession(fakeSession);

    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1));
    // No spurious extra teardown: the normal ws.on('close', ...) path never gets to run
    // because clientGone short-circuits before it's registered.
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('closes 1012 without an exit frame when the agent connection is lost', async () => {
    let handlers!: { onLost?: () => void };
    createPtySessionMock.mockImplementation(async (_m, _c, _t, _s, h) => {
      handlers = h;
      return { pid: null, write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
    });

    const { messages, closed } = await connectClient(port);
    await waitForMessage(messages, 'ready');

    handlers.onLost!();
    const { code, reason } = await closed;

    expect(code).toBe(1012);
    expect(reason).toBe('agent reconnecting');
    expect(messages.some((m) => (m as { type?: string }).type === 'exit')).toBe(false);
  });

  it('real exit still sends exit + 1000', async () => {
    let handlers!: { onExit: (code: number) => void };
    createPtySessionMock.mockImplementation(async (_m, _c, _t, _s, h) => {
      handlers = h;
      return { pid: null, write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
    });

    const { messages, closed } = await connectClient(port);
    await waitForMessage(messages, 'ready');

    handlers.onExit(0);
    const { code } = await closed;

    expect(code).toBe(1000);
    expect(messages).toContainEqual({ type: 'exit', code: 0 });
  });

  it('waits for a moving agent before opening the pty', async () => {
    let release!: (v: boolean) => void;
    awaitAgentMock.mockReturnValue(new Promise<boolean>((r) => (release = r)));
    createPtySessionMock.mockResolvedValue({ pid: null, write: vi.fn(), resize: vi.fn(), kill: vi.fn() });

    const { ws, messages } = await connectClient(port);
    await new Promise((r) => setTimeout(r, 50));
    expect(createPtySessionMock).not.toHaveBeenCalled();

    release(true);
    await waitForMessage(messages, 'ready');
    expect(createPtySessionMock).toHaveBeenCalledOnce();
    ws.close();
  });

  it('fails at once for a long-offline machine', async () => {
    awaitAgentMock.mockResolvedValue(false);
    createPtySessionMock.mockRejectedValue(new AgentOfflineError('agent offline: m1'));

    const { messages, closed } = await connectClient(port);

    expect((await closed).code).toBe(1011);
    expect(messages).toContainEqual({ type: 'error', message: 'Agente desconectado' });
  });

  it('client gone during the wait: no pty is opened', async () => {
    let release!: (v: boolean) => void;
    awaitAgentMock.mockReturnValue(new Promise<boolean>((r) => (release = r)));

    const { ws } = await connectClient(port);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));

    release(true);
    await new Promise((r) => setTimeout(r, 50));

    expect(createPtySessionMock).not.toHaveBeenCalled();
  });

  // TER-576: terminals:read lets someone watch a terminal; typing into it takes terminals:write.
  describe('read-only viewer (no terminals:write)', () => {
    async function connect(grants: string[]) {
      canAccessMock.mockImplementation(async (_r: unknown, _u: unknown, _res: string, action: string) => grants.includes(action));
      const writes: string[] = [];
      const resize = vi.fn();
      createPtySessionMock.mockResolvedValue({ pid: null, write: (b: Buffer) => writes.push(b.toString()), resize, kill: vi.fn() });
      const { ws, messages } = await connectClient(port);
      await waitForMessage(messages, 'ready');
      return { ws, messages, writes, resize };
    }
    const tick = () => new Promise((r) => setTimeout(r, 50));

    it('ready says readonly: true and scroll: false', async () => {
      const { ws, messages } = await connect(['read']);
      expect(messages).toContainEqual({ type: 'ready', scroll: false, readonly: true });
      ws.close();
    });

    it('drops keystrokes, resize and scroll, but still answers ping', async () => {
      const { ws, messages, writes, resize } = await connect(['read']);
      ws.send(Buffer.from('rm -rf /\r'), { binary: true });
      ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }));
      ws.send(JSON.stringify({ type: 'scroll', lines: -3 }));
      ws.send(JSON.stringify({ type: 'ping' }));
      await waitForMessage(messages, 'pong');
      await tick();
      expect(writes).toEqual([]);
      expect(resize).not.toHaveBeenCalled();
      expect(scrollSessionMock).not.toHaveBeenCalled();
      ws.close();
    });

    it('a writer still types and resizes', async () => {
      const { ws, messages, writes, resize } = await connect(['read', 'write']);
      expect(messages).toContainEqual({ type: 'ready', scroll: true, readonly: false });
      ws.send(Buffer.from('ls'), { binary: true });
      ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }));
      await vi.waitFor(() => expect(writes).toEqual(['ls']));
      await vi.waitFor(() => expect(resize).toHaveBeenCalledWith({ type: 'resize', cols: 100, rows: 40 }));
      ws.close();
    });
  });

  describe('mouse wheel', () => {
    /** A connected client and the fake session's writes, as text. */
    async function ready(): Promise<{ ws: WebSocket; messages: unknown[]; writes: string[] }> {
      const writes: string[] = [];
      createPtySessionMock.mockResolvedValue({ pid: null, write: (b: Buffer) => writes.push(b.toString()), resize: vi.fn(), kill: vi.fn() });
      const { ws, messages } = await connectClient(port);
      await waitForMessage(messages, 'ready');
      return { ws, messages, writes };
    }
    /** A scrollSession call that only finishes when the test says so. */
    function holdNextScroll(): () => void {
      let release!: () => void;
      scrollSessionMock.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
      return () => release();
    }
    const scrollMsg = (lines: unknown) => JSON.stringify({ type: 'scroll', lines });
    const tick = () => new Promise((r) => setTimeout(r, 50));

    it('ready says whether the machine can scroll: an agent from 0.12.0 on', async () => {
      const { ws, messages } = await ready();
      expect(messages).toContainEqual({ type: 'ready', scroll: true, readonly: false });
      ws.close();
    });

    it('ready says scroll: false for an older agent, and its scroll messages are ignored', async () => {
      agentInfoMock.mockReturnValue({ agent_version: '0.11.0', os: 'macos', tools: [], connected_at: '' });
      const { ws, messages, writes } = await ready();
      expect(messages).toContainEqual({ type: 'ready', scroll: false, readonly: false });
      ws.send(scrollMsg(-3));
      ws.send(Buffer.from('a'), { binary: true });
      await vi.waitFor(() => expect(writes).toEqual(['a']));
      expect(scrollSessionMock).not.toHaveBeenCalled();
      ws.close();
    });

    it('scrolls the tab session by the lines sent', async () => {
      const { ws } = await ready();
      ws.send(scrollMsg(-3));
      await vi.waitFor(() => expect(scrollSessionMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'termhub-t1', -3));
      ws.close();
    });

    it('ignores a scroll of 0, a fraction or more than 500 lines', async () => {
      const { ws } = await ready();
      for (const lines of [0, 1.5, 501, -501, '3']) ws.send(scrollMsg(lines));
      await tick();
      expect(scrollSessionMock).not.toHaveBeenCalled();
      ws.close();
    });

    it('keeps one call in flight and adds up the deltas that arrive meanwhile', async () => {
      const release = holdNextScroll();
      const { ws } = await ready();
      ws.send(scrollMsg(-1));
      await vi.waitFor(() => expect(scrollSessionMock).toHaveBeenCalledTimes(1));
      ws.send(scrollMsg(-2));
      ws.send(scrollMsg(-4));
      ws.send(scrollMsg(1));
      await tick();
      expect(scrollSessionMock).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(scrollSessionMock).toHaveBeenCalledTimes(2));
      expect(scrollSessionMock.mock.calls[1][2]).toBe(-5);
      await tick();
      expect(scrollSessionMock).toHaveBeenCalledTimes(2);
      ws.close();
    });

    it('leaves copy-mode before the first key after a scroll, keeping the keys in order', async () => {
      const { ws, writes } = await ready();
      ws.send(scrollMsg(-2));
      await vi.waitFor(() => expect(scrollSessionMock).toHaveBeenCalledTimes(1));
      const release = holdNextScroll();
      ws.send(Buffer.from('a'), { binary: true });
      ws.send(Buffer.from('b'), { binary: true });
      await vi.waitFor(() => expect(scrollSessionMock).toHaveBeenCalledTimes(2));
      expect(scrollSessionMock.mock.calls[1][2]).toBe(0);
      await tick();
      expect(writes).toEqual([]); // held until tmux left copy-mode
      release();
      await vi.waitFor(() => expect(writes).toEqual(['a', 'b']));
      // only the first key after a scroll pays for it
      ws.send(Buffer.from('c'), { binary: true });
      await vi.waitFor(() => expect(writes).toEqual(['a', 'b', 'c']));
      expect(scrollSessionMock).toHaveBeenCalledTimes(2);
      ws.close();
    });

    it('still writes the keys when leaving copy-mode fails', async () => {
      const { ws, writes } = await ready();
      ws.send(scrollMsg(-2));
      await vi.waitFor(() => expect(scrollSessionMock).toHaveBeenCalledTimes(1));
      scrollSessionMock.mockRejectedValueOnce(new Error('tmux went away'));
      ws.send(Buffer.from('x'), { binary: true });
      await vi.waitFor(() => expect(writes).toEqual(['x']));
      ws.close();
    });

    it('writes keys straight through when there was no scroll', async () => {
      const { ws, writes } = await ready();
      ws.send(Buffer.from('ls'), { binary: true });
      await vi.waitFor(() => expect(writes).toEqual(['ls']));
      expect(scrollSessionMock).not.toHaveBeenCalled();
      ws.close();
    });
  });
});
