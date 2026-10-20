import type { ProjectSetupData } from '../setup/schema.js';

/**
 * The repository the project's automatic runs work on (spec 2026-10-07 multi-repo R14): its single
 * repository for now, `setup.repo.full_name`. Null when Setup names none.
 */
export const runRepoOf = (setup: Pick<ProjectSetupData, 'repo'>): string | null => setup.repo?.full_name || null;

/** Whether a PR's repository is the run's. GitHub names are case-insensitive. With no project repository
 *  there is nothing to tell two PRs apart, and every one passes. */
export const inRunRepo = (runRepo: string | null, repo: string): boolean => !runRepo || repo.toLowerCase() === runRepo.toLowerCase();

/** Whether a PR is the head of one of these run branches, in the run's repository: two repositories can each
 *  have a `TER-12-x` branch, and only one of them is the run's. */
export const isRunHead = (runRepo: string | null, branches: readonly string[], pr: { repo: string; head_ref: string }): boolean =>
  branches.includes(pr.head_ref) && inRunRepo(runRepo, pr.repo);
