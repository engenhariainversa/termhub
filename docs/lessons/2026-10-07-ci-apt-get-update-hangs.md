---
symptom: "check job: \"The job has exceeded the maximum execution time of 15m0s\" while stuck in sudo apt-get update"
tags: [ci, github-actions, apt, flaky]
evidence: fixed
card: TER-466
pr: https://github.com/engenhariainversa/termhub/pull/444
agent: claude
date: 2026-10-07
---
## Cause

Not the code under test. In the `check` job, the "Instalar tmux" step ran `sudo apt-get update` on
the GitHub-hosted runner; the azure Ubuntu mirror was ignored, the fallback `archive.ubuntu.com`
answered the first `InRelease` files and then stalled on `noble-security InRelease` with no output
for 13 minutes. apt's default timeouts let it wait, so the job hit `timeout-minutes: 15` and was
cancelled. The `FATAL: role "root" does not exist` lines in the Postgres service log are only the
service healthcheck and show up in green runs too; they are not the cause.

## Fix

`.github/workflows/check.yml`: the apt step passes
`-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=3` to `apt-get update`
and `install`, so a stalled mirror request fails over and moves on, and the step has its own
`timeout-minutes: 4` so a hang shows up as a failed apt step instead of a whole-job timeout.

## How to check

In the failed run, `gh run view --job=<id> --log` shows the last line of the apt step minutes before
`##[error]The operation was canceled.` After the fix, the "Instalar tmux" step finishes in seconds
and the job completes in its usual ~8 minutes.
