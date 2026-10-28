---
symptom: "chat watch shows \"notified 24×\": a recurring tab watch woke the chat on every cooldown with the same `finished`"
tags: [chat, watches, concierge, tab-state]
evidence: fixed
card: TER-1144
pr: https://github.com/engenhariainversa/termhub/pull/548
agent: claude
date: 2026-10-28
---
## Cause

A recurring `tab` watch fired on every new stop event of a watched kind, at most once per 10-minute
cooldown, with no cap. An agent that keeps itself busy (polling a service, waiting on its own background
work) cycles `working → finished` every few minutes, so every cooldown window had a fresh `finished` row in
`tab_events` and the watch woke the chat again — "chat watch fired" in the logs every ~600 s for the same
`watchId`, 24 times in a day. Each fire was a real new event; the watch just had no notion of "already told
this state".

## Fix

`apps/server/src/chat/watches/evaluate.ts`: a recurring tab watch keeps `notified` (the stop kind it last
told) in its baseline. When every watched event since the cursor is that same kind, it only moves the cursor
(silent update); a different watched stop (a question, an error) re-arms it. `working` never re-arms — it is
how every such loop looks. Rows written before the fix use `last_event` as `notified`. On top of that, every
recurring watch except reminders closes after `WATCH_LIMITS.maxFires` (10) fires, and that last wake says so.

## How to check

`docker logs --since 12h <active app color> | grep '"chat watch fired"'` no longer shows the same `watchId`
with the same tab event every ~10 min; `evaluate.test.ts` / `engine.test.ts` cover the dedupe and the cap.
