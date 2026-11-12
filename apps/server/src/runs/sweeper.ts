import { removeWorkspace } from '../automation/branches.js';
import type { ApiRun } from '../db/repositories/api-runs.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { localeOf, t, tk } from '../i18n/index.js';

/**
 * Housekeeping of the personal runs API (TER-1176, spec "Workspace" and "Normalized events"), hourly:
 *
 * - events older than 7 days are deleted (the run rows stay, with status and usage);
 * - the worktree of an edit run that ended more than 24 h ago is removed from its machine — only the ones
 *   `api_runs` points at, never an automation worktree. A worktree with changes nobody committed is kept
 *   by the agent (`dirty`) and tried again on the next sweep;
 * - a run still `queued`/`running` that no process holds and that is past its own timeout (the server
 *   crashed, or was killed before it could end it) ends `failed`.
 */

export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const WORKTREE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** A run is an orphan once this long past its own timeout with nobody holding it. */
export const ORPHAN_GRACE_MS = 5 * 60 * 1000;
export const SWEEP_EVERY_MS = 60 * 60 * 1000;

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export interface RunSweeperDeps {
  repos: Pick<Repositories, 'apiRuns' | 'machines' | 'projectMachines' | 'projectSetup' | 'users'>;
  log: Log;
  /** Whether this process holds the run now (`RunService.holds`). */
  holds: (runId: string) => boolean;
  /** Whether this color sweeps now (a draining one does not). */
  active?: () => boolean;
  remove?: (machine: Machine, i: { repoDir: string; root: string; path: string }) => Promise<{ removed: boolean; dirty: boolean }>;
  now?: () => Date;
}

export interface SweepResult {
  events: number;
  worktrees: number;
  orphans: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : 'unknown';
}

export async function sweepRuns(deps: RunSweeperDeps): Promise<SweepResult> {
  const { repos, log } = deps;
  const now = deps.now?.() ?? new Date();
  const out: SweepResult = { events: 0, worktrees: 0, orphans: 0 };

  out.events = await repos.apiRuns.deleteEventsBefore(new Date(now.getTime() - EVENT_RETENTION_MS));

  for (const run of await repos.apiRuns.listActive()) {
    if (deps.holds(run.id)) continue;
    const since = Date.parse(run.started_at ?? run.created_at);
    if (now.getTime() - since < run.timeout_ms + ORPHAN_GRACE_MS) continue;
    const user = await repos.users.findById(run.user_id).catch(() => undefined);
    const message = t(localeOf(user?.locale), tk('O servidor reiniciou'));
    if (await repos.apiRuns.finishActive(run.id, { status: 'failed', error_code: 'cli_failed', error_message: message, ended_at: now })) {
      await repos.apiRuns.appendEvents(run.id, [
        { type: 'error', payload: { code: 'cli_failed', message } },
        { type: 'done', payload: { status: 'failed', result: null, usage: null } },
      ]);
      out.orphans += 1;
    }
  }

  const remove = deps.remove ?? removeWorkspace;
  for (const run of await repos.apiRuns.listWorktreesEndedBefore(new Date(now.getTime() - WORKTREE_RETENTION_MS))) {
    if (await removeRunWorktree(deps, remove, run, now)) out.worktrees += 1;
  }

  if (out.events || out.worktrees || out.orphans) log.info({ ...out }, 'api runs: swept');
  return out;
}

async function removeRunWorktree(deps: RunSweeperDeps, remove: NonNullable<RunSweeperDeps['remove']>, run: ApiRun, now: Date): Promise<boolean> {
  const { repos, log } = deps;
  const ws = run.workspace;
  if (!ws || ws.kind !== 'worktree' || !run.machine_id) return false;
  const gone = () => repos.apiRuns.setStatus(run.id, { workspace: { ...ws, removed_at: now.toISOString() } });
  const [machine, link, setup] = await Promise.all([
    repos.machines.findById(run.machine_id),
    repos.projectMachines.find(run.project_id, run.machine_id),
    repos.projectSetup.get(run.project_id),
  ]);
  // The machine or its link to the project went away: there is nothing termhub can still reach.
  if (!machine || !link) {
    await gone();
    return false;
  }
  try {
    const r = await remove(machine, { repoDir: link.cwd, root: setup.data.automation.worktrees_dir, path: ws.path });
    if (r.dirty) {
      log.info({ runId: run.id, machineId: machine.id }, 'api runs: worktree kept (uncommitted changes)');
      return false;
    }
    await gone();
    return r.removed;
  } catch (err) {
    // Offline or outdated: the next sweep tries again.
    log.warn({ runId: run.id, machineId: machine.id, err: errorText(err) }, 'api runs: worktree not removed');
    return false;
  }
}

/** Runs the sweep every hour (first one a minute after boot); returns the stop function. */
export function startRunSweeper(deps: RunSweeperDeps, everyMs = SWEEP_EVERY_MS): () => void {
  const tick = () => {
    if (deps.active && !deps.active()) return;
    void sweepRuns(deps).catch((err: unknown) => deps.log.warn({ err: errorText(err) }, 'api runs: sweep failed'));
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, everyMs);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
