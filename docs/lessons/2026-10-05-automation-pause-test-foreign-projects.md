---
symptom: "dispatcher.colours.db.test 'pause during a burst' / 'pause pressed while a card is being prepared' fail intermittently: a pause read after the pause answered 'not paused'"
tags: [tests, postgres, automation, vitest, flaky]
evidence: fixed
card: TER-969
agent: claude
date: 2026-10-05
---
## Cause

The tests log every `automationPauses.state` read and `claim` of the dispatcher and assert that, after the
pause, every read answers "paused". A dispatcher pass reads the pause of every project with automation on in
the shared database, not only the test's own. A project left behind by another test file (not serialized by
`serializeAutomationDb`) or an earlier aborted run is not paused, so its read, logged after the pause, broke the
assertion. Reproduced by inserting one project with `automation.enabled` into an empty database.

## Fix

`observed()` in `dispatcher.colours.db.test.ts` logs only the reads and claims of the test's own project.
Placement timing (R6 room check, per-tick limit) was not involved.

## How to check

Insert a foreign project with automation enabled, then run
`TERMHUB_DB_TESTS=1 npx vitest run src/automation/dispatcher.colours`: green.
