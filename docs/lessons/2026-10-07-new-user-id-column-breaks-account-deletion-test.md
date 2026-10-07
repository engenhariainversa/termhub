---
symptom: "AssertionError: expected [ 'api_tokens.user_id', …(17) ] to deeply equal [ 'access_logs.user_id', …(18) ]"
tags: [account-deletion, prisma, tests, ci]
evidence: fixed
card: TER-744
pr: https://github.com/engenhariainversa/termhub/pull/422
agent: claude
date: 2026-10-07
---
## Cause

`apps/server/src/db/repositories/account-deletion.db.test.ts` lists every `user_id` / `owner_id`
column in the schema (from `information_schema`) and requires the seed to put a row in each one, and
the purge to leave none. A migration that adds a table with a `user_id` column (here `access_logs`)
fails that test until the seed and the purge account for it. It only runs with `TERMHUB_DB_TESTS=1`,
so it passes locally without Postgres and fails in CI.

## Fix

Decide whether the new rows go with the account. If they do, delete them in
`AccountDeletionRepository.purge` and seed one in `seedAccount`. If they must outlive it (the access
records, kept 6 months under the Marco Civil), seed one anyway and assert the row is still there after
the purge, as the test now does for `access_logs.user_id`.

## How to check

`DATABASE_URL=… TERMHUB_DB_TESTS=1 npx -w @termhub/server vitest run src/db/repositories/account-deletion.db.test.ts`
against a migrated, disposable database, or the `check` job of the PR.
