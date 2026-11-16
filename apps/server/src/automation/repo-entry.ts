import type { Repositories } from '../db/repositories/index.js';
import type { ProjectRepository } from '../db/repositories/types.js';
import { effectiveRepos, type EffectiveRepo } from '../setup/repos.js';
import { normalizeSetup, sameRepo, SETUP_VERSION, type ProjectSetupData } from '../setup/schema.js';

/*
 * The repository entry the delivery path reads (spec 2026-10-07 multi-repo R7, §8): a PR's base branch,
 * deploy workflow, level, required checks and globs come from its repository's entry in the project's
 * effective list, never from `setup.repo` alone. A single-repo project has one entry, built from `setup.repo`
 * and the project-wide `automation`, so it reads exactly what it read before.
 */

export type RepoEntry = Pick<
  EffectiveRepo,
  | 'full_name'
  | 'key'
  | 'enabled'
  | 'status'
  | 'integration_id'
  | 'base_branch'
  | 'deploy_workflow'
  | 'autonomy'
  | 'required_checks'
  | 'release_workflows'
  | 'release_paths'
  | 'store_paths'
  | 'merge_order'
>;

const FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

/** A setup read whole (`projectSetup.get`) has every section; a partial one is filled with the defaults first. */
const whole = (setup: ProjectSetupData): ProjectSetupData =>
  Array.isArray(setup.repos) && setup.repo_defaults && setup.automation?.release_paths ? setup : normalizeSetup(setup, SETUP_VERSION);

/** The project's repositories: discovery's rows merged with the setup (`effectiveRepos`). */
export async function loadRepoEntries(repos: Repositories, projectId: string, setup: ProjectSetupData): Promise<EffectiveRepo[]> {
  // a Repositories without the discovery table (a fake) reads the setup alone
  const rows: ProjectRepository[] = repos.projectRepositories ? await repos.projectRepositories.listByProject(projectId) : [];
  return effectiveRepos(whole(setup), rows);
}

/** The repositories the automation works on: enabled, readable and named `owner/repo`. */
export const activeEntries = <T extends RepoEntry>(list: T[]): T[] => list.filter((e) => e.enabled && e.status === 'ok' && FULL_NAME_RE.test(e.full_name));

export const entryFor = <T extends RepoEntry>(list: T[], repo: string | null | undefined): T | null => list.find((e) => sameRepo(e.full_name, repo)) ?? null;

/**
 * The repository the automatic runs work on today (spec R14 until the runs take the card's repositories):
 * the one in `setup.repo` (the mirror of the first enabled repository, R19), else the first active one.
 */
export function runEntry<T extends RepoEntry>(list: T[], setup: Pick<ProjectSetupData, 'repo'>): T | null {
  const active = activeEntries(list);
  return entryFor(active, setup.repo?.full_name) ?? active[0] ?? null;
}

/** A repository's entry read from the setup alone (a caller with no list at hand), else null. */
export function legacyEntry(setup: ProjectSetupData, repo: string | null | undefined): EffectiveRepo | null {
  const list = effectiveRepos(whole(setup), []);
  return entryFor(list, repo ?? setup.repo?.full_name);
}

/** Whether the project has more than one repository the automation works on (the policy text names them). */
export const isMultiRepo = (list: RepoEntry[]): boolean => activeEntries(list).length > 1;
