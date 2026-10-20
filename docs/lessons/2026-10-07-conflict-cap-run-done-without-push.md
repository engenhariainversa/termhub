---
symptom: "PR escalated for conflict_cap is never merged after a later run reports it updated, conflict-free and green"
tags: [automation, merge, conflict_cap, report_card]
evidence: fixed
card: TER-1016
agent: claude
date: 2026-10-07
---
## Cause

The escalation was not what held the merge. A `conflict_cap` escalation is keyed by the PR head
(`conflict_cap:<sha>` marker run) and the merge executor re-reads the PR on every pass. On #397 the run
that came after the escalation (14:03–14:14) called `report_card done` saying the PR was up to date with
`main`, conflict-free and green, but it never pushed: the head stayed `a058efd`, which still conflicted
with `main` (`apps/web/src/lib/api.ts`). GitHub kept answering `mergeable: false`, so the executor kept
the PR on the conflict path. The merge commit that resolved it (`df95ae8`) only reached GitHub at 14:41.

The feed showed `run_done` and `pr_opened` after the escalation and nothing else, so the PR looked done.

## Fix

The executor now tells the person once more per head (`escalated`, `cause: run_done_no_push`) when a run
of the card ends after the conflict escalation and the head did not move (past `NO_PUSH_GRACE_MS`, no run
on). The queue and the feed name the escalated head ("Escalado por conflito em a058efd; aguardando um push
que resolva").

## How to check

Compare the PR head with the escalated `sha` before assuming the escalation is stuck:
`gh pr view <n> --json headRefOid,mergeable,commits` and
`git merge-tree --write-tree --name-only <sha> origin/main` (a `CONFLICT` line means the head really
conflicts). `src/automation/merge.test.ts` replays the #397 sequence.
