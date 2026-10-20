/**
 * Brings the cards that wait on the person back to the end of the chat (TER-477): the concierge's pending
 * confirmations and the tabs' open questions. Each row gets `surfaced_at = now` and is re-published on its
 * usual event with `resurfaced: true`, so every open screen moves it and the push service stays quiet.
 * Nothing is decided, asked again or typed anywhere.
 */
import type { Repositories } from '../db/repositories/index.js';
import { describeActions, type ChatActionCard } from '../db/repositories/chat-actions-view.js';
import { describeTabQuestions, type TabQuestionView } from '../db/repositories/tab-questions-view.js';
import { chatBus } from './bus.js';

export interface Resurfaced {
  actions: ChatActionCard[];
  questions: TabQuestionView[];
}

/** `actionIds` narrows the confirmations; `questions: false` leaves the tab questions where they are. */
export async function resurfaceCards(
  repos: Repositories,
  userId: string,
  conversationId: string,
  opts: { actionIds?: string[]; questions?: boolean } = {},
): Promise<Resurfaced> {
  const rows = await repos.chatActions.surfacePending(conversationId, opts.actionIds);
  const actions = rows.length ? await describeActions(repos, rows, userId) : [];
  for (const card of actions) {
    chatBus.publish({
      type: 'confirmation',
      user_id: userId,
      conversation_id: conversationId,
      action_id: card.id,
      tool: card.tool,
      args: card.args,
      class: card.class,
      machine_id: card.machine_id,
      project_id: card.project_id,
      tab_id: card.tab_id,
      summary: card.summary,
      subagent: card.subagent,
      created_at: card.created_at,
      ...(card.command_rule ? { command_rule: card.command_rule } : {}),
      surfaced_at: card.surfaced_at,
      resurfaced: true,
    });
  }
  let questions: TabQuestionView[] = [];
  if (opts.questions !== false) {
    const open = await repos.tabQuestions.surfaceOpen(conversationId);
    questions = open.length ? await describeTabQuestions(repos, open, userId) : [];
    for (const question of questions) chatBus.publish({ type: 'tab_question', user_id: userId, conversation_id: conversationId, question, resurfaced: true });
  }
  return { actions, questions };
}
