# Mobile chat: PIN only for irreversible actions, and no more "Token inválido" (TER-92, TER-93)

## 1. Problem

Two reports from the same session on the phone (2026-09-26):

- **TER-92.** Every "Autorizar" and every "Permitir sempre nesta aba" on a confirmation card asks for the PIN, even while the app is unlocked. Most cards are ordinary writes (`send_input`, `create_task`, …); typing six digits for each one breaks the conversation.
- **TER-93.** After about ten approvals, the app starts answering "Token inválido" to everything, until the person re-pairs or relocks and unlocks.

## 2. Root cause of TER-93

The access token lives 15 minutes (`ACCESS_TOKEN_TTL_MS`). The app renews it only when a call answers `401 TOKEN_EXPIRED` (`apps/mobile/src/services/api/client.ts`), which is what the mobile spec (2026-09-24, §5 and the mock) says the server answers for an expired or unknown token. The real server answers `401 TOKEN_INVALID` ("Token inválido") instead (`apps/server/src/mobile/auth.ts`), so the app never renews: the error surfaces as is.

It went unnoticed because the chat socket was refused by the server until PR #158 (the `Origin` React Native sends), and the socket renews the token before **every** reconnect after a refused upgrade. That loop (a challenge + token pair every 1–30 s) kept the token fresh by accident. Once #158 was live the socket connected and nothing renewed any more; 15 minutes later every call failed.

Evidence (server logs, metadata only): token renewed at 02:47:19 UTC (the socket connected right after, first time after the deploy); approvals at 03:00–03:01 fine; at 03:02:24 — five seconds after the 15-minute mark — the next approval got `401`, and so did three retries at 03:02:35, 03:02:46 and 03:03:00 (four `401`s and no `423`, so not a wrong PIN: the third wrong PIN locks). After a relock and unlock at 03:05:36 the same action was approved. The "~10 interactions" were only the time passing.

## 3. Decisions

| Topic | Decision |
|---|---|
| Approving a `write` card | No PIN. The access token and the DPoP proof (hardware key) are enough, like denying. The app is unlocked only after a PIN, relocks after 5 minutes in the background, and renewals need the PIN secret in memory. |
| Approving an `irreversible` card (`C-c`, `Escape`, `close_tab`, `delete_task`, any unknown tool) | PIN or biometrics, as today. |
| "Permitir sempre nesta aba" (`approve_tab`) | PIN or biometrics, as today: it hands over continuing power on a tab. |
| Where the rule lives | **The server** decides from the action's stored class; the app only avoids the useless round trip. |
| Web | Unchanged. |
| Expired or unknown access token | `401 TOKEN_EXPIRED`, as the spec always said. |

## 4. Server

### 4.1 Decision route (`POST /api/m/v1/chat/actions/:id/decision`)

- `mobileDecisionBody` (`packages/mobile-api/src/chat.ts`): `approve` takes `challenge` and `pin_proof` as optional, both or neither. `approve_tab` still requires both. `deny` unchanged.
- The route loads the action as today (404 / 409 first). The proof is **required** when the decision is `approve_tab` or the action's class is not `write`; missing, the answer is `401 PIN_REQUIRED` ("Confirme com o PIN para autorizar esta ação."), the action stays pending and nothing is consumed or counted.
- When a proof comes (an app released before this change always sends one), it is checked exactly as today — challenge consumed, PIN counted — whatever the class. A wrong PIN on a `write` card still counts: the app asked for it.
- An approved `write` card without proof is logged by the existing events only (the decision itself is already published on the bus and stored).

### 4.2 Authentication (`apps/server/src/mobile/auth.ts`)

A well-formed `thb_mob_` token that does not resolve to a valid token of an active device answers:

- `401 DEVICE_REVOKED` when the row exists and its device is revoked (unchanged);
- otherwise `401 TOKEN_EXPIRED`, message "Sessão expirada." — expired, or already removed by the hourly purge. A malformed token stays `401 UNAUTHORIZED`.

This alone fixes TER-93 for the app already installed: it already renews on `TOKEN_EXPIRED`.

The `mobile-client` CLI (`apps/server/src/cli/mobile-client.ts`) reacts to `TOKEN_EXPIRED` where it reacted to `TOKEN_INVALID`.

## 5. App

### 5.1 Approvals

`createChatStore.decide`: for `approve` of a card whose class is `write`, call `api.decide(auth, id, { decision: 'approve' })` directly, with the same busy state, settle and 409 handling as today. If the server answers `PIN_REQUIRED` (a card whose class the app got wrong or a server that has not been updated) or `VALIDATION` (a server rolled back to the old schema, which rejects an `approve` with no proof at all), fall back to the PIN sheet for the same action — but only if the conversation is still the one this decision was made for; a conversation switch or reset in between drops the fallback silently. `approve_tab` and non-`write` cards keep the PIN sheet.

### 5.2 Token lifetime

- **Proactive renewal.** The session store knows `expires_in` from activation and every renewal. While `unlocked`, a timer renews at `Math.max(expires_in / 2, expires_in − 60 s)` (so a lifetime of 2 min or less still gets a sane delay, half the lifetime, instead of firing at once); a relock or wipe clears it. A timer that fires late (the app was in the background) is harmless: the reactive path below still covers it.
- **Reactive renewal** stays as it is: one `401 TOKEN_EXPIRED` → one single-flighted renewal → one retry.
- **Socket.** A refused upgrade renews before the next attempt only when the token is stale (past `expires_at − 60 s`, or no expiry known). A refusal with a fresh token is not a token problem: the socket only backs off. No renewal loop again from a refusal that has nothing to do with the token.
- **Clear expiry.** When a renewal cannot happen because the PIN secret is gone, the store relocks with the notice "Sessão expirada. Desbloqueie para continuar." — never "Token inválido".

### 5.3 Mock

The mock transport mirrors the server: `approve` without proof accepted on a `write` action, `PIN_REQUIRED` otherwise.

## 6. Compatibility

- No migration.
- Old apps: send the proof on every approval, which the server keeps accepting; they get the TER-93 fix from the server change alone.
- New app against a server without this change: its `write` approval without proof is refused by schema, `400 VALIDATION` (`apps/server/src/lib/errors.ts`). The app also falls back to the PIN sheet on that old-schema validation error, so a server rollback keeps approvals working (with the PIN); the server still deploys first (CI on merge) and the app ships later through EAS.

## 7. Testing

- Server (vitest): decision without proof on a `write` card approves without touching challenge or PIN; on an `irreversible` card and on `approve_tab` answers `PIN_REQUIRED` and leaves the action pending; with proof behaves as today. Auth: expired token → `TOKEN_EXPIRED`; unknown token → `TOKEN_EXPIRED`; revoked → `DEVICE_REVOKED`. Body schema: `approve` with both, neither, or only one field.
- App (jest): chat store approves a `write` card without opening the PIN sheet and falls back to the sheet on `PIN_REQUIRED` and on `VALIDATION` (old-schema rollback), but not once the conversation has moved on. Session store schedules a renewal at `Math.max(expires_in / 2, expires_in − 60 s)`, clears it on relock, and relocks with the "Sessão expirada" notice when there is no secret; a short `expires_in` (≤ 2 min) still gets one renewal, not a burst. Client: a socket refusal with a fresh token does not renew; with a stale token it does.
- Specs updated: `2026-09-24-mobile-chat-app-design.md` §2 table, §5.6 (when the PIN is asked) and §5.7 (`TOKEN_EXPIRED` instead of `TOKEN_INVALID`).
