---
symptom: "Refazer login on a Mac: \"The login was not confirmed\" while the modal's CLI output reads \"Opening browser to sign in… Paste code here if prompted > Login successful.\" (agent 0.29.0)"
tags: [ai-login, claude-cli, agent, macos, keychain, tmux, ssh]
evidence: fixed
card: TER-1078
agent: claude
date: 2026-10-13
---
## Cause

Not the agent version this time (compare `2026-10-12-login-not-confirmed-was-an-outdated-agent.md`):
the machine ran 0.29.0, which already has every TER-1054 fix. The CLI did log in, but the agent's
`claude auth status` said logged out.

On macOS, Claude Code keeps the credentials in the login keychain and reads them **keychain first, then
`<config dir>/.credentials.json`**. It writes the file only when the keychain write fails. Which of the
two a process sees depends on the macOS security session it runs in:

- That Mac's tmux server had been started over SSH (`tmux show-environment -g` shows `SSH_CONNECTION`).
  Inside it the login keychain is locked: `security show-keychain-info` answers
  `User interaction is not allowed.` So `claude auth login`, run in a hidden session of that server,
  saved the new login to `.credentials.json`. The terminal tabs run there too and use that file.
- The agent is a launchd agent in the GUI session (`launchctl print gui/$UID/dev.termhub.agent`), where
  the keychain is unlocked. Its `claude auth status`, run as the agent's own child, read the keychain's
  stale item and said logged out. Status said logged out, which outranks "Login successful" since
  0.28.1, so the agent returned the pane text as the failure.

On jarvis (Linux) there is no keychain, everything uses the file, and the same flow works. A Mac whose
tmux server was started from the GUI (Terminal, or the agent itself) also works: there both sides see
the keychain.

## Fix

Agent 0.29.2 (`apps/agent/src/rpc/ai-login.ts`): the status command runs in a hidden
`termhub-login-status-*` session of the tmux server, with the same environment as the login. It is
never run as the agent's own child. Its stdout, stderr and exit code come back through files in a temp
dir. When tmux cannot start the session, the agent runs the command itself as before. The status now
answers from the same place the login and the tabs run, whatever session started tmux.

## How to check

- `npx vitest run src/rpc/ai-login.real.test.ts` in `apps/agent` (needs tmux). The fake CLI of the
  "a status that only the tmux server sees logged in" tests says logged in only when `$TMUX` is set.
  With the old `askStatus` those tests fail with the card's symptom.
- On the Mac, with the agent at 0.29.2: Refazer login, sign in in the browser that opens. The modal
  shows "Login refeito" and the account's warning goes away.
- To tell whether a Mac is in this state: inside a termhub tab, `security show-keychain-info` answers
  `User interaction is not allowed.` while the agent runs under `gui/<uid>`.
