/**
 * The MCP half of the run_command allow list (TER-1081): `list_command_rules` tells the concierge what it
 * may run without a card, and `propose_command_rule` adds a rule — on a chat token always through a card
 * the person approves (the gate classes it `write` and no grant or default covers it).
 */
import { describeCommandRules, type ChatCommandRuleView } from '../chat/command-rule-grants.js';
import { parseCommand, ruleWordsAllowed, type CommandRuleMatch } from '../chat/command-rules.js';
import { COMMAND_RULE_BUDGET, DEFAULT_ALLOW_BUDGETS } from '../chat/gate.js';
import { msg } from '../i18n/index.js';
import { ControlError, type ControlContext } from './context.js';

const NEVER =
  'Sempre pedem confirmação, com ou sem regra: comandos encadeados ou com redirecionamento, substituição, variáveis, globs, "!" ou quebra de linha; sudo, rm, kill e afins; git push --force/-f, git reset --hard, git clean; e qualquer coisa que toque segredos (.env, chaves, ~/.ssh, tokens). Só numa aba de shell (sem agente rodando).';

export interface CommandRulesReport {
  rules: ChatCommandRuleView[];
  read_only_default: { on: boolean; per_hour: number; commands: string };
  per_rule_per_hour: number;
  never: string;
}

/** `list_command_rules`: the rules in force (one project's and the global ones, or all), and the default list. */
export async function listCommandRulesTool(ctx: ControlContext, input: { project_id?: string }): Promise<CommandRulesReport> {
  const userId = ctx.scope.user.id;
  let rules;
  if (input.project_id) {
    const { project } = await ctx.scoped.project(input.project_id);
    rules = await ctx.repos.chatCommandRules.listActiveFor(userId, project.id);
  } else {
    rules = await ctx.repos.chatCommandRules.listForUser(userId, 'active');
  }
  const restricted = await ctx.repos.chatDefaultRestrictions.listForUser(userId);
  return {
    rules: await describeCommandRules(ctx.repos, rules, userId),
    read_only_default: {
      on: !restricted.has('read_commands'),
      per_hour: DEFAULT_ALLOW_BUDGETS.read_commands,
      commands: 'git status/log/diff/show, git branch (só listar), gh pr view/checks/list, gh run view/list, ls, pwd, df, du, ps, uptime, which, whoami, uname, cat/head/tail de arquivos dentro do diretório da aba, <programa> --version',
    },
    per_rule_per_hour: COMMAND_RULE_BUDGET,
    never: NEVER,
  };
}

const RULE_REFUSED = (reason: string) =>
  new ControlError('RULE_NOT_ALLOWED', msg('Este padrão não pode virar uma regra ({{reason}}): só um comando simples, sem encadear nem expandir nada, fora da lista que sempre pede confirmação. Um prefixo não pode começar por ssh, um shell ou outro programa que roda comandos; para esses, use match "exact".', { reason }));

/**
 * `propose_command_rule`: adds a command rule once the person approves the card. The pattern is parsed
 * like a command, so a rule can only hold what the gate could ever match. Owner-scoped: the project and
 * machines must be the person's own.
 */
export async function proposeCommandRule(
  ctx: ControlContext,
  input: { pattern: string; match: CommandRuleMatch; project_id?: string; machine_ids?: string[]; expires_at?: string },
): Promise<{ rule: ChatCommandRuleView; created: boolean }> {
  const parsed = parseCommand(input.pattern);
  if (!parsed.ok) throw RULE_REFUSED(parsed.reason);
  const refused = ruleWordsAllowed(parsed.words, input.match);
  if (refused) throw RULE_REFUSED(refused);
  const projectId = input.project_id ? (await ctx.scoped.project(input.project_id)).project.id : null;
  const machineIds = [...new Set(input.machine_ids ?? [])];
  for (const id of machineIds) await ctx.scoped.machine(id);
  const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new ControlError('RULE_EXPIRED', 'A validade da regra já passou: use uma data no futuro ou deixe sem validade.');
  const { rule, created } = await ctx.repos.chatCommandRules.create({
    user_id: ctx.scope.user.id,
    project_id: projectId,
    words: parsed.words,
    match: input.match,
    machine_ids: machineIds,
    conversation_id: ctx.token?.chat_conversation_id ?? null,
    source_action_id: ctx.approval?.actionId ?? null,
    expires_at: expiresAt,
  });
  return { rule: (await describeCommandRules(ctx.repos, [rule], ctx.scope.user.id))[0]!, created };
}
