import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChatDecision } from '../db/repositories/chat-decisions.js';
import type { MemoryItem } from '../db/repositories/memory-items.js';
import type { Repositories } from '../db/repositories/index.js';
import { config } from '../config.js';
import { publishTabQuestions } from '../chat/tab-questions.js';
import { defaultEmbedder } from '../chat/embeddings.js';
import { HttpError, notFound } from '../lib/errors.js';
import type { Superseder, StatusTarget } from '../db/repositories/memory-status.js';
import { MEMORY_STATUSES } from '../memory/status.js';
import { scoped } from '../auth/scope.js';
import { indexProjectNote } from '../memory/note.js';
import { excerpt } from '../memory/text.js';
import { requestLocale, t, tk } from '../i18n/index.js';

const listQuery = z.object({ q: z.string().trim().max(200).optional(), cursor: z.string().max(500).optional() });
const notesQuery = z.object({ cursor: z.string().max(500).optional() });
const lessonsQuery = z.object({ q: z.string().trim().max(200).optional(), project_id: z.string().min(1).max(64).optional(), cursor: z.string().max(500).optional() });
const idParam = z.object({ id: z.string().min(1).max(64) });
/** A decision's or a note's ref: what "Substituída por…" picks and `supersedes` stores. */
const STATUS_REF = /^(decision|note):[a-z0-9]{1,64}$/;
/** `PUT /decisions/:id/status` and `PUT /notes/:id/status` (TER-1013): `current` undoes any mark;
 *  `superseded` names the item that replaces this one. */
const statusBody = z
  .object({ status: z.enum(MEMORY_STATUSES), superseded_by: z.string().regex(STATUS_REF).optional() })
  .refine((b) => b.status !== 'superseded' || b.superseded_by !== undefined, { message: 'Informe superseded_by', path: ['superseded_by'] });
const replacementsQuery = z.object({ q: z.string().trim().max(200).optional(), exclude: z.string().regex(STATUS_REF).optional() });
/** How many items the "Substituída por…" picker offers per kind. */
const REPLACEMENTS_PER_KIND = 10;

const toTarget = (ref: string): StatusTarget => {
  const [kind, id] = ref.split(':') as ['decision' | 'note', string];
  return { kind, id };
};

/** `setStatus`'s refusals, as the screen shows them. */
const STATUS_ERRORS = {
  replacement_not_found: [404, tk('O item escolhido para substituir não foi encontrado'), 'REPLACEMENT_NOT_FOUND'],
  self: [400, tk('Um item não pode substituir a si mesmo'), 'SELF_REPLACEMENT'],
  replacement_taken: [409, tk('O item escolhido já substitui outro; desfaça aquela substituição antes'), 'REPLACEMENT_TAKEN'],
  cycle: [409, tk('Este item já substitui o escolhido; desfaça aquela substituição antes'), 'REPLACEMENT_CYCLE'],
} as const;
/** `PATCH /memory` (spec D8/§8): at least one of the switches, never none — an empty body is a
 *  400, not a silent no-op. */
const memoryBody = z
  .object({ enabled: z.boolean().optional(), autodecide: z.boolean().optional(), codex_replies: z.boolean().optional() })
  .refine((b) => b.enabled !== undefined || b.autodecide !== undefined || b.codex_replies !== undefined, { message: 'Informe enabled, autodecide ou codex_replies' });

/** 50 decisions per page (spec 2026-09-26 §4.6). */
export const DECISIONS_PAGE = 50;
/** 50 notes per page (task-10 brief), same page size as decisions. */
export const NOTES_PAGE = 50;
/** 50 lessons per page (spec 2026-09-27 failure lessons §6), same page size as decisions/notes. */
export const LESSONS_PAGE = 50;

/** The wire shape of one remembered decision: every `ChatDecision` column but `user_id`,
 * `conversation_id`, `tab_question_id`, `question_index` and `embed_model` — none of which the
 * "Memória do chat" screen shows, and the last two of which are implementation detail. */
function toDecisionView(d: ChatDecision, supersededBy: Superseder | null = null) {
  return {
    id: d.id,
    project_id: d.project_id,
    project_name: d.project_name,
    header: d.header,
    question: d.question,
    options: d.options,
    multi_select: d.multi_select,
    answer: d.answer,
    suggested_count: d.suggested_count,
    accepted_count: d.accepted_count,
    // TER-1013: where the person put it, and (when replaced) the item that replaces it.
    status: d.status,
    expires_at: d.expires_at,
    superseded_by: d.status === 'superseded' ? supersededBy : null,
    created_at: d.created_at,
  };
}

/** Reverses `indexNote`'s stored `text` (`Decisão: …\nMotivo: …\nFontes: …`, see
 * `apps/server/src/memory/index-items.ts`) back into the two fields "Anotações do concierge" shows
 * in their own columns. A line missing (an old or malformed row, or one cut short by the 1200-char
 * limit) answers `''` for that field rather than throwing — the note still shows, just blank there. */
function parseNoteText(text: string): { decision: string; reason: string } {
  const lines = text.split('\n');
  const after = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? '';
  return { decision: after('Decisão: '), reason: after('Motivo: ') };
}

/** The wire shape of one concierge note (spec D12/§8): `question` is the note's `title`; `decision`
 *  and `reason` are parsed back out of `text`. Never the project id's owner, `source_id`, `trust` or
 *  any other memory-item column the "Anotações do concierge" list has no use for. */
function toNoteView(item: MemoryItem, supersededBy: Superseder | null = null) {
  const { decision, reason } = parseNoteText(item.text);
  return {
    id: item.id,
    project_id: item.project_id,
    project_name: item.project_name,
    question: item.title,
    decision,
    reason,
    status: item.status,
    expires_at: item.expires_at,
    superseded_by: item.status === 'superseded' ? supersededBy : null,
    created_at: item.created_at,
  };
}

/** One "Lições" list row (spec 2026-09-27 failure lessons §6/§8): a `lesson` item (chunk 0), as the
 *  list (and the verify/unverify routes, which answer the same shape) show it. `evidence` falls back
 *  to `'observed'` and `path`/`tab_id`/`card`/`pr` to `null` when `meta` is missing — never actually the
 *  case for a `lesson` row, but it keeps the mapping total rather than throwing on a malformed one.
 *  Never `source_id`, `trust`, `content_hash`, `owner_id` or any other column the list has no use for. */
function toLessonView(item: MemoryItem) {
  const meta = item.meta;
  return {
    id: item.id,
    project: item.project_id ? { id: item.project_id, name: item.project_name ?? '' } : null,
    title: item.title,
    excerpt: excerpt(item.text),
    origin: meta?.origin ?? 'file',
    path: meta?.path ?? null,
    tab_id: meta?.tab_id ?? null,
    card: meta?.card ?? null,
    pr: meta?.pr ?? null,
    evidence: meta?.evidence ?? 'observed',
    verified: item.verified,
    verified_at: item.verified_at,
    created_at: item.created_at,
  };
}

/** "Memória do chat" (spec 2026-09-26 §4.6, concierge memory D8/D12/§8): the user's own decisions, the
 * suggestion and "Responder sozinho" switches, the concierge's own notes, and (spec 2026-09-27 failure
 * lessons §6/§8) the "Lições" list — verify/unverify/forget, always the signed-in user's own `lesson`
 * items. Mounted by both the web chat and the phone's, under the `chat` resource; always the
 * signed-in user's rows — `PATCH /memory`, `DELETE /decisions/:id`, `DELETE /notes/:id` and every
 * lessons route only ever touch the requester's own memory, so the ordinary `chat:update`/`chat:delete`
 * grants (held by every role with the chat — BETA has full CRUD on `chat`, migration
 * 20260921233000_chat_beta_role) are enough; the two verify routes set `action: 'update'` explicitly
 * since their HTTP methods (`POST`/`DELETE`) would otherwise default to `create`/`delete` (see the
 * task-6 report for the check). */
export async function chatMemoryRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/decisions', async (request) => {
    const { q, cursor } = listQuery.parse(request.query);
    const userId = request.scope.user.id;
    const { items, next_cursor } = await repos.chatDecisions.listForUser(userId, { q: q || undefined, cursor, limit: DECISIONS_PAGE });
    const by = await supersedersOf(userId, 'decision', items);
    return { decisions: items.map((d) => toDecisionView(d, by.get(`decision:${d.id}`) ?? null)), next_cursor };
  });

  /** The "substituída por …" line of every superseded row of a page, in one query. */
  const supersedersOf = (ownerId: string, kind: 'decision' | 'note', rows: { id: string; status: string }[]) =>
    repos.memoryStatus.supersedersOf(
      ownerId,
      rows.filter((r) => r.status === 'superseded').map((r) => `${kind}:${r.id}`),
    );

  /** One decision or note, re-read after a status change, as its list shows it. */
  const statusView = async (ownerId: string, target: StatusTarget) => {
    const ref = `${target.kind}:${target.id}`;
    const by = (await repos.memoryStatus.supersedersOf(ownerId, [ref])).get(ref) ?? null;
    if (target.kind === 'decision') {
      const [d] = await repos.chatDecisions.findManyForUser([target.id], ownerId);
      if (!d) throw notFound();
      return toDecisionView(d, by);
    }
    const [n] = await repos.memoryItems.findManyForOwner([target.id], ownerId);
    if (!n || n.kind !== 'note') throw notFound();
    return toNoteView(n, by);
  };

  /** "Desatualizada" / "Errada" / "Substituída por…" and their undo (TER-1013). Only the requester's
   *  own rows: any other id — someone else's, a missing one — is a 404, never a 403. */
  const setStatus = async (ownerId: string, target: StatusTarget, body: z.infer<typeof statusBody>) => {
    const by = body.status === 'superseded' && body.superseded_by ? toTarget(body.superseded_by) : undefined;
    const result = await repos.memoryStatus.setStatus(ownerId, target, body.status, by);
    if (result === 'not_found') throw notFound();
    if (result !== 'ok') {
      const [code, message, errorCode] = STATUS_ERRORS[result];
      throw new HttpError(code, message, errorCode);
    }
    return statusView(ownerId, target);
  };

  app.put('/decisions/:id/status', async (request) => {
    const { id } = idParam.parse(request.params);
    return { decision: await setStatus(request.scope.user.id, { kind: 'decision', id }, statusBody.parse(request.body)) };
  });

  app.put('/notes/:id/status', async (request) => {
    const { id } = idParam.parse(request.params);
    return { note: await setStatus(request.scope.user.id, { kind: 'note', id }, statusBody.parse(request.body)) };
  });

  /** "Substituída por…"'s picker (TER-1013): the requester's current decisions and notes matching `q`
   *  (newest first, at most `REPLACEMENTS_PER_KIND` of each), never `exclude` — the item being marked. */
  app.get('/memory/replacements', async (request) => {
    const { q, exclude } = replacementsQuery.parse(request.query);
    const userId = request.scope.user.id;
    const [decisions, notes] = await Promise.all([
      repos.chatDecisions.listForUser(userId, { q: q || undefined, limit: REPLACEMENTS_PER_KIND * 2 }),
      repos.memoryItems.listNotes(userId, { q: q || undefined, limit: REPLACEMENTS_PER_KIND * 2 }),
    ]);
    const items = [
      ...decisions.items
        .filter((d) => d.status === 'current')
        .slice(0, REPLACEMENTS_PER_KIND)
        .map((d) => ({ ref: `decision:${d.id}`, kind: 'decision' as const, title: d.question, detail: d.answer.text ?? d.answer.labels.join(', '), project_name: d.project_name, created_at: d.created_at })),
      ...notes.items
        .filter((n) => n.status === 'current')
        .slice(0, REPLACEMENTS_PER_KIND)
        .map((n) => ({ ref: `note:${n.id}`, kind: 'note' as const, title: n.title, detail: parseNoteText(n.text).decision, project_name: n.project_name, created_at: n.created_at })),
    ]
      .filter((it) => it.ref !== exclude)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { items };
  });

  /** Idempotent and silent about whether the id ever existed or was someone else's: `deleteForUser`
   * scopes the delete to this user in SQL, so there is nothing left to distinguish here. */
  app.delete('/decisions/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await repos.chatDecisions.deleteForUser(id, request.scope.user.id);
    return reply.code(204).send();
  });

  const memory = async (userId: string) => ({
    enabled: await repos.users.chatSuggestions(userId),
    // "Responder sozinho quando houver precedente" (spec D8): off by default, opt-in per user.
    autodecide: await repos.users.chatAutodecide(userId),
    // "Responder perguntas do Codex pelo chat": off by default, opt-in per user.
    codex_replies: await repos.users.chatCodexReplies(userId),
    // `false` when embeddings are not configured on this server at all: the switch has nothing to do.
    available: config.embeddings !== null,
    count: await repos.chatDecisions.countForUser(userId),
    // "Anotações do concierge" (spec D12): the ruling is `countNotesSince(userId, epoch)` — every note
    // this user has, not a windowed count.
    notes: await repos.memoryItems.countNotesSince(userId, new Date(0)),
  });
  app.get('/memory', async (request) => memory(request.scope.user.id));
  app.patch('/memory', async (request) => {
    const body = memoryBody.parse(request.body);
    const userId = request.scope.user.id;
    if (body.enabled !== undefined) await repos.users.setChatSuggestions(userId, body.enabled);
    if (body.autodecide !== undefined) await repos.users.setChatAutodecide(userId, body.autodecide);
    if (body.codex_replies !== undefined) await repos.users.setChatCodexReplies(userId, body.codex_replies);
    if (body.autodecide === false) {
      // Turning "Responder sozinho" off also stops what it already started: every countdown still
      // `scheduled` becomes `cancelled` (the card keeps its proposed answer as a pre-selection), and
      // every open screen hears it. After the switch is stored, so nothing new is scheduled behind it;
      // one already claimed (`sent`) is the sender's, which re-reads the switch and fails AUTODECIDE_OFF.
      const cancelled = await repos.tabQuestions.cancelScheduledForUser(userId);
      if (cancelled.length > 0) await publishTabQuestions(repos, 'tab_question', cancelled, { update: true });
    }
    return memory(userId);
  });

  /** "Anotações do concierge" (spec D12/§8): newest first, 50 per page, keyset `cursor` like `/decisions`. */
  app.get('/notes', async (request) => {
    const { cursor } = notesQuery.parse(request.query);
    const userId = request.scope.user.id;
    const { items, next_cursor } = await repos.memoryItems.listNotes(userId, { cursor, limit: NOTES_PAGE });
    const by = await supersedersOf(userId, 'note', items);
    return { notes: items.map((n) => toNoteView(n, by.get(`note:${n.id}`) ?? null)), next_cursor };
  });

  /** "Esquecer": idempotent and silent about whether the id ever existed, was someone else's, or was
   * some other memory kind — `deleteNote` scopes to `(id, ownerId, kind: 'note')` in SQL, so there is
   * nothing left to distinguish here. */
  app.delete('/notes/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await repos.memoryItems.deleteNote(id, request.scope.user.id);
    return reply.code(204).send();
  });

  /** "Lições" (spec §6/§8): the owner's `lesson` items, one row per source (chunk 0), newest first;
   *  `q` is ILIKE on title/text. `project_id`, when given, is ownership-checked through
   *  `scoped(...).project` first — a project outside the requester's scope is a 404, never an empty,
   *  silently-filtered list. */
  app.get('/lessons', async (request) => {
    const { q, project_id, cursor } = lessonsQuery.parse(request.query);
    if (project_id) await scoped(repos, request).project(project_id);
    const { items, next_cursor } = await repos.memoryItems.listLessons(request.scope.user.id, { q: q || undefined, projectId: project_id, cursor, limit: LESSONS_PAGE });
    return { lessons: items.map(toLessonView), next_cursor };
  });

  /** "Verificar" (spec D8/§7): only this user's own `lesson` chunk 0 — any other id (someone else's
   *  row, a non-lesson item, one already hidden) is a 404, never a 403 that would confirm the id
   *  exists. `POST`'s default action would be `create`; this — like "Desfazer verificação" — is
   *  `chat:update`. */
  app.post('/lessons/:id/verify', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const ownerId = request.scope.user.id;
    const item = await repos.memoryItems.findLessonForOwner(id, ownerId);
    if (!item) throw notFound();
    await repos.memoryItems.setVerified(id, ownerId, ownerId);
    const updated = await repos.memoryItems.findLessonForOwner(id, ownerId);
    return toLessonView(updated ?? item);
  });

  /** "Desfazer verificação": the inverse of `POST .../verify`, same scope and grant — `DELETE`'s
   *  default action would be `delete`; unverifying is `chat:update`, not a deletion of the lesson. */
  app.delete('/lessons/:id/verify', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const ownerId = request.scope.user.id;
    const item = await repos.memoryItems.findLessonForOwner(id, ownerId);
    if (!item) throw notFound();
    await repos.memoryItems.clearVerified(id, ownerId);
    const updated = await repos.memoryItems.findLessonForOwner(id, ownerId);
    return toLessonView(updated ?? item);
  });

  /** "Esquecer" (spec §6): a note-origin lesson (`source_id` `note:<project id>:<lesson id>`) has its
   *  block removed from the note first (row-locked; a block already gone from the note — `removeBlock`
   *  answering `null` — still lets the item delete and the route succeed), then its memory items are
   *  deleted, then the note is re-indexed (best effort) so its sections reflect the removal. A
   *  file-origin lesson is only ever hidden (`hideSource`) — the file stays in the repository until a
   *  PR removes it, which the response says in words. 404 for an id that is not this user's own
   *  `lesson` (or not a lesson at all), never another user's data. */
  app.delete('/lessons/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const ownerId = request.scope.user.id;
    const item = await repos.memoryItems.findLessonForOwner(id, ownerId);
    if (!item) throw notFound();
    if (item.meta?.origin === 'note' && item.project_id) {
      const prefix = `note:${item.project_id}:`;
      const lessonId = item.source_id.startsWith(prefix) ? item.source_id.slice(prefix.length) : item.source_id;
      await repos.notes.removeBlock(item.project_id, lessonId);
      await repos.memoryItems.deleteBySource('lesson', [item.source_id]);
      void indexProjectNote(repos, item.project_id, { embedder: defaultEmbedder(), log: app.log });
      return { ok: true };
    }
    await repos.memoryItems.hideSource(id, ownerId);
    return { ok: true, note: t(requestLocale(request), 'O arquivo continua no repositório; apague-o por um PR para sumir de vez') };
  });
}
