import type { EffectiveRepo } from './repos.js';
import { sameRepo } from './schema.js';

/** At most this many repositories per card (spec 2026-10-07 multi-repo, outline Task 7). */
export const REPO_KEYS_MAX = 10;
/** Longest `owner/repo` or key a tool may name. */
export const REPO_REF_MAX = 200;

/**
 * A project with more than one enabled repository (spec R8). Only then does a card carry keys: in a project
 * with one repository, an empty list means that repository, so nothing is stored and nothing changes.
 */
export const isMultiRepo = (repos: EffectiveRepo[]): boolean => repos.filter((r) => r.enabled).length > 1;

export type RepoKeysProblem =
  | { code: 'TOO_MANY' }
  /** no repository of the project has this key or owner/repo */
  | { code: 'UNKNOWN'; repo: string }
  /** the person turned it off in Setup → Repositórios */
  | { code: 'DISABLED'; repo: string }
  /** named by hand in Setup, and discovery has not given it a key yet */
  | { code: 'NO_KEY'; repo: string };

/** One repository named by key (`api`) or by `owner/repo` (case does not matter, as on GitHub). */
function find(ref: string, repos: EffectiveRepo[]): EffectiveRepo | undefined {
  const r = ref.trim();
  if (r.includes('/')) return repos.find((e) => sameRepo(e.full_name, r));
  const key = r.toLowerCase();
  return repos.find((e) => e.key === key);
}

/**
 * The keys a card stores for `refs` (keys or `owner/repo`), checked against the project's effective
 * repositories: each one must exist, be enabled and have a key. Repeats count once; the result follows the
 * project's order (`effectiveRepos`), so the same set always reads the same. A single-repo project stores
 * `[]` even for a valid ref (R8: empty = the single repository, and a stored `main` would go stale once
 * discovery names the repository).
 */
export function resolveRepoKeys(refs: string[], repos: EffectiveRepo[]): { keys: string[] } | { problem: RepoKeysProblem } {
  const picked = new Set<EffectiveRepo>();
  for (const ref of refs) {
    const repo = find(ref, repos);
    if (!repo) return { problem: { code: 'UNKNOWN', repo: ref.trim() } };
    if (!repo.enabled) return { problem: { code: 'DISABLED', repo: repo.key ?? repo.full_name } };
    if (!repo.key) return { problem: { code: 'NO_KEY', repo: repo.full_name } };
    picked.add(repo);
  }
  if (picked.size > REPO_KEYS_MAX) return { problem: { code: 'TOO_MANY' } };
  if (!isMultiRepo(repos)) return { keys: [] };
  return { keys: repos.filter((r) => picked.has(r)).map((r) => r.key!) };
}
