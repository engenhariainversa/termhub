import type { PrismaClient } from '../prisma.js';

/** Where the next read of a tab's transcript starts: a byte offset into one Claude Code session. */
export interface UsageCursor {
  session_id: string;
  offset: number;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One metering pass of a tab: counts and ids only (spec D23). */
export interface UsageWrite {
  tab_id: string;
  project_id: string;
  task_id: string | null;
  account_id: string | null;
  /** `YYYY-MM-DD` in the owner's zone */
  day: string;
  /** the last model counted; null when nothing was counted */
  model: string | null;
  /** the cursor this pass read from (null: the tab had none); the write is refused when it moved since */
  from: UsageCursor | null;
  /** where the next pass starts */
  to: UsageCursor;
  tokens: UsageTokens;
  /** null: nothing in this pass had a priced model */
  cost_usd: number | null;
}

/** Usage summed per card (the run's task) and AI account over a range of days. */
export interface UsageSum {
  task_id: string | null;
  account_id: string | null;
  tokens: UsageTokens;
  /** null when no row of the group had a priced model */
  cost_usd: number | null;
}

class CursorMoved extends Error {}

const hasTokens = (t: UsageTokens) => t.input + t.output + t.cacheRead + t.cacheWrite > 0;

/**
 * Tokens per tab and day (agentic board, spec D23, preflight F-29). `record` moves the tab's cursor and adds
 * the counts in one transaction, and only from the cursor the caller read: two passes over the same bytes
 * (two Stops close together, or both colours during a deploy) count them once.
 */
export class TabUsageRepository {
  constructor(private db: PrismaClient) {}

  async cursor(tabId: string): Promise<UsageCursor | null> {
    const row = await this.db.tabUsage.findUnique({ where: { tabId } });
    return row ? { session_id: row.sessionId, offset: Number(row.transcriptOffset) } : null;
  }

  /** false: another pass moved the cursor first, or the tab is gone, and nothing was written. */
  async record(w: UsageWrite): Promise<boolean> {
    try {
      await this.db.$transaction(async (tx) => {
        const to = { sessionId: w.to.session_id, transcriptOffset: BigInt(w.to.offset), updatedAt: new Date() };
        if (w.from === null) {
          const inserted = await tx.$executeRaw`
            INSERT INTO "tab_usage" ("tab_id", "session_id", "transcript_offset", "updated_at")
            VALUES (${w.tab_id}, ${to.sessionId}, ${to.transcriptOffset}, ${to.updatedAt})
            ON CONFLICT ("tab_id") DO NOTHING`;
          if (inserted !== 1) throw new CursorMoved();
        } else {
          const { count } = await tx.tabUsage.updateMany({
            where: { tabId: w.tab_id, sessionId: w.from.session_id, transcriptOffset: BigInt(w.from.offset) },
            data: to,
          });
          if (count !== 1) throw new CursorMoved();
        }
        if (!hasTokens(w.tokens)) return;
        const cost = w.cost_usd === null ? null : w.cost_usd.toFixed(6);
        await tx.$executeRaw`
          INSERT INTO "tab_usage_days" AS d ("tab_id", "day", "project_id", "task_id", "account_id", "model",
            "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd_estimate", "updated_at")
          VALUES (${w.tab_id}, ${w.day}::date, ${w.project_id}, ${w.task_id}, ${w.account_id}, ${w.model},
            ${w.tokens.input}, ${w.tokens.output}, ${w.tokens.cacheRead}, ${w.tokens.cacheWrite}, ${cost}::numeric, ${to.updatedAt})
          ON CONFLICT ("tab_id", "day") DO UPDATE SET
            "task_id" = COALESCE(EXCLUDED."task_id", d."task_id"),
            "account_id" = COALESCE(EXCLUDED."account_id", d."account_id"),
            "model" = COALESCE(EXCLUDED."model", d."model"),
            "input_tokens" = d."input_tokens" + EXCLUDED."input_tokens",
            "output_tokens" = d."output_tokens" + EXCLUDED."output_tokens",
            "cache_read_tokens" = d."cache_read_tokens" + EXCLUDED."cache_read_tokens",
            "cache_write_tokens" = d."cache_write_tokens" + EXCLUDED."cache_write_tokens",
            "cost_usd_estimate" = CASE WHEN EXCLUDED."cost_usd_estimate" IS NULL THEN d."cost_usd_estimate"
              ELSE COALESCE(d."cost_usd_estimate", 0) + EXCLUDED."cost_usd_estimate" END,
            "updated_at" = EXCLUDED."updated_at"`;
      });
      return true;
    } catch (err) {
      if (err instanceof CursorMoved) return false;
      // the tab was closed meanwhile: its cursor goes with it (foreign key, TER-974), so there is nothing to meter
      if (w.from === null && !(await this.db.tab.findUnique({ where: { id: w.tab_id }, select: { id: true } }))) return false;
      throw err;
    }
  }

  /**
   * A tab whose tokens cannot be read (a Codex tab, spec D23) still shows on its card, as "—": a day row
   * with no counts and no cost. Written once per tab and day; nothing else is stored.
   */
  async noteUnmetered(w: Pick<UsageWrite, 'tab_id' | 'project_id' | 'task_id' | 'account_id' | 'day'>): Promise<void> {
    await this.db.$executeRaw`
      INSERT INTO "tab_usage_days" ("tab_id", "day", "project_id", "task_id", "account_id", "updated_at")
      VALUES (${w.tab_id}, ${w.day}::date, ${w.project_id}, ${w.task_id}, ${w.account_id}, ${new Date()})
      ON CONFLICT ("tab_id", "day") DO NOTHING`;
  }

  /** Every token and the cost of each card, all days; a card with no row is absent. */
  async totalsByTask(taskIds: string[]): Promise<Map<string, { tokens: number; cost_usd: number | null }>> {
    if (taskIds.length === 0) return new Map();
    const rows = await this.db.$queryRaw<Array<{ task_id: string; tokens: bigint; cost: string | null }>>`
      SELECT "task_id",
        SUM("input_tokens" + "output_tokens" + "cache_read_tokens" + "cache_write_tokens")::bigint AS tokens,
        SUM("cost_usd_estimate")::text AS cost
      FROM "tab_usage_days"
      WHERE "task_id" = ANY(${taskIds}::text[])
      GROUP BY "task_id"`;
    return new Map(rows.map((r) => [r.task_id, { tokens: Number(r.tokens), cost_usd: r.cost === null ? null : Number(r.cost) }]));
  }

  /** The project's estimated cost on one day (`YYYY-MM-DD`, the owner's zone): the budget's meter. Unpriced rows count 0. */
  async costOfDay(projectId: string, day: string): Promise<number> {
    const rows = await this.db.$queryRaw<Array<{ cost: string | null }>>`
      SELECT SUM("cost_usd_estimate")::text AS cost FROM "tab_usage_days" WHERE "project_id" = ${projectId} AND "day" = ${day}::date`;
    return Number(rows[0]?.cost ?? 0);
  }

  /** A project's usage per card and account, from `from` to `to` (inclusive `YYYY-MM-DD`; open when absent). */
  async sums(projectId: string, range: { from?: string; to?: string } = {}): Promise<UsageSum[]> {
    const rows = await this.db.$queryRaw<
      Array<{ task_id: string | null; account_id: string | null; input: bigint; output: bigint; cache_read: bigint; cache_write: bigint; cost: string | null }>
    >`
      SELECT "task_id", "account_id",
        SUM("input_tokens")::bigint AS input, SUM("output_tokens")::bigint AS output,
        SUM("cache_read_tokens")::bigint AS cache_read, SUM("cache_write_tokens")::bigint AS cache_write,
        SUM("cost_usd_estimate")::text AS cost
      FROM "tab_usage_days"
      WHERE "project_id" = ${projectId}
        AND (${range.from ?? null}::date IS NULL OR "day" >= ${range.from ?? null}::date)
        AND (${range.to ?? null}::date IS NULL OR "day" <= ${range.to ?? null}::date)
      GROUP BY "task_id", "account_id"`;
    return rows.map((r) => ({
      task_id: r.task_id,
      account_id: r.account_id,
      tokens: { input: Number(r.input), output: Number(r.output), cacheRead: Number(r.cache_read), cacheWrite: Number(r.cache_write) },
      cost_usd: r.cost === null ? null : Number(r.cost),
    }));
  }

  /** The IANA zone of the project's owner (`users.time_zone`); null when unset or the project has no owner. */
  async ownerTimeZone(projectId: string): Promise<string | null> {
    const row = await this.db.project.findUnique({ where: { id: projectId }, select: { owner: { select: { timeZone: true } } } });
    return row?.owner?.timeZone ?? null;
  }
}
