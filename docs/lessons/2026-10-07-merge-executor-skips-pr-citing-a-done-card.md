---
symptom: "Automatic merge stopped: green, conflict-free PRs of automatic cards (#396, #397, #408) sat unmerged for hours, with no error in the server log and the queue only saying \"Fora da coluna A fazer\""
tags: [automation, merge, github, pull-requests]
evidence: fixed
card: TER-1004
agent: claude
date: 2026-10-07
---
## Cause

A PR is linked to every card whose ref appears in its head branch, title **or body** (`cardsNamed` in
`apps/server/src/ci/sync.ts`), one `task_pull_requests` row per card. The merge executor (`candidateOf` in
`apps/server/src/automation/merge.ts`) skipped the whole PR, silently, as soon as any linked card was not
automatic ("a PR that names a card a person works on is merged by a person"). The three PRs cited old,
already-done manual cards in their text (#396 → TER-987, #397 → TER-11, #408 → TER-851), so they were never
candidates. Nothing was logged or recorded: `candidateOf` returning null looks the same as "not an automatic
PR". The executor was running all along (it kept updating #405), and the base branch and its deploy were
green. The 05:03 time was only the last merge (#407), not the moment something broke.

The same linking-by-mention put effects on the wrong cards:
- a merge moved **every** linked automatic card to done and recorded `merged` on each: #395 (TER-992's branch)
  cited TER-994, which went to done while its own PR #405 was still open;
- the deploy/release follower reported on whichever row came first for the PR number: the deploy of #394 (a
  person's PR on TER-991's branch) was recorded on TER-988, which it only cited. A failed deploy there would
  have paused the automation over a PR it did not make.

How it was found: `docker logs termhub-app-<color> | grep -i merge` (only #405 showed up), the base head's runs
(`gh api repos/<repo>/actions/runs?head_sha=<main sha>`, all completed/success), then a read-only query of
`task_pull_requests` for those PR numbers, which showed two or three rows each, one for a manual card.

## Fix

- `candidateOf`: the PR is the automatic card whose run worked on its head branch (the primary); the merge acts
  on that card alone (`tasks: [primary]`). Other cited cards are references: not moved, not told. A cited manual
  card blocks only while it is not done; a done or missing one does not.
- A PR held by a manual card that is not done is no longer silent: the queue shows `merge_person_card` ("O PR
  cita um card manual que não está em Feito; uma pessoa mescla"), and once the PR is green an `escalated` event
  with that reason (feed, chat line, push) is recorded once per PR head, with the cited refs in `cards`.
- `followMerged` reports deploys and releases only for the automatic card whose run worked on the PR's head
  (`runBranchOf`), and the CI sync picks that row of a merged PR (`deliveryRow`).

## How to check

`list_automation_queue` shows the reason on a held card instead of "Fora da coluna A fazer";
`list_automation_events` shows `merged` and `deploy_ok` only on the card whose branch the PR came from. Tests:
`merge.test.ts`, `release.test.ts` and `ci/sync.test.ts`, the cases named `TER-1004`.
