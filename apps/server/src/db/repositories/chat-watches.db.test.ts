import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatWatchesRepository, FIRE_CLAIM_TTL_MS, type NewChatWatch } from './chat-watches.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatWatchesRepository (Postgres, TER-1099)', () => {
  let db: PrismaClient;
  let repo: ChatWatchesRepository;
  let userId: string;
  let otherUserId: string;
  let projectId: string;
  const t0 = new Date('2026-10-21T12:00:00.000Z');

  const input = (over: Partial<NewChatWatch> = {}): NewChatWatch => ({
    user_id: userId, project_id: projectId, conversation_id: null, kind: 'tab', target_id: 'tab1', params: { events: ['finished'] }, baseline: { cursor: t0.toISOString() },
    label: 'api', note: 'avisar', recurring: false, expires_at: new Date(t0.getTime() + 3600_000), ...over,
  });
  const fired = (key: string) => ({ events: [{ key, event: 'finished', payload: { tab_id: 'tab1' } }], baseline: { cursor: t0.toISOString() } });

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatWatchesRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    projectId = newId();
    await db.project.create({ data: { id: projectId, key: `WT${projectId.slice(0, 6).toUpperCase()}`, name: 'p1', ownerId: userId } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades the watches and their fires
    await db.project.deleteMany({ where: { id: projectId } });
    await db.$disconnect();
  });

  it('creates, lists per scope and counts the open watches', async () => {
    const w = await repo.create(input(), t0);
    expect(w).toMatchObject({ user_id: userId, project_id: projectId, kind: 'tab', status: 'open', fire_count: 0, params: { events: ['finished'] } });
    expect((await repo.listOpen(userId, projectId)).map((x) => x.id)).toContain(w.id);
    expect(await repo.listOpen(userId, null)).toEqual([]);
    expect(await repo.countOpen(otherUserId, projectId)).toBe(0);
    expect((await repo.listAllOpen({ kind: 'tab', targetId: 'tab1' })).map((x) => x.id)).toContain(w.id);
  });

  it('a one-shot watch fires once, whoever tries (two colours), and closes', async () => {
    const w = await repo.create(input(), t0);
    const [a, b] = await Promise.all([repo.fire(w, { ...fired('tab:e1'), close: 'done' }, t0), repo.fire(w, { ...fired('tab:e1'), close: 'done' }, t0)]);
    expect(a + b).toBe(1);
    expect(await repo.findById(w.id)).toMatchObject({ status: 'done', fire_count: 1, last_event: 'finished', summary: null });
    expect(await repo.fire(w, { ...fired('tab:e2'), close: 'done' }, t0)).toBe(0);
    expect(await db.chatWatchFire.count({ where: { watchId: w.id } })).toBe(1);
  });

  it('a recurring watch honours its cooldown, and the same event key is never stored twice', async () => {
    const w = await repo.create(input({ recurring: true }), t0);
    expect(await repo.fire(w, { ...fired('tab:e1'), close: null, cooldownMs: 600_000 }, t0)).toBe(1);
    expect(await repo.fire(w, { ...fired('tab:e2'), close: null, cooldownMs: 600_000 }, new Date(t0.getTime() + 60_000))).toBe(0);
    expect(await repo.fire(w, { ...fired('tab:e1'), close: null, cooldownMs: 600_000 }, new Date(t0.getTime() + 700_000))).toBe(0);
    expect(await repo.fire(w, { ...fired('tab:e3'), close: null, cooldownMs: 600_000 }, new Date(t0.getTime() + 700_000))).toBe(1);
    expect(await repo.findById(w.id)).toMatchObject({ status: 'open', fire_count: 2, last_event: 'finished', last_fired_at: new Date(t0.getTime() + 700_000).toISOString() });
  });

  it('claims, delivers, hands back and counts wakes; a stale claim can be taken over', async () => {
    const w = await repo.create(input({ project_id: null }), t0);
    await repo.fire(w, { ...fired('tab:x1'), close: 'done' }, t0);
    const [fire] = (await repo.listPendingFires(t0)).filter((f) => f.watch_id === w.id);
    expect(fire).toMatchObject({ event: 'finished', payload: { tab_id: 'tab1' }, project_id: null });
    expect(await repo.claimFires([fire.id], t0)).toEqual([fire.id]);
    expect(await repo.claimFires([fire.id], t0)).toEqual([]);
    expect((await repo.listPendingFires(t0)).some((f) => f.id === fire.id)).toBe(false);
    const later = new Date(t0.getTime() + FIRE_CLAIM_TTL_MS + 1);
    expect(await repo.claimFires([fire.id], later)).toEqual([fire.id]);
    await repo.releaseFires([fire.id]);
    expect((await repo.listPendingFires(later)).find((f) => f.id === fire.id)?.attempts).toBe(1);
    await repo.markDelivered([fire.id], later);
    expect(await repo.countWakesSince(userId, null, t0)).toBe(1);
    expect((await repo.listPendingFires(later)).some((f) => f.id === fire.id)).toBe(false);
  });

  it('drops what could not be delivered in time, cancels only the owner\'s, lists due and purges closed', async () => {
    const w = await repo.create(input({ target_id: 'tab9' }), t0);
    await repo.fire(w, { ...fired('tab:z1'), close: 'done' }, t0);
    expect(await repo.dropUndeliveredBefore(new Date(t0.getTime() + 1))).toBeGreaterThanOrEqual(1);
    expect((await repo.listPendingFires(t0)).some((f) => f.watch_id === w.id)).toBe(false);

    const open = await repo.create(input({ target_id: 'tab8' }), t0);
    expect(await repo.cancel(open.id, otherUserId)).toBeNull();
    expect((await repo.listDue(new Date(t0.getTime() + 3600_000))).map((x) => x.id)).toContain(open.id);
    expect(await repo.cancel(open.id, userId)).toMatchObject({ status: 'cancelled' });
    expect(await repo.cancel(open.id, userId)).toBeNull();
    await repo.updateBaseline(open.id, { cursor: 'x' });
    expect((await repo.findById(open.id))?.baseline).toEqual({ cursor: t0.toISOString() });
    expect(await repo.purgeClosedBefore(new Date(Date.now() + 1000))).toBeGreaterThanOrEqual(2);
    expect(await repo.findById(open.id)).toBeNull();
  });

  it('TER-1141: pings an open watch of its owner once per gap, two at once pass once, and unping gives it back', async () => {
    const w = await repo.create(input(), t0);
    const [a, b] = await Promise.all([repo.ping(w.id, userId, 30_000, t0), repo.ping(w.id, userId, 30_000, t0)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await repo.findById(w.id))?.last_pinged_at).toBe(t0.toISOString());
    expect(await repo.ping(w.id, userId, 30_000, new Date(t0.getTime() + 10_000))).toBeNull();
    expect(await repo.ping(w.id, otherUserId, 30_000, new Date(t0.getTime() + 60_000))).toBeNull();
    const later = new Date(t0.getTime() + 30_000);
    expect((await repo.ping(w.id, userId, 30_000, later))?.last_pinged_at).toBe(t0.toISOString());
    await repo.unping(w.id, later, t0.toISOString());
    expect(await repo.findById(w.id)).toMatchObject({ status: 'open', last_pinged_at: t0.toISOString() });
    await repo.cancel(w.id, userId, t0);
    expect(await repo.ping(w.id, userId, 30_000, new Date(t0.getTime() + 120_000))).toBeNull();
  });
});
