import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

export type PrState = 'open' | 'closed' | 'merged';
export type CiState = 'none' | 'running' | 'passed' | 'failed';
export interface CiSummary { total: number; passed: number; failed: number; running: number; failing: string[] }
export interface PullRequestInfo {
  repo: string;
  number: number;
  url: string;
  title: string;
  head_ref: string;
  head_sha: string;
  /** the PR's base branch; null on rows synced before it was stored */
  base_ref: string | null;
  state: PrState;
  draft: boolean;
  merged_at: Date | null;
  merge_commit_sha: string | null;
}
/** One release workflow's run on the merge commit (agentic board D22); `version` only for an npm publisher. */
export interface ReleaseRun { workflow: string; state: CiState; url: string | null; version: string | null }
export interface TaskPullRequest extends PullRequestInfo {
  id: string;
  project_id: string;
  task_id: string;
  ci_state: CiState;
  ci_summary: CiSummary;
  deploy_state: CiState;
  deploy_url: string | null;
  release_runs: ReleaseRun[];
  changed_level: string | null;
  synced_at: string;
}

/** A merged PR stays watched this long, for its deploy run. */
export const WATCH_MERGED_FOR_MS = 24 * 3600_000;
const EMPTY_SUMMARY: CiSummary = { total: 0, passed: 0, failed: 0, running: 0, failing: [] };

type Row = Awaited<ReturnType<PrismaClient['taskPullRequest']['findFirstOrThrow']>>;
const map = (r: Row): TaskPullRequest => ({
  id: r.id,
  project_id: r.projectId,
  task_id: r.taskId,
  repo: r.repo,
  number: r.number,
  url: r.url,
  title: r.title,
  head_ref: r.headRef,
  head_sha: r.headSha,
  base_ref: r.baseRef,
  state: r.state as PrState,
  draft: r.draft,
  merged_at: r.mergedAt,
  merge_commit_sha: r.mergeCommitSha,
  ci_state: r.ciState as CiState,
  ci_summary: { ...EMPTY_SUMMARY, ...(r.ciSummary as Partial<CiSummary>) },
  deploy_state: r.deployState as CiState,
  deploy_url: r.deployUrl,
  release_runs: (Array.isArray(r.releaseRuns) ? r.releaseRuns : []) as unknown as ReleaseRun[],
  changed_level: r.changedLevel,
  synced_at: r.syncedAt.toISOString(),
});

const prFields = (pr: PullRequestInfo) => ({
  url: pr.url,
  title: pr.title,
  headRef: pr.head_ref,
  headSha: pr.head_sha,
  baseRef: pr.base_ref,
  state: pr.state,
  draft: pr.draft,
  mergedAt: pr.merged_at,
  mergeCommitSha: pr.merge_commit_sha,
  syncedAt: new Date(),
});

export class TaskPullRequestsRepository {
  constructor(private db: PrismaClient) {}

  /** The PR's rows become exactly `taskIds`: upserted (CI fields kept), the others deleted. */
  async replaceLinks(projectId: string, pr: PullRequestInfo, taskIds: string[]): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.taskPullRequest.deleteMany({ where: { projectId, repo: pr.repo, number: pr.number, taskId: { notIn: taskIds } } });
      for (const taskId of taskIds) {
        await tx.taskPullRequest.upsert({
          where: { taskId_repo_number: { taskId, repo: pr.repo, number: pr.number } },
          create: { id: newId(), projectId, taskId, repo: pr.repo, number: pr.number, ...prFields(pr) },
          update: prFields(pr),
        });
      }
    });
  }

  async updateCi(projectId: string, repo: string, number: number, fields: { ci_state?: CiState; ci_summary?: CiSummary; deploy_state?: CiState; deploy_url?: string | null; release_runs?: ReleaseRun[] }): Promise<void> {
    await this.db.taskPullRequest.updateMany({
      where: { projectId, repo, number },
      data: {
        ...(fields.ci_state ? { ciState: fields.ci_state } : {}),
        ...(fields.ci_summary ? { ciSummary: fields.ci_summary as object } : {}),
        ...(fields.deploy_state ? { deployState: fields.deploy_state } : {}),
        ...(fields.deploy_url !== undefined ? { deployUrl: fields.deploy_url } : {}),
        ...(fields.release_runs ? { releaseRuns: fields.release_runs as unknown as object } : {}),
        syncedAt: new Date(),
      },
    });
  }

  /** The level the merge executor computed for the PR's files (spec D6): `pr`…`release`, or `store`. */
  async setChangedLevel(projectId: string, repo: string, number: number, level: string): Promise<void> {
    await this.db.taskPullRequest.updateMany({ where: { projectId, repo, number }, data: { changedLevel: level } });
  }

  async listByTasks(taskIds: string[]): Promise<TaskPullRequest[]> {
    if (taskIds.length === 0) return [];
    return (await this.db.taskPullRequest.findMany({ where: { taskId: { in: taskIds } }, orderBy: [{ number: 'desc' }] })).map(map);
  }

  /**
   * Open PRs of the setup's current repo, and (when a deploy workflow is set: `includeMerged`) its PRs merged
   * less than a day ago whose deploy is not passed/failed yet. Rows of a previous repo are never watched.
   */
  async listWatched(projectId: string, opts: { repo: string; includeMerged: boolean; releases?: boolean }, now = new Date()): Promise<TaskPullRequest[]> {
    // `releases`: a finished deploy no longer ends the watch; the caller decides from the release runs (JSON) whether any is still pending
    const merged = { state: 'merged', mergedAt: { gt: new Date(now.getTime() - WATCH_MERGED_FOR_MS) }, ...(opts.releases ? {} : { deployState: { in: ['none', 'running'] } }) };
    const rows = await this.db.taskPullRequest.findMany({
      where: {
        projectId,
        repo: opts.repo,
        OR: [{ state: 'open' }, ...(opts.includeMerged ? [merged] : [])],
      },
      orderBy: [{ number: 'desc' }],
    });
    return rows.map(map);
  }
}
