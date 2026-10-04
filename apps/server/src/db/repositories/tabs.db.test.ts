import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { needsYou } from '../../monitor/state.js';
import { AiAccountsRepository } from './ai-accounts.js';
import { ApiTokensRepository } from './api-tokens.js';
import { TabsRepository } from './tabs.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see tasks.db.test.ts / the plan for the local Docker recipe).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TabsRepository.markSeen / clearState (Postgres)', () => {
  let db: PrismaClient;
  let repo: TabsRepository;
  let machineId: string;
  let projectId: string;
  let tabId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TabsRepository(db);
  });

  beforeEach(async () => {
    machineId = newId();
    projectId = newId();
    tabId = newId();
    await db.machine.create({ data: { id: machineId, name: 'test', type: 'agent' } });
    await db.project.create({ data: { id: projectId, key: 'K' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p' } });
    await db.projectMachine.create({ data: { id: newId(), projectId, machineId, cwd: '/tmp' } });
    await db.tab.create({ data: { id: tabId, projectId, machineId, name: 't', tmuxSession: `th-${tabId}` } });
    return async () => {
      await db.project.delete({ where: { id: projectId } }); // cascades link and tab
      await db.machine.delete({ where: { id: machineId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('writes state_seen_at for a tab waiting for the person', async () => {
    await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Posso seguir?' });
    const now = new Date();
    const updated = await repo.markSeen(tabId, now);
    expect(updated?.state_seen_at).toBe(now.toISOString());
  });

  it('returns undefined for a tab that is not waiting (working, idle, or never reported)', async () => {
    expect(await repo.markSeen(tabId)).toBeUndefined(); // state is null: never reported

    await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null });
    expect(await repo.markSeen(tabId)).toBeUndefined();

    await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null });
    expect(await repo.markSeen(tabId)).toBeUndefined();
  });

  it('returns undefined when already seen for the current state_at', async () => {
    await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
    expect(await repo.markSeen(tabId)).toBeDefined();
    expect(await repo.markSeen(tabId)).toBeUndefined(); // already seen, state_at unchanged
  });

  it('needs you again after a new hook event bumps state_at, and markSeen writes again', async () => {
    await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'first?' });
    const firstSeen = await repo.markSeen(tabId);
    expect(firstSeen).toBeDefined();

    await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'second?' });
    const reloaded = await repo.findById(tabId);
    expect(reloaded?.state_seen_at).toBe(firstSeen!.state_seen_at); // stale: older than the new state_at

    const secondSeen = await repo.markSeen(tabId);
    expect(secondSeen).toBeDefined();
    expect(secondSeen!.state_seen_at).not.toBe(firstSeen!.state_seen_at);
  });

  it('clearState also clears state_seen_at', async () => {
    await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
    await repo.markSeen(tabId);
    await repo.clearState(tabId);
    const cleared = await repo.findById(tabId);
    expect(cleared).toMatchObject({ state: null, state_at: null, state_seen_at: null });
  });

  it('finds tabs by id in one query, filtered to one owner — another owner\'s tab does not resolve', async () => {
    const ownerId = newId();
    const otherOwnerId = newId();
    const ownedMachineId = newId();
    const otherMachineId = newId();
    const ownedProjectId = newId();
    const otherProjectId = newId();
    const ownedTabId = newId();
    const otherTabId = newId();
    await db.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' },
      { id: otherOwnerId, email: `${otherOwnerId}@test.local`, name: 'other' },
    ] });
    try {
      await db.machine.createMany({ data: [
        { id: ownedMachineId, name: 'mine', type: 'agent', ownerId },
        { id: otherMachineId, name: 'theirs', type: 'agent', ownerId: otherOwnerId },
      ] });
      await db.project.createMany({ data: [
        { id: ownedProjectId, ownerId, key: 'K' + ownedProjectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p' },
        { id: otherProjectId, ownerId: otherOwnerId, key: 'K' + otherProjectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p2' },
      ] });
      await db.projectMachine.createMany({ data: [
        { id: newId(), projectId: ownedProjectId, machineId: ownedMachineId, cwd: '/tmp' },
        { id: newId(), projectId: otherProjectId, machineId: otherMachineId, cwd: '/tmp' },
      ] });
      await db.tab.createMany({ data: [
        { id: ownedTabId, projectId: ownedProjectId, machineId: ownedMachineId, name: 'mine', tmuxSession: `th-${ownedTabId}` },
        { id: otherTabId, projectId: otherProjectId, machineId: otherMachineId, name: 'theirs', tmuxSession: `th-${otherTabId}` },
      ] });

      const found = await repo.findByIdsForOwner([ownedTabId, otherTabId, 'nope'], ownerId);
      expect(found.map((t) => t.id)).toEqual([ownedTabId]); // another owner's tab is absent, indistinguishable from "does not exist"
      expect(await repo.findByIdsForOwner([], ownerId)).toEqual([]);
    } finally {
      await db.project.deleteMany({ where: { id: { in: [ownedProjectId, otherProjectId] } } }); // cascades links and tabs
      await db.machine.deleteMany({ where: { id: { in: [ownedMachineId, otherMachineId] } } });
      await db.user.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } });
    }
  });

  it('listByProjects returns the tabs of the given projects in tab-bar order, and nothing for none', async () => {
    const second = newId();
    await db.tab.create({ data: { id: second, projectId, machineId, name: 'second', position: 1, tmuxSession: `th-${second}` } });
    expect((await repo.listByProjects([projectId])).map((t) => t.id)).toEqual([tabId, second]);
    expect(await repo.listByProjects([])).toEqual([]);
  });

  describe('created_by_token_id / countOpenByToken', () => {
    it('records which token opened a tab and counts the ones still open', async () => {
      const a = await repo.create(projectId, machineId, 'T1', { created_by_token_id: 'tok1' });
      await repo.create(projectId, machineId, 'T2', { created_by_token_id: 'tok1' });
      await repo.create(projectId, machineId, 'T3');

      expect(a.created_by_token_id).toBe('tok1');
      expect(await repo.countOpenByToken('tok1')).toBe(2);
      expect(await repo.countOpenByToken('tok2')).toBe(0);

      await repo.delete(a.id);
      expect(await repo.countOpenByToken('tok1')).toBe(1);
    });
  });

  describe('delete', () => {
    it('revokes the tab\'s live token in the same transaction; another tab\'s token stays live', async () => {
      const apiTokens = new ApiTokensRepository(db);
      const userId = newId();
      await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'u' } });
      const other = await repo.create(projectId, machineId, 'other');
      const mine = await apiTokens.create(userId, { name: 'aba', scopes: ['read', 'memory'], expiresAt: null, tabId }, newId(32));
      const otherTok = await apiTokens.create(userId, { name: 'aba2', scopes: ['read', 'memory'], expiresAt: null, tabId: other.id }, newId(32));

      expect(await repo.delete(tabId)).toBe(true);

      const rows = await apiTokens.listByUser(userId);
      expect(rows.find((t) => t.id === mine.id)?.revoked_at).not.toBeNull();
      expect(rows.find((t) => t.id === otherTok.id)?.revoked_at).toBeNull();

      await db.user.delete({ where: { id: userId } }); // cascades the tokens
    });
  });

  describe('recordEvent — a background subagent never takes the tab out of its main thread\'s wait (TER-615)', () => {
    const sub = (tool: string, agent_id?: string) => ({ kind: 'working' as const, tool: 'claude', text: null, meta: { event: 'PreToolUse', tool, subagent: true, ...(agent_id ? { agent_id } : {}) } });

    it('replays the hulk tab of 2026-09-30: every Stop and the question stay waiting', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Pronto.', meta: { event: 'Stop', background_tasks: 2 } });
      const afterStop = await repo.recordEvent(tabId, sub('Read'));
      expect(afterStop.event).toBeNull();
      expect(afterStop.tab).toMatchObject({ state: 'waiting_input', state_text: 'Pronto.' });
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Claude is waiting for your input', meta: { event: 'Notification', type: 'idle_prompt' }, continuesWait: true, keepsWaitText: true });
      expect((await repo.recordEvent(tabId, sub('Bash'))).tab.state).toBe('waiting_input');
      // the subagent's message wakes the main thread, which asks a question
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
      await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'Claude needs your permission', meta: { event: 'Notification', type: 'permission_prompt' } });
      const handback = await repo.recordEvent(tabId, sub('SubagentHandback'));
      expect(handback.event).toBeNull();
      expect(handback.tab).toMatchObject({ state: 'waiting_permission', state_text: 'Claude needs your permission' });
    });

    it('a subagent is back at work once the person approved its own prompt', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null, meta: { event: 'Stop', background_tasks: 1 } });
      await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: null, meta: { event: 'PermissionRequest', tool: 'Bash', subagent: true, agent_id: 'a1' } });
      await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'Claude needs your permission', meta: { event: 'Notification', type: 'permission_prompt' } });
      expect((await repo.recordEvent(tabId, sub('Read', 'a2'))).tab.state).toBe('waiting_permission');
      const approved = await repo.recordEvent(tabId, sub('Bash', 'a1'));
      expect(approved.event).not.toBeNull();
      expect(approved.tab.state).toBe('working');
    });
  });

  describe('recordEvent — a turn that ends on its own background work (TER-644)', () => {
    const sub = (tool: string) => ({ kind: 'working' as const, tool: 'claude', text: null, meta: { event: 'PreToolUse', tool, subagent: true, agent_id: 'a1' } });
    const idlePrompt = { kind: 'waiting_input' as const, tool: 'claude', text: 'Claude is waiting for your input', meta: { event: 'Notification', type: 'idle_prompt' }, continuesWait: true as const, keepsWaitText: true as const };

    it('replays OPM-440: the tab waits on its subagent, never on the person, until the agent really stops', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
      const stop = await repo.recordEvent(tabId, { kind: 'waiting_background', tool: 'claude', text: 'Aguardando o subagente da Tarefa 2.', meta: { event: 'Stop', background_tasks: 1 } });
      expect(stop.tab).toMatchObject({ state: 'waiting_background', state_text: 'Aguardando o subagente da Tarefa 2.' });
      expect(needsYou(stop.tab)).toBe(false);
      // the subagent's tool calls and the reminder a minute later leave it there
      expect((await repo.recordEvent(tabId, sub('Bash'))).event).toBeNull();
      const reminder = await repo.recordEvent(tabId, idlePrompt);
      expect(reminder.event).toBeNull();
      expect(reminder.tab.state).toBe('waiting_background');
      expect(await repo.countBusyByMachine(machineId)).toBe(1);
      // the subagent reports: the main thread works again, then ends for good and waits for the person
      expect((await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'PreToolUse', tool: 'Read' } })).tab.state).toBe('working');
      const done = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Revisão pronta.', meta: { event: 'Stop' } });
      expect(done.tab.state).toBe('waiting_input');
      expect(needsYou(done.tab)).toBe(true);
    });

    it('is looked at again when it goes quiet, and the screen check writes over it under ifStateAt', async () => {
      const { tab } = await repo.recordEvent(tabId, { kind: 'waiting_background', tool: 'claude', text: null, meta: { event: 'Stop', background_tasks: 2 } });
      expect((await repo.listStaleWorking(new Date(Date.parse(tab.state_at!) + 1))).map((t) => t.id)).toContain(tabId);
      const exited = await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: 'Agente encerrado sem terminar o turno', meta: { event: 'AgentExited', pane: 'shell' }, ifStateAt: tab.state_at! });
      expect(exited.event).not.toBeNull();
      expect(exited.tab.state).toBe('idle');
    });
  });

  describe('stale working tabs (TER-615)', () => {
    it('lists Claude and Codex terminal tabs working with nothing since the cut, oldest first (TER-643: Codex too)', async () => {
      const { tab } = await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
      const later = new Date(Date.parse(tab.state_at!) + 1);
      expect((await repo.listStaleWorking(later)).map((t) => t.id)).toContain(tabId);
      expect((await repo.listStaleWorking(new Date(Date.parse(tab.state_at!)))).map((t) => t.id)).not.toContain(tabId);
      await repo.recordEvent(tabId, { kind: 'working', tool: 'codex', text: null, meta: { event: 'UserPromptSubmit' } });
      expect((await repo.listStaleWorking(new Date(Date.now() + 1000))).map((t) => t.id)).toContain(tabId);
      await repo.recordEvent(tabId, { kind: 'working', tool: 'cursor', text: null, meta: { event: 'beforeSubmitPrompt' } });
      expect((await repo.listStaleWorking(new Date(Date.now() + 1000))).map((t) => t.id)).not.toContain(tabId);
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null, meta: { event: 'Stop' } });
      expect((await repo.listStaleWorking(new Date(Date.now() + 1000))).map((t) => t.id)).not.toContain(tabId);
    });

    it('ifStateAt: writes only when the tab is still working since that moment', async () => {
      const { tab } = await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
      const read = tab.state_at!;
      // a hook landed between the screen capture and the write
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
      const late = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null, meta: { event: 'ScreenCheck', screen: 'prompt' }, ifStateAt: read });
      expect(late.event).toBeNull();
      expect(late.tab.state).toBe('working');
      const fresh = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null, meta: { event: 'ScreenCheck', screen: 'prompt' }, ifStateAt: late.tab.state_at! });
      expect(fresh.event).not.toBeNull();
      expect(fresh.tab).toMatchObject({ state: 'waiting_input', state_seen_at: null });
    });
  });

  describe('recordEvent — the same wait (Claude: Stop, then idle_prompt ~1min later) stays seen, a new one re-arms', () => {
    it('carries the seen mark forward: seen waiting_input + a waiting_input that continues it stays seen', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'first?' });
      await repo.markSeen(tabId);
      const { tab: updated } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null, continuesWait: true });
      expect(needsYou(updated)).toBe(false);
      expect(updated.state_seen_at).toBe(updated.state_at);
    });

    it('re-arms on a seen waiting_input followed by a new wait (the next Codex turn, which sends no working in between)', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'codex', text: 'um' });
      await repo.markSeen(tabId);
      const { tab: second } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'codex', text: 'dois' });
      expect(needsYou(second)).toBe(true);
      expect(second.state_text).toBe('dois');
      await repo.markSeen(tabId);
      const { tab: third } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'codex', text: 'tres' });
      expect(needsYou(third)).toBe(true);
    });

    it('a continuation with no text keeps the text of the wait it continues (Cursor: an answer, then a stop that is not completed)', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: 'dois' });
      await repo.markSeen(tabId);
      const { tab: seen } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: null, continuesWait: true });
      expect(needsYou(seen)).toBe(false);
      expect(seen.state_text).toBe('dois');
    });

    it('keeps the text even while the wait is still unseen, and never re-arms nor silences it', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: 'dois' });
      const { tab } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: null, continuesWait: true });
      expect(needsYou(tab)).toBe(true);
      expect(tab.state_text).toBe('dois');
    });

    it("a continuation that keepsWaitText keeps the wait's text when it has one: Claude's idle_prompt no longer replaces the Stop's message (spec 2026-09-26 §6.1)", async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Posso seguir?' });
      const { tab, event } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Claude is waiting for your input', continuesWait: true, keepsWaitText: true });
      expect(tab.state_text).toBe('Posso seguir?');
      expect(event.text).toBe('Claude is waiting for your input'); // the event row keeps what the event said
    });

    it('a continuation that keepsWaitText brings its own text when the wait has none (a Claude Code older than 2.1.47 sends no message on Stop)', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
      const { tab } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Claude is waiting for your input', continuesWait: true, keepsWaitText: true });
      expect(tab.state_text).toBe('Claude is waiting for your input');
    });

    it("a continuation that does not keepsWaitText replaces a stale wait text with its own fresh answer (Cursor's afterAgentResponse, spec 2026-09-26 §6.1 fix)", async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: 'um' });
      const { tab } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: 'dois', continuesWait: true });
      expect(tab.state_text).toBe('dois');
    });

    it('Esc mid-turn: the first stop opens the wait, the second one does not alert again once seen', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'cursor', text: null });
      const { tab: first } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: null, continuesWait: true });
      expect(needsYou(first)).toBe(true);
      await repo.markSeen(tabId);
      const { tab: second } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: null, continuesWait: true });
      expect(needsYou(second)).toBe(false);
    });

    it('a lost answer leaves the tab working, and the stop that follows opens the wait (Cursor)', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'cursor', text: null });
      const { tab } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: null, continuesWait: true });
      expect(needsYou(tab)).toBe(true);
      expect(tab.state_text).toBeNull();
    });

    it('inverted Cursor race: stop before afterAgentResponse ends with the answer text and still needs you', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'cursor', text: null });
      const { tab: stop } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: null, continuesWait: true });
      expect(needsYou(stop)).toBe(true);
      expect(stop.state_text).toBeNull();
      const { tab: answer } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: 'Pronto.', continuesWait: true });
      expect(needsYou(answer)).toBe(true);
      expect(answer.state_text).toBe('Pronto.');
    });

    it('inverted Cursor race: opening the tab between stop and answer keeps one alert', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'cursor', text: null });
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: null, continuesWait: true });
      await repo.markSeen(tabId);
      const { tab: answer } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: 'Pronto.', continuesWait: true });
      expect(needsYou(answer)).toBe(false);
      expect(answer.state_text).toBe('Pronto.');
    });

    it('never carries a seen mark the tab does not have, even for a continuation', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null });
      await repo.markSeen(tabId);
      const { tab: updated } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null, continuesWait: true });
      expect(needsYou(updated)).toBe(true);
    });

    it('re-arms once the wait passes through another state (working) before returning to waiting_input', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'first?' });
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null });
      const { tab: updated } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
      expect(needsYou(updated)).toBe(true);
    });

    it('re-arms on waiting_permission right after a seen waiting_input (a permission prompt is always a new ask)', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'first?' });
      await repo.markSeen(tabId);
      const { tab: updated } = await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'Allow Bash?' });
      expect(needsYou(updated)).toBe(true);
    });

    it('re-arms on a second waiting_permission even if the previous one was also seen', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'first?' });
      await repo.markSeen(tabId);
      const { tab: updated } = await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'second?' });
      expect(needsYou(updated)).toBe(true);
    });

    it('an unseen waiting_input still needs you after another waiting_input (nothing to carry)', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'first?' });
      const { tab: updated } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
      expect(needsYou(updated)).toBe(true);
    });
  });

  describe('recordEvent — a reminder with nothing new in it does not alert (spec 2026-09-29)', () => {
    const idlePrompt = { kind: 'waiting_input' as const, tool: 'claude', text: 'Claude is waiting for your input', meta: { event: 'Notification', type: 'idle_prompt' }, continuesWait: true, keepsWaitText: true };
    const stop = (text: string) => ({ kind: 'waiting_input' as const, tool: 'claude', text, meta: { event: 'Stop' } });
    const working = (name: string) => ({ kind: 'working' as const, tool: 'claude', text: null, meta: { event: name } });

    it('/clear on a seen wait, then idle_prompt: the tab waits again, already seen', async () => {
      await repo.recordEvent(tabId, stop('Pronto.'));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd', reason: 'clear' } });
      await repo.recordEvent(tabId, working('SessionStart'));
      const { tab, event, rearm } = await repo.recordEvent(tabId, idlePrompt);
      expect(event).not.toBeNull();
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(false);
      expect(tab.state_seen_at).toBe(tab.state_at);
      expect(rearm).toBeNull();
    });

    it('a reply typed from termhub that started no turn, then idle_prompt: no alert', async () => {
      await repo.recordEvent(tabId, stop('Pronto.'));
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'input', via: 'termhub' } });
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(false);
    });

    it('a turn whose Stop was lost: idle_prompt is what ends it, and it alerts', async () => {
      await repo.recordEvent(tabId, stop('antes'));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, working('UserPromptSubmit'));
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(true);
    });

    it('a compaction in the middle of a turn, then a lost Stop: idle_prompt still alerts', async () => {
      await repo.recordEvent(tabId, stop('antes'));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, working('UserPromptSubmit'));
      await repo.recordEvent(tabId, working('SessionStart'));
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(needsYou(tab)).toBe(true);
    });

    it('tool calls after a quiet start leave no row, only the activity: idle_prompt alerts', async () => {
      await repo.recordEvent(tabId, working('SessionStart'));
      await repo.setActivity(tabId, 'coding', null);
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(needsYou(tab)).toBe(true);
    });

    it('idle_prompt over a permission prompt the person saw: the tab waits for input, still seen', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'Allow Bash?', meta: { event: 'Notification', type: 'permission_prompt' } });
      await repo.markSeen(tabId);
      const { tab, event } = await repo.recordEvent(tabId, idlePrompt);
      expect(event).not.toBeNull();
      expect(tab.state).toBe('waiting_input');
      expect(tab.state_text).toBe('Claude is waiting for your input');
      expect(needsYou(tab)).toBe(false);
    });

    it('idle_prompt over a permission prompt the person did not see: still needs them', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'Allow Bash?', meta: { event: 'Notification', type: 'permission_prompt' } });
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(true);
    });

    it('nothing is dropped because a session ended: Codex in a tab where Claude ended still alerts, turn after turn', async () => {
      await repo.recordEvent(tabId, working('UserPromptSubmit'));
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd', reason: 'exit' } });
      const codex = (text: string) => ({ kind: 'waiting_input' as const, tool: 'codex', text, meta: { event: 'agent-turn-complete' } });
      const first = await repo.recordEvent(tabId, codex('um'));
      expect(first.event).not.toBeNull();
      expect(needsYou(first.tab)).toBe(true);
      await repo.markSeen(tabId);
      const second = await repo.recordEvent(tabId, codex('dois'));
      expect(second.event).not.toBeNull();
      expect(needsYou(second.tab)).toBe(true);
      expect(second.tab.state_text).toBe('dois');
    });

    it("the account swap's own wait after the session ended is recorded and alerts", async () => {
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd' } });
      const { tab, event } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Conta trocada', meta: { event: 'AccountSwap' } });
      expect(event).not.toBeNull();
      expect(needsYou(tab)).toBe(true);
    });

    it('idle_prompt on a tab whose session ended: the tab waits, already seen', async () => {
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd', reason: 'exit' } });
      const { tab, event } = await repo.recordEvent(tabId, idlePrompt);
      expect(event).not.toBeNull();
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(false);
    });

    it('a look that commits while an event waits for the row lock does not hide the wait that event opens', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'codex', text: 'um', meta: { event: 'agent-turn-complete' } });
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const hasLock = new Promise<void>((resolve) => (locked = resolve));
      // another transaction holds the tab's row, then writes the look and commits
      const holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "tabs" WHERE "id" = ${tabId} FOR UPDATE`;
          locked();
          await held;
          await tx.$executeRaw`UPDATE "tabs" SET "state_seen_at" = ${new Date()} WHERE "id" = ${tabId}`;
        },
        { timeout: 10_000 },
      );
      await hasLock;
      // the next turn arrives and waits for the lock
      const pending = repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'codex', text: 'dois', meta: { event: 'agent-turn-complete' } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      await holder;
      const { tab } = await pending;
      expect(tab.state_text).toBe('dois');
      expect(needsYou(tab)).toBe(true);
    });
  });

  describe('recordEvent — a Cursor session start that arrives after its own prompt', () => {
    it('is dropped: no row is written and the tab keeps working, with the time of its prompt', async () => {
      const { tab: prompted } = await repo.recordEvent(tabId, { kind: 'working', tool: 'cursor', text: null, meta: { event: 'beforeSubmitPrompt' } });
      const before = await repo.listEvents(tabId);
      const { tab, event, rearm } = await repo.recordEvent(tabId, { kind: 'idle', tool: 'cursor', text: null, meta: { event: 'sessionStart' } });
      expect(event).toBeNull();
      expect(rearm).toBeNull();
      expect(tab.state).toBe('working');
      expect(tab.state_at).toBe(prompted.state_at);
      expect((await repo.listEvents(tabId)).map((e) => e.id)).toEqual(before.map((e) => e.id));
    });

    it('is recorded on a tab that is not in a fresh turn', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: 'Pronto.', meta: { event: 'afterAgentResponse' }, continuesWait: true });
      const { tab, event } = await repo.recordEvent(tabId, { kind: 'idle', tool: 'cursor', text: null, meta: { event: 'sessionStart' } });
      expect(event).not.toBeNull();
      expect(tab.state).toBe('idle');
    });
  });

  describe('recordEvent — reports a wait the person had seen that alerts again with no prompt of theirs', () => {
    const stop = (text: string, background = 0) => ({ kind: 'waiting_input' as const, tool: 'claude', text, meta: background > 0 ? { event: 'Stop', background_tasks: background } : { event: 'Stop' } });

    it('an answer nobody asked for, after a Stop that left background tasks running', async () => {
      await repo.recordEvent(tabId, stop('um', 2));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'PreToolUse', tool: 'Bash' } });
      const { rearm, tab } = await repo.recordEvent(tabId, stop('dois'));
      expect(needsYou(tab)).toBe(true);
      expect(rearm).toEqual({ previous: 'PreToolUse', background: true, afterSessionEnd: false });
    });

    it('a wait that lands after the session ended', async () => {
      await repo.recordEvent(tabId, stop('um'));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd' } });
      const { rearm, tab } = await repo.recordEvent(tabId, stop('dois'));
      expect(needsYou(tab)).toBe(true);
      expect(rearm).toEqual({ previous: 'SessionEnd', background: false, afterSessionEnd: true });
    });

    it('is null when the person asked for the turn', async () => {
      await repo.recordEvent(tabId, stop('um'));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
      const { rearm, tab } = await repo.recordEvent(tabId, stop('dois'));
      expect(needsYou(tab)).toBe(true);
      expect(rearm).toBeNull();
    });

    it('is null when the wait before it had not been seen, and for the first wait of a tab', async () => {
      const first = await repo.recordEvent(tabId, stop('um'));
      expect(first.rearm).toBeNull();
      const second = await repo.recordEvent(tabId, stop('dois'));
      expect(second.rearm).toBeNull();
    });
  });

  describe('activity', () => {
    it('recordEvent stores the activity of a working event and clears it when the tab leaves working', async () => {
      const { tab } = await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'coding' });
      expect(tab.activity).toBe('coding');
      const waiting = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'q?' });
      expect(waiting.tab.activity).toBeNull();
      const again = await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null });
      expect(again.tab.activity).toBeNull(); // working with no activity known
    });

    it('setActivity changes only the activity and the time, with no event row', async () => {
      const { tab: before } = await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'coding' });
      const events = await db.tabEvent.count({ where: { tabId } });
      const updated = await repo.setActivity(tabId, 'reading', null);
      expect(updated?.activity).toBe('reading');
      expect(updated?.state).toBe('working');
      expect(updated?.state_text).toBe(before.state_text);
      expect(await db.tabEvent.count({ where: { tabId } })).toBe(events);
      expect(new Date(updated!.state_at!).getTime()).toBeGreaterThanOrEqual(new Date(before.state_at!).getTime());
    });

    it('setActivity writes nothing once the tab has left working (a Stop landing between the read and the write)', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'coding' });
      const { tab: stopped } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'q?' });
      expect(await repo.setActivity(tabId, 'reading', null)).toBeUndefined();
      const reloaded = await repo.findById(tabId);
      expect(reloaded?.activity).toBeNull(); // a waiting tab never reads as coding
      expect(reloaded?.state).toBe('waiting_input');
      expect(reloaded?.state_at).toBe(stopped.state_at); // and its wait is not pushed past state_seen_at
    });

    it('setActivity returns undefined for a tab that does not exist', async () => {
      expect(await repo.setActivity(newId(), 'reading', null)).toBeUndefined();
    });

    it('recordEvent stores the spinner verb of a working event and clears it with the activity', async () => {
      const { tab } = await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'coding', activityVerb: 'Moonwalking' });
      expect(tab.activity_verb).toBe('Moonwalking');
      const again = await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'coding' });
      expect(again.tab.activity_verb).toBeNull();
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'coding', activityVerb: 'Brewing' });
      // a verb sent along with a non-working state is never kept
      const waiting = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'q?', activityVerb: 'Brewing' });
      expect(waiting.tab.activity_verb).toBeNull();
    });

    it('setActivity moves the verb with the activity, and only on a working tab', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'coding', activityVerb: 'Brewing' });
      expect((await repo.setActivity(tabId, 'coding', 'Musing'))?.activity_verb).toBe('Musing');
      expect((await repo.setActivity(tabId, 'reading', null))?.activity_verb).toBeNull();
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'q?' });
      expect(await repo.setActivity(tabId, 'reading', 'Pondering')).toBeUndefined();
      expect((await repo.findById(tabId))?.activity_verb).toBeNull();
    });

    it('clearState clears the verb too', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'terminal', activityVerb: 'Brewing' });
      await repo.clearState(tabId);
      expect((await repo.findById(tabId))?.activity_verb).toBeNull();
    });

    it('clearState clears the activity too', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'terminal' });
      await repo.clearState(tabId);
      expect((await repo.findById(tabId))?.activity).toBeNull();
    });
  });

  describe('setAgentFields (spec 2026-09-26 account swap)', () => {
    let aiAccounts: AiAccountsRepository;

    beforeAll(() => {
      aiAccounts = new AiAccountsRepository(db);
    });

    it('setAgentFields stores and clears the agent session, account and limit', async () => {
      const account = await aiAccounts.create({ provider: 'claude', label: 'conta', machine_id: machineId });
      const SID = 'a1b2c3d4-0000-4000-8000-000000000000';
      const at = new Date('2026-09-26T05:00:00Z');
      const t = await repo.setAgentFields(tabId, {
        agent_session_id: SID,
        agent_transcript_path: `/h/.claude/projects/-p/${SID}.jsonl`,
        ai_account_id: account.id,
        rate_limited_at: at,
      });
      expect(t).toMatchObject({ agent_session_id: SID, ai_account_id: account.id, rate_limited_at: at.toISOString() });
      const cleared = await repo.setAgentFields(tabId, { rate_limited_at: null });
      expect(cleared).toMatchObject({ agent_session_id: SID, rate_limited_at: null });
    });

    it('setAgentFields on a missing tab answers undefined', async () => {
      expect(await repo.setAgentFields('nope', { rate_limited_at: null })).toBeUndefined();
    });

    it('deleting the account keeps the tab and forgets the account', async () => {
      const account = await aiAccounts.create({ provider: 'claude', label: 'conta', machine_id: machineId });
      await repo.setAgentFields(tabId, { ai_account_id: account.id });
      await aiAccounts.delete(account.id);
      expect((await repo.findById(tabId))?.ai_account_id).toBeNull();
    });
  });
  describe('the last answer (spec 2026-09-30)', () => {
    it('recordEvent stores the answer an event carries, and leaves it when an event carries none', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
      expect(await repo.readLastAnswer(tabId)).toBeNull();

      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'resposta…', meta: { event: 'Stop' }, answer: 'resposta inteira, de verdade' });
      const first = await repo.readLastAnswer(tabId);
      expect(first).toMatchObject({ text: 'resposta inteira, de verdade', tool: 'claude', stale: false });
      expect(Date.parse(first!.at)).toBeGreaterThan(0);

      // A reminder carries no answer: the stored one stays, time included, and it is not stale.
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Claude is waiting for your input', meta: { event: 'Notification', type: 'idle_prompt' }, continuesWait: true, keepsWaitText: true });
      expect(await repo.readLastAnswer(tabId)).toEqual(first);

      // A new turn makes it stale; its answer replaces it.
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
      expect(await repo.readLastAnswer(tabId)).toMatchObject({ text: 'resposta inteira, de verdade', stale: true });
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'outra', meta: { event: 'Stop' }, answer: 'outra resposta' });
      expect(await repo.readLastAnswer(tabId)).toMatchObject({ text: 'outra resposta', stale: false });
    });

    it('a dropped event writes no answer, even one it carries', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: 'r', meta: { event: 'afterAgentResponse' }, continuesWait: true, answer: 'r inteira' });
      // The sequence pinned above as dropped: a Cursor sessionStart right after its own prompt.
      await repo.recordEvent(tabId, { kind: 'working', tool: 'cursor', text: null, meta: { event: 'beforeSubmitPrompt' } });
      const { event } = await repo.recordEvent(tabId, { kind: 'idle', tool: 'cursor', text: null, meta: { event: 'sessionStart' }, answer: 'nova' });
      expect(event).toBeNull();
      expect(await repo.readLastAnswer(tabId)).toMatchObject({ text: 'r inteira', tool: 'cursor', stale: true });
    });

    it('a session end and clearState leave the answer; the Tab row never carries it; the tab takes it along', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: 'r', meta: { event: 'afterAgentResponse' }, continuesWait: true, answer: 'r inteira' });
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'cursor', text: null, meta: { event: 'sessionEnd' } });
      await repo.clearState(tabId);
      expect((await repo.readLastAnswer(tabId))!.text).toBe('r inteira');
      const row = await repo.findById(tabId);
      expect(JSON.stringify(row)).not.toContain('r inteira');
      await db.tab.delete({ where: { id: tabId } });
      expect(await db.tabLastAnswer.findUnique({ where: { tabId } })).toBeNull();
    });

    it('a SessionStart after the answer does not make it stale (/compact, /clear, a resume)', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'r', meta: { event: 'Stop' }, answer: 'r inteira' });
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'SessionStart' } });
      expect(await repo.readLastAnswer(tabId)).toMatchObject({ text: 'r inteira', stale: false });
    });

    it("a subagent's working event after the answer does not make it stale (a background agent)", async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'r', meta: { event: 'Stop' }, answer: 'r inteira' });
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'PreToolUse', tool: 'Bash', subagent: true } });
      expect(await repo.readLastAnswer(tabId)).toMatchObject({ text: 'r inteira', stale: false });
      // The main agent's own tool call is a new turn's work: that one does.
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'PreToolUse', tool: 'Bash' } });
      expect(await repo.readLastAnswer(tabId)).toMatchObject({ text: 'r inteira', stale: true });
    });
  });
});

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TabsRepository.listOpenTerminals / listByMachine (Postgres)', () => {
  let db: PrismaClient;
  let repo: TabsRepository;
  let ownerId: string;
  let mine: string;
  let theirs: string;
  let projectId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TabsRepository(db);
  });

  beforeEach(async () => {
    ownerId = newId();
    mine = newId();
    theirs = newId();
    projectId = newId();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'o' } });
    await db.machine.createMany({ data: [
      { id: mine, name: 'mine', type: 'agent', ownerId },
      { id: theirs, name: 'theirs', type: 'agent' },
    ] });
    await db.project.create({ data: { id: projectId, key: 'K' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p', ownerId } });
    return async () => {
      await db.project.delete({ where: { id: projectId } });
      await db.machine.deleteMany({ where: { id: { in: [mine, theirs] } } });
      await db.user.delete({ where: { id: ownerId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('lists every terminal tab on the owner\'s machines, reported a state or not, in tab-bar order', async () => {
    const b = await repo.create(projectId, mine, 'Bia');
    const a = await repo.create(projectId, mine, 'Ana');
    await repo.create(projectId, mine, 'Sim', { kind: 'simulator' });
    await repo.create(projectId, theirs, 'Caio');
    await repo.recordEvent(a.id, { kind: 'working', tool: 'claude', text: null });

    expect((await repo.listOpenTerminals(ownerId)).map((t) => t.name)).toEqual([b.name, a.name]); // position order, never-reported included
    expect((await repo.listOpenTerminals(null)).map((t) => t.name)).toEqual(expect.arrayContaining(['Bia', 'Ana', 'Caio']));
    expect((await repo.listOpenTerminals(null)).some((t) => t.name === 'Sim')).toBe(false);
  });

  it('lists every tab on one machine (read before a machine delete cascades them)', async () => {
    await repo.create(projectId, mine, 'Ana');
    await repo.create(projectId, theirs, 'Caio');
    expect((await repo.listByMachine(mine)).map((t) => t.name)).toEqual(['Ana']);
  });
});

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TabsRepository.recordEvent — agent time (Postgres)', () => {
  let db: PrismaClient;
  let repo: TabsRepository;
  let machineId: string;
  let projectId: string;
  let tabId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TabsRepository(db);
  });

  beforeEach(async () => {
    machineId = newId();
    projectId = newId();
    tabId = newId();
    await db.machine.create({ data: { id: machineId, name: 'm', type: 'agent' } });
    await db.project.create({ data: { id: projectId, key: 'A' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p' } });
    await db.tab.create({ data: { id: tabId, projectId, machineId, name: 'agent' } });
    return async () => {
      await db.project.delete({ where: { id: projectId } });
      await db.machine.delete({ where: { id: machineId } });
    };
  });

  const eventAgo = (kind: 'working' | 'idle', seconds: number) =>
    db.tabEvent.create({ data: { id: newId(), tabId, kind, tool: 'claude', createdAt: new Date(Date.now() - seconds * 1000) } });
  const task = (data: { parentId?: string; tabId?: string | null; type?: 'task' | 'subtask' }) =>
    db.task.create({ data: { id: newId(), projectId, title: 't', type: data.type ?? 'task', parentId: data.parentId ?? null, tabId: data.tabId ?? null } });
  const secondsOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).activeSeconds;

  it('adds the closed working interval to the linked card', async () => {
    const card = await task({ tabId });
    await eventAgo('working', 90);
    await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
    expect(await secondsOf(card.id)).toBeGreaterThanOrEqual(89);
    expect(await secondsOf(card.id)).toBeLessThanOrEqual(91);
  });

  it('adds nothing when the previous event was not working', async () => {
    const card = await task({ tabId });
    await eventAgo('idle', 600);
    await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null });
    expect(await secondsOf(card.id)).toBe(0);
  });

  it('caps one interval at two hours', async () => {
    const card = await task({ tabId });
    await eventAgo('working', 5 * 3600);
    await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null });
    expect(await secondsOf(card.id)).toBe(7200);
  });

  it('credits the parent card once when the tab is linked to the card and to one of its subtasks', async () => {
    const card = await task({ tabId });
    const sub = await task({ parentId: card.id, tabId, type: 'subtask' });
    await eventAgo('working', 60);
    await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null });
    expect(await secondsOf(card.id)).toBeGreaterThanOrEqual(59);
    expect(await secondsOf(card.id)).toBeLessThanOrEqual(61);
    expect(await secondsOf(sub.id)).toBe(0);
  });

  it('credits one interval once when two events for the tab arrive together', async () => {
    const card = await task({ tabId });
    await eventAgo('working', 60);
    // Hold the tab row from another connection so both events are in flight at once (Claude fires
    // PermissionRequest and Notification(permission_prompt) together), then let them go.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "tabs" WHERE "id" = ${tabId} FOR UPDATE`;
      await held;
    });
    const events = Promise.all([
      repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: null }),
      repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: null }),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await blocker;
    await events;
    expect(await secondsOf(card.id)).toBeGreaterThanOrEqual(59);
    expect(await secondsOf(card.id)).toBeLessThanOrEqual(61);
  });

  it('credits the parent card when only a subtask is linked', async () => {
    const card = await task({});
    await task({ parentId: card.id, tabId, type: 'subtask' });
    await eventAgo('working', 60);
    await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null });
    expect(await secondsOf(card.id)).toBeGreaterThanOrEqual(59);
  });
});
