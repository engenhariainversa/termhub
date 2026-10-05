import type { PrismaClient } from '../prisma.js';
import { normalizeSetup, SETUP_VERSION, withLegacyMirror, type ProjectSetupData, type TicketSource } from '../../setup/schema.js';

export interface ProjectSetup {
  project_id: string;
  version: number;
  data: ProjectSetupData;
  updated_at: string | null;
}

export class ProjectSetupRepository {
  constructor(private db: PrismaClient) {}

  async get(projectId: string): Promise<ProjectSetup> {
    const row = await this.db.projectSetup.findUnique({ where: { projectId } });
    return {
      project_id: projectId,
      version: SETUP_VERSION,
      data: normalizeSetup(row?.data, row?.version ?? SETUP_VERSION),
      updated_at: row?.updatedAt.toISOString() ?? null,
    };
  }

  async save(projectId: string, data: ProjectSetupData): Promise<ProjectSetup> {
    const withMirror = withLegacyMirror(data);
    const row = await this.db.projectSetup.upsert({
      where: { projectId },
      create: { projectId, version: SETUP_VERSION, data: withMirror as object },
      update: { version: SETUP_VERSION, data: withMirror as object },
    });
    return { project_id: projectId, version: row.version, data: normalizeSetup(row.data, row.version), updated_at: row.updatedAt.toISOString() };
  }

  /** Projects with at least one source on automatic sync, and those sources. */
  async listWithAutoSync(): Promise<{ project_id: string; sources: TicketSource[] }[]> {
    const rows = await this.db.projectSetup.findMany();
    return rows
      .map((r) => ({ project_id: r.projectId, sources: normalizeSetup(r.data, r.version).ticket_sources.filter((s) => s.sync_minutes > 0) }))
      .filter((r) => r.sources.length > 0);
  }

  /** Projects with automatic work on (`automation.enabled`), and their setup: what the dispatcher walks. */
  async listWithAutomation(): Promise<{ project_id: string; data: ProjectSetupData }[]> {
    const rows = await this.db.projectSetup.findMany();
    return rows.map((r) => ({ project_id: r.projectId, data: normalizeSetup(r.data, r.version) })).filter((r) => r.data.automation.enabled);
  }

  /** Projects whose setup names a repository and the integration to read it with (CI panel). */
  async listWithRepo(): Promise<{ project_id: string; data: ProjectSetupData }[]> {
    const rows = await this.db.projectSetup.findMany();
    return rows
      .map((r) => ({ project_id: r.projectId, data: normalizeSetup(r.data, r.version) }))
      .filter((r) => !!r.data.repo?.integration_id && !!r.data.repo.full_name);
  }
}
