import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { ProjectRuleError } from './projects.js';
import { mapMachine, mapProjectMachine, type Machine, type ProjectMachine } from './types.js';

const ORDER = [{ position: 'asc' as const }, { createdAt: 'asc' as const }];

/** The project ↔ machine links: where a project's terminals run and in which directory. */
export class ProjectMachinesRepository {
  constructor(private db: PrismaClient) {}

  async listByProject(projectId: string): Promise<ProjectMachine[]> {
    return (await this.db.projectMachine.findMany({ where: { projectId }, orderBy: ORDER })).map(mapProjectMachine);
  }

  /** Links of many projects in one query (the project list attaches them). */
  async listByProjects(projectIds: string[]): Promise<ProjectMachine[]> {
    if (projectIds.length === 0) return [];
    return (await this.db.projectMachine.findMany({ where: { projectId: { in: projectIds } }, orderBy: ORDER })).map(mapProjectMachine);
  }

  /**
   * Every link of an owned project, with its project's owner and its machine (the memory docs sweeper,
   * spec 2026-09-26 concierge memory D15: it walks all of them, owner by owner, with no request scope).
   * An orphaned project (owner deleted) is left out — its items would have no one to belong to.
   */
  /** `ai_memory_lessons`: the project's TER-1021 opt-in, read by the memory sweeper's docs pass. */
  async listAllWithOwner(): Promise<(ProjectMachine & { owner_id: string; ai_memory_lessons: boolean; machine: Machine })[]> {
    const rows = await this.db.projectMachine.findMany({
      where: { project: { ownerId: { not: null } } },
      include: { project: { select: { ownerId: true, aiMemoryLessons: true } }, machine: { include: { owner: { select: { name: true } } } } },
      orderBy: [{ projectId: 'asc' }, ...ORDER],
    });
    return rows.map((l) => ({ ...mapProjectMachine(l), owner_id: l.project.ownerId!, ai_memory_lessons: l.project.aiMemoryLessons, machine: mapMachine(l.machine) }));
  }

  async listByMachine(machineId: string): Promise<ProjectMachine[]> {
    return (await this.db.projectMachine.findMany({ where: { machineId }, orderBy: ORDER })).map(mapProjectMachine);
  }

  async find(projectId: string, machineId: string): Promise<ProjectMachine | undefined> {
    const l = await this.db.projectMachine.findUnique({ where: { projectId_machineId: { projectId, machineId } } });
    return l ? mapProjectMachine(l) : undefined;
  }

  async link(input: { project_id: string; machine_id: string; cwd: string }): Promise<ProjectMachine> {
    if (await this.find(input.project_id, input.machine_id)) throw new ProjectRuleError('MACHINE_ALREADY_LINKED', 'Esta máquina já está vinculada ao projeto');
    const agg = await this.db.projectMachine.aggregate({ where: { projectId: input.project_id }, _max: { position: true } });
    const l = await this.db.projectMachine.create({
      data: { id: newId(), projectId: input.project_id, machineId: input.machine_id, cwd: input.cwd, position: (agg._max.position ?? -1) + 1 },
    });
    return mapProjectMachine(l);
  }

  async updateCwd(projectId: string, machineId: string, cwd: string): Promise<ProjectMachine | undefined> {
    const r = await this.db.projectMachine.updateMany({ where: { projectId, machineId }, data: { cwd } });
    return r.count > 0 ? this.find(projectId, machineId) : undefined;
  }

  async unlink(projectId: string, machineId: string): Promise<boolean> {
    const r = await this.db.projectMachine.deleteMany({ where: { projectId, machineId } });
    return r.count > 0;
  }
}
