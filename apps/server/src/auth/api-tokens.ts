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

/**
 * Where a token came from (TER-1191). `person`: made on Settings → Tokens de API. `concierge`: the chat's
 * own, one per run (chat/token.ts). `tab`: the one `start_agent` gives an agent tab (mcp/tab-token.ts);
 * `automation` is the same for a tab an automatic run opened. Machine hooks keep their own token in
 * `machine_hooks` and are not API tokens.
 */
export const API_TOKEN_ORIGINS = ['person', 'concierge', 'tab', 'automation'] as const;
export type ApiTokenOrigin = (typeof API_TOKEN_ORIGINS)[number];
/** The origins termhub mints by itself. */
export const SYSTEM_TOKEN_ORIGINS: readonly ApiTokenOrigin[] = ['concierge', 'tab', 'automation'];

/** A system token, once revoked or expired, is deleted after this (TER-1191). Its events are already gone
 *  by then (API_TOKEN_EVENT_RETENTION_DAYS), so nothing of the audit trail is lost with it. */
export const SYSTEM_TOKEN_RETENTION_DAYS = 30;
/** A person's own revoked token is deleted after this (TER-1191). An expired one stays: it is theirs. */
export const PERSON_REVOKED_TOKEN_RETENTION_DAYS = 90;
/** "Revogar inativos" takes a live system token unused (or never used) for this long. */
export const SYSTEM_TOKEN_IDLE_DAYS = 7;

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
