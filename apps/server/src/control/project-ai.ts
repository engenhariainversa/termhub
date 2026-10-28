import { CAPABILITY_CLAUDE_SYSTEM_PROMPT } from '@termhub/agent-protocol';
import { agents as liveAgents } from '../agent/registry.js';
import { getAccountUsage, type AiAccountUsage } from '../ai/index.js';
import { usableIn } from '../ai/exclusive.js';
import { isAgentProvider, type AgentProvider } from '../ai/project-accounts.js';
import { forgetLimited, limitedUntilOf, machineReady, markLimited, projectChatAccounts, projectPick, type HostAgents, type ProjectPickReason } from '../chat/host.js';
import { peakUtilization, SWAP_MAX_UTILIZATION, windowLimits } from '../control/account-swap.js';
import type { AiAccount, Machine } from '../db/repositories/types.js';
import { msg } from '../i18n/index.js';
import { describeProjectAi, saveProjectAi, type ProjectAiOption, type ProjectAiScope } from '../setup/project-ai.js';
import type { ProjectAi } from '../setup/schema.js';
import { ControlError, type ControlContext } from './context.js';

/**
 * The project's "AI accounts and model" Setup and its chat's account through MCP (TER-1147): what the
 * concierge reads and changes so the person does not have to open the Setup, and the way out of a project
 * chat parked on a usage limit. The saved block is the Setup screen's own (`saveProjectAi`): the same
 * checks, exclusive accounts (TER-990) included.
 */

/** What the live agents tell: the registry in production, a stand-in in a test. */
type Agents = Pick<HostAgents, 'capabilities'>;

const aiScopeOf = (ctx: ControlContext): ProjectAiScope => ({ scoped: ctx.scoped, ownerId: ctx.scope.ownerId, log: ctx.log });

/** An agent tab's token never changes where its own project's work runs, nor the chat's account. */
function refuseTab(ctx: ControlContext): void {
  if (ctx.token?.tab) throw new ControlError('FORBIDDEN', 'Só a pessoa ou o concierge mudam as contas de IA de um projeto, nunca um agente numa aba');
}

export interface UsageView {
  ok: boolean;
  plan: string | null;
  /** model: the family a window caps alone (e.g. "fable"); null = the whole account */
  windows: { label: string; model: string | null; utilization: number; resets_at: string | null }[];
  error: string | null;
}

const usageView = (u: AiAccountUsage): UsageView => ({
  ok: u.ok,
  plan: u.plan,
  windows: u.windows.map((w) => ({ label: w.label, model: w.model ?? null, utilization: w.utilization, resets_at: w.resets_at })),
  error: u.ok ? null : u.error,
});

export interface ProjectAiAccountView {
  /** 1-based place in the project's order */
  position: number;
  id: string;
  label: string;
  provider: AgentProvider;
  machine: { id: string; name: string; online: boolean };
  /** the machine's own login (no config dir override) */
  default: boolean;
  exclusive_project: { id: string; name: string } | null;
  /** false: listed but skipped by every path (exclusive to another project, machine unlinked or gone) */
  usable: boolean;
  /** Claude: the project chat leaves the account aside until then, after it met its limit */
  limited_until: string | null;
  usage: UsageView;
}

export interface ConciergeView {
  account: { id: string; label: string } | null;
  machine: { id: string; name: string } | null;
  model: string | null;
  reason: ProjectPickReason | 'no_claude_account';
  text: string;
}

const REASON_TEXT: Record<ConciergeView['reason'], string> = {
  first_with_room: 'a primeira conta do Claude da ordem com a máquina online e sem limite atingido',
  all_limited_last: 'todas as contas do Claude atingiram o limite: fica na última em que o chat respondeu',
  all_limited_first: 'todas as contas do Claude atingiram o limite: fica na primeira com a máquina online',
  none_ready: 'nenhuma máquina das contas do Claude da lista está online com um agente que roda o chat: vale o host da conversa geral',
  no_claude_account: 'o projeto não lista conta do Claude utilizável: vale o host da conversa geral',
};

async function machinesOf(ctx: ControlContext): Promise<Machine[]> {
  return ctx.repos.machines.list(ctx.scope.user.id);
}

/** Who answers the project's chat now and why, without waiting on any agent (TER-1144's own pick). */
async function conciergeNow(ctx: ControlContext, projectId: string, ai: ProjectAi, machines: Machine[], agents: Agents): Promise<ConciergeView> {
  const { accounts } = await projectChatAccounts(ctx.repos, ctx.scope.user.id, projectId, machines);
  const conversation = await ctx.repos.chat.findLatestActiveForProject(projectId, ctx.scope.user.id);
  const model = conversation?.model ?? ai.models.claude;
  if (accounts.length === 0) return { account: null, machine: null, model, reason: 'no_claude_account', text: REASON_TEXT.no_claude_account };
  const { pick, reason } = projectPick(accounts, (m) => machineReady(agents, m.id, CAPABILITY_CLAUDE_SYSTEM_PROMPT), conversation?.ai_account_id ?? null);
  return {
    account: pick ? { id: pick.account.id, label: pick.account.label } : null,
    machine: pick ? { id: pick.machine.id, name: pick.machine.name } : null,
    model,
    reason,
    text: REASON_TEXT[reason],
  };
}

export interface ProjectAiSetupView {
  project: { id: string; name: string };
  accounts: ProjectAiAccountView[];
  /** accounts the project may add (of a machine linked to it), not listed yet */
  available: ProjectAiOption[];
  models: ProjectAi['models'];
  concierge: ConciergeView;
}

/** `get_project_ai_setup`: the project's accounts in order with their usage, its models and who answers its chat. */
export async function getProjectAiSetup(ctx: ControlContext, input: { project_id: string }, agents: Agents = liveAgents): Promise<ProjectAiSetupView> {
  const { project } = await ctx.scoped.project(input.project_id);
  const [{ ai, available }, machines, accounts] = await Promise.all([describeProjectAi(ctx.repos, aiScopeOf(ctx), project.id), machinesOf(ctx), ctx.repos.aiAccounts.list(ctx.scope.ownerId)]);
  const offered = new Set(available.map((o) => o.id));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const listed = ai.accounts.map((id) => byId.get(id)).filter((a): a is AiAccount & { provider: AgentProvider } => !!a && isAgentProvider(a.provider));
  const views = await Promise.all(
    listed.map(async (a, i): Promise<ProjectAiAccountView> => {
      const machine = machines.find((m) => m.id === a.machine_id);
      return {
        position: i + 1,
        id: a.id,
        label: a.label,
        provider: a.provider,
        machine: { id: a.machine_id, name: machine?.name ?? '', online: machine ? agents.capabilities(machine.id) !== null : false },
        default: a.config_dir === null,
        exclusive_project: a.exclusive_project,
        usable: offered.has(a.id) && usableIn(a, project.id),
        limited_until: a.provider === 'claude' ? limitedUntilOf(a.id) : null,
        usage: usageView(await getAccountUsage(a, machine)),
      };
    }),
  );
  return {
    project: { id: project.id, name: project.name },
    accounts: views,
    available: available.filter((o) => !ai.accounts.includes(o.id)),
    models: ai.models,
    concierge: await conciergeNow(ctx, project.id, ai, machines, agents),
  };
}

export interface SetProjectAiInput {
  project_id: string;
  /** the whole order; omitted = the current one */
  accounts?: string[];
  add?: string[];
  remove?: string[];
  /** this machine's accounts go first, in their order: the concierge (and start_agent with no machine) prefer it */
  prefer_machine_id?: string;
  models?: { claude?: string | null; chatgpt?: string | null };
  confirm?: boolean;
}

/** The order after the call's changes: replace, then remove, then add at the end, then the machine first. */
function nextOrder(current: string[], input: SetProjectAiInput, machineOf: (id: string) => string | undefined): string[] {
  const removed = new Set(input.remove ?? []);
  let order = (input.accounts ?? current).filter((id) => !removed.has(id));
  for (const id of input.add ?? []) if (!order.includes(id)) order.push(id);
  order = [...new Set(order)];
  if (input.prefer_machine_id) {
    const first = order.filter((id) => machineOf(id) === input.prefer_machine_id);
    order = [...first, ...order.filter((id) => machineOf(id) !== input.prefer_machine_id)];
  }
  return order;
}

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** How a side of the change reads: "1. Claude · jarvis, 2. Codex · hulk; modelos: Claude opus, Codex padrão do CLI". */
function describe(ai: ProjectAi, nameOf: (id: string) => string): string {
  const accounts = ai.accounts.length ? ai.accounts.map((id, i) => `${i + 1}. ${nameOf(id)}`).join(', ') : 'nenhuma conta (vale o comportamento de antes do Setup)';
  const model = (m: string | null) => m ?? 'padrão do CLI';
  return `${accounts}; modelos: Claude ${model(ai.models.claude)}, Codex ${model(ai.models.chatgpt)}`;
}

export interface SetProjectAiOut {
  project_id: string;
  changed: boolean;
  /** true: nothing was saved; the call needs confirm: true */
  confirm_required: boolean;
  before: string;
  after: string;
  ai: ProjectAi;
  concierge?: ConciergeView;
}

/**
 * `set_project_ai_setup`: changes the project's account order (replace, add, remove, a machine first) and
 * default models. Without `confirm: true` it only answers the before and after and saves nothing; with it,
 * on the concierge's token, it runs only from the card the person approved (the gate asks it; this check
 * stands even if a call got through without one).
 */
export async function setProjectAiSetup(ctx: ControlContext, input: SetProjectAiInput, agents: Agents = liveAgents): Promise<SetProjectAiOut> {
  refuseTab(ctx);
  const { project } = await ctx.scoped.project(input.project_id);
  const { ai: current } = await describeProjectAi(ctx.repos, aiScopeOf(ctx), project.id);
  const [accounts, machines] = await Promise.all([ctx.repos.aiAccounts.list(ctx.scope.ownerId), machinesOf(ctx)]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  if (input.prefer_machine_id) {
    const machine = await ctx.scoped.machine(input.prefer_machine_id);
    if (!(await ctx.repos.projectMachines.find(project.id, machine.id))) throw new ControlError('MACHINE_NOT_LINKED', msg('A máquina {{machine}} não está ligada ao projeto', { machine: machine.name }));
  }
  const next: ProjectAi = {
    accounts: nextOrder(current.accounts, input, (id) => byId.get(id)?.machine_id),
    models: {
      claude: input.models?.claude !== undefined ? input.models.claude : current.models.claude,
      chatgpt: input.models?.chatgpt !== undefined ? input.models.chatgpt : current.models.chatgpt,
    },
  };
  const nameOf = (id: string) => {
    const a = byId.get(id);
    const machine = a && machines.find((m) => m.id === a.machine_id);
    return a ? `${a.label} · ${machine?.name ?? a.machine_id}` : id;
  };
  const base = { project_id: project.id, before: describe(current, nameOf) };
  if (sameOrder(current.accounts, next.accounts) && current.models.claude === next.models.claude && current.models.chatgpt === next.models.chatgpt) {
    return { ...base, changed: false, confirm_required: false, after: base.before, ai: current };
  }
  if (!input.confirm) return { ...base, changed: false, confirm_required: true, after: describe(next, nameOf), ai: current };
  if (ctx.token?.gated && !ctx.approval) {
    throw new ControlError('CONFIRMATION_REQUIRED', msg('Mudar as contas de IA ou o modelo de um projeto precisa da confirmação da pessoa no chat. Nada foi alterado: proponha a chamada de novo.'));
  }
  const saved = await saveProjectAi(ctx.repos, aiScopeOf(ctx), project.id, next);
  ctx.log?.info({ project_id: project.id, accounts: saved.ai.accounts.length, via: ctx.token?.gated ? 'chat' : 'mcp' }, 'project ai setup changed');
  return { ...base, changed: true, confirm_required: false, after: describe(saved.ai, nameOf), ai: saved.ai, concierge: await conciergeNow(ctx, project.id, saved.ai, machines, agents) };
}

export interface UnstickAccountView {
  id: string;
  label: string;
  machine: { id: string; name: string };
  /** ready: the machine runs the chat now; full: a fresh reading at the limit; unknown: no reading (tried anyway) */
  state: 'room' | 'full' | 'unknown' | 'offline';
  peak: number | null;
  resets_at: string | null;
}

export interface UnstickOut {
  project_id: string;
  unstuck: boolean;
  account: { id: string; label: string } | null;
  machine: { id: string; name: string } | null;
  model: string | null;
  accounts: UnstickAccountView[];
  text: string;
}

/** When the windows that keep the account full reset: the latest of them, since all must reset. */
function fullUntil(u: AiAccountUsage, model: string | null): string | null {
  const resets = u.windows.filter((w) => windowLimits(w, model) && w.utilization >= SWAP_MAX_UTILIZATION && w.resets_at).map((w) => w.resets_at!);
  return resets.length ? resets.sort().at(-1)! : null;
}

/**
 * `unstick_project_chat`: the project chat forgets which of its Claude accounts met their limit, reads
 * each one's usage again (fresh) on the machines that are online, leaves aside only the ones still full,
 * and starts its next message on the first of the project's order with room — the conversation's account
 * moves there. It never picks an account the project does not list, nor one exclusive to another project.
 */
export async function unstickProjectChat(ctx: ControlContext, input: { project_id: string }, agents: Agents = liveAgents): Promise<UnstickOut> {
  refuseTab(ctx);
  const { project } = await ctx.scoped.project(input.project_id);
  const machines = await machinesOf(ctx);
  const { accounts, model: projectModel } = await projectChatAccounts(ctx.repos, ctx.scope.user.id, project.id, machines);
  const conversation = await ctx.repos.chat.findLatestActiveForProject(project.id, ctx.scope.user.id);
  const model = conversation?.model ?? projectModel;
  const none = { project_id: project.id, unstuck: false, account: null, machine: null, model };
  if (accounts.length === 0) {
    return { ...none, accounts: [], text: 'O projeto não lista conta do Claude utilizável numa máquina ligada a ele: o chat dele roda no host da conversa geral. Ajuste com set_project_ai_setup.' };
  }
  forgetLimited(accounts.map((a) => a.account.id));
  const ready = (m: Machine) => machineReady(agents, m.id, CAPABILITY_CLAUDE_SYSTEM_PROMPT);
  const views = await Promise.all(
    accounts.map(async ({ account, machine }): Promise<UnstickAccountView> => {
      const view = { id: account.id, label: account.label, machine: { id: machine.id, name: machine.name } };
      if (!ready(machine)) return { ...view, state: 'offline', peak: null, resets_at: null };
      const usage = await getAccountUsage(account, machine, true);
      const peak = peakUtilization(usage, model);
      if (peak === null) return { ...view, state: 'unknown', peak, resets_at: null };
      if (peak < SWAP_MAX_UTILIZATION) return { ...view, state: 'room', peak, resets_at: null };
      const resets_at = fullUntil(usage, model);
      markLimited(account.id, resets_at);
      return { ...view, state: 'full', peak, resets_at };
    }),
  );
  const { pick, reason } = projectPick(accounts, ready, conversation?.ai_account_id ?? null);
  const stuck = reason !== 'first_with_room' || !pick;
  console.info('chat: project chat re-read its accounts', { project_id: project.id, to: pick?.account.id ?? null, reason });
  if (stuck) {
    const resets = views.map((v) => v.resets_at).filter((r): r is string => r !== null).sort();
    const text = views.every((v) => v.state === 'offline')
      ? 'Nenhuma máquina das contas do Claude do projeto está online com um agente que roda o chat.'
      : `Todas as contas do Claude do projeto continuam no limite${resets.length ? `; a primeira volta em ${resets[0]}` : ''}. Adicione outra conta com set_project_ai_setup ou espere.`;
    return { ...none, accounts: views, text };
  }
  if (conversation && conversation.ai_account_id !== pick.account.id) await ctx.repos.chat.setRunAccount(conversation.id, pick.account.id);
  return {
    project_id: project.id,
    unstuck: true,
    account: { id: pick.account.id, label: pick.account.label },
    machine: { id: pick.machine.id, name: pick.machine.name },
    model,
    accounts: views,
    text: `A próxima mensagem do chat do projeto começa na conta "${pick.account.label}" da máquina ${pick.machine.name}.`,
  };
}
