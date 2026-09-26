import type { FastifyRequest } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { Integration } from '../db/repositories/integrations.js';
import type { AiAccount, Machine, Project, ProjectMachine, Tab, Task, TaskColumn, User } from '../db/repositories/types.js';
import { HttpError, notFound } from '../lib/errors.js';
import { parseRef } from '../db/repositories/task-rules.js';
import { isAdmin } from './permissions.js';

/**
 * Data scope: machines, projects and integrations belong to a user (`owner_id`); tabs, tasks,
 * notes and tickets follow their project, and a tab additionally runs on a machine of the same
 * scope. A request sees only the rows of one owner — the signed-in user by default. Admins can
 * switch that owner with the "view as" cookie: another user's id (support/impersonation) or "*"
 * for everything. Non-admins never leave their own scope, whatever the cookie says.
 */

export const VIEW_AS_COOKIE = 'termhub_view_as';
export const VIEW_AS_ALL = '*';

export type ViewAs = { kind: 'self' } | { kind: 'all' } | { kind: 'user'; user: User };

export interface Scope {
  user: User;
  viewAs: ViewAs;
  /** owner filter for lists and lookups: a user id, or null = no filter (admin "all") */
  ownerId: string | null;
  /** owner assigned to rows created in this request */
  createAs: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** set by the auth hook for authenticated requests */
    scope: Scope;
  }
}

export async function resolveScope(repos: Repositories, user: User, cookies: Record<string, string>): Promise<Scope> {
  const self: Scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id };
  const raw = cookies[VIEW_AS_COOKIE];
  if (!raw || raw === user.id) return self;
  if (!(await isAdmin(repos, user))) return self;
  if (raw === VIEW_AS_ALL) return { user, viewAs: { kind: 'all' }, ownerId: null, createAs: user.id };
  const target = await repos.users.findById(raw);
  if (!target) return self;
  return { user, viewAs: { kind: 'user', user: target }, ownerId: target.id, createAs: target.id };
}

/** Ownership-checked lookups: anything outside the scope answers 404, like a row that does not exist. */
export class Scoped {
  constructor(
    private repos: Repositories,
    readonly scope: Scope,
  ) {}

  owns(ownerId: string | null): boolean {
    return this.scope.ownerId === null || ownerId === this.scope.ownerId;
  }

  async machine(id: string): Promise<Machine> {
    const m = await this.repos.machines.findById(id);
    if (!m || !this.owns(m.owner_id)) throw notFound('Máquina não encontrada');
    return m;
  }

  async project(id: string): Promise<{ project: Project }> {
    const project = await this.repos.projects.findById(id);
    if (!project || !this.owns(project.owner_id)) throw notFound('Projeto não encontrado');
    return { project };
  }

  /**
   * A project and one of its linked machines; the link and the machine must both be in scope. A scope miss
   * is a 404 (`HttpError`); a failure reading a row (a DB error) propagates unchanged.
   */
  async projectMachine(projectId: string, machineId: string): Promise<{ project: Project; machine: Machine; link: ProjectMachine }> {
    const { project } = await this.project(projectId);
    const link = await this.repos.projectMachines.find(projectId, machineId);
    if (!link) throw notFound('Máquina não vinculada ao projeto');
    const machine = await this.machine(machineId).catch((err: unknown) => {
      throw err instanceof HttpError ? notFound('Máquina não vinculada ao projeto') : err;
    });
    return { project, machine, link };
  }

  /** A project with every linked machine the scope can see (a link to a machine outside it is skipped). */
  async projectMachines(projectId: string): Promise<{ project: Project; machines: Array<{ machine: Machine; link: ProjectMachine }> }> {
    const { project } = await this.project(projectId);
    const links = await this.repos.projectMachines.listByProject(projectId);
    const machines: Array<{ machine: Machine; link: ProjectMachine }> = [];
    for (const link of links) {
      const machine = await this.repos.machines.findById(link.machine_id);
      if (machine && this.owns(machine.owner_id)) machines.push({ machine, link });
    }
    return { project, machines };
  }

  /**
   * The machine a new tab opens on: `machineId` when given (must be linked), else the only linked
   * machine. 400 MACHINE_REQUIRED with several, 400 NO_MACHINE with none — the messages tell the
   * person (or the agent) what to do.
   */
  async projectMachineFor(projectId: string, machineId?: string): Promise<{ project: Project; machine: Machine; link: ProjectMachine }> {
    if (machineId) return this.projectMachine(projectId, machineId);
    const { project, machines } = await this.projectMachines(projectId);
    if (machines.length === 0) throw new HttpError(400, 'Vincule uma máquina ao projeto antes de abrir um terminal', 'NO_MACHINE');
    if (machines.length > 1) throw new HttpError(400, 'Escolha a máquina onde abrir o terminal (machine_id)', 'MACHINE_REQUIRED');
    return { project, ...machines[0] };
  }

  /**
   * A tab of the scope. A scope miss on its project–machine link (an `HttpError`) is the tab's own 404;
   * any other failure (a DB error) propagates unchanged: callers read 404 as "the tab is gone", and a
   * card expires on it (spec 2026-09-26 §4.7).
   */
  async tab(id: string): Promise<{ tab: Tab; project: Project; machine: Machine; cwd: string }> {
    const tab = await this.repos.tabs.findById(id);
    if (!tab) throw notFound('Tab não encontrada');
    const { project, machine, link } = await this.projectMachine(tab.project_id, tab.machine_id).catch((err: unknown) => {
      throw err instanceof HttpError ? notFound('Tab não encontrada') : err;
    });
    return { tab, project, machine, cwd: link.cwd };
  }

  async task(id: string): Promise<{ task: Task; project: Project }> {
    const task = await this.repos.tasks.findById(id);
    if (!task) throw notFound('Tarefa não encontrada');
    const { project } = await this.project(task.project_id).catch(() => {
      throw notFound('Tarefa não encontrada');
    });
    return { task, project };
  }

  /**
   * A card by its ref ("TER-12", key case-insensitive). A malformed ref, an unknown key or number
   * and another owner's project all answer the same 404 — the ref never confirms a foreign project.
   */
  async taskByRef(ref: string): Promise<{ task: Task; project: Project }> {
    const parsed = parseRef(ref);
    const project = parsed ? await this.repos.projects.findByKey(parsed.key) : undefined;
    if (!parsed || !project || !this.owns(project.owner_id)) throw notFound('Card não encontrado');
    const task = await this.repos.tasks.findByRef(project.id, parsed.number);
    if (!task) throw notFound('Card não encontrado');
    return { task, project };
  }

  /** A board column and its project; the project must be in scope. */
  async column(id: string): Promise<{ column: TaskColumn; project: Project }> {
    const column = await this.repos.taskColumns.findById(id);
    if (!column) throw notFound('Coluna não encontrada');
    const { project } = await this.project(column.project_id).catch(() => {
      throw notFound('Coluna não encontrada');
    });
    return { column, project };
  }

  async integration(id: string): Promise<Integration> {
    const i = await this.repos.integrations.findById(id);
    if (!i || !this.owns(i.owner_id)) throw notFound('Integração não encontrada');
    return i;
  }

  async aiAccount(id: string): Promise<{ account: AiAccount; machine: Machine }> {
    const account = await this.repos.aiAccounts.findById(id);
    if (!account) throw notFound('Conta não encontrada');
    const machine = await this.machine(account.machine_id).catch(() => {
      throw notFound('Conta não encontrada');
    });
    return { account, machine };
  }
}

export const scoped = (repos: Repositories, request: FastifyRequest): Scoped => new Scoped(repos, request.scope);
