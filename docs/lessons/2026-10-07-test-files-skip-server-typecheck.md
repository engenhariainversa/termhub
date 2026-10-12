---
symptom: "AssertionError: expected [] to deeply equal [ '<id>' ] in supersede.db.test.ts after merging an epic branch"
tags: [typecheck, vitest, merge, server]
evidence: fixed
card: TER-1013
pr: https://github.com/engenhariainversa/termhub/pull/433
agent: claude
date: 2026-10-07
---
## Cause

`apps/server/tsconfig.json` excludes `src/**/*.test.ts`, so `npm run typecheck -w @termhub/server`
never sees test files. TER-1015 added a test calling `decisions.textSearch(..., undefined, true)` and
`nearestAny(..., undefined, true)` with a boolean `includeSuperseded` as the last argument. TER-1013 changed
that parameter to a `StatusSearch` object (`{ includeInactive?, includeSuperseded? }`). After the merge,
`true` was read as an object with no flags, so the search used the default "current only" filter and
returned nothing. Typecheck passed, and the test failed only in CI, where `TERMHUB_DB_TESTS=1` runs the
Postgres suites.

It happened again in TER-1006 (2026-10-08): the WIP made `embedModel` a required 4th argument of
`chatDecisions.nearestAny` and `memoryItems.nearest`, and the merged TER-1015 test still called
`nearestAny(userId, vec(30), 10, undefined, { includeSuperseded: true })`. The `undefined` became the
model (`embed_model = NULL` matches nothing), so `expect([]).toContain(id)` failed in CI only. The
`not.toContain` calls with the old shape passed vacuously.

## Fix

Pass the object form: `decisions.textSearch(userId, marker, 10, undefined, { includeSuperseded: true })`
(the same for `nearestAny`). For the TER-1006 case, pass the model the test embedded with:
`nearestAny(userId, vec(30), 10, 'm#q1', undefined, { includeSuperseded: true })`,
`items.nearest({ ownerId: userId }, vec(10), 10, 'm')`.

## How to check

After changing a repository method's signature, grep its callers in tests too
(`grep -rn "textSearch(" apps/server/src --include=*.test.ts`), because typecheck will not flag them.
The DB suite needs Postgres: `TERMHUB_DB_TESTS=1 DATABASE_URL=… npm test -w @termhub/server`.
