---
symptom: "check job cancelled after 15 minutes on step \"Instalar tmux (teste e2e do agente)\", no test failed"
tags: [ci, github-actions, apt]
evidence: fixed
card: TER-1022
pr: https://github.com/engenhariainversa/termhub/pull/439
agent: claude
date: 2026-10-07
---
## Cause

`sudo apt-get update && sudo apt-get install -y tmux` hung on an Ubuntu mirror for ~13 minutes on a
GitHub-hosted runner. The step had no timeout of its own, so the job-level `timeout-minutes: 15`
cancelled the whole `check` job and every test after it was skipped. Runs started minutes before
and after passed: the hang is transient, not caused by the PR's code. `gh run view --log-failed`
prints nothing for a cancelled job; read the step list with
`gh run view <id> --json jobs --jq '.jobs[].steps[]'` to see which step was cancelled.

## Fix

In `.github/workflows/check.yml`, skip the install when `tmux` already exists, and run
apt inside `timeout 180` with `Acquire::Retries=3`, retrying up to three times.

## How to check

The "Instalar tmux" step finishes in seconds; a slow mirror shows
"apt falhou ou travou (tentativa N)" in its log instead of eating the job's timeout.
