import { describe, expect, it, vi } from 'vitest';

vi.mock('./note.js', () => ({ indexProjectNote: vi.fn(async () => ({ sections: 0, lessons: 1 })) }));
vi.mock('./ai-memory-sync.js', () => ({ nudgeAiMemoryRules: vi.fn(), nudgeAiMemoryRulesForOwner: vi.fn() }));

import type { Repositories } from '../db/repositories/index.js';
import type { MemoryBucket, QueuedMemoryWrite } from '../db/repositories/memory-write-queue.js';
import type { NewMemoryItem } from '../db/repositories/memory-items.js';
import { admit, bucketRoom, flushMemoryQueue, GLOBAL_NOTES_FLOOR, NOTES_PER_PROJECT_HOUR, QUOTA_WINDOW_MS } from './quota.js';
import { indexProjectNote } from './note.js';

const NOW = new Date('2026-10-28T12:00:00Z');
const log = { info: vi.fn(), warn: vi.fn() };

/** A stand-in for the quota's tables: notes written this hour per bucket key, the queue, and the projects at work. */
function store(o: { written?: Record<string, number>; agentNotes?: number; active?: number; queue?: QueuedMemoryWrite[] } = {}) {
  const written = { ...(o.written ?? {}) };
  let agentNotes = o.agentNotes ?? 0;
  const queue = [...(o.queue ?? [])];
  const key = (b: MemoryBucket) => `${b.projectId}:${b.what}:${b.writtenBy}`;
  const same = (a: MemoryBucket, b: MemoryBucket) => key(a) === key(b) && a.ownerId === b.ownerId;
  const order: string[] = [];
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const repos = {
    memoryItems: {
      bucketWritesSince: vi.fn(async (b: MemoryBucket, _since: Date, limit: number) =>
        Array.from({ length: Math.min(limit, written[key(b)] ?? 0) }, () => new Date(NOW.getTime() - 30 * 60_000)),
      ),
      countAgentNotesSince: vi.fn(async () => agentNotes),
      countNoteLessonsSince: vi.fn(async () => 0),
      upsertMany: vi.fn(async (items: NewMemoryItem[]) =>
        items.map((it) => {
          const b = { ownerId: it.owner_id, projectId: it.project_id, what: 'note' as const, writtenBy: it.written_by ?? null };
          written[key(b)] = (written[key(b)] ?? 0) + 1;
          if (it.written_by !== 'person') agentNotes++;
          order.push(it.title);
          return { ...it, id: it.id ?? 'n', created_at: NOW.toISOString() };
        }),
      ),
      insertNoteSuperseding: vi.fn(async () => null),
    },
    memoryWriteQueue: {
      count: vi.fn(async (b: MemoryBucket) => queue.filter((w) => same(w, b)).length),
      activeProjectCount: vi.fn(async () => o.active ?? 0),
      buckets: vi.fn(async () => {
        const seen = new Map<string, MemoryBucket>();
        for (const w of [...queue].sort((x, y) => Number(y.writtenBy === 'person') - Number(x.writtenBy === 'person') || x.createdAt.getTime() - y.createdAt.getTime()))
          if (!seen.has(key(w))) seen.set(key(w), { ownerId: w.ownerId, projectId: w.projectId, what: w.what, writtenBy: w.writtenBy });
        return [...seen.values()];
      }),
      claim: vi.fn(async (b: MemoryBucket, limit: number) => {
        const taken = queue.filter((w) => same(w, b)).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).slice(0, Math.max(0, limit));
        for (const w of taken) queue.splice(queue.indexOf(w), 1);
        return taken;
      }),
    },
    notes: { appendBlock: vi.fn(async () => ({})) },
    automationEvents: { insert: vi.fn(async (e: { kind: string; payload: Record<string, unknown> }) => (events.push(e), { ...e, id: 'e', created_at: '' })) },
    projects: { findById: vi.fn(async (id: string) => ({ id, owner_id: 'u1' })) },
  };
  return { repos: repos as unknown as Repositories, raw: repos, queue, order, events };
}

const bucket = (projectId: string | null, writtenBy: MemoryBucket['writtenBy'] = 'agent'): MemoryBucket => ({ ownerId: 'u1', projectId, what: 'note', writtenBy });

let seq = 0;
const queuedNote = (projectId: string, writtenBy: MemoryBucket['writtenBy'], title: string, minutesAgo: number): QueuedMemoryWrite => ({
  id: `q${++seq}`,
  ownerId: 'u1',
  projectId,
  what: 'note',
  writtenBy,
  createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  payload: {
    item: { owner_id: 'u1', project_id: projectId, kind: 'note', source_id: `s${seq}`, chunk_index: 0, title, text: 't', trust: 'derived', written_by: writtenBy, source_at: NOW.toISOString() },
  },
});

describe('memory quota per project (TER-1137)', () => {
  it('each project has its own 60 per hour: a full project does not hold back another', async () => {
    const { repos } = store({ written: { 'p1:note:agent': 60 } });
    expect((await bucketRoom(repos, bucket('p1'), NOW)).room).toBe(0);
    expect((await bucketRoom(repos, bucket('p2'), NOW)).room).toBe(NOTES_PER_PROJECT_HOUR);
  });

  it("the person's bucket is separate: the agents' 60 leave all of the person's room", async () => {
    const { repos } = store({ written: { 'p1:note:agent': 60, 'p1:note:assistant': 60 }, agentNotes: 5000 });
    expect((await bucketRoom(repos, bucket('p1', 'person'), NOW)).room).toBe(NOTES_PER_PROJECT_HOUR);
  });

  it('the global cap grows with the projects at work: 15 active projects write 900 in an hour without being held back', async () => {
    const { repos } = store({ active: 15, agentNotes: 15 * 60 - 1 });
    expect((await bucketRoom(repos, bucket('p15'), NOW)).room).toBe(1);
  });

  it('the global cap never goes below its floor, and past it holds back the agents for a window', async () => {
    const { repos } = store({ active: 1, agentNotes: GLOBAL_NOTES_FLOOR });
    const r = await bucketRoom(repos, bucket('p1'), NOW);
    expect(r.room).toBe(0);
    expect(r.freeAt).toEqual(new Date(NOW.getTime() + QUOTA_WINDOW_MS));
    const under = store({ active: 1, agentNotes: GLOBAL_NOTES_FLOOR - 1 });
    expect((await bucketRoom(under.repos, bucket('p1'), NOW)).room).toBe(1);
  });

  it('a full bucket is admitted once its oldest write leaves the window; with writes waiting, a window more per quota ahead', async () => {
    const { repos } = store({ written: { 'p1:note:agent': 60 } });
    expect(await admit(repos, bucket('p1'), NOW)).toEqual({ ok: false, full: false, at: new Date(NOW.getTime() + 30 * 60_000) });
    const busy = store({ written: { 'p1:note:agent': 60 }, queue: Array.from({ length: 60 }, (_, i) => queuedNote('p1', 'agent', `n${i}`, 10)) });
    expect(await admit(busy.repos, bucket('p1'), NOW)).toEqual({ ok: false, full: false, at: new Date(NOW.getTime() + 90 * 60_000) });
  });

  it('a runaway loop in one project stops at its quota: past the queue limit, writes are refused', async () => {
    const { repos } = store({ written: { 'p1:note:agent': 60 }, queue: Array.from({ length: 200 }, (_, i) => queuedNote('p1', 'agent', `n${i}`, 10)) });
    expect(await admit(repos, bucket('p1'), NOW)).toEqual({ ok: false, full: true });
  });
});

describe('flushMemoryQueue (TER-1137)', () => {
  it("writes the queue in order once there is room, the person's first", async () => {
    const s = store({
      written: { 'p1:note:agent': 58 },
      queue: [queuedNote('p1', 'agent', 'agent 1', 50), queuedNote('p1', 'agent', 'agent 2', 40), queuedNote('p1', 'agent', 'agent 3', 30), queuedNote('p1', 'person', 'person 1', 5)],
    });
    expect(await flushMemoryQueue(s.repos, { embedder: null, log, now: NOW })).toBe(3);
    // the agents' bucket had room for two: the third waits for the next window
    expect(s.order).toEqual(['person 1', 'agent 1', 'agent 2']);
    expect(s.queue.map((w) => w.payload.item && (w.payload.item as { title: string }).title)).toEqual(['agent 3']);
    expect((s.raw.memoryItems.upsertMany.mock.calls[0]![0] as NewMemoryItem[])[0]).toMatchObject({ written_by: 'person', source_at: new Date(NOW) });
  });

  it('writes nothing while the window is full', async () => {
    const s = store({ written: { 'p1:note:agent': 60 }, queue: [queuedNote('p1', 'agent', 'a', 5)] });
    expect(await flushMemoryQueue(s.repos, { embedder: null, log, now: NOW })).toBe(0);
    expect(s.queue).toHaveLength(1);
  });

  it('a queued note whose replaced note is gone is still written, on its own', async () => {
    const w = queuedNote('p1', 'person', 'replaces', 5);
    w.payload.supersedes = { kind: 'note', id: 'old' };
    const s = store({ queue: [w] });
    expect(await flushMemoryQueue(s.repos, { embedder: null, log, now: NOW })).toBe(1);
    expect(s.raw.memoryItems.insertNoteSuperseding).toHaveBeenCalledTimes(1);
    expect(s.order).toEqual(['replaces']);
  });

  it('appends a queued lesson to the project note and indexes it; a full note drops it with a feed event', async () => {
    const lesson: QueuedMemoryWrite = { id: 'ql', ownerId: 'u1', projectId: 'p1', what: 'lesson', writtenBy: null, createdAt: NOW, payload: { lesson_id: 'abc', tab_id: null, input: { symptom: 's', cause: 'c', fix: 'f', evidence: 'fixed' } } };
    const s = store({ queue: [lesson] });
    expect(await flushMemoryQueue(s.repos, { embedder: null, log, now: NOW })).toBe(1);
    expect(s.raw.notes.appendBlock).toHaveBeenCalledWith('p1', expect.any(Function));
    expect(indexProjectNote).toHaveBeenCalledWith(expect.anything(), 'p1', expect.anything());

    const full = store({ queue: [{ ...lesson, id: 'ql2' }] });
    const { NoteTooLargeError } = await import('../db/repositories/notes.js');
    full.raw.notes.appendBlock.mockRejectedValueOnce(new NoteTooLargeError());
    await flushMemoryQueue(full.repos, { embedder: null, log, now: NOW });
    expect(full.events).toEqual([expect.objectContaining({ kind: 'memory_dropped', payload: expect.objectContaining({ what: 'lesson', reason: 'note_full' }) })]);
  });
});
