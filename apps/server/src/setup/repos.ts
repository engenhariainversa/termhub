import type { ProjectRepository, ProjectRepositoryCheckout, RepoStatus } from '../db/repositories/types.js';
import { AUTONOMY_LEVELS, REPOS_MAX, sameRepo, type AutonomyLevel, type ProjectSetupData, type RepoOverride } from './schema.js';

/** The key of the checkout at the project's folder itself, and of `setup.repo` before discovery ran (spec 2026-10-07 multi-repo R4, R19). */
export const LEGACY_REPO_KEY = 'main';

const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_BRANCH_PATTERN = '{ticket}-{slug}';
const KEY_MAX = 64;
const FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

/** One repository of a project as the rest of the server should read it: discovery, the person's override and the defaults merged. */
export interface EffectiveRepo {
  /** owner/repo */
  full_name: string;
  /** null: added by hand, and discovery has not named it yet */
  key: string | null;
  discovered: boolean;
  has_override: boolean;
  /** `ok` while not discovered */
  status: RepoStatus;
  enabled: boolean;
  integration_id: string | null;
  description: string | null;
  base_branch: string;
  branch_pattern: string;
  draft_pr: boolean;
  deploy_workflow: string | null;
  /** never above the project's */
  autonomy: AutonomyLevel;
  required_checks: string[];
  release_workflows: string[];
  release_paths: string[];
  store_paths: string[];
  merge_order: number;
  checkouts: ProjectRepositoryCheckout[];
}

const lowest = (a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel => AUTONOMY_LEVELS[Math.min(AUTONOMY_LEVELS.indexOf(a), AUTONOMY_LEVELS.indexOf(b))]!;

function byOrder(a: EffectiveRepo, b: EffectiveRepo): number {
  if (a.merge_order !== b.merge_order) return a.merge_order - b.merge_order;
  if (a.key !== b.key) {
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    return a.key < b.key ? -1 : 1;
  }
  const [x, y] = [a.full_name.toLowerCase(), b.full_name.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The project's repositories (spec 2026-10-07 multi-repo R1): every discovered one, plus the ones the person
 * named by hand (`setup.repo` and the overrides) that discovery has not seen yet. Each entry is merged with
 * its override and the defaults, and its level is clamped to the project's (R7).
 *
 * `setup.repo` is the override of the repository it names (§3.1): that repo keeps the project-wide policy
 * until it gets an entry in `repos`, and every other repository starts at `pr` with no checks or globs (R6).
 * With nothing discovered, `setup.repo` is the entry of key `main` (R19).
 */
export function effectiveRepos(setup: ProjectSetupData, discovered: ProjectRepository[]): EffectiveRepo[] {
  const legacy = setup.repo?.full_name ? setup.repo : null;
  const project = setup.automation;
  const names: string[] = [];
  for (const name of [...discovered.map((r) => r.full_name), ...(legacy ? [legacy.full_name!] : []), ...setup.repos.map((o) => o.full_name)]) {
    if (!names.some((n) => sameRepo(n, name))) names.push(name);
  }
  const list = names.map((name): EffectiveRepo => {
    const row = discovered.find((r) => sameRepo(r.full_name, name));
    const o = setup.repos.find((r) => sameRepo(r.full_name, name));
    const own = legacy && sameRepo(legacy.full_name, name) ? legacy : null;
    const seenBranch = row?.checkouts.find((c) => !c.missing_at && c.default_branch)?.default_branch ?? null;
    const policy = o ?? (own ? project : null);
    return {
      full_name: name,
      key: row?.key ?? (own && discovered.length === 0 ? LEGACY_REPO_KEY : null),
      discovered: !!row,
      has_override: !!o,
      status: row?.status ?? 'ok',
      enabled: o?.enabled ?? true,
      integration_id: o?.integration_id ?? own?.integration_id ?? setup.repo_defaults.integration_id,
      description: o?.description ?? row?.description ?? null,
      base_branch: o?.base_branch ?? own?.base_branch ?? seenBranch ?? DEFAULT_BASE_BRANCH,
      // the project's pattern is the one in the repo block
      branch_pattern: o?.branch_pattern ?? setup.repo?.branch_pattern ?? DEFAULT_BRANCH_PATTERN,
      draft_pr: setup.repo?.draft_pr ?? true,
      deploy_workflow: o?.deploy_workflow ?? own?.deploy_workflow ?? null,
      autonomy: policy ? lowest(policy.autonomy, project.autonomy) : 'pr',
      required_checks: [...(policy?.required_checks ?? [])],
      release_workflows: [...(policy?.release_workflows ?? [])],
      release_paths: [...(policy?.release_paths ?? [])],
      store_paths: [...(policy?.store_paths ?? [])],
      merge_order: o?.merge_order ?? 0,
      checkouts: row?.checkouts ?? [],
    };
  });
  return list.sort(byOrder);
}

/** The override that states an entry's values outright, so they no longer depend on `setup.repo`. */
function pinned(e: EffectiveRepo, o: RepoOverride | undefined): RepoOverride {
  return {
    full_name: e.full_name,
    enabled: e.enabled,
    integration_id: e.integration_id,
    description: o?.description ?? null,
    base_branch: e.base_branch,
    branch_pattern: e.branch_pattern,
    deploy_workflow: e.deploy_workflow,
    autonomy: e.autonomy,
    required_checks: e.required_checks,
    release_workflows: e.release_workflows,
    release_paths: e.release_paths,
    store_paths: e.store_paths,
    merge_order: e.merge_order,
  };
}

/**
 * `repo` = the first enabled repository (lowest `merge_order`), so the previous release, which only knows
 * `repo`, keeps working on it (spec 2026-10-07 multi-repo R19). A project with nothing discovered and no
 * override is returned as given.
 *
 * On a tie the repository already in `repo` stays, so a first scan never moves it. When it does move, the
 * repository leaving `repo` and the one entering it get an override stating their values: the one in `repo`
 * reads the project-wide policy, and neither may lose or gain a level by changing places. With no enabled
 * repository left, `repo` is kept as it is.
 */
export function withRepoMirror(setup: ProjectSetupData, discovered: ProjectRepository[]): ProjectSetupData {
  if (discovered.length === 0 && setup.repos.length === 0) return setup;
  const list = effectiveRepos(setup, discovered);
  const isCurrent = (e: EffectiveRepo) => sameRepo(e.full_name, setup.repo?.full_name);
  const target = list
    .filter((e) => e.enabled && e.status === 'ok' && FULL_NAME_RE.test(e.full_name))
    .sort((a, b) => a.merge_order - b.merge_order || Number(isCurrent(b)) - Number(isCurrent(a)))[0];
  if (!target) return setup;
  let repos = setup.repos;
  if (!isCurrent(target)) {
    const moving = [list.find(isCurrent), target].filter((e): e is EffectiveRepo => !!e);
    const kept = repos.filter((o) => !moving.some((e) => sameRepo(e.full_name, o.full_name)));
    const stated = moving.map((e) => pinned(e, repos.find((o) => sameRepo(o.full_name, e.full_name))));
    if (kept.length + stated.length > REPOS_MAX) return setup;
    repos = [...kept, ...stated];
  }
  return {
    ...setup,
    repos,
    repo: {
      integration_id: target.integration_id,
      full_name: target.full_name,
      base_branch: target.base_branch,
      branch_pattern: target.branch_pattern,
      // a project-wide rule, not a per-repo one: it stays as the person set it
      require_ticket: setup.repo?.require_ticket ?? false,
      draft_pr: target.draft_pr,
      deploy_workflow: target.deploy_workflow,
    },
  };
}

/**
 * The key discovery gives a checkout (spec 2026-10-07 multi-repo R4): `main` for the project's folder itself,
 * else the folder's base name, slugged. Only `[a-z0-9._-]`, never empty, no `/` and no `..`, so it is safe
 * as a path segment.
 */
export function repoKeyFor(dir: string): string {
  const path = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (path === '' || path === '.') return LEGACY_REPO_KEY;
  const slug = path
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-._]+/, '')
    .slice(0, KEY_MAX)
    .replace(/[-._]+$/, '');
  return slug || 'repo';
}

/** `base`, or `base-2`, `base-3`… when another repository of the project already has it. */
export function uniqueRepoKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const key = `${base.slice(0, KEY_MAX - suffix.length)}${suffix}`;
    if (!used.has(key)) return key;
  }
}
