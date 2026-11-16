---
symptom: "Approving a group of 30 pending chat cards on the phone (\"Approve selected (30)\") opens the PIN sheet \"Authorize 30 actions\" and then answers \"Invalid data\"; \"Deny all\" on the same group fails too"
tags: [chat, mobile, web, zod, batch, gate, open-permissions]
evidence: fixed
card: TER-1192
agent: claude
date: 2026-11-16
---
## Cause

1. **The batch routes took at most 20 decisions.** `mobileBatchDecisionBody` and `decisionChallengesBody`
   (`packages/mobile-api/src/chat.ts`) and the web's `batchBody` (`apps/server/src/routes/chat.ts`) had `.max(20)`,
   but the group card sends every card it shows. 30 cards gave a zod 400 `VALIDATION` ("Dados inválidos").
   On the phone it looked like a PIN problem: `decideMany` in the app treats `VALIDATION` on a session-only batch
   as "an older server wants proofs" and opens the PIN sheet. The `actions/challenges` call behind the sheet has
   the same cap, so the second answer was "Invalid data" too. "Recusar todas" sends no proof and got the first
   400 directly. The pending bar sliced its own list to 20, so it never showed the bug.
2. **Why a subagent's 30 cards existed at all with "liberado por padrão" on.** It was not the old gate: the open
   model (TER-1164) allows at most `OPEN_BUDGETS.board = 30` board writes per person per rolling hour
   (`apps/server/src/chat/open-permissions.ts`), across every chat. Past that, `openGrantCovering` returns null
   and the call becomes a card. In prod, all three bursts that made cards (auvp 20:42, termhub 03:37, reactivando
   10:44 UTC, 2026-11-16) came right after exactly 30 `default:open-board:<user>` grants in the hour before.
   Subagents just hit the budget first because they create cards in bulk.

## Fix

- One cap, `CHAT_DECISION_BATCH_MAX = 100` (`@termhub/mobile-api/decision-batch`, zod-free for the web), on all three
  schemas. The web's `decideChatActions`, the app's `decideMany` client call and its challenges call send a longer
  list in runs of that size (`decisionBatches`). The pending bars no longer slice to 20. An old app works as soon
  as the server is deployed: it sends 30 in one call, which is now under the cap.
- The open model's budget is a separate decision (it is a safety brake). See the card.

## How to check

- `npx vitest run src/routes/chat.test.ts src/routes/m-chat.test.ts` (apps/server): the 50-decision tests.
- `npx jest src/features/chat/viewmodel/createChatStore.test.ts -t TER-1192` (apps/mobile).
- When a batch fails with "Dados inválidos", compare the body's length with the cap before looking at the PIN.
- When cards show up with the open model on, count `chat_actions` rows with `grant_id = 'default:open-<kind>:<user>'`
  in the hour before. At the budget, the card is expected.
