import { i18n, tk } from '../i18n';
import { formatNumber } from './format';
import { NEEDS_YOU, type AgentOnCard, type EpicProgress, type ProgressEstimate, type PullRequestBadge, type Tab, type TabState } from './types';

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
  blocked: tk('bloqueado'),
  auth_required: tk('login expirado'),
  trust_prompt: tk('confiar na pasta?'),
};

type StateFlags = Partial<Pick<AgentOnCard, 'background' | 'finished' | 'blocked' | 'auth_required' | 'trust_prompt'>>;

/** The tab's own state from the contract's older one and its flags (TER-644, TER-972, TER-1046). */
export function fullStateOf(a: { state: TabState | null } & StateFlags): TabState | null {
  if (a.background && a.state === 'working') return 'waiting_background';
  if (a.finished && a.state === 'idle') return 'finished';
  if (a.blocked && a.state === 'idle') return 'blocked';
  if (a.auth_required && a.state === 'error') return 'auth_required';
  if (a.trust_prompt && a.state === 'waiting_input') return 'trust_prompt';
  return a.state;
}

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
  const s = live.state;
  return {
    ...agent,
    // the shape the server sends (TER-644, TER-972, TER-1046): each newer state as an older one, flagged
    state: s === 'waiting_background' ? 'working' : s === 'finished' || s === 'blocked' ? 'idle' : s === 'auth_required' ? 'error' : s === 'trust_prompt' ? 'waiting_input' : s,
    state_at: live.state_at,
    background: s === 'waiting_background',
    finished: s === 'finished',
    blocked: s === 'blocked',
    auth_required: s === 'auth_required',
    trust_prompt: s === 'trust_prompt',
    needs_you: s !== null && NEEDS_YOU.includes(s),
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

/** One release workflow after a merge: "publicado v1.2.3" / "publicação falhou: <workflow>" (agentic board D22). */
export function releaseLabel(r: NonNullable<PullRequestBadge['release_runs']>[number]): string {
  if (r.state === 'passed') return r.version ? i18n.t('publicado v{{version}}', { version: r.version }) : i18n.t('publicado');
  if (r.state === 'failed') return i18n.t('publicação falhou: {{workflow}}', { workflow: r.workflow });
  return i18n.t('publicando: {{workflow}}', { workflow: r.workflow });
}

export function epicCiLine(ci: NonNullable<EpicProgress['ci']>): string {
  const parts = [i18n.t('{{count}} abertos', { count: ci.open })];
  if (ci.failed) parts.push(i18n.t('{{n}} falhou', { n: ci.failed }));
  if (ci.running) parts.push(i18n.t('{{n}} rodando', { n: ci.running }));
  if (ci.deployed) parts.push(i18n.t('{{n}} em produção', { n: ci.deployed }));
  return i18n.t('PRs: {{parts}}', { parts: parts.join(' · ') });
}
