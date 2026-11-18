import type { FastifyBaseLogger } from 'fastify';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { Repositories } from '../db/repositories/index.js';
import { chatBus } from './bus.js';
import { failureLabel } from './service.js';

/**
 * Pending cards that no longer ask anything (TER-1192). A subagent asks for a card, gets "aguardando
 * confirmação" and ends; the concierge carries an approval later, so the card is still worth answering
 * for a while. Three things make it redundant instead:
 *
 * - the same card is asked again (same tool `create_task`, same project, same title): no second card, the
 *   first comes back to the end of its chat (`duplicatePendingCreateTask`, in the gate's `ask`);
 * - the card was created since by another path (`expireRedoneCreateTask`, after a `create_task` runs):
 *   approving the pending one would put it on the board twice. It expires with `REDONE`;
 * - its subagent ended and nobody answered it for `ABANDONED_AFTER_MS` (`expireAbandonedSubagentCards`, at
 *   boot and in the hourly purge). It expires with `SUBAGENT_ENDED`.
 */

/** How long a card asked by a subagent that already ended waits for an answer before it expires. */
export const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000;

/** What `create_task` cards are compared by: the project id and the title, trimmed, spaces folded, any case. */
export function createTaskKey(args: unknown): { projectId: string; title: string } | null {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.project_id !== 'string' || typeof a.title !== 'string') return null;
  const title = a.title.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
  if (!a.project_id || !title) return null;
  return { projectId: a.project_id, title };
}

const sameTitle = (row: ChatAction, title: string): boolean => createTaskKey(row.args)?.title === title;

/** The pending `create_task` card of this person for the same project and title, if one waits already. A
 * failed read answers none: the card is then asked as before. */
export async function duplicatePendingCreateTask(repos: Repositories, userId: string, tool: string, args: unknown): Promise<ChatAction | undefined> {
  if (tool !== 'create_task') return undefined;
  const key = createTaskKey(args);
  if (!key) return undefined;
  try {
    const rows = await repos.chatActions.listPendingCreateTasks(userId, key.projectId);
    return rows.find((r) => sameTitle(r, key.title));
  } catch {
    return undefined;
  }
}

function publishExpired(moved: Array<{ action: ChatAction; user_id: string }>, code: string): void {
  for (const { action, user_id } of moved) {
    chatBus.publish({ type: 'action_status', user_id, conversation_id: action.conversation_id, action_id: action.id, status: 'expired', error_code: code });
  }
}

/** A `create_task` just ran: every pending card of this person for the same project and title expires
 * (`REDONE`). Best effort, never throws: a failure leaves the cards pending, as before. */
export async function expireRedoneCreateTask(repos: Repositories, userId: string, args: unknown): Promise<number> {
  try {
    const key = createTaskKey(args);
    if (!key) return 0;
    const rows = await repos.chatActions.listPendingCreateTasks(userId, key.projectId);
    const ids = rows.filter((r) => sameTitle(r, key.title)).map((r) => r.id);
    const moved = await repos.chatActions.expirePending(ids, 'REDONE');
    publishExpired(moved, 'REDONE');
    return moved.length;
  } catch {
    return 0;
  }
}

/** Cards of a subagent that ended, unanswered for `ABANDONED_AFTER_MS`, expire (`SUBAGENT_ENDED`). At boot and
 * in the hourly purge; never throws, logs the count and codes only. */
export async function expireAbandonedSubagentCards(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>, now = new Date()): Promise<number> {
  try {
    const moved = await repos.chatActions.expireAbandonedSubagentPending(new Date(now.getTime() - ABANDONED_AFTER_MS));
    publishExpired(moved, 'SUBAGENT_ENDED');
    if (moved.length > 0) log.info({ count: moved.length }, 'chat cards of ended subagents expired');
    return moved.length;
  } catch (err) {
    log.warn({ code: failureLabel(err) }, 'ended subagent card sweep failed');
    return 0;
  }
}
