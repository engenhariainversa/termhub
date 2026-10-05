import type { ZodRawShape } from 'zod';
import { newApiToken, type ApiTokenScope } from '../auth/api-tokens.js';
import { ControlError } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';

/**
 * Tab tokens (spec 2026-09-27 agent tab MCP): the `/mcp` token `start_agent` mints for one agent tab,
 * so the agent in it can search the termhub memory and propose lessons — and nothing else.
 */

/** The fixed allowlist of a tab token (D2): every other tool is absent from `tools/list` and refused on
 *  `tools/call`, whatever the scopes and grants say. `get_automation_policy` is read-only: the project's autonomy
 *  level and what it covers, so the agent knows what happens after it opens a PR. */
export const TAB_TOKEN_TOOLS = ['search_memory', 'record_lesson', 'get_automation_policy'] as const;

/** Scopes of a tab token (D2). The allowlist narrows them further. */
export const TAB_TOKEN_SCOPES: ApiTokenScope[] = ['read', 'memory'];

/** Memory kinds a tab never reads (D3): the person's own chat messages and the gate's decisions. */
export const TAB_EXCLUDED_KINDS = ['message', 'action'] as const;

/** Last floor of a tab token's life (D6): it is revoked with the tab long before this. */
export const TAB_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The name shown in Settings › Tokens (D1). */
export function tabTokenName(tabName: string): string {
  return `aba «${tabName.slice(0, 60)}» (automático)`;
}

/**
 * Mints the token of one agent tab (D1, D6). `gated: false` and the narrow scopes are hardcoded here,
 * never taken from a caller: this is the one function that makes tab tokens, so a tab token can never be
 * gated nor carry wider scopes (§6). The plain token goes back to the caller only — it is never logged.
 */
export async function mintTabToken(repos: Repositories, userId: string, tab: { id: string; name: string }): Promise<{ token: string; id: string }> {
  const { token, hash } = newApiToken();
  const row = await repos.apiTokens.create(
    userId,
    { name: tabTokenName(tab.name), scopes: [...TAB_TOKEN_SCOPES], expiresAt: new Date(Date.now() + TAB_TOKEN_TTL_MS), gated: false, tabId: tab.id },
    hash,
  );
  return { token, id: row.id };
}

/**
 * The one pinning rule for every call of a tab token (D5), applied by the MCP route before the tool
 * runs: `project_id` must be the tab's project and `tab_id` the tab itself. A different value is refused
 * whether or not the tool declares the key; an absent one is filled in only when the tool declares it
 * (`declaredKeys`, the keys of the tool's input shape), so a strict schema never sees a stray argument.
 * Returns a new object; the arguments given are left untouched.
 */
export function pinTabArgs(tab: { id: string; project_id: string }, args: Record<string, unknown>, declaredKeys: readonly string[]): Record<string, unknown> {
  if (args.project_id !== undefined && args.project_id !== tab.project_id) throw new ControlError('TAB_SCOPE', 'O token desta aba só acessa o projeto da aba');
  if (args.tab_id !== undefined && args.tab_id !== tab.id) throw new ControlError('TAB_SCOPE', 'O token desta aba só age em nome da própria aba');
  const out = { ...args };
  if (declaredKeys.includes('project_id')) out.project_id = tab.project_id;
  if (declaredKeys.includes('tab_id')) out.tab_id = tab.id;
  return out;
}

/**
 * A tool's input shape as a tab token's call is validated against (D5): `project_id` and `tab_id`, when
 * declared, become optional — a tab does not know its ids, and `pinTabArgs` fills them in right after, so
 * the tool still runs with both present. Every other key keeps its own rule.
 */
export function tabInputShape(shape: ZodRawShape): ZodRawShape {
  const out: ZodRawShape = { ...shape };
  for (const key of ['project_id', 'tab_id'] as const) {
    const field = out[key];
    if (field) out[key] = field.optional();
  }
  return out;
}

/** pt-BR answer for a tools/call outside the allowlist (D2): naming a scope, as the ordinary refusal
 *  does, would mislead — no scope or grant unlocks it for a tab token. */
export function tabRefusalMessage(name: string): string {
  return `O token desta aba só usa as ferramentas permitidas (${TAB_TOKEN_TOOLS.join(', ')}); ${name.slice(0, 64)} não está disponível aqui`;
}
