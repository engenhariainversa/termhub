import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { boardProjectOf } from './board-project.js';
import type { StandingGrantKind } from './gate.js';

const idOf = (v: unknown) => (typeof v === 'string' && v.length >= 1 && v.length <= 64 ? v : null);

/**
 * The project a standing grant is judged on, resolved with the user's own id — or null when it does not
 * resolve (unknown id, another user's project/tab), which the gate always reads as "ask". For a tab-borne
 * kind the tab comes back too, so the gate can apply its state guards without a second read. Shared by
 * the gate and the decision routes, so "Liberar sem prazo" is accepted for exactly the calls the gate honours.
 */
export async function standingProjectOf(repos: Pick<Repositories, 'projects' | 'tasks' | 'tabs' | 'taskColumns'>, ownerId: string, kind: StandingGrantKind, tool: string, args: Record<string, unknown>): Promise<{ projectId: string; tab?: Tab } | null> {
  if (kind === 'open_tab' || kind === 'start_agent') {
    const projectId = idOf(args.project_id);
    if (!projectId) return null;
    const [project] = await repos.projects.findByIdsForOwner([projectId], ownerId);
    return project ? { projectId: project.id } : null;
  }
  if (kind === 'close_tab' || kind === 'terminal') {
    const tabId = idOf(args.tab_id);
    if (!tabId) return null;
    const [tab] = await repos.tabs.findByIdsForOwner([tabId], ownerId);
    return tab ? { projectId: tab.project_id, tab } : null;
  }
  const projectId = await boardProjectOf(repos as Repositories, ownerId, tool, args);
  return projectId ? { projectId } : null;
}
