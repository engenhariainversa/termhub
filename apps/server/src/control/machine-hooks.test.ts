import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The agent connection, faked: which agents are online, their version, and what `hooks.*` answer.
const online = new Map<string, string>();
const rpc = vi.fn();
vi.mock('../agent/registry.js', async (orig) => {
  const actual = await orig<typeof import('../agent/registry.js')>();
  return {
    ...actual,
    agents: {
      info: (id: string) => (online.has(id) ? { agent_version: online.get(id) } : null),
      isOnline: (id: string) => online.has(id),
      awaitAgent: async () => undefined,
      rpc: async (id: string, method: string, params: unknown) => {
        if (!online.has(id)) throw new actual.AgentOfflineError('offline');
        return rpc(method, params);
      },
    },
  };
});
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>();
  return { ...actual, config: { ...actual.config, hooksUrl: 'https://app.termhub.dev/api/hooks' } };
});

import { HOOK_SCRIPT_VERSION, type HooksStatus } from '@termhub/machine-ops';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { Scoped } from '../auth/scope.js';
import { HttpError } from '../lib/errors.js';
import { ControlError, type ControlContext } from './context.js';
import { getMachineHooks, installMachineHooks } from './machine-hooks.js';

const machines: Machine[] = [
  { id: 'm1', name: 'homem de ferro', type: 'agent', owner_id: 'u1' } as Machine,
  { id: 'local', name: 'servidor', type: 'local', owner_id: 'u1' } as Machine,
  { id: 'mx', name: 'de outra pessoa', type: 'agent', owner_id: 'u2' } as Machine,
];
let hooks: Map<string, string>;
let upserts: { machine: string; hash: string }[];

function ctxFor(opts: { gated?: boolean; approved?: boolean } = {}): ControlContext {
  const repos = {
    machines: { findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)) },
    aiAccounts: { list: vi.fn(async () => [{ machine_id: 'm1', provider: 'claude', config_dir: '~/.claude_work' }]) },
    machineHooks: {
      findByMachine: vi.fn(async (id: string) => (hooks.has(id) ? { machine_id: id, installed_at: hooks.get(id)! } : undefined)),
      upsert: vi.fn(async (id: string, hash: string) => {
        upserts.push({ machine: id, hash });
        hooks.set(id, '2026-10-07T12:00:00.000Z');
        return { machine_id: id, installed_at: '2026-10-07T12:00:00.000Z' };
      }),
    },
  } as unknown as Repositories;
  const scope = { user: { id: 'u1', locale: null } as never, viewAs: { kind: 'self' as const }, ownerId: 'u1', createAs: 'u1' };
  return {
    repos,
    scope,
    scoped: new Scoped(repos, scope),
    can: async () => true,
    ...(opts.gated ? { token: { id: 't', scopes: ['read', 'terminals'], gated: true } } : {}),
    ...(opts.approved ? { approval: { actionId: 'a1', approvedAt: new Date() } } : {}),
  };
}

/** What `hooks.status` answers: each CLI there or not, and the state of our entries in it. */
function status(over: { claude?: HooksStatus['claude']['state'] | null; codex?: HooksStatus['codex']['state'] | null; cursor?: HooksStatus['cursor']['state'] | null; trusted?: HooksStatus['codex']['trusted']; script?: boolean } = {}): HooksStatus {
  const claude = over.claude === undefined ? 'missing' : over.claude;
  const codex = over.codex === undefined ? 'missing' : over.codex;
  const cursor = over.cursor === undefined ? null : over.cursor;
  return {
    script: { installed: !!over.script, version: over.script ? HOOK_SCRIPT_VERSION : null, expected_version: HOOK_SCRIPT_VERSION, outdated: false },
    claude: claude === null ? { present: false, state: 'missing', dirs: [] } : { present: true, state: claude, dirs: [{ dir: '~/.claude', state: claude }] },
    codex: codex === null ? { present: false, state: 'missing', notify: false, trusted: null } : { present: true, state: codex, notify: codex !== 'missing', trusted: over.trusted ?? null },
    cursor: cursor === null ? { present: false, state: 'missing' } : { present: true, state: cursor },
  };
}

async function rejection(p: Promise<unknown>): Promise<ControlError | HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err instanceof ControlError || err instanceof HttpError).toBe(true);
  return err as ControlError | HttpError;
}

beforeEach(() => {
  vi.clearAllMocks();
  online.clear();
  hooks = new Map();
  upserts = [];
});

describe('get_machine_hooks', () => {
  it('answers each CLI of an agent machine, with the Codex trust and a note when the person still has to trust them', async () => {
    online.set('m1', '0.21.0');
    hooks.set('m1', '2026-10-01T00:00:00.000Z');
    rpc.mockResolvedValueOnce(status({ claude: 'current', codex: 'outdated', trusted: 'some', script: true }));
    const r = await getMachineHooks(ctxFor(), { machine_id: 'm1' });
    expect(rpc).toHaveBeenCalledWith('hooks.status', { claude_dirs: ['~/.claude_work'] });
    expect(r).toMatchObject({
      machine_id: 'm1',
      name: 'homem de ferro',
      installed_at: '2026-10-01T00:00:00.000Z',
      claude: { present: true, installed: true, outdated: false, state: 'current' },
      codex: { present: true, installed: true, outdated: true, state: 'outdated', notify: true, trusted: 'some' },
      cursor: { present: false, installed: false, outdated: false },
    });
    expect(r.notes.join(' ')).toContain('Trust all');
  });

  it('says so when no agent CLI is on the machine', async () => {
    online.set('m1', '0.21.0');
    rpc.mockResolvedValueOnce(status({ claude: null, codex: null }));
    const r = await getMachineHooks(ctxFor(), { machine_id: 'm1' });
    expect(r.installed_at).toBeNull();
    expect(r.notes.join(' ')).toContain('Nenhum CLI');
  });

  it('answers AGENT_OFFLINE for a machine whose agent is not connected', async () => {
    const err = await rejection(getMachineHooks(ctxFor(), { machine_id: 'm1' }));
    expect(err.code).toBe('AGENT_OFFLINE');
  });

  it('tells an agent older than 0.21.0 to update, naming the version, without calling it', async () => {
    online.set('m1', '0.20.0');
    const err = await rejection(getMachineHooks(ctxFor(), { machine_id: 'm1' }));
    expect(err.code).toBe('AGENT_OUTDATED');
    expect(err.message).toContain('0.21.0');
    expect(rpc).not.toHaveBeenCalled();
  });

  it("never reads another person's machine", async () => {
    online.set('mx', '0.21.0');
    const err = await rejection(getMachineHooks(ctxFor(), { machine_id: 'mx' }));
    expect(err.message).not.toContain('de outra pessoa');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('install_machine_hooks', () => {
  it('never runs on the concierge token without the person\'s card', async () => {
    online.set('m1', '0.21.0');
    const err = await rejection(installMachineHooks(ctxFor({ gated: true }), { machine_id: 'm1' }));
    expect(err.code).toBe('CONFIRMATION_REQUIRED');
    expect(rpc).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
  });

  it('installs through the agent once approved, records a fresh token hash, and answers what changed', async () => {
    online.set('m1', '0.21.0');
    rpc.mockImplementation(async (method: string) => {
      if (method === 'hooks.install') return { home: '/Users/p', claude: 'installed', codex: 'installed', cursor: 'skipped', claude_dirs: ['~/.claude', '~/.claude_work'] };
      return upserts.length ? status({ claude: 'current', codex: 'current', trusted: 'none', script: true }) : status({ claude: 'missing', codex: 'outdated', trusted: 'all' });
    });
    const r = await installMachineHooks(ctxFor({ gated: true, approved: true }), { machine_id: 'm1', tools: ['claude', 'codex'] });
    const install = rpc.mock.calls.find(([m]) => m === 'hooks.install')![1] as { hooks_url: string; token: string; claude_dirs: string[] };
    expect(install).toMatchObject({ hooks_url: 'https://app.termhub.dev/api/hooks', claude_dirs: ['~/.claude_work'] });
    // only the hash is kept, and the plain token is never in the answer
    expect(upserts).toHaveLength(1);
    expect(upserts[0].hash).not.toBe(install.token);
    expect(JSON.stringify(r)).not.toContain(install.token);
    expect(r.changes).toEqual([
      { tool: 'claude', before: 'missing', after: 'current' },
      { tool: 'codex', before: 'outdated', after: 'current' },
      { tool: 'cursor', before: 'absent', after: 'absent' },
    ]);
    expect(r.script).toEqual({ before: null, after: HOOK_SCRIPT_VERSION });
    expect(r.hooks?.codex.trusted).toBe('none');
    expect(r.hooks?.notes.join(' ')).toContain('Trust all');
  });

  it('refuses, writing nothing, when a CLI the person named is not on the machine', async () => {
    online.set('m1', '0.21.0');
    rpc.mockResolvedValue(status({ claude: 'current', codex: null, cursor: null }));
    const err = await rejection(installMachineHooks(ctxFor(), { machine_id: 'm1', tools: ['claude', 'cursor'] }));
    expect(err.code).toBe('CLI_NOT_FOUND');
    expect(err.message).toContain('cursor');
    expect(rpc.mock.calls.map(([m]) => m)).toEqual(['hooks.status']);
    expect(upserts).toEqual([]);
  });

  it('answers AGENT_OFFLINE and writes nothing when the agent is not connected', async () => {
    const err = await rejection(installMachineHooks(ctxFor(), { machine_id: 'm1' }));
    expect(err.code).toBe('AGENT_OFFLINE');
    expect(upserts).toEqual([]);
  });

  it('tells an agent older than 0.21.0 to update before writing anything', async () => {
    online.set('m1', '0.12.3');
    const err = await rejection(installMachineHooks(ctxFor(), { machine_id: 'm1' }));
    expect(err.code).toBe('AGENT_OUTDATED');
    expect(err.message).toContain('0.21.0');
    expect(rpc).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
  });

  it('passes on what the machine reported when the install fails there', async () => {
    online.set('m1', '0.21.0');
    const { AgentRpcError } = await import('../agent/connection.js');
    rpc.mockImplementation(async (method: string) => {
      if (method === 'hooks.install') throw new AgentRpcError({ code: 'failed', message: '~/.claude/settings.json não é JSON válido' });
      return status({ claude: 'unreadable' });
    });
    const err = await rejection(installMachineHooks(ctxFor(), { machine_id: 'm1' }));
    expect(err.code).toBe('MACHINE_FAILED');
    expect(err.message).toContain('não é JSON válido');
    expect(upserts).toEqual([]);
  });
});

/** The ssh/local path for real: the same `sh` script against a throwaway $HOME. */
describe('both tools on a local machine', () => {
  let home: string;
  let realHome: string | undefined;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'termhub-mcp-hooks-'));
    realHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(home, { recursive: true, force: true });
  });

  it('installs, and get_machine_hooks then reads the new state', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    const before = await getMachineHooks(ctxFor(), { machine_id: 'local' });
    expect(before).toMatchObject({ installed_at: null, claude: { present: true, installed: false }, cursor: { present: true, installed: false }, codex: { present: false } });

    const r = await installMachineHooks(ctxFor({ gated: true, approved: true }), { machine_id: 'local', tools: ['claude'] });
    expect(r.changes).toEqual([
      { tool: 'claude', before: 'missing', after: 'current' },
      { tool: 'codex', before: 'absent', after: 'absent' },
      { tool: 'cursor', before: 'missing', after: 'current' },
    ]);
    const env = await readFile(path.join(home, '.termhub/hook.env'), 'utf8');
    const token = /TERMHUB_HOOK_TOKEN='([^']+)'/.exec(env)![1];
    expect(JSON.stringify(r)).not.toContain(token);

    const after = await getMachineHooks(ctxFor(), { machine_id: 'local' });
    expect(after).toMatchObject({ installed_at: '2026-10-07T12:00:00.000Z', script: { installed: true, outdated: false }, claude: { installed: true, outdated: false, state: 'current' }, cursor: { state: 'current' } });
  });

  it('refuses a CLI that is not there, and writes nothing', async () => {
    const err = await rejection(installMachineHooks(ctxFor(), { machine_id: 'local', tools: ['codex'] }));
    expect(err.code).toBe('CLI_NOT_FOUND');
    await expect(readFile(path.join(home, '.termhub/hook.env'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
