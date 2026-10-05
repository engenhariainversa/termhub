import type { PrismaClient } from '../prisma.js';
import type { Task as PrismaTask } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { closeGap, defaultEpicId, endOf, ensureDefaultColumns, firstColumnId, lockProject, openSlot, placementFor, placementOf, requireEpic, type Tx } from './task-board.js';
import { checkSubtaskParent, checkTypeChange, MAX_SUBTASKS_PER_CALL, PARENT_TYPES, TaskRuleError, WORK_TYPES } from './task-rules.js';
import { nestTasks } from './task-tree.js';
import { mapTask, type OfficeProgress, type Task, type TaskStatus, type TaskType, type TaskWithSubtasks } from './types.js';

export { MAX_SUBTASKS_PER_CALL, TaskRuleError, type TaskRuleCode } from './task-rules.js';

/** Every query that maps a task loads its project's key, for `ref`. */
const KEY = { project: { select: { key: true } } } as const;
const toTask = (t: PrismaTask & { project: { key: string } }): Task => mapTask(t, t.project.key);

/** The work the counters count: top-level stories, tasks, bugs and spikes (epics group, subtasks are checklist items). */
const WORK = { parentId: null, type: { in: WORK_TYPES } };

export interface TaskInput {
  title: string;
  description?: string | null;
  /** backlog, or a category (the card lands in the first column of it); default todo, backlog for an epic */
  status?: TaskStatus;
  /** default task; a subtask needs parent_id */
  type?: TaskType;
  /** story/task/bug/spike: its epic; absent or null = the project's default epic. Ignored for an epic. */
  epic_id?: string | null;
  /** a board column of the project; wins over status */
  column_id?: string | null;
  /** creates a subtask of this story or task */
  parent_id?: string | null;
  /** Tag "automático" on a top-level card. A card in an automatic epic is born automatic whatever this says (the epic rules, spec D2). */
  auto?: boolean;
}

/** What `update` changes. `epic_id` is ignored on epics and subtasks (they have none). */
export interface TaskPatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  type?: TaskType;
  epic_id?: string | null;
}

export interface SubtaskInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
}

/** Where `move` sends a card: a column of its project, or a status (backlog, or the first column of a category). */
export type MoveTarget = { column_id: string } | { status: TaskStatus };

export class TasksRepository {
  constructor(private db: PrismaClient) {}

  /** Every card of the project, subtasks nested under their parent (epics included: the backlog needs them). Heals legacy rows first. */
  async listByProject(projectId: string): Promise<TaskWithSubtasks[]> {
    await this.normalize(projectId);
    const project = await this.db.project.findUnique({ where: { id: projectId }, select: { key: true } });
    if (!project) return [];
    const rows = await this.db.task.findMany({ where: { projectId }, orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }] });
    return nestTasks(rows.map((t) => mapTask(t, project.key)));
  }

  /**
   * Heals what the previous release writes during a blue/green switch (spec §3): a project without
   * columns gets the defaults; a row with a parent becomes a subtask; a top-level non-epic card with
   * no epic joins the default epic (appended to its backlog when it is in the backlog); a non-backlog
   * top-level card whose column disagrees with its status — no column at all, or a column of another
   * category (the old release's move only ever changes status/position) — is appended to the first
   * column of its status's category; a backlog card that kept a column from before the move is
   * stripped of it and appended to its epic's backlog. Trust `status`: it holds the person's latest
   * action. Cheap counts decide; a healthy board is not written to.
   */
  async normalize(projectId: string): Promise<void> {
    const legacySubtasks = { projectId, parentId: { not: null }, type: { not: 'subtask' as const } };
    const orphans = { projectId, parentId: null, epicId: null, type: { notIn: ['epic' as const, 'subtask' as const] } };
    const backlogWithColumn = { projectId, parentId: null, status: 'backlog' as const, columnId: { not: null } };
    const wrongColumnFor = (category: 'todo' | 'doing' | 'done') => ({
      projectId,
      parentId: null,
      status: category,
      OR: [{ columnId: null }, { column: { category: { not: category } } }],
    });
    const wrongColumnAny = { projectId, parentId: null, OR: (['todo', 'doing', 'done'] as const).map((c) => wrongColumnFor(c)) };
    const [columns, subs, noEpic, noBacklogColumn, noColumn] = await Promise.all([
      this.db.taskColumn.count({ where: { projectId } }),
      this.db.task.count({ where: legacySubtasks }),
      this.db.task.count({ where: orphans }),
      this.db.task.count({ where: backlogWithColumn }),
      this.db.task.count({ where: wrongColumnAny }),
    ]);
    if (columns > 0 && subs + noEpic + noBacklogColumn + noColumn === 0) return;
    await this.db.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await ensureDefaultColumns(tx, projectId);
      await tx.task.updateMany({ where: legacySubtasks, data: { type: 'subtask', epicId: null, columnId: null } });
      const noEpicRows = await tx.task.findMany({ where: orphans, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
      if (noEpicRows.length > 0) {
        const epicId = await defaultEpicId(tx, projectId);
        let next = await endOf(tx, projectId, { status: 'backlog', columnId: null, epicId, type: 'task' });
        for (const t of noEpicRows) await tx.task.update({ where: { id: t.id }, data: { epicId, ...(t.status === 'backlog' ? { position: next++ } : {}) } });
      }
      // an old-release move to backlog keeps the columnId it had on the board: strip it and append
      // to the (by now resolved) epic's backlog, grouping so several rows of one epic each get a slot.
      const backlogRows = await tx.task.findMany({ where: backlogWithColumn, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
      const byEpic = new Map<string, typeof backlogRows>();
      for (const t of backlogRows) {
        const key = t.epicId ?? '';
        const bucket = byEpic.get(key) ?? [];
        bucket.push(t);
        byEpic.set(key, bucket);
      }
      for (const [epicKey, rows] of byEpic) {
        const epicId = epicKey || (await defaultEpicId(tx, projectId));
        let next = await endOf(tx, projectId, { status: 'backlog', columnId: null, epicId, type: 'task' });
        for (const t of rows) await tx.task.update({ where: { id: t.id }, data: { columnId: null, epicId, position: next++ } });
      }
      // an old-release move within a category (e.g. todo→doing) keeps the old columnId: `status` wins.
      for (const category of ['todo', 'doing', 'done'] as const) {
        const rows = await tx.task.findMany({ where: wrongColumnFor(category), orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
        if (rows.length === 0) continue;
        const columnId = await firstColumnId(tx, projectId, category);
        let next = await endOf(tx, projectId, { status: category, columnId, epicId: null, type: 'task' });
        for (const t of rows) await tx.task.update({ where: { id: t.id }, data: { columnId, position: next++ } });
      }
    });
  }

  async findById(id: string): Promise<Task | undefined> {
    const t = await this.db.task.findUnique({ where: { id }, include: KEY });
    return t ? toTask(t) : undefined;
  }

  async findByIds(ids: string[]): Promise<Task[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.task.findMany({ where: { id: { in: ids } }, include: KEY });
    return rows.map(toTask);
  }

  /** The card numbered `number` in the project (the `N` of `KEY-N`). */
  async findByRef(projectId: string, number: number): Promise<Task | undefined> {
    const t = await this.db.task.findUnique({ where: { projectId_number: { projectId, number } }, include: KEY });
    return t ? toTask(t) : undefined;
  }

  /**
   * Batched by id, one query regardless of how many ids are asked for, filtered to one owner's tasks
   * through their project — never "no filter": a caller that resolves names for one
   * person's screen (e.g. the chat action trail) must not be able to pass `null` and see everyone's.
   * Another owner's task id is simply absent from the result, like a row that does not exist.
   */
  async findByIdsForOwner(ids: string[], ownerId: string): Promise<Task[]> {
    if (ids.length === 0) return [];
    return (await this.db.task.findMany({ where: { id: { in: ids }, project: { ownerId } }, include: KEY })).map(toTask);
  }

  /**
   * Cards of this owner's projects at or after the `(since, afterId)` cursor, oldest first, capped at
   * `limit` — the memory sweeper's read for indexing cards (spec 2026-09-26 concierge memory §4, fix
   * round 1). Ordered by `(updated_at, id)`, and the cursor is that same pair: with `afterId` given, a
   * row exactly at `since` only counts once its id is past `afterId`, so a page boundary that lands
   * mid-tie (several cards updated in the very same millisecond) never re-reads a row it already
   * returned nor skips one it has not. Without `afterId` (the very first page a caller ever asks for),
   * `since` alone is inclusive. The caller (`indexTasks`) is what turns a backlog bigger than `limit`
   * into full, forward-only coverage: advancing this cursor from the *last* row of each page it reads,
   * never from anything computed independently of what was actually fetched.
   */
  async listChangedForOwner(ownerId: string, since: Date, limit = 200, afterId?: string): Promise<Task[]> {
    const rows = await this.db.task.findMany({
      where: {
        project: { ownerId },
        OR: afterId !== undefined ? [{ updatedAt: { gt: since } }, { updatedAt: since, id: { gt: afterId } }] : [{ updatedAt: { gte: since } }],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      include: KEY,
    });
    return rows.map(toTask);
  }

  /** Every owner with at least one card — the memory sweeper's per-owner pass (spec 2026-09-26
   *  concierge memory §4): never Prisma outside a repository. */
  async listOwnersWithTasks(): Promise<string[]> {
    const rows = await this.db.project.findMany({ where: { ownerId: { not: null }, tasks: { some: {} } }, select: { ownerId: true }, distinct: ['ownerId'] });
    return rows.map((r) => r.ownerId).filter((id): id is string => id !== null);
  }

  /** A top-level card lands at the top of its column (or of its epic's backlog); a subtask is appended to its parent. */
  async create(projectId: string, input: TaskInput): Promise<Task> {
    if (input.parent_id || input.type === 'subtask') {
      if (!input.parent_id) throw new TaskRuleError('PARENT_NOT_FOUND');
      const [subtask] = await this.createSubtasks(input.parent_id, [{ title: input.title, description: input.description, status: input.status }], projectId);
      return subtask;
    }
    return this.db.$transaction(async (tx) => toTask(await this.insertCard(tx, projectId, input)));
  }

  /**
   * A top-level card and its subtasks in one transaction (the MCP `create_task` tool): the card lands
   * at the top of its column, the subtasks in call order. All or nothing — every rule is checked
   * before anything is written.
   */
  async createWithSubtasks(projectId: string, input: Omit<TaskInput, 'parent_id'>, subtasks: SubtaskInput[]): Promise<TaskWithSubtasks> {
    if (subtasks.length > MAX_SUBTASKS_PER_CALL) throw new TaskRuleError('TOO_MANY_SUBTASKS');
    if (input.type === 'subtask') throw new TaskRuleError('PARENT_NOT_FOUND');
    if (subtasks.length > 0 && !PARENT_TYPES.includes(input.type ?? 'task')) throw new TaskRuleError('PARENT_TYPE');
    return this.db.$transaction(async (tx) => {
      const parent = await this.insertCard(tx, projectId, input);
      const rows = [toTask(parent)];
      for (const [position, item] of subtasks.entries()) {
        const t = await tx.task.create({
          data: { id: newId(), projectId, parentId: parent.id, type: 'subtask', title: item.title, description: item.description ?? null, status: item.status ?? 'todo', position },
          include: KEY,
        });
        rows.push(toTask(t));
      }
      return nestTasks(rows)[0];
    });
  }

  /** Validates type, epic and column, then writes a top-level card at slot 0 of its place. */
  private async insertCard(tx: Tx, projectId: string, input: Omit<TaskInput, 'parent_id'>) {
    await lockProject(tx, projectId);
    await ensureDefaultColumns(tx, projectId);
    const type = input.type ?? 'task';
    const epicId = type === 'epic' ? null : input.epic_id ? await requireEpic(tx, projectId, input.epic_id) : await defaultEpicId(tx, projectId);
    const to = await placementFor(tx, projectId, { type, epicId }, { column_id: input.column_id, status: input.status ?? (type === 'epic' ? 'backlog' : 'todo') });
    const position = await openSlot(tx, projectId, to, 0);
    const epicAuto = epicId ? ((await tx.task.findUnique({ where: { id: epicId }, select: { auto: true } }))?.auto ?? false) : false;
    return tx.task.create({
      data: { id: newId(), projectId, type, title: input.title, description: input.description ?? null, status: to.status, columnId: to.columnId, epicId, position, auto: epicAuto || (input.auto ?? false) },
      include: KEY,
    });
  }

  /**
   * Appends subtasks to `parentId` in one transaction. The parent must be a top-level story or task
   * (of `expectProjectId`, when given). Subtasks inherit the parent's project and have no epic or column.
   */
  async createSubtasks(parentId: string, items: SubtaskInput[], expectProjectId?: string): Promise<Task[]> {
    if (items.length > MAX_SUBTASKS_PER_CALL) throw new TaskRuleError('TOO_MANY_SUBTASKS');
    const found = await this.db.task.findUnique({ where: { id: parentId }, select: { projectId: true } });
    if (!found || (expectProjectId && found.projectId !== expectProjectId)) throw new TaskRuleError('PARENT_NOT_FOUND');
    return this.db.$transaction(async (tx) => {
      // The project lock serializes every writer of this board, concurrent appends to one parent included.
      await lockProject(tx, found.projectId);
      const parent = await tx.task.findUnique({ where: { id: parentId } });
      if (!parent) throw new TaskRuleError('PARENT_NOT_FOUND');
      checkSubtaskParent(parent);
      const agg = await tx.task.aggregate({ where: { parentId }, _max: { position: true } });
      let position = (agg._max.position ?? -1) + 1;
      const created: Task[] = [];
      for (const item of items) {
        const t = await tx.task.create({
          data: {
            id: newId(),
            projectId: parent.projectId,
            parentId,
            type: 'subtask',
            title: item.title,
            description: item.description ?? null,
            status: item.status ?? 'todo',
            position: position++,
          },
          include: KEY,
        });
        created.push(toTask(t));
      }
      return created;
    });
  }

  /** Ids of a task's subtasks (the route unlinks their tickets before a cascading delete). */
  async childIds(id: string): Promise<string[]> {
    const rows = await this.db.task.findMany({ where: { parentId: id }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /**
   * Title, description, type, epic and status. A subtask's status changes in place (the checklist);
   * a top-level card's status change is a move to the top of the first column of that category (or of
   * its epic's backlog). A backlog item that changes epic goes to the top of the new epic's backlog.
   */
  async update(id: string, patch: TaskPatch): Promise<Task | undefined> {
    return this.db.$transaction(async (tx) => {
      const found = await tx.task.findUnique({ where: { id }, select: { projectId: true } });
      if (!found) return undefined;
      await lockProject(tx, found.projectId);
      const cur = await tx.task.findUnique({ where: { id } });
      if (!cur) return undefined;
      const text = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      };
      if (cur.parentId) {
        if (patch.type && patch.type !== cur.type) throw new TaskRuleError('TYPE_LOCKED');
        return toTask(await tx.task.update({ where: { id }, data: { ...text, ...(patch.status ? { status: patch.status } : {}) }, include: KEY }));
      }
      const type = patch.type ?? cur.type;
      if (type !== cur.type) checkTypeChange(cur.type, type, await tx.task.count({ where: { parentId: id } }));
      let epicId = cur.epicId;
      if (type !== 'epic' && patch.epic_id !== undefined) {
        if (!patch.epic_id) throw new TaskRuleError('EPIC_REQUIRED');
        epicId = await requireEpic(tx, cur.projectId, patch.epic_id);
      }
      if (type !== 'epic' && !epicId) epicId = await defaultEpicId(tx, cur.projectId);

      const statusChanges = patch.status !== undefined && patch.status !== cur.status;
      const backlogEpicChanges = !statusChanges && cur.status === 'backlog' && epicId !== cur.epicId;
      let place = { status: cur.status as TaskStatus, columnId: cur.columnId, position: cur.position };
      if (statusChanges || backlogEpicChanges) {
        const to = await placementFor(tx, cur.projectId, { type, epicId }, { status: statusChanges ? patch.status : 'backlog' });
        await closeGap(tx, cur.projectId, placementOf(cur), cur.position, id);
        place = { status: to.status, columnId: to.columnId, position: await openSlot(tx, cur.projectId, to, 0, id) };
      }
      // Moving into an automatic epic tags the card; moving out keeps the tag (spec D2).
      const joinsAutoEpic = type !== 'epic' && epicId !== cur.epicId && epicId !== null && (await tx.task.findUnique({ where: { id: epicId }, select: { auto: true } }))?.auto === true;
      const t = await tx.task.update({ where: { id }, data: { ...text, type, epicId, ...(joinsAutoEpic ? { auto: true } : {}), status: place.status, columnId: place.columnId, position: place.position }, include: KEY });
      return toTask(t);
    });
  }

  /**
   * Tags or untags a top-level card for automatic work. On an epic it is the whole epic: the epic and every
   * top-level card in it, cards tagged one by one included (spec D2). Subtasks never carry the tag.
   */
  async setAuto(taskId: string, auto: boolean): Promise<{ changed: number }> {
    return this.db.$transaction(async (tx) => {
      const found = await tx.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
      if (!found) return { changed: 0 };
      await lockProject(tx, found.projectId);
      const cur = await tx.task.findUnique({ where: { id: taskId } });
      if (!cur) return { changed: 0 };
      if (cur.parentId) throw new TaskRuleError('AUTO_NOT_FOR_SUBTASK');
      const own = await tx.task.updateMany({ where: { id: taskId, auto: { not: auto } }, data: { auto } });
      if (cur.type !== 'epic') return { changed: own.count };
      const cards = await tx.task.updateMany({ where: { projectId: cur.projectId, epicId: taskId, parentId: null, auto: { not: auto } }, data: { auto } });
      return { changed: own.count + cards.count };
    });
  }

  /** Moves a top-level card to a column (or a status) at `position` (clamped), closing its old gap. */
  async move(id: string, target: MoveTarget, position: number): Promise<Task | undefined> {
    return this.db.$transaction(async (tx) => {
      const found = await tx.task.findUnique({ where: { id }, select: { projectId: true, parentId: true } });
      if (!found) return undefined;
      if (found.parentId) throw new TaskRuleError('SUBTASK_CANNOT_MOVE');
      await lockProject(tx, found.projectId);
      const cur = await tx.task.findUniqueOrThrow({ where: { id } });
      const epicId = cur.type === 'epic' ? null : (cur.epicId ?? (await defaultEpicId(tx, cur.projectId)));
      const to = await placementFor(tx, cur.projectId, { type: cur.type, epicId }, 'column_id' in target ? { column_id: target.column_id } : { status: target.status });
      await closeGap(tx, cur.projectId, placementOf(cur), cur.position, id);
      const slot = await openSlot(tx, cur.projectId, to, position, id);
      return toTask(await tx.task.update({ where: { id }, data: { status: to.status, columnId: to.columnId, epicId, position: slot }, include: KEY }));
    });
  }

  /**
   * An agent starts on the card (start_agent): a top-level card goes to the top of the project's agent
   * column — else the first `doing` column — unless it already sits in a doing column; a subtask is
   * marked doing.
   */
  async startWork(id: string): Promise<Task | undefined> {
    const cur = await this.findById(id);
    if (!cur) return undefined;
    if (cur.status === 'doing') return cur;
    if (cur.parent_id) return this.update(id, { status: 'doing' });
    const project = await this.db.project.findUnique({ where: { id: cur.project_id }, select: { agentColumnId: true } });
    return this.move(id, project?.agentColumnId ? { column_id: project.agentColumnId } : { status: 'doing' }, 0);
  }

  /** Moves a subtask to `position` among its siblings (clamped), reindexing them 0..n-1. */
  async reorder(id: string, position: number): Promise<Task | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    if (!current.parent_id) throw new TaskRuleError('NOT_A_SUBTASK');
    return this.db.$transaction(async (tx) => {
      await lockProject(tx, current.project_id);
      const siblings = await tx.task.findMany({ where: { parentId: current.parent_id }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true, position: true } });
      const ids = siblings.map((s) => s.id).filter((s) => s !== id);
      ids.splice(Math.max(0, Math.min(Math.trunc(position), ids.length)), 0, id);
      for (const [i, siblingId] of ids.entries()) {
        if (siblings.find((s) => s.id === siblingId)?.position !== i) await tx.task.update({ where: { id: siblingId }, data: { position: i } });
      }
      const t = await tx.task.findUnique({ where: { id }, include: KEY });
      return t ? toTask(t) : undefined;
    });
  }

  /** Deletes the card (its subtasks cascade) and closes the gap it leaves. An epic with cards is refused. */
  async delete(id: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const found = await tx.task.findUnique({ where: { id }, select: { projectId: true } });
      if (!found) return false;
      await lockProject(tx, found.projectId);
      const cur = await tx.task.findUnique({ where: { id } });
      if (!cur) return false;
      if (cur.type === 'epic' && (await tx.task.count({ where: { epicId: id } })) > 0) throw new TaskRuleError('EPIC_HAS_CHILDREN');
      await tx.task.delete({ where: { id } });
      if (cur.parentId) {
        await tx.task.updateMany({ where: { parentId: cur.parentId, position: { gt: cur.position } }, data: { position: { decrement: 1 } } });
      } else {
        await closeGap(tx, cur.projectId, placementOf(cur), cur.position);
      }
      return true;
    });
  }

  /**
   * A synced ticket becomes a task at the end of the default epic's backlog (spec §5).
   * Deliberate deviation from spec D2: the card is never born automatic, even when the default epic is
   * tagged — an imported ticket must not become automatic work by import alone (ruling R-15).
   */
  /** With `ticketId`, that staging ticket is linked to the new card in the same transaction (no card without its link). */
  async createFromTicket(projectId: string, ticket: { key: string; title: string; description: string | null; ref: Record<string, unknown>; ticketId?: string }): Promise<Task> {
    return this.db.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await ensureDefaultColumns(tx, projectId);
      const epicId = await defaultEpicId(tx, projectId);
      const position = await endOf(tx, projectId, { status: 'backlog', columnId: null, epicId, type: 'task' });
      const t = await tx.task.create({
        data: {
          id: newId(),
          projectId,
          type: 'task',
          epicId,
          title: ticket.title,
          description: ticket.description,
          status: 'backlog',
          position,
          externalKey: ticket.key,
          externalRef: ticket.ref as object,
        },
        include: KEY,
      });
      if (ticket.ticketId) await tx.ticket.update({ where: { id: ticket.ticketId, projectId }, data: { taskId: t.id } });
      return toTask(t);
    });
  }

  /** Atualiza só o espelho do ticket externo (estado/meta), sem mexer em título, coluna ou descrição. */
  async setExternalRef(id: string, ref: Record<string, unknown>): Promise<void> {
    await this.db.task.updateMany({ where: { id }, data: { externalRef: ref as object } });
  }

  async setTab(id: string, tabId: string | null): Promise<Task | undefined> {
    const t = await this.db.task.update({ where: { id }, data: { tabId }, include: KEY });
    return toTask(t);
  }

  /** Open work (todo + doing) per project: stories, tasks, bugs and spikes. */
  async openCountByProject(): Promise<Record<string, number>> {
    const rows = await this.db.task.groupBy({ by: ['projectId'], where: { status: { in: ['todo', 'doing'] }, ...WORK }, _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.projectId, r._count._all]));
  }

  /** `owner`: only tasks of that user's projects (null = all). Work types only. */
  async listDoing(owner: string | null = null): Promise<Task[]> {
    const rows = await this.db.task.findMany({
      where: { status: 'doing', ...WORK, ...(owner ? { project: { ownerId: owner } } : {}) },
      orderBy: [{ projectId: 'asc' }, { position: 'asc' }],
      include: KEY,
    });
    return rows.map(toTask);
  }

  /** Whether the project has a top-level work card in a doing column (the CI poll's "work in progress"). */
  async hasDoing(projectId: string): Promise<boolean> {
    return (await this.db.task.count({ where: { projectId, status: 'doing', ...WORK }, take: 1 })) > 0;
  }

  /**
   * What the office floor shows of the board: per project, how many top-level tasks sit in
   * todo/doing/done (the backlog is not work in progress); per tab, the `doing` task bound to it
   * with its subtask counts. Two `doing` tasks on one tab: the first by position wins.
   */
  async officeProgress(projectIds: string[]): Promise<OfficeProgress> {
    if (projectIds.length === 0) return { counts: {}, byTab: {} };
    const [groups, bound] = await Promise.all([
      this.db.task.groupBy({
        by: ['projectId', 'status'],
        where: { projectId: { in: projectIds }, ...WORK, status: { in: ['todo', 'doing', 'done'] } },
        _count: { _all: true },
      }),
      this.db.task.findMany({
        where: { projectId: { in: projectIds }, ...WORK, status: 'doing', tabId: { not: null } },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, title: true, tabId: true, subtasks: { select: { status: true } } },
      }),
    ]);
    const counts: OfficeProgress['counts'] = {};
    for (const g of groups) {
      const c = (counts[g.projectId] ??= { todo: 0, doing: 0, done: 0 });
      c[g.status as 'todo' | 'doing' | 'done'] = g._count._all;
    }
    const byTab: OfficeProgress['byTab'] = {};
    for (const t of bound) {
      if (!t.tabId || byTab[t.tabId]) continue;
      byTab[t.tabId] = { task_id: t.id, title: t.title, done: t.subtasks.filter((s) => s.status === 'done').length, total: t.subtasks.length };
    }
    return { counts, byTab };
  }
}
