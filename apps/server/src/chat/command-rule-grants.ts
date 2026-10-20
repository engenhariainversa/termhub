/**
 * Creating, reading and revoking the command rules of `run_command` (TER-1081), for the chat card's two
 * buttons, "Permissões do chat" and the MCP tools. The gate's half is `commandRuleCovering` in
 * gate-runtime.ts; both judge a command with the same functions (chat/command-rules.ts).
 */
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { ChatCommandRule } from '../db/repositories/chat-command-rules.js';
import type { Repositories } from '../db/repositories/index.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';
import { formatWords, ruleEligible, ruleWordsAllowed, suggestPrefix, type CommandRuleMatch } from './command-rules.js';

/** A rule as screens and the concierge read it: names resolved owner-scoped, the command as text. */
export interface ChatCommandRuleView {
  id: string;
  /** The command (or its first words, for a prefix) as it reads in a shell. */
  pattern: string;
  match: CommandRuleMatch;
  /** null: every project. */
  project_id: string | null;
  project_name: string | null;
  /** Empty: every machine. */
  machine_ids: string[];
  machine_names: string[];
  source_action_id: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  state: 'active' | 'revoked' | 'expired';
}

/** The decision words of a run_command card's two buttons. */
export type CommandRuleDecision = 'approve_command' | 'approve_command_prefix';

export async function describeCommandRules(repos: Repositories, rules: ChatCommandRule[], ownerId: string, now = new Date()): Promise<ChatCommandRuleView[]> {
  const projectIds = [...new Set(rules.flatMap((r) => (r.project_id ? [r.project_id] : [])))];
  const machineIds = [...new Set(rules.flatMap((r) => r.machine_ids))];
  const [projects, machines] = await Promise.all([
    projectIds.length ? repos.projects.findByIdsForOwner(projectIds, ownerId) : [],
    machineIds.length ? repos.machines.findByIdsForOwner(machineIds, ownerId) : [],
  ]);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const machineName = new Map(machines.map((m) => [m.id, m.name]));
  return rules.map((r) => ({
    id: r.id,
    pattern: formatWords(r.words),
    match: r.match,
    project_id: r.project_id,
    project_name: r.project_id ? (projectName.get(r.project_id) ?? null) : null,
    machine_ids: r.machine_ids,
    machine_names: r.machine_ids.flatMap((id) => (machineName.has(id) ? [machineName.get(id)!] : [])),
    source_action_id: r.source_action_id,
    created_at: r.created_at,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    state: r.revoked_at ? 'revoked' : r.expires_at && Date.parse(r.expires_at) <= now.getTime() ? 'expired' : 'active',
  }));
}

const NOT_ALLOWED = () => new HttpError(400, 'Só dá para permitir sempre um comando simples, fora da lista de comandos que sempre pedem confirmação, numa aba sua', 'GRANT_NOT_ALLOWED');

/**
 * The rule a button of a pending run_command card would create, checked before anything is decided: the
 * row is this user's and pending, its command is eligible (one simple command, not on the "never" list),
 * a prefix exists for "começam com", and the tab resolves owner-scoped — its project is the rule's.
 */
export async function assertCommandRuleAction(repos: Repositories, userId: string, actionId: string, decision: CommandRuleDecision): Promise<{ action: ChatAction; words: string[]; match: CommandRuleMatch; projectId: string }> {
  const row = await repos.chatActions.findByIdForUser(actionId, userId);
  if (!row) throw notFound('Ação não encontrada');
  if (row.status !== 'pending') throw conflict('Esta ação já foi decidida');
  const args = (row.args ?? {}) as Record<string, unknown>;
  if (row.tool !== 'run_command' || typeof args.command !== 'string' || typeof args.tab_id !== 'string') throw NOT_ALLOWED();
  const parsed = ruleEligible(args.command);
  if (!parsed.ok) throw NOT_ALLOWED();
  const match: CommandRuleMatch = decision === 'approve_command_prefix' ? 'prefix' : 'exact';
  const words = match === 'prefix' ? suggestPrefix(parsed.words) : parsed.words;
  if (!words || ruleWordsAllowed(words, match)) throw NOT_ALLOWED();
  const [tab] = await repos.tabs.findByIdsForOwner([args.tab_id], userId);
  if (!tab) throw NOT_ALLOWED();
  return { action: row, words, match, projectId: tab.project_id };
}

/** Adds the rule of a card the person just approved: this project, every machine, no expiry. */
export async function grantCommandRule(repos: Repositories, userId: string, action: ChatAction, check: { words: string[]; match: CommandRuleMatch; projectId: string }): Promise<ChatCommandRuleView> {
  const { rule } = await repos.chatCommandRules.create({ user_id: userId, project_id: check.projectId, words: check.words, match: check.match, conversation_id: action.conversation_id, source_action_id: action.id });
  return (await describeCommandRules(repos, [rule], userId))[0]!;
}

/** The rules in force a conversation's cards may show as created by them: the project's and the global
 * ones, or — for the general chat — all of the user's. */
export async function activeCommandRules(repos: Repositories, userId: string, projectId: string | null): Promise<ChatCommandRuleView[]> {
  const rules = projectId ? await repos.chatCommandRules.listActiveFor(userId, projectId) : await repos.chatCommandRules.listForUser(userId, 'active');
  return describeCommandRules(repos, rules, userId);
}

/** "Permissões do chat": the rules in force and the ones revoked or expired. */
export async function listCommandRules(repos: Repositories, userId: string): Promise<{ active: ChatCommandRuleView[]; ended: ChatCommandRuleView[] }> {
  const [active, ended] = await Promise.all([repos.chatCommandRules.listForUser(userId, 'active'), repos.chatCommandRules.listForUser(userId, 'ended')]);
  return { active: await describeCommandRules(repos, active, userId), ended: await describeCommandRules(repos, ended, userId) };
}

/** "Revogar": 404 unknown or another user's, 409 already revoked. */
export async function revokeCommandRule(repos: Repositories, userId: string, ruleId: string): Promise<ChatCommandRuleView> {
  const revoked = await repos.chatCommandRules.revoke(ruleId, userId);
  if (revoked) return (await describeCommandRules(repos, [revoked], userId))[0]!;
  throw (await repos.chatCommandRules.findByIdForUser(ruleId, userId)) ? conflict('Esta regra já foi revogada') : notFound('Regra não encontrada');
}
