/** Failed starts in a row after which the card's tag is removed until a person tags it again. */
export const MAX_START_FAILURES = 3;

/**
 * The wait before a card whose start failed is tried again, by failed starts in a row (TER-987): short after the
 * first, since the usual cause passes (a machine reconnecting, a deploy switching colour), longer after the
 * second. The third failure untags the card (`MAX_START_FAILURES`), so there is no third wait.
 */
export const START_RETRY_BACKOFF_MS: readonly number[] = [2 * 60_000, 10 * 60_000];

/** The wait after `failures` failed starts in a row (1 = the first failure). */
export function startRetryBackoffMs(failures: number): number {
  const i = Math.min(Math.max(failures, 1), START_RETRY_BACKOFF_MS.length) - 1;
  return START_RETRY_BACKOFF_MS[i]!;
}
