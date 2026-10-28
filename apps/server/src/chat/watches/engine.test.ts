import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatWatch, ChatWatchFire, NewChatWatch, WatchFiring } from '../../db/repositories/chat-watches.js';
import { FIRE_CLAIM_TTL_MS } from '../../db/repositories/chat-watches.js';
import type { Repositories } from '../../db/repositories/index.js';
import { createWatchEngine, UNDELIVERED_MAX_MS, type WatchEngineDeps } from './engine.js';
import type { ProbeTab, WatchProbe } from './evaluate.js';
import { WATCH_LIMITS } from './kinds.js';

vi.mock('../../memory/current-rules.js', () => ({ currentRulesBlock: async () => null }));

/**
 * The repository's guarantees, in memory: a watch fires only while open (and past its cooldown), a fire's
 * `(watch_id, event_key)` is unique, a claim holds for `FIRE_CLAIM_TTL_MS`. Shared by two engines it plays
 * the database both colours see; a new engine on the same store is a restarted process.
 */
class FakeWatches {
  watches = new Map<string, ChatWatch>();
  fires: (ChatWatchFire & { claimed_at: number | null; delivered_at: number | null; dropped_at: number | null })[] = [];
  private n = 0;
  constructor(private clock: () => Date) {}

  async create(input: NewChatWatch, now = this.clock()): Promise<ChatWatch> {
    const w: ChatWatch = { id: `w${++this.n}`, ...input, summary: input.summary ?? null, last_event: null, expires_at: input.expires_at.toISOString(), status: 'open', created_at: now.toISOString(), closed_at: null, last_fired_at: null, fire_count: 0, last_pinged_at: null };
    this.watches.set(w.id, w);
    return { ...w };
  }
  async listOpen(userId: string, projectId: string | null) {
    return [...this.watches.values()].filter((w) => w.user_id === userId && w.project_id === projectId && w.status === 'open').map((w) => ({ ...w }));
  }
  async countOpen(userId: string, projectId: string | null) {
    return (await this.listOpen(userId, projectId)).length;
  }
  async listAllOpen(filter: { kind?: string; targetId?: string } = {}) {
    return [...this.watches.values()].filter((w) => w.status === 'open' && (!filter.kind || w.kind === filter.kind) && (!filter.targetId || w.target_id === filter.targetId)).map((w) => ({ ...w }));
  }
  async findById(id: string) {
    const w = this.watches.get(id);
    return w ? { ...w } : null;
  }
  async cancel(id: string, userId: string) {
    const w = this.watches.get(id);
    if (!w || w.user_id !== userId || w.status !== 'open') return null;
    w.status = 'cancelled';
    return { ...w };
  }
  async fire(watch: Pick<ChatWatch, 'id' | 'user_id' | 'project_id'>, firing: WatchFiring, now = this.clock()) {
    const w = this.watches.get(watch.id)!;
    if (w.status !== 'open') return 0;
    if (firing.cooldownMs && w.last_fired_at && Date.parse(w.last_fired_at) >= now.getTime() - firing.cooldownMs) return 0;
    const fresh = firing.events.filter((e) => !this.fires.some((f) => f.watch_id === w.id && f.event_key === e.key));
    if (fresh.length === 0) return 0;
    w.baseline = firing.baseline;
    w.last_fired_at = now.toISOString();
    w.fire_count += firing.events.length;
    w.last_event = firing.events[firing.events.length - 1]!.event;
    if (firing.close) w.status = firing.close;
    for (const e of fresh)
      this.fires.push({ id: `f${++this.n}`, watch_id: w.id, user_id: w.user_id, project_id: w.project_id, event_key: e.key, event: e.event, payload: e.payload, created_at: now.toISOString(), attempts: 0, claimed_at: null, delivered_at: null, dropped_at: null });
    return fresh.length;
  }
  async updateBaseline(id: string, baseline: Record<string, unknown>) {
    const w = this.watches.get(id);
    if (w?.status === 'open') w.baseline = baseline;
  }
  async listDue(now = this.clock()) {
    return [...this.watches.values()].filter((w) => w.status === 'open' && Date.parse(w.expires_at) <= now.getTime());
  }
  private free = (f: FakeWatches['fires'][number], now: Date) => f.delivered_at === null && f.dropped_at === null && (f.claimed_at === null || f.claimed_at < now.getTime() - FIRE_CLAIM_TTL_MS);
  async listPendingFires(now = this.clock()) {
    return this.fires.filter((f) => this.free(f, now)).map((f) => ({ ...f }));
  }
  async claimFires(ids: string[], now = this.clock()) {
    return ids.filter((id) => {
      const f = this.fires.find((x) => x.id === id)!;
      if (!this.free(f, now)) return false;
      f.claimed_at = now.getTime();
      return true;
    });
  }
  async markDelivered(ids: string[], now = this.clock()) {
    for (const f of this.fires) if (ids.includes(f.id)) f.delivered_at = now.getTime();
  }
  async releaseFires(ids: string[]) {
    for (const f of this.fires) if (ids.includes(f.id) && f.delivered_at === null) Object.assign(f, { claimed_at: null, attempts: f.attempts + 1 });
  }
  async dropUndeliveredBefore(cutoff: Date, now = this.clock()) {
    let n = 0;
    for (const f of this.fires) if (f.delivered_at === null && f.dropped_at === null && Date.parse(f.created_at) < cutoff.getTime()) (f.dropped_at = now.getTime()), n++;
    return n;
  }
  async countWakesSince(userId: string, projectId: string | null, since: Date) {
    return new Set(this.fires.filter((f) => f.user_id === userId && f.project_id === projectId && f.delivered_at !== null && f.delivered_at >= since.getTime()).map((f) => f.delivered_at)).size;
  }
  async purgeClosedBefore() {
    return 0;
  }
}

let clock: Date;
let store: FakeWatches;
let tabs: Map<string, ProbeTab>;
let events: { tabId: string; id: string; kind: string; created_at: string }[];
let wakes: { conversationId: string; text: string }[];
let wakeFails: boolean;

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const at = (ms = 0) => new Date(clock.getTime() + ms).toISOString();

const probe: WatchProbe = {
  tab: async (id) => tabs.get(id) ?? null,
  tabEventsAfter: async (tabId, after, kinds) => events.filter((e) => e.tabId === tabId && Date.parse(e.created_at) > after.getTime() && (kinds as string[]).includes(e.kind)) as never,
  task: async () => null,
  pullRequests: async () => [],
  machine: async () => null,
  latestAgentVersion: async () => null,
};

function engine(over: Partial<WatchEngineDeps> = {}) {
  const repos = {
    chatWatches: store,
    users: { findById: async (id: string) => ({ id }) },
    chat: { getOrCreateForProject: async (_u: string, p: string) => ({ id: `conv-${p}` }), getOrCreateForUser: async () => ({ id: 'conv-general' }) },
    memoryItems: {},
  } as unknown as WatchEngineDeps['repos'];
  return createWatchEngine({
    repos,
    probe,
    chat: {
      wake: async (_user, conversationId, text) => {
        if (wakeFails) throw Object.assign(new Error('host away'), { code: 'CHAT_HOST_OFFLINE' });
        wakes.push({ conversationId, text });
        return { conversation_id: conversationId, user_message_id: 'q', assistant_message_id: 'a', done: Promise.resolve() } as never;
      },
    },
    log: { info: () => {}, warn: () => {} },
    now: () => clock,
    publish: async () => {},
    ...over,
  });
}

async function watchTab(over: Partial<NewChatWatch> = {}) {
  return store.create({
    user_id: 'u1', project_id: 'p1', conversation_id: 'c1', kind: 'tab', target_id: 't1', params: { events: ['finished'] }, baseline: { cursor: clock.toISOString() },
    label: 'api', note: 'Ler a resposta e avisar', recurring: false, expires_at: new Date(clock.getTime() + 24 * 3600_000), ...over,
  });
}

beforeEach(() => {
  clock = new Date('2026-10-21T12:00:00.000Z');
  store = new FakeWatches(() => clock);
  tabs = new Map([['t1', { id: 't1', name: 'api', project_id: 'p1', machine_id: 'm1', state: 'working' }]]);
  events = [];
  wakes = [];
  wakeFails = false;
});

describe('firing and delivering', () => {
  it('wakes the scope\'s conversation once with the event, the ids and the note, and closes a one-shot watch', async () => {
    const w = await watchTab();
    const e = engine();
    await e.sweep();
    expect(wakes).toEqual([]);
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) });
    advance(2000);
    await e.sweep();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].conversationId).toBe('conv-p1');
    expect(wakes[0].text).toMatch(/^Automático: aconteceu o que você pediu para acompanhar\./);
    expect(wakes[0].text).toContain(`Assinatura ${w.id}`);
    expect(wakes[0].text).toContain('tab_id t1');
    expect(wakes[0].text).toContain('terminou o turno');
    expect(wakes[0].text).toContain('«Ler a resposta e avisar»');
    expect((await store.findById(w.id))?.status).toBe('done');
    await e.sweep();
    expect(wakes).toHaveLength(1);
  });

  it('two colours sweeping the same database fire and deliver once (idempotent)', async () => {
    await watchTab();
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) });
    advance(2000);
    const blue = engine();
    const green = engine();
    await Promise.all([blue.sweep(), green.sweep()]);
    await Promise.all([blue.sweep(), green.sweep()]);
    expect(store.fires).toHaveLength(1);
    expect(wakes).toHaveLength(1);
  });

  it('a nudge evaluates only the watches of that target', async () => {
    await watchTab();
    tabs.set('t2', { id: 't2', name: 'web', project_id: 'p1', machine_id: 'm1', state: 'working' });
    await watchTab({ target_id: 't2', label: 'web' });
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) }, { tabId: 't2', id: 'ev2', kind: 'finished', created_at: at(1000) });
    advance(2000);
    const e = engine();
    e.nudge('tab', 't1');
    await e.deliver();
    expect(store.fires.map((f) => f.event_key)).toEqual(['tab:ev1']);
    expect(wakes).toHaveLength(1);
  });

  it('a watched tab that changes state without firing still refreshes its screens; a fire publishes once (TER-1115)', async () => {
    await watchTab();
    const published: string[] = [];
    const e = engine({ publish: async (u, p) => void published.push(`${u}:${p}`) });
    e.nudge('tab', 't1');
    await e.deliver();
    expect(store.fires).toEqual([]);
    expect(published).toEqual(['u1:p1']);
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) });
    advance(2000);
    e.nudge('tab', 't1');
    await e.deliver();
    expect(published).toEqual(['u1:p1', 'u1:p1']);
    const [w] = [...store.watches.values()];
    expect(w).toMatchObject({ last_event: 'finished', fire_count: 1 });
    e.nudge('tab', 't9');
    await e.deliver();
    expect(published).toHaveLength(2);
  });

  it('several events of one scope share one wake', async () => {
    await watchTab();
    tabs.set('t2', { id: 't2', name: 'web', project_id: 'p1', machine_id: 'm1', state: 'working' });
    await watchTab({ target_id: 't2', label: 'web', note: 'Outra nota' });
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) }, { tabId: 't2', id: 'ev2', kind: 'finished', created_at: at(1000) });
    advance(2000);
    await engine().sweep();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toMatch(/aconteceram coisas/);
    expect(wakes[0].text).toContain('«Outra nota»');
  });

  it('a closed tab wakes the chat with `gone` and ends the watch', async () => {
    const w = await watchTab();
    tabs.delete('t1');
    await engine().sweep();
    expect(wakes[0].text).toContain('foi fechada ou a sessão dela terminou');
    expect((await store.findById(w.id))?.status).toBe('gone');
  });

  it('does nothing on a draining colour', async () => {
    await watchTab();
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) });
    advance(2000);
    await engine({ active: () => false }).sweep();
    expect(store.fires).toHaveLength(0);
    expect(wakes).toHaveLength(0);
  });
});

describe('restarts', () => {
  it('a fire the old process could not deliver is delivered by the next one', async () => {
    await watchTab();
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) });
    advance(2000);
    wakeFails = true;
    await engine().sweep();
    expect(store.fires).toHaveLength(1);
    expect(wakes).toHaveLength(0);
    // The process dies here; a new one starts with the same database.
    wakeFails = false;
    await engine().sweep();
    expect(wakes).toHaveLength(1);
    expect(store.fires[0].delivered_at).not.toBeNull();
  });

  it('a fire claimed by a process that died mid-delivery is taken over once the claim is stale', async () => {
    await watchTab();
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) });
    advance(2000);
    await engine().sweep();
    store.fires[0].delivered_at = null;
    store.fires[0].claimed_at = clock.getTime();
    wakes = [];
    await engine().sweep();
    expect(wakes).toHaveLength(0);
    advance(FIRE_CLAIM_TTL_MS + 1);
    await engine().sweep();
    expect(wakes).toHaveLength(1);
  });

  it('an event that happened while no process was watching is reconciled on the first sweep', async () => {
    await watchTab();
    // No engine runs: the tab stops and goes back to work meanwhile.
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) }, { tabId: 't1', id: 'ev2', kind: 'working', created_at: at(5000) });
    advance(60_000);
    await engine().sweep();
    expect(wakes).toHaveLength(1);
    expect(store.fires[0].event_key).toBe('tab:ev1');
  });

  it('a failed delivery waits before trying again, and is dropped after a day', async () => {
    await watchTab();
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) });
    advance(2000);
    wakeFails = true;
    const e = engine();
    await e.sweep();
    wakeFails = false;
    await e.sweep();
    expect(wakes).toHaveLength(0);
    advance(61_000);
    await e.sweep();
    expect(wakes).toHaveLength(1);

    await watchTab();
    events.push({ tabId: 't1', id: 'ev3', kind: 'finished', created_at: at(1000) });
    advance(2000);
    wakeFails = true;
    await e.sweep();
    advance(UNDELIVERED_MAX_MS + 1);
    wakeFails = false;
    await engine().sweep();
    expect(wakes).toHaveLength(1);
    expect(store.fires.at(-1)?.dropped_at).not.toBeNull();
  });
});

describe('limits', () => {
  it('the hourly wake budget holds deliveries until the hour turns', async () => {
    const e = engine({ wakesPerHour: 1 });
    await watchTab();
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) });
    advance(2000);
    await e.sweep();
    await watchTab();
    events.push({ tabId: 't1', id: 'ev2', kind: 'finished', created_at: at(1000) });
    advance(2000);
    await e.sweep();
    expect(wakes).toHaveLength(1);
    advance(3600_000);
    await e.sweep();
    expect(wakes).toHaveLength(2);
  });

  it('a recurring watch fires at most once per cooldown, then tells the newest stop', async () => {
    const w = await watchTab({ recurring: true });
    const e = engine();
    events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) });
    advance(2000);
    await e.sweep();
    events.push({ tabId: 't1', id: 'ev2', kind: 'finished', created_at: at(1000) }, { tabId: 't1', id: 'ev3', kind: 'finished', created_at: at(2000) });
    advance(60_000);
    await e.sweep();
    expect(wakes).toHaveLength(1);
    advance(WATCH_LIMITS.recurringCooldownMs);
    await e.sweep();
    expect(wakes).toHaveLength(2);
    expect(store.fires.map((f) => f.event_key)).toEqual(['tab:ev1', 'tab:ev3']);
    expect((await store.findById(w.id))?.status).toBe('open');
  });

  it('an expired watch wakes the chat once with `expired` and closes', async () => {
    const w = await watchTab({ expires_at: new Date(clock.getTime() + 3600_000) });
    advance(3600_000);
    const e = engine();
    await e.sweep();
    await e.sweep();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toContain('a assinatura venceu');
    expect((await store.findById(w.id))?.status).toBe('expired');
  });
});

it('the account-wide chat is woken in its own conversation', async () => {
  await watchTab({ project_id: null });
  events.push({ tabId: 't1', id: 'ev1', kind: 'finished', created_at: at(1000) });
  advance(2000);
  await engine().sweep();
  expect(wakes[0].conversationId).toBe('conv-general');
});

// Keeps the fake honest about the interface it stands in for.
const _typecheck: Pick<Repositories['chatWatches'], keyof FakeWatches & keyof Repositories['chatWatches']> = new FakeWatches(() => new Date());
void _typecheck;

describe('reminders (TER-1100)', () => {
  async function remind(over: Partial<NewChatWatch> = {}, inMs = 5 * 60_000) {
    const due = new Date(clock.getTime() + inMs).toISOString();
    return store.create({
      user_id: 'u1', project_id: 'p1', conversation_id: 'c1', kind: 'reminder', target_id: null, params: { events: ['due'], at: due, zone: 'America/Sao_Paulo' }, baseline: { next: due },
      label: 'Conferir o build', note: 'Conferir o build', recurring: false, expires_at: new Date(Date.parse(due) + 3600_000), ...over,
    });
  }

  it('wakes the chat at its time, on the person\'s clock, once, and closes', async () => {
    const w = await remind();
    const e = engine();
    advance(4 * 60_000);
    await e.sweep();
    expect(wakes).toEqual([]);
    expect(e.nextReminderAt()).toBe(Date.parse('2026-10-21T12:05:00.000Z'));
    advance(60_000);
    await e.sweep();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toMatch(/^Automático: chegou a hora do lembrete que você marcou\./);
    expect(wakes[0].text).toContain(`Lembrete ${w.id}`);
    expect(wakes[0].text).toContain('2026-10-21 09:05 America/Sao_Paulo');
    expect(wakes[0].text).toContain('«Conferir o build»');
    expect(wakes[0].text).not.toContain('atraso');
    expect((await store.findById(w.id))?.status).toBe('done');
    expect(e.nextReminderAt()).toBeNull();
    await e.sweep();
    expect(wakes).toHaveLength(1);
  });

  it('a restart before its time loses nothing: the next process fires it', async () => {
    const w = await remind();
    await engine().sweep();
    advance(5 * 60_000);
    await engine().sweep();
    expect(wakes).toHaveLength(1);
    expect((await store.findById(w.id))?.status).toBe('done');
  });

  it('a server down at its time (even past its validity) fires it as soon as it is back, saying how late', async () => {
    const w = await remind();
    advance(3 * 3600_000);
    await engine().sweep();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toContain('com 175 min de atraso');
    expect(wakes[0].text).not.toContain('venceu');
    expect((await store.findById(w.id))?.status).toBe('done');
  });

  it('repeats every N minutes up to its cap, without the watches\' cooldown, and says the last one', async () => {
    const w = await remind({ recurring: true, params: { events: ['due'], at: at(10 * 60_000), every_minutes: 5, times: 3, until: at(20 * 60_000), zone: 'UTC' }, baseline: { next: at(10 * 60_000) } }, 10 * 60_000);
    const e = engine();
    advance(10 * 60_000);
    await e.sweep();
    expect(wakes[0].text).toContain('o próximo é 2026-10-21 12:15 UTC');
    expect(wakes[0].text).toContain('O lembrete continua ativo.');
    advance(5 * 60_000);
    await e.sweep();
    advance(5 * 60_000);
    await e.sweep();
    expect(wakes).toHaveLength(3);
    expect(wakes[2].text).toContain('foi a última repetição');
    expect((await store.findById(w.id))?.status).toBe('done');
    advance(5 * 60_000);
    await e.sweep();
    expect(wakes).toHaveLength(3);
  });

  it('a repeating one missed several times while down wakes once, says how many it skipped, and moves past now', async () => {
    const w = await remind({ recurring: true, params: { events: ['due'], at: at(5 * 60_000), every_minutes: 10, until: at(24 * 3600_000), zone: 'UTC' } });
    advance(5 * 60_000 + 32 * 60_000);
    await engine().sweep();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toContain('3 repetição(ões) anteriores passaram sem aviso');
    expect(wakes[0].text).toContain('com 32 min de atraso');
    expect((await store.findById(w.id))?.baseline).toEqual({ next: '2026-10-21T12:45:00.000Z' });
  });

  it('a periodic summary stops with the job it follows (TER-1101 stop_with)', async () => {
    tabs.set('t9', { id: 't9', name: 'build', project_id: 'p1', machine_id: 'm1', state: 'working' } as ProbeTab);
    const job = await store.create({
      user_id: 'u1', project_id: 'p1', conversation_id: 'c1', kind: 'tab', target_id: 't9', params: { events: ['finished'] }, baseline: { state: 'working', at: at() },
      label: 'build', note: 'Avisar quando terminar', recurring: false, expires_at: new Date(clock.getTime() + 24 * 3600_000),
    });
    const summary = await remind({ recurring: true, params: { events: ['due'], at: at(60 * 60_000), every_minutes: 60, until: at(24 * 3600_000), zone: 'UTC', stop_with: job.id }, baseline: { next: at(60 * 60_000) } }, 60 * 60_000);
    const e = engine();
    advance(60 * 60_000);
    await e.sweep();
    expect(wakes).toHaveLength(1);
    expect((await store.findById(summary.id))?.status).toBe('open');
    // The job ends: its watch closes, and the summary goes with it before its next time.
    await store.cancel(job.id, 'u1');
    await e.sweep();
    expect((await store.findById(summary.id))?.status).toBe('cancelled');
    advance(60 * 60_000);
    await e.sweep();
    expect(wakes).toHaveLength(1);
  });

  it('a cancelled reminder never wakes the chat', async () => {
    const w = await remind();
    await store.cancel(w.id, 'u1');
    advance(10 * 60_000);
    await engine().sweep();
    expect(wakes).toEqual([]);
  });
});
