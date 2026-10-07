import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapSession, mapUser, type Session, type User } from './types.js';

/** Where a session was opened, shown in the sessions list. */
export interface SessionOrigin {
  ip?: string | null;
  user_agent?: string | null;
}

/** A session is alive until `expiresAt` and, with an idle timeout, while it was used after `idleCutoff`. */
function aliveWhere(now: Date, idleCutoff: Date | null) {
  return { expiresAt: { gt: now }, ...(idleCutoff ? { lastUsedAt: { gt: idleCutoff } } : {}) };
}

export class SessionsRepository {
  constructor(private db: PrismaClient) {}

  async create(userId: string, tokenHash: string, expiresAt: Date, origin: SessionOrigin = {}): Promise<Session> {
    const s = await this.db.session.create({
      data: { id: newId(), userId, tokenHash, expiresAt, ip: origin.ip ?? null, userAgent: origin.user_agent ?? null },
    });
    return mapSession(s);
  }

  /** Retorna a sessão + usuário se o token for válido, não expirado e (com `idleCutoff`) usado depois dele. */
  async findValidByTokenHash(tokenHash: string, idleCutoff: Date | null = null): Promise<{ session: Session; user: User } | undefined> {
    const s = await this.db.session.findFirst({
      where: { tokenHash, ...aliveWhere(new Date(), idleCutoff) },
      include: { user: true },
    });
    if (!s) return undefined;
    return { session: mapSession(s), user: mapUser(s.user) };
  }

  /** Records a use; skipped when the last one is newer than `notBefore`, so a busy session writes once a minute. */
  async touch(id: string, now: Date, notBefore: Date): Promise<void> {
    await this.db.session.updateMany({ where: { id, lastUsedAt: { lt: notBefore } }, data: { lastUsedAt: now } });
  }

  /** The user's live sessions, most recently used first. */
  async listForUser(userId: string, idleCutoff: Date | null = null): Promise<Session[]> {
    const rows = await this.db.session.findMany({ where: { userId, ...aliveWhere(new Date(), idleCutoff) }, orderBy: { lastUsedAt: 'desc' } });
    return rows.map(mapSession);
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.db.session.deleteMany({ where: { tokenHash } });
  }

  /** Ends one of the user's sessions; false when it is not theirs (or already gone). */
  async deleteForUser(userId: string, id: string): Promise<boolean> {
    const r = await this.db.session.deleteMany({ where: { id, userId } });
    return r.count > 0;
  }

  /** Ends every session of the user, except `keepId` when given (the one making the request). */
  async deleteAllForUser(userId: string, keepId?: string): Promise<number> {
    const r = await this.db.session.deleteMany({ where: { userId, ...(keepId ? { id: { not: keepId } } : {}) } });
    return r.count;
  }

  /** Expired sessions, and with an idle timeout the ones unused since `idleCutoff`. */
  async purgeExpired(idleCutoff: Date | null = null): Promise<number> {
    const now = new Date();
    const r = await this.db.session.deleteMany({
      where: { OR: [{ expiresAt: { lte: now } }, ...(idleCutoff ? [{ lastUsedAt: { lte: idleCutoff } }] : [])] },
    });
    return r.count;
  }
}
