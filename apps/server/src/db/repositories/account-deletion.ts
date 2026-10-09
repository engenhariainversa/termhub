import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { hashEmail } from '../../mobile/codes.js';
import { mapUser, type User } from './types.js';

/** What the cascade removed that lives outside the database: the caller cleans it up after the commit. */
export interface PurgedAccount {
  user: User;
  /** Machines the account owned: their agents are disconnected (the token went with the row). */
  machine_ids: string[];
  /** Chat attachments whose bytes sit on the chat-files volume under `<dir>/<user_id>/<id>`. */
  attachment_ids: string[];
}

export interface AccountDeletionLink {
  id: string;
  email: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

/**
 * Account deletion (TER-720): the 30-day window on the user row and the cascade that removes an
 * account for good. The schema already cascades most of what hangs off `users`; this covers the
 * rest — what is owned through `owner_id` with `SET NULL` (machines, projects, integrations), rows
 * that point at the user without a foreign key (device trail, uploads, tickets of their
 * integrations) and rows keyed by e-mail (login codes and attempts, waitlist, decoy device requests,
 * deletion links). One transaction, under the user row's lock, so two app colors running the job
 * cannot both act on the same account and a cancel cannot land halfway through.
 */
export class AccountDeletionRepository {
  constructor(private db: PrismaClient) {}

  /**
   * Deactivates the account until `scheduledAt`. An account already pending keeps its first
   * schedule (asking twice never pushes the date back); returns the row as it ends up.
   */
  async markRequested(userId: string, requestedAt: Date, scheduledAt: Date): Promise<User | undefined> {
    await this.db.user.updateMany({
      where: { id: userId, deletionScheduledAt: null },
      data: { deletionRequestedAt: requestedAt, deletionScheduledAt: scheduledAt },
    });
    const u = await this.db.user.findUnique({ where: { id: userId } });
    return u ? mapUser(u) : undefined;
  }

  /** Lifts a pending deletion. False when there was none (already cancelled, or already deleted). */
  async cancel(userId: string): Promise<boolean> {
    const { count } = await this.db.user.updateMany({
      where: { id: userId, deletionScheduledAt: { not: null } },
      data: { deletionRequestedAt: null, deletionScheduledAt: null },
    });
    return count === 1;
  }

  /** Accounts whose window is over, oldest first. */
  async listDue(now: Date, limit = 50): Promise<string[]> {
    const rows = await this.db.user.findMany({
      where: { deletionScheduledAt: { lte: now } },
      orderBy: { deletionScheduledAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Deletes the account and everything it owns. With `dueBy`, only when its deletion is scheduled
   * at or before that instant (the job: a cancel that won the lock wins). Undefined = nothing was
   * deleted (no such account, or not due).
   */
  async purge(userId: string, opts: { dueBy?: Date } = {}): Promise<PurgedAccount | undefined> {
    return this.db.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
        if (!locked) return undefined;
        const row = await tx.user.findUnique({ where: { id: userId } });
        if (!row) return undefined;
        if (opts.dueBy && (!row.deletionScheduledAt || row.deletionScheduledAt > opts.dueBy)) return undefined;
        const email = row.email;

        const [machines, projects, integrations, attachments] = await Promise.all([
          tx.machine.findMany({ where: { ownerId: userId }, select: { id: true } }),
          tx.project.findMany({ where: { ownerId: userId }, select: { id: true } }),
          tx.integration.findMany({ where: { ownerId: userId }, select: { id: true } }),
          tx.chatAttachment.findMany({ where: { userId }, select: { id: true } }),
        ]);
        const machineIds = machines.map((m) => m.id);
        const projectIds = projects.map((p) => p.id);
        const integrationIds = integrations.map((i) => i.id);

        // The cascade below removes these tabs without TabsRepository.delete: their tab tokens
        // (another person's included) are revoked here first, as the machine delete route does.
        const tabs = await tx.tab.findMany({ where: { OR: [{ machineId: { in: machineIds } }, { projectId: { in: projectIds } }] }, select: { id: true } });
        if (tabs.length) await tx.apiToken.updateMany({ where: { tabId: { in: tabs.map((t) => t.id) }, revokedAt: null }, data: { revokedAt: new Date() } });

        // Tickets point at their integration without a foreign key.
        if (integrationIds.length) await tx.ticket.deleteMany({ where: { integrationId: { in: integrationIds } } });
        // Projects take their board, notes, tickets, setups, tabs and project chats with them;
        // machines take their tabs, AI accounts, uploads, hooks and project links.
        await tx.project.deleteMany({ where: { ownerId: userId } });
        await tx.machine.deleteMany({ where: { ownerId: userId } });
        await tx.integration.deleteMany({ where: { ownerId: userId } });
        await tx.upload.deleteMany({ where: { userId } });
        await tx.deviceEvent.deleteMany({ where: { userId } });
        // Rows keyed by e-mail, not by id.
        await tx.deviceRequest.deleteMany({ where: { emailHash: hashEmail(email) } });
        await tx.loginCode.deleteMany({ where: { email } });
        await tx.loginAttempt.deleteMany({ where: { key: `email:${email}` } });
        await tx.waitlistEntry.deleteMany({ where: { email } });
        await tx.accountDeletionLink.deleteMany({ where: { email } });
        // The rest cascades from the user row: sessions, API tokens, chat (conversations, messages,
        // actions, attachments, live runs, grants), memory, decisions, groups, devices, notifications, daily automation summaries,
        // data export requests (their zip files go with the export job's sweep).
        await tx.user.delete({ where: { id: userId } });

        return { user: mapUser(row), machine_ids: machineIds, attachment_ids: attachments.map((a) => a.id) };
      },
      { timeout: 60_000 },
    );
  }

  // ---------- links from the public page (TER-728) ----------

  async createLink(email: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.accountDeletionLink.create({ data: { id: newId(), email: email.trim().toLowerCase(), tokenHash, expiresAt } });
  }

  async countLinksSince(email: string, since: Date): Promise<number> {
    return this.db.accountDeletionLink.count({ where: { email: email.trim().toLowerCase(), createdAt: { gte: since } } });
  }

  /**
   * Spends a link: the e-mail it was sent to, once, while it is valid. The condition is part of the
   * write, so the same link clicked twice (or by two tabs at once) is spent only once.
   */
  async consumeLink(tokenHash: string, now: Date): Promise<string | undefined> {
    const { count } = await this.db.accountDeletionLink.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) return undefined;
    return (await this.db.accountDeletionLink.findUnique({ where: { tokenHash }, select: { email: true } }))?.email;
  }

  async purgeExpiredLinks(now: Date): Promise<number> {
    return (await this.db.accountDeletionLink.deleteMany({ where: { expiresAt: { lt: now } } })).count;
  }
}
