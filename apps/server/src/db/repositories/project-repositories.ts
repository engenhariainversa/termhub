import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { effectiveRepos, repoKeyFor, uniqueRepoKey, type EffectiveRepo } from '../../setup/repos.js';
import { sameRepo, type ProjectSetupData } from '../../setup/schema.js';
import { lockProject, type Tx } from './task-board.js';
import { mapProjectRepository, type ProjectRepository, type RepoStatus } from './types.js';

/** One git checkout a machine's scan found under the project's folder. */
export interface DiscoveredCheckoutInput {
  /** owner/repo */
  full_name: string;
  /** relative to the project's folder; `.` for the folder itself */
  dir: string;
  default_branch: string | null;
  has_commits: boolean;
  description?: string | null;
  status?: RepoStatus;
}

const WITH_CHECKOUTS = { checkouts: { orderBy: { machineId: 'asc' as const } } };

/** A project's discovered repositories with their checkouts, in key order. */
export async function loadProjectRepositories(db: PrismaClient | Tx, projectId: string): Promise<ProjectRepository[]> {
  return (await db.projectRepository.findMany({ where: { projectId }, include: WITH_CHECKOUTS, orderBy: { key: 'asc' } })).map(mapProjectRepository);
}

/**
 * The repositories discovery found in a project's folder (spec 2026-10-07 multi-repo R1). Discovery is the
 * only writer; the person's overrides live in the setup, and `effective` merges the two.
 */
export class ProjectRepositoriesRepository {
  constructor(private db: PrismaClient) {}

  listByProject(projectId: string): Promise<ProjectRepository[]> {
    return loadProjectRepositories(this.db, projectId);
  }

  /**
   * Stores what one machine's scan found. A repository new to the project gets its key here, and keeps it
   * for good (R4): a renamed folder only updates the checkout. `created` are the repositories new to the
   * project; `duplicates` are further checkouts of a repository already seen in this scan, of which the
   * first in folder order is used (spec §10).
   */
  async upsertDiscovered(
    projectId: string,
    machineId: string,
    found: DiscoveredCheckoutInput[],
  ): Promise<{ repositories: ProjectRepository[]; created: ProjectRepository[]; duplicates: DiscoveredCheckoutInput[] }> {
    const sorted = [...found].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
    const firsts: DiscoveredCheckoutInput[] = [];
    const duplicates: DiscoveredCheckoutInput[] = [];
    for (const f of sorted) (firsts.some((x) => sameRepo(x.full_name, f.full_name)) ? duplicates : firsts).push(f);

    return this.db.$transaction(async (tx) => {
      // two machines scanning at once must not hand out the same key
      await lockProject(tx, projectId);
      const known = await tx.projectRepository.findMany({ where: { projectId } });
      const keys = new Set(known.map((r) => r.key));
      const createdIds = new Set<string>();
      const now = new Date();
      for (const f of firsts) {
        let row = known.find((r) => sameRepo(r.fullName, f.full_name));
        if (!row) {
          const key = uniqueRepoKey(repoKeyFor(f.dir), keys);
          keys.add(key);
          row = await tx.projectRepository.create({
            data: { id: newId(), projectId, fullName: f.full_name, key, description: f.description ?? null, status: f.status ?? 'ok' },
          });
          known.push(row);
          createdIds.add(row.id);
        } else {
          const description = f.description === undefined ? row.description : f.description;
          const status = f.status ?? row.status;
          if (description !== row.description || status !== row.status) await tx.projectRepository.update({ where: { id: row.id }, data: { description, status } });
        }
        const checkout = { dir: f.dir, defaultBranch: f.default_branch, hasCommits: f.has_commits, seenAt: now, missingAt: null };
        await tx.projectRepositoryCheckout.upsert({
          where: { repositoryId_machineId: { repositoryId: row.id, machineId } },
          create: { repositoryId: row.id, machineId, ...checkout },
          update: checkout,
        });
      }
      const repositories = await loadProjectRepositories(tx, projectId);
      return { repositories, created: repositories.filter((r) => createdIds.has(r.id)), duplicates };
    });
  }

  /**
   * Marks this machine's checkouts of the project that a scan no longer found (`presentRepositoryIds` are
   * the ones it did). Returns the repositories newly marked. Nothing is deleted (R3).
   */
  async markMissing(projectId: string, machineId: string, presentRepositoryIds: string[]): Promise<ProjectRepository[]> {
    return this.db.$transaction(async (tx) => {
      const gone = await tx.projectRepositoryCheckout.findMany({
        where: { machineId, missingAt: null, repositoryId: { notIn: presentRepositoryIds }, repository: { projectId } },
        select: { repositoryId: true },
      });
      if (gone.length === 0) return [];
      const ids = gone.map((c) => c.repositoryId);
      await tx.projectRepositoryCheckout.updateMany({ where: { machineId, missingAt: null, repositoryId: { in: ids } }, data: { missingAt: new Date() } });
      return (await tx.projectRepository.findMany({ where: { id: { in: ids } }, include: WITH_CHECKOUTS, orderBy: { key: 'asc' } })).map(mapProjectRepository);
    });
  }

  /** The project's repositories as the rest of the server reads them: see `effectiveRepos`. */
  async effective(projectId: string, setup: ProjectSetupData): Promise<EffectiveRepo[]> {
    return effectiveRepos(setup, await this.listByProject(projectId));
  }
}
