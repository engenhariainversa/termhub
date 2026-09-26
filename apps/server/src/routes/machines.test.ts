import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { CLOSE } from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, MachineType } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { agents } from '../agent/registry.js';
import { AgentClosedError, AgentRpcError } from '../agent/connection.js';
import { setLatestAgentVersion } from '../agent/latest-version.js';
import { AGENT_TOKEN_RE, hashAgentToken } from '../agent/token.js';
import { HOOK_TOKEN_PREFIX, hashHookToken } from '../monitor/token.js';
import { machineRoutes } from './machines.js';

function makeMachine(overrides: Partial<Machine> & { type: MachineType }): Machine {
  return {
    id: 'm1',
    name: 'box',
    subtitle: null,
    host: overrides.type === 'ssh' ? 'example.com' : null,
    ssh_user: null,
    ssh_port: 22,
    os: null,
    capabilities: [],
    checked_at: null,
    agent_version: null,
    agent_last_seen_at: null,
    agent_auto_update: false,
    claude_auto_swap: false,
    is_local: false,
    owner_id: 'u1',
    owner_name: null,
    created_at: '',
    ...overrides,
  };
}

/** Builds a Fastify app with stubbed repos and a fixed request scope, like waitlist.test.ts. */
function buildApp(
  store: Record<string, Machine>,
  aiAccounts: { machine_id: string; provider: string; config_dir: string | null }[] = [],
  health: { hooks?: Record<string, string>; counts?: Record<string, { tabs: number; reporting: number }> } = {},
) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: null, createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });

  const create = vi.fn(async (input: Partial<Machine> & { type: MachineType; name: string }) => {
    const m = makeMachine({
      id: 'm-new',
      name: input.name,
      type: input.type,
      host: input.host ?? null,
      ssh_user: input.ssh_user ?? null,
      ssh_port: input.ssh_port ?? 22,
      is_local: input.is_local ?? false,
      owner_id: input.owner_id ?? null,
    });
    store[m.id] = m;
    return m;
  });
  const rotateAgentToken = vi.fn(async (id: string, hash: string) => {
    if (store[id]) store[id] = { ...store[id], agent_version: store[id].agent_version };
    void hash;
  });
  const update = vi.fn(async (id: string, patch: Partial<Machine>) => {
    store[id] = { ...store[id], ...patch } as Machine;
    return store[id];
  });
  const del = vi.fn(async (id: string) => {
    delete store[id];
    return true;
  });

  const machineHooks = {
    findByMachine: vi.fn(async () => undefined),
    installedAtByMachine: vi.fn(async () => health.hooks ?? {}),
    upsert: vi.fn(async (machine_id: string) => ({ machine_id, installed_at: '2026-01-01T00:00:00.000Z' })),
    delete: vi.fn(async () => true),
  };

  const repos = {
    machineHooks,
    tabs: {
      countsByMachine: vi.fn(async () => health.counts ?? {}),
      listByMachine: vi.fn(async (id: string) => (id === 'm1' ? [{ id: 't1', project_id: 'p1', machine_id: 'm1' }, { id: 't2', project_id: 'p2', machine_id: 'm1' }] : [])),
    },
    aiAccounts: { list: vi.fn(async () => aiAccounts) },
    machines: {
      findById: async (id: string) => store[id],
      list: async () => Object.values(store),
      create,
      rotateAgentToken,
      update,
      delete: del,
    },
    users: {
      findById: async () => undefined,
    },
  } as unknown as Repositories;

  app.register((instance) => machineRoutes(instance, repos), { prefix: '/api/machines' });
  return { app, repos: { create, rotateAgentToken, update, delete: del, machineHooks } };
}

let app: FastifyInstance;
let store: Record<string, Machine>;

beforeEach(() => {
  agents.reset();
  vi.clearAllMocks();
  store = {};
});

/** A connected agent as the registry sees it: hello + an rpc stub, no socket. */
function attachAgent(version: string, rpc = vi.fn()) {
  const conn = Object.assign(new EventEmitter(), {
    hello: { type: 'hello', protocol: 1, agent_version: version, os: 'macos', tools: ['tmux'] },
    connectedAt: Date.now(),
    rpc,
    close: vi.fn(),
  });
  agents.attach('m1', conn as never);
  return rpc;
}

describe('GET /api/machines (monitor health)', () => {
  it('says whether the hooks are installed and how many tabs ever reported a state', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store, [], { hooks: { m1: '2026-01-02T00:00:00.000Z' }, counts: { m1: { tabs: 4, reporting: 3 } } }));
    const res = await app.inject({ method: 'GET', url: '/api/machines' });
    expect(res.statusCode).toBe(200);
    expect(res.json().machines[0]).toMatchObject({ id: 'm1', hooks_installed_at: '2026-01-02T00:00:00.000Z', tabs: 4, tabs_reporting: 3 });
  });

  it('reports a machine with tabs but no hooks as reporting nothing (the monitor looks empty)', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store, [], { counts: { m1: { tabs: 2, reporting: 0 } } }));
    const res = await app.inject({ method: 'GET', url: '/api/machines' });
    expect(res.json().machines[0]).toMatchObject({ hooks_installed_at: null, tabs: 2, tabs_reporting: 0 });
  });

  it('zeroes the counts of a machine with no tabs at all', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'GET', url: '/api/machines' });
    expect(res.json().machines[0]).toMatchObject({ hooks_installed_at: null, tabs: 0, tabs_reporting: 0 });
  });
});

describe('POST /api/machines (agent enrollment)', () => {
  it('creates an agent machine, returns a plaintext token, and rotates the stored hash', async () => {
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'agent-box', type: 'agent' } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(AGENT_TOKEN_RE.test(body.agent_token)).toBe(true);
    expect(body.machine.host).toBeNull();
  });

  it('rotateAgentToken is called with the hash of the returned token', async () => {
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'agent-box', type: 'agent' } });
    const body = res.json();
    expect(built.repos.rotateAgentToken).toHaveBeenCalledWith(body.machine.id, hashAgentToken(body.agent_token));
  });

  it('rejects an agent machine with a host set (400)', async () => {
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'agent-box', type: 'agent', host: 'example.com' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects the legacy ssh and local transports (400)', async () => {
    ({ app } = buildApp(store));
    for (const payload of [{ name: 'ssh-box', type: 'ssh', host: 'example.com' }, { name: 'this-pc', type: 'local' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/machines', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().agent_token).toBeUndefined();
    }
  });

  it('stores is_local for the user\'s own computer', async () => {
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'this-pc', type: 'agent', is_local: true } });
    expect(res.statusCode).toBe(201);
    expect(res.json().machine.is_local).toBe(true);
  });
});

describe('POST /api/machines/:id/agent-token (rotation)', () => {
  it('rotates the token and disconnects the live connection', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    const built = buildApp(store);
    app = built.app;
    const disconnect = vi.spyOn(agents, 'disconnect');
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent-token' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(AGENT_TOKEN_RE.test(body.agent_token)).toBe(true);
    expect(built.repos.rotateAgentToken).toHaveBeenCalledWith('m1', hashAgentToken(body.agent_token));
    expect(disconnect).toHaveBeenCalledWith('m1', CLOSE.UNAUTHORIZED, 'rotated');
  });

  it('rejects rotation on a non-agent machine (400)', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'ssh', host: 'example.com' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent-token' });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/machines/:id (transport type is fixed)', () => {
  it('rejects changing type to agent (400)', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'ssh', host: 'example.com' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { type: 'agent' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects changing type away from agent (400)', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { type: 'ssh', host: 'example.com' } });
    expect(res.statusCode).toBe(400);
  });

  it('still allows a plain rename', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'ssh', host: 'example.com' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { name: 'renamed' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('PATCH /api/machines/:id (agent_auto_update)', () => {
  it('stores the auto-update flag for an agent machine', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { agent_auto_update: true } });
    expect(res.statusCode).toBe(200);
    expect(built.repos.update).toHaveBeenCalledWith('m1', expect.objectContaining({ agent_auto_update: true }));
  });
  it('rejects the flag on an ssh machine', async () => {
    store.m1 = makeMachine({ type: 'ssh' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { agent_auto_update: true } });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/machines/:id (claude_auto_swap)', () => {
  it('reaches the repository with the flag set', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { claude_auto_swap: true } });
    expect(res.statusCode).toBe(200);
    expect(built.repos.update).toHaveBeenCalledWith('m1', expect.objectContaining({ claude_auto_swap: true }));
  });

  it('rejects a non-boolean value (400)', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { claude_auto_swap: 'yes' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('subtitle (create and edit)', () => {
  it('stores a trimmed subtitle on create', async () => {
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'mac', type: 'agent', subtitle: '  MacBook do escritório  ' } });
    expect(res.statusCode).toBe(201);
    expect(built.repos.create).toHaveBeenCalledWith(expect.objectContaining({ subtitle: 'MacBook do escritório' }));
  });

  it('turns an empty or blank subtitle into null on create, and accepts null or no subtitle', async () => {
    const built = buildApp(store);
    app = built.app;
    for (const subtitle of ['', '   ', null]) {
      const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'mac', type: 'agent', subtitle } });
      expect(res.statusCode).toBe(201);
      expect(built.repos.create).toHaveBeenLastCalledWith(expect.objectContaining({ subtitle: null }));
    }
    const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'mac', type: 'agent' } });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a subtitle longer than 80 characters, or one that is not a string (400)', async () => {
    const built = buildApp(store);
    app = built.app;
    for (const subtitle of ['x'.repeat(81), 42]) {
      const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'mac', type: 'agent', subtitle } });
      expect(res.statusCode).toBe(400);
    }
    const ok = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'mac', type: 'agent', subtitle: `  ${'x'.repeat(80)}  ` } });
    expect(ok.statusCode).toBe(201);
    expect(built.repos.create).toHaveBeenCalledTimes(1);
  });

  it('sets, trims and clears the subtitle on edit', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    const built = buildApp(store);
    app = built.app;
    let res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { subtitle: ' servidor da sala ' } });
    expect(res.statusCode).toBe(200);
    expect(built.repos.update).toHaveBeenLastCalledWith('m1', expect.objectContaining({ subtitle: 'servidor da sala' }));
    expect(res.json().machine.subtitle).toBe('servidor da sala');
    res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { subtitle: '' } });
    expect(res.statusCode).toBe(200);
    expect(built.repos.update).toHaveBeenLastCalledWith('m1', expect.objectContaining({ subtitle: null }));
    res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { subtitle: 'de volta' } });
    res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { subtitle: null } });
    expect(res.statusCode).toBe(200);
    expect(built.repos.update).toHaveBeenLastCalledWith('m1', expect.objectContaining({ subtitle: null }));
  });

  it('keeps the subtitle when an edit does not mention it', async () => {
    store.m1 = makeMachine({ type: 'agent', subtitle: 'MacBook do escritório' });
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { name: 'renamed' } });
    expect(res.statusCode).toBe(200);
    expect(built.repos.update).toHaveBeenLastCalledWith('m1', expect.objectContaining({ name: 'renamed', subtitle: 'MacBook do escritório' }));
  });

  it('rejects a subtitle longer than 80 characters on edit (400)', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { subtitle: 'x'.repeat(81) } });
    expect(res.statusCode).toBe(400);
    expect(built.repos.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/machines/:id', () => {
  it('disconnects any live agent connection after deleting', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    ({ app } = buildApp(store));
    const disconnect = vi.spyOn(agents, 'disconnect');
    const res = await app.inject({ method: 'DELETE', url: '/api/machines/m1' });
    expect(res.statusCode).toBe(200);
    expect(disconnect).toHaveBeenCalledWith('m1', CLOSE.UNAUTHORIZED, 'deleted');
  });

  it('deletes a machine that still has linked projects (the links go, the projects stay)', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'DELETE', url: '/api/machines/m1' });
    expect(res.statusCode).toBe(200);
    expect(store.m1).toBeUndefined();
  });

  it('announces the removal of every tab the cascade takes, under the machine owner', async () => {
    const { monitorBus } = await import('../monitor/bus.js');
    store.m1 = makeMachine({ id: 'm1', type: 'agent', owner_id: 'u7' });
    ({ app } = buildApp(store));
    const events: unknown[] = [];
    const off = monitorBus.subscribeLifecycle((e) => events.push(e));
    try {
      await app.inject({ method: 'DELETE', url: '/api/machines/m1' });
    } finally {
      off();
    }
    expect(events).toEqual([
      { kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u7' },
      { kind: 'removed', tab_id: 't2', project_id: 'p2', machine_id: 'm1', owner_id: 'u7' },
    ]);
  });
});

describe('GET /api/machines/:id/status', () => {
  it('reports an offline agent without shelling out', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent', agent_version: '0.1.0', agent_last_seen_at: '2026-01-01T00:00:00.000Z' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'GET', url: '/api/machines/m1/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.online).toBe(false);
    expect(body.agent_version).toBe('0.1.0');
    expect(body.last_seen_at).toBe('2026-01-01T00:00:00.000Z');
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('GET /api/machines/:id/simulators', () => {
  it('answers 503 AGENT_OFFLINE for an agent machine, before the "is this a Mac" check', async () => {
    // No os/capabilities set (a freshly enrolled agent machine): the agent guard must run
    // before requireMac, or this would 400 with "Esta máquina não é um Mac com Xcode" instead.
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'GET', url: '/api/machines/m1/simulators' });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('AGENT_OFFLINE');
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('/api/machines/:id/hooks (monitor hooks on an agent machine)', () => {
  it('POST answers 503 when the agent is offline, without minting a token', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/hooks' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('Agente desconectado');
    expect(built.repos.machineHooks.upsert).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('POST answers 409 AGENT_OUTDATED for an agent that predates the hooks RPC, without calling it', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    const rpc = attachAgent('0.1.3');
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/hooks' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_OUTDATED');
    expect(rpc).not.toHaveBeenCalled();
    expect(built.repos.machineHooks.upsert).not.toHaveBeenCalled();
  });

  it('POST installs through hooks.install and stores the hash of the token it sent', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    const rpc = attachAgent('0.1.4', vi.fn(async () => ({ home: '/Users/p', claude: 'installed', codex: 'skipped' })));
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/hooks' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ installed_at: '2026-01-01T00:00:00.000Z', claude: 'installed', codex: 'skipped' });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [method, params] = rpc.mock.calls[0] as [string, { hooks_url: string; token: string }];
    expect(method).toBe('hooks.install');
    expect(params.hooks_url).toBe(res.json().hooks_url);
    expect(params.token.startsWith(HOOK_TOKEN_PREFIX)).toBe(true);
    expect(built.repos.machineHooks.upsert).toHaveBeenCalledWith('m1', hashHookToken(params.token));
    expect(spawn).not.toHaveBeenCalled();
  });

  it('POST reports the Cursor CLI as the agent answers it, and as agent_outdated when an older agent leaves it out', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    attachAgent('0.4.1', vi.fn(async () => ({ home: '/Users/p', claude: 'installed', codex: 'installed' })));
    let built = buildApp(store);
    app = built.app;
    const old = await app.inject({ method: 'POST', url: '/api/machines/m1/hooks' });
    expect(old.statusCode).toBe(200);
    expect(old.json()).toMatchObject({ claude: 'installed', codex: 'installed', cursor: 'agent_outdated' });

    agents.reset();
    attachAgent('0.4.3', vi.fn(async () => ({ home: '/Users/p', claude: 'installed', codex: 'skipped', cursor: 'installed' })));
    built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/hooks' });
    expect(res.json()).toMatchObject({ cursor: 'installed' });
  });

  it('POST also hooks the config dirs of this machine\'s Claude accounts, which needs agent 0.1.5', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    const accounts = [
      { machine_id: 'm1', provider: 'claude', config_dir: '~/.claude_pedro' },
      { machine_id: 'm1', provider: 'claude', config_dir: null },
      { machine_id: 'm1', provider: 'chatgpt', config_dir: '~/.codex-work' },
      { machine_id: 'other', provider: 'claude', config_dir: '~/.claude-elsewhere' },
    ];
    const old = attachAgent('0.1.4');
    let built = buildApp(store, accounts);
    app = built.app;
    const outdated = await app.inject({ method: 'POST', url: '/api/machines/m1/hooks' });
    expect(outdated.statusCode).toBe(409);
    expect(outdated.json().code).toBe('AGENT_OUTDATED');
    expect(old).not.toHaveBeenCalled();

    agents.reset();
    const rpc = attachAgent('0.1.5', vi.fn(async () => ({ home: '/Users/p', claude: 'installed', codex: 'skipped', claude_dirs: ['~/.claude', '~/.claude_pedro'] })));
    built = buildApp(store, accounts);
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/hooks' });
    expect(res.statusCode).toBe(200);
    expect(res.json().claude_dirs).toEqual(['~/.claude', '~/.claude_pedro']);
    const [, params] = rpc.mock.calls[0] as [string, { claude_dirs?: string[] }];
    expect(params.claude_dirs).toEqual(['~/.claude_pedro']);
  });

  it('POST relays what the machine reported (rpc error "failed") as 502 and stores nothing', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    attachAgent('0.1.4', vi.fn(async () => { throw new AgentRpcError({ code: 'failed', message: '~/.claude/settings.json não é JSON válido', path: '.claude/settings.json' }); }));
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/hooks' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('~/.claude/settings.json não é JSON válido');
    expect(built.repos.machineHooks.upsert).not.toHaveBeenCalled();
  });

  it('DELETE removes through hooks.uninstall and forgets the token', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    const rpc = attachAgent('0.1.4', vi.fn(async () => ({ removed: true })));
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'DELETE', url: '/api/machines/m1/hooks' });
    expect(res.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith('hooks.uninstall', {}, undefined);
    expect(built.repos.machineHooks.delete).toHaveBeenCalledWith('m1');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('DELETE answers 503 for an offline agent and keeps whatever is stored', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'DELETE', url: '/api/machines/m1/hooks' });
    expect(res.statusCode).toBe(503);
    expect(built.repos.machineHooks.delete).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('GET still answers for an agent machine (DB only)', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'GET', url: '/api/machines/m1/hooks' });
    expect(res.statusCode).toBe(200);
    expect(res.json().installed_at).toBeNull();
  });
});

describe('agent update', () => {
  afterEach(() => setLatestAgentVersion(null));

  it('GET /api/machines flags outdated online agents and carries the latest version', async () => {
    store.m1 = makeMachine({ type: 'agent', agent_version: '0.2.1' });
    store.m2 = makeMachine({ id: 'm2', type: 'agent', agent_version: '0.2.5' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.1');
    const res = await app.inject({ method: 'GET', url: '/api/machines' });
    const body = res.json();
    expect(body.latest_agent_version).toBe('0.2.5');
    expect(body.machines.find((m: { id: string }) => m.id === 'm1').update_available).toBe(true);
    expect(body.machines.find((m: { id: string }) => m.id === 'm2').update_available).toBe(false); // offline: nothing to update
  });

  it('GET /api/machines/:id/status carries latest_agent_version and update_available', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.1');
    const res = await app.inject({ method: 'GET', url: '/api/machines/m1/status' });
    expect(res.json()).toMatchObject({ online: true, agent_version: '0.2.1', latest_agent_version: '0.2.5', update_available: true });
  });

  it('POST answers 503 when the agent is offline', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(503);
  });

  it('POST answers 503 while the latest version is unknown', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    attachAgent('0.2.1');
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(503);
  });

  it('POST answers 409 when the agent is already up to date', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    const rpc = attachAgent('0.2.5');
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('POST answers 409 AGENT_OUTDATED for agents that predate the RPC', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.0');
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_OUTDATED');
  });

  it('POST runs agent.update with the latest version and returns the outcome', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    const rpc = attachAgent('0.2.1', vi.fn(async () => ({ installed_version: '0.2.5', restart: 'service' })));
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith('agent.update', { version: '0.2.5' }, 180_000);
    expect(res.json()).toEqual({ installed_version: '0.2.5', restart: 'service', restarting: true });
  });

  it('POST treats a connection closed mid-update as "restarting"', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.1', vi.fn(async () => { throw new AgentClosedError('closed'); }));
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ installed_version: null, restart: 'service', restarting: true });
  });

  it('POST maps an RPC failure to 502 with the agent message', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.1', vi.fn(async () => { throw new AgentRpcError({ code: 'failed', message: 'npm exited with code 243' }); }));
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('AGENT_UPDATE_FAILED');
    expect(res.json().error).toMatch(/^Falha ao atualizar o agente: npm exited with code 243/);
  });

  it('POST maps an RPC timeout to 504', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.1', vi.fn(async () => { throw new AgentRpcError({ code: 'timeout', message: 'npm install timed out' }); }));
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(504);
    expect(res.json().code).toBe('AGENT_UPDATE_TIMEOUT');
  });

  it('POST maps a missing-npm RPC failure to 502 with an install hint', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.1', vi.fn(async () => { throw new AgentRpcError({ code: 'notfound', message: 'npm not found beside node' }); }));
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('AGENT_UPDATE_NPM_MISSING');
  });
});
