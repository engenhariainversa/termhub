import { api } from './api';
import type { AutomationAutonomy, Task } from './types';

/** task_id -> why a tagged card cannot be taken yet. A failed request means "no reasons", never an error. */
export async function loadIneligibleReasons(projectId: string): Promise<Map<string, string>> {
  try {
    const { items } = await api.automation.queue(projectId);
    return new Map(items.filter((i) => !i.eligible && i.reason_text).map((i) => [i.task_id, i.reason_text as string]));
  } catch {
    return new Map();
  }
}

export const AUTONOMY_LABEL: Record<AutomationAutonomy, string> = {
  pr: 'Só código e PR',
  merge: 'Merge com CI verde',
  deploy: 'Deploy',
  release: 'Publicação (npm, OTA)',
};

const AUTONOMY_ORDER: AutomationAutonomy[] = ['pr', 'merge', 'deploy', 'release'];

const WHAT_THEY_DO: Record<AutomationAutonomy, string> = {
  pr: 'Os agentes vão pegar os cards marcados e abrir PRs sozinhos; o merge continua com você.',
  merge: 'Os agentes vão pegar os cards marcados, abrir PRs e fazer merge com CI verde sem perguntar.',
  deploy: 'Os agentes vão pegar os cards marcados, abrir PRs, fazer merge e deploy sem perguntar.',
  release: 'Os agentes vão pegar os cards marcados, abrir PRs, fazer merge, deploy e publicar (npm, OTA) sem perguntar.',
};

export function autonomyConfirmText(level: AutomationAutonomy): string {
  return `${WHAT_THEY_DO[level]} Confirmar?`;
}

/** Turning automation on, or raising the level to Deploy or Publicação, asks first. */
export function needsAutonomyConfirm(from: { enabled: boolean; autonomy: AutomationAutonomy }, to: { enabled: boolean; autonomy: AutomationAutonomy }): boolean {
  if (!to.enabled) return false;
  if (!from.enabled) return true;
  const raised = AUTONOMY_ORDER.indexOf(to.autonomy) > AUTONOMY_ORDER.indexOf(from.autonomy);
  return raised && (to.autonomy === 'deploy' || to.autonomy === 'release');
}

/** What tagging an epic reaches: itself and every top-level card of it still untagged (new cards follow later). */
export function untaggedUnderEpic(epic: Task, tasks: Task[]): number {
  const cards = tasks.filter((t) => t.epic_id === epic.id && !t.parent_id && t.type !== 'epic' && !t.auto).length;
  return cards + (epic.auto ? 0 : 1);
}
