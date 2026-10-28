import type { FastifyBaseLogger } from 'fastify';
import { defaultEmbedder, memoryCode, type Embedder } from '../chat/embeddings.js';
import { recordEvent } from '../automation/events.js';
import type { Repositories } from '../db/repositories/index.js';
import type { NewMemoryItem, NoteWrittenBy } from '../db/repositories/memory-items.js';
import type { MemoryBucket, QueuedMemoryWrite } from '../db/repositories/memory-write-queue.js';
import { NoteTooLargeError } from '../db/repositories/notes.js';
import { formatLocal, zoneOrUtc } from '../lib/local-time.js';
import { renderLessonBlock, type LessonInput } from '../lessons/note.js';
import { nudgeAiMemoryRules, nudgeAiMemoryRulesForOwner } from './ai-memory-sync.js';
import { indexNote } from './index-items.js';
import { indexProjectNote } from './note.js';

/**
 * The memory's hourly quotas (TER-1137, replacing TER-95's 30 notes and TER-205's 20 lessons per hour and
 * per owner). They still guard against a runaway loop or an injection that floods the memory (spec
 * 2026-09-26 concierge memory §5.2, failure lessons D10), but per project, so automatic work in one project
 * never uses up another's, and per origin for notes, so the person's decisions never wait on the agents'.
 */
export const NOTES_PER_PROJECT_HOUR = 60;
/** Lessons went up in the same proportion as notes (20 → 40, as 30 → 60). */
export const LESSONS_PER_PROJECT_HOUR = 40;
/**
 * The owner's global cap only stops a flood out of the ordinary: the per-project quota times the projects
 * with work going on in the last hour (`activeProjectCount`), never below this floor. The person's own
 * notes are outside it.
 */
export const GLOBAL_NOTES_FLOOR = 300;
export const GLOBAL_LESSONS_FLOOR = 200;
/** At most this many writes wait per bucket; past it a write is dropped, with a log line and a feed event. */
export const MEMORY_QUEUE_MAX = 200;
export const QUOTA_WINDOW_MS = 60 * 60 * 1000;
/** How often the flusher looks at the queue. */
export const MEMORY_FLUSH_INTERVAL_MS = 60 * 1000;

const perProject = (what: MemoryBucket['what']) => (what === 'note' ? NOTES_PER_PROJECT_HOUR : LESSONS_PER_PROJECT_HOUR);
const floorOf = (what: MemoryBucket['what']) => (what === 'note' ? GLOBAL_NOTES_FLOOR : GLOBAL_LESSONS_FLOOR);

/** The owner's global cap right now: `perProject × active projects`, at least the floor. */
export async function globalCap(repos: Pick<Repositories, 'memoryWriteQueue'>, ownerId: string, what: MemoryBucket['what'], now: Date): Promise<number> {
  const active = await repos.memoryWriteQueue.activeProjectCount(ownerId, new Date(now.getTime() - QUOTA_WINDOW_MS));
  return Math.max(floorOf(what), perProject(what) * active);
}

/** How many writes the bucket takes now, and when its window frees the next slot when it takes none. */
export async function bucketRoom(repos: Pick<Repositories, 'memoryItems' | 'memoryWriteQueue'>, b: MemoryBucket, now: Date): Promise<{ room: number; freeAt: Date }> {
  const since = new Date(now.getTime() - QUOTA_WINDOW_MS);
  const quota = perProject(b.what);
  const writes = await repos.memoryItems.bucketWritesSince(b, since, quota);
  let room = quota - writes.length;
  // The oldest write in the window leaves it first; with the window not full, the next flush.
  let freeAt = room > 0 ? now : new Date(writes[0]!.getTime() + QUOTA_WINDOW_MS);
  if (b.writtenBy !== 'person') {
    const used = b.what === 'note' ? await repos.memoryItems.countAgentNotesSince(b.ownerId, since) : await repos.memoryItems.countNoteLessonsSince(b.ownerId, since);
    const globalRoom = (await globalCap(repos, b.ownerId, b.what, now)) - used;
    // The global window's oldest write is not read: at worst it frees in a full window.
    if (globalRoom <= 0 && room > 0) freeAt = new Date(now.getTime() + QUOTA_WINDOW_MS);
    room = Math.min(room, globalRoom);
  }
  return { room: Math.max(0, room), freeAt };
}

export type Admission = { ok: true } | { ok: false; full: false; at: Date } | { ok: false; full: true };

/**
 * Whether a write goes in now: only with room in the bucket and nothing of the bucket already waiting
 * (the queue keeps its order). Otherwise when it should be written — the next free slot plus a window
 * for each full quota waiting ahead of it — or that the queue is full.
 */
export async function admit(repos: Pick<Repositories, 'memoryItems' | 'memoryWriteQueue'>, b: MemoryBucket, now = new Date()): Promise<Admission> {
  const waiting = await repos.memoryWriteQueue.count(b);
  if (waiting >= MEMORY_QUEUE_MAX) return { ok: false, full: true };
  const { room, freeAt } = await bucketRoom(repos, b, now);
  if (waiting === 0 && room > 0) return { ok: true };
  const base = Math.max(freeAt.getTime(), now.getTime() + MEMORY_FLUSH_INTERVAL_MS);
  return { ok: false, full: false, at: new Date(base + Math.floor(waiting / perProject(b.what)) * QUOTA_WINDOW_MS) };
}

/** "HH:MM" on the owner's clock (UTC when they set no time zone). */
export async function localClock(repos: Pick<Repositories, 'users'>, ownerId: string, at: Date): Promise<string> {
  return formatLocal(at, zoneOrUtc(await repos.users.timeZone(ownerId))).slice(11);
}

/** A queued or dropped write in the project's feed (ids, counts and the time only: never the text). */
export async function memoryEvent(
  repos: Repositories,
  projectId: string | null,
  kind: 'memory_queued' | 'memory_dropped',
  payload: { what: MemoryBucket['what']; by: NoteWrittenBy | null; count: number; until?: Date; reason?: 'queue_full' | 'note_full'; task_id?: string | null; run_id?: string | null },
): Promise<void> {
  if (!projectId) return;
  const { task_id = null, run_id = null, until, ...rest } = payload;
  await recordEvent(repos, { project_id: projectId, task_id, run_id, kind, payload: { ...rest, ...(until ? { until: until.toISOString() } : {}) } });
}

/** A queued note: the item to write, and the ref it replaces when it was given one. */
export interface QueuedNote {
  item: NewMemoryItem;
  supersedes?: { kind: 'note' | 'decision'; id: string };
}

/** A queued lesson: its id (already handed to the caller), the tab it came from and its fields. */
export interface QueuedLesson {
  lesson_id: string;
  tab_id: string | null;
  input: LessonInput;
}

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

async function writeNote(repos: Repositories, w: QueuedMemoryWrite, deps: { embedder: Embedder | null; log: Log }): Promise<void> {
  const p = w.payload as unknown as { item: NewMemoryItem & { source_at: string; expires_at?: string | null }; supersedes?: QueuedNote['supersedes'] };
  const item: NewMemoryItem = { ...p.item, source_at: new Date(p.item.source_at), expires_at: p.item.expires_at ? new Date(p.item.expires_at) : null };
  let row = await indexNote(repos, item, { embedder: deps.embedder, log: deps.log, supersedes: p.supersedes });
  // What it replaced is gone already (forgotten, or replaced meanwhile): the decision itself still stands.
  if (!row && p.supersedes) row = await indexNote(repos, item, { embedder: deps.embedder, log: deps.log });
  if (item.project_id) nudgeAiMemoryRules(repos, item.project_id, deps.log);
  else nudgeAiMemoryRulesForOwner(repos, item.owner_id, deps.log);
}

async function writeLesson(repos: Repositories, w: QueuedMemoryWrite, deps: { embedder: Embedder | null; log: Log }): Promise<void> {
  const p = w.payload as unknown as QueuedLesson;
  try {
    await repos.notes.appendBlock(w.projectId!, (at) => renderLessonBlock(p.lesson_id, at, p.tab_id, p.input));
  } catch (err) {
    if (!(err instanceof NoteTooLargeError)) throw err;
    deps.log.warn({ queueId: w.id, projectId: w.projectId }, 'memory queue: lesson dropped, the project note is full');
    await memoryEvent(repos, w.projectId, 'memory_dropped', { what: 'lesson', by: null, count: 1, reason: 'note_full' });
    return;
  }
  await indexProjectNote(repos, w.projectId!, { embedder: deps.embedder, log: deps.log });
}

/**
 * Writes what the queue holds as far as each bucket's window allows (TER-1137): the person's buckets first,
 * then the one waiting longest; inside a bucket, in the order the writes came. A write that fails is
 * logged by id and not retried (it was taken out of the queue). Returns how many were written.
 */
export async function flushMemoryQueue(repos: Repositories, deps: { embedder?: Embedder | null; log: Log; now?: Date }): Promise<number> {
  const embedder = deps.embedder !== undefined ? deps.embedder : defaultEmbedder();
  let written = 0;
  for (const b of await repos.memoryWriteQueue.buckets()) {
    try {
      const { room } = await bucketRoom(repos, b, deps.now ?? new Date());
      for (const w of await repos.memoryWriteQueue.claim(b, room)) {
        try {
          if (w.what === 'note') await writeNote(repos, w, { embedder, log: deps.log });
          else await writeLesson(repos, w, { embedder, log: deps.log });
          written++;
        } catch (err) {
          deps.log.warn({ queueId: w.id, code: memoryCode(err) }, 'memory queue: write failed');
        }
      }
    } catch (err) {
      deps.log.warn({ code: memoryCode(err) }, 'memory queue: bucket flush failed');
    }
  }
  if (written > 0) deps.log.info({ written }, 'memory queue flushed');
  return written;
}

/** Runs `flushMemoryQueue` every `intervalMs` (unref'd, one tick at a time); returns the stop function. */
export function startMemoryQueueFlusher(repos: Repositories, log: Log, intervalMs = MEMORY_FLUSH_INTERVAL_MS): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await flushMemoryQueue(repos, { log });
    } catch (err) {
      log.warn({ code: memoryCode(err) }, 'memory queue: flush failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
