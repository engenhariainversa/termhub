import type { FastifyBaseLogger } from 'fastify';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { Repositories } from '../db/repositories/index.js';
import { HttpError } from '../lib/errors.js';
import { monitorBus } from '../monitor/bus.js';
import { chatBus } from './bus.js';
import { failureLabel } from './service.js';

/**
 * Pending cards that point at a tab that is gone (TER-986). The tab is the card's "where": with it gone,
 * neither the call nor any grant the card offers ("Permitir sempre nesta aba", "Liberar tudo neste
 * projeto", "Liberar sem prazo"…) can apply any more. Such a card ends `failed` with `TAB_GONE`, exactly
 * like an approval whose tab died before it ran, so every screen shows it as stale ("Expirou: a aba foi
 * fechada", with "Propor de novo") instead of offering buttons the server would refuse.
 */

type Moved = Array<{ action: ChatAction; user_id: string }>;

/** Tells every open screen (web and phone) these cards went stale. Publishing never throws (`chatBus`). */
function publishTabGone(moved: Moved): void {
  for (const { action, user_id } of moved) {
    chatBus.publish({ type: 'action_status', user_id, conversation_id: action.conversation_id, action_id: action.id, status: 'failed', error_code: 'TAB_GONE' });
  }
}

/** A removed tab (closed from the UI, by the concierge, or with its machine or project) retires its pending cards. */
export function startTabGoneActionExpiry(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>): () => void {
  return monitorBus.subscribeLifecycle((event) => {
    if (event.kind !== 'removed') return;
    void repos.chatActions
      .failPendingForTab(event.tab_id)
      .then((moved) => {
        publishTabGone(moved);
        if (moved.length > 0) log.info({ tabId: event.tab_id, count: moved.length }, 'chat cards of a closed tab expired');
      })
      .catch((err) => log.warn({ tabId: event.tab_id, code: failureLabel(err) }, 'chat card expiry for a closed tab failed'));
  });
}

/** Retires every pending card whose tab vanished without a lifecycle event (the other color removed it, a
 * crash). At boot and in the hourly purge. Never throws; logs the count and codes only. */
export async function expireOrphanTabActions(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>): Promise<number> {
  try {
    const moved = await repos.chatActions.failOrphanPending();
    publishTabGone(moved);
    if (moved.length > 0) log.info({ count: moved.length }, 'orphan chat cards expired');
    return moved.length;
  } catch (err) {
    log.warn({ code: failureLabel(err) }, 'orphan chat card sweep failed');
    return 0;
  }
}

/**
 * A click on a pending card whose tab is gone — any approve word, a grant or not — retires the card
 * instead of deciding it, and answers with an error that says why. Without this, a grant button on such
 * a card failed with a refusal about its kind ("Só dá para liberar sem prazo uma ação de rotina…") that
 * named the wrong cause. The tab is read owner-scoped, exactly as the gate reads it, so another user's tab
 * reads as gone. "Recusar" never comes here: refusing a stale card is always fine.
 */
export async function assertActionTabAlive(repos: Repositories, userId: string, actionId: string): Promise<void> {
  const row = await repos.chatActions.findByIdForUser(actionId, userId);
  if (!row || row.status !== 'pending' || !row.tab_id) return; // the decision itself answers 404 / 409
  const [tab] = await repos.tabs.findByIdsForOwner([row.tab_id], userId);
  if (tab) return;
  const moved = await repos.chatActions.failPendingTabGone(row.id);
  if (moved) publishTabGone([moved]);
  throw new HttpError(409, 'A aba desta ação foi fechada: nada foi feito e o pedido expirou. Use “Propor de novo” para o chat pedir de novo numa aba aberta.', 'TAB_GONE');
}
