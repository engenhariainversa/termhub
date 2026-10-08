---
symptom: "TypeError: Cannot read properties of undefined (reading 'projectId') ❯ holdsAtSql src/db/repositories/decision-scope.ts"
tags: [tests, typecheck, merge, db-tests]
evidence: fixed
card: TER-1014
pr: https://github.com/engenhariainversa/termhub/pull/419
agent: claude
date: 2026-10-07
---
## Cause

TER-1014 changed `ChatDecisionsRepository.nearest` to require `opts.place`, and moved the
`includeSuperseded` flag of `textSearch` / `nearestAny` into a `DecisionSearchPlace` object. Merging the
epic brought in `supersede.db.test.ts` (TER-1015), written against the old signatures. The server's
`typecheck` excludes `src/**/*.test.ts`, and `*.db.test.ts` only run with `TERMHUB_DB_TESTS=1`, so the
stale calls compiled and were skipped locally, and only failed in CI against Postgres.

## Fix

Update the callers in the test: pass `place: { projectId }` to `nearest`, and
`{ includeSuperseded: true }` instead of `true` as the last argument of `textSearch` / `nearestAny`.

## How to check

After changing a repository signature (or merging a branch that adds DB tests), type-check the tests
too, with a throwaway tsconfig that extends `apps/server/tsconfig.json` and includes
`src/db/repositories/*.db.test.ts` with an empty `exclude`; look for errors at the changed calls. Then
CI's "Testes server" step runs the DB tests for real.
