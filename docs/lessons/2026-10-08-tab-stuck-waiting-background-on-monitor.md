---
symptom: "a Claude Code tab ended its turn with a final report but stays waiting_background (\"still working\") for hours; the chat never says it finished"
tags: [monitor, hooks, background, claude-code, monitor-tool]
evidence: fixed
card: TER-1053
agent: claude
date: 2026-10-08
---
## Cause

Claude Code's `Stop` hook sends `background_tasks`, and the server read any entry with
`status: "running"` as "the agent waits on that work" (TER-644): the tab went to `waiting_background`,
which counts as still working, so nothing alerted. A `Monitor` (or a `gh pr checks --watch` started
with `run_in_background`) can run for ever. Claude Code itself considered the turn over. The screen
said `✻ Crunched for 2m 3s · done 5:27 PM · 1 monitor still running` with the input box below it, but
no further hook arrives, so the tab never left `waiting_background`. The machine's agent version
(0.19.0) and the hooks were not involved: the `Stop` arrived with the answer and
`background_tasks: [{ type: "monitor", status: "running" }]`.

## Fix

- `monitor/turn-end.ts` `classifyBackgroundTurnEnd`: a `Stop` with background work running stays
  `waiting_background` only when its message says it waits on that work ("aguardando o CI", "te aviso
  quando terminar", "I'll check once it finishes") or is blank. Any other message reads like a `Stop`
  with nothing running: `finished` for a report, `waiting_input` for a request. Both alert.
  `meta.background_tasks` keeps the count, and `wait_for_state` adds a note that background work is
  still running.
- `monitor/stale-working.ts`: a Claude tab `waiting_background` with no hook event for
  `MONITOR_BACKGROUND_TIMEOUT_MINUTES` (default 20, 0 turns it off) whose screen is Claude Code's
  prompt and does not change between two sweeps reads as the end of the turn (`BackgroundTimeout`
  event).

## How to check

Start a `Monitor` (or `run_in_background` a `sleep 9999`) in a Claude Code tab and end the turn with a
plain report. The tab goes to `finished` (or `waiting_input` if the report asks something) at once,
and its last `tab_events` row is a `Stop` with `background_tasks: 1`. A tab whose message says it waits
leaves `waiting_background` about `MONITOR_BACKGROUND_TIMEOUT_MINUTES` + 3 minutes later, with a
`BackgroundTimeout` row and the log line `monitor: background wait timed out`.
