/**
 * One project's office for the terminal area when no tab is open (TER-912): the same model and scene
 * as /office, fed from what the project page already holds — its tab list and its machines — so it
 * costs no extra read and opens no terminal connection. The live state comes from the monitor.
 */
import type { MachineStatus } from '../lib/data';
import type { Machine, Project, Tab } from '../lib/types';
import type { ModelCity } from './model';

/**
 * A city with a single building: the project and every terminal it has. A machine still being
 * checked reads as online (the sidebar does the same); `reachable: false` = the tab list came back
 * without being able to ask tmux, which the model draws faded rather than as empty chairs.
 */
export function projectCity(
  project: Pick<Project, 'id' | 'name' | 'status'>,
  tabs: Tab[],
  machines: Array<Pick<Machine, 'id' | 'name' | 'subtitle'>>,
  statuses: Record<string, MachineStatus>,
  reachable: boolean,
): ModelCity {
  return {
    projects: [{ project: { id: project.id, name: project.name, status: project.status }, tabs: tabs.map((t) => ({ ...t, progress: null })), tasks: null }],
    machines: machines.map((m) => ({ id: m.id, name: m.name, subtitle: m.subtitle, online: statuses[m.id] !== 'offline', reachable: reachable ? null : false })),
  };
}
