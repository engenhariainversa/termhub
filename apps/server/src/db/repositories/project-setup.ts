import type { PrismaClient } from '../prisma.js';
import { normalizeSetup, SETUP_VERSION, withLegacyMirror, type ProjectSetupData, type TicketSource } from '../../setup/schema.js';
import { withRepoMirror } from '../../setup/repos.js';
import { loadProjectRepositories } from './project-repositories.js';

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
    // spec 2026-10-07 multi-repo R19: `repo` follows the first enabled repository once the project has several
    const withMirror = withRepoMirror(withLegacyMirror(data), await loadProjectRepositories(this.db, projectId));
    const before = await this.db.projectSetup.findUnique({ where: { projectId } });
    const row = await this.db.projectSetup.upsert({
      where: { projectId },
      create: { projectId, version: SETUP_VERSION, data: withMirror as object },
      update: { version: SETUP_VERSION, data: withMirror as object },
    });
    // TER-1212: an account added back to a project is in use again, and its dismissed login banner returns.
    const had = new Set(before ? normalizeSetup(before.data, before.version).ai.accounts : []);
    const added = data.ai.accounts.filter((id) => !had.has(id));
    if (added.length > 0) await this.db.aiAccount.updateMany({ where: { id: { in: added }, loginWarningDismissedAt: { not: null } }, data: { loginWarningDismissedAt: null } });
    return { project_id: projectId, version: row.version, data: normalizeSetup(row.data, row.version), updated_at: row.updatedAt.toISOString() };
  }

  /** TER-1212: every AI account id some project's Setup lists ("AI accounts and model"). */
  async listedAccountIds(): Promise<Set<string>> {
    const rows = await this.db.projectSetup.findMany();
    return new Set(rows.flatMap((r) => normalizeSetup(r.data, r.version).ai.accounts));
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

  /** Projects that publish their current rules to ai-memory (TER-1019): what the rules sweeper walks. */
  async listWithAiMemoryRules(): Promise<string[]> {
    const rows = await this.db.projectSetup.findMany();
    return rows.filter((r) => normalizeSetup(r.data, r.version).ai_memory.publish_rules).map((r) => r.projectId);
  }

  /** Projects whose setup names a repository and the integration to read it with (CI panel). */
  /**
   * Projects with any repository the CI sync can read (spec 2026-10-07 multi-repo R17): one named in
   * `setup.repo` or an override, or found by discovery, and a GitHub integration named somewhere in the setup.
   */
  async listWithRepo(): Promise<{ project_id: string; data: ProjectSetupData }[]> {
    const [rows, discovered] = await Promise.all([this.db.projectSetup.findMany(), this.db.projectRepository.findMany({ select: { projectId: true }, distinct: ['projectId'] })]);
    const withRows = new Set(discovered.map((d) => d.projectId));
    return rows
      .map((r) => ({ project_id: r.projectId, data: normalizeSetup(r.data, r.version) }))
      .filter(({ project_id, data }) => {
        const named = !!data.repo?.full_name || data.repos.length > 0 || withRows.has(project_id);
        const integration = !!data.repo?.integration_id || !!data.repo_defaults.integration_id || data.repos.some((o) => !!o.integration_id);
        return named && integration;
      });
  }
}
