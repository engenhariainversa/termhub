import type { PrismaClient } from '../prisma.js';
import type { Prisma, TabQuestion as PrismaTabQuestion } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import type { ChoiceAnswer, ChoicePayload, PermissionAnswer, PermissionPayload, SuggestionAnswer, SuggestionPayload, TabRowKind } from '../../chat/tab-question-payload.js';

export type TabQuestionStatus = 'open' | 'answered' | 'answered_in_tab' | 'expired' | 'failed' | 'dismissed';
export type TabRowPayload = ChoicePayload | PermissionPayload | SuggestionPayload;
export type TabRowAnswer = ChoiceAnswer | PermissionAnswer | SuggestionAnswer;
/** How a question leaves the screen when the chat did not answer it: the person answered in the tab
 * (or anything else happened there), or the tab is gone. */
export type TabQuestionCloseStatus = 'answered_in_tab' | 'expired';

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
}

export interface OpenTabQuestionInput {
  tab_id: string;
  project_id: string;
  conversation_id: string;
  kind: TabRowKind;
  payload: TabRowPayload;
  tool_use_id: string | null;
}

const withOwner = { conversation: { select: { userId: true } } } as const;

/**
 * `error_code` of a permission row closed because another permission arrived behind it: the tab is in
 * a permission queue (spec §9) until the next closing event, which clears it (`closeForTab`).
 */
export const PERMISSION_QUEUED = 'QUEUED';

/** `listByConversation`'s windows, one per kind of row. */
export const LIST_QUESTIONS_MAX = 200;
export const LIST_SUGGESTIONS_MAX = 50;

export interface CloseForTabOptions {
  /** A closing hook event (PreToolUse, Stop…) ends a permission queue; a question event does not. Default true. */
  endsQueue?: boolean;
}
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
});

/**
 * Closes whatever of this tab is still on its screen: an `open` question becomes `status`, and one
 * the chat already answered keeps `answered` and only gets its `closed_at` (spec §5.2, "Mirror"). The
 * status filter sits in the UPDATE itself, so a claim racing this close either lands first (the row
 * stays `answered`) or finds the row closed and loses.
 */
async function closeIn(tx: Prisma.TransactionClient, tabId: string, status: TabQuestionCloseStatus, now: Date): Promise<TabQuestion[]> {
  const rows = await tx.tabQuestion.findMany({ where: { tabId, closedAt: null, status: { in: ['open', 'answered'] } }, select: { id: true } });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await tx.tabQuestion.updateMany({ where: { id: { in: ids }, status: 'open' }, data: { status, closedAt: now } });
  await tx.tabQuestion.updateMany({ where: { id: { in: ids }, closedAt: null }, data: { closedAt: now } });
  const after = await tx.tabQuestion.findMany({ where: { id: { in: ids } }, include: withOwner, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return after.map(mapQuestion);
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
   * `PERMISSION_QUEUED`, and nothing opens. Until a closing event clears the mark, the tab stays in the
   * queue — its newest row is that marked permission — and no permission opens a card: all of them are
   * answered in the tab. A choice is never held, and being the newest row it ends the queue. The tab
   * row is locked first, so two hooks of one tab land in order. A suggestion row never counts here: it is
   * not part of Claude Code's permission queue (spec 2026-09-25 tab suggestions §6.1). A suggestion is
   * read seconds after the `Stop`, so it opens only if the tab, under that lock, still waits for input
   * and shows no question (open, or answered from the chat but still on screen): otherwise nothing opens
   * and nothing closes.
   */
  async open(input: OpenTabQuestionInput, now = new Date()): Promise<{ question: TabQuestion | null; closed: TabQuestion[] }> {
    return this.db.$transaction(async (tx) => {
      const [tab] = await tx.$queryRaw<{ state: string | null }[]>`SELECT state::text AS state FROM "tabs" WHERE id = ${input.tab_id} FOR UPDATE`;
      if (input.kind === 'suggestion') {
        if (tab?.state !== 'waiting_input') return { question: null, closed: [] };
        const question = await tx.tabQuestion.findFirst({ where: { tabId: input.tab_id, kind: { not: 'suggestion' }, closedAt: null, status: { in: ['open', 'answered'] } }, select: { id: true } });
        if (question) return { question: null, closed: [] };
      }
      let queued = false;
      if (input.kind === 'permission') {
        const newest = await tx.tabQuestion.findFirst({ where: { tabId: input.tab_id, kind: { not: 'suggestion' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, kind: true, status: true, errorCode: true } });
        if (newest?.kind === 'permission' && newest.status === 'open') {
          await tx.tabQuestion.update({ where: { id: newest.id }, data: { errorCode: PERMISSION_QUEUED } });
          queued = true;
        } else if (newest?.kind === 'permission' && newest.errorCode === PERMISSION_QUEUED) {
          queued = true;
        }
      }
      const closed = await closeIn(tx, input.tab_id, 'answered_in_tab', now);
      if (queued) return { question: null, closed };
      const row = await tx.tabQuestion.create({
        data: {
          id: newId(),
          tabId: input.tab_id,
          projectId: input.project_id,
          conversationId: input.conversation_id,
          kind: input.kind,
          payload: input.payload as never,
          toolUseId: input.tool_use_id,
          status: 'open',
          createdAt: now,
        },
        include: withOwner,
      });
      return { question: mapQuestion(row), closed };
    });
  }

  async closeForTab(tabId: string, status: TabQuestionCloseStatus, now = new Date(), opts: CloseForTabOptions = {}): Promise<TabQuestion[]> {
    const endsQueue = opts.endsQueue ?? true;
    // Called for almost every hook event of every tab: the common case (nothing on screen, no queue)
    // is one indexed read, and only a tab with something to close or clear pays for the transaction.
    const onScreen = { closedAt: null, status: { in: ['open', 'answered'] } };
    const any = await this.db.tabQuestion.findFirst({ where: { tabId, OR: endsQueue ? [onScreen, { errorCode: PERMISSION_QUEUED }] : [onScreen] }, select: { id: true } });
    if (!any) return [];
    return this.db.$transaction(async (tx) => {
      const closed = await closeIn(tx, tabId, status, now);
      if (endsQueue) await tx.tabQuestion.updateMany({ where: { tabId, errorCode: PERMISSION_QUEUED }, data: { errorCode: null } });
      return closed;
    });
  }

  async findOpenForTab(tabId: string): Promise<TabQuestion | undefined> {
    const row = await this.db.tabQuestion.findFirst({ where: { tabId, status: 'open' }, include: withOwner, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return row ? mapQuestion(row) : undefined;
  }

  async findByIdForUser(id: string, userId: string): Promise<TabQuestion | undefined> {
    const row = await this.db.tabQuestion.findFirst({ where: { id, conversation: { userId } }, include: withOwner });
    return row ? mapQuestion(row) : undefined;
  }

  /**
   * A question's `open → answered`, conditionally: a double click, a second device or a close that got
   * there first all match nothing — and so does a suggestion, which is only ever sent (`claimSuggestion`).
   */
  async claim(id: string, userId: string, answer: ChoiceAnswer | PermissionAnswer, now = new Date()): Promise<TabQuestion | undefined> {
    return this.claimKind(id, userId, { not: 'suggestion' }, answer, now);
  }

  /** "Enviar": a suggestion's `open → answered` with the text as sent; never matches a question. */
  async claimSuggestion(id: string, userId: string, answer: SuggestionAnswer, now = new Date()): Promise<TabQuestion | undefined> {
    return this.claimKind(id, userId, 'suggestion', answer, now);
  }

  private async claimKind(id: string, userId: string, kind: 'suggestion' | { not: 'suggestion' }, answer: TabRowAnswer, now: Date): Promise<TabQuestion | undefined> {
    const { count } = await this.db.tabQuestion.updateMany({
      where: { id, kind, status: 'open', conversation: { userId } },
      data: { status: 'answered', answer: answer as never, answeredBy: userId, answeredAt: now },
    });
    return count === 0 ? undefined : this.findByIdForUser(id, userId);
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
}
