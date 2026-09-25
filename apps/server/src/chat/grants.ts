import type { ChatAction } from '../db/repositories/chat-actions.js';
import { describeGrants, type ChatGrantView } from '../db/repositories/chat-actions-view.js';
import type { Repositories } from '../db/repositories/index.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';
import { chatBus } from './bus.js';
import { grantable, GRANTABLE_TOOL } from './gate.js';

/**
 * "Permitir sempre nesta aba" is only for what the gate will honour (`grantable`): checked on the row
 * as the user sees it, before anything is decided (and, on the phone, before the PIN challenge is
 * spent), so a refused request changes nothing. Owner-scoped: another user's row is a 404.
 */
export async function assertGrantableAction(repos: Repositories, userId: string, actionId: string): Promise<ChatAction> {
  const row = await repos.chatActions.findByIdForUser(actionId, userId);
  if (!row) throw notFound('Ação não encontrada');
  if (row.status !== 'pending') throw conflict('Esta ação já foi decidida');
  if (!grantable(row.tool, (row.args ?? {}) as Record<string, unknown>)) throw new HttpError(400, 'Só dá para permitir sempre o envio de texto para uma aba', 'GRANT_NOT_ALLOWED');
  return row;
}

/** Trusts the tab of an action the user just approved, and tells every open screen (web and phone).
 * Created before the decision is re-injected, so the injected sentence can mention it. */
export async function grantTab(repos: Repositories, userId: string, action: ChatAction): Promise<ChatGrantView> {
  if (!action.tab_id) throw new HttpError(400, 'Só dá para permitir sempre o envio de texto para uma aba', 'GRANT_NOT_ALLOWED');
  const created = await repos.chatGrants.grant({ conversation_id: action.conversation_id, tab_id: action.tab_id, tool: GRANTABLE_TOOL, source_action_id: action.id, granted_by: userId });
  const [grant] = await describeGrants(repos, [created], userId);
  chatBus.publish({ type: 'grant', user_id: userId, conversation_id: action.conversation_id, grant });
  return grant;
}

/** "Revogar", from the strip or from the card that granted it. 404 unknown or not this user's,
 * 409 already revoked. */
export async function revokeGrant(repos: Repositories, userId: string, grantId: string): Promise<ChatGrantView> {
  const revoked = await repos.chatGrants.revoke(grantId, userId);
  if (!revoked) {
    const existing = await repos.chatGrants.findByIdForUser(grantId, userId);
    throw existing ? conflict('Esta permissão já foi revogada') : notFound('Permissão não encontrada');
  }
  chatBus.publish({ type: 'grant_revoked', user_id: userId, conversation_id: revoked.conversation_id, grant_id: revoked.id });
  const [grant] = await describeGrants(repos, [revoked], userId);
  return grant;
}

/** The conversation's grants still in force, as `GET /chat` (web and phone) returns them. */
export async function activeGrants(repos: Repositories, userId: string, conversationId: string): Promise<ChatGrantView[]> {
  return describeGrants(repos, await repos.chatGrants.listActive(conversationId), userId);
}
