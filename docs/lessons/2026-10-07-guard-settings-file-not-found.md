---
symptom: "Error: Settings file not found: ~/.termhub/tabs/<tab>/guard.json — an automatic run never starts and is escalated as trust_prompt"
tags: [automation, guard, agent, launch-line]
evidence: fixed
card: TER-1005
agent: claude
date: 2026-10-07
---
## Cause

Two bugs on top of each other, on hulk with `@termhub/agent` 0.18.0 (no `termhub-guard`):

1. `startAgent` correctly skipped writing `guard.json` on an agent older than 0.19.0 (`guardSupported`
   false, `guardTabId` null), but `launchLine` fell back to the memory MCP's tab id:
   `guardTabId ?? mcp?.tabId`. Any tab with the MCP installed got `--settings …/guard.json` for a file
   nobody wrote, and Claude Code refused to start. `resumeLine` / `continueLine` had the same shape
   (the MCP tab id passed as the guard tab id), so a resume could also name a missing file — or, with no
   live MCP token, drop the guard silently.
2. The follower's start watchdog read "no hook at all for 3 minutes" as Claude's folder-trust question
   and escalated `trust_prompt`, though the pane was back at the shell with the error.

## Fix

- The guard tab id is explicit everywhere; no fallback to the MCP tab id.
- `installRunGuard(machine, tabId, permission)` in `apps/server/src/control/agents.ts` writes
  `guard.json` and returns the id for `--settings`; it throws `GUARD_UNSUPPORTED` ("Atualize o agente…")
  on an agent before 0.19.0. Start, the exited-agent restart, the resume card and the account swap use it.
- The dispatcher's placement treats a machine without the guard as not capable (`no_guard`), and the
  queue's capable-machine count requires 0.19.0: automatic work never runs without the lock.
- The watchdog asks `paneForeground` first: a pane at its shell escalates `agent_not_started`.

## How to check

`list_automation_queue` on a project whose only machine runs agent 0.18 shows "Nenhuma máquina com
agente 0.19 ligada ao projeto; atualize o agente". On 0.19.0, a started run's tab has
`~/.termhub/tabs/<tab>/guard.json` and its launch line carries `--settings` with that path.
