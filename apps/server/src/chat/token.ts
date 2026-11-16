import { newApiToken, type ApiTokenScope } from '../auth/api-tokens.js';
import type { Repositories } from '../db/repositories/index.js';

/** Name of the token the server mints for the concierge. It is rotated on every run, so a leaked
 * one is useless within a day and the audit trail in api_token_events stays per-run. */
export const CONCIERGE_TOKEN_NAME = 'concierge (automático)';
const TTL_MS = 24 * 60 * 60 * 1000;

/** Mints a fresh token for one conversation's run and revokes that conversation's previous one —
 * never another conversation's: a project chat and the account-wide chat run at the same time, and
 * revoking across them would cut the other run's MCP calls mid-answer. A token minted before tokens
 * named their conversation (null) belongs to the account-wide chat, the only one that existed. */
export async function mintConciergeToken(
  repos: Repositories,
  userId: string,
  conversationId: string,
  scopes: ApiTokenScope[],
  opts: { accountWide?: boolean; projectId?: string | null; machineId?: string | null } = {},
): Promise<string> {
  // One targeted update, not a read of every token the person ever had (thousands, one per run).
  await repos.apiTokens.revokeLiveConcierge(userId, conversationId, { accountWide: opts.accountWide });

  const { token, hash } = newApiToken();
  // `gated: true` is hardcoded here, never taken from a caller — this is the one function that
  // mints the concierge's own token, so wide scopes and the gate flag can only ever arrive together.
  await repos.apiTokens.create(
    userId,
    { name: CONCIERGE_TOKEN_NAME, scopes, expiresAt: new Date(Date.now() + TTL_MS), gated: true, chatConversationId: conversationId, origin: 'concierge', projectId: opts.projectId ?? null, machineId: opts.machineId ?? null },
    hash,
  );
  return token;
}
