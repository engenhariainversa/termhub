---
symptom: "expected { recorded: false, queued: true, …(4) } to match object — write_at '2026-10-28T11:15:00.000Z' received as the current time"
tags: [tests, vitest, time, rate-limit]
evidence: fixed
card: TER-1146
pr: https://github.com/engenhariainversa/termhub/pull/549
agent: claude
date: 2026-10-28
---
## Cause

The TER-1137 quota tests (`control/memory.test.ts` "61st note", `control/lessons.test.ts` "41st lesson")
fake the window's writes at a fixed `2026-10-28T10:15:00Z` but ran on the real clock. They passed only
while the real time was inside that hour; past 11:15 UTC on the day (or any later day) the oldest write
is already out of the window, so `write_at` falls back to "now" and the assertion fails on every PR,
whatever it changes.

## Fix

Freeze `Date` inside the test, within the hour the fakes assume:
`vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-28T10:30:00.000Z')); onTestFinished(() => vi.useRealTimers());`.
Any test whose fakes return fixed timestamps compared against `new Date()` needs the same.

## How to check

`DATABASE_URL=postgresql://x:x@127.0.0.1:1/x npx vitest run apps/server/src/control` passes at any time of day.
