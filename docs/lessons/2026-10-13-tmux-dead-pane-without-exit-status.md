---
symptom: "FAIL ai-login.real.test.ts > claude: \"Login successful\" with exit 0 is a login when the status cannot answer (TER-1054) — Error: Opening browser to sign in… Paste code here if prompted > Login successful."
tags: [ci, flaky-test, tmux, agent, ai-login]
evidence: fixed
card: TER-1077
agent: claude
date: 2026-10-13
---
## Cause

tmux marks a pane dead (`#{pane_dead}` = 1) as soon as it reads EOF on the pty, but fills in
`#{pane_dead_status}` only when it reaps the process on SIGCHLD (`server_child_exited` sets
`PANE_STATUSREADY`). On a loaded machine a `display-message` can land between the two, so `paneState`
in `apps/agent/src/rpc/ai-login.ts` read "dead, exit status unknown". The TER-1054 rule takes a CLI
at its word only when it exited 0 *and* printed "Login successful", so a status-less dead pane turned
a finished login into a failure whose message holds the success line. It blocked the deploy of #490
(run 38203826908) and the CI of #491. Not the same race as
`2026-10-10-tmux-dead-pane-loses-last-line.md`: here the text is complete, the exit code is missing.

## Fix

`paneState` re-reads a dead pane without a status every 50 ms for up to 1 s (`DEAD_STATUS_POLLS`)
before it answers. A CLI killed by a signal never gets a status and still reads as `null` after that.

To reproduce it on purpose, a fake CLI that runs `trap '' HUP`, closes its fds
(`exec 0<&- 1>&- 2>&-`) and exits 0 a moment later keeps the pane dead without a status for that
long (test "a dead pane whose exit status lands a moment later…"). Without the trap, tmux closing
the pty sends SIGHUP and the pane gets a signal instead of an exit status.

## How to check

`npx vitest run src/rpc/ai-login.real.test.ts` in `apps/agent` (needs tmux): the TER-1077 test
fails without the fix and passes with it; 12 passed, 5 runs in a row in `node:22` with tmux 3.3a.
