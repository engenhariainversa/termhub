import type { Repositories } from '../db/repositories/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The tabs' state history (what each agent was doing, with its texts) is kept for 90 days (TER-743, D-6). */
export const TAB_EVENT_RETENTION_MS = 90 * DAY_MS;
/** A waitlist entry goes 12 months after it signed up, or 12 months after its (last) invite (TER-743, D-6). */
export const WAITLIST_RETENTION_MS = 365 * DAY_MS;

/**
 * The retention periods of the Privacy Policy (section 8) that are not anyone's own to delete, run from
 * app.ts's hourly purge. Chat, the agents' last answers and memory stay while the account exists: the
 * person deletes them. Returns how many rows were deleted in total.
 */
export async function purgeRetention(repos: Pick<Repositories, 'tabs' | 'waitlist'>, now = new Date()): Promise<number> {
  const at = now.getTime();
  const events = await repos.tabs.purgeEventsBefore(new Date(at - TAB_EVENT_RETENTION_MS));
  const waitlist = await repos.waitlist.purgeBefore(new Date(at - WAITLIST_RETENTION_MS));
  return events + waitlist;
}
