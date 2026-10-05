# Test push to one's own device — design (TER-913)

Status: proposal, not implemented. Came out of the push test plan
(`2026-10-04-mobile-push-test-plan.md`, TER-901).

## 1. Problem

The only way to get a push today is a real event: a concierge confirmation, a tab question, a finished
reply or a device request (`apps/server/src/mobile/push.ts`). Each takes a chat run or an agent tab, and
pushes are skipped while the phone has a live socket. So checking "does a push reach this phone, closed,
and does the tap open the right screen" takes minutes per try. A credential problem on the Expo side
(missing or expired APNs key or FCM V1 key) is also invisible: the send succeeds and nothing arrives,
because Expo receipts are never read (TER-924).

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Who can send | The signed-in user, only to an **active device of their own**. | A test must never reach someone else's phone. |
| Two entry points | Web: `POST /api/devices/:id/test-push` (Aparelhos page). App: `POST /api/m/v1/push-test` (the calling device). | The web button is the only way to test with the app **closed**. The app button is handy for a quick check. |
| What it sends | The same text and `data` shapes as a real push of the chosen `kind`, with "[Teste] " before the title and `data.test: true`. | It exercises the real tap path (`conversation_id` → chat, `device_request` → nothing) without a real event. |
| Conversation | `data.conversation_id` is the user's most recently active conversation (any project). If there is none, the push has no conversation and the tap just opens the app. | The deep link stays real, so the tap actually lands somewhere. |
| Live socket | Ignored: the push goes to the chosen device even when it is open. | The point is to see the push. The foreground handler shows a banner. |
| History | **No** `user_notifications` row. | A test is not something the person has to act on. It must not raise the unread badge. |
| Delay | `delay_seconds` 0–120. Web default 0. App default 10. | Time to close the app or lock the phone. In-process timer on the active color. A deploy in between drops it, which is fine for a test. |
| Rate limit | 6 per minute per device (`SlidingWindow`, like the reply limit), 429 `PUSH_TEST_RATE_LIMITED` beyond that. | Enough for a test session, useless for spam. |
| Result | The answer carries the Expo ticket (`ok`, or the error code). About 15 s later the server fetches the receipt and records a device event `push_test` with `{ kind, outcome }` (`delivered_to_provider`, or the receipt error code such as `InvalidCredentials`, `DeviceNotRegistered`). Aparelhos shows it in the device's events. | Tells "the server did not send" apart from "APNs/FCM refused it". `DeviceNotRegistered` clears the token as today. |
| Device without a token | 409 `NO_PUSH_TOKEN`, pt-BR message "Este aparelho ainda não ativou as notificações." | Tells the person what to fix. |
| Pending deletion | Refused like every other route (the mobile route is not `allowPendingDeletion`). | Same rule as TER-920. |
| Logs | Ids, kind and outcome only. Never the token. | Project rule. |

## 3. API

```http
POST /api/devices/:id/test-push         (web session; resource `devices`, action `update`)
POST /api/m/v1/push-test                (mobile auth, action `update`; the calling device)
Content-Type: application/json

{ "kind": "confirmation" | "tab_question" | "reply" | "device_request", "delay_seconds": 0 }
```

zod: `kind` defaults to `confirmation`. `delay_seconds` is an integer from 0 to 120. The web route loads the
device with the user's id (404 when it is not theirs or not active). The body schema lives in
`@termhub/mobile-api` (`pushTestBody`) so the app and the server share it.

Answer `202`:

```json
{ "scheduled_for": "2026-10-04T23:10:05.000Z", "ticket": { "status": "ok" } }
```

With `delay_seconds > 0`, `ticket` is `null`: the outcome comes later as the `push_test` event.

Text per kind, from `push-text.ts`. The names come from the chosen conversation's project, or are
fixed sample names when there is none:

| kind | Title | Body |
|---|---|---|
| confirmation | "[Teste] {projeto} precisa de você" | `confirmationText` with the conversation's project, no tab |
| tab_question | "[Teste] {projeto} precisa de você" | `tabQuestionText(ctx, 'permission')` with tab "teste" |
| reply | "[Teste] Resposta pronta em {projeto}" | `replyText` |
| device_request | "[Teste] Novo aparelho pede acesso" | `deviceRequestText({ model: 'Aparelho de teste', … })` |

## 4. Components

- `apps/server/src/mobile/push.ts`: `PushSender.send` also returns the Expo ticket `id`. A new
  `ExpoReceipts.fetch(ids)` (`/--/api/v2/push/getReceipts`, chunks of 300, 10 s timeout) is shared
  with TER-924. `MobilePushService.testPush(user, device, kind)` builds the message from the same
  text functions and sends it to that one device, bypassing `offline()` and `deliver`'s history row.
- `apps/server/src/routes/devices.ts` (web) and `apps/server/src/routes/m-devices.ts` (mobile): the two
  routes, registered under the existing `devices` resource. No new resource.
- `apps/server/src/db/repositories/device-events.ts`: new kind `push_test`, with its pt-BR label in
  `routes/devices.ts` ("Notificação de teste: entregue ao Apple/Google" / "Notificação de teste
  falhou: {código}").
- Web, Aparelhos: per active device with notifications on, "Enviar notificação de teste" with a kind
  select and a delay (0 / 10 / 30 s).
- App, Ajustes → Notificações: "Enviar notificação de teste" (only when the status is `granted`), with
  a 10 s delay and a hint "Feche o app para ver como ela chega." Also show the running OTA update id
  (`expo-updates` `Updates.updateId`, or "binário" when embedded) next to the version, so a test run can
  record binary and OTA.
- Tap handling needs no change: `data.conversation_id` and `data.notification_id` keep their meaning.
  A test push has no `notification_id`, so nothing is marked read.

## 5. Not doing

- No CLI or MCP tool: the web button covers the closed-app case. `mobile-client` cannot receive a
  push.
- No broadcast to all devices, no admin sending to other users' devices.

## 6. Testing

- `push.test.ts`: `testPush` sends one message to the chosen device even with a live socket, writes no
  history row, prefixes the title, sets `data.test`. A ticket error `DeviceNotRegistered` clears the
  token. The receipt check records `push_test` with the outcome.
- Route tests: another user's device → 404. Revoked → 404. No token → 409. Seventh call in a minute →
  429. Pending deletion (mobile) → 403. zod rejects `delay_seconds: 121`.
- Web and app component tests for the buttons.

## 7. Impact on other users

A new "Enviar notificação de teste" action in Aparelhos (web) and in the app's Ajustes, for everyone.
It only sends when the person clicks, only to their own device, and writes nothing to their
notification history. Nothing changes by default.
