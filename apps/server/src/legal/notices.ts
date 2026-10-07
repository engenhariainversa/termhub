import type { Repositories } from '../db/repositories/index.js';
import type { Mailer } from '../email/mailer.js';
import { legalChangeNoticeMail } from '../email/templates.js';
import { localeOf } from '../i18n/index.js';

export interface LegalNoticeLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface LegalNoticeDeps {
  repos: Pick<Repositories, 'legal' | 'users'>;
  mailer: Mailer;
  log: LegalNoticeLog;
  now?: Date;
  /** false while this colour drains (SIGTERM): it claims nothing, the next colour sends. */
  active?: () => boolean;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The hourly 30-day notice (TER-742, spec decision 6): claims every relevant version that now takes
 * effect within 30 days (once, across colours) and e-mails every person whose account is not pending
 * deletion, one e-mail each in their language. Logs counts and user ids, never addresses.
 * Returns how many e-mails went out.
 */
export async function sendDueLegalNotices(deps: LegalNoticeDeps): Promise<number> {
  if (deps.active && !deps.active()) return 0;
  const claimed = await deps.repos.legal.claimDueNotices(deps.now ?? new Date());
  if (claimed.length === 0) return 0;
  const users = (await deps.repos.users.list()).filter((u) => !u.deletion_scheduled_at);
  let sent = 0;
  let failed = 0;
  for (const user of users) {
    try {
      await deps.mailer.send(legalChangeNoticeMail(user.email, claimed, localeOf(user.locale)));
      sent += 1;
    } catch (err) {
      failed += 1;
      deps.log.warn({ err: errText(err), userId: user.id }, 'legal notice: e-mail failed');
    }
  }
  deps.log.info({ versions: claimed.map((v) => v.id), sent, failed }, 'legal notice: sent');
  return sent;
}
