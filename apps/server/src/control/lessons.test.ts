import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { MemoryItem } from '../db/repositories/memory-items.js';
import { NoteTooLargeError } from '../db/repositories/notes.js';
import type { Project, Tab } from '../db/repositories/types.js';
import { Scoped } from '../auth/scope.js';
import { HttpError } from '../lib/errors.js';
import { ControlError, type ControlContext } from './context.js';
import { recordLesson } from './lessons.js';
import { LESSONS_PER_PROJECT_HOUR, MEMORY_QUEUE_MAX } from '../memory/quota.js';

const indexProjectNote = vi.hoisted(() => vi.fn(async () => ({ sections: 0, lessons: 1 })));
vi.mock('../memory/note.js', () => ({ indexProjectNote }));

const project = (over: Partial<Project> & { id: string }): Project => ({
  owner_id: 'u1', key: over.id.toUpperCase(), next_task_number: 1, name: over.id, status: 'active', description: null, last_terminal_at: null, created_at: '', ...over,
});

const tab = (over: Partial<Tab> & { id: string; project_id: string; machine_id: string }): Tab => ({ name: over.id, ...over }) as unknown as Tab;

const item = (over: Partial<MemoryItem> & { id: string; source_id: string }): MemoryItem => ({
  owner_id: 'u1', project_id: 'p1', project_name: 'p1', kind: 'lesson', chunk_index: 0, title: 't', text: 'x', trust: 'derived',
  content_hash: 'h', source_hash: null, embed_model: null, meta: null, verified: false, verified_at: null,
  source_at: '2026-09-27T00:00:00.000Z', created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z', ...over,
});

interface Setup {
  /** Lessons of the project already written this hour (TER-1137). */
  count?: number;
  /** Lessons already waiting in the project's queue. */
  queued?: number;
  appendBlock?: () => Promise<unknown>;
  lessons?: MemoryItem[];
  user?: string;
}

function ctxFor(setup: Setup = {}) {
  const projects = [project({ id: 'p1' }), project({ id: 'p2' }), project({ id: 'px', owner_id: 'u2' })];
  const machines = [{ id: 'm1', owner_id: 'u1' }];
  const links = [
    { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/src', position: 0, created_at: '' },
    { id: 'l2', project_id: 'p2', machine_id: 'm1', cwd: '/src', position: 0, created_at: '' },
  ];
  const tabs = [tab({ id: 't1', project_id: 'p1', machine_id: 'm1' }), tab({ id: 't2', project_id: 'p2', machine_id: 'm1' })];
  const bucketWritesSince = vi.fn(async (_b: object, _since: Date, limit: number) => Array.from({ length: Math.min(limit, setup.count ?? 0) }, () => new Date('2026-10-28T10:15:00Z')));
  const countNoteLessonsSince = vi.fn(async () => 0);
  const memoryWriteQueue = {
    count: vi.fn(async () => setup.queued ?? 0),
    enqueue: vi.fn(async (b: object, payload: object) => ({ ...b, id: 'q1', payload, createdAt: new Date() })),
    activeProjectCount: vi.fn(async () => 0),
  };
  const insertEvent = vi.fn(async (e: object) => ({ id: 'e1', created_at: '', ...e }));
  const appendBlock = vi.fn(setup.appendBlock ?? (async () => ({ id: 'n1', project_id: 'p1', content: '', updated_at: '2026-09-27T00:00:00.000Z' })));
  const listLessons = vi.fn(async () => ({ items: setup.lessons ?? [], next_cursor: null }));
  const repos = {
    projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)) },
    tabs: { findById: vi.fn(async (id: string) => tabs.find((t) => t.id === id)) },
    machines: { findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)) },
    projectMachines: { find: vi.fn(async (p: string, m: string) => links.find((l) => l.project_id === p && l.machine_id === m)) },
    notes: { appendBlock },
    memoryItems: { bucketWritesSince, countNoteLessonsSince, listLessons },
    memoryWriteQueue,
    automationEvents: { insert: insertEvent },
    users: { timeZone: vi.fn(async () => null) },
  };
  const user = setup.user ?? 'u1';
  const scope = { user: { id: user } as never, viewAs: { kind: 'self' as const }, ownerId: user, createAs: user };
  const ctx: ControlContext = { repos: repos as unknown as Repositories, scope, scoped: new Scoped(repos as unknown as Repositories, scope), can: async () => true };
  return { ctx, repos, calls: { bucketWritesSince, appendBlock, listLessons, memoryWriteQueue, insertEvent } };
}

const validInput = { project_id: 'p1', symptom: 'P3009: migrate found failed migrations', cause: 'a migração anterior falhou', fix: 'rodar resolve --applied' };

describe('recordLesson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });


  it('checks project_id through ctx.scoped.project: a foreign project 404s with nothing written', async () => {
    const { ctx, calls } = ctxFor();
    await expect(recordLesson(ctx, { ...validInput, project_id: 'px' }, { embedder: null, log: console })).rejects.toBeInstanceOf(HttpError);
    expect(calls.appendBlock).not.toHaveBeenCalled();
  });

  it('checks project_id through ctx.scoped.project: a missing project also 404s', async () => {
    const { ctx } = ctxFor();
    await expect(recordLesson(ctx, { ...validInput, project_id: 'nope' }, { embedder: null, log: console })).rejects.toBeInstanceOf(HttpError);
  });

  it('a missing tab_id 404s with nothing written', async () => {
    const { ctx, calls } = ctxFor();
    await expect(recordLesson(ctx, { ...validInput, tab_id: 'nope' }, { embedder: null, log: console })).rejects.toBeInstanceOf(HttpError);
    expect(calls.appendBlock).not.toHaveBeenCalled();
  });

  it('a tab_id from another project is refused with TAB_OTHER_PROJECT, nothing written', async () => {
    const { ctx, calls } = ctxFor();
    await expect(recordLesson(ctx, { ...validInput, project_id: 'p1', tab_id: 't2' }, { embedder: null, log: console })).rejects.toMatchObject({ code: 'TAB_OTHER_PROJECT' });
    expect(calls.appendBlock).not.toHaveBeenCalled();
  });

  it('accepts a tab_id that belongs to the project', async () => {
    const { ctx, calls } = ctxFor({ lessons: [item({ id: 'm1', source_id: 'note:p1:abc' })] });
    await recordLesson(ctx, { ...validInput, project_id: 'p1', tab_id: 't1' }, { embedder: null, log: console });
    expect(calls.appendBlock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['symptom', { symptom: 'leaked thb_pat_abcdefgh12345678' }],
    ['cause', { cause: 'a chave sk-abcdefghijklmnop foi commitada' }],
    ['fix', { fix: 'revogar ghp_' + 'a'.repeat(36) }],
    ['card', { card: 'AKIAABCDEFGHIJKLMNOP' }],
    ['pr', { pr: 'https://example.com/AKIAABCDEFGHIJKLMNOP' }],
  ])('a secret in %s is refused with LESSON_SECRET, nothing written', async (_field, over) => {
    const { ctx, calls } = ctxFor();
    await expect(recordLesson(ctx, { ...validInput, ...over }, { embedder: null, log: console })).rejects.toMatchObject({ code: 'LESSON_SECRET' });
    expect(calls.appendBlock).not.toHaveBeenCalled();
    expect(indexProjectNote).not.toHaveBeenCalled();
  });

  it('queues the 41st lesson of the project within an hour: nothing appended, the answer and the feed say when (TER-1137)', async () => {
    // the window's writes are at 10:15 UTC: the clock is pinned inside that hour, or the test ages out
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-28T10:30:00Z') });
    const { ctx, calls } = ctxFor({ count: LESSONS_PER_PROJECT_HOUR });
    const r = await recordLesson(ctx, { ...validInput, tab_id: 't1' }, { embedder: null, log: console });
    expect(calls.appendBlock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ref: null, queued: true, write_at: '2026-10-28T11:15:00.000Z', message: 'Na fila: grava às 11:15' });
    const [bucket, payload] = calls.memoryWriteQueue.enqueue.mock.calls[0]! as [object, { lesson_id: string; tab_id: string; input: object }];
    expect(bucket).toEqual({ ownerId: 'u1', projectId: 'p1', what: 'lesson', writtenBy: null });
    expect(payload).toMatchObject({ lesson_id: r.lesson_id, tab_id: 't1', input: { symptom: validInput.symptom, evidence: 'fixed' } });
    expect(calls.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', kind: 'memory_queued', payload: expect.objectContaining({ what: 'lesson', count: 1, until: '2026-10-28T11:15:00.000Z' }) }));
  });

  it('allows the 40th lesson of the project in the hour', async () => {
    const { ctx, calls } = ctxFor({ count: LESSONS_PER_PROJECT_HOUR - 1, lessons: [item({ id: 'm1', source_id: 'note:p1:abc' })] });
    await recordLesson(ctx, validInput, { embedder: null, log: console });
    expect(calls.appendBlock).toHaveBeenCalledTimes(1);
  });

  it('counts the lessons of this project only', async () => {
    const { ctx, calls } = ctxFor();
    await recordLesson(ctx, validInput, { embedder: null, log: console });
    expect(calls.bucketWritesSince).toHaveBeenCalledWith({ ownerId: 'u1', projectId: 'p1', what: 'lesson', writtenBy: null }, expect.any(Date), LESSONS_PER_PROJECT_HOUR);
  });

  it('a full queue refuses with LESSONS_QUEUE_FULL and a feed event, nothing written', async () => {
    const { ctx, calls } = ctxFor({ count: LESSONS_PER_PROJECT_HOUR, queued: MEMORY_QUEUE_MAX });
    await expect(recordLesson(ctx, validInput, { embedder: null, log: console })).rejects.toMatchObject({ code: 'LESSONS_QUEUE_FULL' });
    expect(calls.appendBlock).not.toHaveBeenCalled();
    expect(calls.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'memory_dropped', payload: expect.objectContaining({ reason: 'queue_full' }) }));
  });

  it('a full note is refused as NOTE_FULL, and the rate limit was already checked', async () => {
    const { ctx, calls } = ctxFor({ appendBlock: async () => { throw new NoteTooLargeError(); } });
    await expect(recordLesson(ctx, validInput, { embedder: null, log: console })).rejects.toMatchObject({ code: 'NOTE_FULL' });
    expect(calls.bucketWritesSince).toHaveBeenCalled();
  });

  it('on success appends the block, indexes the note and resolves the ref of the freshly indexed item', async () => {
    const { ctx, calls } = ctxFor();
    // The lesson id is generated inside recordLesson, so the lookup mock reads it back out of the
    // block just appended (mirroring how the real note indexer keys a lesson item by the fence's own id).
    let writtenBlock = '';
    calls.appendBlock.mockImplementationOnce(async (_projectId: string, render: (at: Date) => string) => {
      const block = render(new Date('2026-09-27T00:00:00.000Z'));
      writtenBlock = block;
      return { id: 'n1', project_id: 'p1', content: block, updated_at: '2026-09-27T00:00:00.000Z' };
    });
    calls.listLessons.mockImplementation(async (_owner: string, o: { projectId?: string }) => {
      const m = /id=([a-z0-9]+)/.exec(writtenBlock);
      return { items: m ? [item({ id: 'm9', source_id: `note:${o.projectId}:${m[1]}` })] : [], next_cursor: null };
    });

    const r = await recordLesson(ctx, validInput, { embedder: null, log: console });
    expect(calls.appendBlock).toHaveBeenCalledTimes(1);
    expect(indexProjectNote).toHaveBeenCalledTimes(1);
    expect(indexProjectNote).toHaveBeenCalledWith(ctx.repos, 'p1', { embedder: null, log: console });
    expect(r.lesson_id).toMatch(/^[a-z0-9]+$/);
    expect(r.ref).toBe('lesson:m9');
  });

  it('without explicit deps (the MCP path), indexes with the context\'s request logger, never console', async () => {
    const { ctx } = ctxFor();
    const log = { info: vi.fn(), warn: vi.fn() };
    await recordLesson({ ...ctx, log }, validInput);
    expect(indexProjectNote).toHaveBeenCalledWith(ctx.repos, 'p1', expect.objectContaining({ log }));
  });

  it('succeeds with ref: null when the freshly indexed item cannot be found', async () => {
    const { ctx } = ctxFor({ lessons: [] });
    const r = await recordLesson(ctx, validInput, { embedder: null, log: console });
    expect(r.lesson_id).toBeTruthy();
    expect(r.ref).toBeNull();
  });

  it('the generated lesson id matches the note fence format ([a-z0-9_]{1,40})', async () => {
    const { ctx } = ctxFor();
    const r = await recordLesson(ctx, validInput, { embedder: null, log: console });
    expect(r.lesson_id).toMatch(/^[a-z0-9_]{1,40}$/);
  });
});
