import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../lib/errors.js';
import { tk } from '../i18n/index.js';

/** Personal API tokens (Settings → Tokens de API), used by the MCP endpoint. Only the hash is stored. */
export const API_TOKEN_PREFIX = 'thb_pat_';
export const API_TOKEN_RE = /^thb_pat_[A-Za-z0-9_-]{43}$/;

/** What a token may do, on top of the owner's own grants (effective = scopes ∩ grants). `memory`
 *  (spec 2026-09-26 concierge memory D14) unlocks `record_decision`; `search_memory` needs only `read`
 *  and `answer_tab_question` only `terminals`, so writing memory reuses neither. `runs` (TER-1176, behind
 *  the `runs_api` flag) unlocks `/api/v1/runs`: prompts run on the owner's own accounts and machines. It
 *  is never granted to a gated (concierge) or tab token (`OWNER_ONLY_SCOPES`). */
export const API_TOKEN_SCOPES = ['read', 'tasks', 'terminals', 'memory', 'runs'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** Scopes only a person's own token may carry: never a gated (concierge) nor a tab token. */
export const OWNER_ONLY_SCOPES: readonly ApiTokenScope[] = ['runs'];

/**
 * Refuses (422) an owner-only scope on a gated (concierge) or tab token. Called where every token is
 * made (`ApiTokensRepository.create`), so no minting path can hand the concierge or an agent tab the
 * right to run prompts on the person's accounts.
 */
export function assertScopesFor(token: { gated?: boolean; tabId?: string | null }, scopes: readonly ApiTokenScope[]): void {
  if (!token.gated && !token.tabId) return;
  if (scopes.some((s) => OWNER_ONLY_SCOPES.includes(s))) {
    throw new HttpError(422, tk('O escopo runs só vale para tokens pessoais, nunca para o chat nem para uma aba'), 'VALIDATION');
  }
}

export const MAX_ACTIVE_TOKENS_PER_USER = 20;
export const API_TOKEN_EVENT_RETENTION_DAYS = 30;

export function newApiToken(): { token: string; hash: string } {
  const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashApiToken(token) };
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Known scopes only, once each, in catalog order. */
export function toScopes(raw: readonly string[]): ApiTokenScope[] {
  return API_TOKEN_SCOPES.filter((s) => raw.includes(s));
}
