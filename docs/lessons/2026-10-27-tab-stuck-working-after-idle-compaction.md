---
symptom: "a Claude Code tab stays \"trabalhando\" for days; its screen is back at the prompt under \"Compacted while idle, before the prompt cache expired\""
tags: [monitor, hooks, compaction, claude-code, stale-working]
evidence: fixed
card: TER-1133
agent: claude
date: 2026-10-27
---
## Cause

Claude Code compacts a conversation on its own while it sits at the prompt, shortly before the prompt
cache expires (about an hour after the turn ended). It prints "● Compacted while idle, before the prompt
cache expired · turn off with "idleCompaction": false in settings.json" and fires a `SessionStart` hook
with `source: "compact"`, and nothing after it: no `UserPromptSubmit`, no `Stop`. The server read every
`SessionStart` as `working`, so a tab that had ended its turn (`finished`, `waiting_input`) went back to
`working` and nothing took it out again. A `/compact` the person types at the prompt does the same.

How it was confirmed without any content: `read_last_answer` on the stuck tabs said `stale: false`, so
the only working events newer than the last answer were `SessionStart` (or a subagent's), and the
answer's time was about an hour before the tab's `state_at`.

The screen sweep (`monitor/stale-working.ts`, TER-615) should have read those tabs as `waiting_input`
after 3 minutes, but did not. It listed only the 50 oldest stale tabs, and tabs that stay on that list for
good (on offline machines, Codex tabs) can fill it, which keeps every newer one out of every pass. This
part is likely but not proven: it was not checked against the production logs.

## Fix

- `monitor/state.ts` keeps the `SessionStart` `source` in the event's meta, and `monitor/wait-decision.ts`
  drops a compaction (`compaction_at_rest`) while the tab is in any state other than `working`, `idle` or
  none. A compaction in the middle of a turn is still recorded.
- `monitor/stale-working.ts`: a Claude tab at its prompt whose last answer is not stale goes back to the
  turn end that answer stood for (`classifyTurnEnd`), with the answer as its text, without a new alert
  (`restoreTurnEnd`). This is what fixes the tabs that were already stuck.
- `listStaleWorking` lists up to 500 tabs (`STALE_WORKING_LIMIT`), and the sweep warns
  "monitor: stale working list is full" when it hits that limit.

## How to check

A finished Claude tab left idle for about an hour keeps its state after "Compacted while idle". A tab
that was already stuck shows "monitor: stale working tab back to its turn end" in the server log within a
few minutes of the deploy. If it does not, look for "monitor: stale working list is full" and "monitor:
stale working check failed".
