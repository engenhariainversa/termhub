---
symptom: "Only a routine action of one of your projects can be allowed with no time limit (Só dá para liberar sem prazo uma ação de rotina de um projeto seu) on a card that reads \"numa aba que não existe mais\""
tags: [chat, gate, grants, tabs]
evidence: fixed
card: TER-986
agent: claude
date: 2026-10-07
---
## Cause

A terminal card (`send_input`/`send_key`) finds its project through its tab. Once the tab was closed,
the card stayed `pending` with every grant button still on screen, and each grant check
(`assertStandingGrantableAction`, `assertProjectAllGrantableAction`…) failed on the missing tab with a
refusal about the card's *kind* — so the error named the wrong cause. A plain "Autorizar" was accepted
and only failed later, at execution, as `TAB_GONE`.

## Fix

A pending card whose tab is gone is retired as `failed`/`TAB_GONE`, the same state the gate already
used for an approval whose tab died, which the web and the app show as "Expirou: a aba foi fechada"
with "Propor de novo":

- on tab removal (`startTabGoneActionExpiry`, a monitor lifecycle subscriber) and in the boot/hourly
  orphan sweep (`expireOrphanTabActions`), in `apps/server/src/chat/tab-gone-actions.ts`;
- on any approve word for such a card (`assertActionTabAlive`, before the grant checks and the PIN):
  409 `TAB_GONE` with a message that says the tab was closed.

The gate also keeps the tab's `project_id` on the row when it asks, so the card still names its project.

## How to check

Close a tab that has a pending chat card: the card turns stale at once. On an older stale card,
clicking a grant answers 409 `TAB_GONE` ("A aba desta ação foi fechada…") and the card turns stale.
Tests: `apps/server/src/chat/tab-gone-actions.test.ts`, the TER-986 cases in `routes/chat.test.ts` and
`routes/m-chat.test.ts`.
