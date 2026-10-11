import type { ZodRawShape } from 'zod';
import { newApiToken, type ApiTokenScope } from '../auth/api-tokens.js';
import { ControlError } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import { DEFAULT_LOCALE, t, type Locale } from '../i18n/index.js';

/**
 * Tab tokens (spec 2026-09-27 agent tab MCP): the `/mcp` token `start_agent` mints for one agent tab,
 * so the agent in it can search the termhub memory, propose lessons and read the project's automation
 * policy — and, only while its own tab runs automatic work (an active run, agentic board preflight F-8),
 * read that run's card and report how the run ended. Nothing else: the narrowness is a security property.
 */

/** The fixed allowlist of a tab token (D2): every other tool is absent from `tools/list` and refused on
 *  `tools/call`, whatever the scopes and grants say. `get_automation_policy` is read-only: the project's autonomy
 *  level and what it covers, so the agent knows what happens after it opens a PR. `report_card` and `get_card`
 *  are listed and callable only by a tab with an active automatic run (their `allowedIf`), and act on that
 *  run's card only: the scopes stay `read`/`memory`. `report_card` also answers a tab whose latest run ended
 *  `blocked` and may still be adopted (spike TER-1031 §5.4), for `done` with the PR the agent opened by hand. */
export const TAB_TOKEN_TOOLS = ['search_memory', 'record_lesson', 'get_automation_policy', 'report_card', 'get_card'] as const;

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

/** The tab tools that need an active automatic run in the tab (preflight F-8); `report_card` also takes a
 *  tab whose run ended blocked within the adoption window, and every other tab gets this refusal. */
const RUN_ONLY_TOOLS: readonly string[] = ['report_card', 'get_card'];

/** pt-BR answer for a tools/call outside the allowlist (D2): naming a scope, as the ordinary refusal
 *  does, would mislead — no scope or grant unlocks it for a tab token. A run-only tool called from a tab
 *  without an active automatic run says that instead. */
export function tabRefusalMessage(name: string, locale: Locale = DEFAULT_LOCALE): string {
  const tool = name.slice(0, 64);
  if (RUN_ONLY_TOOLS.includes(name)) return t(locale, '{{tool}} só está disponível numa aba com trabalho automático em andamento', { tool });
  const tools = TAB_TOKEN_TOOLS.filter((x) => !RUN_ONLY_TOOLS.includes(x)).join(', ');
  return t(locale, 'O token desta aba só usa as ferramentas permitidas ({{tools}}, e report_card e get_card numa aba com trabalho automático); {{tool}} não está disponível aqui', { tools, tool });
}
