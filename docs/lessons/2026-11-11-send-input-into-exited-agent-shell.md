---
symptom: "The concierge says \"Te aviso quando…\" after send_input answered sent: true, but the tab's agent had exited: the text ran in the shell (syntax errors) and the tab watch waited until it expired"
tags: [send_input, watch, monitor, concierge, health]
evidence: fixed
card: TER-1168
agent: claude
date: 2026-11-11
---
## Cause

Three gaps, each one harmless alone:

1. `sendInput` (`apps/server/src/control/terminals.ts`) answered `sent: true` once `tmux send-keys` ran. It only
   refused a permission wait and, since TER-1166, a CLI dialog. It never looked at what runs in front of the pane, so a
   tab whose Claude Code had exited took the text into its shell.
2. A tab whose agent exited reads as `idle` only when a hook said so (`SessionEnd`), or when the stale sweep found
   the pane back at its shell while the tab was `working` (`AgentExited`, TER-643). An agent killed while the tab
   rested (`finished`, `waiting_input`) left it in that state for good: nothing re-read the pane of a tab at rest.
3. A tab watch (`chat/watches/evaluate.ts`) only fires on `tab_events` written after it was created. A watch on a
   tab whose agent was already gone, or on a text that never started a turn, waits for an event that never comes,
   until it expires (24 h by default).

`wait_for_state` right after the send does not help: on a tab at rest it answers at once with the old state.

## Fix

- `monitor/agent-gone.ts` reads "agent tab" (hooks reported, or termhub started it) and "agent gone" (`idle` whose
  newest event is `SessionEnd`, `sessionEnd` or `AgentExited`) in one place.
- `send_input` and `send_key` (MCP) check `tmux.foreground` first and fail with `AGENT_NOT_RUNNING` when an agent tab
  is back at its shell; `to_shell: true` types into the shell on purpose. Into an agent at rest, `send_input` waits up
  to 15 s for a turn to start and answers `delivered` (with `reason` and `note` when it is false). A failed delivery is
  kept in memory (`terminal/deliveries.ts`) for the tab's watches.
- `sweepDialogs` reads the pane of resting Claude/Codex tabs before their screen: back at the shell, the tab becomes
  `idle` with `AGENT_LEFT_TEXT` (no resume card, no restart of a run: the turn had ended).
- A tab watch fires `gone` with `reason: agent_exited` (gone before or after the watch) or `not_delivered`.
- The health watcher has a new `agent_exited` signal for a tab a card in Fazendo points at, or a watch follows
  (then `told_elsewhere`: the watch already woke the chat).
- The orchestrator prompt had 1 character left (lesson 2026-11-06-orchestrator-prompt-budget), so the "promise only
  after `delivered: true`" rule is in the `send_input` and `watch` descriptions.

No new agent release: `tmux.foreground` exists since @termhub/agent 0.14.0. On an older agent the check is skipped,
never a refusal.

## How to check

`npx vitest run src/control/terminals.test.ts src/chat/watches src/health src/monitor/stale-working.dialogs.test.ts
src/mcp/tools.send-input.test.ts` in `apps/server`. By hand: start Claude Code in a throwaway tab, `/exit` it, then
`send_input` into the tab: `AGENT_NOT_RUNNING`, and nothing reaches the shell.
