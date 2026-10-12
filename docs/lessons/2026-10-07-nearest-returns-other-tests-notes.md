---
symptom: "AssertionError: expected [ 'P', 'later', 'legacy-user' ] to deeply equal [ 'later', 'legacy-user' ] (memory-items.db.test.ts, nearest)"
tags: [tests, postgres, memory, pgvector, vitest]
evidence: fixed
card: TER-1014
pr: https://github.com/engenhariainversa/termhub/pull/419
agent: claude
date: 2026-10-07
---
## Cause

`MemoryItemsRepository.nearest` has no similarity cut-off: it ranks every embedded row the filter admits and
returns up to `limit`. The tests in `memory-items.db.test.ts` share one owner (`userId`), so a user-scope note
left behind by an earlier test (title `P`, embedded on another axis) still came back from a `nearest` call
whose query vector it does not resemble. `textSearch` hid the problem because it filters by the search text.

## Fix

Filter `nearest` results to the ids the test itself created before asserting on them (or give the test its
own owner). Do not assert on the full result set of `nearest` in a file whose tests share an owner.

## How to check

`TERMHUB_DB_TESTS=1 npm test -w @termhub/server` against a migrated pgvector database: the
`note scope and expiry (TER-1014)` test passes when run with the whole file, not only alone.
