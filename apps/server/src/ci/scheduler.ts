import { activeEntries, loadRepoEntries } from '../automation/repo-entry.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { createGithubCiClient, GithubCiError, type GithubCiClient } from '../integrations/github-ci.js';
import { githubHealth, type GithubHealthReader } from '../integrations/github-status.js';
import { CI_POLL_MS } from './poll.js';
import { syncProjectCi } from './sync.js';

export { CI_POLL_MS };
/** A rate-limited project without a reset time waits this long. */
const DEFAULT_PAUSE_MS = 15 * 60_000;

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
export interface CiTickState { etags: Map<string, string>; pausedUntil: Map<string, number> }

/** Whether any repository the project's automation works on has a watched PR: open, or merged with a deploy to follow (multi-repo R17). */
async function hasWatched(repos: Repositories, projectId: string, setup: ProjectSetupData, now: Date): Promise<boolean> {
  for (const e of activeEntries(await loadRepoEntries(repos, projectId, setup))) {
    if ((await repos.taskPullRequests.listWatched(projectId, { repo: e.full_name, includeMerged: !!e.deploy_workflow }, now)).length > 0) return true;
  }
  return false;
}

/** One pass: every project with a repository and work in progress (a card in doing, or a watched PR in one of its repositories). */
export async function ciTick(deps: { repos: Repositories; github: GithubCiClient; log: Log; now?: () => Date; merge?: (projectId: string) => Promise<void>; githubHealth?: GithubHealthReader }, state: CiTickState): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const projects = await deps.repos.projectSetup.listWithRepo().catch(() => []);
  for (const { project_id: projectId, data } of projects) {
    if ((state.pausedUntil.get(projectId) ?? 0) > now.getTime()) continue;
    try {
      const busy = (await deps.repos.tasks.hasDoing(projectId)) || (await hasWatched(deps.repos, projectId, data, now));
      if (!busy) continue;
      await syncProjectCi({ repos: deps.repos, github: deps.github, etags: state.etags, now: () => now, merge: deps.merge, githubHealth: deps.githubHealth, log: deps.log }, projectId);
    } catch (e) {
      if (e instanceof GithubCiError && e.kind === 'rate_limited') state.pausedUntil.set(projectId, e.resetAt?.getTime() ?? now.getTime() + DEFAULT_PAUSE_MS);
      deps.log.warn({ projectId, err: (e as Error).message }, 'ci sync failed');
    }
  }
}

/** The CI panel's poll (spec 2026-09-26 progress-panel D11); both colours may run it during a switch — writes are idempotent. */
export function startCiSyncScheduler(
  repos: Repositories,
  log: Log,
  github: GithubCiClient = createGithubCiClient(),
  opts: { merge?: (projectId: string) => Promise<void> } = {},
): () => void {
  const state: CiTickState = { etags: new Map(), pausedUntil: new Map() };
  let running = false;
  const tick = async () => {
    if (running) return; // a slow GitHub never stacks passes
    running = true;
    try {
      await ciTick({ repos, github, log, merge: opts.merge, githubHealth }, state);
    } finally {
      running = false;
    }
  };
  // Never an unhandled rejection: Node exits the server on one.
  const run = () => void tick().catch((e: unknown) => log.warn({ err: (e as Error).message }, 'ci tick failed'));
  const timer = setInterval(run, CI_POLL_MS);
  const first = setTimeout(run, 10_000);
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
