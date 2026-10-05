---
symptom: "automatic run resumed twice, or blocked with agent_exited, right after the other colour took it over"
tags: [automation, blue-green, follower, tests]
evidence: fixed
card: TER-865
agent: claude
date: 2026-10-05
---
## Cause

The follower remembered "I already typed for this tab state" in a module-level `Map` (`actedOn`). Memory is
per process: when one colour stops beating and the other takes the run over (`takeOver`), the new colour
does not know the old one typed a resume (or a restart) into a tab whose state has not moved since. It types
the resume again, or — for an exited agent with `restart_count` already at the cap — ends the run `blocked`
with `agent_exited` although the restart was just typed.

Tests in one process hid it: both "colours" shared the same module and the same `Map`.

## Fix

The time of the last typed line is stored on the run (`automation_runs.last_typed_at`, written by
`automationRuns.noteTyped`, by the follower after a resume or restart and by `resumeAfterReset` before the
quota resume). The follower skips a tab state when `last_typed_at >= tab.state_at` and less than
`RETYPE_AFTER_MS` ago, whichever colour typed it.

To test two colours in one process, give each its own module copies: `vi.resetModules()` and then
`await import('./follower.js')` / `('./dispatcher.js')` per colour (see `dispatcher.colours.db.test.ts`).

## How to check

`TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- dispatcher.colours` (with a migrated Postgres): the
"a line typed by one colour is not typed again by the one that takes over" cases pass.
