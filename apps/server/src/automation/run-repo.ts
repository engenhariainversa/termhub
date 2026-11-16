import path from 'node:path';
import { ControlError } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ProjectRepository } from '../db/repositories/types.js';
import { msg } from '../i18n/index.js';
import { isMultiRepo } from '../setup/repo-keys.js';
import { effectiveRepos, type EffectiveRepo } from '../setup/repos.js';
import { normalizeSetup, sameRepo, SETUP_VERSION, type ProjectSetupData } from '../setup/schema.js';
import { activeEntries, runEntry } from './repo-entry.js';

/*
 * The repository a run works in (spec 2026-10-07 multi-repo R5, R11, §7; outline Task 11). A run works in the
 * checkout of its card's repository on the chosen machine, not in the folder of the project/machine link, so
 * a link pointing at a parent folder that holds several repositories works. A single-repo project reads the
 * same folder, base and pattern as before: its checkout is the link's folder (`.`).
 */

/** The fields of `setup.repo` the branch name reads (`implementerBranchOf`). */
export interface BranchRepo {
  branch_pattern: string;
  base_branch: string;
  require_ticket: boolean;
}

export interface RunRepo {
  /** The repository's entry; null = a project with no repository named at all (the link's folder and `setup.repo`, as before). */
  entry: EffectiveRepo | null;
  /** Its `project_repositories` id; null while discovery has not stored it (the run then gets no `automation_run_repos` row). */
  repositoryId: string | null;
  /** More than one enabled repository in the project (R8): only then does a checkout row decide where it is. */
  multi: boolean;
  /** The base branch and naming the card's branch reads. */
  branch: BranchRepo | null;
  /**
   * A workspace run (R11, outline Task 12): the card names two or more repositories, one `RunRepo` each, in
   * the card's order. The run itself reads the first one's naming, so the one branch name is the same in
   * every repository. Absent for a run in one repository.
   */
  members?: RunRepo[];
}

/** A member of a workspace run: always a discovered, keyed repository. */
export type MemberRepo = RunRepo & { entry: EffectiveRepo & { key: string } };

/** A setup read whole has every section; a partial one (a test's) is filled with the defaults first. */
const whole = (setup: ProjectSetupData): ProjectSetupData => (Array.isArray(setup.repos) && setup.repo_defaults ? setup : normalizeSetup(setup, SETUP_VERSION));

/**
 * The repository of a run whose card names `keys` (`tasks.repo_keys`). One key: that repository, which must be
 * enabled and readable. No key: the project's run repository (`runEntry`, the single one). Several keys: a
 * workspace run (R11), the first key's repository with every key's in `members`. Throws a ControlError with a
 * readable reason.
 */
export function pickRunRepo(setup: ProjectSetupData, rows: ProjectRepository[], keys: readonly string[]): RunRepo {
  const entries = effectiveRepos(whole(setup), rows);
  const multi = isMultiRepo(entries);
  const keyed = (key: string): RunRepo => {
    const entry = activeEntries(entries).find((e) => e.key === key) ?? null;
    if (!entry) throw new ControlError('REPO_UNAVAILABLE', msg('Repositório desligado ou removido no Setup'));
    return repoOf(setup, rows, entry, multi);
  };
  const unique = [...new Set(keys)];
  if (unique.length > 1) {
    const members = unique.map(keyed);
    return { ...members[0]!, members };
  }
  return unique.length === 1 ? keyed(unique[0]!) : repoOf(setup, rows, runEntry(entries, setup), multi);
}

function repoOf(setup: ProjectSetupData, rows: ProjectRepository[], entry: EffectiveRepo | null, multi: boolean): RunRepo {
  const repositoryId = entry ? (rows.find((r) => sameRepo(r.full_name, entry.full_name))?.id ?? null) : null;
  const branch: BranchRepo | null = entry
    ? { branch_pattern: entry.branch_pattern, base_branch: entry.base_branch, require_ticket: setup.repo?.require_ticket ?? false }
    : setup.repo
      ? { branch_pattern: setup.repo.branch_pattern, base_branch: setup.repo.base_branch, require_ticket: setup.repo.require_ticket }
      : null;
  return { entry, repositoryId, multi, branch };
}

/** The members of a workspace run, each with its key; empty for a run in one repository. */
export const membersOf = (repo: RunRepo | null | undefined): MemberRepo[] => (repo?.members ?? []).filter((m): m is MemberRepo => !!m.entry?.key);

/** `pickRunRepo` with the project's discovered repositories read from the database. */
export async function resolveRunRepo(repos: Repositories, projectId: string, setup: ProjectSetupData, keys: readonly string[]): Promise<RunRepo> {
  // a Repositories without the discovery table (a fake) reads the setup alone
  const rows: ProjectRepository[] = repos.projectRepositories ? await repos.projectRepositories.listByProject(projectId) : [];
  return pickRunRepo(setup, rows, keys);
}

/**
 * Where the run's repository sits under the project's folder on a machine (R5): the checkout's dir, `.` for
 * the folder itself. Null when the machine has no present checkout of it: the scan marked it missing, or, in a
 * multi-repo project, never saw it there. A single-repo project with no checkout row for the machine (an agent
 * that does not scan, or no scan yet) uses the folder itself, as before.
 */
export function checkoutDirOn(repo: RunRepo, machineId: string): string | null {
  if (repo.members) return memberDirsOn(repo, machineId)?.[0]?.dir ?? null;
  return ownDirOn(repo, machineId);
}

function ownDirOn(repo: RunRepo, machineId: string): string | null {
  if (!repo.entry || !repo.entry.discovered) return '.';
  const checkout = repo.entry.checkouts.find((c) => c.machine_id === machineId);
  if (checkout) return checkout.missing_at === null ? checkout.dir : null;
  return repo.multi ? null : '.';
}

/**
 * Where each repository of a workspace run sits under the project's folder on a machine, in the card's order;
 * null when the machine lacks any of them (a workspace run needs every one on the same machine, R5).
 */
export function memberDirsOn(repo: RunRepo, machineId: string): Array<{ key: string; dir: string }> | null {
  const out: Array<{ key: string; dir: string }> = [];
  for (const m of membersOf(repo)) {
    const dir = ownDirOn(m, machineId);
    if (dir === null) return null;
    out.push({ key: m.entry.key, dir });
  }
  return out;
}

/**
 * The repository keys of a workspace run, read back from its `automation_run_repos` rows: each worktree sits
 * at `<worktree>/<key>`. Empty for a run in one repository (its row's path is the worktree itself).
 */
export function runKeysOf(rows: ReadonlyArray<{ worktree_path: string }>, worktree: string | null): string[] {
  if (!worktree) return [];
  const root = worktree.replace(/\/+$/, '');
  const keys = rows.flatMap((r) => {
    const p = r.worktree_path.replace(/\/+$/, '');
    return path.posix.dirname(p) === root ? [path.posix.basename(p)] : [];
  });
  return [...new Set(keys)];
}

/** The checkout's folder on the machine: the link's folder itself for `.` (the same string as before), else joined. */
export function repoDirOf(cwd: string, dir: string): string {
  return dir === '.' || dir === '' ? cwd : path.posix.join(cwd, dir);
}

/** The base branch of a card that is not in an automatic epic: its repository's, else `setup.repo`'s. */
export const baseOf = (repo: RunRepo | null, setup: ProjectSetupData): string => repo?.branch?.base_branch ?? setup.repo?.base_branch ?? 'main';
