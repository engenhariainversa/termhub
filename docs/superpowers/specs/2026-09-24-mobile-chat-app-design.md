# termhub mobile app (chat only) — design

**Status:** approved in conversation (Pedro, 2026-09-24), block by block; implementation follows this document. Supersedes the mobile half of `2026-09-19-mobile-chat-concierge-brainstorm.md`. Builds on `2026-09-20-chat-concierge-design.md` (gate, cards, conversation model), `2026-09-22-user-hosted-concierge-design.md` (the CLI runs on the user's own host) and `2026-09-23-project-chat-design.md` (one conversation per project). None of those change.

## 1. Why

The chat already answers "what is opapingou waiting for?" and "run the tests on jarvis" from the browser. The person who asks those questions is often away from a computer, and the moment the concierge needs a confirmation is exactly the moment they are not at the desk. The web app on a phone works, but it lives behind Cloudflare Access, keeps no session on the device, and cannot notify anyone.

What the user asked for: **the chat, and only the chat, as a native app** — talk, watch the answer stream, dictate, pick the machine and account that host the conversation, and confirm or refuse the concierge's pending actions — with a session that is as strong as the web's, because a hijacked chat session is a hijacked computer.

Success: a pending action on the phone is confirmed with a PIN or a fingerprint within a minute of the push arriving; a stolen phone is useless to the thief after fifteen minutes without the PIN, and useless immediately after the owner revokes it on the web; nobody can find out from the app which e-mails have an account.

## 2. Decisions

| Question | Decision |
|---|---|
| Stack | **Expo (React Native)**, development builds through EAS Build, EAS Submit for the stores. Workspace `apps/mobile` (`@termhub/mobile`). |
| Scope | Chat only: account-wide chat **and** the per-project chats, streaming, dictation, host picker, pending-action decisions. No terminal, tasks, notes, office, admin screens. |
| Server | **Cloud only** (`app.termhub.dev`'s backend). The server URL is a constant in the app; there is no screen to change it. |
| Where the mobile routes live | **`https://termhub.dev/api/m/v1/*` and `wss://termhub.dev/ws/m/chat`**, on the host that has no Cloudflare Access, following the `/mcp` precedent: nginx `location` blocks with per-client budgets, nothing changes in Access. The web app on `app.termhub.dev` cannot even send its cookie there. |
| Who can use the app | Whoever is in the **chat feature flag**: today the `BETA` role (the only non-admin role holding the `chat` resource) plus admins. A new `devices` resource is granted to exactly the roles that hold `chat`; when the chat opens to everyone, the app opens with it. |
| Enrolment | Starts in the app with the e-mail, is approved **on the web** with a verification code shown on both screens. The response to the app is identical whether the account exists or not. |
| Session | Hardware-bound key (Secure Enclave / Keystore, non-exportable). Short opaque access token (15 min) bound to that key; **proof of possession on every call** (DPoP-style). Renewal needs the key **and** a secret the PIN unlocks. |
| PIN | Six digits, mandatory on every device; biometrics are an optional shortcut to the same secret. The PIN never leaves the device; the **server** counts wrong attempts: 3 → device locked 15 minutes, 6 → device revoked as hijacked. |
| Approving an action | Always asks for the PIN or biometrics at the moment of the tap, even when the app is unlocked. Denying does not. |
| Push | `expo-notifications` + Expo Push Service (APNs/FCM). Payloads name the project, tab and machine, never a command, argument, summary or reply text. An in-app **Notificações** tab keeps the history. |
| Store review account | One ordinary account with `review_enabled_until` set by an admin; while it is in the future, a device request for that e-mail is approved automatically. Everything else is the normal flow. Never a code path that applies to other accounts. |
| The web | Does not change its login, session or CSRF. It only gains the device screens (pending requests, device list, activity) and the review-account panel. |

## 3. Architecture

```
phone ──HTTPS + DPoP──▶ termhub.dev/api/m/v1/*   (nginx → app, no Access)
phone ──WSS  + DPoP──▶ termhub.dev/ws/m/chat
                            │
                            ▼
                     ChatService (unchanged) ──▶ agent on the user's host ──▶ claude -p ──▶ POST /mcp ──▶ gate
                            │
                     chatBus ──▶ MobilePushService ──▶ Expo Push ──▶ APNs / FCM ──▶ phone
web (app.termhub.dev, Access + cookie + CSRF) ──▶ /api/devices/* (approve, revoke, activity), /api/users/:id/review
```

Four new pieces, one refactor, and one thing that stays exactly as it is:

1. **A mobile auth layer** — a Fastify plugin at `/api/m/v1`, registered at the root, *outside* the `/api` plugin. It has its own `preHandler` that accepts only a device access token plus a DPoP proof. It never reads a cookie, the Cloudflare Access header or a `thb_pat_` token, so the web session is worthless on these routes and the device token is worthless on `/api`, by construction. Routes still declare `resource` / `action` and go through the same `canAccess`; a `guardedMobile(resource, plugin, prefix)` mirrors `guarded()`. The scope is always the caller ("view as" does not exist here).
2. **Device enrolment and session** — requests, approval, activation, tokens, challenges, revocation, audit.
3. **Mobile chat routes and `/ws/m/chat`** — thin adapters over `ChatService` and `chatBus`. The WebSocket is registered as a public upgrade route (like `/agent/ws`) that authenticates itself with the same two headers.
4. **Push and notifications** — a service subscribed to the bus, a table that is the in-app history.
5. **Refactor:** `ChatService.send` is split into *start* (persist the messages, take the lock, return ids) and *finish* (the run), so the mobile route can answer `202` at once while the web route keeps awaiting the whole thing.
6. **Unchanged:** the gate, the cards, the conversation model, the host resolution, the agent protocol, the transcription service, the web's own auth.

Shared types live in `packages/mobile-api` (`@termhub/mobile-api`): zod schemas for every request, response and WebSocket event, used by the server to validate and by the app to type, plus the pure chat logic the app reuses from the web (timeline merge, delta fold, per-conversation filter). The web app does not depend on it.

## 4. Enrolment

### 4.1 In the app

"Continuar com e-mail". The app generates a P-256 key pair in the Secure Enclave (iOS) or Keystore, StrongBox when available (Android); the private key is non-exportable and needs no user presence to sign. It then calls:

```
POST /api/m/v1/devices/requests
{ email, public_key: <JWK>, device: { platform, model, os_version, name }, app_version }
```

### 4.2 The response is always the same

`202 { request_id, request_secret, verification_code, expires_at, poll_after }` — for a known e-mail, an unknown one, and an account without `devices:create`. The verification code is generated every time: 6 characters from an alphabet without ambiguous glyphs (no `0/O`, `1/I/L`), shown as `K7F-2QD`.

To keep even the polling identical, **every request becomes a row** in `device_requests`. When the e-mail does not exist, or the account cannot enrol devices, the row is a **decoy**: `user_id` is null, it is never shown on the web, never approvable, and expires like the others. Decoys store only `email_hash`, never the e-mail.

What stays measurable is small: for a real account the handler runs one or two extra queries (`canAccess` on the account's role, `countPending`) before it answers. The notification e-mail, the push and the `device_events` rows run in the background, after the response, so they add nothing to its timing.

### 4.3 Limits

- Per e-mail: 3 requests per 10 minutes. Per IP: 10 per 10 minutes (in memory, the waitlist pattern; nginx and the WAF add their own per-IP budgets).
- Pending per account: 3. Beyond that the request still gets the neutral response but is stored as a decoy.
- Notification e-mails: at most 5 per hour per account, so nobody can flood a person's inbox by typing their e-mail.
- Polling: one call per 2 seconds per request, with `request_secret` as bearer.
- A request expires **10 minutes** after creation. An approved request must be activated within 10 minutes of approval (`activate_until`).

### 4.4 On the web

When the account exists, the request appears under Configurações → Aparelhos and as a banner at the top of the app ("Um aparelho pede acesso à sua conta · Ver pedido"). The card shows device name, model and OS, approximate country and city (from Cloudflare's headers), IP, time, how long until it expires, and the **verification code, large**. Aprovar opens a dialog: "O código na tela do celular é K7F-2QD?" → "Sim, aprovar". The card says "Se você não pediu isso, recuse." An e-mail ("Um aparelho pede acesso à sua conta") carries the same facts and a link. With 5 active devices, Aprovar is disabled with "Revogue um aparelho antes".

### 4.5 Back in the app

`GET /api/m/v1/devices/requests/:id` (bearer `request_secret`) answers `{ status: 'pending' | 'approved' | 'closed' }`. Denied, expired and unknown ids are `closed`. A decoy behaves like a real row that nobody answers: `pending` until it expires, `closed` after, so polling it tells nothing either. With `approved` the app moves on; the `request_secret` it already holds doubles as the activation credential (only this app instance has it, and activation also needs the key's signature).

The app then asks the person to **create the PIN** (6 digits, typed twice) and only then calls `POST /api/m/v1/devices/activate` with `request_id` and `request_secret`, signed by the hardware key (the DPoP proof of §5.2 with no access token yet). That is when the `devices` row is created. The response carries `device_id`, the first access token and, **once**, the `pin_secret` the server generated; the app wraps it under the PIN (§5.4) and stores it. Abandoning the PIN screen creates nothing; the approval expires by itself. A device without a PIN does not exist.

### 4.6 Audit

Created, approved, denied, expired and activated each write a `device_events` row with IP, country and city (§8).

## 5. Session, proof of possession and PIN

### 5.1 Access token

Opaque, random (32 bytes, base64url), **15 minutes**, stored as a sha256 hash in `device_tokens`, bound to `device_id`. Opaque rather than a JWT on purpose: revoking a device deletes its rows and the token dies at once, with no cache window.

### 5.2 Proof of possession on every call

Every call to `/api/m/v1/*` and the `/ws/m/chat` upgrade carry:

```
Authorization: Bearer <access token>
DPoP: <compact JWS, ES256, signed by the device key>
  header:  { typ: 'dpop+jwt', alg: 'ES256', jwk: <public key> }
  payload: { htm, htu, iat, jti, ath }
```

- `htm` is the method, `htu` the canonical URL (`MOBILE_PUBLIC_URL` + path, no query), `iat` the device's idea of now, `jti` random and unique, `ath` the sha256 of the access token (absent on `devices/activate` and `session/token`, which carry no access token yet).
- The server finds the device through the token, verifies the JWS against the **stored** public key (the `jwk` in the header is only compared, never trusted), checks `htm`/`htu`, accepts `iat` within ±60 s (the app corrects its clock from the `Date` response header), and rejects a `jti` seen in the last 5 minutes (in-memory set per device, pruned).
- A token of another device, an expired token, a bad signature or a replayed `jti` all answer `401 { code }`; a revoked device answers `401 DEVICE_REVOKED`, which makes the app wipe itself (§5.7).

The signature is silent — the hardware key does not ask for the PIN — so the cost per call is CPU only.

### 5.3 Renewal — where the PIN enters

```
POST /api/m/v1/session/challenge   { device_id }                    → { challenge, expires_at }   (60 s, single use)
POST /api/m/v1/session/token       { device_id, challenge, pin_proof }  + DPoP proof carrying `chal: challenge`
                                                                     → { access_token, expires_in: 900 }
```

`pin_proof = base64url(HMAC-SHA256(pin_secret, challenge))`. The signature proves the device; the HMAC proves the person. Both are required.

### 5.4 Why the PIN holds even on a rooted phone

The `pin_secret` (32 random bytes, generated by the server at activation, stored server-side encrypted with the existing `encryptSecret` helper) is kept on the device **wrapped under a PIN-derived key without an authentication tag**: `wrapped = pin_secret XOR scrypt(PIN, salt)`. Any PIN "unwraps" to 32 plausible bytes. Nobody can test a PIN offline, not even with the phone rooted: every guess has to be tried against the server, which counts. The app itself never knows whether the PIN was right; it learns from the server's answer. Consequence, accepted: with no network the app cannot unlock (and with no network it cannot do anything anyway).

### 5.5 The server counts

`devices.pin_failures` and `pin_locked_until`:

- wrong proof → `pin_failures + 1`, event `pin_failed`;
- failure 3 → `pin_locked_until = now + 15 min`, event `pin_locked`; while locked, every renewal answers `423 DEVICE_LOCKED` with `retry-after`, and the app shows the countdown;
- failures 4, 5 and 6 (after the lock ends) → at 6 the device is **revoked** with `revoked_reason = pin_bruteforce`, its tokens deleted, its sockets closed, and the owner e-mailed ("Um aparelho foi removido da sua conta por tentativas de PIN");
- a correct proof resets `pin_failures` to 0.

### 5.6 When the PIN is asked

- On cold start and after **5 minutes** in the background. Between those, the unwrapped `pin_secret` stays in memory and renewals are silent.
- **Approving a pending action always asks**, even when unlocked: `POST chat/actions/:id/decision` with `decision: 'approve'` needs a fresh challenge (`purpose: 'decision'`, bound to the action id) and `pin_proof = HMAC(pin_secret, challenge ‖ action_id ‖ 'approve')`. `deny` needs nothing beyond the normal proof of possession.
- **Biometrics** are an optional shortcut, enabled in Ajustes: the plain `pin_secret` is stored in a SecureStore item that requires Face ID / Touch ID / BiometricPrompt. Biometric failure or absence falls back to the PIN.

### 5.7 Revocation and leaving

Revoking on the web (or by the brute-force rule, or by an admin) sets `status = revoked`, clears the push token and closes that device's `/ws/m/chat` sockets with code `4401`. Its `device_tokens` stop resolving at once (the everyday lookup only accepts a token of an active device); the rows themselves stay until they expire and the hourly purge removes them, which is what lets the next call answer `DEVICE_REVOKED` rather than a plain `TOKEN_EXPIRED`; the app wipes key, secrets and PIN and returns to the first screen. "Sair e remover este aparelho" in the app is `POST devices/self/revoke` plus the same wipe. There is no "log out but keep the device".

## 6. Mobile API

All under `/api/m/v1`. Errors keep the wire shape `{ error, code }` with pt-BR `error` text. The app sends `X-Termhub-App: ios/1.0.0+12` on every call; when it is below `MOBILE_MIN_APP_VERSION` the server answers `426 APP_TOO_OLD` with a message that tells the person to update.

| Route | Auth | Permission | Notes |
|---|---|---|---|
| `POST devices/requests` | none | — | §4.2 |
| `GET devices/requests/:id` | request secret | — | §4.5 |
| `POST devices/activate` | DPoP only | `devices:create` (checked on the request's user) | creates the device |
| `POST session/challenge` | none | — | 60 s, single use |
| `POST session/token` | DPoP + pin proof | — | §5.3 |
| `GET me` | token | `chat:read` | user, permissions, device summary |
| `GET devices/self` | token | `devices:read` | this device |
| `POST devices/self/revoke` | token | `devices:delete` | leave |
| `PUT push-token` | token | `devices:update` | `{ token }` (Expo push token) |
| `GET chat?project=` | token | `chat:read` | same payload as the web |
| `GET chat/projects` | token | `chat:read` | `[{ id, name, key, busy, pending_confirmations, last_message_at }]` |
| `GET chat/host/options` | token | `chat:read` | the user's agent machines with `online`, `agent_version`, and each one's Claude accounts — one call instead of the web's two |
| `POST chat/host` | token | `chat:update` | same body as the web |
| `POST chat/messages` | token | `chat:create` | **`202 { conversation_id, user_message_id, assistant_message_id }`**; host errors and `CHAT_BUSY` stay synchronous 409s; run failures become the assistant message's `error_code` and the final `message` event, as today |
| `POST chat/reset` | token | `chat:update` | same as the web |
| `POST chat/actions/:id/decision` | token (+ pin proof for approve) | `chat:create` | same `decide`, same `decision` event to every client; answers `{ action, queued: true, note }` at once for approve and deny, and the resumed run's text, actions and `run_finished` arrive over `/ws/m/chat` |
| `GET transcriptions/config` | token | `terminals:read` | `{ enabled }` |
| `POST transcriptions?seconds=` | token | `terminals:create` | §7 |
| `GET transcriptions/:id` | token | `terminals:read` | poll |
| `GET notifications?before=` | token | `chat:read` | history, newest first, 50 per page, plus `unread` |
| `POST notifications/:id/read` | token | `chat:read` | |

### 6.1 `/ws/m/chat?v=1`

Server → client only, exactly the `ChatEvent` union of `/ws/chat` (`message`, `delta`, `action`, `action_result`, `reset`, `confirmation`, `decision`, `run_finished`), filtered by user on the server and by conversation in the app. On open the server sends `{ type: 'hello', protocol: 1, server_time }`. No replay: every (re)connect re-reads `GET chat`, like the web. Ping every 30 s. Close codes with meaning: `4400` unknown protocol version ("atualize o app"), `4401` device revoked. An access token expiring does not close an open socket; revocation does. iOS kills the socket in the background; the app reconnects and re-reads on foreground, and push covers the gap.

An upgrade that carries an `Origin` header is refused (`403`): browsers never use this route.

### 6.2 Versioning

`v1` in the path is the contract. Compatible additions (new optional fields, new event types the app may ignore) stay in `v1`; a breaking change ships as `v2` beside `v1`, because apps in the store keep running the old one. `MOBILE_MIN_APP_VERSION` is the lever to retire a build that must not run any more.

## 7. Dictation

Same contract as the web's dictation: the audio is the raw request body (`content-type: audio/*`, no multipart), `202 { transcription }`, then `GET transcriptions/:id` every second until `done` or `error`. Transcription stays on the server, in the `whisper` container; the phone only records and uploads; the text lands in the composer and **never sends by itself**.

Mobile-route limits:

- MIME allowlist: `audio/mp4`, `audio/m4a`, `audio/x-m4a`, `audio/aac`, `audio/3gpp`, `audio/webm`, `audio/ogg`, `audio/wav`. Anything else → `400`.
- 32 MB per upload (the existing `TRANSCRIPTION_MAX_BYTES`), `seconds` **required**, at most 300. If whisper measures more than 330 s the job ends in `error` with code `TOO_LONG`.
- 2 pending jobs per user (existing) and 10 uploads per device per 10 minutes.
- Recording with `expo-audio` (`expo-av` is deprecated), high-quality preset → AAC in `.m4a` on both platforms, uploaded as `audio/mp4` with `expo-file-system`'s binary upload. Auto-stop at 5 minutes, as on the web.

## 8. Data model

All additive: new tables and two nullable columns on `users`. The previous container never reads any of it, so a blue/green deploy stays safe. Ids from `newId()`, snake_case tables through `@@map`, timestamps as the rest of the schema.

| Table | Columns | Notes |
|---|---|---|
| `device_requests` | `id`, `user_id?` (null = decoy), `email_hash`, `public_key` (JWK text), `key_thumbprint`, `platform`, `model`, `os_version`, `device_name`, `app_version`, `verification_code`, `request_secret_hash`, `status` (`pending`, `approved`, `denied`, `expired`, `activated`), `ip`, `country?`, `city?`, `created_at`, `expires_at`, `decided_at?`, `activate_until?` | Indexes on `(user_id, status)`, `(email_hash, created_at)`, `expires_at`. Purged 24 h after expiry. |
| `devices` | `id`, `user_id`, `name`, `platform`, `model`, `os_version`, `app_version`, `public_key`, `key_thumbprint` (unique), `pin_secret_enc`, `pin_failures`, `pin_locked_until?`, `status` (`active`, `revoked`), `revoked_at?`, `revoked_reason?` (`user`, `admin`, `pin_bruteforce`, `review`), `push_token?`, `last_seen_at?`, `last_ip?`, `request_id?`, `created_at` | `pin_secret_enc` through `encryptSecret` (`ENCRYPTION_KEY`). Revoked rows are kept for the list and the trail. At most 5 active per user, enforced in code. |
| `device_tokens` | `id`, `device_id`, `token_hash` (unique), `expires_at`, `created_at`, `last_used_at?` | Hash only. Hourly purge of expired rows. |
| `device_challenges` | `id`, `device_id`, `challenge_hash` (unique), `purpose` (`refresh`, `decision`), `action_id?`, `expires_at`, `used_at?` | In the database, not in memory: survives a blue/green switch and works with more than one process. Single use. |
| `device_events` | `id`, `user_id?`, `device_id?`, `request_id?`, `kind`, `actor` (`user`, `admin:<id>`, `system`), `ip?`, `country?`, `city?`, `meta` Json, `created_at` | Kinds: `request_created`, `request_approved`, `request_denied`, `request_expired`, `device_activated`, `token_refreshed`, `pin_failed`, `pin_locked`, `device_revoked`, `push_token_set`, `review_auto_approved`, `review_changed`. `meta` holds ids and names, never secrets. Retention 90 days. |
| `user_notifications` | `id`, `user_id`, `kind`, `title`, `body`, `data` Json, `created_at`, `read_at?` | The in-app history (§9). Index `(user_id, created_at)`. Retention 30 days. |
| `users` (+2) | `review_enabled_until?`, `review_enabled_by?` | Null or in the past = review off. Never a boolean without an expiry. |

**Deliberately not in the database:** the `jti` replay set (5 minutes, in memory, per device) and the per-e-mail / per-IP counters (in memory, the waitlist pattern). Both tolerate a process restart without a security consequence: a `jti` reused right after a deploy still has to fit the ±60 s window, and the counters restart from zero.

**Permissions.** A `devices` resource (`create`, `read`, `update`, `delete`) joins the catalog in `auth/permissions.ts`. The migration grants it to every role that currently holds `chat:read` (in practice `BETA`; admins bypass), in the same SQL shape as the `api_tokens` and `chat_beta_role` migrations. Notifications and the mobile chat routes require `chat`; a user who loses `chat` loses the whole app on the next call, with no migration.

**Purge.** Joins the hourly routine that already prunes sessions and token events: requests expired for more than 24 h, expired tokens and challenges, events older than 90 days, notifications older than 30.

## 9. Push and the notification history

**Channel.** `expo-notifications` in the app; the server calls the Expo Push Service (`EXPO_PUSH_ACCESS_TOKEN`), which delivers through APNs and FCM. The APNs key and FCM service account live in EAS (manual step, §12).

**Registration.** On every start the app calls `PUT push-token`; the token lives in `devices.push_token` and is cleared on revocation or when Expo reports `DeviceNotRegistered`.

**Triggers — these three, nothing else:**

| Server event | Title / body (pt-BR, fixed shapes) | `data` |
|---|---|---|
| Pending action created (`confirmation` on the bus) | "termhub precisa de você" / "O chat do projeto termhub pediu confirmação para agir na aba api (jarvis)." — account-wide: "O chat geral pediu confirmação…"; no tab: "…pediu sua confirmação." | `kind: confirmation`, `conversation_id`, `project_id`, `action_id` |
| Run finished (new bus event `run_finished { conversation_id, message_id, ok }`, which the web ignores) | "Resposta pronta em termhub" / "O chat do projeto termhub terminou de responder." — or "O chat geral terminou de responder." | `kind: reply`, `conversation_id`, `project_id` |
| Device request created for an existing account | "Novo aparelho pede acesso" / "iPhone 15 (São Paulo) pediu acesso à sua conta. Confira o código e aprove ou recuse na web." | `kind: device_request` |

The text names the context — project, tab, machine, chat — because that is what makes a notification usable; it never carries a command, an argument, the action summary or the reply. Ids only in `data`.

**Recipients.** Every active device of the user that does **not** have a live `/ws/m/chat` socket at that moment (whoever has the app open already saw the event). "Resposta pronta" is collapsed per conversation (`collapseId`) and limited to one per conversation per minute; "precisa de você" is one per action. Tapping opens `termhub://chat/<conversation_id>`, after the PIN if the app is locked.

**History.** Every notification sent becomes a `user_notifications` row (per user, not per device), even when the push fails, so the list is complete. The app's **Notificações** tab lists them with an unread badge; tapping marks the row read and opens the chat; opening from the push marks it read too. The web does not show this list in this version.

**Code.** `MobilePushService` behind a `PushSender` interface (`ExpoPushSender` in production, a fake in tests), subscribed to `chatBus` (`confirmation`, `run_finished`) and called by the enrolment flow. Failures are logged with ids only and never affect the chat run.

## 10. Web

### 10.1 Configurações → Aparelhos

New section (key `devices`, group Conta, resource `devices`, so it is visible only inside the chat feature flag). Three parts, top to bottom:

1. **Pedidos pendentes** — one card per request (§4.4).
2. **Aparelhos conectados** — a table in the shape of Tokens de API: name (editable), model and OS, added on, last seen, situation (ativo; bloqueado por PIN até <hora>; revogado, with the reason). Revogar opens "Ele perde o acesso na hora. Isso não pode ser desfeito." Revoked rows stay, dimmed.
3. **Atividade** — the account's last 50 `device_events`, in pt-BR ("Pedido aprovado de iPhone 15", "PIN errado 3 vezes, aparelho bloqueado por 15 min", "Aparelho revogado por tentativas de PIN").

Empty state: "Instale o app termhub no celular e entre com seu e-mail. O pedido de acesso aparece aqui."

**Global banner.** While a request is pending, `Layout` shows "Um aparelho pede acesso à sua conta · Ver pedido" linking to the section. Fed by `GET /api/devices/summary` (pending and device counts), polled every 60 s only by users with `devices:read`.

**Routes** (cookie + CSRF, `guarded('devices', …, '/devices')`, always `request.user`, never "view as", like Tokens de API): `GET requests`, `POST requests/:id/approve`, `POST requests/:id/deny`, `GET /`, `PATCH /:id` (name), `DELETE /:id` (revoke), `GET events`, `GET summary`.

### 10.2 Review account panel (admin)

In Configurações → Usuários, on a user's detail, a panel "Revisão de loja":

- A switch "Modo revisão" that asks for a duration (1, 3 or 7 days) and writes `review_enabled_until` / `review_enabled_by`; shows "ligado até <data> por <admin>" and "Desligar agora". A second button, "Desligar e revogar os aparelhos", does both. Turning it off alone does not revoke, so the admin decides.
- Refused on an admin account: "A conta de revisão não pode ser admin." The account must be in a role that holds `chat` and `devices` (BETA); otherwise its requests become decoys like anyone else's, and the panel says so.
- That user's devices with Revogar (actor `admin:<id>`), and their last 50 events.
- Routes, guarded by `users`: `POST /api/users/:id/review { days | null, revoke_devices? }`, `GET /api/users/:id/devices`, `DELETE /api/users/:id/devices/:deviceId`.

**What review changes on the server:** a single `if`, inside `POST devices/requests`, after the account is found: if `review_enabled_until > now()`, the request is created already `approved`, actor `system`, event `review_auto_approved`. The response to the app is the same, the warning e-mail still goes out, the reviewer creates a PIN and activates like everyone else. Nothing else in the code knows review exists.

The review account is tied to a disposable, isolated environment defined by the operator (a VM or container with no secrets, no internal network, its own Claude account), never to real machines or production. That environment must be online, with the agent connected, for the whole review window (§12.3).

## 11. The app

### 11.1 Workspace

`apps/mobile`, `@termhub/mobile`: current Expo SDK, TypeScript, `expo-router`, EAS Build (development and production profiles) and EAS Submit. **Development builds, not Expo Go**, because of the native key module. Bundle / package id `dev.termhub.app`. The server URL is a constant (`https://termhub.dev`); test builds may point elsewhere through an EAS build-time variable, never through a screen.

| Need | Choice |
|---|---|
| Non-exportable P-256 key with silent signing | `@pagopa/io-react-native-crypto` (Secure Enclave on iOS, Keystore/StrongBox on Android). `expo-secure-store` stores data, it does not sign. The plan starts with a check of this library against the requirement; if it fails, an equivalent module replaces it without changing the design. |
| Wrapped `pin_secret`, salt, `device_id`, key tag | `expo-secure-store` |
| Biometric shortcut | a SecureStore item with `requireAuthentication`, plus `expo-local-authentication` for the prompt |
| PIN key derivation | `@noble/hashes` (scrypt, pure JS — the strength is on the server, §5.4) |
| Push, audio, upload, markdown | `expo-notifications`, `expo-audio`, `expo-file-system`, `react-native-markdown-display` |

**Server image.** The `Dockerfile` copies every workspace's `package.json` before `npm ci`; `apps/mobile` joins that list, and the `deps` stage installs only the workspaces the server needs (`npm ci -w …`) so React Native does not inflate the image. CI: the mobile workspace's `typecheck` and tests join the `check` job; app builds are manual (`eas build`), never on push.

### 11.2 Screens

Início ("Continuar com e-mail") → Aguardando aprovação (the verification code, large; "Abra o termhub na web para aprovar este aparelho"; "expira em X min") → Criar PIN → Desbloquear (numeric pad and biometrics) → tabs **Chats** (Chat geral and the projects, each with "respondendo" and a pending badge), **Notificações**, **Ajustes** (this device, biometrics switch, chat host, "Sair e remover este aparelho").

The conversation screen: thread, action cards (Autorizar → PIN/biometrics → decision; Recusar → decision), composer with the microphone button (record → upload → poll → text in the composer), host state lines ("máquina offline", "escolha a máquina", "agente antigo") and the host picker sheet on the account-wide chat, with the fresh-session warning the web shows. Assistant text is rendered as markdown; user text as plain text.

The chat logic the web already has as pure TypeScript (timeline merge, delta fold, per-conversation filter, host and failure copy) moves to `packages/mobile-api` and is imported by both; the rendering is written for React Native.

## 12. Deployment notes (manual steps)

### 12.1 Cloudflare and nginx

- **Access: nothing changes.** `termhub.dev` has no Access; these paths live there.
- nginx (`deploy/nginx/termhub.dev.conf.tmpl`, `termhub.dev` server): `location /api/m/` (per-IP zone keyed by `$http_cf_connecting_ip`, 10 r/s burst 20, `client_max_body_size 64k`, `proxy_read_timeout 60s`); `location /api/m/v1/devices/requests` and `location /api/m/v1/session/` in a tighter zone (2 r/s burst 5); `location = /api/m/v1/transcriptions` POST only, `client_max_body_size 32m`, `proxy_read_timeout 120s`; `location /ws/m/` with the upgrade headers, `limit_conn` 4 per IP, `proxy_read_timeout 3600s`. Every upstream through a variable, as the file's own comment demands.
- WAF: a rate-limiting rule on `/api/m/v1/devices/requests` (10 per minute per IP) as a second layer. **Bot Fight Mode and managed challenges must not fire on `/api/m/*`** — a native app cannot solve a challenge — so a WAF rule that skips challenges on that path is part of the setup.
- Location headers: `CF-IPCountry` arrives by default; enabling the "Add visitor location headers" managed transform gives `cf-ipcity` and is optional.
- Server env: `MOBILE_PUBLIC_URL` (the `htu` base, `https://termhub.dev`), `EXPO_PUSH_ACCESS_TOKEN`, `MOBILE_MIN_APP_VERSION`.

### 12.2 EAS

APNs key and FCM v1 service account registered in EAS credentials; `eas.json` with `development` and `production` profiles; store listings and the `termhub://` scheme.

### 12.3 Store review

- **Notes to the reviewer:** the review account's e-mail; that on this account the device is approved automatically and the app only asks to create a PIN; what the app does (a conversation with an assistant that acts on the user's own machines, every write confirmed by the person); that the demo machine is a disposable environment. **A pre-submission checklist** confirms the review environment is online with its agent connected, otherwise the chat answers "máquina offline".
- **Account deletion:** Apple's 5.1.1(v) and Google's policy require in-app deletion only when the app creates accounts; this one does not. The app offers "Sair e remover este aparelho"; the privacy policy and the notes say how to delete the account through the web or by e-mail.
- **Sign in with Apple:** not applicable — guideline 4.8 covers third-party / social login; this is a first-party e-mail + device approval login. Recorded here so it is not re-asked.
- Permission strings in pt-BR (microphone, Face ID, notifications), `ITSAppUsesNonExemptEncryption = false`, rating 4+, privacy policy at `termhub.dev/privacidade` (landing) declaring e-mail, device identifiers and audio processed without storage.

## 13. Threats

| Threat | What handles it |
|---|---|
| Stolen access token (traffic, log, backup) | Proof of possession on every call; 15-minute life; renewal needs the key and the PIN secret. |
| Replay of a captured call | Unique `jti` for 5 min, `iat` ±60 s, method and URL inside the signature; single-use challenges in the database. |
| Lost or stolen phone, locked | Non-exportable key; without the PIN the token dies in 15 min; web revocation kills everything at once. |
| Stolen phone, unlocked, or rooted | PIN on open and after 5 min; approval always asks; tag-less wrapping makes offline PIN testing impossible; 3 failures lock, 6 revoke, counted on the server. |
| PIN brute force | The counter is the server's and cannot be reset on the phone; revocation e-mails the owner. |
| Request spam against someone's e-mail (approval fatigue) | 3 per e-mail per 10 min, 10 per IP, 3 pending per account, 5 e-mails per hour; 10-minute expiry; nginx and WAF per-IP budgets. |
| Approving the wrong device | Verification code on both screens and the "O código no celular é X?" dialog; model, location and IP on the card. |
| Account enumeration | Identical response, timing and polling: every request is a row, a decoy when the account does not exist or cannot enrol. Residual: a real account costs one or two extra queries (`canAccess`, `countPending`) before the response; mail, push and events run in the background. |
| Abuse of the review account | Only while `review_enabled_until` is in the future; never an admin; every auto-approval and use audited; devices revocable by an admin; disposable machine with no secrets. |
| Web session used on mobile routes, or the reverse | A prefix with its own hook that ignores cookies; `/api` ignores device tokens; upgrades with `Origin` refused. |
| Prompt injection from terminal screens | Unchanged: the gate at `/mcp` and the human confirmation — now with a PIN — remain the last barrier. |
| Push payload leaking content | Fixed titles, names and ids only. |

## 14. Testing

The house pattern: a Fastify app per test file with fake `repos`, database tests behind `TERMHUB_DB_TESTS=1`, Vitest everywhere.

- **Server, unit:** DPoP verification (signature, `htu`, `iat` window, repeated `jti`, token of another device); PIN HMAC with the counter (3 → lock, 6 → revoke, success resets); verification-code alphabet; the neutral response identical byte for byte for an existing account, a missing one and one without permission; rate limits; the audio allowlist; push text built without sensitive content.
- **Mobile routes, `inject`:** the full request → approval → activation → token → chat flow; denial and expiry answering `closed`; revocation killing token and socket; `POST chat/messages` answering 202 with the run continuing behind it; a decision without proof refused; `426` on an old app; an upgrade with `Origin` refused.
- **Repositories (real Postgres):** `key_thumbprint` uniqueness, single-use challenge under concurrency, purges.
- **Web:** the Aparelhos section (approve through the code dialog, deny, revoke), the banner, the review panel.
- **App:** pure logic in Vitest (PIN derivation and wrapping, proof building, event fold, enrolment state machine); screens with React Native Testing Library against a fake API. A documented manual check of the native key module on iOS and Android.

## 15. Out of scope

Terminal, tasks, notes, office; self-hosted or configurable servers; account creation or social login in the app; approving a device from the app itself; the notification history on the web; passkeys on the web; attachments in the chat; a second language.

## 16. Delivery order

Each step ships alone.

1. **Server base:** migrations, the `devices` permission, the `/api/m/v1` prefix with DPoP and tokens, the full enrolment, the web device routes and the Configurações section, nginx. Testable with a command-line client before any app exists.
2. **Chat through the prefix:** chat routes, `/ws/m/chat`, the 202 send, decisions with PIN, dictation.
3. **The app:** enrolment, PIN, biometrics, chats, dictation; TestFlight and Play internal testing.
4. **Push and notifications:** the table, the service, the tab.
5. **Review and stores:** the review panel, reviewer notes, privacy policy, submission.
