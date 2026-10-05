// Same wording as the web's lib/progress.ts (spec 2026-09-26 progress-panel §4.6): keep both in sync.
// In the language the app shows (i18n spec 2026-10-04): "min" and "h" read the same in both.
import { t, tk } from '@/i18n';
import { formatNumber } from '@/i18n/format';
import type { TAgentOnCard, TEpicProgress, TProgressEstimate, TPullRequestBadge } from '@/services/api/contract';

const HOUR = 3600;

/** "20 min", "1 h", "2,5 h" ("2.5 h" in English). */
export function formatDuration(seconds: number): string {
  if (seconds < HOUR) return `${Math.round(seconds / 60)} min`;
  const hours = Math.round((seconds / HOUR) * 10) / 10;
  return `${formatNumber(hours, { maximumFractionDigits: 1 })} h`;
}

/** The card's or epic's estimate as one line (spec D4, D6: work time, never a clock time). */
export function formatEstimate(e: TProgressEstimate): string {
  if (e.kind === 'done') return t('concluído');
  if (e.kind === 'none') return e.reason === 'not_started' ? t('ainda não começou') : t('estimativa após 2 subtarefas');
  const low = formatDuration(e.low_s);
  const high = formatDuration(e.high_s);
  if (low === high) return t('~{{range}} de trabalho', { range: low });
  const sameUnit = e.low_s < HOUR === e.high_s < HOUR;
  return t('~{{range}} de trabalho', { range: `${sameUnit ? low.replace(/ (min|h)$/, '') : low}–${high}` });
}

const STATE_LABEL: Record<NonNullable<TAgentOnCard['state']>, string> = {
  working: tk('trabalhando'),
  waiting_input: tk('esperando você'),
  waiting_permission: tk('pedindo permissão'),
  idle: tk('parado'),
  error: tk('erro'),
};

/**
 * `background`: the agent waits on its own subagents, shells or monitors, sent as `working` (TER-644).
 * `finished`: the agent ended its turn with a report and asks nothing, sent as `idle` (TER-972).
 */
export function stateLabel(state: TAgentOnCard['state'], background = false, finished = false): string {
  if (background && state === 'working') return t('aguardando segundo plano');
  if (finished && state === 'idle') return t('concluído');
  return state ? t(STATE_LABEL[state]) : t('sem sinal');
}

const DEPLOY_LABEL: Record<TPullRequestBadge['deploy_state'], string> = {
  none: tk('mergeado'),
  running: tk('deploy rodando'),
  passed: tk('deploy ok'),
  failed: tk('deploy falhou'),
};

const CI_LABEL: Record<Exclude<TPullRequestBadge['ci_state'], 'failed'>, string> = {
  none: tk('sem CI'),
  running: tk('CI rodando'),
  passed: tk('CI verde'),
};

/** One line per PR: an open PR by its CI, a merged one by its deploy (spec §5.6). */
export function ciLabel(p: TPullRequestBadge): string {
  if (p.state === 'closed') return t('fechado');
  if (p.state === 'merged') return t(DEPLOY_LABEL[p.deploy_state]);
  if (p.ci_state === 'failed') return p.ci_summary.failing.length ? t('CI falhou: {{checks}}', { checks: p.ci_summary.failing.join(', ') }) : t('CI falhou');
  return t(CI_LABEL[p.ci_state]);
}

export function epicCiLine(ci: NonNullable<TEpicProgress['ci']>): string {
  // pt reads 0 as singular ("0 aberto"): the zero keeps its own key.
  const parts = [ci.open === 0 ? t('0 abertos') : t('{{count}} abertos', { count: ci.open })];
  if (ci.failed) parts.push(t('{{n}} falhou', { n: ci.failed }));
  if (ci.running) parts.push(t('{{n}} rodando', { n: ci.running }));
  if (ci.deployed) parts.push(t('{{n}} em produção', { n: ci.deployed }));
  return `PRs: ${parts.join(' · ')}`;
}
