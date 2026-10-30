---
symptom: "The chat's machine went offline in the middle of the answer. Turn it on and send the message again. — with the machine online; agent log: dropped invalid server message {\"issues\":1}"
tags: [chat, concierge, prompt, agent, protocol]
evidence: fixed
card: TER-1154
agent: claude
date: 2026-10-29
---
## Cause

A project chat's system prompt is `ORCHESTRATOR_PROMPT` (3991 chars) plus the project prompt
(`projectSystemPrompt`), and the agent protocol caps `append_system_prompt` at 8000. The project
prompt was meant to stay under 4000, but only the machine list gave way: the default allowances,
standing grants, command rules, groups and the current rules block (up to 1000) together could pass
4000 on their own (4115 chars with a full rules block, all grants, five command rules and one group).
Once a few new project rules filled the rules block, every open frame went over 8000.

The agent validates every server message with zod and drops an invalid one with only
`dropped invalid server message {"issues":1}` in `~/.termhub/agent.log`. No `opened` came back, the
server's open timed out after 10 s, and `agent-runner.ts` reported every failed open as `host_gone`.
So each message showed "the chat's machine went offline" while the agent stayed connected. The 905k
context fill on screen at the same moment had nothing to do with it.

## Fix

- `projectSystemPrompt` keeps the whole prompt under 4000: when the optional lines crowd out the
  machine list, they give way in order (groups, command rules, rules trimmed at a rule's end with
  "… (outras em search_memory)", standing grants, default allowances).
- `agent-runner.ts` checks the open params against `claudeOpenParams` before sending and fails the
  run as `run_failed` (logging only the field path). An open that fails while the machine is still
  connected is `run_failed`, not `host_gone`.

## How to check

`DATABASE_URL=postgresql://x:x@127.0.0.1:1/x npx -w @termhub/server vitest run src/chat/project-prompt.test.ts src/chat/agent-runner.test.ts`
passes. On a machine, `grep "dropped invalid server message" ~/.termhub/agent.log` should stay quiet
after a chat message.
