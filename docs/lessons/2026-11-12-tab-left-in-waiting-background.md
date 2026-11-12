---
symptom: "A tab the chat watches ends its turn in waiting_background, its background work ends, and nothing wakes the chat: the next step started ~14 h late, when the person asked"
tags: [watch, waiting_background, health, concierge]
evidence: fixed
card: TER-1168
agent: claude
date: 2026-11-12
---
## Cause

drhorton, 12/11: the APPS-456 tab's last event was a `Stop` into `waiting_background` at 03:06 UTC; the next one came at
16:55, when the person typed in it. Two tab watches of the chat were open on it, both with the default events.

1. The default tab events are every stop *but* `waiting_background` (`TAB_DEFAULT_EVENTS`,
   `apps/server/src/chat/watches/kinds.ts`), and a tab watch only fires on an event written after its cursor
   (`evaluateTab`, `chat/watches/evaluate.ts`). Claude Code writes no hook when its background work ends unless it starts
   a turn, so the tab sat in `waiting_background` with nothing left to do and nothing to fire on.
2. The health watcher's `tab_stuck` looked only at `working`, and `tab_waiting` lists the states that wait on a
   person (`chat/health/signals.ts`), which `waiting_background` is not.

## Fix

- A tab watch tells a tab in `waiting_background` with no event for 20 min (`BACKGROUND_QUIET_MS`) as a stop, once per
  stretch, whatever events it asked; the wake says the background work may have ended without waking the agent.
- `tab_stuck` also covers `waiting_background`, with its own minutes (default 30) and sentence.

## How to check

`select created_at, kind, meta->>'event' from tab_events where tab_id = '<id>' order by created_at` (metadata only): a
last row `waiting_background` / `Stop` hours old with an open tab watch is this case. It now fires 20 min after that row.
