import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { CloseForTabOptions, TabQuestion, TabQuestionCloseStatus } from '../db/repositories/tab-questions.js';
import { describeTabQuestions, type TabQuestionView } from '../db/repositories/tab-questions-view.js';
import type { Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import type { Interpreted } from '../monitor/state.js';
import { chatBus } from './bus.js';
import { failureLabel } from './service.js';
import type { ChoicePayload, TabQuestionInput } from './tab-question-payload.js';

export type TabQuestionEventType = 'tab_question' | 'tab_question_answered' | 'tab_question_closed';

/**
 * Whether a hook event means the tab moved past its open question (spec 2026-09-25 §5.2). A
 * `Notification` never does: it only ever says the tab is still waiting — the `permission_prompt`
 * that follows every question, or a reminder a minute later. Nor does AskUserQuestion's own
 * `PermissionRequest`, the question's companion. An event that opens a question closes the previous
 * one itself (`open`).
 */
export function closesOpenQuestion(next: Interpreted): boolean {
  if (next.question) return false;
  if (next.meta.event === 'Notification') return false;
  if (next.meta.event === 'PermissionRequest' && next.meta.tool === 'AskUserQuestion') return false;
  return true;
}

/** Tells every open screen of each row's conversation owner. Resolves the views it published. */
export async function publishTabQuestions(repos: Pick<Repositories, 'tabs'>, type: TabQuestionEventType, rows: TabQuestion[]): Promise<TabQuestionView[]> {
  const views: TabQuestionView[] = [];
  for (const row of rows) {
    const [question] = await describeTabQuestions(repos, [row], row.user_id);
    chatBus.publish({ type, user_id: row.user_id, conversation_id: row.conversation_id, question });
    views.push(question);
  }
  return views;
}

/** Closes the tab's question (if any) and says so. */
export async function closeTabQuestions(repos: Repositories, tabId: string, status: TabQuestionCloseStatus, opts?: CloseForTabOptions): Promise<TabQuestion[]> {
  const closed = await repos.tabQuestions.closeForTab(tabId, status, undefined, opts);
  await publishTabQuestions(repos, 'tab_question_closed', closed);
  return closed;
}

/**
 * A tab asked something: the row goes into the project owner's most recently active conversation and
 * the card onto every screen showing it. A project nobody chats in (or with no owner) gets nothing —
 * the question stays in the tab, as before — but whatever the tab had open is still closed: the
 * screen moved on. A permission queued behind an open one opens nothing either (see `open`).
 */
export async function openTabQuestion(repos: Repositories, tab: Pick<Tab, 'id' | 'project_id'>, input: TabQuestionInput): Promise<TabQuestion | null> {
  // Only the owner's chat: another user's conversation left on the project (a former owner, or an
  // admin's) must not receive the card, which would let them answer a tab they no longer own.
  const owner = (await repos.projects.findById(tab.project_id))?.owner_id;
  const conversation = owner ? await repos.chat.findLatestActiveForProject(tab.project_id, owner) : undefined;
  if (!conversation) {
    // A question event, not a closing one: it must not end a permission queue.
    await closeTabQuestions(repos, tab.id, 'answered_in_tab', { endsQueue: false });
    return null;
  }
  const { question, closed } = await repos.tabQuestions.open({ tab_id: tab.id, project_id: tab.project_id, conversation_id: conversation.id, kind: input.kind, payload: input.payload, tool_use_id: input.tool_use_id });
  await publishTabQuestions(repos, 'tab_question_closed', closed);
  if (question) await publishTabQuestions(repos, 'tab_question', [question]);
  return question;
}

/**
 * The ingest step's hand-off (spec §4.2): after the tab row is updated, a question opens and any
 * other event closes. Never throws — a hook event is already recorded, and bookkeeping for a card
 * must not turn it into a failed POST. Logs ids, kind and counts; never the question.
 */
export async function noteHookEvent(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>, tab: Tab, next: Interpreted): Promise<void> {
  try {
    if (next.question) {
      const q = await openTabQuestion(repos, tab, next.question);
      if (q) log.info({ tabId: tab.id, tabQuestionId: q.id, kind: q.kind, questions: q.kind === 'choice' ? (q.payload as ChoicePayload).questions.length : 1 }, 'tab question opened');
    } else if (closesOpenQuestion(next)) {
      await closeTabQuestions(repos, tab.id, 'answered_in_tab');
    }
  } catch (err) {
    log.warn({ tabId: tab.id, code: failureLabel(err) }, 'tab question bookkeeping failed');
  }
}

/** A removed tab (closed from the UI, by the concierge, or with its machine) expires its question. */
export function startTabQuestionExpiry(repos: Repositories, log: Pick<FastifyBaseLogger, 'warn'>): () => void {
  return monitorBus.subscribeLifecycle((event) => {
    if (event.kind !== 'removed') return;
    void closeTabQuestions(repos, event.tab_id, 'expired').catch((err) => log.warn({ tabId: event.tab_id, code: failureLabel(err) }, 'tab question expiry failed'));
  });
}
