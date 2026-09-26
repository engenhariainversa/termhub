# termhub mobile app — architecture and the mocked first cut — design

**Status:** approved in conversation (Pedro, 2026-09-24): decisions in §2 were each chosen by him. Implements the app half of `2026-09-24-mobile-chat-app-design.md` (the *product* spec, referred to as **P§n** below) on top of the scaffold of PR #134, **before the server exists**: everything the phone does is real, only the network is a fake that lives inside the app. Nothing here changes P; where P and this document overlap, P wins.

## 1. Why

The server side of the mobile chat (`2026-09-24-mobile-chat-server.md`) is being implemented in parallel. Waiting for it means the app's architecture, its enrolment and PIN flows and its screens would all be designed and debugged at the very end, against a live server. Building the app now against an in-memory implementation of the same contract gets three things early: the architecture is settled while it is cheap to change, the security logic of P§5 (wrapping, proofs, lock counting) is written and unit-tested once, and the screens can be tried on a phone this week.

Success: on a development build with no server, a person can enter an e-mail, see the verification code, "approve" it, create a PIN, unlock with the PIN or biometrics, read and send messages in a project chat, watch an answer stream, approve a pending action with the PIN, be locked out after three wrong PINs, and remove the device — and every one of those steps is the code the real server will talk to, with one implementation of one interface swapped.

## 2. Decisions

| Question | Decision |
|---|---|
| Where the fake lives | **In memory, inside the app, at the transport level.** The real client (`HttpMobileApi`: routes, DPoP headers, renewal, the socket) is written now against the contract of `packages/mobile-api`; the fake is a `MockTransport` that answers the same URLs with the same status codes, bodies and socket frames, so the app runs on the simulator, on a phone and in Jest with nothing running, and switching to the server is `EXPO_PUBLIC_API_MODE=http` and nothing else. `mock` is the default until the server ships. |
| Architecture | **MVVM by feature**, the same shape as the Opa Pingou app: `src/features/<feature>/{model,viewmodel,view}`. Views never call a service; viewmodels never import React Native. The `logic` Jest project enforces the second rule by throwing on `react-native`. |
| State | **zustand** stores as the viewmodels, `persist` with `createJSONStorage` over **MMKV** (`react-native-mmkv`) for everything that is not a secret. Secrets go to `expo-secure-store`, never to MMKV. |
| Styling | **NativeWind v4** (Tailwind classes) with the termhub palette as CSS variables on one root `View`, as in Opa Pingou, so the light/dark flip repaints everything. |
| Simulated approval | Only in mock mode, the *Aguardando aprovação* screen shows **"Simular aprovação na web"** and **"Simular recusa"**. Nothing approves by itself; expiry (10 min, P§4.3) still runs. |
| Chat logic | **Copied from `apps/web`** now (`chatTimeline`, the live-event fold, the per-conversation filter, the error sentences) with their tests, into `src/features/chat/model`. When `@termhub/mobile-api` reaches `main`, these become imports from there (P§3, P§11.2) and the copies are deleted. |
| Device key | Behind a `DeviceKey` interface. `HardwareDeviceKey` (`@pagopa/io-react-native-crypto`) is written but only exercised on a real device, which is the app plan's first check (P§11.1); `SoftwareDeviceKey` (P-256 with `@noble/curves`, private key in SecureStore) runs the mock on simulators and in Jest. |
| Proof of possession | DPoP proofs are **built for real** (`htm`, `htu`, `iat`, `jti`, `ath`, `chal`; ES256 over the device key) and the mock **verifies them** against the public key it received at enrolment, so a wrong `htu` or `ath` fails here, not against the server. |
| Contract source | The request, response and event schemas are **the zod schemas of `packages/mobile-api`**, copied verbatim into `src/services/api/contract/` with the source commit in a header comment, used by the client to type and by the mock to validate, exactly as the server does. When that package reaches `main`, the copies become imports. |

## 3. Architecture

```
app/ (expo-router)             thin: picks the view for a route, nothing else
  └── src/features/*/view      React Native + NativeWind; read stores, call viewmodel actions
        └── viewmodel          zustand stores + persist(MMKV); orchestration, no RN imports
              └── model        pure logic (PIN wrap, proofs, timeline), types, services
                    └── src/services/api      MobileApi = HttpMobileApi over a Transport ── FetchTransport | MockTransport
                    └── src/services/key      DeviceKey port  ── SoftwareDeviceKey | HardwareDeviceKey
                    └── src/services/vault    SecureStore wrapper for the few secrets
```

Dependencies point down only. A feature knows the session (through the `sessionEnded` signal and the session store), never the reverse. The `api` and `key` services are chosen once at boot from `EXPO_PUBLIC_API_MODE` and `Platform`/mock mode; every consumer imports the instance, never a concrete class.

### 3.1 Folder layout

```
apps/mobile/
  app/                          routes (unchanged set from PR #134); each file renders one view
  src/
    services/
      api/index.ts              `api: MobileApi` — HttpMobileApi over the transport chosen from env
      api/contract/             zod schemas copied from packages/mobile-api (+ the types inferred from them)
      api/client.ts             HttpMobileApi: routes, headers, DPoP, renewal, error mapping
      api/socket.ts             the /ws/m/chat client: hello, reconnect, re-read, close codes
      api/transport.ts          Transport { fetch, connect } + FetchTransport (fetch + WebSocket)
      api/errors.ts             ApiError { status, code, message, retryAfter? }
      api/mock/                 MockTransport (router, state, fixtures, proof verification) + MockControls
      key/                      DeviceKey, SoftwareDeviceKey, HardwareDeviceKey
      vault.ts                  SecureStore items (typed keys)
      storage.ts                MMKV instance + zustand StateStorage
    features/
      session/                  enrolment, activation, PIN, unlock, lock, revoke
      chat/                     projects, conversation, live events, decisions
      notifications/            history and unread
      settings/                 device, biometrics, host, leave
      theme/                    light/dark preference
      shared/                   signals, relative-time, small helpers
    ui/                         Screen, Text, Button, Field, PinInput, Sheet, Card… (NativeWind)
    theme/tokens.ts             palette (CSS vars) for both schemes
  test/                         jest setup, MMKV/SecureStore/key fakes
```

## 4. The API port

`MobileApi` is the contract of P§6, one method per route, typed by the zod schemas copied from `packages/mobile-api`. It has **one implementation**, `HttpMobileApi`, which talks to a `Transport`:

```ts
interface MobileApi {
  readonly mode: 'mock' | 'http';
  // enrolment (P§4)
  requestDevice(body: DeviceRequestBody): Promise<DeviceRequestResponse>;          // 202 always
  pollRequest(requestId: string, requestSecret: string): Promise<DevicePollResponse>;
  activate(body: DeviceActivateBody, proof: DpopProof): Promise<DeviceActivateResponse>;
  // session (P§5)
  challenge(body: ChallengeBody): Promise<ChallengeResponse>;
  token(body: TokenBody, proof: DpopProof): Promise<TokenResponse>;
  me(auth: Auth): Promise<MeResponse>;
  deviceSelf(auth: Auth): Promise<DeviceSelf>;
  revokeSelf(auth: Auth): Promise<void>;
  setPushToken(auth: Auth, token: string): Promise<void>;
  // chat (P§6, §6.1)
  chatProjects(auth: Auth): Promise<ChatProjectsResponse>;
  chat(auth: Auth, projectId: string | null): Promise<ChatResponse>;               // conversation, messages, actions, host
  hostOptions(auth: Auth): Promise<HostOptionsResponse>;
  setHost(auth: Auth, body: SetHostBody): Promise<void>;
  sendMessage(auth: Auth, body: MobileMessageBody): Promise<SendAccepted>;           // 202
  reset(auth: Auth, projectId: string | null): Promise<void>;
  decide(auth: Auth, actionId: string, body: MobileDecisionBody): Promise<void>;
  // notifications (P§9)
  notifications(auth: Auth, before?: string): Promise<NotificationsResponse>;
  markRead(auth: Auth, id: string): Promise<void>;
  // the socket (P§6.1): server → client events, filtered by user on the server
  events(auth: Auth, onEvent: (e: ChatEvent) => void, onClose: (code: number) => void): () => void;
}
type Auth = { accessToken: string; proof: (htm: string, path: string) => Promise<DpopProof> };
```

`Auth` carries the token and a proof *factory*: every call signs its own `htm`/`htu`, as P§5.2 demands, and the caller never sees a key. Errors are `ApiError { status, code, message, retryAfter? }` with the wire shape `{ error, code }` (message in pt-BR); `401 DEVICE_REVOKED` and `423 DEVICE_LOCKED` (with `retryAfter`) are the two the session store reacts to; `426 APP_TOO_OLD` shows a blocking sheet.

### 4.1 `HttpMobileApi` and the transport

```ts
interface Transport {
  fetch(input: { method: string; url: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; text: string }>;
  connect(url: string, headers: Record<string, string>, handlers: { onOpen; onMessage(text); onClose(code) }): { close(): void };
}
```

`FetchTransport` is `fetch` and React Native's `WebSocket` (which accepts upgrade headers). `HttpMobileApi` owns everything P§5.2, P§6 and P§6.1 ask of a client, so that the day the server exists nothing above it changes:

- **Every call**: `X-Termhub-App: <platform>/<version>+<build>`, `Authorization: Bearer <token>` when `Auth` is given, and `DPoP: <compact JWS>` from `Auth.proof(htm, path)`, with `htu = canonicalHtu(TERMHUB_URL, path)` (P: base without trailing slash, path without query), `iat` corrected by the **clock skew** learned from the `Date` response header of every answer (and from `hello.server_time`), a fresh `jti`, `ath = base64url(sha256(token))` when there is a token, `chal` on `session/token`.
- **Responses** are parsed with the contract's zod schema; a body that does not parse is an `ApiError(502, 'BAD_RESPONSE')`. Non-2xx bodies map to `ApiError` with the wire `code`, `Retry-After` into `retryAfter`.
- **Renewal**: one `401 TOKEN_EXPIRED` triggers `onTokenExpired()` — the session store's single-flighted `challenge` + `token` — and the call is retried once with the new token. A second `401` surfaces. `DEVICE_REVOKED` and `APP_TOO_OLD` are never retried.
- **The socket** (`api/socket.ts`): `connect(MOBILE_WS_URL, { Authorization, DPoP })` with a proof for `GET /ws/m/chat`; the first frame must be `hello` (protocol `1`, `server_time` feeds the skew), then every frame is parsed with `chatEventSchema` and delivered; `onReconnect` fires on every open so the store re-reads `GET chat` (the web's rule: no replay). Backoff 1 s → 30 s, reset on open; a socket is closed and not reopened on `4400` (the store shows "atualize o app") and `4401` (the store wipes). Foreground (`AppState` → `active`) reconnects immediately if closed; the token expiring does not close it (P§6.1).

### 4.2 `MockTransport`

One in-memory "server" per app process, deterministic, that answers the same URLs `FetchTransport` would reach: a small router keyed by method and path (`POST /api/m/v1/devices/requests`, …) that validates bodies with the same zod schemas, checks the DPoP proof for real (ES256 signature against the JWK stored at enrolment, `htm`/`htu`/`ath`/`iat` window/`jti` uniqueness — the rules of P§5.2), and answers status codes, `{ error, code }` bodies and a `Date` header. `connect()` returns a fake socket that emits JSON frames. It carries the rules of P§4–P§6 that the app can observe:

- **Enrolment.** `requestDevice` answers `202` with a `request_id`, a `request_secret`, a 6-char code from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, `expires_at = now + 10 min`, `poll_after = 2000`, for any e-mail. `pollRequest` is `pending` until a `MockControls` call flips it: `approve(requestId)` → `approved` with `activate_until = now + 10 min`; `deny(requestId)`, expiry or an unknown id → `closed`. `activate` with a stale or wrong secret → `401`; on success creates the device, returns `device_id`, a 32-byte `pin_secret` (base64url), an access token (15 min) and records the public JWK.
- **Session.** `challenge` → 60 s, single use, `purpose` `refresh` or `decision` bound to an `action_id`. `token` verifies the DPoP signature **before** counting anything (P's review focus 1: only the device itself can burn attempts), then the proof: `pin_proof === base64url(HMAC-SHA256(pin_secret, challenge))`. Wrong → `pin_failures + 1`; at 3 → `423 DEVICE_LOCKED` for 15 min (`retryAfter`); at 6 → device revoked (`revoked_reason = pin_bruteforce`), tokens deleted, live event stream closed with `4401`. Right → failures reset, new token. An expired or unknown access token → `401 TOKEN_EXPIRED`; a revoked device → `401 DEVICE_REVOKED` on every call; a replayed `jti` → `401 PROOF_REPLAYED`; a bad `htu` or `ath` → `401 PROOF_INVALID`.
- **Chat.** Fixtures: the account-wide chat and three projects (`termhub`, `opapingou`, `reactivando`) with a few messages each and one pending action in `termhub` ("digitar `npm test` na aba api do projeto termhub, no jarvis"). `sendMessage` answers `202` at once, then streams: a `message` event for the user row, a `message` for the empty assistant row, five to ten `delta` events over ~3 s, and a final `message` with the full text — the same sequence the web sees. One canned answer per keyword ("teste", "deploy", "status") and a default; a message containing "erro" ends with `error_code = HOST_GONE` instead of text, so the failure copy is exercised. A message containing "confirma" produces a new `confirmation` event (a pending action). `decide` with `deny` needs nothing; `approve` on a `write` action approves without proof; otherwise `401 PIN_REQUIRED`. A proof that is sent — a `decision` challenge for that action and a valid `pin_proof = HMAC(pin_secret, challenge + '\n' + action_id + '\napprove')` (P§5.6) — is always checked. Answers `409` if already decided, then emits `decision`. `host` is always `{ kind: 'ready', machine: { id, name: 'jarvis' }, account: { kind: 'default' }, sessionAtStake: false }`; `hostOptions` lists two machines and `setHost` swaps the name. `reset` archives the conversation and starts an empty one.
- **Notifications.** Every `confirmation` and every finished run adds a row (P§9 texts); `notifications` pages 50 newest with `unread`; `markRead` sets `read_at`.
- **Events.** The fake socket refuses an upgrade without a valid token and proof (close `4401`), sends `hello` first, then everything above for the enrolled device, on a `setTimeout` chain so React sees separate ticks; it closes with `4401` on revocation and with `4400` when the URL's `v` is not `1`.
- **Controls.** `MockControls` (exported only from the mock module, reached by the *Aguardando* screen through the viewmodel's `mockControls` field, which is `null` in `http` mode): `approve`, `deny`, `expireNow`, `lockNow`, `revokeNow`, `dropSocket` (to watch the reconnect). Latency: 150–400 ms per call, so loading states are visible; `0` under Jest.

The mock keeps no state across restarts on purpose: a restart of the app is a fresh server, which makes "Sair e remover este aparelho" and a stale device both testable (the device the app remembers no longer exists → `DEVICE_REVOKED` → wipe, P§5.7).

## 5. Session feature

### 5.1 Phases

The session store owns one `phase` and the router reads nothing else:

```
new ──requestDevice──▶ waiting ──approved──▶ pin_setup ──activate──▶ locked ──unlock──▶ unlocked
                          │ closed/expired ▶ new                               ▲              │ 5 min in background,
                                                                               └──────────────┘ cold start
any ──DEVICE_REVOKED / "Sair e remover"──▶ new (after a full wipe)
```

Persisted in MMKV (`session` store): `phase` (only `new` | `locked` survive a restart; `waiting`/`pin_setup` collapse to `new`, because the request expires anyway and a PIN never got created — P§4.5), `deviceId`, `deviceName`, `email` (for the banner copy only), `biometricsEnabled`, `lastBackgroundAt`. **Never** persisted: the request secret, the access token, the unwrapped `pin_secret`, the challenge.

In SecureStore (`vault`): `key.private` (software key only), `pin.wrapped`, `pin.salt`, `pin.biometric` (the plain secret behind `requireAuthentication`, present only while biometrics are on), `device.id` (duplicated here so a wiped MMKV cannot resurrect a half session).

### 5.2 Enrolment (P§4)

`requestDevice(email)`: generates the key (`DeviceKey.create()`), reads `Device.modelName`, `Device.osVersion`, `Device.deviceName` (`expo-device`) and the app version (`expo-application`), calls the API, stores `requestId`, `requestSecret`, `verificationCode`, `expiresAt` in memory and moves to `waiting`. The viewmodel polls every `poll_after` ms until `approved` (→ `pin_setup`) or `closed` (→ `new` with a reason line: "O pedido expirou ou foi recusado. Tente de novo."). The screen shows the code as `K7F-2QD`, the countdown, "Abra o termhub na web para aprovar este aparelho", and, when `mockControls` is present, the two simulation buttons.

### 5.3 PIN and activation (P§4.5, P§5.4)

`createPin(pin, confirm)`: six digits, equal twice, no other rule (a PIN is a server-counted secret, not a password). Then `activate`: a DPoP proof with no `ath` over `POST /devices/activate`, the API returns `pin_secret`; the store derives `salt = random(16)`, `k = scrypt(pin, salt, { N: 2**14, r: 8, p: 1, dkLen: 32 })` (async; 2**14 keeps the JS thread free for well under a second on a phone — the strength is on the server, P§5.4), stores `wrapped = pin_secret XOR k` and `salt` in the vault, keeps `pin_secret` in memory, stores the access token in memory, and moves to `unlocked`. Abandoning the PIN screen keeps `pin_setup` in memory only; the request expires on the server side by itself.

### 5.4 Unlock and renewal (P§5.3, P§5.5)

`unlock(pin)`: `k = scrypt(pin, salt)`, `candidate = wrapped XOR k`, `challenge` from the API, `pin_proof = HMAC(candidate, challenge)`, `token()` with a DPoP proof carrying `chal`. Success → keep `candidate` as the unwrapped secret, store the token, `unlocked`. `401 PIN_INVALID` → "PIN incorreto", plus a remaining-attempts line when the response carries an optional `attempts_left` (the mock sends it; P does not promise it, so its absence hides the line); `423` → `locked` with `lockedUntil` and a countdown; `401 DEVICE_REVOKED` → `wipe()`. The app never compares the PIN locally (P§5.4 is the reason: every guess must cost a server call).

Silent renewal: while `unlocked`, a `401 TOKEN_EXPIRED` from any call triggers one `challenge` + `token` with the in-memory secret, single-flighted, and the failed call is retried once. If the secret is gone from memory (the app was relaunched), the store moves to `locked` instead.

Proactive renewal: the store also schedules a timer from `expires_in`, learned at activation and at every renewal, and renews at `expires_in − 60 s` while `unlocked`; a relock or wipe clears the timer. A timer that fires late (the app was in the background) is harmless — the reactive path above still covers it. The socket renews before its next reconnect attempt only when the token is stale (past `expires_at − 60 s`, or no expiry known); a refused upgrade with a fresh token just backs off, so a refusal unrelated to the token never turns into a renewal loop.

Relock: `AppState` `background` stamps `lastBackgroundAt`; `active` after more than 5 min, or a cold start, drops the in-memory secret and token and sets `locked`. The `unlocked` → `locked` transition never touches the vault.

Biometrics (P§5.6): `enableBiometrics()` asks the OS prompt once (`expo-local-authentication`), then writes the plain secret to `pin.biometric` with `requireAuthentication: true`; `unlockWithBiometrics()` reads it (the OS prompts) and continues as `unlock` does from the challenge. Any failure falls back to the PIN pad. Turning it off deletes the item.

### 5.5 Leaving and revocation (P§5.7)

`leave()`: `revokeSelf` (best effort), then `wipe()`. `wipe()` deletes every vault item, resets every persisted store (through `sessionEnded`), closes the event stream and sets `new`. A `DEVICE_REVOKED` from any call, or a `4401` close, calls `wipe()` and shows "Este aparelho foi removido da sua conta." on the first screen.

## 6. Chat feature

**Model** (copied from the web, with tests): the `ChatMessage`, `ChatAction`, `ChatEvent`, `ChatHostState` types; `chatTimeline(messages, actions)`; `foldLive(events)` → `{ deltas, actions, started }` (the `useMemo` body of `ChatPanel`, extracted); `belongsTo(conversationId)(event)`; `errorSentence(code)` (the `ChatTurn` table); `hostLine(host)` (the sentences of `ChatHost`). None of it imports React.

**Viewmodel** `useChatStore` (MMKV-persisted: the last `projects` list and, per conversation, the last loaded `messages`/`actions`, so a cold open shows the thread before the fetch): `loadProjects()`, `open(projectId)` (fetch + subscribe), `send(text)` (`202` → the thread updates only through events, as on the web), `decide(actionId, 'approve' | 'deny')` — `approve` asks the session store for a **decision proof** (`challenge(purpose: 'decision', action_id)` + PIN or biometrics, P§5.6) through a `requestPinProof(actionId)` promise the unlock sheet resolves; `deny` does not — `reset()`, `changeHost()`. Live events go through `belongsTo` before touching state; `message` events re-read the thread (the web's rule), `confirmation`/`decision` update the actions list in place.

**Views**: `ChatsScreen` (Chat geral + projects, "respondendo…" while `busy`, a badge with `pending_confirmations`), `ConversationScreen` (timeline in a `FlatList`, `MessageBubble` — markdown for the assistant via `react-native-markdown-display`, plain text for the person —, `ActionCard` with Autorizar/Recusar and the queued note, `ThinkingRow` for a started-but-empty answer, `HostLine`, `Composer` with a send button; the microphone button is rendered disabled with "em breve"), `HostSheet` for the account-wide chat.

## 7. Notifications and settings

`useNotificationsStore`: `load()`, `loadMore()`, `markRead(id)`, `unread`; a `confirmation` or `run_finished`-derived row arriving over the stream is prepended. The tab lists rows with title, body and relative time; tapping marks read and opens `chat/[conversation_id]`. Push registration is not wired (P§9 says the server calls Expo; the mock has no way to deliver a push), but `setPushToken` is called with a fake token so the flow exists.

`useSettingsStore` (MMKV): `theme: 'system' | 'light' | 'dark'`, nothing else — the device, biometrics and host live in their own stores. The Ajustes screen shows the device (`deviceSelf`), the biometrics switch (session store), the host line with a change button (chat store), the theme picker, the app version and "Sair e remover este aparelho" behind a confirmation sheet.

## 8. Navigation

`app/_layout.tsx` waits for the session store's `hydrated`, then renders one `Stack` and redirects by `phase`: `new` → `/`, `waiting` → `/enrol/waiting`, `pin_setup` → `/enrol/create-pin`, `locked` → `/unlock`, `unlocked` → `/(tabs)`. Routes inside a group are only reachable in their phase; a deep link `termhub://chat/<id>` while `locked` is stored as `pendingRoute` and followed after the unlock (P§9). The route files stay one-liners that render the feature's view.

## 9. UI

NativeWind v4 with `tailwind.config.js` (`darkMode: 'class'`, `nativewind/preset`) and `src/theme/tokens.ts` exporting the termhub palette for both schemes (`bg`, `surface`, `border`, `text`, `muted`, `accent` = `#5B63D3`, `accentSoft`, `danger`, `ok`), published as CSS variables by a `ThemeProvider` on the root `View` and mapped to `app-*` colour utilities, exactly as in Opa Pingou. System font; no font loading. Components in `src/ui`: `Screen` (safe area + padding), `Text` variants, `Button` (primary, secondary, danger, loading), `Field`, `PinInput` (the system number pad under `PinDots`) and `PinDots`, `Sheet` (bottom sheet on a `Modal`, rising with the keyboard), `Card`, `EmptyState`, `Countdown`, `Banner`. Copy in pt-BR throughout.

## 10. Testing

- **`logic` project** (plain Node, RN import throws): PIN wrap/unwrap round-trip and "any PIN unwraps to 32 bytes"; `pin_proof` and decision proof vectors; DPoP proof shape (`htm`, `htu`, `iat`, `jti`, `ath`, `chal`) and `SoftwareDeviceKey` sign/verify; `HttpMobileApi` against a scripted transport (headers on every call, skew correction from `Date`, one renewal then retry, no retry on `DEVICE_REVOKED`, zod refusal of a bad body, socket `hello` → events → backoff → `4400`/`4401`); the copied chat helpers with the web's own tests; `HttpMobileApi` over `MockTransport` end to end (request → approve → activate → wrong PIN ×3 → 423 → right PIN → chat → 202 + events → approve with proof → 409 on repeat → replayed `jti` → 401 → revoke → 4401); every store over the mock transport with fake MMKV/SecureStore/key and `latency: 0`.
- **`ui` project** (jest-expo + Testing Library): Início submits an e-mail; Aguardando shows the formatted code and the mock buttons; Criar PIN refuses a mismatch; Desbloquear shows "PIN incorreto", then the lock countdown; Conversa renders a streaming answer and an action card, and Autorizar opens the PIN sheet; Ajustes removes the device.
- **Manual, on a device** (documented in `apps/mobile/README.md`): the full flow on a development build in mock mode; `HardwareDeviceKey` create/sign/thumbprint on iOS and Android (P§11.1's first check) — a `Ajustes → Diagnóstico da chave` row runs it and shows the result.

## 11. Out of scope

Pointing at a real server (the client is ready; only `FetchTransport` against `termhub.dev` is untested until the server exists); dictation (P§7); real push delivery; the store-review switch; the account-wide host picker's fresh-session warning beyond the sentence; account creation; a second language.

## 12. Delivery order

Each step is a task group of the plan and leaves the app runnable.

1. **Foundations**: NativeWind + tokens + `ui` components; MMKV storage, vault, signals; `DeviceKey` (software) and the DPoP/PIN model with tests.
2. **API client and mock transport**: the contract copy, `ApiError`, `HttpMobileApi` and the socket client with their scripted-transport tests, `MockTransport` with fixtures, proof verification and controls, the end-to-end test.
3. **Session**: store, enrolment → PIN → activation → unlock/lock/biometrics/leave; the five session screens; root navigation by phase.
4. **Chat**: copied model + tests, chat store, Chats and Conversa screens, decisions with PIN.
5. **Notifications and settings**: stores and tabs; theme; hardware key diagnostic; README and the manual checklist.
