import type { PrismaClient } from '../prisma.js';

export type RunRepoState = 'ready' | 'pr_open' | 'no_changes' | 'removed';

/** One repository a run works on (spec 2026-10-07 multi-repo R11, §4). */
export interface AutomationRunRepo {
  run_id: string;
  repository_id: string;
  branch: string;
  base: string;
  worktree_path: string;
  state: RunRepoState;
  created_at: Date;
}

type Row = Awaited<ReturnType<PrismaClient['automationRunRepo']['findFirstOrThrow']>>;
const map = (r: Row): AutomationRunRepo => ({
  run_id: r.runId,
  repository_id: r.repositoryId,
  branch: r.branch,
  base: r.base,
  worktree_path: r.worktreePath,
  state: r.state as RunRepoState,
  created_at: r.createdAt,
});

/** The rows of `automation_run_repos`: written when a run's worktree exists, read by the cleanup. */
export class AutomationRunReposRepository {
  constructor(private db: PrismaClient) {}

  /** Adds a run's repository; a row already there (a retried start) keeps what it had. */
  async add(i: { run_id: string; repository_id: string; branch: string; base: string; worktree_path: string }): Promise<void> {
    await this.db.automationRunRepo.createMany({
      data: [{ runId: i.run_id, repositoryId: i.repository_id, branch: i.branch, base: i.base, worktreePath: i.worktree_path }],
      skipDuplicates: true,
    });
  }

  async listByRun(runId: string): Promise<AutomationRunRepo[]> {
    return (await this.db.automationRunRepo.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } })).map(map);
  }

  /** The final state of one repository of a run that ended done (spec 2026-10-07 multi-repo R14): `pr_open` or `no_changes`. */
  async setState(runId: string, repositoryId: string, state: RunRepoState): Promise<void> {
    await this.db.automationRunRepo.updateMany({ where: { runId, repositoryId }, data: { state } });
  }

  /** A fixer that takes over the card's tab works in the same worktrees (spec §7): it gets the old run's rows. */
  async copy(fromRunId: string, toRunId: string): Promise<number> {
    const rows = await this.db.automationRunRepo.findMany({ where: { runId: fromRunId } });
    if (rows.length === 0) return 0;
    const r = await this.db.automationRunRepo.createMany({
      data: rows.map((x) => ({ runId: toRunId, repositoryId: x.repositoryId, branch: x.branch, base: x.base, worktreePath: x.worktreePath, state: x.state })),
      skipDuplicates: true,
    });
    return r.count;
  }
}
