---
symptom: "CI check cancelled after 15 min at \"Instalar tmux\": apt-get update stuck after Ign: http://azure.archive.ubuntu.com ... InRelease; ##[error]The operation was canceled."
tags: [ci, github-actions, apt, tmux, flaky]
evidence: fixed
card: TER-583
pr: https://github.com/engenhariainversa/termhub/pull/415
agent: claude
date: 2026-10-07
---
## Cause

The GitHub-hosted runner's Ubuntu mirror (`azure.archive.ubuntu.com`) stopped answering. apt fell back
to `archive.ubuntu.com`, fetched the `InRelease` files and then hung with no output. The step had no
timeout of its own, so it ran until the job's `timeout-minutes: 15` cancelled the whole `check` job.
The PR's code was not involved: `gh run view <id> --json jobs` shows every earlier step green and the
job `cancelled`, not `failure`, and `gh run view --log-failed` prints nothing.

## Fix

In `.github/workflows/check.yml`, the tmux step skips apt when tmux is already on the image, runs
`apt-get update`/`install` under `timeout 120` with `Acquire::Retries` and HTTP timeouts, retries up to
three times, and has a step-level `timeout-minutes: 8`, so a stuck mirror costs minutes and a retry
instead of the whole run.

## How to check

The "Instalar tmux" step finishes in seconds on a healthy mirror; on a bad one its log shows
`apt-get failed or timed out (attempt N); retrying` instead of a silent hang until cancellation.
