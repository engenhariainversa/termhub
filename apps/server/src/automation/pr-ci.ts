import type { ControlContext } from '../control/context.js';
import { tk } from '../i18n/index.js';
import { createGithubCiClient, type GithubCiClient } from '../integrations/github-ci.js';
import type { ProjectAutomation } from '../setup/schema.js';
import { githubAccess } from './merge.js';

/**
 * Whether the project's repository runs CI on pull requests (TER-1114): termhub merges only a green CI, so
 * at merge level or above a repository with no workflow on `pull_request` leaves every PR waiting. Read from
 * the runs GitHub kept (a workflow that never ran on a PR counts as none); `unknown` without a GitHub
 * integration or when GitHub does not answer.
 */
export type PrCiState = 'present' | 'absent' | 'unknown';

/** What the Setup and `get_automation_policy` say when `needsPrCiWarning`. */
export const NO_PR_CI_TEXT = tk(
  'Nenhum workflow do repositório rodou em pull_request: o termhub não mescla sem CI verde, então os PRs vão ficar esperando. Adicione um workflow em pull_request ou use o nível PR.',
);

const PR_EVENTS = ['pull_request', 'pull_request_target'];
/** A workflow added to the repository shows up within this long. */
const TTL_MS = 10 * 60_000;
const cache = new Map<string, { state: 'present' | 'absent'; at: number }>();
let client: Pick<GithubCiClient, 'hasRunsFor'> | null = null;

export async function projectPrCi(ctx: ControlContext, projectId: string, gh?: Pick<GithubCiClient, 'hasRunsFor'>, now = Date.now()): Promise<PrCiState> {
  const { project } = await ctx.scoped.project(projectId);
  const setup = (await ctx.repos.projectSetup.get(project.id)).data;
  const access = await githubAccess(ctx.repos, project, setup);
  if (!access) return 'unknown';
  return repoPrCi(access.token, access.repo, gh ?? (client ??= createGithubCiClient()), now);
}

/** The same reading for a repository and token already in hand (the merge executor, TER-1188). */
export async function repoPrCi(token: string, repo: string, reader: Pick<GithubCiClient, 'hasRunsFor'>, now = Date.now()): Promise<PrCiState> {
  const hit = cache.get(repo);
  if (hit && now - hit.at < TTL_MS) return hit.state;
  try {
    let state: 'present' | 'absent' = 'absent';
    for (const event of PR_EVENTS) {
      if (await reader.hasRunsFor(token, repo, event)) {
        state = 'present';
        break;
      }
    }
    cache.set(repo, { state, at: now });
    return state;
  } catch {
    return 'unknown';
  }
}

/** Merge level or above with no CI on pull requests: nothing would be merged by itself, unless the project
 *  lets such PRs merge (TER-1188 `no_ci_merge`). */
export const needsPrCiWarning = (automation: Pick<ProjectAutomation, 'autonomy'> & Partial<Pick<ProjectAutomation, 'no_ci_merge'>>, state: PrCiState) =>
  state === 'absent' && automation.autonomy !== 'pr' && automation.no_ci_merge !== 'merge';

/** Tests only. */
export function resetPrCiCache(): void {
  cache.clear();
}
