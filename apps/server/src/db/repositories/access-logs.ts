import type { PrismaClient } from '../prisma.js';

/** The Marco Civil (art. 15) asks for 6 months; a few days more so a record is never short of them. */
export const ACCESS_LOG_RETENTION_MS = 190 * 24 * 3600_000;

/** One access record (TER-744): metadata only, never a query string, a body or terminal/chat content. */
export interface AccessLogInput {
  at: Date;
  ip: string | null;
  user_id: string | null;
  kind: 'http' | 'ws';
  method: string;
  route: string;
  status: number | null;
}

export class AccessLogsRepository {
  constructor(private db: PrismaClient) {}

  async insertMany(rows: AccessLogInput[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.accessLog.createMany({
      data: rows.map((r) => ({
        createdAt: r.at,
        ip: r.ip,
        userId: r.user_id,
        kind: r.kind,
        method: r.method,
        route: r.route,
        status: r.status,
      })),
    });
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    const r = await this.db.accessLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  }
}
