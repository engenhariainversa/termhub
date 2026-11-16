import type { EffectiveRepo } from '../setup/repos.js';

/** Why a card of a multi-repo project cannot run yet because of its repositories (spec 2026-10-07 multi-repo §9). */
export type RepoReason =
  /** the card names no repository: the chat is woken to pick them (R9 b) */
  | 'repo_unknown'
  /** the key is gone from the project, or the person turned it off in Setup */
  | 'repo_disabled'
  /** the project's GitHub integration cannot read it, or it is not on GitHub */
  | 'repo_no_access'
  /** it has no GitHub integration (the single-repo reason, same text) */
  | 'repo_missing'
  /** no capable machine of the project answers `git.repos.scan` (agent below 0.29) */
  | 'agent_no_repo_scan'
  /** no machine linked to the project has a checkout of it */
  | 'repo_not_on_machine';

export interface RepoBlock {
  reason: RepoReason;
  /** the key the reason is about, when it is about one */
  repo?: string;
}

/**
 * Whether every repository of a card is ready for a run (spec §9: `repo_ready` = "every repo of the card is
 * ready"), and otherwise the first thing missing. Only for a multi-repo project (`isMultiRepo`): a single-repo
 * project keeps the project-wide `repo_missing` check. `linkedMachines`: the ids of the machines linked to the
 * project (a checkout left by an unlinked machine does not count); `repoScan`: some capable machine of the
 * project answers `git.repos.scan`, so where a repository sits is known.
 */
export function cardRepoBlock(keys: readonly string[], repos: readonly EffectiveRepo[], linkedMachines: ReadonlySet<string>, repoScan: boolean): RepoBlock | null {
  if (keys.length === 0) return { reason: 'repo_unknown' };
  const cardRepos: EffectiveRepo[] = [];
  for (const key of new Set(keys)) {
    const repo = repos.find((r) => r.key === key);
    if (!repo || !repo.enabled) return { reason: 'repo_disabled', repo: key };
    if (repo.status !== 'ok') return { reason: 'repo_no_access', repo: key };
    if (!repo.integration_id) return { reason: 'repo_missing', repo: key };
    cardRepos.push(repo);
  }
  if (!repoScan) return { reason: 'agent_no_repo_scan' };
  // a workspace run (outline Task 12) works on one machine: some linked machine must hold every repository
  const holds = (machineId: string, repo: EffectiveRepo) => repo.checkouts.some((c) => c.machine_id === machineId && c.missing_at === null);
  if ([...linkedMachines].some((m) => cardRepos.every((r) => holds(m, r)))) return null;
  const missing = cardRepos.find((r) => ![...linkedMachines].some((m) => holds(m, r))) ?? cardRepos[cardRepos.length - 1]!;
  return { reason: 'repo_not_on_machine', repo: missing.key! };
}
