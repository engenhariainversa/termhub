import { config } from '../config.js';
import { dispatchTriggers } from '../automation/events.js';
import { TaskRuleError } from '../db/repositories/tasks.js';
import type { ColumnCategory, Task, TaskColumn, TaskStatus, TaskType, TaskWithSubtasks } from '../db/repositories/types.js';
import { readTicketLink } from '../integrations/ticket-link.js';
import { ControlError, type ControlContext } from './context.js';
import { recordTagChange, viaOf } from '../automation/setup-tools.js';
import { msg } from '../i18n/index.js';

/** Field limits, the same the REST routes enforce (`routes/tasks.ts`). */
export const TASK_TITLE_MAX = 300;
export const TASK_DESCRIPTION_MAX = 5000;
export const TASK_POSITION_MAX = 10_000;

/** Types a tool may create (a subtask is created with add_subtasks) and switch between. */
export type CreatableType = Exclude<TaskType, 'subtask'>;
export type WorkType = 'story' | 'task' | 'bug' | 'spike';

export interface SubtaskIn {
  title: string;
  description?: string | null;
}

/** A card as the tools return it: never `external_ref` (provider payload the model does not need). */
export interface TaskOut {
  id: string;
  project_id: string;
  type: TaskType;
  /** "TER-12" */
  ref: string;
  /** where the person opens this card in the app */
  url: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  position: number;
  parent_id: string | null;
  epic_id: string | null;
  column_id: string | null;
  tab_id: string | null;
  /** tagged "automático" (eligible for automatic work) */
  auto: boolean;
  /** the external ticket this card came from (Linear/Jira/GitHub), or null */
  ticket: { key: string; url: string; state: string; provider: string } | null;
  created_at: string;
  updated_at: string;
}

export interface TaskTreeOut extends TaskOut {
  subtasks: TaskOut[];
  subtask_counts: { done: number; total: number };
}

/** A board column as the tools see it: the user's name, the category the system reasons with. */
export interface ColumnOut {
  id: string;
  name: string;
  category: ColumnCategory;
}

export interface ListedTaskOut extends TaskTreeOut {
  /** null in the backlog (and on epics kept there) */
  column: ColumnOut | null;
}

/** Where the person opens one card: `/project/TER-12`. */
export function cardUrl(ref: string): string {
  return `${config.publicUrl}/project/${ref}`;
}

/** Where the person sees this board in the app. */
export function boardUrl(projectId: string): string {
  return `${config.publicUrl}/projects/${projectId}/tasks`;
}

export const taskOut = (t: Task): TaskOut => ({
  id: t.id, project_id: t.project_id, type: t.type, ref: t.ref, url: cardUrl(t.ref), title: t.title, description: t.description, status: t.status,
  position: t.position, parent_id: t.parent_id, epic_id: t.epic_id, column_id: t.column_id, tab_id: t.tab_id, auto: t.auto,
  ticket: (() => { const l = readTicketLink(t.external_ref); return l ? { key: l.key, url: l.url, state: l.state, provider: l.provider } : null; })(),
  created_at: t.created_at, updated_at: t.updated_at,
});
const outTree = (t: TaskWithSubtasks): TaskTreeOut => ({ ...taskOut(t), subtasks: t.subtasks.map(taskOut), subtask_counts: t.subtask_counts });
const columnOut = (c: TaskColumn): ColumnOut => ({ id: c.id, name: c.name, category: c.category });

/** Board rules live in the repository; a broken one is the caller's mistake, said in pt-BR. */
export async function rules<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof TaskRuleError) throw new ControlError(e.code, e.localized);
    throw e;
  }
}

export async function listTasks(
  ctx: ControlContext,
  input: { project_id: string; status?: TaskStatus; type?: TaskType; epic_id?: string },
): Promise<{ project_id: string; board_url: string; columns: ColumnOut[]; tasks: ListedTaskOut[] }> {
  await ctx.scoped.project(input.project_id);
  // listByProject heals rows from the previous release first, columns included
  const tasks = await ctx.repos.tasks.listByProject(input.project_id);
  const columns = (await ctx.repos.taskColumns.list(input.project_id)).map(columnOut);
  const byId = new Map(columns.map((c) => [c.id, c]));
  return {
    project_id: input.project_id,
    board_url: boardUrl(input.project_id),
    columns,
    tasks: tasks
      .filter((t) => (!input.status || t.status === input.status) && (!input.type || t.type === input.type) && (!input.epic_id || t.epic_id === input.epic_id))
      .map((t) => ({ ...outTree(t), column: (t.column_id ? byId.get(t.column_id) : undefined) ?? null })),
  };
}

export async function createTask(
  ctx: ControlContext,
  input: { project_id: string; title: string; description?: string | null; status?: TaskStatus; type?: CreatableType; epic_id?: string; auto?: boolean; subtasks?: SubtaskIn[] },
): Promise<{ task: TaskTreeOut; board_url: string }> {
  await ctx.scoped.project(input.project_id);
  const task = await rules(() =>
    ctx.repos.tasks.createWithSubtasks(input.project_id, { title: input.title, description: input.description, status: input.status, type: input.type, epic_id: input.epic_id, auto: input.auto }, input.subtasks ?? []),
  );
  if (task.auto) {
    await recordTagChange(ctx.repos, task, true, 1, viaOf(ctx));
    dispatchTriggers.poke('tag_set');
  }
  return { task: outTree(task), board_url: boardUrl(input.project_id) };
}

export async function addSubtasks(ctx: ControlContext, input: { task_id: string; subtasks: SubtaskIn[] }): Promise<{ task_id: string; subtasks: TaskOut[]; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  const created = await rules(() => ctx.repos.tasks.createSubtasks(task.id, input.subtasks, task.project_id));
  return { task_id: task.id, subtasks: created.map(taskOut), board_url: boardUrl(task.project_id) };
}

export async function updateTask(
  ctx: ControlContext,
  input: { task_id: string; title?: string; description?: string | null; status?: TaskStatus; type?: WorkType; epic_id?: string; auto?: boolean },
): Promise<{ task: TaskOut; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  const fields = [input.title, input.description, input.status, input.type, input.epic_id];
  if (fields.every((v) => v === undefined) && input.auto === undefined) {
    throw new ControlError('BAD_REQUEST', 'Informe title, description, status, type, epic_id ou auto');
  }
  let updated: Task | undefined = task;
  if (fields.some((v) => v !== undefined)) {
    updated = await rules(() =>
      ctx.repos.tasks.update(task.id, { title: input.title, description: input.description, status: input.status, type: input.type, epic_id: input.epic_id }),
    );
  }
  if (updated && input.auto !== undefined) {
    // After the fields, so an epic change and the tag in one call end up consistent.
    const { changed } = await rules(() => ctx.repos.tasks.setAuto(task.id, input.auto!));
    await recordTagChange(ctx.repos, task, input.auto, changed, viaOf(ctx));
    if (input.auto) dispatchTriggers.poke('tag_set');
    updated = await ctx.repos.tasks.findById(task.id);
  }
  if (!updated) throw new ControlError('NOT_FOUND', 'Tarefa não encontrada');
  return { task: taskOut(updated), board_url: boardUrl(task.project_id) };
}

/** Top-level cards only: the repository refuses a subtask (they have no column of their own). */
export async function moveTask(
  ctx: ControlContext,
  input: { task_id: string; column_id?: string; status?: TaskStatus; position?: number },
): Promise<{ task: TaskOut; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  if ((input.column_id === undefined) === (input.status === undefined)) throw new ControlError('BAD_REQUEST', 'Informe column_id ou status (um dos dois)');
  const target = input.column_id !== undefined ? { column_id: input.column_id } : { status: input.status as TaskStatus };
  const moved = await rules(() => ctx.repos.tasks.move(task.id, target, input.position ?? 0));
  if (!moved) throw new ControlError('NOT_FOUND', 'Tarefa não encontrada');
  return { task: taskOut(moved), board_url: boardUrl(task.project_id) };
}

/** Destructive and cascading, so it needs `confirm: true`; the refusal spells out what would go. */
export async function deleteTask(ctx: ControlContext, input: { task_id: string; confirm?: boolean }): Promise<{ deleted: true; task_id: string; deleted_subtasks: number; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  const children = await ctx.repos.tasks.childIds(task.id);
  if (!input.confirm) {
    const vars = { title: task.title, count: children.length };
    throw new ControlError(
      'CONFIRM_REQUIRED',
      task.parent_id
        ? children.length
          ? msg('Isso exclui a subtarefa "{{title}}" e {{count}} subtarefas; repita com confirm: true para confirmar', vars)
          : msg('Isso exclui a subtarefa "{{title}}"; repita com confirm: true para confirmar', vars)
        : children.length
          ? msg('Isso exclui a tarefa "{{title}}" e {{count}} subtarefas; repita com confirm: true para confirmar', vars)
          : msg('Isso exclui a tarefa "{{title}}"; repita com confirm: true para confirmar', vars),
    );
  }
  // Tickets point at tasks by id with no FK: unlink the whole subtree so they show as "não importado" again.
  for (const id of [task.id, ...children]) await ctx.repos.tickets.unlinkTask(id);
  // An epic that still has cards is refused here (EPIC_HAS_CHILDREN), after the unlink: an epic never has tickets.
  if (!(await rules(() => ctx.repos.tasks.delete(task.id)))) throw new ControlError('NOT_FOUND', 'Tarefa não encontrada');
  return { deleted: true, task_id: task.id, deleted_subtasks: children.length, board_url: boardUrl(task.project_id) };
}
