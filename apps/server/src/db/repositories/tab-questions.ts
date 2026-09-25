import type { PrismaClient } from '../prisma.js';
import type { Prisma, TabQuestion as PrismaTabQuestion } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import type { ChoiceAnswer, ChoicePayload, PermissionAnswer, PermissionPayload, TabQuestionKind } from '../../chat/tab-question-payload.js';

export type TabQuestionStatus = 'open' | 'answered' | 'answered_in_tab' | 'expired' | 'failed';
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
  kind: TabQuestionKind;
  payload: ChoicePayload | PermissionPayload;
  tool_use_id: string | null;
  status: TabQuestionStatus;
  answer: ChoiceAnswer | PermissionAnswer | null;
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
  kind: TabQuestionKind;
  payload: ChoicePayload | PermissionPayload;
  tool_use_id: string | null;
}

const withOwner = { conversation: { select: { userId: true } } } as const;
type Row = PrismaTabQuestion & { conversation: { userId: string } };

const iso = (d: Date | null) => d?.toISOString() ?? null;
const mapQuestion = (q: Row): TabQuestion => ({
  id: q.id,
  tab_id: q.tabId,
  project_id: q.projectId,
  conversation_id: q.conversationId,
  user_id: q.conversation.userId,
  kind: q.kind as TabQuestionKind,
  payload: q.payload as unknown as ChoicePayload | PermissionPayload,
  tool_use_id: q.toolUseId,
  status: q.status as TabQuestionStatus,
  answer: (q.answer ?? null) as unknown as ChoiceAnswer | PermissionAnswer | null,
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

  /** A new question for a tab: whatever the tab still had open is closed first, in the same transaction. */
  async open(input: OpenTabQuestionInput, now = new Date()): Promise<{ question: TabQuestion; closed: TabQuestion[] }> {
    return this.db.$transaction(async (tx) => {
      const closed = await closeIn(tx, input.tab_id, 'answered_in_tab', now);
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

  async closeForTab(tabId: string, status: TabQuestionCloseStatus, now = new Date()): Promise<TabQuestion[]> {
    return this.db.$transaction((tx) => closeIn(tx, tabId, status, now));
  }

  async findOpenForTab(tabId: string): Promise<TabQuestion | undefined> {
    const row = await this.db.tabQuestion.findFirst({ where: { tabId, status: 'open' }, include: withOwner, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return row ? mapQuestion(row) : undefined;
  }

  async findByIdForUser(id: string, userId: string): Promise<TabQuestion | undefined> {
    const row = await this.db.tabQuestion.findFirst({ where: { id, conversation: { userId } }, include: withOwner });
    return row ? mapQuestion(row) : undefined;
  }

  /** `open → answered`, conditionally: a double click, a second device or a close that got there first all match nothing. */
  async claim(id: string, userId: string, answer: ChoiceAnswer | PermissionAnswer, now = new Date()): Promise<TabQuestion | undefined> {
    const { count } = await this.db.tabQuestion.updateMany({
      where: { id, status: 'open', conversation: { userId } },
      data: { status: 'answered', answer: answer as never, answeredBy: userId, answeredAt: now },
    });
    return count === 0 ? undefined : this.findByIdForUser(id, userId);
  }

  /** The keys never reached the tab: only a claimed row can fail. */
  async markFailed(id: string, code: string): Promise<TabQuestion | undefined> {
    const { count } = await this.db.tabQuestion.updateMany({ where: { id, status: 'answered' }, data: { status: 'failed', errorCode: code } });
    if (count === 0) return undefined;
    const row = await this.db.tabQuestion.findUnique({ where: { id }, include: withOwner });
    return row ? mapQuestion(row) : undefined;
  }

  /** The newest `limit`, returned oldest-first — the same window rule as `ChatRepository.listMessages`. */
  async listByConversation(conversationId: string, limit = 200): Promise<TabQuestion[]> {
    const rows = await this.db.tabQuestion.findMany({ where: { conversationId }, include: withOwner, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
    return rows.reverse().map(mapQuestion);
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
