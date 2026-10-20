---
symptom: "account-deletion.db.test.ts: AssertionError: expected [ 'access_logs.user_id', …(20) ] to deeply equal [ 'access_logs.user_id', …(21) ]"
tags: [prisma, migration, tests, ci, account-deletion]
evidence: observed
card: TER-1010
pr: https://github.com/engenhariainversa/termhub/pull/431
agent: claude
date: 2026-10-11
---
## Cause

`apps/server/src/db/repositories/account-deletion.db.test.ts` reads every column named `user_id` or
`owner_id` from `information_schema` and requires `seedAccount` to put a row in each of those tables, so
the "no row points at the deleted account" check means something. A migration that adds a table with
such a column (here `memory_rules.owner_id`) fails the test until the seed has a row for it. The test
needs Postgres (`TERMHUB_DB_TESTS=1`), so it is skipped locally and only fails in CI.

## Fix

Add a row of the new table to `seedAccount`, and make sure the row goes away with the account: an
`onDelete: Cascade` foreign key to `users`, or an explicit delete in `AccountDeletionRepository.purge`.

## How to check

The "Testes server" step of the `check` job passes: `account-deletion.db.test.ts` is green.
