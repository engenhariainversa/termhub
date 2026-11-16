import type { EffectiveRepo } from '../setup/repos.js';

/** Why a card of a multi-repo project cannot run yet because of its repositories (spec 2026-10-07 multi-repo §9). */
export type RepoReason =
  /** the card names no repository: the chat is woken to pick them (R9 b) */
  | 'repo_unknown'
  /** several repositories: workspace runs come later (outline Task 12 lifts it) */
  | 'repo_multi_soon'
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
  if (keys.length > 1) return { reason: 'repo_multi_soon' };
  const key = keys[0]!;
  const repo = repos.find((r) => r.key === key);
  if (!repo || !repo.enabled) return { reason: 'repo_disabled', repo: key };
  if (repo.status !== 'ok') return { reason: 'repo_no_access', repo: key };
  if (!repo.integration_id) return { reason: 'repo_missing', repo: key };
  if (!repoScan) return { reason: 'agent_no_repo_scan' };
  if (!repo.checkouts.some((c) => c.missing_at === null && linkedMachines.has(c.machine_id))) return { reason: 'repo_not_on_machine', repo: key };
  return null;
}
