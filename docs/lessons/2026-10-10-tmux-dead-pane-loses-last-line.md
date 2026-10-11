---
symptom: "AssertionError: expected 'Opening browser to sign in...' to contain 'invalid_grant' (ai-login.real.test.ts, CI e Deploy blocked)"
tags: [ci, flaky-test, tmux, agent, ai-login]
evidence: fixed
card: TER-1055
agent: claude
date: 2026-10-10
---
## Cause

The deploy of PR #478 (run 37874723262) failed in "Testes agent", in a test unrelated to that PR:
`ai-login.real.test.ts > claude: a bad code fails with the CLI message`. The fake `claude` is a shell
script that prints its error and exits at once. tmux can mark the pane dead before it has read the
script's last bytes off the pty, so the capture taken after the exit missed the final
`OAuth error: invalid_grant` line. It failed once in 60+ runs. The real CLIs (Node) take far longer
to exit after their last line, so the error shown to the person is not affected in practice.

## Fix

The fake CLIs whose output a test reads after they exit (`fakeClaude` on a bad code, `FAILING_CLAUDE`)
`sleep 0.3` before `exit 1`. Test only; no agent release.

A flaky test on `main` blocks the deploy of everything merged after it: check whether the failing
test touches the merged PR's files before treating it as a regression. Re-running the failed run (or
the next push to `main`) deploys the same commit.

## How to check

`npx vitest run src/rpc/ai-login.real.test.ts` in `apps/agent` (needs tmux), several times in a row:
9 passed every time.
