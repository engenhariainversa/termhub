import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { MemoryItemsRepository, type NewMemoryItem } from './memory-items.js';
import { MemoryWriteQueueRepository, type MemoryBucket } from './memory-write-queue.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('memory quota and queue (TER-1137, Postgres)', () => {
  let db: PrismaClient;
  let items: MemoryItemsRepository;
  let queue: MemoryWriteQueueRepository;
  let userId: string;
  let p1: string;
  let p2: string;
  let p3: string;

  const key = (id: string, c: string) => `${c}${id.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    items = new MemoryItemsRepository(db);
    queue = new MemoryWriteQueueRepository(db);
    userId = newId();
    [p1, p2, p3] = [newId(), newId(), newId()];
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.project.create({ data: { id: p1, key: key(p1, 'Q'), name: 'p1', ownerId: userId } });
    await db.project.create({ data: { id: p2, key: key(p2, 'R'), name: 'p2', ownerId: userId } });
    await db.project.create({ data: { id: p3, key: key(p3, 'S'), name: 'p3', ownerId: userId } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { id: { in: [p1, p2, p3] } } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  const note = (projectId: string | null, writtenBy: NewMemoryItem['written_by']): NewMemoryItem => {
    const id = newId();
    return { id, owner_id: userId, project_id: projectId, kind: 'note', source_id: id, chunk_index: 0, title: 'q', text: 't', trust: 'derived', written_by: writtenBy, source_at: new Date() };
  };

  it('bucketWritesSince counts one project and one origin; a note from before the column counts as the assistant', async () => {
    await items.upsertMany([note(p1, 'agent'), note(p1, 'agent'), note(p1, 'person'), note(p2, 'agent'), note(p1, null), note(null, 'assistant')]);
    const since = new Date(Date.now() - 60_000);
    const count = async (projectId: string | null, writtenBy: MemoryBucket['writtenBy']) => (await items.bucketWritesSince({ ownerId: userId, projectId, what: 'note', writtenBy }, since, 60)).length;
    expect(await count(p1, 'agent')).toBe(2);
    expect(await count(p1, 'person')).toBe(1);
    expect(await count(p2, 'agent')).toBe(1);
    expect(await count(p1, 'assistant')).toBe(1);
    expect(await count(null, 'assistant')).toBe(1);
    expect((await items.bucketWritesSince({ ownerId: userId, projectId: p1, what: 'note', writtenBy: 'agent' }, since, 1)).length).toBe(1);
    // every note but the person's
    expect(await items.countAgentNotesSince(userId, since)).toBe(5);
  });

  it('queue: enqueue, count per bucket, buckets with the person first, claim in order and only once', async () => {
    const agent: MemoryBucket = { ownerId: userId, projectId: p1, what: 'note', writtenBy: 'agent' };
    const person: MemoryBucket = { ...agent, writtenBy: 'person' };
    const lesson: MemoryBucket = { ownerId: userId, projectId: p1, what: 'lesson', writtenBy: null };
    const a1 = await queue.enqueue(agent, { n: 1, at: new Date('2026-10-28T10:00:00Z') });
    await queue.enqueue(agent, { n: 2 });
    await queue.enqueue(lesson, { lesson_id: 'x' });
    await queue.enqueue(person, { n: 3 });
    expect(a1.payload).toEqual({ n: 1, at: '2026-10-28T10:00:00.000Z' });
    expect(await queue.count(agent)).toBe(2);
    expect(await queue.count(lesson)).toBe(1);
    const buckets = (await queue.buckets()).filter((b) => b.ownerId === userId);
    expect(buckets[0]).toEqual(person);
    expect(buckets).toHaveLength(3);

    const [first, second] = await Promise.all([queue.claim(agent, 1), queue.claim(agent, 1)]);
    expect([...first, ...second].map((w) => w.payload.n).sort()).toEqual([1, 2]);
    expect(await queue.claim(agent, 5)).toEqual([]);
    expect((await queue.claim(lesson, 5)).map((w) => w.writtenBy)).toEqual([null]);
    expect(await queue.claim(person, 0)).toEqual([]);
  });

  it('activeProjectCount: projects with an automatic run in the window; notes never count', async () => {
    const since = new Date(Date.now() - 60 * 60_000);
    expect(await queue.activeProjectCount(userId, since)).toBe(0);
    await db.automationRun.create({ data: { id: newId(), projectId: p1, role: 'implementer', status: 'running', claimedBy: 'test' } });
    await db.automationRun.create({ data: { id: newId(), projectId: p2, role: 'implementer', status: 'done', claimedBy: 'test', heartbeatAt: new Date(Date.now() - 3 * 60 * 60_000), createdAt: new Date(Date.now() - 3 * 60 * 60_000) } });
    expect(await queue.activeProjectCount(userId, since)).toBe(1);
  });
});
