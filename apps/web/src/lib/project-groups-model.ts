import { tk } from '../i18n';
import type { Project, ProjectGroup } from './types';

export type SectionId = string; // 'running' | 'others' | a group id
export interface Section { id: SectionId; kind: 'running' | 'favorites' | 'custom' | 'others'; label: string; projects: Project[] }
export type DragSource = { projectId: string; from: SectionId };
export interface DropTarget { to: SectionId; index: number }
type Change = { id: string; project_ids: string[] };

/** The sidebar's sections, top to bottom: Em execução (when anything runs), the groups by position, Outros. */
export function buildSections(projects: Project[], groups: ProjectGroup[], runningIds: Set<string>, showArchived: boolean): Section[] {
  const visible = projects.filter((p) => showArchived || p.status !== 'archived');
  const byId = new Map(visible.map((p) => [p.id, p]));
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((p): p is Project => !!p);
  const sorted = [...groups].sort((a, b) => a.position - b.position);
  const grouped = new Set(sorted.flatMap((g) => g.project_ids));
  const out: Section[] = [];
  const running = visible.filter((p) => runningIds.has(p.id));
  if (running.length) out.push({ id: 'running', kind: 'running', label: tk('Em execução'), projects: running });
  for (const g of sorted) out.push({ id: g.id, kind: g.kind, label: g.name, projects: pick(g.project_ids) });
  out.push({ id: 'others', kind: 'others', label: tk('Outros'), projects: visible.filter((p) => !grouped.has(p.id)) });
  return out;
}

const insertAt = (list: string[], id: string, index: number) => {
  const next = [...list];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, id);
  return next;
};
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The result of dropping a project: the groups' next state and the membership writes, or null when nothing changes. */
export function applyDrop(groups: ProjectGroup[], drag: DragSource, drop: DropTarget, opts: { copy: boolean }): { next: ProjectGroup[]; changes: Change[] } | null {
  if (drop.to === 'running') return null;
  const byId = new Map(groups.map((g) => [g.id, g]));
  const source = byId.get(drag.from);
  const target = byId.get(drop.to);
  const changes: Change[] = [];

  if (drop.to === 'others') {
    if (!source) return null;
    changes.push({ id: source.id, project_ids: source.project_ids.filter((id) => id !== drag.projectId) });
  } else if (target) {
    const from = target.project_ids.indexOf(drag.projectId);
    const without = target.project_ids.filter((id) => id !== drag.projectId);
    const index = from !== -1 && drop.index > from ? drop.index - 1 : drop.index;
    const next = insertAt(without, drag.projectId, index);
    if (source && source.id !== target.id && !opts.copy) {
      changes.push({ id: source.id, project_ids: source.project_ids.filter((id) => id !== drag.projectId) });
    }
    if (!same(next, target.project_ids)) {
      changes.push({ id: target.id, project_ids: next });
    }
  } else {
    return null;
  }

  const real = changes.filter((c) => !same(c.project_ids, byId.get(c.id)!.project_ids));
  if (!real.length) return null;
  const patch = new Map(real.map((c) => [c.id, c.project_ids]));
  return { next: groups.map((g) => (patch.has(g.id) ? { ...g, project_ids: patch.get(g.id)! } : g)), changes: real };
}

/** Moves a group to `toIndex` in position order and renumbers positions densely. */
export function moveGroup(groups: ProjectGroup[], groupId: string, toIndex: number): ProjectGroup[] {
  const sorted = [...groups].sort((a, b) => a.position - b.position);
  const from = sorted.findIndex((g) => g.id === groupId);
  if (from === -1) return groups;
  const [g] = sorted.splice(from, 1);
  sorted.splice(Math.max(0, Math.min(toIndex, sorted.length)), 0, g);
  return sorted.map((x, position) => ({ ...x, position }));
}

/** The Favoritos section's projects in its order, archived ones left out — what the collapsed rail shows. */
export function favoriteProjects(projects: Project[], groups: ProjectGroup[]): Project[] {
  return buildSections(projects, groups, new Set(), false).find((s) => s.kind === 'favorites')?.projects ?? [];
}
