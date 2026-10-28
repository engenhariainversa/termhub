---
symptom: "lessons.test.ts / memory.test.ts: expected write_at '2026-10-28T11:15:00.000Z', received the current time (TER-1137 queue tests)"
tags: [tests, vitest, time, memory-quota]
evidence: fixed
card: TER-1145
agent: claude
date: 2026-10-28
---
## Cause

The TER-1137 queue tests stub the hour window's writes at a fixed instant (`2026-10-28T10:15:00Z`) and
expect the queued write one hour after it, but they ran on the real clock. The quota only queues
while the oldest write is less than an hour old; once real time passed 11:15 UTC on the day they were
written, the slot came out as "now" and both tests failed — on every branch, including ones that never
touched the memory code.

## Fix

Freeze the clock inside the window in those tests:
`vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-28T10:30:00Z') })`, undone with
`onTestFinished(() => vi.useRealTimers())`. Faking only `Date` keeps promises and timers real. Any
fixture with a hard-coded timestamp that the code compares to `Date.now()` needs the same.

## How to check

`npx vitest run --root apps/server src/control/lessons.test.ts src/control/memory.test.ts` passes at
any time of day.
