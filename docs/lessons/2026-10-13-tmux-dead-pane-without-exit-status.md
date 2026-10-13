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
`#{pane_dead_status}` only when it reaps the process on SIGCHLD. `paneState` in
`apps/agent/src/rpc/ai-login.ts` could read "dead, exit status unknown", and the TER-1054 rule takes
a CLI at its word only when it exited 0 *and* printed "Login successful", so a finished login came
back as a failure whose message holds the success line. It blocked the deploy of #490
(run 38203826908) and the CI of #491.

The gap is not always short. tmux before 3.6, when built with utempter (Ubuntu 24.04's 3.4, the CI
runner; Debian's 3.3a), calls `utempter_remove_record` when the pty closes, and libutempter sets
SIGCHLD to `SIG_DFL` while it forks and waits for its helper. A pane process that exits inside that
window loses its SIGCHLD: tmux does not reap it, and the status stays empty until some other child of
the server exits. tmux 3.6 sends itself a SIGCHLD right after for that reason. A first fix that only
waited up to 1 s for the status still failed on CI (the test ran 1 s longer, then failed the same way).

Measured in `ubuntu:24.04` (tmux 3.4) under CPU load, one pane per server: 65 dead panes read without
a status, all 65 still without one 1.5 s later, all 65 with one right after `tmux run-shell true`.
With many panes per server the other panes' exits rescue it within ~100 ms, which hides the bug.

Not the same race as `2026-10-10-tmux-dead-pane-loses-last-line.md`: here the text is complete, the
exit code is missing.

## Fix

`paneState` re-reads a dead pane without a status, up to 20 times 50 ms apart, each read after
`tmux run-shell true`: that job's exit makes tmux run `waitpid(WAIT_ANY)`, which reaps the pane too.
A CLI killed by a signal never gets a status and still reads as `null`.

The test "a dead pane whose exit status lands a moment later…" holds the pane dead without a status
on purpose: the fake CLI runs `trap '' HUP`, closes its fds (`exec 0<&- 1>&- 2>&-`) and exits 0
0.4 s later. Without the trap, tmux closing the pty sends SIGHUP and the pane gets a signal instead of
an exit status. The lost SIGCHLD itself cannot be forced from a test; the probe above is the evidence.

## How to check

`npx vitest run src/rpc/ai-login.real.test.ts` in `apps/agent` (needs tmux): the TER-1077 test
fails without the fix and passes with it; 12 passed in 10 runs in a row under CPU load in `node:22`
(tmux 3.3a).
