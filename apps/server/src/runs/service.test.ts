import type { RunOpenParams } from '@termhub/agent-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentChannel, ChannelHandlers } from '../agent/connection.js';
import type { ApiRun, ApiRunPatch, RunEventRow, StoredRunEvent } from '../db/repositories/api-runs.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, User } from '../db/repositories/types.js';
import type { Candidate, RouteResult } from './routing.js';
import { RunService, type CreateRunInput, type RunAgents } from './service.js';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const user = { id: 'u1', email: 'a@b.c', locale: 'en' } as unknown as User;
const token = { id: 'tok1', user_id: 'u1', scopes: ['runs'] } as unknown as ApiToken;

const line = (o: unknown) => JSON.stringify(o) + '\n';
const TEXT = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const TOOL = line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/a' } }] } });
const RESULT_OK = line({ type: 'result', subtype: 'success', is_error: false, result: 'pronto', usage: { input_tokens: 5, output_tokens: 2 }, total_cost_usd: 0.01 });
const RESULT_LIMIT = line({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached', api_error_status: 429 });

/** In-memory api_runs + api_run_events, the way the repository behaves. */
function memoryRuns() {
  const runs = new Map<string, ApiRun>();
  const events = new Map<string, StoredRunEvent[]>();
  let n = 0;
  const active = (r: ApiRun) => r.status === 'queued' || r.status === 'running';
  const apply = (r: ApiRun, p: ApiRunPatch) => {
    const iso = (d: Date | null | undefined) => (d === undefined ? undefined : d === null ? null : d.toISOString());
    const next: ApiRun = { ...r };
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      (next as unknown as Record<string, unknown>)[k] = k === 'started_at' || k === 'ended_at' ? iso(v as Date | null) : v;
    }
    runs.set(r.id, next);
  };
  return {
    runs,
    events,
    repo: {
      create: vi.fn(async (i: { user_id: string; token_id: string | null; project_id: string; capabilities: string[]; timeout_ms: number; idempotency_key?: string | null }) => {
        const run: ApiRun = {
          id: `run${++n}`, user_id: i.user_id, token_id: i.token_id, project_id: i.project_id, machine_id: null, machine_name: null, account_id: null, account_label: null,
          provider: null, model: null, capabilities: i.capabilities, status: 'queued', workspace: null, result: null, usage: null, error_code: null, error_message: null,
          idempotency_key: i.idempotency_key ?? null, timeout_ms: i.timeout_ms, created_at: NOW.toISOString(), started_at: null, ended_at: null,
        };
        runs.set(run.id, run);
        return run;
      }),
      findById: async (id: string) => runs.get(id),
      findForUser: async (userId: string, id: string) => (runs.get(id)?.user_id === userId ? runs.get(id) : undefined),
      findByIdempotency: async (userId: string, key: string) => [...runs.values()].find((r) => r.user_id === userId && r.idempotency_key === key),
      clearIdempotencyKey: vi.fn(async (id: string) => {
        runs.set(id, { ...runs.get(id)!, idempotency_key: null });
      }),
      setStatus: async (id: string, p: ApiRunPatch, o: { onlyActive?: boolean } = {}) => {
        const r = runs.get(id);
        if (!r || (o.onlyActive && !active(r))) return undefined;
        apply(r, p);
        return runs.get(id);
      },
      finishActive: async (id: string, p: ApiRunPatch) => {
        const r = runs.get(id);
        if (!r || !active(r)) return false;
        apply(r, p);
        return true;
      },
      appendEvents: async (id: string, rows: RunEventRow[]) => {
        const list = events.get(id) ?? [];
        const out = rows.map((e, i) => ({ ...e, seq: list.length + i + 1, at: NOW.toISOString() }));
        events.set(id, [...list, ...out]);
        return out;
      },
      eventsAfter: async (id: string, after: number, limit = 1000) => (events.get(id) ?? []).filter((e) => e.seq > after).slice(0, limit),
      countRunning: async () => 0,
      countCreatedSince: async () => 0,
      oldestCreatedSince: async () => null,
    },
  };
}

class FakeChannel implements AgentChannel {
  static next = 1;
  readonly ch = FakeChannel.next++;
  written: Buffer[] = [];
  closed = false;
  constructor(readonly params: RunOpenParams, readonly handlers: ChannelHandlers) {}
  write(data: Buffer | string) {
    this.written.push(Buffer.from(data));
  }
  close() {
    this.closed = true;
  }
  out(text: string) {
    this.handlers.onData(Buffer.from(text, 'utf8'));
  }
}

function fakeAgents(opts: { refuse?: string[] } = {}) {
  const channels: FakeChannel[] = [];
  const online = new Set(['m1', 'm2']);
  const agents: RunAgents & { channels: FakeChannel[]; online: Set<string> } = {
    channels,
    online,
    isOnline: (id) => online.has(id),
    capabilities: () => ['run.headless'],
    openRun: vi.fn(async (machineId: string, params: RunOpenParams, handlers: ChannelHandlers) => {
      if (!online.has(machineId) || opts.refuse?.includes(machineId)) throw new Error('agent offline');
      const c = new FakeChannel(params, handlers);
      channels.push(c);
      return c;
    }),
  };
  return agents;
}

const machine = (id: string) => ({ id, name: `${id}-name`, type: 'agent', owner_id: 'u1' }) as unknown as Machine;
const account = (id: string, machineId: string, provider: AiAccount['provider'] = 'claude') =>
  ({ id, label: `L-${id}`, provider, machine_id: machineId, config_dir: `~/.claude-${id}`, exclusive_project: null, login_expires_at: null, created_at: '' }) as AiAccount;
const cand = (a: AiAccount, m: Machine): Candidate => ({ account: a, machine: m, provider: a.provider === 'chatgpt' ? 'codex' : 'claude', cwd: '/p' });

function setup(opts: { candidates?: Candidate[]; refuse?: string[] } = {}) {
  const mem = memoryRuns();
  const agents = fakeAgents({ refuse: opts.refuse });
  const marked: string[] = [];
  const worktrees: Array<{ path: string; branch: string }> = [];
  const repos = {
    apiRuns: mem.repo,
    users: { chatBlockedModels: async () => [] },
    projects: { findById: async (id: string) => (id === 'p1' ? { id: 'p1', key: 'TER', name: 'termhub', owner_id: 'u1' } : undefined), findByKey: async () => undefined },
    projectSetup: { get: async () => ({ data: { ai: { accounts: [], models: { claude: null, chatgpt: null } }, repo: { base_branch: 'main' }, automation: { worktrees_dir: '~/.termhub/worktrees' } } }) },
  } as unknown as Repositories;
  const candidates = opts.candidates ?? [cand(account('a1', 'm1'), machine('m1')), cand(account('a2', 'm2'), machine('m2'))];
  const route = vi.fn(async (): Promise<RouteResult> => ({ candidates, skipped: [], ai: { accounts: [], models: { claude: null, chatgpt: 'gpt-5.5' } } as unknown as RouteResult['ai'] }));
  const service = new RunService({
    repos,
    agents,
    log: { info: () => {}, warn: () => {} },
    route,
    ensureWorktree: async (_m, i) => {
      const path = `/home/u/.termhub/worktrees/${i.projectId}/${i.ref}`;
      worktrees.push({ path, branch: i.branch });
      return { path };
    },
    markExhausted: async (a) => {
      marked.push(a.id);
    },
    now: () => NOW,
    offlineCheckMs: 50,
    pollMs: 20,
  });
  return { service, mem, agents, marked, worktrees, route };
}

const input = (over: Partial<CreateRunInput> = {}): CreateRunInput => ({ project: 'p1', prompt: 'leia o README', capabilities: ['read'], timeout_s: 600, ...over });
const types = (mem: ReturnType<typeof memoryRuns>, id: string) => (mem.events.get(id) ?? []).map((e) => e.type);

async function channel(agents: ReturnType<typeof fakeAgents>, i: number) {
  await vi.waitFor(() => expect(agents.channels.length).toBeGreaterThan(i));
  return agents.channels[i]!;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RunService', () => {
  it('stores the lines as events in seq order: started first, done last, succeeded', async () => {
    const { service, mem, agents } = setup();
    const { run, created } = await service.create({ user, token }, input());
    expect(created).toBe(true);
    const ch = await channel(agents, 0);
    expect(ch.params).toMatchObject({ provider: 'claude', cwd: '/p', tools: ['Read', 'Grep', 'Glob'], guard: null, config_dir: '~/.claude-a1', timeout_ms: 600_000 });
    expect(Buffer.concat(ch.written).toString()).toBe('leia o README');
    // A line split across two frames is still one line.
    const t = TEXT('olá');
    ch.out(t.slice(0, 10));
    ch.out(t.slice(10) + RESULT_OK);
    ch.handlers.onExit(0);
    await vi.waitFor(() => expect(mem.runs.get(run.id)!.status).toBe('succeeded'));
    const evs = mem.events.get(run.id)!;
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1));
    expect(types(mem, run.id)).toEqual(['started', 'text', 'usage', 'done']);
    expect(evs[0]!.payload).toMatchObject({ provider: 'claude', machine: 'm1-name', account: 'L-a1', workspace: { kind: 'project', path: '/p', branch: null } });
    expect(evs.at(-1)!.payload).toEqual({ status: 'succeeded', result: 'pronto', usage: { input_tokens: 5, output_tokens: 2, cost_usd: 0.01 } });
    expect(mem.runs.get(run.id)).toMatchObject({ machine_id: 'm1', account_id: 'a1', provider: 'claude', model: 'sonnet', result: 'pronto' });
    expect(service.holds(run.id)).toBe(false);
  });

  it('a CLI that fails ends failed with cli_failed', async () => {
    const { service, mem, agents } = setup();
    const { run } = await service.create({ user, token }, input());
    const ch = await channel(agents, 0);
    ch.handlers.onExit(1, 'cli_missing');
    await vi.waitFor(() => expect(mem.runs.get(run.id)!.status).toBe('failed'));
    expect(mem.runs.get(run.id)).toMatchObject({ error_code: 'cli_failed' });
    expect(types(mem, run.id)).toEqual(['started', 'error', 'done']);
  });

  it('a rate limit before any text moves to the next account and marks the first exhausted', async () => {
    const { service, mem, agents, marked } = setup();
    const { run } = await service.create({ user, token }, input());
    const first = await channel(agents, 0);
    first.out(TEXT('Claude AI usage limit reached') + RESULT_LIMIT);
    first.handlers.onExit(1, 'usage_limit');
    const second = await channel(agents, 1);
    expect(second.params.config_dir).toBe('~/.claude-a2');
    expect(marked).toEqual(['a1']);
    second.out(TEXT('oi') + RESULT_OK);
    second.handlers.onExit(0);
    await vi.waitFor(() => expect(mem.runs.get(run.id)!.status).toBe('succeeded'));
    // The first account's limit never reached the caller; a new `started` names the second one.
    expect(types(mem, run.id)).toEqual(['started', 'started', 'text', 'usage', 'done']);
    expect(mem.runs.get(run.id)).toMatchObject({ account_id: 'a2', machine_id: 'm2' });
  });

  it('every account limited before output → failed account_limited', async () => {
    const { service, mem, agents, marked } = setup();
    const { run } = await service.create({ user, token }, input());
    (await channel(agents, 0)).handlers.onExit(1, 'usage_limit');
    (await channel(agents, 1)).handlers.onExit(1, 'usage_limit');
    await vi.waitFor(() => expect(mem.runs.get(run.id)!.status).toBe('failed'));
    expect(mem.runs.get(run.id)!.error_code).toBe('account_limited');
    expect(marked).toEqual(['a1', 'a2']);
  });

  it('a rate limit after a text ends the run with account_limited, never on another account', async () => {
    const { service, mem, agents } = setup();
    const { run } = await service.create({ user, token }, input());
    const ch = await channel(agents, 0);
    ch.out(TEXT('Vou ler os arquivos') + RESULT_LIMIT);
    ch.handlers.onExit(1, 'usage_limit');
    await vi.waitFor(() => expect(mem.runs.get(run.id)!.status).toBe('failed'));
    expect(agents.channels).toHaveLength(1);
    expect(mem.runs.get(run.id)!.error_code).toBe('account_limited');
    expect(types(mem, run.id)).toEqual(['started', 'text', 'usage', 'error', 'done']);
  });

  it('the machine drops mid-run → error agent_offline, failed', async () => {
    const { service, mem, agents } = setup();
    const { run } = await service.create({ user, token }, input());
    const ch = await channel(agents, 0);
    ch.out(TEXT('lendo'));
    ch.handlers.onExit(null); // the connection went away
    await vi.waitFor(() => expect(mem.runs.get(run.id)!.status).toBe('failed'));
    expect(mem.runs.get(run.id)!.error_code).toBe('agent_offline');
  });

  it('a connection that dies silently is noticed by the watchdog (well within 60 s)', async () => {
    const { service, mem, agents } = setup();
    const { run } = await service.create({ user, token }, input());
    const ch = await channel(agents, 0);
    agents.online.delete('m1');
    await vi.waitFor(() => expect(mem.runs.get(run.id)!.status).toBe('failed'));
    expect(mem.runs.get(run.id)!.error_code).toBe('agent_offline');
    expect(ch.closed).toBe(true);
  });

  it("a machine that refuses the channel is skipped for the next one", async () => {
    const { service, mem, agents } = setup({ refuse: ['m1'] });
    const { run } = await service.create({ user, token }, input());
    const ch = await channel(agents, 0);
    expect(ch.params.config_dir).toBe('~/.claude-a2');
    ch.out(RESULT_OK);
    ch.handlers.onExit(0);
    await vi.waitFor(() => expect(mem.runs.get(run.id)!.status).toBe('succeeded'));
  });

  it('cancel closes the channel and ends with done cancelled', async () => {
    const { service, mem, agents } = setup();
    const { run } = await service.create({ user, token }, input());
    const ch = await channel(agents, 0);
    const after = await service.cancel('u1', run.id);
    expect(after?.status).toBe('cancelled');
    expect(ch.closed).toBe(true);
    expect(mem.events.get(run.id)!.at(-1)).toMatchObject({ type: 'done', payload: { status: 'cancelled' } });
    // Someone else's run is not found.
    expect(await service.cancel('u2', run.id)).toBeUndefined();
  });

  it('the agent timeout ends the run with error timeout', async () => {
    const { service, mem, agents } = setup();
    const { run } = await service.create({ user, token }, input());
    (await channel(agents, 0)).handlers.onExit(null, 'timeout');
    await vi.waitFor(() => expect(mem.runs.get(run.id)!.status).toBe('failed'));
    expect(mem.runs.get(run.id)!.error_code).toBe('timeout');
  });

  it('an edit run works in a worktree with the guard', async () => {
    const { service, mem, agents, worktrees } = setup();
    const { run } = await service.create({ user, token }, input({ capabilities: ['read', 'edit'] }));
    const ch = await channel(agents, 0);
    const path = `/home/u/.termhub/worktrees/p1/run-${run.id}`;
    expect(worktrees).toEqual([{ path, branch: `termhub/run-${run.id}` }]);
    expect(ch.params).toMatchObject({ cwd: path, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], guard: { branch: `termhub/run-${run.id}`, worktree: path } });
    ch.handlers.onExit(0);
    await vi.waitFor(() => expect(mem.runs.get(run.id)!.workspace).toMatchObject({ kind: 'worktree', path }));
  });

  it('a Codex run gets the sandbox and the Setup model, no tools nor guard', async () => {
    const { service, agents } = setup({ candidates: [cand(account('c1', 'm1', 'chatgpt'), machine('m1'))] });
    await service.create({ user, token }, input({ capabilities: ['run_commands'] }));
    const ch = await channel(agents, 0);
    expect(ch.params).toEqual(expect.objectContaining({ provider: 'codex', sandbox: 'workspace-write', model: 'gpt-5.5', guard: null }));
    expect(ch.params.tools).toBeUndefined();
  });

  it('the same idempotency key returns the same run', async () => {
    const { service, mem } = setup();
    const a = await service.create({ user, token }, input({ idempotency_key: 'k1' }));
    const b = await service.create({ user, token }, input({ idempotency_key: 'k1' }));
    expect(b).toEqual({ run: expect.objectContaining({ id: a.run.id }), created: false });
    expect(mem.repo.create).toHaveBeenCalledTimes(1);
  });

  it('subscribe replays from the table, then streams live, and ends after done', async () => {
    const { service, agents } = setup();
    const { run } = await service.create({ user, token }, input());
    const ch = await channel(agents, 0);
    ch.out(TEXT('um'));
    const seen: number[] = [];
    const ended = vi.fn();
    const stop = service.subscribe(run.id, 1, (e) => seen.push(e.seq), ended);
    ch.out(TEXT('dois') + RESULT_OK);
    ch.handlers.onExit(0);
    await vi.waitFor(() => expect(ended).toHaveBeenCalled());
    expect(seen[0]).toBe(2); // only what came after seq 1
    expect(seen).toEqual(seen.map((_, i) => i + 2));
    stop();
  });

  it('a subscriber leaving never cancels the run', async () => {
    const { service, mem, agents } = setup();
    const { run } = await service.create({ user, token }, input());
    const ch = await channel(agents, 0);
    const stop = service.subscribe(run.id, 0, () => {}, () => {});
    stop();
    ch.out(TEXT('ainda aqui') + RESULT_OK);
    ch.handlers.onExit(0);
    await vi.waitFor(() => expect(mem.runs.get(run.id)!.status).toBe('succeeded'));
    expect(ch.closed).toBe(false);
  });

  it('shutdown ends the runs it holds as failed (server restarted) and refuses new ones', async () => {
    const { service, mem, agents } = setup();
    const { run } = await service.create({ user, token }, input());
    const ch = await channel(agents, 0);
    await service.shutdown();
    expect(mem.runs.get(run.id)).toMatchObject({ status: 'failed', error_code: 'cli_failed', error_message: 'The server restarted' });
    expect(ch.closed).toBe(true);
    await expect(service.create({ user, token }, input())).rejects.toMatchObject({ statusCode: 503 });
  });

  it('no candidate → 409 NO_ACCOUNT_AVAILABLE with a reason per account; all outdated → AGENT_OUTDATED', async () => {
    const { service, route, mem } = setup();
    route.mockResolvedValueOnce({ candidates: [], skipped: [{ account: 'L-a1', machine: 'm1', reason: 'machine_offline' }], ai: {} as RouteResult['ai'] });
    await expect(service.create({ user, token }, input())).rejects.toMatchObject({ statusCode: 409, code: 'NO_ACCOUNT_AVAILABLE', details: { candidates: [{ account: 'L-a1', machine: 'm1', reason: 'machine_offline' }] } });
    route.mockResolvedValueOnce({ candidates: [], skipped: [{ account: 'L-a1', machine: 'm1', reason: 'agent_outdated' }], ai: {} as RouteResult['ai'] });
    await expect(service.create({ user, token }, input())).rejects.toMatchObject({ statusCode: 409, code: 'AGENT_OUTDATED' });
    expect(mem.repo.create).not.toHaveBeenCalled();
  });

  it("another person's project is a 404, before any run is created", async () => {
    const { service, mem } = setup();
    await expect(service.create({ user, token }, input({ project: 'p9' }))).rejects.toMatchObject({ statusCode: 404 });
    expect(mem.repo.create).not.toHaveBeenCalled();
  });
});
