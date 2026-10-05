import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

export type RunRole = 'implementer' | 'integrator' | 'fixer';
export type RunStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'done' | 'blocked' | 'failed' | 'cancelled';

/** The statuses the partial unique index `automation_runs_one_active_per_task` covers: one per card. */
export const ACTIVE_RUN_STATUSES = ['queued', 'starting', 'running', 'waiting'] as const satisfies readonly RunStatus[];

export interface AutomationRun {
  id: string;
  project_id: string;
  /** null once the card is deleted (the sweep cancels such runs) */
  task_id: string | null;
  role: RunRole;
  status: RunStatus;
  waiting_reason: string | null;
  tab_id: string | null;
  machine_id: string | null;
  account_id: string | null;
  branch: string | null;
  worktree_path: string | null;
  resume_count: number;
  fix_count: number;
  /** the server instance (colour) driving the run */
  claimed_by: string;
  heartbeat_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
}

export type AutomationRunPatch = Partial<
  Pick<AutomationRun, 'status' | 'waiting_reason' | 'tab_id' | 'machine_id' | 'account_id' | 'branch' | 'worktree_path' | 'started_at' | 'ended_at'>
>;

/** An active run whose card was deleted, cancelled by the sweep: where its worktree may still be. */
export interface OrphanedRun {
  id: string;
  project_id: string;
  machine_id: string | null;
  worktree_path: string | null;
}

type Row = Awaited<ReturnType<PrismaClient['automationRun']['findFirstOrThrow']>>;
const map = (r: Row): AutomationRun => ({
  id: r.id,
  project_id: r.projectId,
  task_id: r.taskId,
  role: r.role as RunRole,
  status: r.status as RunStatus,
  waiting_reason: r.waitingReason,
  tab_id: r.tabId,
  machine_id: r.machineId,
  account_id: r.accountId,
  branch: r.branch,
  worktree_path: r.worktreePath,
  resume_count: r.resumeCount,
  fix_count: r.fixCount,
  claimed_by: r.claimedBy,
  heartbeat_at: r.heartbeatAt,
  started_at: r.startedAt,
  ended_at: r.endedAt,
  created_at: r.createdAt,
});

/** A raw `RETURNING *` row of automation_runs (snake_case columns). */
type RawRow = Omit<AutomationRun, 'role' | 'status'> & { role: string; status: string };
const mapRaw = (r: RawRow): AutomationRun => ({ ...r, role: r.role as RunRole, status: r.status as RunStatus });

const active = { in: [...ACTIVE_RUN_STATUSES] };

/**
 * The automatic runs (agentic board, spec D11). The database guarantees one active run per card, also
 * while two server colours run side by side during a deploy: `claim` returns null when another instance
 * got there first. Each instance refreshes `heartbeat_at` on its runs; a run whose heartbeat went stale
 * (its instance is gone) is taken over by exactly one survivor.
 */
export class AutomationRunsRepository {
  constructor(private db: PrismaClient) {}

  /** A new `queued` run on the card, or null when the card already has an active run ("already taken"). */
  async claim(i: { project_id: string; task_id: string; role: RunRole; instance: string }): Promise<AutomationRun | null> {
    try {
      const row = await this.db.automationRun.create({
        data: { id: newId(), projectId: i.project_id, taskId: i.task_id, role: i.role, status: 'queued', claimedBy: i.instance },
      });
      return map(row);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return null;
      throw e;
    }
  }

  /**
   * Writes the patch while `instance` still drives the run: after a takeover by another instance the row
   * is theirs, and this one's late writes are dropped. False when nothing was written.
   */
  async update(id: string, instance: string, patch: AutomationRunPatch): Promise<boolean> {
    const { count } = await this.db.automationRun.updateMany({
      where: { id, claimedBy: instance },
      data: {
        status: patch.status,
        waitingReason: patch.waiting_reason,
        tabId: patch.tab_id,
        machineId: patch.machine_id,
        accountId: patch.account_id,
        branch: patch.branch,
        worktreePath: patch.worktree_path,
        startedAt: patch.started_at,
        endedAt: patch.ended_at,
      },
    });
    return count === 1;
  }

  /**
   * Releases a claim that never started (no place for it, or the card changed after the claim): the row
   * goes away, so the card is free again and no event or history is left per tick. Only the claiming
   * instance releases, and only before the run started.
   */
  async release(id: string, instance: string): Promise<boolean> {
    const { count } = await this.db.automationRun.deleteMany({ where: { id, claimedBy: instance, status: { in: ['queued', 'starting'] } } });
    return count === 1;
  }

  async findById(id: string): Promise<AutomationRun | null> {
    const row = await this.db.automationRun.findUnique({ where: { id } });
    return row ? map(row) : null;
  }

  /** Increments the counter and returns its new value. */
  async bump(id: string, field: 'resume_count' | 'fix_count'): Promise<number> {
    const key = field === 'resume_count' ? 'resumeCount' : 'fixCount';
    const row = await this.db.automationRun.update({ where: { id }, data: { [key]: { increment: 1 } }, select: { resumeCount: true, fixCount: true } });
    return row[key];
  }

  /** Refreshes `heartbeat_at` on every active run this instance drives (the database's clock, like `takeOver`). */
  async heartbeat(instance: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "automation_runs" SET "heartbeat_at" = now()
      WHERE "claimed_by" = ${instance} AND "status" IN ('queued', 'starting', 'running', 'waiting')`;
  }

  /**
   * Moves the active runs whose heartbeat is older than `staleMs` to `instance`. Ages are measured on the
   * database's clock, the one `heartbeat` writes with, so two hosts with skewed clocks agree. One
   * conditional UPDATE: when two instances race, the second re-checks each row after the first committed,
   * sees the fresh heartbeat and skips it, so every run comes back to one caller only.
   */
  async takeOver(instance: string, staleMs: number): Promise<AutomationRun[]> {
    const rows = await this.db.$queryRaw<RawRow[]>`
      UPDATE "automation_runs" SET "claimed_by" = ${instance}, "heartbeat_at" = now()
      WHERE "status" IN ('queued', 'starting', 'running', 'waiting')
        AND "claimed_by" <> ${instance}
        AND "heartbeat_at" < now() - make_interval(secs => CAST(${staleMs / 1000} AS double precision))
      RETURNING *`;
    return rows.map(mapRaw);
  }

  async activeByTab(tabId: string): Promise<AutomationRun | null> {
    const row = await this.db.automationRun.findFirst({ where: { tabId, status: active }, orderBy: { createdAt: 'desc' } });
    return row ? map(row) : null;
  }

  async activeByProject(projectId: string): Promise<AutomationRun[]> {
    return (await this.db.automationRun.findMany({ where: { projectId, status: active }, orderBy: { createdAt: 'asc' } })).map(map);
  }

  async countActive(projectId: string): Promise<number> {
    return this.db.automationRun.count({ where: { projectId, status: active } });
  }

  /**
   * The sweep: active runs whose card was deleted (`task_id` nulled by the foreign key) become
   * `cancelled`. Returns where their worktrees are, so the dispatcher can remove the clean ones.
   */
  async cancelOrphaned(): Promise<OrphanedRun[]> {
    return this.db.$queryRaw<OrphanedRun[]>`
      UPDATE "automation_runs" SET "status" = 'cancelled', "ended_at" = now()
      WHERE "task_id" IS NULL AND "status" IN ('queued', 'starting', 'running', 'waiting')
      RETURNING "id", "project_id", "machine_id", "worktree_path"`;
  }
}
