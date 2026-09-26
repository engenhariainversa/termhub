import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { Repositories } from '../db/repositories/index.js';
import { conflict, HttpError } from '../lib/errors.js';
import { chatBus } from './bus.js';

/** One line of a grouped confirmation (spec 2026-09-26 §7): approve or deny — "Permitir sempre nesta
 * aba" is not batchable. */
export type BatchItem = { id: string; decision: 'approve' | 'deny' };
export type Skipped = { id: string; reason: 'not_found' | 'already_decided' };

/**
 * The rows of a batch that can still be decided, read owner-scoped one by one (a batch is ≤ 20). A
 * batch belongs to one conversation — its decisions are injected there in one sentence — so ids of
 * two conversations are refused before anything is decided.
 */
export async function pendingBatch(repos: Repositories, userId: string, ids: string[]): Promise<{ pending: ChatAction[]; skipped: Skipped[] }> {
  const rows = await Promise.all(ids.map((id) => repos.chatActions.findByIdForUser(id, userId)));
  const found = rows.filter((r): r is ChatAction => r !== undefined);
  if (new Set(found.map((r) => r.conversation_id)).size > 1) throw new HttpError(400, 'As ações precisam ser da mesma conversa', 'MIXED_CONVERSATIONS');
  const pending: ChatAction[] = [];
  const skipped: Skipped[] = [];
  ids.forEach((id, i) => {
    const r = rows[i];
    if (!r) skipped.push({ id, reason: 'not_found' });
    else if (r.status !== 'pending') skipped.push({ id, reason: 'already_decided' });
    else pending.push(r);
  });
  return { pending, skipped };
}

/** Decides a batch: each row conditionally, like the single route (a race ends in `already_decided`),
 * each decision published so every open screen sees it. Nothing decided at all is a 409. */
export async function decideMany(repos: Repositories, userId: string, items: BatchItem[]): Promise<{ decided: ChatAction[]; skipped: Skipped[] }> {
  const { pending, skipped } = await pendingBatch(repos, userId, items.map((i) => i.id));
  const decisionOf = new Map(items.map((i) => [i.id, i.decision]));
  const decided: ChatAction[] = [];
  for (const row of pending) {
    const status = decisionOf.get(row.id) === 'deny' ? 'denied' : 'approved';
    const action = await repos.chatActions.decide(row.id, userId, status);
    if (!action) {
      skipped.push({ id: row.id, reason: 'already_decided' });
      continue;
    }
    decided.push(action);
    chatBus.publish({ type: 'decision', user_id: userId, conversation_id: action.conversation_id, action_id: action.id, status });
  }
  if (decided.length === 0) throw conflict('Estas ações já foram decididas');
  return { decided, skipped };
}
