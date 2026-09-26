# Chat: trusting a tab for `send_input` — design

Card: **TER-2** (epic TER-1 · Chat). Subtasks: TER-3 (model + migration), TER-4 (gate + API), TER-5
(web UI), TER-58 (mobile app), TER-6 (tests).

Project rule: everything the chat does must work in the mobile app too, in the same delivery.

## 1. Problem

The concierge's gate (`apps/server/src/chat/gate-runtime.ts`, spec 2026-09-20 §5) asks the user to
confirm every gated write, and an approval authorises exactly one call (the idempotency key covers
tool + arguments). When the user relays answers to an agent running in a tab — a brainstorm, a
long back-and-forth with Claude in a terminal — every relayed message is one more confirmation
card. The user wants to say once: "for this conversation, you may type into this tab".

## 2. Decisions

| Topic | Decision |
|---|---|
| Scope | One conversation + one tab + one tool: `send_input` **without** `answering_permission`. Never `run_command`, `send_key`, `answering_permission`, another tab or another conversation. |
| Lifetime | While the conversation lasts, capped at **24 h** from the grant. "Nova conversa" (reset) ends it; so does deleting the conversation. Granting again for the same tab replaces the old grant and restarts the 24 h. |
| Where it is granted | A third button on an eligible confirmation card: **"Permitir sempre nesta aba"**. It approves that card *and* creates the grant. |
| Where it shows / is revoked | Both: a strip above the message box ("Enviando direto para a aba X até HH:MM · Revogar"), one per active grant, and the card that granted it ("Permitido nesta aba até HH:MM · Revogar"). |
| Agent tabs only | `send_input` types any text and presses Enter, so on a bare shell it *is* `run_command`, and in Claude Code a leading `!` runs bash directly. A grant therefore applies only while the tab reports an agent that is running or waiting for input (`tab.state` is `working` or `waiting_input`, from the monitor hooks), and never to text whose first non-blank character is `!`. A shell tab (state never reported), an agent that ended (`idle`, from `SessionEnd`) or errored, and `!` text all fall back to asking. Decided by the user after the final review (2026-09-25). Follow-up (2026-09-25): text containing any control character other than a newline is also outside a grant — `send_input` delivers text as keystrokes, and a control character (Ctrl-U, backspace…) can edit the line into a `!` command without the text itself starting with `!` (e.g. `"\x15!curl … | sh"`, `"a\x7f!rm -rf ~"`); same fallback to asking. |
| Safety locks | Unchanged and still binding: `TAB_GONE`, `WAITING_PERMISSION`, `PROMPT_CHANGED`. A grant never turns into a new question when a lock trips: the model gets the lock's error and nothing is typed. |
| Precedence | An open row for the same call (pending / approved) or a denial still in force (`DENIAL_HOLDS_MS`) decides first, exactly as today. A "no" beats a grant. |
| Audit | Every call executed under a grant is a `chat_actions` row (status `executed` / `failed`, real `error_code`, `duration_ms`), linked to the grant by `grant_id`. |
| Clients | Web and mobile app, same behaviour. On the phone, "Permitir sempre nesta aba" always needs the PIN (its own proof word, §5.1) — "Autorizar" only for an irreversible card; "Revogar" does not (it only takes power away). |

## 3. Data model (TER-3)

New table `chat_grants`:

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `newId()` |
| `conversation_id` | text FK → `chat_conversations.id`, `ON DELETE CASCADE` | |
| `tab_id` | text | Not a FK: tabs come and go; a dead tab is caught by `TAB_GONE`. |
| `tool` | text | Always `send_input` today; a column so the scope is explicit in SQL. |
| `source_action_id` | text, nullable | The card the user clicked. |
| `granted_by` | text | User id. |
| `created_at` | timestamptz default now() | |
| `expires_at` | timestamptz | `created_at + 24 h`. |
| `revoked_at` | timestamptz, nullable | |
| `revoked_by` | text, nullable | User id, or null when the system ended it (reset). |

Indexes: `(conversation_id)`; partial unique `(conversation_id, tab_id, tool) WHERE revoked_at IS
NULL`. An expired-but-not-revoked row still holds the unique slot, so "grant again" revokes the
existing row and inserts the new one in one transaction.

`chat_actions` gains `grant_id text NULL` (no FK, same as the other id columns there).

The migration only adds a table and a nullable column: the previous release keeps working against
the new schema during the blue/green switch.

Repository `ChatGrantsRepository` (`apps/server/src/db/repositories/chat-grants.ts`), every method
scoped by the owning conversation's `user_id` in SQL where a user id is involved:

- `grant({ conversation_id, tab_id, tool, source_action_id, granted_by, now? })` → the new grant
  (revokes the previous active one for the same triple, same transaction).
- `findActive(conversationId, tabId, tool, now?)` → grant with `revoked_at IS NULL AND expires_at > now`.
- `listActive(conversationId, now?)` → active grants of a conversation.
- `revoke(id, userId)` → the revoked grant, or undefined (wrong id, other user, already revoked).
- `revokeForConversation(conversationId)` → count (used by reset).
- `findBySourceAction(actionIds)` → grants whose source is one of these cards, for the trail.

`ChatActionsRepository.insertApproved({...target, grant_id, decided_by})` inserts a row already
`approved` (decided now, by the user who granted), so the grant path reuses `execute()` untouched.

## 4. Gate (TER-4)

`applyGate`, after the open-row / denial lookup and before `ask`:

```
open row or denial in force  → existing behaviour (waiting / allow / refuse / expire)
grantable(call) && active grant for (conversation, tab_id, 'send_input')
                             → insertApproved(... grant_id) → execute(ctx, call, row)
otherwise                    → ask (unchanged)
```

- `grantable(call)`: `call.tool === 'send_input' && call.args.answering_permission !== true &&
  targetId(call.args.tab_id)`. A single pure function in `gate.ts`, shared with the decision route
  so the button is only offered, and only accepted, for calls the gate would honour.
- Before using the grant the gate checks, in this order: the text does not start with `!` (after
  leading whitespace) and contains no control character other than a newline (`CONTROL_CHARS` from
  `control/agents.ts`, the same check `checkPrompt` runs on a prompt's own text — a control character
  is a keystroke that can edit the line into a `!` command even when the text itself does not start
  with one), and the tab — read through the same owner-scoped `findByIdsForOwner` — reports `working`
  or `waiting_input`. Otherwise it asks, exactly as without a grant. A tab that is missing or waiting
  on a permission still goes through `execute()`, so it is recorded as `TAB_GONE` /
  `WAITING_PERMISSION` like before.
- `execute()` is reused as is: claim, then `staleApproval` (so `TAB_GONE` and
  `WAITING_PERMISSION` trip exactly as for a clicked approval; `PROMPT_CHANGED` cannot apply since
  free-text input is refused outright on a waiting tab), then run and `markExecuted`.
- The tab is checked through the owner-scoped read `staleApproval` already uses; a grant naming a
  tab the user cannot see behaves like `TAB_GONE`.
- If `insertApproved` loses the partial unique index to a parallel identical call, the call answers
  `CONFIRMATION_WAITING` (the same "somebody else owns it" reading `ask` uses).
- After the row is closed, the gate publishes `granted_action` on the chat bus with the row's card
  (see §5) so the trail shows it live.

## 5. API and events

- `POST /chat/actions/:id/decision` accepts `decision: 'approve_tab'` in addition to `approve` /
  `deny`. The route reads the row (owner-scoped) first; if it is not `grantable`, it answers
  `400 GRANT_NOT_ALLOWED` without deciding anything. Otherwise it decides `approved` exactly like
  `approve`, creates the grant, publishes `decision` and `grant`, and resumes the run as today. The
  answer carries `grant`.
- `DELETE /chat/grants/:id` revokes (owner-scoped; 404 otherwise, 409 if already revoked) and
  publishes `grant_revoked`. It is declared with `action: 'create'` (the permission deciding a card
  needs), not the `chat:delete` a bare `DELETE` would map to: whoever can grant must be able to revoke.
- `GET /chat` gains `grants: ChatGrant[]` (active ones of the conversation) and each action card
  gains `grant_id` (the grant it ran under). The card that created an active grant is found by the
  grant's `source_action_id`; the card carries nothing extra for it.
- Reset (`ChatService.reset`) calls `revokeForConversation` beside `expireOpenForConversation`.
- Bus events (all carry `user_id` and `conversation_id`):
  - `grant` — `{ grant }` after a grant is created.
  - `grant_revoked` — `{ grant_id }`.
  - `granted_action` — `{ action: ChatActionCard }`, the audit row of a call run under a grant,
    already in its final status.
- The injected decision sentence says, for an `approve_tab` decision, that further `send_input`
  calls to that tab in this conversation run without asking, until the user revokes it or 24 h pass.

`ChatGrant` on the wire: `{ id, tab_id, tool, source_action_id, created_at, expires_at, tab_name }`
— `tab_name` resolved server-side through the owner-scoped tab read, like the card's summary.

The grant and revoke logic lives once, in `apps/server/src/chat/grants.ts`, and is called by both the
web routes (`routes/chat.ts`) and the mobile routes (`routes/m-chat.ts`).

### 5.1 Mobile API (`/api/m/v1`)

- Contract (`packages/mobile-api`): `mobileDecisionBody` gains
  `{ decision: 'approve_tab', challenge, pin_proof }`; `decisionProofMessage` takes
  `'approve' | 'approve_tab'` and the PIN proof for a grant signs `approve_tab` — a proof made for
  "Autorizar" can never open a 24 h grant. The action card schema (`chatActionSchema`, now with
  `grant_id` optional/nullable) and a `chatGrantSchema` move into the shared package, and
  `chatEventSchema` accepts `grant`, `grant_revoked` and `granted_action` (the app drops any frame the
  schema rejects; `events-parity.test.ts` requires one sample per server event).
- `POST /chat/actions/:id/decision` with `approve_tab`: same row checks, challenge consumption and
  `checkPin` as `approve`, then the shared grant helper; 400 `GRANT_NOT_ALLOWED` for an ineligible row
  (checked before the challenge is consumed or the PIN checked).
- `DELETE /chat/grants/:id`: device auth (DPoP), no PIN, `action: 'create'`; 404 / 409 as on the web.
- `GET /chat` returns `grants`, exactly like the web route. Push ignores the new events (a call run
  under a grant is not a question, so nothing is pushed).

## 6. UI (TER-5) — pt-BR copy

- `ChatActionCard`, pending and eligible (`tool === 'send_input'`, `args.answering_permission !==
  true`, `tab_id` set): buttons "Autorizar", "Permitir sempre nesta aba", "Recusar".
- A card that created an active grant: status line "Permitido nesta aba até HH:MM" + link-button
  "Revogar". After revocation or expiry it reads like any other decided card.
- A card of an action run under a grant: "Executado · aba confiada" (or "Falhou · aba confiada").
- `ChatPanel`, above the composer: one strip per active grant — "Enviando direto para a aba
  <tab_name> até HH:MM" + "Revogar". Grants past `expires_at` are hidden client-side too (a timer
  is not needed: the strip re-evaluates on render and on the next event; the server is the source of
  truth either way).
- Live: `grant` adds, `grant_revoked` removes, `granted_action` appends the card to the trail.

## 6.1 Mobile UI (TER-58) — pt-BR copy

- Action card, pending and eligible: "Autorizar", "Permitir sempre nesta aba", "Recusar". The new
  button opens the same PIN sheet; the proof signs `approve_tab`.
- The card that created an active grant: "Permitido até HH:MM" + "Revogar" (same `até amanhã, HH:MM`
  rule as the web). An action run under a grant: "executada · aba confiada" / "falhou · aba confiada"
  (the card's existing lower-case labels).
- Above the composer: one line per active grant, "Enviando direto para a aba <nome> até HH:MM" +
  "Revogar".
- Store: grants live in the conversation slot (persisted like the actions), `decide` accepts
  `approve_tab`, `revokeGrant(id)`; the reducer applies `grant`, `grant_revoked`, `granted_action`.
  The mock server (`apps/mobile/src/services/api/mock`) implements the same routes and events.

## 7. Tests (TER-6)

- Repository (`chat-grants.db.test.ts`, real Postgres like the other `*.db.test.ts`): grant, re-grant
  replaces, `findActive` ignores expired / revoked / other tab / other tool / other conversation,
  `revoke` scoped by user, `revokeForConversation`.
- Gate unit (`gate.test.ts`): `grantable` truth table.
- Gate runtime / e2e (`apps/server/src/mcp/gate.e2e.test.ts`, the in-memory fakes): with a grant a
  `send_input` types at once and leaves an `executed` row with `grant_id`; `answering_permission`,
  `run_command`, `send_key` and another tab still ask; expired and revoked grants ask; a denial in
  force still refuses; `TAB_GONE` and `WAITING_PERMISSION` block and are recorded as `failed`; the
  full loop grant → direct send → revoke → asks again.
- Routes (`routes/chat.test.ts`): `approve_tab` on an eligible row decides + grants; on an ineligible
  row answers 400 and decides nothing; `DELETE /chat/grants/:id` 200 / 404 / 409; `GET /chat`
  returns grants; reset revokes.
- Web (`ChatActionCard.test.tsx`, `ChatPanel.test.tsx`): the third button only on eligible cards;
  granted card shows "Revogar"; strip renders, revokes, and reacts to `grant` / `grant_revoked` /
  `granted_action`.
- Contract (`packages/mobile-api`): the new body variant, proof word and events parse; the parity test
  has samples for the three events.
- Mobile server (`routes/m-chat.test.ts`): `approve_tab` with a valid PIN proof grants; a proof signed
  for `approve` is refused for `approve_tab`; ineligible row → 400 before consuming the challenge;
  `DELETE /chat/grants/:id` 200 / 404 / 409; `GET /chat` returns grants.
- Mobile app (jest): reducer for the three events; store `decide('approve_tab')` goes through the PIN
  and adds the grant, `revokeGrant` removes it; conversation screen shows the third button, the
  granted card and the strip, and "Revogar" calls the store.

## 8. Out of scope

- Grants for any tool other than `send_input`, and the "gate that learns" (spec 2026-09-20 §6).
