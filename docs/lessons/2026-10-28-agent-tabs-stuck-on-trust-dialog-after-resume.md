---
symptom: "Agent tabs sat for hours on Claude Code's \"Is this a project you created or one you trust?\" in the project's own folder, though TER-1117 answers it there"
tags: [monitor, claude-code, trust, account-swap, resume, health]
evidence: fixed
card: TER-1148
agent: claude
date: 2026-10-28
---
## Cause

Claude Code keeps folder trust per account (`projects[<dir>].hasTrustDialogAccepted` in each config dir's
`.claude.json`), so a folder trusted under one account asks again under another. TER-1117 only covered part
of the ways an agent comes up in a tab:

- `start_agent` and "Iniciar sessão" read the screen for 40 s only; a slower start was left to the sweeps.
- The account swap resumed the session under the new account with no screen read at all, and on purpose
  left the dialog to the person (`waiting_input` with "confirme na aba"). No sweep reads a `waiting_input`
  tab for the dialog, so nothing told anyone.
- The resume of an exited agent (`typeCommandInTab`, from the chat card or the follower) had no screen read
  either, and the tab stayed `idle`.
- Only a tab with `cwd` null counted as the project's folder: the link's folder spelled out, or a run's
  worktree after a swap, was reported instead of answered.
- A dialog whose cursor sat on "No, exit" was never answered (Enter there closes the agent), only reported.
- A `trust_prompt` tab of a run left the run `running` forever (the follower only acts on `waiting_input`
  and `idle`), and the health watcher treated it as a concierge-level `tab_waiting` after 10 minutes.

## Fix

- Agent 0.37.0: RPC `claude.trustFolder` marks a folder trusted in every Claude account of the machine
  (plus the account dirs the server names), as worktrees already were (TER-1025).
- `monitor/folder-trust.ts`: `pretrustFolder` calls it right before Claude starts or resumes in a tab
  (start_agent, "Iniciar sessão", account swap, resume after exit) when the folder is the project link's or
  the tab's run worktree and `agent.trust_project_folder` is on; `trustedFolderOf` is the one rule for which
  folder the server may trust; a cursor on "No" is moved up (at most 3 times, re-reading the screen) and
  Enter goes only once "Yes" shows selected; the launch follow now also runs after a swap and a resume, and
  reads the screen up to 180 s.
- `automation/follower.ts`: a run's tab in `trust_prompt` for 2 minutes parks the run (`needs_person`,
  escalated `trust_prompt`), so it counts as blocked.
- `health/signals.ts`: a `trust_prompt` tab opens `tab_waiting` as `needs_you` after 2 minutes (push).

## How to check

`npm test -w @termhub/server -- folder-trust stale-working account-swap follower signals` and
`npm test -w @termhub/agent -- claude-trust`. On a machine with agent 0.37.0, start an agent in a project
folder no account has opened: the server log shows `monitor: folder trusted before the agent start` and the
dialog never appears; with an older agent, the feed shows "pasta do projeto confiada sozinha".
