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
  /** agent restarts after an exit (spec D15: one, then the run is blocked) */
  restart_count: number;
  /** the `--allowedTools` the agent was started with (preflight F-12); null on runs started before it was stored */
  allowed_tools: string[] | null;
  /** when something was last typed into the run's tab (a resume, a restart): read by whichever colour follows the run */
  last_typed_at: Date | null;
  /** when the chat was woken for a tab that keeps stopping (one wake per run); null = never */
  woken_at: Date | null;
  /** the PR head a server-started run answers (a conflict fixer, spike R2); null = a run from the queue */
  trigger_sha: string | null;
  /** the server instance (colour) driving the run */
  claimed_by: string;
  heartbeat_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
}

export type AutomationRunPatch = Partial<
  Pick<AutomationRun, 'status' | 'waiting_reason' | 'tab_id' | 'machine_id' | 'account_id' | 'branch' | 'worktree_path' | 'started_at' | 'ended_at' | 'allowed_tools'>
>;

/** An active run whose card was deleted, cancelled by the sweep: where its worktree may still be. */
export interface OrphanedRun {
  id: string;
  project_id: string;
  machine_id: string | null;
  worktree_path: string | null;
}

/** A stored allow list, or null when absent or not a list of strings. */
const toolsOf = (v: unknown): string[] | null => (Array.isArray(v) && v.every((t) => typeof t === 'string') ? (v as string[]) : null);

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
  restart_count: r.restartCount,
  allowed_tools: toolsOf(r.allowedTools),
  last_typed_at: r.lastTypedAt,
  woken_at: r.wokenAt,
  trigger_sha: r.triggerSha,
  claimed_by: r.claimedBy,
  heartbeat_at: r.heartbeatAt,
  started_at: r.startedAt,
  ended_at: r.endedAt,
  created_at: r.createdAt,
});

/** A raw `RETURNING *` row of automation_runs (snake_case columns). */
type RawRow = Omit<AutomationRun, 'role' | 'status'> & { role: string; status: string };
const mapRaw = (r: RawRow): AutomationRun => ({ ...r, role: r.role as RunRole, status: r.status as RunStatus, allowed_tools: toolsOf(r.allowed_tools) });

const active = { in: [...ACTIVE_RUN_STATUSES] };

/**
 * The automatic runs (agentic board, spec D11). The database guarantees one active run per card, also
 * while two server colours run side by side during a deploy: `claim` returns null when another instance
 * got there first. Each instance refreshes `heartbeat_at` on its runs; a run whose heartbeat went stale
 * (its instance is gone) is taken over by exactly one survivor.
 */
export class AutomationRunsRepository {
  constructor(private db: PrismaClient) {}

  /**
   * A new `queued` run on the card, or null when the card already has an active run ("already taken") or,
   * with `trigger_sha`, when a run of this role was already made for that trigger, in any status (spike R2:
   * the server never starts two runs for the same PR head, and never recreates one that ended).
   */
  async claim(i: { project_id: string; task_id: string; role: RunRole; instance: string; trigger_sha?: string | null }): Promise<AutomationRun | null> {
    try {
      const row = await this.db.automationRun.create({
        data: { id: newId(), projectId: i.project_id, taskId: i.task_id, role: i.role, status: 'queued', claimedBy: i.instance, triggerSha: i.trigger_sha ?? null },
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
        allowedTools: patch.allowed_tools ?? undefined,
      },
    });
    return count === 1;
  }

  /**
   * `update`, only while the run is still active: the one write that ends (or parks) a run. Two paths that
   * end the same run at once — the agent's `report_card` and the PR fallback — write once between them.
   */
  async updateActive(id: string, instance: string, patch: AutomationRunPatch, opts: { unlessWaitingFor?: string } = {}): Promise<boolean> {
    const { count } = await this.db.automationRun.updateMany({
      where: {
        id,
        claimedBy: instance,
        status: active,
        // a run already parked for this same reason is not parked (nor escalated) again
        ...(opts.unlessWaitingFor ? { NOT: { status: 'waiting', waitingReason: opts.unlessWaitingFor } } : {}),
      },
      data: { status: patch.status, waitingReason: patch.waiting_reason, endedAt: patch.ended_at },
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
  async bump(id: string, field: 'resume_count' | 'fix_count' | 'restart_count'): Promise<number> {
    const key = field === 'resume_count' ? 'resumeCount' : field === 'fix_count' ? 'fixCount' : 'restartCount';
    const row = await this.db.automationRun.update({ where: { id }, data: { [key]: { increment: 1 } }, select: { resumeCount: true, fixCount: true, restartCount: true } });
    return row[key];
  }

  /** Records that a line was just typed into the run's tab (by id: whichever colour drives the run typed it). */
  async noteTyped(id: string, at: Date): Promise<void> {
    await this.db.automationRun.updateMany({ where: { id }, data: { lastTypedAt: at } });
  }

  /** Claims the run's one wake: true for the single caller that finds `woken_at` empty on a run this instance drives. */
  async claimWake(id: string, instance: string, at: Date): Promise<boolean> {
    const { count } = await this.db.automationRun.updateMany({ where: { id, claimedBy: instance, status: active, wokenAt: null }, data: { wokenAt: at } });
    return count === 1;
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

  /**
   * The card's failed starts, read from the database so both colours agree (the dispatcher's retry rule):
   * `consecutive` = failed runs since the last run that did not fail (newest first), `recent` = one of them
   * ended less than `backoffMs` ago on the database's clock.
   */
  async startFailures(taskId: string, backoffMs: number): Promise<{ consecutive: number; recent: boolean }> {
    const rows = await this.db.automationRun.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' }, take: 20, select: { status: true } });
    let consecutive = 0;
    for (const r of rows) {
      if (r.status !== 'failed') break;
      consecutive++;
    }
    if (consecutive === 0) return { consecutive, recent: false };
    const [hit] = await this.db.$queryRaw<Array<{ recent: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM "automation_runs"
        WHERE "task_id" = ${taskId} AND "status" = 'failed'
          AND "ended_at" > now() - make_interval(secs => CAST(${backoffMs / 1000} AS double precision))
      ) AS "recent"`;
    return { consecutive, recent: hit?.recent === true };
  }

  /**
   * The card's server-started runs of a role that count against its cap (`fix_attempts`, spike R2): runs
   * whose trigger is set, minus the markers written when the cap was reached (`exceptReason`).
   */
  async countTriggered(taskId: string, role: RunRole, exceptReason: string): Promise<number> {
    return this.db.automationRun.count({
      where: { taskId, role, triggerSha: { not: null }, OR: [{ waitingReason: null }, { waitingReason: { not: exceptReason } }] },
    });
  }

  /** The statuses of the card's server-started runs of a role (an epic's integrator runs, spike R2). */
  async triggeredStatuses(taskId: string, role: RunRole): Promise<RunStatus[]> {
    const rows = await this.db.automationRun.findMany({ where: { taskId, role, triggerSha: { not: null } }, select: { status: true } });
    return rows.map((r) => r.status as RunStatus);
  }

  /** The branches the card's runs worked on: the only PR heads the merge executor merges for it. */
  async branchesOfTask(taskId: string): Promise<string[]> {
    const rows = await this.db.automationRun.findMany({ where: { taskId, branch: { not: null } }, distinct: ['branch'], select: { branch: true } });
    return rows.map((r) => r.branch!).filter((b) => b.length > 0);
  }

  async activeByTab(tabId: string): Promise<AutomationRun | null> {
    const row = await this.db.automationRun.findFirst({ where: { tabId, status: active }, orderBy: { createdAt: 'desc' } });
    return row ? map(row) : null;
  }

  /** The `running` and `waiting` runs this instance drives: what its follower looks at again on each sweep. */
  async followedBy(instance: string): Promise<AutomationRun[]> {
    return (await this.db.automationRun.findMany({ where: { claimedBy: instance, status: { in: ['running', 'waiting'] } }, orderBy: { createdAt: 'asc' } })).map(map);
  }

  async activeByProject(projectId: string): Promise<AutomationRun[]> {
    return (await this.db.automationRun.findMany({ where: { projectId, status: active }, orderBy: { createdAt: 'asc' } })).map(map);
  }

  async countActive(projectId: string): Promise<number> {
    return this.db.automationRun.count({ where: { projectId, status: active } });
  }

  /**
   * The active runs that hold a `max_parallel` slot (TER-888): every active run except a `waiting` one
   * parked for the person with one of `freeReasons` (an escalation). Such a run stays active — the card
   * keeps its one run (`automation_runs_one_active_per_task`) — but no longer counts against the ceiling.
   */
  async countOccupyingSlots(projectId: string, freeReasons: readonly string[]): Promise<number> {
    return this.db.automationRun.count({
      where: {
        projectId,
        OR: [{ status: { in: ['queued', 'starting', 'running'] } }, { status: 'waiting', OR: [{ waitingReason: null }, { waitingReason: { notIn: [...freeReasons] } }] }],
      },
    });
  }

  /**
   * A `waiting` run back to `running` (the person answered, or asked to resume it), whoever drives it.
   * `fresh` also gives it a new budget of resumes and wakes (an explicit "retomar" after a resume cap).
   * False when the run was not waiting.
   */
  async resumeWaiting(id: string, opts: { fresh?: boolean } = {}): Promise<boolean> {
    const { count } = await this.db.automationRun.updateMany({
      where: { id, status: 'waiting' },
      data: { status: 'running', waitingReason: null, ...(opts.fresh ? { resumeCount: 0, wokenAt: null } : {}) },
    });
    return count === 1;
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
