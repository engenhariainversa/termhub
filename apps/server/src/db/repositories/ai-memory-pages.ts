import type { PrismaClient } from '../prisma.js';

/** One rule page termhub wrote to ai-memory (TER-1019), in one checkout (`cwd`) of one machine. */
export interface AiMemoryPageRow {
  project_id: string;
  machine_id: string;
  cwd: string;
  path: string;
  hash: string;
}

/**
 * What termhub published as pinned ai-memory pages, per project, machine and checkout: the sync diffs
 * the wanted pages against it, so it rewrites only what changed and deletes only what it wrote.
 */
export class AiMemoryPagesRepository {
  constructor(private db: PrismaClient) {}

  async listByProject(projectId: string): Promise<AiMemoryPageRow[]> {
    const rows = await this.db.aiMemoryPage.findMany({ where: { projectId }, orderBy: [{ machineId: 'asc' }, { cwd: 'asc' }, { path: 'asc' }] });
    return rows.map((r) => ({ project_id: r.projectId, machine_id: r.machineId, cwd: r.cwd, path: r.path, hash: r.hash }));
  }

  /** Projects with at least one published page (the sweeper also walks these, to clean up). */
  async projectIds(): Promise<string[]> {
    const rows = await this.db.aiMemoryPage.findMany({ distinct: ['projectId'], select: { projectId: true } });
    return rows.map((r) => r.projectId);
  }

  async upsert(row: AiMemoryPageRow): Promise<void> {
    const key = { projectId: row.project_id, machineId: row.machine_id, cwd: row.cwd, path: row.path };
    await this.db.aiMemoryPage.upsert({
      where: { projectId_machineId_cwd_path: key },
      create: { ...key, hash: row.hash },
      update: { hash: row.hash, publishedAt: new Date() },
    });
  }

  async remove(projectId: string, machineId: string, cwd: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.db.aiMemoryPage.deleteMany({ where: { projectId, machineId, cwd, path: { in: paths } } });
  }
}
