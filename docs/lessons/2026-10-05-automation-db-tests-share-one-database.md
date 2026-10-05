---
symptom: "a different automation *.db.test.ts fails on each full server run (e.g. 'after a takeover, the old instance can no longer write the run', claimed_by is another instance), but passes alone"
tags: [tests, postgres, automation, vitest, flaky]
evidence: fixed
card: TER-871
agent: claude
date: 2026-10-05
---
## Cause

All `*.db.test.ts` files run in parallel against one shared test database. Several automation tests start a
dispatcher or call `takeOver` / `cancelOrphaned`, which act on every project's runs, not only the test's own.
While one file ran them, the runs another file had just created were taken over by a foreign instance or
cancelled mid-test, so an unrelated assertion failed (a different one on each run).

## Fix

`apps/server/test/automation-db-lock.ts` exports `serializeAutomationDb()`: call it first inside the file's
`describe`, and the file holds a session-level Postgres advisory lock while it runs. The five automation DB
files (automation-runs, queue, dispatcher, dispatcher.colours, merge.colours) now run one at a time against
each other; the rest of the suite stays parallel. A new DB test file that creates automation runs or starts a
dispatcher must call it too.

## How to check

Run the full server suite with `TERMHUB_DB_TESTS=1` against a throwaway database several times in a row: all
green every time (3 runs: 313 files, 5452 tests).
