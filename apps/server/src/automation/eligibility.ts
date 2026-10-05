import { WORKTREE_MIN_AGENT_VERSION } from '@termhub/agent-protocol';
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
  | 'repo_missing';

/** What the card shows when it is tagged but does not run (spec §5). `not_in_todo` is not shown: backlog, doing and done are not "waiting". */
export const REASON_TEXT: Record<IneligibleReason, string> = {
  automation_off: 'Trabalho automático desligado no projeto',
  paused: 'Automático pausado',
  type_not_allowed: 'Tipo não permitido no automático',
  not_in_todo: 'Fora da coluna A fazer',
  no_description: 'Sem descrição',
  has_agent: 'Já tem um agente',
  no_capable_machine: `Nenhuma máquina com agente ${WORKTREE_MIN_AGENT_VERSION.split('.').slice(0, 2).join('.')} ligada ao projeto`,
  repo_missing: 'Repositório não configurado no Setup',
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
