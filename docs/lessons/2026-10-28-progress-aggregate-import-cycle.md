---
symptom: "TypeError: Cannot read properties of undefined (reading 'length') ❯ src/automation/prompts.ts:69 (const BUDGET = PROMPT_MAX_CHARS - ORIGIN_REMINDER.length …)"
tags: [server, imports, vitest, automation, progress]
evidence: fixed
card: TER-1150
agent: claude
date: 2026-10-28
---
## Cause

An import cycle. `progress/aggregate.ts` (loaded early through `db/repositories/progress.ts`, i.e. by the
repositories index) started importing an automation module that pulled in `automation/follower.ts`, which
imports `automation/prompts.ts`, which reaches back into modules still half-initialised. `prompts.ts`
evaluates a top-level constant from another module's export (`ORIGIN_REMINDER.length`) at load time, so the
export was still `undefined` and the whole test file failed to load (many suites at once: dispatcher,
prompts, mcp tools-schema, control agents), with no test of the new code failing.

## Fix

Keep what the repositories and the progress/health readers import free of the automation actors: the pure
reading goes in its own module with only type imports and pure helpers (`automation/epic-phase.ts`,
`automation/delivery.ts` for `deliveryPending`, re-exported by `release.ts`), and the module that acts
(`automation/epic-lifecycle.ts`, which imports `follower`, `merge`, `release`) is imported only by the
dispatcher and the merge executor.

## How to check

`DATABASE_URL=postgresql://x:x@localhost:1/x npx vitest run src/automation src/mcp src/control` in
`apps/server`: no suite fails "[ file ]" at load time with the error above.
