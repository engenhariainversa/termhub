import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { Mailer } from '../email/mailer.js';
import { accountDeletedMail, deletionCancelledMail, deletionLinkMail, deletionRequestedMail } from '../email/templates.js';
import { isAdmin } from '../auth/permissions.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { HttpError } from '../lib/errors.js';

/** Decision D-12 (TER-721): a deletion waits 30 days, during which signing in can cancel it. */
export const DELETION_GRACE_DAYS = 30;
export const DELETION_GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;
/** The public page's e-mailed link (TER-728): short-lived and single use. */
export const DELETION_LINK_TTL_MS = 30 * 60 * 1000;
/** Links one e-mail can receive per hour: someone typing another person's address cannot flood them. */
export const DELETION_LINK_MAX_PER_HOUR = 3;

export const pendingDeletion = () =>
  new HttpError(403, 'Sua conta está desativada porque você pediu para excluí-la. Cancele a exclusão para voltar a usar o termhub.', 'ACCOUNT_PENDING_DELETION');

/** True while the account waits out its deletion window: everything but the cancel path is refused. */
export const isPendingDeletion = (user: Pick<User, 'deletion_scheduled_at'>): boolean => !!user.deletion_scheduled_at;

/** What the web, the app and the public page show about a pending deletion. */
export function deletionStatus(user: Pick<User, 'deletion_requested_at' | 'deletion_scheduled_at'>) {
  return { pending: !!user.deletion_scheduled_at, requested_at: user.deletion_requested_at, scheduled_at: user.deletion_scheduled_at };
}

export interface AccountDeletionDeps {
  repos: Repositories;
  mailer: Mailer;
  /** Cloudflare Access allowlist: the e-mail leaves it only when the account is gone for good. */
  access: { remove(email: string): Promise<unknown> };
  /** Removes one chat attachment's bytes from the chat-files volume (idempotent). */
  removeAttachment: (userId: string, id: string) => Promise<void>;
  /** Hangs up a machine's agent: its token went with the machine row. */
  disconnectMachine: (machineId: string) => void;
  /** Tells the public city that the owner and their robots are gone. */
  ownerGone: (userId: string, machineIds: string[]) => void;
  appUrl: string;
  /** The public deletion page; its confirmation link carries `?token=…`. */
  pageUrl: string;
  log: FastifyBaseLogger;
  now?: () => Date;
}

/**
 * Account deletion (TER-720, TER-728). A request deactivates the account and schedules its
 * deletion 30 days ahead; signing in during the window lets the person cancel; the job deletes due
 * accounts for good. An admin deleting someone skips the window but runs the same cascade.
 */
export class AccountDeletionService {
  constructor(private readonly deps: AccountDeletionDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The instance is never left without an administrator. */
  async assertCanDelete(user: User): Promise<void> {
    if ((await isAdmin(this.deps.repos, user)) && (await this.deps.repos.users.countAdmins()) <= 1) {
      throw new HttpError(409, 'Você é o único administrador. Promova outra pessoa a administrador antes de excluir sua conta.', 'LAST_ADMIN');
    }
  }

  /**
   * Deactivates the account and schedules its deletion. Every web session ends at once (the person
   * signs in again to cancel); API and device tokens stay, refused while the deletion is pending,
   * so a cancel brings them back. Asking again keeps the first date.
   */
  async request(user: User, source: 'web' | 'mobile' | 'page'): Promise<User> {
    await this.assertCanDelete(user);
    const now = this.now();
    const updated = await this.deps.repos.accountDeletion.markRequested(user.id, now, new Date(now.getTime() + DELETION_GRACE_MS));
    if (!updated) throw new HttpError(404, 'Conta não encontrada', 'NOT_FOUND');
    await this.deps.repos.sessions.deleteAllForUser(user.id);
    this.deps.log.info({ userId: user.id, source, scheduledAt: updated.deletion_scheduled_at }, 'account deletion: requested');
    // Only a fresh request sends the e-mail: asking twice must not repeat it.
    if (!user.deletion_scheduled_at && updated.deletion_scheduled_at) {
      await this.mail(deletionRequestedMail(updated.email, { scheduledAt: new Date(updated.deletion_scheduled_at), appUrl: this.deps.appUrl }), user.id);
    }
    return updated;
  }

  /** Lifts a pending deletion; false when none was pending. */
  async cancel(user: User): Promise<boolean> {
    const cancelled = await this.deps.repos.accountDeletion.cancel(user.id);
    if (cancelled) {
      this.deps.log.info({ userId: user.id }, 'account deletion: cancelled');
      await this.mail(deletionCancelledMail(user.email, { appUrl: this.deps.appUrl }), user.id);
    }
    return cancelled;
  }

  /**
   * Deletes the account now, with everything it owns, then cleans up what lives outside the
   * database. `dueBy` limits it to an account whose window ended by then (the job). False = nothing
   * was deleted.
   */
  async purge(userId: string, opts: { dueBy?: Date; actor: string; notify?: boolean }): Promise<boolean> {
    const purged = await this.deps.repos.accountDeletion.purge(userId, { dueBy: opts.dueBy });
    if (!purged) return false;
    const { user, machine_ids, attachment_ids } = purged;
    this.deps.log.info({ userId, actor: opts.actor, machines: machine_ids.length, attachments: attachment_ids.length }, 'account deletion: account deleted');
    // Best effort from here on: the rows are gone either way, and the sweep removes orphaned files later.
    for (const id of attachment_ids) {
      await this.deps.removeAttachment(userId, id).catch((err: unknown) => this.deps.log.warn({ err: errText(err), userId }, 'account deletion: attachment file removal failed'));
    }
    for (const id of machine_ids) this.deps.disconnectMachine(id);
    this.deps.ownerGone(userId, machine_ids);
    await this.deps.access.remove(user.email).catch((err: unknown) => this.deps.log.warn({ err: errText(err), userId }, 'account deletion: cloudflare access removal failed'));
    if (opts.notify !== false) await this.mail(accountDeletedMail(user.email), userId);
    return true;
  }

  /** The job: deletes every account whose 30 days are over. Safe on both app colors at once. */
  async runDue(): Promise<number> {
    const now = this.now();
    let done = 0;
    for (const id of await this.deps.repos.accountDeletion.listDue(now)) {
      try {
        if (await this.purge(id, { dueBy: now, actor: 'job' })) done++;
      } catch (err) {
        this.deps.log.warn({ err: errText(err), userId: id }, 'account deletion: job failed for one account');
      }
    }
    await this.deps.repos.accountDeletion.purgeExpiredLinks(now).catch(() => 0);
    return done;
  }

  // ---------- the public page (TER-728) ----------

  /**
   * E-mails a confirmation link when the address has an account that can be deleted. Answers the
   * same way for every address (no account, a pending one, too many links): the page must not tell
   * who has an account.
   */
  async sendLink(rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    const now = this.now();
    const user = await this.deps.repos.users.findByEmail(email);
    if (!user || isPendingDeletion(user)) return;
    if ((await this.deps.repos.accountDeletion.countLinksSince(email, new Date(now.getTime() - 60 * 60 * 1000))) >= DELETION_LINK_MAX_PER_HOUR) return;
    const token = generateToken(32);
    await this.deps.repos.accountDeletion.createLink(email, hashToken(token), new Date(now.getTime() + DELETION_LINK_TTL_MS));
    const link = `${this.deps.pageUrl}${this.deps.pageUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    await this.mail(deletionLinkMail(email, { link, ttlMinutes: Math.round(DELETION_LINK_TTL_MS / 60000) }), user.id);
  }

  /** Spends a link and requests the deletion of its account. Undefined = invalid, used or expired. */
  async confirmLink(token: string): Promise<User | undefined> {
    const email = await this.deps.repos.accountDeletion.consumeLink(hashToken(token), this.now());
    if (!email) return undefined;
    const user = await this.deps.repos.users.findByEmail(email);
    if (!user) return undefined;
    if (isPendingDeletion(user)) return user;
    return this.request(user, 'page');
  }

  private async mail(mail: Parameters<Mailer['send']>[0], userId: string): Promise<void> {
    try {
      await this.deps.mailer.send(mail);
    } catch (err) {
      this.deps.log.warn({ err: errText(err), userId }, 'account deletion: e-mail failed');
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
