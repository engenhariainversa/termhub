import { i18n, tk } from '../i18n';
import type { ColumnCategory, ProjectStatus, Task, TaskColumn, TaskStatus, TaskType } from './types';

/**
 * Names termhub gives (types, statuses, column categories) in the language on screen. The maps in
 * `types.ts` keep the pt-BR text; these hold the same keys with `tk()` so the checker sees them.
 */
const TYPE_KEY: Record<TaskType, string> = {
  epic: tk('Épico'),
  story: tk('História'),
  task: tk('Tarefa'),
  subtask: tk('Subtarefa'),
  bug: tk('Bug'),
  spike: tk('Spike'),
};
const STATUS_KEY: Record<TaskStatus, string> = { backlog: tk('Backlog'), todo: tk('A fazer'), doing: tk('Fazendo'), done: tk('Feito') };
const PROJECT_STATUS_KEY: Record<ProjectStatus, string> = { active: tk('Ativo'), paused: tk('Pausado'), archived: tk('Arquivado') };

export const taskTypeLabel = (type: TaskType): string => i18n.t(TYPE_KEY[type]);
export const taskStatusLabel = (status: TaskStatus): string => i18n.t(STATUS_KEY[status]);
export const columnCategoryLabel = (category: ColumnCategory): string => i18n.t(STATUS_KEY[category]);
export const projectStatusLabel = (status: ProjectStatus): string => i18n.t(PROJECT_STATUS_KEY[status]);

/** The work: what the board shows by default and the open counter counts. */
export const WORK_TYPES: TaskType[] = ['story', 'task', 'bug', 'spike'];
/** The board's type-filter chips, in display order (spec §7: default all but Épico). */
export const FILTER_TYPES: TaskType[] = ['story', 'task', 'bug', 'spike', 'epic'];

export interface BoardFilter {
  types: TaskType[];
  /** only this epic's cards; null = every epic */
  epicId: string | null;
}

export const DEFAULT_FILTER: BoardFilter = { types: WORK_TYPES, epicId: null };

const filterKey = (projectId: string) => `termhub:board-filter:${projectId}`;

/** The filter remembered for a project. Best effort: private mode or broken JSON fall back to the default. */
export function readBoardFilter(projectId: string): BoardFilter {
  try {
    const raw = localStorage.getItem(filterKey(projectId));
    if (!raw) return DEFAULT_FILTER;
    const v = JSON.parse(raw) as { types?: unknown; epicId?: unknown };
    const types = Array.isArray(v.types) ? FILTER_TYPES.filter((t) => (v.types as unknown[]).includes(t)) : WORK_TYPES;
    return { types, epicId: typeof v.epicId === 'string' ? v.epicId : null };
  } catch {
    return DEFAULT_FILTER;
  }
}

export function writeBoardFilter(projectId: string, filter: BoardFilter): void {
  try {
    localStorage.setItem(filterKey(projectId), JSON.stringify(filter));
  } catch {
    /* private mode: the filter is just not remembered */
  }
}

const byPosition = (a: Task, b: Task) => a.position - b.position || a.created_at.localeCompare(b.created_at);

/** Every top-level card of a column in order, hidden or not: server positions count them all. */
export function cardsIn(tasks: Task[], columnId: string): Task[] {
  return tasks.filter((t) => !t.parent_id && t.column_id === columnId).sort(byPosition);
}

/** What the filter lets through: the chosen types and, with an epic chosen, that epic's cards (and the epic itself). */
export function visible(cards: Task[], filter: BoardFilter): Task[] {
  return cards.filter((t) => filter.types.includes(t.type) && (!filter.epicId || t.epic_id === filter.epicId || t.id === filter.epicId));
}

/**
 * The server position for a drop at `index` of the visible list — the index the person saw, which
 * counts the dragged card when it is in that list. The card goes right after the visible card above
 * the drop point (the top when there is none), so hidden cards keep their places.
 */
export function dropPosition(all: Task[], shown: Task[], index: number, movingId: string): number {
  const from = shown.findIndex((t) => t.id === movingId);
  const at = from !== -1 && from < index ? index - 1 : index;
  const allOthers = all.filter((t) => t.id !== movingId);
  const shownOthers = shown.filter((t) => t.id !== movingId);
  const above = shownOthers[Math.min(at, shownOthers.length) - 1];
  return above ? allOthers.indexOf(above) + 1 : 0;
}

/** Local copy of a move to a column, reindexing that column and the one the card left, as the server does. */
export function applyMove(tasks: Task[], id: string, column: TaskColumn, position: number): Task[] {
  const moving = tasks.find((t) => t.id === id);
  if (!moving) return tasks;
  const target = cardsIn(tasks, column.id).filter((t) => t.id !== id);
  target.splice(Math.max(0, Math.min(position, target.length)), 0, { ...moving, column_id: column.id, status: column.category });
  const next = new Map<string, Task>();
  target.forEach((t, i) => next.set(t.id, { ...t, position: i }));
  if (moving.column_id && moving.column_id !== column.id) {
    cardsIn(tasks, moving.column_id)
      .filter((t) => t.id !== id)
      .forEach((t, i) => next.set(t.id, { ...t, position: i }));
  }
  return tasks.map((t) => next.get(t.id) ?? t);
}

/** The column after this one by position; undefined for the last. */
export function nextColumn(columns: TaskColumn[], columnId: string): TaskColumn | undefined {
  const sorted = [...columns].sort((a, b) => a.position - b.position);
  const i = sorted.findIndex((c) => c.id === columnId);
  return i === -1 ? undefined : sorted[i + 1];
}

/** A project's epics by number; the first is the default epic. */
export function epicsOf(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.type === 'epic').sort((a, b) => a.number - b.number);
}

/** Open work for the sidebar badge: stories, tasks, bugs and spikes in todo or doing. */
export function openCount(tasks: Task[]): number {
  return tasks.filter((t) => !t.parent_id && WORK_TYPES.includes(t.type) && (t.status === 'todo' || t.status === 'doing')).length;
}

export interface BacklogSection {
  epic: Task;
  /** the epic's backlog items, in order */
  items: Task[];
  /** progress over the epic's cards already on the board ("3/8 feitas") */
  done: number;
  total: number;
}

/** The Backlog view: one section per epic, the default epic (lowest number) first. */
export function backlogSections(tasks: Task[]): BacklogSection[] {
  return epicsOf(tasks).map((epic) => {
    const cards = tasks.filter((t) => !t.parent_id && t.epic_id === epic.id);
    const onBoard = cards.filter((t) => t.status !== 'backlog');
    return {
      epic,
      items: cards.filter((t) => t.status === 'backlog').sort(byPosition),
      done: onBoard.filter((t) => t.status === 'done').length,
      total: onBoard.length,
    };
  });
}

/** Types the editor offers (spec §3): epics and subtasks never change; a card with subtasks stays a story or task. */
export function typeOptions(task: Task): TaskType[] {
  if (task.type === 'epic' || task.type === 'subtask') return [task.type];
  return (task.subtasks?.length ?? 0) > 0 ? ['story', 'task'] : WORK_TYPES;
}

export const canHaveSubtasks = (task: Task): boolean => task.type === 'story' || task.type === 'task';

/** A card's own URL path (spec §7): `/project/TER-12`. */
export const cardPath = (ref: string): string => `/project/${ref}`;
