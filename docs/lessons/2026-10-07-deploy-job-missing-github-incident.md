---
symptom: "deploy_failed: the deploy run failed with no failed step and no `deploy` job; automation of the project paused"
tags: [deploy, github, automation, incident]
evidence: fixed
card: TER-1025
agent: claude
date: 2026-10-07
---
## Cause

A GitHub incident (2026-10-07, about 15:06–16:25 UTC, Actions and Git operations degraded). The "CI e
Deploy" run of #412's merge commit ended `failure`, but none of its jobs had a step that failed and the
`deploy` job was never created: GitHub, not the code, failed the run. termhub treated every failed deploy
the same way and paused the whole project (`deploy_failed`). The same incident made `git push` answer
"remote: fatal error in commit_refs" / HTTP 500 and `gh pr create` answer "GraphQL: Something went
wrong", so agents reported blocked and the CI fixer ended without a push (`fixer_no_push` → `ci_cap`).

How to tell: open the run's jobs (`gh run view <id> --json jobs` or the API
`/repos/<repo>/actions/runs/<id>/jobs`). No jobs at all, or no step with `conclusion: failure`, or a
`startup_failure` conclusion, means GitHub never ran the code. https://www.githubstatus.com shows the
incident (its API: `https://www.githubstatus.com/api/v2/components.json`, component "Actions").

## Fix

TER-1025: `automation/release.ts` classifies a failed deploy first (`infraCause`: `startup_failure`, no
jobs, no failed step, or an Actions incident on githubstatus.com) and re-runs the same workflow run
(`POST /actions/runs/<id>/rerun`, never a newer commit) after 5, 15 and 30 minutes, up to
`automation.deploy_retries` (default 3), recording `deploy_retried`. Only a real failed step, or the last
try, pauses the project. Agents hand a GitHub error to the server with `report_card` blocked
`code: github_transient`; the run waits and is resumed once GitHub works again (`github_retries`).

By hand, while the automation is paused: wait for githubstatus.com to go green, then
`gh run rerun <id>` (the same run, the same SHA) and resume the project.

## How to check

The project's activity feed shows "Deploy falhou por problema do GitHub; rodando de novo" instead of a
pause, and `list_automation_events` has a `deploy_retried` event with `cause` (`no_jobs`,
`no_failed_step`, `startup_failure` or `github_incident`). A deploy that fails in a real step still
pauses at once.
