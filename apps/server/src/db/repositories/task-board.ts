import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { TaskRuleError } from './task-rules.js';
import type { ColumnCategory, TaskStatus, TaskType } from './types.js';

/** A transaction handle (`db.$transaction(async (tx) => …)`). */
export type Tx = Prisma.TransactionClient;

export const DEFAULT_COLUMNS: ReadonlyArray<{ name: string; category: ColumnCategory }> = [
  { name: 'A fazer', category: 'todo' },
  { name: 'Fazendo', category: 'doing' },
  { name: 'Feito', category: 'done' },
];

export const DEFAULT_EPIC_TITLE = 'Geral';

/**
 * Serializes every structural write on one project's board — positions, the default epic, columns.
 * Always taken first in a transaction (project row, then task rows), so writers never deadlock; the
 * numbering trigger locks the same row, which the transaction then already holds.
 */
export async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "projects" WHERE id = ${projectId} FOR UPDATE`;
}

/** "A fazer", "Fazendo", "Feito" for a project that has no column (new, or made by the previous release). Caller holds the lock. */
export async function ensureDefaultColumns(tx: Tx, projectId: string): Promise<void> {
  if ((await tx.taskColumn.count({ where: { projectId } })) > 0) return;
  await tx.taskColumn.createMany({
    data: DEFAULT_COLUMNS.map((c, position) => ({ id: newId(), projectId, name: c.name, category: c.category, position })),
  });
}

/**
 * The first column of a category, by position, that is not a waiting column (TER-1134). Every category always
 * keeps one (TaskColumnsRepository refuses to remove or mark the last); a waiting one is only the fallback.
 */
export async function firstColumnId(tx: Tx, projectId: string, category: ColumnCategory): Promise<string> {
  await ensureDefaultColumns(tx, projectId);
  const c = await tx.taskColumn.findFirst({ where: { projectId, category }, orderBy: [{ waiting: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }], select: { id: true } });
  if (!c) throw new TaskRuleError('COLUMN_NOT_FOUND');
  return c.id;
}

/** The project's default epic — the one with the lowest number — created as "Geral" in the backlog when there is none. Caller holds the lock. */
export async function defaultEpicId(tx: Tx, projectId: string): Promise<string> {
  const epic = await tx.task.findFirst({ where: { projectId, type: 'epic' }, orderBy: { number: 'asc' }, select: { id: true } });
  if (epic) return epic.id;
  const created = await tx.task.create({
    data: { id: newId(), projectId, type: 'epic', title: DEFAULT_EPIC_TITLE, status: 'backlog', position: 0 },
    select: { id: true },
  });
  return created.id;
}

/** `epicId` must be an epic of this project. */
export async function requireEpic(tx: Tx, projectId: string, epicId: string): Promise<string> {
  const epic = await tx.task.findFirst({ where: { id: epicId, projectId, type: 'epic' }, select: { id: true } });
  if (!epic) throw new TaskRuleError('EPIC_NOT_FOUND');
  return epic.id;
}

/** Where a top-level card sits, which decides what its `position` counts among (spec §2 "Position scope"). */
export interface Placement {
  status: TaskStatus;
  columnId: string | null;
  epicId: string | null;
  type: TaskType;
}

export const placementOf = (t: { status: TaskStatus; columnId: string | null; epicId: string | null; type: TaskType }): Placement => ({
  status: t.status,
  columnId: t.columnId,
  epicId: t.epicId,
  type: t.type,
});

/**
 * The cards sharing a position sequence: a board column; the backlog of one epic; the project's
 * backlog epics. A non-backlog card with no column (a row the previous release wrote, before
 * `normalize` heals it) counts among the column-less cards of its status.
 */
export function scopeWhere(projectId: string, p: Placement): Prisma.TaskWhereInput {
  if (p.status !== 'backlog') return p.columnId ? { columnId: p.columnId } : { projectId, status: p.status, columnId: null, parentId: null };
  if (p.type === 'epic') return { projectId, type: 'epic', status: 'backlog' };
  return { projectId, epicId: p.epicId, status: 'backlog', parentId: null, type: { notIn: ['epic', 'subtask'] } };
}

/** Where a card goes: a column of this project, or a status (backlog, or the first column of a category; default todo). */
export async function placementFor(
  tx: Tx,
  projectId: string,
  card: { type: TaskType; epicId: string | null },
  target: { column_id?: string | null; status?: TaskStatus },
): Promise<Placement> {
  if (target.column_id) {
    const col = await tx.taskColumn.findFirst({ where: { id: target.column_id, projectId }, select: { id: true, category: true } });
    if (!col) throw new TaskRuleError('COLUMN_NOT_FOUND');
    return { status: col.category, columnId: col.id, epicId: card.epicId, type: card.type };
  }
  const status = target.status ?? 'todo';
  if (status === 'backlog') return { status, columnId: null, epicId: card.epicId, type: card.type };
  return { status, columnId: await firstColumnId(tx, projectId, status), epicId: card.epicId, type: card.type };
}

/** Pulls up the cards after `position` in `from` (the card itself, `exceptId`, is left alone). */
export async function closeGap(tx: Tx, projectId: string, from: Placement, position: number, exceptId?: string): Promise<void> {
  await tx.task.updateMany({
    where: { ...scopeWhere(projectId, from), position: { gt: position }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    data: { position: { decrement: 1 } },
  });
}

/** Makes room at `position` in `to` (clamped to 0..count) and returns the slot. */
export async function openSlot(tx: Tx, projectId: string, to: Placement, position: number, exceptId?: string): Promise<number> {
  const others = exceptId ? { id: { not: exceptId } } : {};
  const count = await tx.task.count({ where: { ...scopeWhere(projectId, to), ...others } });
  const slot = Math.max(0, Math.min(Math.trunc(position), count));
  await tx.task.updateMany({ where: { ...scopeWhere(projectId, to), position: { gte: slot }, ...others }, data: { position: { increment: 1 } } });
  return slot;
}

/** The position after the last card of `to`. */
export async function endOf(tx: Tx, projectId: string, to: Placement): Promise<number> {
  const agg = await tx.task.aggregate({ where: scopeWhere(projectId, to), _max: { position: true } });
  return (agg._max.position ?? -1) + 1;
}
