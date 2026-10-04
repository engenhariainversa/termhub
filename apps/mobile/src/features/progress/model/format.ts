// Same wording as the web's lib/progress.ts (spec 2026-09-26 progress-panel §4.6): keep both in sync.
import type { TAgentOnCard, TEpicProgress, TProgressEstimate, TPullRequestBadge } from '@/services/api/contract';

const HOUR = 3600;

/** "20 min", "1 h", "2,5 h". */
export function formatDuration(seconds: number): string {
  if (seconds < HOUR) return `${Math.round(seconds / 60)} min`;
  const hours = Math.round((seconds / HOUR) * 10) / 10;
  return `${String(hours).replace('.', ',')} h`;
}

/** The card's or epic's estimate as one line (spec D4, D6: work time, never a clock time). */
export function formatEstimate(e: TProgressEstimate): string {
  if (e.kind === 'done') return 'concluído';
  if (e.kind === 'none') return e.reason === 'not_started' ? 'ainda não começou' : 'estimativa após 2 subtarefas';
  const low = formatDuration(e.low_s);
  const high = formatDuration(e.high_s);
  if (low === high) return `~${low} de trabalho`;
  const sameUnit = e.low_s < HOUR === e.high_s < HOUR;
  return `~${sameUnit ? low.replace(/ (min|h)$/, '') : low}–${high} de trabalho`;
}

const STATE_LABEL: Record<NonNullable<TAgentOnCard['state']>, string> = {
  working: 'trabalhando',
  waiting_input: 'esperando você',
  waiting_permission: 'pedindo permissão',
  idle: 'parado',
  error: 'erro',
};

/** `background`: the agent waits on its own subagents, shells or monitors, sent as `working` (TER-644). */
export function stateLabel(state: TAgentOnCard['state'], background = false): string {
  if (background && state === 'working') return 'aguardando segundo plano';
  return state ? STATE_LABEL[state] : 'sem sinal';
}

/** One line per PR: an open PR by its CI, a merged one by its deploy (spec §5.6). */
export function ciLabel(p: TPullRequestBadge): string {
  if (p.state === 'closed') return 'fechado';
  if (p.state === 'merged') return { none: 'mergeado', running: 'deploy rodando', passed: 'deploy ok', failed: 'deploy falhou' }[p.deploy_state];
  if (p.ci_state === 'failed') return p.ci_summary.failing.length ? `CI falhou: ${p.ci_summary.failing.join(', ')}` : 'CI falhou';
  return { none: 'sem CI', running: 'CI rodando', passed: 'CI verde' }[p.ci_state];
}

export function epicCiLine(ci: NonNullable<TEpicProgress['ci']>): string {
  const parts = [`${ci.open} ${ci.open === 1 ? 'aberto' : 'abertos'}`];
  if (ci.failed) parts.push(`${ci.failed} falhou`);
  if (ci.running) parts.push(`${ci.running} rodando`);
  if (ci.deployed) parts.push(`${ci.deployed} em produção`);
  return `PRs: ${parts.join(' · ')}`;
}
