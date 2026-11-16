import type { Repositories } from '../db/repositories/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { failureLabel } from '../chat/service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The first purge waits a little after boot, so a deploy's two colours do not both start with it. */
const FIRST_RUN_MS = 10 * 60 * 1000;

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/**
 * The daily API token purge (TER-1191): system tokens revoked or expired over 30 days ago, a person's own
 * revoked over 90 days ago (`ApiTokensRepository.purgeStale`). Both colours may run it: a delete of rows
 * past a cutoff is idempotent. Logs only the count.
 */
export async function purgeStaleApiTokens(repos: Pick<Repositories, 'apiTokens'>, log: Log, now = new Date()): Promise<number> {
  const deleted = await repos.apiTokens.purgeStale(now);
  if (deleted > 0) log.info({ deleted }, 'api tokens: stale tokens purged');
  return deleted;
}

export function startApiTokenPurge(repos: Pick<Repositories, 'apiTokens'>, log: Log): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void purgeStaleApiTokens(repos, log)
      .catch((err: unknown) => log.warn({ code: failureLabel(err) }, 'api tokens: purge failed'))
      .finally(() => (running = false));
  };
  const first = setTimeout(run, FIRST_RUN_MS);
  const timer = setInterval(run, DAY_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
