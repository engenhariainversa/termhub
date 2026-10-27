---
symptom: "Automatic card's PR sits open forever: no merge, no approval card, no fixer, nothing in the feed (ci_state none)"
tags: [automation, merge-executor, ci, github]
evidence: fixed
card: TER-1114
agent: claude
date: 2026-10-22
---
## Cause

The merge executor (`apps/server/src/automation/merge.ts`, `handlePull`) returned right away when the PR's
`ci_state` was `none` (no workflow run on its head), before any other check. A repository with no workflow
on `pull_request` (project STA) has every PR at `none`, so nothing ever happened and nothing said why. The
same early return also skipped the mergeability check: GitHub runs no `pull_request` workflow on a PR in
conflict, so a conflicting PR is often `none` too, and its conflict never got a fixer (STA #27, #30 × #31).

## Fix

- The mergeability check (`gh.pull` → `onConflict`) runs before the CI gate, so a conflict gets its fixer
  whatever the CI says (`none`, red or running).
- `ci_state` `none` on the same head for `NO_CI_GRACE_MS` (5 min, so a fresh push whose runs GitHub has not
  queued yet is not reported) sets the queue reason `merge_no_ci` and records one `escalated`
  (`reason: merge_no_ci`) per PR head (`onNoCi`).
- The Setup and `get_automation_policy` warn when no workflow of the repository ever ran on
  `pull_request`/`pull_request_target` and the autonomy is merge or above (`automation/pr-ci.ts`).

## How to check

`apps/server/src/automation/merge.test.ts`, "a PR with no CI at all (TER-1114)". In production: a project
without PR CI shows "PR sem CI; o termhub não mescla sem CI verde" in the automation queue and one
escalation per PR head in the feed.
