import { i18n, tk } from '../i18n';
import { formatNumber } from './format';
import type { AgentOnCard, EpicProgress, ProgressEstimate, PullRequestBadge, Tab, TabState } from './types';

const HOUR = 3600;

/** "20 min", "1 h", "2,5 h" (the decimal follows the language on screen). */
export function formatDuration(seconds: number): string {
  if (seconds < HOUR) return `${Math.round(seconds / 60)} min`;
  const hours = Math.round((seconds / HOUR) * 10) / 10;
  return `${formatNumber(hours)} h`;
}

/** The card's or epic's estimate as one line (spec D4, D6: work time, never a clock time). */
export function formatEstimate(e: ProgressEstimate): string {
  if (e.kind === 'done') return i18n.t('concluído');
  if (e.kind === 'none') return e.reason === 'not_started' ? i18n.t('ainda não começou') : i18n.t('estimativa após 2 subtarefas');
  const low = formatDuration(e.low_s);
  const high = formatDuration(e.high_s);
  if (low === high) return i18n.t('~{{time}} de trabalho', { time: low });
  const sameUnit = e.low_s < HOUR === e.high_s < HOUR;
  return i18n.t('~{{time}} de trabalho', { time: `${sameUnit ? low.replace(/ (min|h)$/, '') : low}–${high}` });
}

const BASIS_KEY = { agent_time: tk('tempo de agente'), wall_clock: tk('tempo corrido') } as const;

/** How the estimate was measured, in the language on screen. */
export const basisLabel = (basis: keyof typeof BASIS_KEY): string => i18n.t(BASIS_KEY[basis]);

const STATE_LABEL: Record<TabState, string> = {
  working: tk('trabalhando'),
  waiting_input: tk('esperando você'),
  waiting_permission: tk('pedindo permissão'),
  idle: tk('parado'),
  error: tk('erro'),
  waiting_background: tk('aguardando segundo plano'),
  finished: tk('concluído'),
};

/**
 * `background`: the agent waits on its own background work (sent as `working`, TER-644).
 * `finished`: the agent ended its turn with a report and asks nothing (sent as `idle`, TER-972).
 */
export function stateLabel(state: TabState | null, background = false, finished = false): string {
  if (background && state === 'working') return i18n.t(STATE_LABEL.waiting_background);
  if (finished && state === 'idle') return i18n.t(STATE_LABEL.finished);
  return state ? i18n.t(STATE_LABEL[state]) : i18n.t('sem sinal');
}

/** The monitor streams tab states live; the panel's own copy is up to 15 s old. */
export function withLiveTab(agent: AgentOnCard, live: Tab | undefined): AgentOnCard {
  if (!live) return agent;
  const background = live.state === 'waiting_background';
  const finished = live.state === 'finished';
  return {
    ...agent,
    // the shape the server sends (TER-644, TER-972): still at work or stopped, flagged
    state: background ? 'working' : finished ? 'idle' : live.state,
    state_at: live.state_at,
    background,
    finished,
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
  if (p.state === 'closed') return i18n.t('fechado');
  if (p.state === 'merged') {
    return { none: i18n.t('mergeado'), running: i18n.t('deploy rodando'), passed: i18n.t('deploy ok'), failed: i18n.t('deploy falhou') }[p.deploy_state];
  }
  if (p.ci_state === 'failed') return p.ci_summary.failing.length ? i18n.t('CI falhou: {{checks}}', { checks: p.ci_summary.failing.join(', ') }) : i18n.t('CI falhou');
  return { none: i18n.t('sem CI'), running: i18n.t('CI rodando'), passed: i18n.t('CI verde') }[p.ci_state];
}

export function epicCiLine(ci: NonNullable<EpicProgress['ci']>): string {
  const parts = [i18n.t('{{count}} abertos', { count: ci.open })];
  if (ci.failed) parts.push(i18n.t('{{n}} falhou', { n: ci.failed }));
  if (ci.running) parts.push(i18n.t('{{n}} rodando', { n: ci.running }));
  if (ci.deployed) parts.push(i18n.t('{{n}} em produção', { n: ci.deployed }));
  return i18n.t('PRs: {{parts}}', { parts: parts.join(' · ') });
}
