# Chat: trusted tabs out of the conversation, listed in their own place — design

Card: **TER-67** (epic TER-1 · Chat). Existing subtasks: TER-68 (web: remove the cards, header
indicator), TER-69 (web: permissions screen), TER-70 (API: list grants), TER-71 (mobile) and **TER-94**
(batched confirmations, §7). Also covers **TER-97** (the pinned "Enviando direto para a aba…" notice:
`ChatGrantStrip` on the web, `grants-strip` on the phone).

Decisions taken without the user (2026-09-26, asked to decide by recommendation while away) are
marked *(recommendation)*.

Builds on spec 2026-09-25-chat-tab-grant-design.md (TER-2). Project rule: what the chat does works in
the mobile app too, in the same delivery.

## 1. Problem

Every trusted tab (a `chat_grants` row, "Permitir sempre nesta aba") is a fixed line above the message
box — "Enviando direto para a aba X até amanhã, 11:21 · Revogar" — on the web (`ChatGrantStrip`) and in
the app (`GrantsStrip`). With two or more tabs these lines take over the conversation, and they do not
need to be in view all the time. There is also no place to see what the chat was allowed to do across
conversations, nor what already expired or was revoked.

## 2. Decisions

| Topic | Decision |
|---|---|
| In the conversation | The strip goes away (web and app). In its place, a discreet link next to "Nova conversa": **"1 aba confiável"** / **"N abas confiáveis"**, only while the conversation has active grants, leading to the list. |
| The granting card | Unchanged: the confirmation card that created a grant keeps its "Permitido nesta aba até HH:MM · Revogar" state. It is that action's history, not a pinned notice. |
| Where the list lives (web) | **Configurações › Conta › "Abas confiáveis"**, `/settings/chat-grants`, resource `chat`. Not "Permissões": that is the admin role matrix. |
| Where the list lives (app) | A stack screen `app/chat-grants.tsx`, reached from the conversation's indicator and from a row "Abas confiáveis" in Ajustes. |
| What it lists | Every grant of the signed-in user, across all their conversations (account-wide chat and project chats), archived conversations included. |
| Active vs history | Two sections. **Ativas**: all of them, no paging (at most one per conversation + tab, each lives ≤ 24 h). **Histórico**: everything that ended, newest first, paged with **"Carregar mais"** (cursor). |
| Revoke on the phone | **No PIN** (decided 2026-09-26): revoking only takes power away. Same `DELETE /api/m/v1/chat/grants/:id` as today, unchanged. |
| Live updates | None on the list screen: it reads on open, after a revoke and on "Carregar mais". The conversation's indicator stays live through the existing `grant` / `grant_revoked` events. |
| Migration | None. The `(conversation_id)` index covers today's volume; the previous release stays compatible. |

## 3. API (TER-70)

### 3.1 Repository — `ChatGrantsRepository.listForUser`

```ts
listForUser(userId: string, opts: { state: 'active' | 'ended'; cursor?: GrantCursor; limit: number }, now = new Date()):
  Promise<{ grants: ChatGrantWithConversation[]; next: GrantCursor | null }>
```

- Scope in SQL: `conversation: { userId }`, like `findByIdForUser`. Another user's grants never appear.
- `active`: `revoked_at IS NULL AND expires_at > now`. `ended`: `revoked_at IS NOT NULL OR expires_at <= now`.
- Order `created_at DESC, id DESC`. Cursor = the last row's `(created_at, id)`; the next page is
  `created_at < c OR (created_at = c AND id < id_c)`. Reads `limit + 1` rows to know whether there is a
  next page.
- Each row carries its conversation's `project_id` and `archived_at` (Prisma `include`/`select`).
- `active` ignores the cursor and returns every active grant (`limit` still caps it defensively at 100).

### 3.2 View — `describeGrantList` (next to `describeGrants` in `chat-actions-view.ts`)

`ChatGrantListItem`:

| Field | Meaning |
|---|---|
| `id`, `tab_id`, `tool`, `source_action_id`, `created_at`, `expires_at` | As `ChatGrantView`. |
| `tab_name` | Null when the tab is gone or not this user's (same owner-scoped batch lookup as today). |
| `project_id`, `project_name` | The tab's project (null when the tab is gone or has no project). |
| `conversation_id` | The conversation that granted it. |
| `conversation_project_name` | Null = the account-wide chat ("Chat geral"); else "Chat do projeto X". A gone project reads null too. |
| `conversation_archived` | The conversation was reset ("Nova conversa") after. |
| `state` | `active` · `expired` (never revoked, `expires_at <= now`) · `revoked` (`revoked_by` set: someone clicked "Revogar", or a re-grant replaced it) · `ended` (`revoked_by` null: "Nova conversa" ended it). |
| `ended_at` | `revoked_at` for revoked/ended, `expires_at` for expired, null for active. |

Tabs and projects are looked up in one owner-scoped batch each (`tabs.findByIdsForOwner`,
`projects.findByIdsForOwner`), never once per grant. No user ids in the view.

### 3.3 Routes

- Web: `GET /api/chat/grants?state=active|ended&cursor=<opaque>&limit=<1..100>` in `routes/chat.ts`
  (already under `guarded('chat', …)`).
- Mobile: `GET /api/m/v1/chat/grants` with the same query, in `routes/m-chat.ts`.
- Query validated with zod: `state` required; `limit` default 50, max 100; `cursor` optional, an opaque
  base64url of `<created_at ISO>|<id>`. A cursor that does not decode is a **400** (`INVALID_CURSOR`).
- Response `{ grants: ChatGrantListItem[], next_cursor: string | null }` (`next_cursor` always null for
  `active`).
- Both routes share one helper in `chat/grants.ts` (`listGrants(repos, userId, query)`), like
  `activeGrants`/`revokeGrant` today.
- `packages/mobile-api` gains `chatGrantListItemSchema` and `chatGrantListResponse`, which the server
  test and the app both validate against.
- `DELETE /grants/:id` (web and mobile) is unchanged.

## 4. Web (TER-68, TER-69) — pt-BR copy

### 4.1 Conversation

- `ChatPanel` stops rendering `ChatGrantStrip`; the component and its test are deleted.
- `ChatPanel` keeps its `grants` state (the action cards read it) and derives the active count with
  `isGrantActive`. When it is > 0, a `Link` to `/settings/chat-grants` sits left of "Nova conversa":
  "1 aba confiável" / "N abas confiáveis", same small dim style as the button. Applies to `/chat` and to
  the project drawer (both are `ChatPanel`).

### 4.2 Configurações › Conta › "Abas confiáveis"

- `settings-sections.ts`: `{ key: 'chat-grants', label: 'Abas confiáveis', resource: 'chat', group: 'account' }`,
  after "Aparelhos". `SettingsPage` renders `<PageFrame title="Abas confiáveis"><ChatGrantsView /></PageFrame>`.
- `ChatGrantsView` (new, `components/ChatGrantsView.tsx`), one short intro line: "Abas em que o chat pode
  digitar sem pedir confirmação. Cada permissão vale para uma conversa, por até 24 horas."
- **Ativas**: rows with the tab ("Aba X" or "Aba que não existe mais"), the project, the origin ("Chat
  geral" / "Chat do projeto X", plus " · conversa encerrada" when archived), the validity (`untilLabel`)
  and **Revogar**. Revoking removes the row and re-reads the history's first page. A 409 counts as done.
  Empty: "Nenhuma aba confiável agora."
- **Histórico**: the same columns plus the state ("Expirou", "Revogada", "Encerrada com a conversa") and
  `ended_at` (date + time). **Carregar mais** while `next_cursor` is set. Empty: "Nada no histórico ainda."
- Load and revoke errors show inline above the lists, with "Tentar de novo" for a failed load.
- `api.listChatGrants({ state, cursor })` and the `ChatGrantListItem` type in `lib/types.ts`.

## 5. Mobile app (TER-71) — pt-BR copy

- `conversation-screen.tsx` stops rendering `GrantsStrip`; the file is deleted. Next to "Nova conversa", a
  ghost button with the same "N abas confiáveis" label opens `/chat-grants`, only while the open
  conversation has active grants.
- `app/chat-grants.tsx` re-exports `ChatGrantsScreen` from a new feature `features/chat-grants/`
  (model: labels/state copy; viewmodel: `createChatGrantsStore` + `useChatGrantsStore`; view: screen),
  following the other features. Same sections, copy and behaviour as the web; a back button.
- Store: `load()` (active + first history page in parallel), `loadMore()`, `revoke(id)` (no PIN; a 409
  counts as done; then re-read). Guards against double taps like `revokingId` in the chat store.
- The conversation's indicator updates by itself: the chat store already drops a grant on
  `grant_revoked`.
- Ajustes gains a section/row "Abas confiáveis" → `/chat-grants`.
- `client.ts`: `listGrants(auth, { state, cursor })`; mock handler `GET /api/m/v1/chat/grants` built from
  the mock state's grants (all states), paging with the same cursor rules.

## 6. Tests

- Server:
  - `chat-grants.db.test.ts` (Postgres, `TERMHUB_DB_TESTS=1`): `listForUser` scoping by user, the
    active/ended split, order and cursor paging across equal `created_at`.
  - `chat-actions-view.test.ts`: `describeGrantList` — the four states, gone tab, general vs project
    conversation, archived flag, one batched lookup per kind.
  - `routes/chat.test.ts` and `routes/m-chat.test.ts`: query validation (missing/invalid `state`, bad
    cursor → 400, `limit` bounds), response shape, `next_cursor`, the user id passed through.
  - `packages/mobile-api` schema accepts the server's shape.
- Web (vitest + RTL): `ChatGrantsView` (sections, revoke, 409, load more, empty and error states),
  `ChatPanel` indicator (count, singular/plural, hidden at 0, strip gone), settings section visible with
  `chat`.
- App (jest): store (load, paging, revoke, 409, double tap), screen, conversation indicator, mock handler.
- Before finishing: server typecheck + web and landing builds through Docker (CLAUDE.md), plus each
  workspace's tests.

## 7. Batched confirmations (TER-94)

Reported case: one request ("coloca todos os cards do chat pra trabalhar") produced 8 confirmation
cards in a row (1 `send_input`, 2 `move_task`, 5 `start_agent`), each approved alone, and each approval
re-injected as its own concierge run.

### 7.1 Decisions

| Topic | Decision |
|---|---|
| Grouping | *(recommendation)* When a conversation has **two or more pending** confirmation cards, the thread shows them as **one grouped card** at the position of the oldest pending one: "N ações aguardando sua confirmação", one line per action (its summary, "irreversível" when so) with a checkbox. `write` lines start checked, `irreversible` lines start unchecked. Buttons: **"Aprovar selecionadas (k)"** (disabled at 0), **"Recusar todas"**, and a toggle **"Ver separadas"** that shows the ordinary cards instead (the way to reach "Permitir sempre nesta aba"). Pending cards are grouped regardless of which answer proposed them: while cards are pending the concierge has stopped, so they are one request's worth. |
| Unchecked lines | Denied in the same batch (helper text: "As desmarcadas serão recusadas."), so nothing is left pending for the concierge to wait on. |
| One decision, one run | *(recommendation)* A batch is decided in one request and re-injected as **one** sentence listing every decision. More generally, re-injection now always takes **every** decided-but-uninjected action of the conversation (oldest first, at most 20) instead of one per run, so even single clicks that queue behind a busy run drain in one run. One action keeps today's exact sentence. |
| Proposing together | *(recommendation)* The gate's "pending" message tells the concierge that, if the same request needs other independent actions, it should propose them now in the same turn (they join the same confirmation) and then stop. This is what makes sibling `start_agent` calls arrive as one batch. |
| `start_agent` siblings | Covered by grouping + proposing together: approving the batch approves every sibling. No standing grant for `start_agent` (it starts an agent on a machine). |
| Board trust per project | *(recommendation)* **Deferred to its own card** (TER-111, created with this spec): "Permitir sempre neste projeto" for `create_task` / `add_subtasks` / `update_task` / `move_task` needs a second grant kind (project-scoped), a migration that the previous release must tolerate on rollback, and a list that unions two kinds. Not dropping confirmation for board writes: a prompt injected into a terminal could otherwise rearrange the board unasked. |
| Phone | Same grouped card. Approving a batch with approvals asks the **PIN once**; the app requests one decision challenge per approved action and signs each with the same unwrapped secret (proofs stay bound to one action and one decision word, as today). "Recusar todas" needs no PIN. |
| Interaction with TER-92 | TER-92 (parallel branch) makes `write` approvals on the phone PIN-free. When both land, the batch route follows the same rule as the single one: items that need no proof are accepted without one. Until then every approved item carries a proof. |

### 7.2 Server

- `ChatActionsRepository.listToInject(conversationId, excludeIds, limit = 20)`: decided (`approved` /
  `denied`), `injected_at IS NULL`, `grant_id IS NULL`, ordered `decided_at, id`.
- `ChatService.resumeAfterDecision(user, action)` and `drainNextDecision` inject `action` plus the rest
  of `listToInject` in one run; `beforeRun` marks all of them injected. `injectionFor` keeps the single
  sentence for one action; for several: "O usuário decidiu N ações pendentes de uma vez." + one line per
  action ("Autorizou: tool em alvo…" / "Recusou: tool em alvo…", with the approved proposal spelled out
  on a fresh session) + "Siga com as autorizadas, refazendo cada chamada com os mesmos argumentos; não
  faça as recusadas e explique ao usuário o que ficou sem fazer." + the grant note when one of them
  granted a tab.
- `chat/decisions.ts` → `decideMany(repos, userId, items)`: reads every id owner-scoped; ids of more
  than one conversation → 400 `MIXED_CONVERSATIONS`; unknown ids and rows no longer pending are
  returned as `skipped` (`not_found` / `already_decided`), the rest decided and each `decision` event
  published. Nothing decided at all → 409.
- Web: `POST /api/chat/actions/decisions` `{ decisions: [{ id, decision: 'approve' | 'deny' }] }`
  (1..20, unique ids; `approve_tab` is not batchable). Resumes like the single route (`queued` on
  `CHAT_BUSY`). Answer `{ actions, skipped, message? , queued?, note? }`.
- Mobile: `POST /api/m/v1/chat/actions/decisions` `{ decisions: [{ id, decision: 'deny' } | { id,
  decision: 'approve', challenge, pin_proof }] }`. Every approved item is checked exactly like the
  single route (pending, challenge consumed, PIN proof) **before anything is decided**; the first
  failure answers like the single route (401 `PIN_INVALID` with `failures`, 423, 400
  `CHALLENGE_INVALID`) and nothing is decided. Then `decideMany`; the run resumes in the background.
  The proof check is one helper shared with the single route. Schemas in `packages/mobile-api`.

### 7.3 Web

- `chat-timeline.ts`: `groupPendingActions(entries)` replaces the pending action entries with one
  `{ kind: 'action_group', at, actions }` entry when there are two or more.
- `ChatActionGroup.tsx` (new): the grouped card (§7.1). `ChatPanel` renders it, keeps "Ver separadas" as
  local state, and calls `api.decideChatActions(decisions)`; decision events already update each row.

### 7.4 Mobile app

- Session store: `requestPinProofs(actionIds, perform, decision)` — one PIN sheet ("Aprovar N ações"),
  one challenge + proof per id, `perform(proofs)` while the sheet stays busy, same error handling as
  today. `requestPinProof` becomes the one-id case.
- `api.decideMany(auth, body)`; mock route with the same rules; chat store `decideMany(decisions)`.
- Timeline groups pending actions like the web; `action-group-card.tsx` renders the grouped card.

### 7.5 Tests

- Server: `listToInject` (DB); `injectionFor` for one vs several (text); resume/drain inject all and
  mark all; `decideMany` (mixed conversations, skipped, events); both batch routes (validation,
  owner scope, PIN failure decides nothing, `queued`).
- Web: `groupPendingActions`; `ChatActionGroup` (defaults, counts, unchecked denied, "Ver separadas").
- App: session `requestPinProofs`; store `decideMany`; mock route; grouped card on the conversation.

## 8. Out of scope

- Granting from the list (grants are still born only on a confirmation card).
- Filters or search in the history; deleting history rows.
- Live updates on the list screen.
- Changing what a grant allows, its 24 h or the PIN for "Permitir sempre nesta aba".
- Board trust per project (TER-111, §7.1).
