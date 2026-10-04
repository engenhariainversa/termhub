import type { AgentOnCard, EpicProgress, ProgressEstimate, PullRequestBadge, Tab, TabState } from './types';

const HOUR = 3600;

/** "20 min", "1 h", "2,5 h". */
export function formatDuration(seconds: number): string {
  if (seconds < HOUR) return `${Math.round(seconds / 60)} min`;
  const hours = Math.round((seconds / HOUR) * 10) / 10;
  return `${String(hours).replace('.', ',')} h`;
}

/** The card's or epic's estimate as one line (spec D4, D6: work time, never a clock time). */
export function formatEstimate(e: ProgressEstimate): string {
  if (e.kind === 'done') return 'concluído';
  if (e.kind === 'none') return e.reason === 'not_started' ? 'ainda não começou' : 'estimativa após 2 subtarefas';
  const low = formatDuration(e.low_s);
  const high = formatDuration(e.high_s);
  if (low === high) return `~${low} de trabalho`;
  const sameUnit = e.low_s < HOUR === e.high_s < HOUR;
  return `~${sameUnit ? low.replace(/ (min|h)$/, '') : low}–${high} de trabalho`;
}

export const BASIS_LABEL = { agent_time: 'tempo de agente', wall_clock: 'tempo corrido' } as const;

const STATE_LABEL: Record<TabState, string> = {
  working: 'trabalhando',
  waiting_input: 'esperando você',
  waiting_permission: 'pedindo permissão',
  idle: 'parado',
  error: 'erro',
  waiting_background: 'aguardando segundo plano',
};

/** `background`: the agent waits on its own background work (sent as `working`, TER-644). */
export function stateLabel(state: TabState | null, background = false): string {
  if (background && state === 'working') return STATE_LABEL.waiting_background;
  return state ? STATE_LABEL[state] : 'sem sinal';
}

/** The monitor streams tab states live; the panel's own copy is up to 15 s old. */
export function withLiveTab(agent: AgentOnCard, live: Tab | undefined): AgentOnCard {
  if (!live) return agent;
  const background = live.state === 'waiting_background';
  return {
    ...agent,
    // the shape the server sends (TER-644): still at work, flagged
    state: background ? 'working' : live.state,
    state_at: live.state_at,
    background,
    needs_you: live.state === 'waiting_input' || live.state === 'waiting_permission',
    activity: live.activity,
    activity_verb: live.activity_verb,
    rate_limited: live.rate_limited_at !== null,
  };
}

/** Every tab waiting for the user, once, across the epics shown. */
export function needsYouAgents(epics: EpicProgress[]): AgentOnCard[] {
  const byTab = new Map<string, AgentOnCard>();
  for (const e of epics) for (const c of e.cards) for (const a of c.agents ?? []) if (a.needs_you) byTab.set(a.tab_id, a);
  return [...byTab.values()];
}

/** One line per PR: an open PR by its CI, a merged one by its deploy (spec §5.6). */
export function ciLabel(p: PullRequestBadge): string {
  if (p.state === 'closed') return 'fechado';
  if (p.state === 'merged') return { none: 'mergeado', running: 'deploy rodando', passed: 'deploy ok', failed: 'deploy falhou' }[p.deploy_state];
  if (p.ci_state === 'failed') return p.ci_summary.failing.length ? `CI falhou: ${p.ci_summary.failing.join(', ')}` : 'CI falhou';
  return { none: 'sem CI', running: 'CI rodando', passed: 'CI verde' }[p.ci_state];
}

export function epicCiLine(ci: NonNullable<EpicProgress['ci']>): string {
  const parts = [`${ci.open} ${ci.open === 1 ? 'aberto' : 'abertos'}`];
  if (ci.failed) parts.push(`${ci.failed} falhou`);
  if (ci.running) parts.push(`${ci.running} rodando`);
  if (ci.deployed) parts.push(`${ci.deployed} em produção`);
  return `PRs: ${parts.join(' · ')}`;
}
