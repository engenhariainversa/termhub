import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';

/**
 * The automation DB test files share one database and run in parallel, but a dispatcher's `takeOver` and
 * `cancelOrphaned` act on every project's runs, so another file's runs get taken over or cancelled in the
 * middle of its test (flaky failures). Call this first inside the file's `describe`: the file holds a
 * session-level Postgres advisory lock while it runs, so these files run one at a time against each other
 * and the rest of the suite stays parallel.
 */
const LOCK_KEY = 7_300_871;

export function serializeAutomationDb(): void {
  let client: pg.Client | null = null;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  }, 600_000);
  afterAll(async () => {
    await client?.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client?.end().catch(() => {});
  });
}
