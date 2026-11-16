import type { Repositories } from '../db/repositories/index.js';
import type { Project } from '../db/repositories/types.js';
import type { ProjectSetupData } from '../setup/schema.js';
import type { RepoEntry } from './repo-entry.js';

/**
 * A repository's GitHub token, under the CI sync's rule: a GitHub integration of the project's owner. The
 * integration is the repository entry's (spec 2026-10-07 multi-repo R7), else the project's `setup.repo`
 * one (TER-1071: discovered repositories of the same owner read with it).
 */
export async function githubAccess(
  repos: Repositories,
  project: Project,
  setup: ProjectSetupData,
  entry: Pick<RepoEntry, 'full_name' | 'integration_id'> | null,
): Promise<{ token: string; repo: string } | null> {
  const integrationId = entry?.integration_id ?? setup.repo?.integration_id ?? null;
  if (!entry?.full_name || !integrationId) return null;
  const integration = await repos.integrations.findById(integrationId);
  if (!integration || integration.provider !== 'github' || project.owner_id === null || integration.owner_id !== project.owner_id) return null;
  const token = await repos.integrations.getSecret(integration.id);
  return token ? { token, repo: entry.full_name } : null;
}
