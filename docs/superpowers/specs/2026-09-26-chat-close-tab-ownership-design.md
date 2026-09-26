# Chat: closing a tab takes one confirmation (TER-184)

## Problem

To close a tab it had opened itself, the chat asked the user twice. The user approved `close_tab`,
the tool refused with `NOT_YOURS` ("Esta aba não foi aberta por este token: repita com force: true"),
and the repeat with `force: true` is a different proposal (other idempotency key), so the gate
asked again.

## Root cause

- `closeTab` (`apps/server/src/control/terminals.ts`) only closes without `force` a tab whose
  `created_by_token_id` is the calling token.
- The concierge's token is rotated on every run (`mintConciergeToken`, called from
  `ChatService` before each run). A tab opened in one run belongs to a token that is already
  revoked by the next run, so the chat never "owns" the tabs it opened earlier.
- On a gated token the check only runs **after** the gate executed an approved call, so the
  refusal arrives after the user's "yes", and the forced retry is a new question.

## Design

1. **The gate is the ownership check for the concierge.** `ControlContext.token` gains `gated`.
   On a gated token, `closeTab` does not require `force`: every gated `close_tab` is in the
   irreversible class, has no grant, and only reaches `closeTab` after the user approved that exact
   call in the chat. That confirmation is the explicit consent `force` stands for. A person's own
   token (not gated) keeps the current rule: only the tabs it opened, unless `force`.
2. **The card says whose tab it is.** The `close_tab` card sentence (`describeActions`) names the
   tab's origin, so the one confirmation is informed:
   - opened by any concierge token of the same user (any conversation, any run): `(aberta pelo chat)`;
   - opened in the browser (`created_by_token_id` null): `(aberta por você, não pelo chat)`;
   - opened by another API token of the user: `(aberta por um token de API seu, não pelo chat)`.
   Tokens are never deleted, only revoked, so an old concierge token still resolves. The lookup is
   one `apiTokens.listByUser(ownerId)` call, only when a close_tab card has a resolved tab with a
   token id.
3. **Tool description** of `close_tab` says that in the chat the user's confirmation covers any of
   their tabs, so the concierge does not add `force` by reflex (harmless if it does).

A personal tab still needs an explicit confirmation: the card, which now says it is not the chat's.

## Out of scope

- `MAX_TABS_PER_TOKEN` is also per token and resets with each rotation; not the reported bug.
- Batching confirmations (TER-94), per-project trust (TER-111).

## Tests

- `control/terminals.test.ts`: gated token closes a tab of another token / of the browser without
  `force`; a non-gated token still gets `NOT_YOURS`.
- `db/repositories/chat-actions-view.test.ts`: close_tab sentence for the three origins.
- `mcp` route: the gated flag reaches the context.
