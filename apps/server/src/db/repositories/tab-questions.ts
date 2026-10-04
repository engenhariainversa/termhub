import type { PrismaClient } from '../prisma.js';
import type { Prisma, TabQuestion as PrismaTabQuestion } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import type { TabQuestionSuggestion } from '../../chat/decision-text.js';
import type { ChoiceAnswer, ChoicePayload, PermissionAnswer, PermissionPayload, SuggestionAnswer, SuggestionPayload, TabRowKind } from '../../chat/tab-question-payload.js';
import type { MemoryKind } from './memory-items.js';

export type TabQuestionStatus = 'open' | 'answered' | 'answered_in_tab' | 'expired' | 'failed' | 'dismissed';
export type TabRowPayload = ChoicePayload | PermissionPayload | SuggestionPayload;
export type TabRowAnswer = ChoiceAnswer | PermissionAnswer | SuggestionAnswer;
/** How a question leaves the screen when the chat did not answer it: the person answered in the tab
 * (or anything else happened there), or the tab is gone. */
export type TabQuestionCloseStatus = 'answered_in_tab' | 'expired';
/**
 * Which rows a close reaches: one agent's (null is the main thread), or every row of the tab.
 * `leavesQueue`: the agent has no dialog pending any more, so it also leaves the tab's permission queue.
 */
export type CloseScope = { agent: string | null; leavesQueue: boolean } | 'all';
/** How a `choice` question got its `answer`: a click on the card, or the countdown sending it by
 * itself (spec 2026-09-26 concierge memory §3.2). */
export type AnsweredVia = 'card' | 'auto';

/**
 * A scheduled automatic answer on a still-open `choice` card (spec 2026-09-26 concierge memory §3.2,
 * §6): `by: 'memory'` is the repeat path (a near-verbatim precedent, no LLM call), `'concierge'` is the
 * wake path. `sources` cites what backed it — a `chat_decisions` row (`kind: 'decision'`) or a
 * `memory_items` row — so the card can show and forget them. `due_at` is when the sweeper may send it;
 * `status` tracks the countdown itself, independent of the row's own `status`.
 */
export interface AutoAnswer {
  answer: ChoiceAnswer;
  by: 'memory' | 'concierge';
  reason: string;
  sources: { kind: 'decision' | MemoryKind; id: string }[];
  due_at: string;
  status: 'scheduled' | 'cancelled' | 'sent' | 'failed';
  error_code?: string;
  decided_by?: string;
  /** When the sender claimed it (`scheduled → sent`): how `failLostAutoAnswers` tells a sender that
   *  died from one still typing. */
  claimed_at?: string;
}

export interface TabQuestion {
  id: string;
  tab_id: string;
  project_id: string;
  conversation_id: string;
  /** The conversation's owner: whom the bus events and the push go to, and who may answer. */
  user_id: string;
  kind: TabRowKind;
  payload: TabRowPayload;
  tool_use_id: string | null;
  status: TabQuestionStatus;
  answer: TabRowAnswer | null;
  error_code: string | null;
  answered_by: string | null;
  answered_at: string | null;
  closed_at: string | null;
  injected_at: string | null;
  created_at: string;
  /** A suggested answer from a similar past decision, offered before the person picks (spec
   * 2026-09-26 §4); never set on a `permission` or `suggestion` row. */
  suggestion: TabQuestionSuggestion | null;
  /** A scheduled/cancelled/sent/failed automatic answer (spec 2026-09-26 concierge memory §6). */
  auto_answer: AutoAnswer | null;
  /** How `answer` was obtained: null = before this change, same as `card`. */
  answered_via: AnsweredVia | null;
  /** Set once, before a wake turn starts, so one card never wakes the concierge twice (spec §7). */
  woken_at: string | null;
  /** When the card was last brought back to the end of the chat (TER-477): the thread orders by it, else `created_at`. */
  surfaced_at: string | null;
}

export interface OpenTabQuestionInput {
  tab_id: string;
  project_id: string;
  /**
   * The project owner's conversation the card goes into — or null when there is none (spec 2026-09-26
   * §4.1): the lock, the queue marking and the close still run, and nothing is inserted.
   */
  conversation_id: string | null;
  kind: TabRowKind;
  payload: TabRowPayload;
  tool_use_id: string | null;
  /** The subagent that asked, or null for the main thread. */
  agent_id: string | null;
}

const withOwner = { conversation: { select: { userId: true } } } as const;

/**
 * `error_code` of a permission row closed because another permission arrived behind it: the tab is in
 * a permission queue (spec 2026-09-30 tab questions per subagent §5). `queueAgents` keeps its
 * members until all have left; an all-scope close or a choice clears it at once.
 */
export const PERMISSION_QUEUED = 'QUEUED';

const queueKey = (agent: string | null): string => agent ?? '';

/** `listByConversation`'s windows, one per kind of row. */
export const LIST_QUESTIONS_MAX = 200;
export const LIST_SUGGESTIONS_MAX = 50;
/** `listOpenChoicesForUser`'s window (`list_tab_questions`): the newest 50 open cards. */
export const LIST_OPEN_CHOICES_MAX = 50;

type Row = PrismaTabQuestion & { conversation: { userId: string } };

const iso = (d: Date | null) => d?.toISOString() ?? null;
const mapQuestion = (q: Row): TabQuestion => ({
  id: q.id,
  tab_id: q.tabId,
  project_id: q.projectId,
  conversation_id: q.conversationId,
  user_id: q.conversation.userId,
  kind: q.kind as TabRowKind,
  payload: q.payload as unknown as TabRowPayload,
  tool_use_id: q.toolUseId,
  status: q.status as TabQuestionStatus,
  answer: (q.answer ?? null) as unknown as TabRowAnswer | null,
  error_code: q.errorCode,
  answered_by: q.answeredBy,
  answered_at: iso(q.answeredAt),
  closed_at: iso(q.closedAt),
  injected_at: iso(q.injectedAt),
  created_at: q.createdAt.toISOString(),
  suggestion: (q.suggestion ?? null) as unknown as TabQuestionSuggestion | null,
  auto_answer: (q.autoAnswer ?? null) as unknown as AutoAnswer | null,
  answered_via: (q.answeredVia ?? null) as AnsweredVia | null,
  woken_at: iso(q.wokenAt),
  surfaced_at: iso(q.surfacedAt),
});

/**
 * Closes the scope's rows still on this tab's screen: an `open` question becomes `status`, and one
 * the chat already answered keeps `answered` and only gets its `closed_at` (spec §5.2, "Mirror"). The
 * status filter sits in the UPDATE itself, so a claim racing this close either lands first (the row
 * stays `answered`) or finds the row closed and loses.
 */
async function closeIn(tx: Prisma.TransactionClient, tabId: string, status: TabQuestionCloseStatus, now: Date, scope: CloseScope = 'all'): Promise<TabQuestion[]> {
  const rows = await tx.tabQuestion.findMany({ where: { tabId, closedAt: null, status: { in: ['open', 'answered'] }, ...(scope === 'all' ? {} : { agentId: scope.agent }) }, select: { id: true } });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await tx.tabQuestion.updateMany({ where: { id: { in: ids }, status: 'open' }, data: { status, closedAt: now } });
  await tx.tabQuestion.updateMany({ where: { id: { in: ids }, closedAt: null }, data: { closedAt: now } });
  const after = await tx.tabQuestion.findMany({ where: { id: { in: ids } }, include: withOwner, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return after.map(mapQuestion);
}

/**
 * Locks the tab's row until the transaction ends, so two hook events of one tab land in order: `open` and
 * `closeForTab` both take it first (spec 2026-09-26 §4.1). The tab's state, or undefined when the row is
 * gone (nothing is locked then, and nothing needs to be).
 */
async function lockTab(tx: Prisma.TransactionClient, tabId: string): Promise<{ state: string | null } | undefined> {
  const [tab] = await tx.$queryRaw<{ state: string | null }[]>`SELECT state::text AS state FROM "tabs" WHERE id = ${tabId} FOR UPDATE`;
  return tab;
}

/**
 * Who may read what: methods keyed by a tab or a conversation trust the id (the ingest path derives
 * them from a hook token and the tab row; the concierge from the conversation it runs). Methods keyed
 * by an id a client sends (`findByIdForUser`, `claim`) filter by the owning conversation's `user_id`
 * in SQL, so another user's question and no question at all are the same `undefined`.
 */
export class TabQuestionsRepository {
  constructor(private db: PrismaClient) {}

  /**
   * A new question for a tab: whatever the tab still had open is closed first, in the same transaction.
   * A permission arriving while the tab already has an open permission is a queue in Claude Code (it
   * shows the first dialog, the card would show the last): the open one is closed, marked
   * `PERMISSION_QUEUED` with both agents as members, and nothing opens. Further permissions add their
   * agents to that list and open no card until all members have left (`closeForTab`): every queued
   * permission is answered in the tab. A choice is never held and clears every queue mark and list. The tab
   * row is locked first (`lockTab`), so two hooks of one tab land in order. A suggestion row never counts
   * here: it is not part of Claude Code's permission queue (spec 2026-09-25 tab suggestions §6.1). A
   * suggestion is read seconds after the `Stop`, so it opens only if the tab, under that lock, still waits
   * for input and shows no question (open, or answered from the chat but still on screen): otherwise
   * nothing opens and nothing closes. With no conversation (spec 2026-09-26 §4.1) the same rules run and
   * nothing is inserted; a choice still clears every queue mark and list.
   */
  async open(input: OpenTabQuestionInput, now = new Date()): Promise<{ question: TabQuestion | null; closed: TabQuestion[] }> {
    return this.db.$transaction(async (tx) => {
      const tab = await lockTab(tx, input.tab_id);
      // A resume card (TER-643) opens on a tab whose agent exited (`idle`), whatever it had open: the
      // process that asked is gone, and the cards it left close below.
      const exited = input.kind === 'suggestion' && (input.payload as { exited?: unknown }).exited === true;
      if (input.kind === 'suggestion') {
        if (input.conversation_id === null || tab?.state !== (exited ? 'idle' : 'waiting_input')) return { question: null, closed: [] };
        const question = exited ? null : await tx.tabQuestion.findFirst({ where: { tabId: input.tab_id, kind: { not: 'suggestion' }, closedAt: null, status: { in: ['open', 'answered'] } }, select: { id: true } });
        if (question) return { question: null, closed: [] };
      }
      let queued = false;
      if (input.kind === 'permission') {
        const newest = await tx.tabQuestion.findFirst({ where: { tabId: input.tab_id, kind: { not: 'suggestion' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, kind: true, status: true, errorCode: true, agentId: true, queueAgents: true } });
        if (newest?.kind === 'permission' && newest.status === 'open') {
          await tx.tabQuestion.update({ where: { id: newest.id }, data: { errorCode: PERMISSION_QUEUED, queueAgents: [...new Set([queueKey(newest.agentId), queueKey(input.agent_id)])] } });
          queued = true;
        } else if (newest?.kind === 'permission' && newest.errorCode === PERMISSION_QUEUED) {
          const key = queueKey(input.agent_id);
          if (!newest.queueAgents.includes(key)) {
            await tx.tabQuestion.update({ where: { id: newest.id }, data: { queueAgents: [...newest.queueAgents, key] } });
          }
          queued = true;
        }
      }
      const closed = await closeIn(tx, input.tab_id, exited ? 'expired' : 'answered_in_tab', now);
      if (queued) return { question: null, closed };
      if (input.kind === 'choice') await tx.tabQuestion.updateMany({ where: { tabId: input.tab_id, errorCode: PERMISSION_QUEUED }, data: { errorCode: null, queueAgents: [] } });
      const conversationId = input.conversation_id;
      if (conversationId === null) {
        // No chat to show the card in. A permission that is not queued leaves no row behind, so a prompt
        // queued behind it cannot be recognised later — the one case this path cannot cover.
        return { question: null, closed };
      }
      const row = await tx.tabQuestion.create({
        data: {
          id: newId(),
          tabId: input.tab_id,
          projectId: input.project_id,
          conversationId,
          kind: input.kind,
          payload: input.payload as never,
          toolUseId: input.tool_use_id,
          agentId: input.agent_id,
          status: 'open',
          createdAt: now,
        },
        include: withOwner,
      });
      return { question: mapQuestion(row), closed };
    });
  }

  /**
   * A closing hook event or a removed tab: closes the scope's open and answered rows. Departing
   * agents leave the permission queue; it ends when none remain. The default 'all' clears it at once,
   * and a previous-release empty list clears on the first departing agent. Under the tab's lock
   * (spec 2026-09-26 §4.1) — but only when there is something to close or clear: the pre-check below runs outside the transaction, so a tab with nothing committed
   * skips the lock and this call never waits for it. So it lands after an `open` that had already
   * committed, or one working on a tab that already had a row to close or a queue; a card opened
   * concurrently stays until the tab's next closing event — the live check refuses a stale answer.
   */
  async closeForTab(tabId: string, status: TabQuestionCloseStatus, scope: CloseScope = 'all', now = new Date()): Promise<TabQuestion[]> {
    // Called for almost every hook event of every tab: the common case (nothing on screen, no queue)
    // is one indexed read, and only a tab with something to close or clear pays for the transaction.
    const any = await this.db.tabQuestion.findFirst({ where: { tabId, OR: [{ closedAt: null, status: { in: ['open', 'answered'] }, ...(scope === 'all' ? {} : { agentId: scope.agent }) }, ...(scope === 'all' || scope.leavesQueue ? [{ errorCode: PERMISSION_QUEUED }] : [])] }, select: { id: true } });
    if (!any) return [];
    return this.db.$transaction(async (tx) => {
      await lockTab(tx, tabId);
      const closed = await closeIn(tx, tabId, status, now, scope);
      if (scope === 'all') {
        await tx.tabQuestion.updateMany({ where: { tabId, errorCode: PERMISSION_QUEUED }, data: { errorCode: null, queueAgents: [] } });
      } else if (scope.leavesQueue) {
        // The queue ends when every agent in it has left (spec 2026-09-30 tab questions per subagent §5):
        // one agent's close must not end a queue another agent's dialog is still in.
        const marked = await tx.tabQuestion.findMany({ where: { tabId, errorCode: PERMISSION_QUEUED }, select: { id: true, queueAgents: true } });
        for (const row of marked) {
          const left = row.queueAgents.filter((a) => a !== queueKey(scope.agent));
          // Not a member: nothing to write (a mark of the previous release, with no list, still ends here).
          if (row.queueAgents.length > 0 && left.length === row.queueAgents.length) continue;
          await tx.tabQuestion.update({ where: { id: row.id }, data: left.length === 0 ? { errorCode: null, queueAgents: [] } : { queueAgents: left } });
        }
      }
      return closed;
    });
  }

  /**
   * The user's open `choice` cards (spec 2026-09-26 concierge memory §5.3, `list_tab_questions`):
   * never a `permission` row, never one already answered from the chat, never another user's —
   * filtered by the owning conversation's `user_id`, like every other client-facing method here.
   * `projectId` narrows further when given. Newest first, at most `LIST_OPEN_CHOICES_MAX`: the tool's
   * answer goes into a model's context, and a backlog of forgotten cards must not flood it.
   */
  async listOpenChoicesForUser(userId: string, projectId?: string): Promise<TabQuestion[]> {
    const rows = await this.db.tabQuestion.findMany({
      where: { kind: 'choice', status: 'open', conversation: { userId }, ...(projectId ? { projectId } : {}) },
      include: withOwner,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_OPEN_CHOICES_MAX,
    });
    return rows.map(mapQuestion);
  }

  async findOpenForTab(tabId: string): Promise<TabQuestion | undefined> {
    const row = await this.db.tabQuestion.findFirst({ where: { tabId, status: 'open' }, include: withOwner, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return row ? mapQuestion(row) : undefined;
  }

  /**
   * The tab's open rows (questions, permissions, suggestions) of this user's own conversations, oldest
   * first: the cards a tab chat shows at the end of its conversation (spec 2026-10-01 tab chat D13).
   */
  async listOpenForTab(tabId: string, userId: string): Promise<TabQuestion[]> {
    const rows = await this.db.tabQuestion.findMany({
      where: { tabId, status: 'open', conversation: { userId } },
      include: withOwner,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(mapQuestion);
  }

  async findByIdForUser(id: string, userId: string): Promise<TabQuestion | undefined> {
    const row = await this.db.tabQuestion.findFirst({ where: { id, conversation: { userId } }, include: withOwner });
    return row ? mapQuestion(row) : undefined;
  }

  /**
   * A question's `open → answered`, conditionally: a double click, a second device or a close that got
   * there first all match nothing — and so does a suggestion, which is only ever sent (`claimSuggestion`).
   * `via` records how the answer was obtained (spec §3.2): `'card'` (a click, the default) or
   * `'auto'` (the countdown sent it — `startAutoAnswerSweeper`, never a person's own claim call), which
   * also requires the row's countdown still `sent`.
   */
  async claim(id: string, userId: string, answer: ChoiceAnswer | PermissionAnswer, now = new Date(), via: AnsweredVia = 'card'): Promise<TabQuestion | undefined> {
    return this.claimKind(id, userId, { not: 'suggestion' }, answer, now, via);
  }

  /** "Enviar": a suggestion's `open → answered` with the text as sent; never matches a question. */
  async claimSuggestion(id: string, userId: string, answer: SuggestionAnswer, now = new Date()): Promise<TabQuestion | undefined> {
    return this.claimKind(id, userId, 'suggestion', answer, now);
  }

  private async claimKind(id: string, userId: string, kind: 'suggestion' | { not: 'suggestion' }, answer: TabRowAnswer, now: Date, via: AnsweredVia = 'card'): Promise<TabQuestion | undefined> {
    const { count } = await this.db.tabQuestion.updateMany({
      // An automatic answer only over the countdown its sender claimed: one recovered as lost
      // (`failLostAutoAnswers`), cancelled or never claimed is never typed.
      where: { id, kind, status: 'open', conversation: { userId }, ...(via === 'auto' ? { autoAnswer: { path: ['status'], equals: 'sent' } } : {}) },
      data: { status: 'answered', answer: answer as never, answeredBy: userId, answeredAt: now, answeredVia: via },
    });
    return count === 0 ? undefined : this.findByIdForUser(id, userId);
  }

  /**
   * Attaches a countdown to a still-open `choice` question (spec §6, D9): conditional on `status =
   * 'open'` and no countdown already scheduled or being sent — a second `setAutoAnswer` while one is
   * `scheduled` changes nothing, since only the sweeper (`claimAutoAnswer`) or a cancel may end it; nor
   * while one is `sent` (claimed, send in flight): overwriting it would make the sweeper's
   * `finishAutoAnswer` miss on a failed send and let a second automatic send fire later; nor over one
   * the person `cancelled`: two overlapping `answer_tab_question` calls both read the row before the
   * cancel, and the second must not restart the countdown the person just stopped (no legitimate path
   * schedules on a cancelled card — the tool downgrades those to a suggestion).
   */
  async setAutoAnswer(id: string, auto: AutoAnswer): Promise<TabQuestion | undefined> {
    const count = await this.db.$executeRaw`
      UPDATE "tab_questions" SET "auto_answer" = ${JSON.stringify(auto)}::jsonb
      WHERE "id" = ${id} AND "status" = 'open' AND ("auto_answer" IS NULL OR "auto_answer"->>'status' NOT IN ('scheduled', 'sent', 'cancelled'))`;
    if (count === 0) return undefined;
    const row = await this.db.tabQuestion.findUnique({ where: { id }, include: withOwner });
    return row ? mapQuestion(row) : undefined;
  }

  /**
   * `scheduled → sent`, conditionally on the row still `open`, the countdown still `scheduled` and
   * `due_at` reached: the claim across both blue/green colors, and across two sweeper ticks racing —
   * the row's own lock makes exactly one of them see `scheduled` still true. `now` only decides what is
   * due; `claimed_at` is stamped with the database's own clock, the one `failLostAutoAnswers` measures
   * against, so a row claimed late in a slow batch never looks older than it is. The caller still owes the
   * actual send (`answerTabQuestion`); a failure calls `finishAutoAnswer` to record it.
   */
  async claimAutoAnswer(id: string, now = new Date()): Promise<TabQuestion | undefined> {
    const count = await this.db.$executeRaw`
      UPDATE "tab_questions" SET "auto_answer" = jsonb_set(jsonb_set("auto_answer", '{status}', '"sent"'), '{claimed_at}', to_jsonb(now()))
      WHERE "id" = ${id} AND "status" = 'open' AND "auto_answer"->>'status' = 'scheduled' AND ("auto_answer"->>'due_at')::timestamptz <= ${now}`;
    if (count === 0) return undefined;
    const row = await this.db.tabQuestion.findUnique({ where: { id }, include: withOwner });
    return row ? mapQuestion(row) : undefined;
  }

  /** A claimed (`sent`) countdown whose actual send failed (a 409 — the prompt moved — or a 502):
   *  `sent → failed` with the code, so the card falls back to an ordinary one. */
  async finishAutoAnswer(id: string, status: 'failed', code: string): Promise<TabQuestion | undefined> {
    const count = await this.db.$executeRaw`
      UPDATE "tab_questions" SET "auto_answer" = jsonb_set(jsonb_set("auto_answer", '{status}', to_jsonb(${status}::text)), '{error_code}', to_jsonb(${code}::text))
      WHERE "id" = ${id} AND "auto_answer" IS NOT NULL AND "auto_answer"->>'status' = 'sent'`;
    if (count === 0) return undefined;
    const row = await this.db.tabQuestion.findUnique({ where: { id }, include: withOwner });
    return row ? mapQuestion(row) : undefined;
  }

  /**
   * The sender's crash recovery (spec §6): a countdown claimed (`sent`) whose card is still `open` means
   * the process that claimed it died before sending or recording the failure — the row would otherwise
   * say "sent" forever. `sent → failed` with `code`, conditionally, for every such row claimed more than
   * `lostAfterMs` ago on the database's clock (`claimed_at`, stamped by that same clock; `due_at` for a
   * claim stored before `claimed_at` existed). A recovered countdown can no longer be typed: `claim(...,
   * 'auto')` requires it still `sent`. A send that
   * finished claimed the row itself (`answered`) and is never touched. Oldest first.
   */
  async failLostAutoAnswers(code: string, lostAfterMs: number): Promise<TabQuestion[]> {
    const lost = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "tab_questions"
         SET "auto_answer" = jsonb_set(jsonb_set("auto_answer", '{status}', '"failed"'), '{error_code}', to_jsonb(${code}::text))
       WHERE "status" = 'open' AND "auto_answer"->>'status' = 'sent'
         AND COALESCE(("auto_answer"->>'claimed_at')::timestamptz, ("auto_answer"->>'due_at')::timestamptz) < now() - ${lostAfterMs} * interval '1 millisecond'
      RETURNING "id"`;
    if (lost.length === 0) return [];
    const rows = await this.db.tabQuestion.findMany({ where: { id: { in: lost.map((r) => r.id) } }, include: withOwner, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(mapQuestion);
  }

  /** "Cancelar": `scheduled → cancelled`, `decided_by` = the person who clicked — only the
   *  conversation's own user, like every other client-facing method here. The proposed answer stays as
   *  the pre-selection; the row's own `status` is untouched (still `open`). */
  async cancelAutoAnswer(id: string, userId: string): Promise<TabQuestion | undefined> {
    const count = await this.db.$executeRaw`
      UPDATE "tab_questions" q SET "auto_answer" = jsonb_set(jsonb_set(q."auto_answer", '{status}', '"cancelled"'), '{decided_by}', to_jsonb(${userId}::text))
      WHERE q."id" = ${id} AND q."auto_answer"->>'status' = 'scheduled'
        AND EXISTS (SELECT 1 FROM "chat_conversations" c WHERE c."id" = q."conversation_id" AND c."user_id" = ${userId})`;
    return count === 0 ? undefined : this.findByIdForUser(id, userId);
  }

  /**
   * "Responder sozinho" turned off (`PATCH /memory { autodecide: false }`): every countdown of this user
   * still `scheduled` becomes `cancelled`, `decided_by` = the user, in one conditional statement — a
   * countdown already claimed (`sent`) is the sender's and is left alone (it re-reads the switch itself
   * and fails as `AUTODECIDE_OFF`). The rows' own `status` is untouched. Oldest first, for republishing.
   */
  async cancelScheduledForUser(userId: string): Promise<TabQuestion[]> {
    const cancelled = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "tab_questions" q SET "auto_answer" = jsonb_set(jsonb_set(q."auto_answer", '{status}', '"cancelled"'), '{decided_by}', to_jsonb(${userId}::text))
      WHERE q."auto_answer"->>'status' = 'scheduled'
        AND EXISTS (SELECT 1 FROM "chat_conversations" c WHERE c."id" = q."conversation_id" AND c."user_id" = ${userId})
      RETURNING q."id"`;
    if (cancelled.length === 0) return [];
    const rows = await this.db.tabQuestion.findMany({ where: { id: { in: cancelled.map((r) => r.id) } }, include: withOwner, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(mapQuestion);
  }

  /** The sweeper's tick (`startAutoAnswerSweeper`, spec §6): every row whose countdown is `scheduled`,
   *  due, and still `open` — across every user, oldest due first. */
  async listDueAutoAnswers(now: Date, limit: number): Promise<TabQuestion[]> {
    const due = await this.db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "tab_questions"
      WHERE "status" = 'open' AND "auto_answer"->>'status' = 'scheduled' AND ("auto_answer"->>'due_at')::timestamptz <= ${now}
      ORDER BY ("auto_answer"->>'due_at')::timestamptz ASC
      LIMIT ${limit}`;
    if (due.length === 0) return [];
    const rows = await this.db.tabQuestion.findMany({ where: { id: { in: due.map((r) => r.id) } }, include: withOwner });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return due.map((r) => byId.get(r.id)).filter((r): r is Row => r !== undefined).map(mapQuestion);
  }

  /**
   * Set once, before a wake turn starts (spec §7): conditional on `woken_at IS NULL`, so one card never
   * wakes the concierge twice, even across a restart or both blue/green colors — and, fix round 1, also
   * on the row still `open` with no `auto_answer` at all: a card answered from the tab, or one the
   * repeat path (`maybeScheduleRepeat`) or a prior `answer_tab_question` scheduled a countdown on,
   * between the card's publish and this claim, already has (or is about to have) its answer, and must
   * not wake the concierge for one it does not need. True for the one winner of a race, false for
   * everyone else (including a row that never existed, or no longer eligible).
   */
  async markWoken(id: string, now = new Date()): Promise<boolean> {
    const count = await this.db.$executeRaw`
      UPDATE "tab_questions" SET "woken_at" = ${now}
      WHERE "id" = ${id} AND "woken_at" IS NULL AND "status" = 'open' AND "auto_answer" IS NULL`;
    return count > 0;
  }

  /** "Dispensar": `open → dismissed` for a suggestion of this user, conditionally. The tab is not touched. */
  async dismiss(id: string, userId: string, now = new Date()): Promise<TabQuestion | undefined> {
    const { count } = await this.db.tabQuestion.updateMany({
      where: { id, kind: 'suggestion', status: 'open', conversation: { userId } },
      data: { status: 'dismissed', closedAt: now },
    });
    return count === 0 ? undefined : this.findByIdForUser(id, userId);
  }

  /**
   * `open → status`, for this one row only and conditionally: the answer's live check found the tab
   * no longer showing it. Never the tab's other rows (a newer question may already be open), and a
   * claim or close that got there first matches nothing.
   */
  async closeOne(id: string, status: TabQuestionCloseStatus, now = new Date()): Promise<TabQuestion | undefined> {
    const { count } = await this.db.tabQuestion.updateMany({ where: { id, status: 'open' }, data: { status, closedAt: now } });
    if (count === 0) return undefined;
    const row = await this.db.tabQuestion.findUnique({ where: { id }, include: withOwner });
    return row ? mapQuestion(row) : undefined;
  }

  /**
   * A dead card — its tab can no longer be loaded (spec 2026-09-26 §4.7): `open → expired`, and a row the
   * chat already answered keeps `answered` and only gets its `closed_at`. This one row, conditionally
   * (`closed_at` still null): undefined when something closed it first.
   */
  async expireOne(id: string, now = new Date()): Promise<TabQuestion | undefined> {
    const count = await this.db.$executeRaw`
      UPDATE "tab_questions"
         SET "status" = CASE WHEN "status" = 'open' THEN 'expired' ELSE "status" END,
             "closed_at" = ${now}
       WHERE "id" = ${id} AND "closed_at" IS NULL`;
    if (count === 0) return undefined;
    const row = await this.db.tabQuestion.findUnique({ where: { id }, include: withOwner });
    return row ? mapQuestion(row) : undefined;
  }

  /**
   * Attaches a decision-memory suggestion to a still-open `choice` question, before its card is
   * announced (spec 2026-09-26 §4). Conditional on `status: 'open'`, like `closeOne`: a card the tab
   * already closed (raced by another hook event) gets no suggestion, and the caller falls back to
   * showing the question without one rather than failing the whole open.
   */
  async setSuggestion(id: string, suggestion: TabQuestionSuggestion): Promise<TabQuestion | undefined> {
    const { count } = await this.db.tabQuestion.updateMany({ where: { id, status: 'open' }, data: { suggestion: suggestion as never } });
    if (count === 0) return undefined;
    const row = await this.db.tabQuestion.findUnique({ where: { id }, include: withOwner });
    return row ? mapQuestion(row) : undefined;
  }

  /**
   * Every row still on screen whose tab row is gone — removed by the other color during a blue/green
   * switch, or while this process was down, so no lifecycle event closed it (spec 2026-09-26 §4.7). One
   * statement: `open → expired`, `closed_at` set in every case. Oldest first.
   */
  async expireOrphans(now = new Date()): Promise<TabQuestion[]> {
    const swept = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "tab_questions" AS q
         SET "status" = CASE WHEN q."status" = 'open' THEN 'expired' ELSE q."status" END,
             "closed_at" = ${now}
       WHERE q."closed_at" IS NULL
         AND NOT EXISTS (SELECT 1 FROM "tabs" t WHERE t."id" = q."tab_id")
      RETURNING q."id"`;
    if (swept.length === 0) return [];
    const rows = await this.db.tabQuestion.findMany({ where: { id: { in: swept.map((r) => r.id) } }, include: withOwner, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(mapQuestion);
  }

  /** The keys never reached the tab: only a claimed row can fail. */
  async markFailed(id: string, code: string): Promise<TabQuestion | undefined> {
    const { count } = await this.db.tabQuestion.updateMany({ where: { id, status: 'answered' }, data: { status: 'failed', errorCode: code } });
    if (count === 0) return undefined;
    const row = await this.db.tabQuestion.findUnique({ where: { id }, include: withOwner });
    return row ? mapQuestion(row) : undefined;
  }

  /**
   * The newest 200 questions and the newest 50 suggestions, merged oldest-first — the same window rule as
   * `ChatRepository.listMessages`. Separate windows: a chatty tab's suggestions never push a question out.
   */
  async listByConversation(conversationId: string): Promise<TabQuestion[]> {
    const newest = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
    const [questions, suggestions] = await Promise.all([
      this.db.tabQuestion.findMany({ where: { conversationId, kind: { not: 'suggestion' } }, include: withOwner, orderBy: newest, take: LIST_QUESTIONS_MAX }),
      this.db.tabQuestion.findMany({ where: { conversationId, kind: 'suggestion' }, include: withOwner, orderBy: newest, take: LIST_SUGGESTIONS_MAX }),
    ]);
    const rows = [...questions, ...suggestions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows.map(mapQuestion);
  }

  /** Answered from the chat and not yet told to the concierge (spec §5.5), in the order they were answered. */
  async listToInject(conversationId: string): Promise<TabQuestion[]> {
    const rows = await this.db.tabQuestion.findMany({ where: { conversationId, status: 'answered', injectedAt: null }, include: withOwner, orderBy: [{ answeredAt: 'asc' }, { id: 'asc' }] });
    return rows.map(mapQuestion);
  }

  async markInjected(ids: string[], now = new Date()): Promise<void> {
    if (ids.length === 0) return;
    await this.db.tabQuestion.updateMany({ where: { id: { in: ids }, injectedAt: null }, data: { injectedAt: now } });
  }

  /**
   * Brings the conversation's open questions and permission prompts (never a suggestion) back to the end
   * of the chat (TER-477): `surfaced_at = now`, conditional on still being open. The rows it moved, oldest first.
   */
  async surfaceOpen(conversationId: string, now = new Date()): Promise<TabQuestion[]> {
    const where = { conversationId, status: 'open', kind: { not: 'suggestion' } };
    const rows = await this.db.tabQuestion.findMany({ where, select: { id: true } });
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    await this.db.tabQuestion.updateMany({ where: { ...where, id: { in: ids } }, data: { surfacedAt: now } });
    const moved = await this.db.tabQuestion.findMany({ where: { id: { in: ids }, status: 'open', surfacedAt: now }, include: withOwner, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return moved.map(mapQuestion);
  }

  /** Open questions (not suggestions) per conversation: they wait on the person like a pending action (spec 2026-09-26 §4.9). */
  async countOpenByConversation(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.tabQuestion.groupBy({ by: ['conversationId'], where: { conversationId: { in: ids }, status: 'open', kind: { not: 'suggestion' } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.conversationId, r._count._all]));
  }
}
