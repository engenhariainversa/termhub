import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

/** What the automatic work did (agentic board). `worktree_cleanup` ({ outcome: removed | kept | gave_up, path }) closes the loop after a merge. `ci_fix_requested` ({ pr, sha }) lets the red-CI loop
 * ask for a fix once per commit. */
export type AutomationEventKind =
  | 'run_started'
  | 'run_resumed'
  | 'run_done'
  | 'run_blocked'
  | 'run_cancelled'
  | 'question_answered'
  // TER-1043: a decision automatic work took alone ({ via: 'agent' | 'nudge', tab_id, summary? }): the agent's
  // own summary from report_card, or the server telling a tab that stopped on a question to follow its recommendation
  | 'decided_by_recommendation'
  | 'permission_auto_approved'
  | 'guard_blocked'
  | 'escalated'
  | 'pr_opened'
  | 'merged'
  | 'merge_needs_approval'
  | 'deploy_ok'
  | 'deploy_failed'
  // TER-1025: a deploy that failed on GitHub's side, run again ({ pr, sha, attempt, run_id, cause, url, workflow })
  | 'deploy_retried'
  | 'release_ok'
  | 'release_failed'
  | 'quota_hit'
  | 'quota_reset'
  | 'paused'
  | 'resumed'
  | 'budget_hit'
  | 'budget_warning'
  | 'ci_fix_requested'
  | 'worktree_cleanup'
  // TER-975: changes to what automatic work may do, by the chat, an MCP client, the web or the app
  | 'automation_on'
  | 'automation_off'
  | 'setup_changed'
  | 'tagged'
  | 'untagged'
  | 'machine_opt_in'
  | 'machine_opt_out'
  // TER-990 audit, on the account's exclusive project: an account set or cleared as exclusive
  // ({ account_id, from_project_id, to_project_id, via }), and a refused use of it elsewhere
  // ({ account_id, attempted_project_id, path, machine_id?, tab_id? })
  | 'account_exclusive_changed'
  | 'account_exclusive_blocked'
  // TER-1025: a run that reported a GitHub error waits for GitHub ({ reason, attempt, tab_id }), and Claude's
  // trust question of a termhub worktree answered by the server ({ tab_id })
  | 'github_wait'
  | 'trust_auto_accepted';

/** Flat on purpose: ids, URLs, counts and reasons — never terminal content, transcripts or prompts. */
export type AutomationEventPayload = Record<string, string | number | boolean | null>;

export interface AutomationEvent {
  id: string;
  project_id: string;
  task_id: string | null;
  run_id: string | null;
  kind: AutomationEventKind;
  payload: AutomationEventPayload;
  created_at: string;
}

export interface AutomationEventInput {
  project_id: string;
  task_id?: string | null;
  run_id?: string | null;
  kind: AutomationEventKind;
  payload?: AutomationEventPayload;
}

/** Events are kept this long (the hourly purge drops older rows). */
export const AUTOMATION_EVENT_RETENTION_MS = 30 * 24 * 3600_000;
export const AUTOMATION_EVENTS_PAGE_MAX = 100;

type Row = Awaited<ReturnType<PrismaClient['automationEvent']['findFirstOrThrow']>>;
const map = (r: Row): AutomationEvent => ({
  id: r.id,
  project_id: r.projectId,
  task_id: r.taskId,
  run_id: r.runId,
  kind: r.kind as AutomationEventKind,
  payload: (r.payload ?? {}) as AutomationEventPayload,
  created_at: r.createdAt.toISOString(),
});

export class AutomationEventsRepository {
  constructor(private db: PrismaClient) {}

  async insert(e: AutomationEventInput): Promise<AutomationEvent> {
    const row = await this.db.automationEvent.create({
      data: { id: newId(), projectId: e.project_id, taskId: e.task_id ?? null, runId: e.run_id ?? null, kind: e.kind, payload: e.payload ?? {} },
    });
    return map(row);
  }

  /** Newest first; `before` pages back from an earlier page's last `created_at`. */
  async listByProject(projectId: string, opts: { before?: Date; limit: number }): Promise<AutomationEvent[]> {
    const rows = await this.db.automationEvent.findMany({
      where: { projectId, ...(opts.before ? { createdAt: { lt: opts.before } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(opts.limit, 1), AUTOMATION_EVENTS_PAGE_MAX),
    });
    return rows.map(map);
  }

  /** The run's newest event of `kind`, or null. */
  async lastForRun(runId: string, kind: AutomationEventKind): Promise<AutomationEvent | null> {
    const row = await this.db.automationEvent.findFirst({ where: { runId, kind }, orderBy: { createdAt: 'desc' } });
    return row ? map(row) : null;
  }

  /** How many events of `kind` the run recorded since `since` (the answer cap of spec D18, review I2). */
  async countForRun(runId: string, kind: AutomationEventKind, since: Date): Promise<number> {
    return this.db.automationEvent.count({ where: { runId, kind, createdAt: { gte: since } } });
  }

  /** The run's events of `kind` since `since` (payloads only: the cycle detector reads its hashes, TER-970). */
  async payloadsForRun(runId: string, kind: AutomationEventKind, since: Date): Promise<AutomationEventPayload[]> {
    const rows = await this.db.automationEvent.findMany({ where: { runId, kind, createdAt: { gte: since } }, select: { payload: true }, take: 200 });
    return rows.map((r) => (r.payload ?? {}) as AutomationEventPayload);
  }

  /**
   * Inserts the event unless a unique index already holds one like it: null then. `ci_fix_requested`
   * (one per card, PR and head SHA: `automation_events_ci_fix_once`, the red-CI loop's claim, F-27) and the
   * budget notices (one per project, kind and day: `automation_events_budget_once`) have such an index.
   */
  async insertOnce(e: AutomationEventInput): Promise<AutomationEvent | null> {
    try {
      return await this.insert(e);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return null;
      throw err;
    }
  }

  /** Replaces the event's payload (a claim settled with its outcome); null when the row is gone. */
  async setPayload(id: string, payload: AutomationEventPayload): Promise<AutomationEvent | null> {
    const { count } = await this.db.automationEvent.updateMany({ where: { id }, data: { payload } });
    if (count === 0) return null;
    return map(await this.db.automationEvent.findUniqueOrThrow({ where: { id } }));
  }

  /** How many of the card's events of `kind` hold every pair of `match` in their payload. */
  async countForTask(taskId: string, kind: AutomationEventKind, match: Record<string, string | number>): Promise<number> {
    return this.db.automationEvent.count({ where: { taskId, kind, AND: Object.entries(match).map(([k, v]) => ({ payload: { path: [k], equals: v } })) } });
  }

  /** The card's event of `kind` whose payload holds every pair of `match` (a once-only claim), or null. */
  async findOnce(taskId: string, kind: AutomationEventKind, match: Record<string, string | number>): Promise<AutomationEvent | null> {
    const row = await this.db.automationEvent.findFirst({
      where: { taskId, kind, AND: Object.entries(match).map(([k, v]) => ({ payload: { path: [k], equals: v } })) },
      orderBy: { createdAt: 'desc' },
    });
    return row ? map(row) : null;
  }

  /**
   * Replaces the event's payload only while it still holds every pair of `match`: the one caller that moves a
   * claim from one outcome to the next gets the row, a second one (the other colour) null.
   */
  async replacePayloadIf(id: string, match: Record<string, string | number>, payload: AutomationEventPayload): Promise<AutomationEvent | null> {
    const { count } = await this.db.automationEvent.updateMany({
      where: { id, AND: Object.entries(match).map(([k, v]) => ({ payload: { path: [k], equals: v } })) },
      data: { payload },
    });
    if (count === 0) return null;
    return map(await this.db.automationEvent.findUniqueOrThrow({ where: { id } }));
  }

  /** Deletes one event (a claim given back, so a later pass may take it again). */
  async remove(id: string): Promise<void> {
    await this.db.automationEvent.deleteMany({ where: { id } });
  }

  /**
   * Deletes the card's events of `kind` whose payload holds every pair of `match` and that were written
   * before `before`: a claim left behind by a process that died before it settled it. The number removed.
   */
  async removeStale(taskId: string, kind: AutomationEventKind, match: Record<string, string | number>, before: Date): Promise<number> {
    const { count } = await this.db.automationEvent.deleteMany({
      where: { taskId, kind, createdAt: { lt: before }, AND: Object.entries(match).map(([k, v]) => ({ payload: { path: [k], equals: v } })) },
    });
    return count;
  }

  /** Drops events older than `cutoff`; the number removed. */
  async purgeBefore(cutoff: Date): Promise<number> {
    const { count } = await this.db.automationEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return count;
  }
}
