import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { needsYou } from '../../monitor/state.js';
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
