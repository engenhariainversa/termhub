import type { FastifyBaseLogger } from 'fastify';
import { containsSecret } from '../lessons/secrets.js';
import { renderLessonBlock, type LessonInput } from '../lessons/note.js';
import { NoteTooLargeError } from '../db/repositories/notes.js';
import type { LessonMeta } from '../db/repositories/memory-items.js';
import { defaultEmbedder } from '../chat/embeddings.js';
import type { MemoryDeps } from '../memory/index-items.js';
import { indexProjectNote } from '../memory/note.js';
import { newId } from '../lib/ids.js';
import { ControlError, type ControlContext } from './context.js';
import { msg, tk } from '../i18n/index.js';
import { admit, localClock, memoryEvent, MEMORY_QUEUE_MAX, type QueuedLesson } from '../memory/quota.js';

/** How many of the project's most recent lessons `recordLesson` scans (newest first) for the one it
 *  just wrote: comfortably more than one caller could add in the instant between the append and this
 *  read, without pulling the whole project history for what is normally a single new row. */
const LESSON_LOOKUP_LIMIT = 20;

const LESSON_SECRET_MSG = tk('A lição parece conter um segredo (token ou chave); tire-o e tente de novo');
const LESSONS_QUEUE_FULL_MSG = tk('A fila de lições deste projeto está cheia ({{max}}); nada foi gravado');
const NOTE_FULL_MSG = tk('A anotação do projeto chegou ao limite de 200 000 caracteres');

export interface RecordLessonInput {
  project_id: string;
  symptom: string;
  cause: string;
  fix: string;
  evidence?: LessonMeta['evidence'];
  card?: string;
  pr?: string;
  tab_id?: string;
}

/**
 * `record_lesson` (spec 2026-09-27 failure lessons D10, D11): appends a fenced lesson block under the
 * project note's `## Lições` heading — symptom, cause, fix and evidence, with an optional card ref and
 * PR — then re-indexes the note (`indexProjectNote`) so the block is searchable through `search_memory`
 * at once, instead of waiting for the sweeper's next pass.
 *
 * Checks, in order, each with nothing written on failure: `project_id` through `ctx.scoped.project`
 * (a foreign or missing project 404s, like every other tool); `tab_id`, when given, through
 * `ctx.scoped.tab` (404 the same way) and must belong to the same project (`TAB_OTHER_PROJECT` —
 * a lesson tagged with a tab from elsewhere would point the "Abrir origem" link at the wrong project's
 * terminal); every free-text field, plus `card`/`pr`, must not look like a secret (`containsSecret`,
 * `LESSON_SECRET`) — checked before any write, exactly like TER-95's source verification; the project's
 * hourly quota (TER-1137, `admit`: `LESSONS_PER_PROJECT_HOUR` per project, under an owner cap that grows
 * with the projects at work), checked last among the pure checks since it is closest to the write itself.
 * Over it nothing is refused: the lesson (its id already minted) goes to the memory queue, is appended once
 * the window has room, and the answer says when (`queued: true`, `ref: null`). Only a full queue refuses. The note's own size cap (`NOTE_MAX`, surfaced here as
 * `NoteTooLargeError` from `notes.appendBlock`) can only be known once the append is attempted, so it
 * is the very last thing that can fail.
 *
 * The lesson id (`newId()`, base36 lowercase) is minted here, before the append, so the block's own
 * fence carries it and the indexed item can be found again by its `source_id`
 * (`note:<project_id>:<lesson_id>`, spec D7) — `newId()`'s alphabet always satisfies the fence's own
 * `[a-z0-9_]{1,40}` id pattern. `indexProjectNote` never throws (it logs and no-ops on its own
 * failures); if the freshly indexed item cannot be found afterwards — an embed hiccup, or a repository
 * error inside the indexer that its own best-effort catch swallowed — the lesson was still written to
 * the note, so this still succeeds, just with `ref: null` rather than failing a call whose visible
 * effect (the note block) already happened.
 */
export type RecordLessonResult = { lesson_id: string; ref: string | null } | { lesson_id: string; ref: null; queued: true; write_at: string; message: string };

export async function recordLesson(ctx: ControlContext, a: RecordLessonInput, deps?: MemoryDeps): Promise<RecordLessonResult> {
  const { project } = await ctx.scoped.project(a.project_id);

  let tabId: string | null = null;
  if (a.tab_id) {
    const { tab } = await ctx.scoped.tab(a.tab_id);
    if (tab.project_id !== project.id) throw new ControlError('TAB_OTHER_PROJECT', msg('A aba "{{tab}}" é de outro projeto', { tab: tab.name }));
    tabId = tab.id;
  }

  if (containsSecret([a.symptom, a.cause, a.fix, a.card ?? '', a.pr ?? ''])) throw new ControlError('LESSON_SECRET', LESSON_SECRET_MSG);

  const ownerId = ctx.scope.user.id;
  const lessonId = newId();
  const input: LessonInput = { symptom: a.symptom, cause: a.cause, fix: a.fix, evidence: a.evidence ?? 'fixed', card: a.card, pr: a.pr };
  const log: Pick<FastifyBaseLogger, 'info' | 'warn'> = deps?.log ?? ctx.log ?? console;

  const bucket = { ownerId, projectId: project.id, what: 'lesson' as const, writtenBy: null };
  const admission = await admit(ctx.repos, bucket);
  if (!admission.ok) {
    if (admission.full) {
      log.warn({ projectId: project.id }, 'memory queue: lesson dropped, the queue is full');
      await memoryEvent(ctx.repos, project.id, 'memory_dropped', { what: 'lesson', by: null, count: 1, reason: 'queue_full' });
      throw new ControlError('LESSONS_QUEUE_FULL', msg(LESSONS_QUEUE_FULL_MSG, { max: MEMORY_QUEUE_MAX }));
    }
    const queued: QueuedLesson = { lesson_id: lessonId, tab_id: tabId, input };
    const row = await ctx.repos.memoryWriteQueue.enqueue(bucket, queued);
    log.info({ queueId: row.id, projectId: project.id, at: admission.at.toISOString() }, 'memory queue: lesson queued');
    await memoryEvent(ctx.repos, project.id, 'memory_queued', { what: 'lesson', by: null, count: 1, until: admission.at });
    return { lesson_id: lessonId, ref: null, queued: true, write_at: admission.at.toISOString(), message: `Na fila: grava às ${await localClock(ctx.repos, ownerId, admission.at)}` };
  }

  try {
    // The block's `at` is taken under the note's row lock (`appendBlock`), never before it (spec D9).
    await ctx.repos.notes.appendBlock(project.id, (at) => renderLessonBlock(lessonId, at, tabId, input));
  } catch (err) {
    if (err instanceof NoteTooLargeError) throw new ControlError('NOTE_FULL', NOTE_FULL_MSG);
    throw err;
  }

  // The MCP path passes no `deps`: the request's logger (`ctx.log`) and the default embedder, like the
  // notes route; `console` only for a context built without one (a script, a test).
  await indexProjectNote(ctx.repos, project.id, { embedder: deps?.embedder !== undefined ? deps.embedder : defaultEmbedder(), log });

  const sourceId = `note:${project.id}:${lessonId}`;
  const { items } = await ctx.repos.memoryItems.listLessons(ownerId, { projectId: project.id, limit: LESSON_LOOKUP_LIMIT });
  const found = items.find((it) => it.source_id === sourceId);
  return { lesson_id: lessonId, ref: found ? `lesson:${found.id}` : null };
}
