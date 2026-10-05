import type { PrismaClient } from '../prisma.js';

/** What the automatic work did in a window, from its events (counts of ids, never content). */
export interface DayActivity {
  /** distinct cards that finished a run or were merged */
  cards: number;
  /** distinct merged pull requests */
  merges: number;
  /** successful deploys and releases */
  deploys: number;
}

/** A run parked on something only a person can do. */
export interface ParkedRun {
  task_id: string | null;
  reason: string;
}

/** A merge card waiting for the person's decision. */
export interface PendingMerge {
  project_id: string;
  number: number | null;
}

/**
 * The daily summary of the automatic work (agentic board, spec D26, preflight F-28): the once-per-user-and-day
 * claim, and the reads the summary is made of. All of them are by project id: the caller passes the owner's
 * projects with automation on.
 */
export class AutomationSummariesRepository {
  constructor(private db: PrismaClient) {}

  /** True for the one caller that inserts the row (`ON CONFLICT DO NOTHING`); the other colour gets false. */
  async claim(userId: string, day: string): Promise<boolean> {
    const n = await this.db.$executeRaw`INSERT INTO "automation_summaries" ("user_id", "day") VALUES (${userId}, ${day}::date) ON CONFLICT DO NOTHING`;
    return n === 1;
  }

  /** Gives the claim back (the summary could not be written), so a later tick tries again. */
  async release(userId: string, day: string): Promise<void> {
    await this.db.$executeRaw`DELETE FROM "automation_summaries" WHERE "user_id" = ${userId} AND "day" = ${day}::date`;
  }

  /** When the user's previous summary (an earlier day than `day`) was sent; null for the first. */
  async previousSentAt(userId: string, day: string): Promise<Date | null> {
    const rows = await this.db.$queryRaw<Array<{ at: Date | null }>>`
      SELECT MAX("sent_at") AS at FROM "automation_summaries" WHERE "user_id" = ${userId} AND "day" < ${day}::date`;
    return rows[0]?.at ?? null;
  }

  async activity(projectIds: string[], from: Date, to: Date): Promise<DayActivity> {
    if (projectIds.length === 0) return { cards: 0, merges: 0, deploys: 0 };
    const rows = await this.db.$queryRaw<Array<{ cards: bigint; merges: bigint; deploys: bigint }>>`
      SELECT
        COUNT(DISTINCT "task_id") FILTER (WHERE "kind" IN ('run_done', 'merged') AND "task_id" IS NOT NULL) AS cards,
        COUNT(DISTINCT ("project_id" || '#' || ("payload"->>'pr'))) FILTER (WHERE "kind" = 'merged' AND "payload"->>'pr' IS NOT NULL) AS merges,
        COUNT(*) FILTER (WHERE "kind" IN ('deploy_ok', 'release_ok')) AS deploys
      FROM "automation_events"
      WHERE "project_id" = ANY(${projectIds}::text[]) AND "created_at" >= ${from} AND "created_at" < ${to}`;
    const r = rows[0];
    return { cards: Number(r?.cards ?? 0), merges: Number(r?.merges ?? 0), deploys: Number(r?.deploys ?? 0) };
  }

  /** The estimated cost of the days `fromDay`..`toDay` (inclusive `YYYY-MM-DD`) over the projects; null when no row had a priced model. */
  async costOfDays(projectIds: string[], fromDay: string, toDay: string): Promise<number | null> {
    if (projectIds.length === 0) return null;
    const rows = await this.db.$queryRaw<Array<{ cost: string | null }>>`
      SELECT SUM("cost_usd_estimate")::text AS cost FROM "tab_usage_days"
      WHERE "project_id" = ANY(${projectIds}::text[]) AND "day" >= ${fromDay}::date AND "day" <= ${toDay}::date`;
    const cost = rows[0]?.cost;
    return cost === null || cost === undefined ? null : Number(cost);
  }

  /** Runs now waiting with one of `reasons` (the escalation reasons), oldest first. */
  async parkedRuns(projectIds: string[], reasons: string[]): Promise<ParkedRun[]> {
    if (projectIds.length === 0 || reasons.length === 0) return [];
    const rows = await this.db.automationRun.findMany({
      where: { projectId: { in: projectIds }, status: 'waiting', waitingReason: { in: reasons } },
      orderBy: { createdAt: 'asc' },
      select: { taskId: true, waitingReason: true },
    });
    return rows.map((r) => ({ task_id: r.taskId, reason: r.waitingReason ?? '' }));
  }

  /** The user's pending cards of `tool` (the merge approvals), oldest first. */
  async pendingCards(userId: string, tool: string, projectIds: string[]): Promise<PendingMerge[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.db.chatAction.findMany({
      where: { tool, status: 'pending', projectId: { in: projectIds }, conversation: { userId } },
      orderBy: { createdAt: 'asc' },
      select: { projectId: true, args: true },
    });
    return rows.map((r) => {
      const n = (r.args as { number?: unknown } | null)?.number;
      return { project_id: r.projectId ?? '', number: typeof n === 'number' ? n : null };
    });
  }
}
