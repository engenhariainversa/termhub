import { i18n, tk } from '../i18n';
import type { ChatAction } from './types';

/**
 * The one line a turn's settled actions read as while their accordion is closed (TER-1024): how many,
 * how they ended and what they did — "7 ações executadas · fechar aba ×7", or "3 ações · 2 executadas,
 * 1 recusada · digitar ×2, fechar aba". Ported verbatim to `apps/mobile/src/features/chat/model/action-trail.ts`,
 * so a person who uses both reads the same words.
 */

/** How a settled card ended, as the summary counts it. A stale `failed` card (TER-477) reads as expired, as on the card. */
type Outcome = 'executed' | 'approved' | 'denied' | 'expired' | 'failed';
const STALE_CODES = new Set(['TAB_GONE', 'WAITING_PERMISSION', 'PROMPT_CHANGED']);
const outcomeOf = (a: ChatAction): Outcome => (a.status === 'failed' && STALE_CODES.has(a.error_code ?? '') ? 'expired' : (a.status as Outcome));

const OUTCOME_ORDER: Outcome[] = ['executed', 'approved', 'denied', 'expired', 'failed'];

/** The whole head when every action ended the same way. */
function allSame(outcome: Outcome, count: number): string {
  switch (outcome) {
    case 'executed':
      return i18n.t('{{count}} ações executadas', { count });
    case 'approved':
      return i18n.t('{{count}} ações em andamento', { count });
    case 'denied':
      return i18n.t('{{count}} ações recusadas', { count });
    case 'expired':
      return i18n.t('{{count}} ações expiradas', { count });
    case 'failed':
      return i18n.t('{{count}} ações falharam', { count });
  }
}

/** One part of a mixed head ("2 executadas"). */
function part(outcome: Outcome, count: number): string {
  switch (outcome) {
    case 'executed':
      return i18n.t('{{count}} executadas', { count });
    case 'approved':
      return i18n.t('{{count}} em andamento', { count });
    case 'denied':
      return i18n.t('{{count}} recusadas', { count });
    case 'expired':
      return i18n.t('{{count}} expiradas', { count });
    case 'failed':
      return i18n.t('{{count}} falharam', { count });
  }
}

/** What each gated tool does, in a word or two. A tool missing here reads as its own name. */
const TOOL_LABEL: Record<string, string> = {
  send_input: tk('digitar'),
  run_command: tk('rodar comando'),
  send_key: tk('enviar tecla'),
  open_tab: tk('abrir aba'),
  close_tab: tk('fechar aba'),
  start_agent: tk('iniciar agente'),
  link_project_machine: tk('vincular máquina'),
  set_project_machine_cwd: tk('trocar pasta'),
  unlink_project_machine: tk('desvincular máquina'),
  create_task: tk('criar card'),
  add_subtasks: tk('adicionar subtarefas'),
  update_task: tk('atualizar card'),
  move_task: tk('mover card'),
  delete_task: tk('apagar card'),
  link_tab_task: tk('ligar aba a card'),
  pause_automation: tk('pausar automação'),
  resume_automation: tk('retomar automação'),
  set_automation_policy: tk('mudar automação'),
  set_machine_automation: tk('mudar automação da máquina'),
  resume_automation_run: tk('retomar execução'),
  automation_merge: tk('mesclar PR'),
  sync_tickets: tk('sincronizar tickets'),
  import_tickets: tk('importar tickets'),
  push_ticket_status: tk('atualizar ticket'),
  create_integration: tk('criar integração'),
  set_project_repo: tk('definir repositório'),
};

/** How many kinds of tool the line names before folding the rest into "+N". */
const MAX_TOOLS = 3;

export function actionTrailSummary(actions: ChatAction[]): string {
  const outcomes = new Map<Outcome, number>();
  for (const a of actions) outcomes.set(outcomeOf(a), (outcomes.get(outcomeOf(a)) ?? 0) + 1);
  const head =
    outcomes.size === 1
      ? allSame([...outcomes.keys()][0]!, actions.length)
      : `${i18n.t('{{count}} ações', { count: actions.length })} · ${OUTCOME_ORDER.filter((o) => outcomes.has(o))
          .map((o) => part(o, outcomes.get(o)!))
          .join(', ')}`;

  // Most frequent first; a tie keeps the order the tools first ran in.
  const tools = new Map<string, number>();
  for (const a of actions) tools.set(a.tool, (tools.get(a.tool) ?? 0) + 1);
  const ranked = [...tools.entries()].sort((x, y) => y[1] - x[1]);
  const named = ranked.slice(0, MAX_TOOLS).map(([tool, n]) => {
    const label = TOOL_LABEL[tool] ? i18n.t(TOOL_LABEL[tool]) : tool;
    return n > 1 ? `${label} ×${n}` : label;
  });
  const rest = ranked.length - MAX_TOOLS;
  if (rest > 0) named.push(i18n.t('+{{count}} outras', { count: rest }));
  return `${head} · ${named.join(', ')}`;
}
