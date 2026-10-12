---
symptom: "Refazer login still fails after the fix shipped: \"The login wasn't confirmed.\" with \"CLI output: Opening browser to sign in… Paste code here if prompted > Login successful.\""
tags: [ai-login, claude-cli, agent, agent-version, macos]
evidence: fixed
card: TER-1054
agent: claude
date: 2026-10-12
---
## Cause

The report read as "the status check after the login does not recognise the result", and the card listed
suspects in that direction (`claude auth status` missing, a wrong `CLAUDE_CONFIG_DIR`, the macOS keychain).
None of them was it. `claude auth status` exists, prints JSON with `loggedIn` by default and is run with
the same config dir as the login.

The machine was simply still on agent **0.26.0**, and the fix for a login finished in the machine's own
browser is agent 0.27.0 (`docs/lessons/2026-10-08-claude-login-finishes-in-machine-browser.md`). The app
and the web were new (OTA, deploy), the agent was not: 0.26.0 reads every exit of `claude auth login` as a
failure and sends the pane text back, and the new modal showed that text as "Saída da CLI" under "O login
não foi confirmado". New screens over an old agent look exactly like a broken fix.

## Fix

- Server (`apps/server/src/ai/login.ts`): when `ai.login.start` fails on the machine (`MACHINE_FAILED`),
  it asks `ai.login.status` (in every agent with `ai_login`) before giving up. Logged in → the start
  answers `logged_in: true`, the account is `ok` at once and the stuck tabs are listed, whatever the
  agent's version. Logged out → the failure stands, with the CLI output.
- Agent 0.28.1: when the status command cannot answer at all (a timeout, or a Claude Code without
  `auth status`), exit 0 together with "Login successful." is enough. A status that says logged out still
  wins.
- Since TER-1056 agents update themselves by default and the server has a minimum version, so a machine
  does not stay behind for days any more.

## How to check

Before reading a login failure as a bug in the flow, look at the machine's agent version (Máquinas, or
`list_machines`: `agent_version`, `below_min_version`) against the version that carries the fix.
`npx vitest run apps/agent/src/rpc/ai-login.real.test.ts` (needs tmux) covers the four CLI shapes: URL
and code, finished without a code, failure, and "Login successful" with no status command.
