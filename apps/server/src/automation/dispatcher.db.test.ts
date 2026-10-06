import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeAutomationDb } from '../../test/automation-db-lock.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { controlContextFor } from '../control/context.js';
import { DEFAULT_AUTOMATION_TOOLS } from '../control/agents.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { Task, User } from '../db/repositories/types.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { newId } from '../lib/ids.js';
import { normalizeSetup } from '../setup/schema.js';
import { MAX_START_FAILURES, START_RETRY_BACKOFF_MS, startDispatcher, type DispatcherDeps } from './dispatcher.js';
import { ControlError } from '../control/context.js';
import { msg } from '../i18n/index.js';
import { followRun, TAB_CLOSED, UNTAGGED } from './follower.js';
import { pauseAutomation } from './pause.js';
import { resetWaiting } from './placement.js';
import { automationQueue } from './queue.js';

// The agent registry, as the dispatcher, the queue and the placement read it: which machines are online
// with the worktree capability.
const reg = vi.hoisted(() => ({ online: new Set<string>(), caps: new Map<string, string[]>() }));
vi.mock('../agent/registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../agent/registry.js')>();
  return {
    ...real,
    agents: {
      isOnline: (id: string) => reg.online.has(id),
      capabilities: (id: string) => (reg.online.has(id) ? (reg.caps.get(id) ?? ['worktree']) : null),
    },
  };
});

const keyOf = (id: string) => 'D' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('automation dispatcher (Postgres)', () => {
  serializeAutomationDb();
  let db: PrismaClient;
  let repos: Repositories;
  let ownerId: string;
  let projectId: string;
  let machineId: string;
  let accountId: string;
  let todoId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repos = createRepositories(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function setSetup(patch: { automation?: Record<string, unknown>; runner?: Record<string, unknown>; repo?: Record<string, unknown> } = {}) {
    const { data } = await repos.projectSetup.get(projectId);
    const next = normalizeSetup(
      {
        ...data,
        repo: { integration_id: 'int-1', full_name: 'acme/app', ...patch.repo },
        ai: { accounts: [accountId], models: {} },
        runner: { ...data.runner, ...patch.runner },
        automation: { ...data.automation, enabled: true, ...patch.automation },
      },
      2,
    );
    await repos.projectSetup.save(projectId, next);
  }

  beforeEach(async () => {
    ownerId = newId();
    projectId = newId();
    machineId = newId();
    reg.online.clear();
    reg.caps.clear();
    resetWaiting();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' } });
    await db.project.create({ data: { id: projectId, ownerId, key: keyOf(projectId), name: 'p' } });
    await db.machine.create({ data: { id: machineId, name: 'm', type: 'agent', ownerId, capabilities: ['claude'], agentVersion: '0.18.0' } });
    await repos.projectMachines.link({ project_id: projectId, machine_id: machineId, cwd: '/home/u/app' });
    accountId = (await repos.aiAccounts.create({ provider: 'claude', label: 'main', machine_id: machineId })).id;
    reg.online.add(machineId);
    const seed = await repos.tasks.create(projectId, { title: 'seed' }); // creates the default columns
    todoId = (await db.taskColumn.findFirst({ where: { projectId, category: 'todo' }, orderBy: { position: 'asc' } }))!.id;
    await repos.tasks.delete(seed.id);
    await setSetup();
    return async () => {
      await db.project.delete({ where: { id: projectId } });
      await db.machine.deleteMany({ where: { id: machineId } });
      await db.user.delete({ where: { id: ownerId } });
    };
  });

  const card = (title = 'Card', extra: { epic_id?: string } = {}) => repos.tasks.create(projectId, { title, column_id: todoId, auto: true, description: 'faça isto', ...extra });

  function makeDeps(over: Partial<DispatcherDeps> = {}) {
    const startAgent = vi.fn(async (_ctx: unknown, input: { task_id?: string }) => ({ tab_id: `tab-${input.task_id}` }) as never);
    const ensureWorkspace = vi.fn(async (_m: unknown, i: { projectId: string; ref: string }) => ({ path: `/home/u/.termhub/worktrees/${i.projectId}/${i.ref}`, created: true }));
    const ensureEpicBranch = vi.fn(async () => {});
    const removeWorkspace = vi.fn(async () => ({ removed: true, dirty: false }));
    const closeTab = vi.fn(async (_ctx: unknown, _tabId: string) => {});
    const deps = {
      repos,
      instance: `test-${newId()}`,
      lifecycle: { draining: false },
      now: () => new Date(),
      startAgent: startAgent as unknown as DispatcherDeps['startAgent'],
      ensureWorkspace: ensureWorkspace as unknown as DispatcherDeps['ensureWorkspace'],
      ensureEpicBranch: ensureEpicBranch as unknown as DispatcherDeps['ensureEpicBranch'],
      removeWorkspace: removeWorkspace as unknown as DispatcherDeps['removeWorkspace'],
      closeTab,
      gh: {} as GithubWriteClient,
      usage: vi.fn(async () => 10),
      room: vi.fn(async () => true),
      ...over,
    } satisfies DispatcherDeps;
    return { deps, startAgent, ensureWorkspace, ensureEpicBranch, removeWorkspace, closeTab };
  }

  async function tickOnce(deps: DispatcherDeps) {
    const d = startDispatcher(deps, { schedule: false });
    await d.tick('test');
    await d.settle();
    return d;
  }

  const runsOf = () => db.automationRun.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  const eventsOf = () => db.automationEvent.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  const ctx = () => controlContextFor(repos, { id: ownerId } as User);
  const reasonOf = async (taskId: string) => (await automationQueue(ctx(), projectId)).find((i) => i.task_id === taskId)?.reason;

  it('an eligible card becomes one start, in its worktree, as the owner, with the automation flags', async () => {
    await setSetup({ runner: { setup_command: 'npm ci' } });
    const c = await card();
    const { deps, startAgent, ensureWorkspace } = makeDeps();
    await tickOnce(deps);

    expect(ensureWorkspace).toHaveBeenCalledTimes(1);
    expect(ensureWorkspace.mock.calls[0]![1]).toEqual({ repoDir: '/home/u/app', root: '~/.termhub/worktrees', projectId, ref: c.ref, branch: `${c.ref}-card`, base: 'main' });
    expect(startAgent).toHaveBeenCalledTimes(1);
    const [callCtx, input, internal] = startAgent.mock.calls[0] as unknown as [{ scope: { ownerId: string } }, Record<string, string>, Record<string, unknown>];
    expect(callCtx.scope.ownerId).toBe(ownerId);
    expect(input).toMatchObject({ project_id: projectId, machine_id: machineId, account_id: accountId, task_id: c.id });
    expect(input.prompt).toContain(c.ref);
    expect(internal).toEqual({
      cwd: `/home/u/.termhub/worktrees/${projectId}/${c.ref}`,
      permission: { mode: 'acceptEdits', allowedTools: DEFAULT_AUTOMATION_TOOLS, branch: `${c.ref}-card` },
      setupCommand: 'npm ci',
      promptIsFinal: true,
      onTabOpened: expect.any(Function),
    });

    const [run] = await runsOf();
    expect(run).toMatchObject({ taskId: c.id, status: 'running', tabId: `tab-${c.id}`, machineId, accountId, branch: `${c.ref}-card`, worktreePath: `/home/u/.termhub/worktrees/${projectId}/${c.ref}`, allowedTools: DEFAULT_AUTOMATION_TOOLS });
    expect(run!.startedAt).not.toBeNull();
    const events = await eventsOf();
    expect(events.map((e) => [e.kind, e.taskId, e.runId])).toEqual([['run_started', c.id, run!.id]]);
    // run_started feeds Progresso only: it never posts a chat line (spec D25)
    expect(await db.chatMessage.count({ where: { conversation: { projectId } } })).toBe(0);

    // the next tick does not start it again
    await tickOnce(deps);
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  it("a start makes sure the owner has an active project chat, so the agent's questions become cards (review I1)", async () => {
    await setSetup({ automation: { max_parallel: 2 } });
    expect(await repos.chat.findLatestActiveForProject(projectId, ownerId)).toBeUndefined();
    await card();
    const { deps, startAgent } = makeDeps();
    await tickOnce(deps);
    expect(startAgent).toHaveBeenCalledTimes(1);
    const first = await repos.chat.findLatestActiveForProject(projectId, ownerId);
    expect(first).toBeDefined();

    // archived meanwhile: the next start opens a new one (and an existing active one is reused)
    await repos.chat.archive(first!.id);
    await card('Outro');
    await tickOnce(deps);
    expect(startAgent).toHaveBeenCalledTimes(2);
    const second = await repos.chat.findLatestActiveForProject(projectId, ownerId);
    expect(second).toBeDefined();
    expect(second!.id).not.toBe(first!.id);
    expect(await db.chatConversation.count({ where: { projectId, userId: ownerId, archivedAt: null, tabId: null } })).toBe(1);
  });

  it('the run knows its tab before the agent line is typed (the tab tools are listed at start, F-8)', async () => {
    const c = await card();
    let seenAtOpen: unknown;
    const startAgent = vi.fn(async (_ctx: unknown, _input: unknown, internal: { onTabOpened?: (id: string) => Promise<void> }) => {
      await internal.onTabOpened?.('tab-early');
      seenAtOpen = (await repos.automationRuns.activeByTab('tab-early'))?.status;
      return { tab_id: 'tab-early' } as never;
    });
    const { deps } = makeDeps({ startAgent: startAgent as unknown as DispatcherDeps['startAgent'] });
    await tickOnce(deps);
    expect(seenAtOpen).toBe('starting');
    expect((await runsOf())[0]).toMatchObject({ taskId: c.id, status: 'running', tabId: 'tab-early' });
  });

  it('two dispatchers ticking at once start the card once', async () => {
    await card();
    const a = makeDeps();
    const b = makeDeps();
    const da = startDispatcher(a.deps, { schedule: false });
    const db2 = startDispatcher(b.deps, { schedule: false });
    await Promise.all([da.tick('a'), db2.tick('b')]);
    await Promise.all([da.settle(), db2.settle()]);
    expect(a.startAgent.mock.calls.length + b.startAgent.mock.calls.length).toBe(1);
    expect((await runsOf()).filter((r) => r.status === 'running')).toHaveLength(1);
  });

  it('a draining instance claims nothing', async () => {
    await card();
    const { deps, startAgent } = makeDeps({ lifecycle: { draining: true } });
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect(await runsOf()).toEqual([]);
  });

  it('a paused project (or "Pausar tudo") gets no start', async () => {
    await card();
    const { deps, startAgent } = makeDeps();
    await pauseAutomation(ctx(), { scope: projectId });
    await tickOnce(deps);
    await db.project.update({ where: { id: projectId }, data: { automationPausedAt: null } });
    await pauseAutomation(ctx(), { scope: 'all' });
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect(await runsOf()).toEqual([]);
  });

  it('a pause pressed while a card is being prepared stops it before anything is typed', async () => {
    const c = await card();
    const { deps, startAgent, ensureWorkspace } = makeDeps();
    ensureWorkspace.mockImplementationOnce(async (_m, i) => {
      await pauseAutomation(ctx(), { scope: projectId });
      return { path: `/w/${i.ref}`, created: true };
    });
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect(await runsOf()).toEqual([]); // the claim is let go: the card comes back after the pause
    expect(await reasonOf(c.id)).toBe('paused');
  });

  it('max_parallel 1 with one active run starts nothing more', async () => {
    await setSetup({ automation: { max_parallel: 1 } });
    const busy = await card('Busy');
    await db.task.update({ where: { id: busy.id }, data: { columnId: (await db.taskColumn.findFirst({ where: { projectId, category: 'doing' } }))!.id, status: 'doing' } });
    const run = (await repos.automationRuns.claim({ project_id: projectId, task_id: busy.id, role: 'implementer', instance: 'other' }))!;
    await repos.automationRuns.update(run.id, 'other', { status: 'running' });
    await card('Next');
    const { deps, startAgent } = makeDeps();
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect(await runsOf()).toHaveLength(1);
  });

  it('max_parallel 1: a run escalated to the person (waiting) frees its slot, keeps its card, and the next card starts (TER-888)', async () => {
    await setSetup({ automation: { max_parallel: 1 } });
    const busy = await card('Busy');
    await db.task.update({ where: { id: busy.id }, data: { columnId: (await db.taskColumn.findFirst({ where: { projectId, category: 'doing' } }))!.id, status: 'doing' } });
    const run = (await repos.automationRuns.claim({ project_id: projectId, task_id: busy.id, role: 'implementer', instance: 'other' }))!;
    await repos.automationRuns.update(run.id, 'other', { status: 'waiting', waiting_reason: 'question_unanswered' });
    const next = await card('Next');
    const { deps, startAgent } = makeDeps();
    await tickOnce(deps);
    expect(startAgent.mock.calls.map((c) => (c[1] as { task_id: string }).task_id)).toEqual([next.id]);
    // the escalated run is still the card's one active run: no second run can be claimed on it
    expect(await repos.automationRuns.claim({ project_id: projectId, task_id: busy.id, role: 'implementer', instance: 'x' })).toBeNull();
    // answered: back to running, and it counts again (the ceiling is crossed once, nothing more starts)
    expect(await repos.automationRuns.resumeWaiting(run.id)).toBe(true);
    await card('Third');
    await tickOnce(deps);
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  it('updateActive with unlessWaitingFor parks a run once per reason (no second escalation of the same episode)', async () => {
    const c = await card('Once');
    const run = (await repos.automationRuns.claim({ project_id: projectId, task_id: c.id, role: 'implementer', instance: 'me' }))!;
    await repos.automationRuns.update(run.id, 'me', { status: 'running' });
    const park = (reason: string) => repos.automationRuns.updateActive(run.id, 'me', { status: 'waiting', waiting_reason: reason }, { unlessWaitingFor: reason });
    expect(await park('question_unanswered')).toBe(true);
    expect(await park('question_unanswered')).toBe(false);
    expect(await park('permission_needed')).toBe(true);
  });

  it('max_parallel 1: a run waiting on its account limit (not an escalation) still holds its slot', async () => {
    await setSetup({ automation: { max_parallel: 1 } });
    const busy = await card('Busy');
    await db.task.update({ where: { id: busy.id }, data: { columnId: (await db.taskColumn.findFirst({ where: { projectId, category: 'doing' } }))!.id, status: 'doing' } });
    const run = (await repos.automationRuns.claim({ project_id: projectId, task_id: busy.id, role: 'implementer', instance: 'other' }))!;
    await repos.automationRuns.update(run.id, 'other', { status: 'waiting', waiting_reason: 'quota' });
    await card('Next');
    const { deps, startAgent } = makeDeps();
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('max_parallel 2 starts the first two cards in board order, one per machine per tick (R6)', async () => {
    await setSetup({ automation: { max_parallel: 2 } });
    await card('A');
    await card('B');
    await card('C');
    const order = (await automationQueue(ctx(), projectId)).map((i) => i.task_id);
    const { deps, startAgent } = makeDeps();
    await tickOnce(deps);
    expect(startAgent.mock.calls.map((c) => (c[1] as { task_id: string }).task_id)).toEqual(order.slice(0, 1));
    expect(await reasonOf(order[1]!)).not.toBe('no_account'); // nothing shown: the next tick starts it
    await tickOnce(deps);
    expect(startAgent.mock.calls.map((c) => (c[1] as { task_id: string }).task_id)).toEqual(order.slice(0, 2));
    await tickOnce(deps); // the ceiling holds
    expect(startAgent).toHaveBeenCalledTimes(2);
  });

  it('one start per account per tick: two machines, one account each, starts only on the first card of a shared account', async () => {
    const other = newId();
    await db.machine.create({ data: { id: other, name: 'm2', type: 'agent', ownerId, capabilities: ['claude'], agentVersion: '0.18.0' } });
    await repos.projectMachines.link({ project_id: projectId, machine_id: other, cwd: '/home/u/app2' });
    const second = (await repos.aiAccounts.create({ provider: 'claude', label: 'two', machine_id: other })).id;
    reg.online.add(other);
    await setSetup({ automation: { max_parallel: null }, repo: {} });
    await repos.projectSetup.save(projectId, normalizeSetup({ ...(await repos.projectSetup.get(projectId)).data, ai: { accounts: [accountId, second], models: {} } }, 2));
    await card('A');
    await card('B');
    await card('C');
    const { deps, startAgent } = makeDeps();
    await tickOnce(deps);
    expect(startAgent).toHaveBeenCalledTimes(2); // one per machine/account
    expect(new Set(startAgent.mock.calls.map((c) => (c[1] as { machine_id: string }).machine_id)).size).toBe(2);
    await db.automationRun.deleteMany({ where: { projectId } });
    await db.machine.deleteMany({ where: { id: other } });
  });

  it('R6: a machine without room (memory, disk or load) starts nothing, and the queue says why', async () => {
    const c = await card();
    const room = vi.fn(async () => false);
    const { deps, startAgent } = makeDeps({ room });
    await tickOnce(deps);
    expect(room).toHaveBeenCalledTimes(1);
    expect(startAgent).not.toHaveBeenCalled();
    expect(await runsOf()).toEqual([]);
    expect(await reasonOf(c.id)).toBe('no_room');
    // room again: it starts, and the machine's next reading is asked fresh
    const startedOn = vi.fn();
    const ok = makeDeps({ room: async () => true, startedOn });
    await tickOnce(ok.deps);
    expect(ok.startAgent).toHaveBeenCalledTimes(1);
    expect(startedOn).toHaveBeenCalledWith(machineId);
  });

  it('R6: an account at 80 % or more has no room for an automatic start', async () => {
    const c = await card();
    const { deps, startAgent } = makeDeps({ usage: vi.fn(async () => 80) });
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect(await reasonOf(c.id)).toBe('no_account');
    const ok = makeDeps({ usage: vi.fn(async () => 79) });
    await tickOnce(ok.deps);
    expect(ok.startAgent).toHaveBeenCalledTimes(1);
  });

  it('R6: a machine that does not accept automatic work is never chosen, and the queue says why', async () => {
    const c = await card();
    await db.machine.update({ where: { id: machineId }, data: { automationAllowed: false } });
    const room = vi.fn(async () => true);
    const { deps, startAgent } = makeDeps({ room });
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect(room).not.toHaveBeenCalled(); // nothing read on a machine that opted out
    expect(deps.usage).not.toHaveBeenCalled();
    expect(await reasonOf(c.id)).toBe('automation_not_allowed');
    await db.machine.update({ where: { id: machineId }, data: { automationAllowed: true } });
    await tickOnce(deps);
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  it('no capable machine: no start, no run left, and the queue says why', async () => {
    const c = await card();
    reg.online.clear(); // offline: the eligibility itself reads no capable machine
    const { deps, startAgent } = makeDeps();
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect(await runsOf()).toEqual([]);
    expect(await reasonOf(c.id)).toBe('no_capable_machine');

    // online with worktree but without Claude: placement finds no machine; the claim is deleted
    reg.online.add(machineId);
    await db.machine.update({ where: { id: machineId }, data: { capabilities: ['codex'] } });
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect(await runsOf()).toEqual([]);
    expect(await reasonOf(c.id)).toBe('no_capable_machine');
    expect(await eventsOf()).toEqual([]); // waiting is not an event
  });

  it('TER-985: no account chosen in the project Setup: the queue names the machine and each account left out', async () => {
    const c = await card();
    await repos.aiAccounts.create({ provider: 'claude', label: 'pessoal', machine_id: machineId, config_dir: '~/.claude-pessoal' });
    const { data } = await repos.projectSetup.get(projectId);
    await repos.projectSetup.save(projectId, normalizeSetup({ ...data, ai: { accounts: [], models: {} } }, 2));
    const { deps, startAgent } = makeDeps();
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect(await runsOf()).toEqual([]);
    const item = (await automationQueue(ctx(), projectId)).find((i) => i.task_id === c.id);
    expect(item).toMatchObject({ eligible: false, reason: 'no_account' });
    expect(item?.reason_text).toBe(
      'Sem conta com folga: nenhuma conta escolhida em Setup → Contas de IA e modelo; conta main (m): fora das contas do projeto no Setup; conta pessoal (m): fora das contas do projeto no Setup',
    );
  });

  it('every account exhausted or full: no start, and the queue reads no_account', async () => {
    const c = await card();
    await repos.aiAccountExhaustions.mark(accountId, new Date(Date.now() + 60 * 60_000), 'rate_limit');
    const { deps, startAgent } = makeDeps();
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect(await runsOf()).toEqual([]);
    expect(await reasonOf(c.id)).toBe('no_account');

    await db.aiAccountExhaustion.deleteMany({ where: { accountId } });
    const full = makeDeps({ usage: vi.fn(async () => 95) });
    await tickOnce(full.deps);
    expect(full.startAgent).not.toHaveBeenCalled();
    expect(await reasonOf(c.id)).toBe('no_account');

    // room again: the card starts and the waiting reason is gone
    const ok = makeDeps({ usage: vi.fn(async () => null) });
    await tickOnce(ok.deps);
    expect(ok.startAgent).toHaveBeenCalledTimes(1);
    expect(await reasonOf(c.id)).toBe('has_agent');
  });

  it('a project with automation off is untouched: no start and no write', async () => {
    await setSetup({ automation: { enabled: false } });
    await card();
    const before = await db.projectSetup.findUnique({ where: { projectId } });
    const { deps, startAgent, ensureWorkspace } = makeDeps();
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(deps.usage).not.toHaveBeenCalled();
    expect(deps.room).not.toHaveBeenCalled(); // R6: automation off, nothing read from the machine
    expect(await runsOf()).toEqual([]);
    expect(await eventsOf()).toEqual([]);
    expect((await db.projectSetup.findUnique({ where: { projectId } }))!.updatedAt).toEqual(before!.updatedAt);
  });

  /** Moves the card's failed runs back in time, as if the retry wait had passed. */
  const age = (ms: number) => db.automationRun.updateMany({ where: { projectId, status: 'failed' }, data: { endedAt: new Date(Date.now() - ms) } });
  const tabError = (code: string, tabId: string) => Object.defineProperty(Object.assign(new Error(code), { code }), 'tab_id', { value: tabId, enumerable: false });

  /** The longest wait between two starts: past it, any failed card is due again. */
  const LONGEST_WAIT_MS = Math.max(...START_RETRY_BACKOFF_MS);

  it('a start that throws: run failed with the code, run_blocked, and no retry until the first wait passed on either colour', async () => {
    const c = await card();
    const { deps, startAgent } = makeDeps();
    startAgent.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'TOOL_MISSING' }));
    const d = startDispatcher(deps, { schedule: false });
    await d.tick('t');
    await d.settle();
    const [run] = await runsOf();
    expect(run).toMatchObject({ status: 'failed', waitingReason: 'TOOL_MISSING', tabId: null });
    expect(run!.endedAt).not.toBeNull();
    const events = await eventsOf();
    // a plain Error has no message fit to show: the code says it
    expect(events.map((e) => [e.kind, e.taskId, e.runId])).toEqual([['run_blocked', c.id, run!.id]]);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ code: 'TOOL_MISSING', stage: 'start', attempt: 1, max_attempts: MAX_START_FAILURES });
    expect(payload.message).toBeUndefined();
    const retryAt = new Date(payload.retry_at as string).getTime();
    expect(retryAt - run!.endedAt!.getTime()).toBe(START_RETRY_BACKOFF_MS[0]);

    await d.tick('again');
    await d.settle();
    // the other colour, with no memory of the failure, waits too
    const other = makeDeps();
    await tickOnce(other.deps);
    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(other.startAgent).not.toHaveBeenCalled();

    await age(START_RETRY_BACKOFF_MS[0]! + 1000);
    await d.tick('later');
    await d.settle();
    expect(startAgent).toHaveBeenCalledTimes(2);
  });

  // TER-987: the event said only LAUNCH_FAILED, and nobody could tell why the agent never started
  it('run_blocked carries the reason of our own errors, in pt-BR and English, and the wait grows after the second failure', async () => {
    await card();
    const reason = new ControlError('LAUNCH_FAILED', msg('A aba {{tab}} foi aberta, mas o agente não foi iniciado: {{reason}}. Veja a tela com read_screen ou feche a aba com close_tab.', { tab: 'tab-1', reason: msg('Parâmetros inválidos para a máquina') }));
    const first = makeDeps();
    first.startAgent.mockRejectedValueOnce(Object.defineProperty(reason, 'tab_id', { value: 'tab-1' }));
    await tickOnce(first.deps);
    const [blocked] = (await eventsOf()).filter((e) => e.kind === 'run_blocked');
    expect(blocked!.payload).toMatchObject({
      code: 'LAUNCH_FAILED',
      stage: 'start',
      message: 'A aba tab-1 foi aberta, mas o agente não foi iniciado: Parâmetros inválidos para a máquina. Veja a tela com read_screen ou feche a aba com close_tab.',
      message_en: expect.stringContaining('Invalid parameters for the machine'),
      attempt: 1,
    });
    // the card says it too, in the queue the board reads, instead of showing as eligible
    const [waiting] = await automationQueue(ctx(), projectId);
    expect(waiting).toMatchObject({ eligible: false, reason: 'start_backoff' });
    expect(waiting!.reason_text).toMatch(/^O início falhou \(1 de 3\); nova tentativa em [12] min\. A aba tab-1 foi aberta, mas o agente não foi iniciado: Parâmetros inválidos/);
    expect((await automationQueue(ctx(), projectId, 'en'))[0]!.reason_text).toContain('Invalid parameters for the machine');

    await age(START_RETRY_BACKOFF_MS[0]! + 1000);
    expect((await automationQueue(ctx(), projectId))[0]!.reason).toBeNull();
    const second = makeDeps();
    second.startAgent.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'TOOL_MISSING' }));
    await tickOnce(second.deps);
    const [latest] = (await eventsOf()).filter((e) => e.kind === 'run_blocked').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    expect(latest!.payload).toMatchObject({ attempt: 2 });
    const ended = (await runsOf()).map((r) => r.endedAt!.getTime()).sort((a, b) => b - a)[0]!;
    expect(new Date((latest!.payload as Record<string, string>).retry_at!).getTime() - ended).toBe(START_RETRY_BACKOFF_MS[1]);

    // the first wait is not enough any more
    await age(START_RETRY_BACKOFF_MS[0]! + 1000);
    const early = makeDeps();
    await tickOnce(early.deps);
    expect(early.startAgent).not.toHaveBeenCalled();
  });

  it('LAUNCH_FAILED: the empty tab is closed and kept on the failed run', async () => {
    await card();
    const { deps, startAgent, closeTab } = makeDeps();
    startAgent.mockRejectedValueOnce(tabError('LAUNCH_FAILED', 'tab-empty'));
    await tickOnce(deps);
    expect(closeTab).toHaveBeenCalledWith(expect.anything(), 'tab-empty');
    expect((await runsOf())[0]).toMatchObject({ status: 'failed', waitingReason: 'LAUNCH_FAILED', tabId: 'tab-empty' });
  });

  it('TASK_LINK_FAILED: the agent runs, so the run stays active with its tab and no colour claims the card again', async () => {
    const c = await card();
    const { deps, startAgent, closeTab } = makeDeps();
    startAgent.mockRejectedValueOnce(tabError('TASK_LINK_FAILED', 'tab-live'));
    await tickOnce(deps);
    expect(closeTab).not.toHaveBeenCalled();
    const [run] = await runsOf();
    expect(run).toMatchObject({ status: 'running', tabId: 'tab-live' });
    expect((await eventsOf()).map((e) => [e.kind, (e.payload as Record<string, unknown>).card_linked])).toEqual([['run_started', false]]);

    const other = makeDeps();
    await tickOnce(other.deps);
    expect(other.startAgent).not.toHaveBeenCalled();
    expect(await runsOf()).toHaveLength(1);

    // and the kill switch reaches it
    const pressed: string[] = [];
    await pauseAutomation(ctx(), { scope: projectId, interrupt: true }, { press: async (id) => void pressed.push(id) });
    expect(pressed).toEqual(['tab-live']);
    expect(c.id).toBe(run!.taskId);
  });

  it(`after ${MAX_START_FAILURES} failed starts in a row the card loses its tag and the failure escalates`, async () => {
    const c = await card();
    for (let n = 1; n <= MAX_START_FAILURES; n++) {
      const { deps, startAgent } = makeDeps();
      startAgent.mockRejectedValueOnce(tabError('LAUNCH_FAILED', `tab-${n}`));
      await age(LONGEST_WAIT_MS + 1000);
      await tickOnce(deps);
      expect(startAgent).toHaveBeenCalledTimes(1);
    }
    expect((await repos.tasks.findById(c.id))!.auto).toBe(false);
    const escalated = (await eventsOf()).filter((e) => e.kind === 'escalated');
    expect(escalated.map((e) => e.payload)).toEqual([{ reason: 'start_failed', tab_id: null, attempts: MAX_START_FAILURES, code: 'LAUNCH_FAILED', untagged: true }]);
    // the person learns it in the project chat (no question card: a line of its own)
    const lines = await db.chatMessage.findMany({ where: { conversation: { projectId } }, select: { text: true } });
    expect(lines.map((l) => l.text)).toEqual([`Automático parou em ${c.ref}: O card não conseguiu começar depois de várias tentativas e saiu do automático; corrija a causa e marque o card de novo.`]);

    await age(LONGEST_WAIT_MS + 1000);
    const later = makeDeps();
    await tickOnce(later.deps);
    expect(later.startAgent).not.toHaveBeenCalled(); // untagged: out of the queue until a person tags it again
  });

  it('a failure to record run_started never turns the live run into a failed one', async () => {
    await card();
    const { deps, startAgent } = makeDeps();
    const events = Object.create(repos.automationEvents) as Repositories['automationEvents'];
    events.insert = async () => {
      throw new Error('events table down');
    };
    await tickOnce({ ...deps, repos: { ...repos, automationEvents: events } });
    expect(startAgent).toHaveBeenCalledTimes(1);
    expect((await runsOf())[0]).toMatchObject({ status: 'running' });
  });

  describe('the card changed between the queue and the claim (F-23)', () => {
    async function changedAfterClaim(change: (t: Task) => Promise<void>) {
      const c = await card();
      const { deps, startAgent } = makeDeps();
      const runs = Object.create(repos.automationRuns) as Repositories['automationRuns'];
      runs.claim = async (i) => {
        await change(c);
        return repos.automationRuns.claim(i);
      };
      await tickOnce({ ...deps, repos: { ...repos, automationRuns: runs } });
      expect(startAgent).not.toHaveBeenCalled();
      expect(await runsOf()).toEqual([]);
    }

    it('moved out of todo', async () => {
      const doing = (await db.taskColumn.findFirst({ where: { projectId, category: 'doing' } }))!;
      await changedAfterClaim(async (t) => void (await db.task.update({ where: { id: t.id }, data: { columnId: doing.id, status: 'doing' } })));
    });

    it('tag removed', async () => {
      await changedAfterClaim(async (t) => void (await db.task.update({ where: { id: t.id }, data: { auto: false } })));
    });

    it('automation turned off', async () => {
      await changedAfterClaim(async () => setSetup({ automation: { enabled: false } }));
    });
  });

  it('a card of an automatic epic gets its epic branch first and is cut from it', async () => {
    // the project's GitHub integration (its secret is encrypted at rest, which needs a key this test has no use for)
    const integrations = { findById: async (id: string) => (id === 'int-1' ? { id, provider: 'github', owner_id: ownerId } : undefined), getSecret: async () => 'ghp_test' };
    const epic = await repos.tasks.create(projectId, { title: 'Grande coisa', type: 'epic' });
    await repos.tasks.setAuto(epic.id, true);
    const c = await card('Parte', { epic_id: epic.id });
    const { deps, startAgent, ensureEpicBranch, ensureWorkspace } = makeDeps();
    await tickOnce({ ...deps, repos: { ...repos, integrations: integrations as unknown as Repositories['integrations'] } });
    const epicBranch = `epic/${epic.ref}-grande-coisa`;
    expect(ensureEpicBranch).toHaveBeenCalledWith({ gh: deps.gh, token: 'ghp_test', repo: 'acme/app' }, 'main', epicBranch);
    expect(ensureWorkspace.mock.calls[0]![1]).toMatchObject({ base: epicBranch, branch: `${c.ref}-parte` });
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  it('an epic card without GitHub access (no such integration) fails with GITHUB_NO_ACCESS and starts nothing', async () => {
    const epic = await repos.tasks.create(projectId, { title: 'E', type: 'epic' });
    await repos.tasks.setAuto(epic.id, true);
    await card('Parte', { epic_id: epic.id });
    const { deps, startAgent } = makeDeps();
    await tickOnce(deps);
    expect(startAgent).not.toHaveBeenCalled();
    expect((await runsOf())[0]).toMatchObject({ status: 'failed', waitingReason: 'GITHUB_NO_ACCESS' });
  });

  it('"Pausar e interromper" sends Escape to the tabs of the active runs', async () => {
    const c = await card();
    const { deps } = makeDeps();
    await tickOnce(deps);
    const pressed: string[] = [];
    await pauseAutomation(ctx(), { scope: projectId, interrupt: true }, { press: async (id) => void pressed.push(id) });
    expect(pressed).toEqual([`tab-${c.id}`]);
  });

  it('on startup, a pause with interrupt recorded earlier stops the runs still in a turn', async () => {
    const c = await card();
    const tab = await repos.tabs.create(projectId, machineId, 'agent');
    await db.tab.update({ where: { id: tab.id }, data: { state: 'working' } });
    const run = (await repos.automationRuns.claim({ project_id: projectId, task_id: c.id, role: 'implementer', instance: 'old' }))!;
    await repos.automationRuns.update(run.id, 'old', { status: 'running', tab_id: tab.id });
    // recorded as an older release did: the pause and its event, nobody pressed the key
    await pauseAutomation(ctx(), { scope: projectId, interrupt: true }, { press: async () => {} });
    const pressed: string[] = [];
    const { deps } = makeDeps({ pressEscape: async (id) => void pressed.push(id) });
    const d = await tickOnce(deps);
    expect(pressed).toEqual([tab.id]);
    await d.tick('second');
    await d.settle();
    expect(pressed).toEqual([tab.id]); // once per process start
  });

  it('a deleted card cancels its run and removes its clean worktree', async () => {
    const c = await card();
    const { deps, removeWorkspace } = makeDeps();
    await tickOnce(deps);
    await repos.tasks.delete(c.id);
    await tickOnce(deps);
    const [run] = await runsOf();
    expect(run).toMatchObject({ status: 'cancelled', taskId: null });
    expect(removeWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: machineId }), { repoDir: '/home/u/app', root: '~/.termhub/worktrees', path: `/home/u/.termhub/worktrees/${projectId}/${c.ref}` });
  });

  it('the heartbeat takes over a silent instance\'s runs and frees the ones that never started', async () => {
    const started = await card('Started');
    const stuck = await card('Stuck');
    const a = (await repos.automationRuns.claim({ project_id: projectId, task_id: started.id, role: 'implementer', instance: 'dead' }))!;
    await repos.automationRuns.update(a.id, 'dead', { status: 'running', tab_id: 'tab-a' });
    await repos.automationRuns.claim({ project_id: projectId, task_id: stuck.id, role: 'implementer', instance: 'dead' });
    await db.automationRun.updateMany({ where: { projectId }, data: { heartbeatAt: new Date(Date.now() - 5 * 60_000) } });
    const { deps } = makeDeps();
    const d = startDispatcher(deps, { schedule: false });
    await d.heartbeat();
    const runs = await runsOf();
    expect(runs.map((r) => [r.taskId, r.status, r.claimedBy])).toEqual([[started.id, 'running', deps.instance]]);
    await d.tick('t');
    await d.settle();
    expect((await runsOf()).find((r) => r.taskId === stuck.id)?.status).toBe('running'); // claimed again and started
  });

  describe('runs that must end, and starts that must not be lost (final review I1, I4)', () => {
    const followerDeps = (instance: string) => ({ repos, instance, lifecycle: { draining: false }, settleMs: 0, type: vi.fn(async () => {}) });

    it('a run whose tab was closed is cancelled with an event; the card and the slot are free again', async () => {
      await setSetup({ automation: { max_parallel: 1 } });
      const first = await card('First');
      const second = await card('Second');
      const { deps, startAgent } = makeDeps(); // its tabs are never real rows: as if closed right after the start
      await tickOnce(deps);
      expect(startAgent).toHaveBeenCalledTimes(1);
      const [run] = await runsOf();
      await followRun(followerDeps(deps.instance), run!.id);
      expect(await db.automationRun.findUnique({ where: { id: run!.id } })).toMatchObject({ status: 'cancelled', waitingReason: TAB_CLOSED });
      expect((await eventsOf()).filter((e) => e.kind === 'run_cancelled')).toEqual([expect.objectContaining({ runId: run!.id, payload: { reason: TAB_CLOSED, tab_id: run!.tabId } })]);
      // the slot is free: the next tick starts a card again (max_parallel 1)
      await tickOnce(deps);
      expect(startAgent).toHaveBeenCalledTimes(2);
      expect([first.id, second.id]).toContain((await runsOf()).find((r) => r.status === 'running')?.taskId);
    });

    it('a cleanup due on a run whose tab was closed settles once the run is cancelled', async () => {
      const c = await card();
      const { deps, removeWorkspace } = makeDeps();
      await tickOnce(deps);
      const [run] = await runsOf();
      await repos.automationRuns.markCleanupDue([c.id]);
      await tickOnce(deps);
      expect(removeWorkspace).not.toHaveBeenCalled(); // held by the active run
      await followRun(followerDeps(deps.instance), run!.id);
      await tickOnce(deps);
      expect(removeWorkspace).toHaveBeenCalledTimes(1);
      expect((await db.automationRun.findUnique({ where: { id: run!.id } }))!.cleanupState).toBe('done');
    });

    it('a run parked for the person on a card that lost its tag is cancelled', async () => {
      const c = await card();
      const tab = await repos.tabs.create(projectId, machineId, 'auto');
      const run = (await repos.automationRuns.claim({ project_id: projectId, task_id: c.id, role: 'implementer', instance: 'me' }))!;
      await repos.automationRuns.update(run.id, 'me', { status: 'waiting', waiting_reason: 'permission_needed', tab_id: tab.id });
      await db.tab.update({ where: { id: tab.id }, data: { state: 'working', stateAt: new Date() } });
      await followRun(followerDeps('me'), run.id);
      expect((await db.automationRun.findUnique({ where: { id: run.id } }))!.status).toBe('waiting');
      await repos.tasks.setAuto(c.id, false);
      await followRun(followerDeps('me'), run.id);
      expect(await db.automationRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'cancelled', waitingReason: UNTAGGED });
      expect((await eventsOf()).map((e) => e.kind)).toEqual(['run_cancelled']);
    });

    it('takeover: a starting run that already has a tab is adopted as running and followed, not deleted', async () => {
      const c = await card();
      const run = (await repos.automationRuns.claim({ project_id: projectId, task_id: c.id, role: 'implementer', instance: 'dead' }))!;
      await repos.automationRuns.update(run.id, 'dead', { status: 'starting', tab_id: 'tab-live', branch: 'b' });
      await db.automationRun.updateMany({ where: { projectId }, data: { heartbeatAt: new Date(Date.now() - 5 * 60_000) } });
      const onTakeOver = vi.fn();
      const { deps, startAgent } = makeDeps({ onTakeOver });
      const d = startDispatcher(deps, { schedule: false });
      await d.heartbeat();
      const row = await db.automationRun.findUnique({ where: { id: run.id } });
      expect(row).toMatchObject({ status: 'running', claimedBy: deps.instance, tabId: 'tab-live' });
      expect(row!.startedAt).toBeInstanceOf(Date);
      expect(onTakeOver).toHaveBeenCalledWith(expect.objectContaining({ id: run.id, status: 'running' }));
      expect((await eventsOf()).find((e) => e.kind === 'run_started')?.payload).toMatchObject({ tab_id: 'tab-live', adopted: true });
      // the card keeps its one run: no second start
      await d.tick('t');
      await d.settle();
      expect(startAgent).not.toHaveBeenCalled();
    });

    it('a running write that throws once is tried again: the run is running', async () => {
      await card();
      const { deps } = makeDeps();
      const runs = Object.create(repos.automationRuns) as Repositories['automationRuns'];
      let failed = 0;
      runs.update = async (id, instance, patch) => {
        if (patch.status === 'running' && failed++ === 0) throw new Error('db hiccup');
        return repos.automationRuns.update(id, instance, patch);
      };
      await tickOnce({ ...deps, repos: { ...repos, automationRuns: runs } });
      expect((await runsOf())[0]).toMatchObject({ status: 'running' });
    });

    it('a running write that keeps throwing: the tab is closed and the run is not left starting', async () => {
      const c = await card();
      const { deps, closeTab } = makeDeps();
      const runs = Object.create(repos.automationRuns) as Repositories['automationRuns'];
      runs.update = async (id, instance, patch) => {
        if (patch.status === 'running') throw new Error('db down for this write');
        return repos.automationRuns.update(id, instance, patch);
      };
      await tickOnce({ ...deps, repos: { ...repos, automationRuns: runs } });
      expect(closeTab).toHaveBeenCalledWith(expect.anything(), `tab-${c.id}`);
      expect((await runsOf())[0]).toMatchObject({ status: 'failed', waitingReason: 'RUN_NOT_RECORDED', tabId: `tab-${c.id}` });
    });
  });
});
