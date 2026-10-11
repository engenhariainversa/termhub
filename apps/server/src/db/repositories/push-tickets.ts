import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

export interface PushTicketInput {
  ticket_id: string;
  device_id: string;
  push_token: string;
  kind: string;
}

/** An Expo push ticket waiting for its receipt (TER-924). */
export interface PushTicket extends PushTicketInput {
  id: string;
  created_at: string;
}

interface PushTicketRow {
  id: string;
  ticket_id: string;
  device_id: string;
  push_token: string;
  kind: string;
  created_at: Date;
}

export class PushTicketsRepository {
  constructor(private db: PrismaClient) {}

  async recordMany(inputs: PushTicketInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.db.pushTicket.createMany({
      data: inputs.map((t) => ({ id: newId(), ticketId: t.ticket_id, deviceId: t.device_id, pushToken: t.push_token, kind: t.kind })),
    });
  }

  /**
   * Claims up to `limit` tickets sent before `sentBefore` that nobody claimed since `reclaimBefore`
   * (a claim whose receipt was not ready yet, or whose process died, is taken again later). `SKIP
   * LOCKED` and the conditional update make one claimer win per row, so both colors can sweep.
   */
  async claimDue(sentBefore: Date, reclaimBefore: Date, now: Date, limit: number): Promise<PushTicket[]> {
    const rows = await this.db.$queryRaw<PushTicketRow[]>`
      UPDATE "push_tickets" SET "claimed_at" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "push_tickets"
        WHERE "created_at" < ${sentBefore} AND ("claimed_at" IS NULL OR "claimed_at" < ${reclaimBefore})
        ORDER BY "created_at"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "ticket_id", "device_id", "push_token", "kind", "created_at"`;
    return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
  }

  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.pushTicket.deleteMany({ where: { id: { in: ids } } });
  }

  /** Tickets whose receipt Expo no longer keeps (24 h): nothing left to learn from them. */
  async deleteSentBefore(before: Date): Promise<number> {
    return (await this.db.pushTicket.deleteMany({ where: { createdAt: { lt: before } } })).count;
  }
}
