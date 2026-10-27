---
symptom: "Merge queue stopped in silence by a red base (TestFlight without a runner): green PRs with no conflict sat unmerged for days, queue says \"Branch base vermelha\", nothing in the feed"
tags: [automation, merge, github-actions, runner]
evidence: fixed
card: TER-1120
agent: claude
date: 2026-10-27
---
## Cause

The base head (a merge that touched native mobile files) started "Mobile TestFlight (hulk)", a workflow on
a self-hosted runner that was not registered on the repository. Its job sat in the queue with no runner
and GitHub cancelled it after 24 h (`conclusion: cancelled`). The merge executor's `baseState`
(`apps/server/src/automation/merge.ts`) only forgave a `cancelled` run of the deploy workflow or of a
`release_workflows` entry, so the base counted as red (`merge_base_red`) and every PR into it waited.
That wait was only ever written to the in-memory queue reasons: no event, no push, no chat line, so six
green PRs (#526–#531) waited from 22 to 27/10 without anyone being told.

## Fix

- A run cancelled before any job got a runner (every job of `runJobs` with no `runner_name` and no step)
  delivered nothing: it no longer makes the base red, and a `workflow_no_runner` event plus a chat line say
  "workflow X ficou sem runner", once per run.
- A base that stays red while holding a ready PR for `BASE_RED_ESCALATE_MS` (15 min) is escalated once per
  base head (`escalated`, reason `merge_base_red`, with the workflow and its run; unique index
  `automation_events_base_red_once`): push needs_you, chat line, and the project's chat is woken.
- The Setup warns about workflows that only a push to the base runs and that are neither the deploy, a
  release workflow nor a required check (`GET /projects/:id/automation/workflows`).

The runner itself (register it again, or turn the workflow off) is the owner's decision, outside this fix.

## How to check

`list_automation_queue` / the web queue shows "Branch base vermelha: <workflow>"; the feed has a
"precisa de você" line with the base head and workflow 15 minutes after a ready PR started waiting; a
cancelled-without-runner workflow on the base shows the "cancelado sem runner" line and the PR merges.
