import type { Repositories } from '../db/repositories/index.js';

/**
 * Limits of the personal runs API (TER-1176, spec "Security"). Counted in the database, so they hold
 * across restarts and on both colors of a deploy.
 */
export const RUN_LIMITS = {
  /** Runs one token may have queued or running at once. */
  runningPerToken: 2,
  /** Runs one token may create in any rolling hour. */
  createdPerTokenPerHour: 30,
  /** Runs one person may have queued or running at once, across all their tokens. */
  runningPerUser: 4,
  /** Prompt length, in characters. */
  maxPromptChars: 100_000,
  /** Run timeout: the default and the ceiling, in seconds. */
  defaultTimeoutS: 600,
  maxTimeoutS: 3600,
} as const;

const HOUR_MS = 60 * 60 * 1000;
/** A slot held by a running run frees when it ends, which nobody can tell in advance: ask again soon. */
const RUNNING_RETRY_S = 30;

export type RunLimitReason = 'token_running' | 'user_running' | 'token_hourly';
export type RunLimitResult = { ok: true } | { ok: false; retryAfterS: number; reason: RunLimitReason };

/** Whether this token may start one more run now; when not, which limit and when to try again. */
export async function checkRunLimits(
  repos: Pick<Repositories, 'apiRuns'>,
  who: { userId: string; tokenId: string },
  now: Date = new Date(),
): Promise<RunLimitResult> {
  if ((await repos.apiRuns.countRunning({ tokenId: who.tokenId })) >= RUN_LIMITS.runningPerToken) {
    return { ok: false, retryAfterS: RUNNING_RETRY_S, reason: 'token_running' };
  }
  if ((await repos.apiRuns.countRunning({ userId: who.userId })) >= RUN_LIMITS.runningPerUser) {
    return { ok: false, retryAfterS: RUNNING_RETRY_S, reason: 'user_running' };
  }
  const since = new Date(now.getTime() - HOUR_MS);
  if ((await repos.apiRuns.countCreatedSince(who.tokenId, since)) >= RUN_LIMITS.createdPerTokenPerHour) {
    // The window frees a slot once its oldest run is an hour old.
    const oldest = await repos.apiRuns.oldestCreatedSince(who.tokenId, since);
    const freesAt = (oldest ?? now).getTime() + HOUR_MS;
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((freesAt - now.getTime()) / 1000)), reason: 'token_hourly' };
  }
  return { ok: true };
}
