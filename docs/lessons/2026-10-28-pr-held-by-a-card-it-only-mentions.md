---
symptom: "escalated { reason: merge_person_card, cards: PST-3 } on a green PR, then silence: the PR waits and nobody is told"
tags: [automation, merge, pull-requests, health, watches]
evidence: fixed
card: TER-1136
agent: claude
date: 2026-10-28
---
## Cause

Two things together.

1. The CI sync linked a PR to **every** card ref found in its branch, title and body (`refsIn`), and the merge
   executor held any PR linked to a manual card not yet done (`merge_person_card`, TER-1004). A passing mention
   in the description ("Tela mínima no cms… (o visual final vem do PST-3)") was enough to stop the merge.
   The same pattern held termhub's own PRs #500, #526 and #535.
2. The escalation only recorded the event, its push and a plain chat line with a generic reason (no PR, no
   card). Nothing woke the project chat, the health watcher's `pr_ready` waited its 120 minutes, and a `pr`
   watch had no event for "termhub will not merge this", so the person only found out by asking.

## Fix

- `linkedRefsIn` (`apps/server/src/ci/rules.ts`): a ref in the title or body is a link only right after a link
  word (`Depende de:`, `Depends on`, `Blocked by`, `Closes`, `Fixes`, `Resolves`, `Fecha`, `Corrige`…). The sync
  stores the other cited cards with `task_pull_requests.mention_only = true`; `candidateOf` ignores them when
  deciding whether a person's card holds the PR. A PR whose cards are all mentions is also linked to its run's card.
- The escalation names the PR and the cards (feed, chat line, push), and the executor wakes the project chat
  once per head (`wakeHeld` → `heldPrWakeText`) with the ways out.
- The health watcher opens `pr_ready` at once for `merge_person_card`, with the cards (`told_elsewhere`).
- `pr` watches get a `merge_blocked` event (default on), read from the executor's `escalated` /
  `merge_needs_approval` events for the PR head.

## How to check

A PR whose body says "o visual final vem do TER-x" (TER-x manual, not done) is merged once green. One whose body
says "Depende de: TER-x" shows `merge_person_card: TER-x` in `list_automation_queue`, and the project chat gets an
"Automático: o PR #n … depende de TER-x" turn.
