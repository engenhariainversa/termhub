import type { PrismaClient } from '../prisma.js';

/**
 * AI accounts at their usage limit (agentic board): automatic work skips an account until `until`.
 * One row per account; marking again moves the deadline.
 */
export class AiAccountExhaustionsRepository {
  constructor(private db: PrismaClient) {}

  async mark(accountId: string, until: Date, reason: string): Promise<void> {
    await this.db.aiAccountExhaustion.upsert({
      where: { accountId },
      create: { accountId, until, reason },
      update: { until, reason },
    });
  }

  /** The accounts still at their limit at `now`. */
  async activeIds(now: Date): Promise<Set<string>> {
    const rows = await this.db.aiAccountExhaustion.findMany({ where: { until: { gt: now } }, select: { accountId: true } });
    return new Set(rows.map((r) => r.accountId));
  }

  /** Deletes the rows whose deadline passed and returns their account ids (each comes back once). */
  async clearExpired(now: Date): Promise<string[]> {
    const rows = await this.db.$queryRaw<Array<{ account_id: string }>>`
      DELETE FROM "ai_account_exhaustions" WHERE "until" <= ${now} RETURNING "account_id"`;
    return rows.map((r) => r.account_id);
  }
}
