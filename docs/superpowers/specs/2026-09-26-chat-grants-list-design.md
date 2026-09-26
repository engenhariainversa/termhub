# Chat: trusted tabs out of the conversation, listed in their own place — design

Card: **TER-67** (epic TER-1 · Chat). Existing subtasks: TER-68 (web: remove the cards, header
indicator), TER-69 (web: permissions screen), TER-70 (API: list grants), TER-71 (mobile). Also covers
**TER-97** (the pinned "Enviando direto para a aba…" notice: `ChatGrantStrip` on the web,
`grants-strip` on the phone).

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
- Load errors show inline with "Tentar de novo"; a revoke error goes through the existing toast.
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

## 7. Out of scope

- Granting from the list (grants are still born only on a confirmation card).
- Filters or search in the history; deleting history rows.
- Live updates on the list screen.
- Changing what a grant allows, its 24 h or the PIN for "Permitir sempre nesta aba".
