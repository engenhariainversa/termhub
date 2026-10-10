import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

/**
 * How long a "view as" period is kept after it ended (TER-746). A year: past the 6 months the Marco Civil
 * (art. 15) asks of access records, so a question about who saw an account can still be answered after a
 * semester, and short enough not to keep admins' trails forever.
 */
export const VIEW_AS_AUDIT_RETENTION_MS = 365 * 24 * 3600_000;

export type ViewAsAuditScope = 'user' | 'all';

/** One period an admin spent in another scope. Ids and the IP only: never what was seen. */
export interface ViewAsAuditEntry {
  id: string;
  admin_id: string;
  scope: ViewAsAuditScope;
  target_user_id: string | null;
  ip: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface ViewAsAuditStart {
  admin_id: string;
  scope: ViewAsAuditScope;
  target_user_id?: string | null;
  ip?: string | null;
}

type Row = Awaited<ReturnType<PrismaClient['viewAsAudit']['findFirstOrThrow']>>;
const map = (r: Row): ViewAsAuditEntry => ({
  id: r.id,
  admin_id: r.adminId,
  scope: r.scope as ViewAsAuditScope,
  target_user_id: r.targetUserId,
  ip: r.ip,
  started_at: r.startedAt.toISOString(),
  ended_at: r.endedAt?.toISOString() ?? null,
});

export class ViewAsAuditRepository {
  constructor(private db: PrismaClient) {}

  /** Opens a period; the admin's previous open one (if any) ends at the same instant. */
  async start(e: ViewAsAuditStart, now = new Date()): Promise<ViewAsAuditEntry> {
    const [, row] = await this.db.$transaction([
      this.db.viewAsAudit.updateMany({ where: { adminId: e.admin_id, endedAt: null }, data: { endedAt: now } }),
      this.db.viewAsAudit.create({
        data: { id: newId(), adminId: e.admin_id, scope: e.scope, targetUserId: e.scope === 'user' ? (e.target_user_id ?? null) : null, ip: e.ip ?? null, startedAt: now },
      }),
    ]);
    return map(row);
  }

  /** Ends the admin's open period (back to their own scope, or signed out); how many rows it closed. */
  async end(adminId: string, now = new Date()): Promise<number> {
    const r = await this.db.viewAsAudit.updateMany({ where: { adminId, endedAt: null }, data: { endedAt: now } });
    return r.count;
  }

  /** Newest first: the periods in which an admin saw this user's data (or "all"). */
  async listForTarget(userId: string, limit = 50): Promise<ViewAsAuditEntry[]> {
    const rows = await this.db.viewAsAudit.findMany({
      where: { OR: [{ targetUserId: userId }, { scope: 'all' }] },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(map);
  }

  /** Newest first: the admin's own periods. */
  async listForAdmin(adminId: string, limit = 50): Promise<ViewAsAuditEntry[]> {
    const rows = await this.db.viewAsAudit.findMany({ where: { adminId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: limit });
    return rows.map(map);
  }

  /** Drops periods that ended before `cutoff`, and open ones that started before it (never closed explicitly). */
  async purgeBefore(cutoff: Date): Promise<number> {
    const r = await this.db.viewAsAudit.deleteMany({ where: { OR: [{ endedAt: { lt: cutoff } }, { endedAt: null, startedAt: { lt: cutoff } }] } });
    return r.count;
  }
}
