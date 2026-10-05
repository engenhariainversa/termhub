import { tk } from '../i18n/index.js';
import type { TaskStatus, TaskType } from '../db/repositories/types.js';
import type { ProjectAutomation } from '../setup/schema.js';

export type IneligibleReason =
  | 'automation_off'
  | 'paused'
  | 'type_not_allowed'
  | 'not_in_todo'
  | 'no_description'
  | 'has_agent'
  | 'no_capable_machine'
  | 'repo_missing'
  // set by the dispatcher when it found no place for an eligible card (spec §8 step 3, D14)
  | 'no_account'
  | 'machine_offline'
  // set by the merge executor on a card whose green PR is not merged yet (spec §10.1, spike R1)
  | 'merge_needs_approval'
  | 'merge_store'
  | 'merge_checks_pending'
  | 'merge_base_red'
  | 'merge_base_pending'
  | 'merge_updating'
  | 'merge_no_write'
  | 'merge_conflict_cap'
  | 'merge_ci_cap';

/** What the card shows when it is tagged but does not run (spec §5). `not_in_todo` is not shown: backlog, doing and done are not "waiting". */
export const REASON_TEXT: Record<IneligibleReason, string> = {
  automation_off: tk('Trabalho automático desligado no projeto'),
  paused: tk('Automático pausado'),
  type_not_allowed: tk('Tipo não permitido no automático'),
  not_in_todo: tk('Fora da coluna A fazer'),
  no_description: tk('Sem descrição'),
  has_agent: tk('Já tem um agente'),
  no_capable_machine: tk('Nenhuma máquina com agente 0.18 ligada ao projeto'),
  repo_missing: tk('Repositório não configurado no Setup'),
  no_account: tk('Sem conta com folga'),
  machine_offline: tk('Máquina do agente desligada'),
  merge_needs_approval: tk('Merge esperando sua aprovação no chat'),
  merge_store: tk('precisa de build nas lojas'),
  merge_checks_pending: tk('Esperando os checks obrigatórios do PR'),
  merge_base_red: tk('Branch base vermelha'),
  merge_base_pending: tk('Esperando a CI e a entrega da branch base'),
  merge_updating: tk('Atualizando o PR com a branch base'),
  merge_no_write: tk('Integração do GitHub sem permissão de escrita'),
  merge_conflict_cap: tk('PR com conflito depois das tentativas de correção'),
  merge_ci_cap: tk('CI vermelho depois das tentativas de correção'),
};

export interface EligibilityInput {
  card: {
    type: TaskType;
    parent_id: string | null;
    auto: boolean;
    /** category of the card's board column; null in the backlog */
    column_category: TaskStatus | null;
    description: string | null;
    subtask_count: number;
    /** a linked tab that still exists */
    tab_alive: boolean;
    active_run: boolean;
  };
  project: { automation: ProjectAutomation; paused: boolean; repo_ready: boolean; capable_machines: number };
}

export type Eligibility = { eligible: true } | { eligible: false; reason: IneligibleReason };

/**
 * Whether a card gets automatic work, and otherwise the first check it fails (spec §5 order).
 * `null` = the card is not in the queue at all: a subtask, or a card that is not tagged.
 */
export function eligibilityOf({ card, project }: EligibilityInput): Eligibility | null {
  if (card.parent_id !== null || !card.auto) return null;
  const no = (reason: IneligibleReason): Eligibility => ({ eligible: false, reason });
  if (!project.automation.enabled) return no('automation_off');
  if (project.paused) return no('paused');
  if (!(project.automation.types as readonly TaskType[]).includes(card.type)) return no('type_not_allowed');
  if (card.column_category !== 'todo') return no('not_in_todo');
  if (!card.description?.trim() && card.subtask_count === 0) return no('no_description');
  if (card.active_run || card.tab_alive) return no('has_agent');
  if (project.capable_machines === 0) return no('no_capable_machine');
  if (!project.repo_ready) return no('repo_missing');
  return { eligible: true };
}
