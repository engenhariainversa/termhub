---
symptom: "check job ends with \"##[error]The operation was canceled.\" while stuck in `sudo apt-get update` (Instalar tmux)"
tags: [ci, github-actions, apt, timeout]
evidence: fixed
card: TER-1023
pr: https://github.com/engenhariainversa/termhub/pull/441
agent: claude
date: 2026-10-07
---
## Cause

Not the code under test. In the `check` job the "Instalar tmux" step ran `sudo apt-get update`, and
the GitHub-hosted runner's Ubuntu mirrors (`azure.archive.ubuntu.com`, then `archive.ubuntu.com`)
stopped answering mid-fetch. apt's default timeouts let it wait about 14 minutes, until the job's
`timeout-minutes: 15` cancelled the whole run. The only error in the log is "The operation was
canceled." The repeated `FATAL: role "root" does not exist` lines printed when the Postgres service
container is torn down are unrelated noise.

## Fix

In `.github/workflows/check.yml` the step now:

- first tries `apt-get install -y tmux` without `update` (the runner image's package index is usually
  fresh enough), and runs `update` only if that install fails;
- sets `Acquire::Retries=3` and `Acquire::http(s)::Timeout=20` so a dead mirror fails fast and is retried;
- has `timeout-minutes: 5`, so a hang shows up as a failed step with a clear name instead of a
  cancelled job.

## How to check

In the job log the "Instalar tmux" step finishes in seconds. If a mirror hangs again, the step itself
fails within 5 minutes, and a re-run (`gh run rerun <id> --failed`) is the remedy.
