import type { AutomationAutonomy, EffectiveRepo, RepoOverride } from './types';

/** `owner/repo` is compared without case, as GitHub does (server `sameRepo`). */
export const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const LEVELS: AutomationAutonomy[] = ['pr', 'merge', 'deploy', 'release'];

/** The levels a repository may take: never above the project's (spec 2026-10-07 multi-repo R7). */
export const levelsUpTo = (ceiling: AutomationAutonomy): AutomationAutonomy[] => LEVELS.slice(0, LEVELS.indexOf(ceiling) + 1);

/**
 * The Setup shows the "Repositórios" table only with more than one repository (TER-1072): a project whose
 * list is the single entry from `setup.repo`, or one discovered checkout, keeps the old block.
 */
export const showRepoTable = (effective: EffectiveRepo[] | undefined): effective is EffectiveRepo[] => (effective?.length ?? 0) > 1;

/**
 * The person's override of a repository, or a new one seeded from what the repository does now: level,
 * checks, globs, deploy and merge order as shown, and null for the fields that fall back (integration,
 * description, base, branch pattern), so creating an override by editing one field changes only that field.
 */
export function overrideFor(entry: EffectiveRepo, overrides: RepoOverride[]): RepoOverride {
  const own = overrides.find((o) => sameRepo(o.full_name, entry.full_name));
  if (own) return own;
  return {
    full_name: entry.full_name,
    enabled: entry.enabled,
    integration_id: null,
    description: null,
    base_branch: null,
    branch_pattern: null,
    deploy_workflow: entry.deploy_workflow,
    autonomy: entry.autonomy,
    required_checks: [...entry.required_checks],
    release_workflows: [...entry.release_workflows],
    release_paths: [...entry.release_paths],
    store_paths: [...entry.store_paths],
    merge_order: entry.merge_order,
  };
}

/** The overrides with this repository's changed (appended when it had none). */
export function setOverride(overrides: RepoOverride[], entry: EffectiveRepo, patch: Partial<RepoOverride>): RepoOverride[] {
  const next = { ...overrideFor(entry, overrides), ...patch, full_name: entry.full_name };
  const i = overrides.findIndex((o) => sameRepo(o.full_name, entry.full_name));
  return i < 0 ? [...overrides, next] : overrides.map((o, j) => (j === i ? next : o));
}

/** "Restaurar padrão": the repository goes back to what discovery and the project give it. */
export const dropOverride = (overrides: RepoOverride[], fullName: string): RepoOverride[] => overrides.filter((o) => !sameRepo(o.full_name, fullName));

/** What the table shows for a repository: the override being edited, else what the server answered. */
export function shownRepo(entry: EffectiveRepo, overrides: RepoOverride[]): EffectiveRepo {
  const o = overrides.find((x) => sameRepo(x.full_name, entry.full_name));
  if (!o) return entry;
  return {
    ...entry,
    enabled: o.enabled,
    integration_id: o.integration_id ?? entry.integration_id,
    description: o.description ?? entry.description,
    base_branch: o.base_branch ?? entry.base_branch,
    branch_pattern: o.branch_pattern ?? entry.branch_pattern,
    deploy_workflow: o.deploy_workflow,
    autonomy: o.autonomy,
    required_checks: o.required_checks,
    release_workflows: o.release_workflows,
    release_paths: o.release_paths,
    store_paths: o.store_paths,
    merge_order: o.merge_order,
  };
}
