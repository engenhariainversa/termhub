---
symptom: "CI check job ends with \"The operation was canceled.\" during \"Instalar tmux\" (sudo apt-get update), after every test before it passed"
tags: [ci, github-actions, apt, flaky]
evidence: fixed
card: TER-586
pr: https://github.com/engenhariainversa/termhub/pull/432
agent: claude
date: 2026-10-07
---
## Cause

`sudo apt-get update` in the `check` job stalled on an Ubuntu mirror (`archive.ubuntu.com`) and made
no progress until the job's 15-minute `timeout-minutes` canceled the run. Nothing in the code was
wrong; runs started at the same time on other branches finished in about 7 minutes. The log tail is
full of `FATAL: role "root" does not exist` from the Postgres service healthcheck, which is noise and
hides the real last step.

## Fix

The step now passes `Acquire::Retries` and `Acquire::http(s)::Timeout` to apt and has its own
`timeout-minutes: 5`, so a stalled mirror retries or fails that step quickly instead of eating the
whole job budget. A re-run (or a new push) passes once the mirror recovers.

## How to check

`gh run view <run> --job <job> --log | grep -v 'role "root"' | tail -40` shows the last real step;
if it is the apt step followed by "The operation was canceled.", it is this mirror stall.
