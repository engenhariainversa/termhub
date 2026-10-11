---
symptom: "automation dispatcher (Postgres) > LAUNCH_FAILED: … — dozens of dispatcher / dispatcher.colours DB tests fail at once, nothing claimed or started"
tags: [tests, postgres, automation, legal, shared-database]
evidence: fixed
card: TER-742
agent: claude
date: 2026-10-11
---
## Cause

The automation dispatcher starts nothing for a project owner who has not accepted the Terms in force
(TER-742: their tokens and the MCP refuse every call, so an agent could not report back). The DB tests
share one database and run in parallel, and `account-deletion.db.test.ts` seeded a
`legal_document_versions` row with `requires_acceptance` (the default) and `effective_at = now`, then left
it there. From then on every user in the database, the dispatcher tests' owners included, had a pending
acceptance, so their dispatchers skipped every project.

## Fix

A DB test that only needs a version row creates it with `requiresAcceptance: false` (it never gates
anyone) and deletes it in `afterAll`. A test that needs versions in force (`legal.db.test.ts`) calls
`serializeAutomationDb()` (`apps/server/test/automation-db-lock.ts`), so it never runs at the same time as
the automation DB files.

## How to check

`TERMHUB_DB_TESTS=1 DATABASE_URL=… npx vitest run` from `apps/server` against a throwaway, migrated
Postgres, twice in a row: the dispatcher DB files pass both times, and
`SELECT count(*) FROM legal_document_versions` is 0 afterwards.
