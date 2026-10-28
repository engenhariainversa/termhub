---
symptom: "automatic run created feature/<termhub ref>-… instead of the branch named after the client's ticket, and started a second agent on a ticket a tab was already working on"
tags: [automation, branch, tickets, dispatcher]
evidence: fixed
card: TER-1110
agent: claude
date: 2026-10-22
---
## Cause

Two gaps in the dispatcher, seen on a client project whose GitHub ruleset only accepts branches named after
the client's tracker key (`feature/<key>-<slug>`) and whose rules forbid the termhub ref on GitHub:

1. `repo.branch_pattern`'s `{ticket}` was always the termhub ref (`cardBranchName` filled it with `card.ref`),
   so the run's branch ignored both the card's external ticket and the branch its description asked for.
   The push was only saved by the client's ruleset refusing it.
2. Nothing checked for work already going on: the chat created the card already tagged while a tab opened by
   hand was implementing the same ticket, and the dispatcher took the card on its next tick (15 s), before the
   chat linked that tab (`link_tab_task`). The second agent found the first one's PR and stood down.

## Fix

- `{ticket}`/`{ticket_lower}` are the external ticket's key (else the ref), `{ref}` is always the ref; a
  `branch: <name>` line in the description wins; `repo.require_ticket` refuses a card without a ticket
  (`no_ticket` in the queue) and tells the agent never to put the ref on GitHub (`namingRule`).
- `findExistingWork` (apps/server/src/automation/existing-work.ts) runs before each start: a tab, open PR or
  GitHub branch naming the ref or the ticket key, outside the card's own runs, untags the card with the reason.
- Cards wait `NEW_CARD_GRACE_MS` (2 min) after creation; the concierge prompt says to create such a card
  without the tag and link the tab.
- A PR naming no card links to the card whose run works on its branch (`taskOfBranch` in the CI sync).

## How to check

Queue (`list_automation_queue`): a card without a ticket in a project with "Exigir ticket externo" reads
`no_ticket`; a just-created card reads `just_created`. A card whose ticket has an open PR leaves the queue with
an `untagged` event whose feed line ends in "Já há trabalho em andamento neste ticket: …".
