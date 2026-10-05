# Mobile push notifications — test plan (TER-901)

End-to-end manual test of the termhub app's push notifications on iOS and Android. This plan maps
what the code does today (2026-10-04, `main` at `fa825338`), lists every case by platform and app
state, and gives each case its steps and expected result. The maintainer runs it on real phones.
Gaps found while reading the code are cards on the board. A case that is expected to fail today names
its card.

Related: product spec `2026-09-24-mobile-chat-app-design.md` §9 (push and history), permission prompts
`2026-09-30-mobile-permission-prompts-design.md` (TER-628), account deletion (TER-720), issue #208
(a seen wait that comes back), and the test endpoint proposal `2026-10-04-push-test-endpoint-design.md`
(TER-913).

## 0. Status after the fixes (2026-10-05)

The cards from §6 shipped (server deploy + OTA of the `production` channel), except TER-922, which waits
for evidence from the phone. Sections 1–5 below describe the code as it was on 2026-10-04; where they
say "expected to fail today" or "likely today", read this table instead.

| Card | PRs | What changes for the cases |
|---|---|---|
| TER-913 | #322, #323, #324, #327 | Test push: web Aparelhos → "Notificação de teste" (kind + delay 0/10/30 s, any of your active devices) and app Ajustes → Notificações → "Enviar notificação de teste" (confirmation in 10 s). Title "[Teste] …", tap opens your latest conversation, no history row. ~15 s later Aparelhos → Atividade shows "entregue à Apple/Google" or the error code (`InvalidCredentials` = APNs/FCM key problem). Ajustes → Versão shows `OTA: <update id>` or `OTA: binário`. |
| TER-919 | #315 | B-07: one push and one history row per question; countdown, suggestion, "Cancelar", "Responder sozinho" off and a failed send no longer push again. |
| TER-920 | #313 | X-02: no push and no history row while the deletion is pending; X-03 unchanged. |
| TER-921 | #316 | R-08: coming back to the app after turning notifications on in the system settings registers the token at once (any screen). |
| TER-923 | #336, #339 | B-01: the icon shows the unread count. B-05/B-06: answering or ending a card anywhere marks its row read and sends a silent badge update; opening the app removes the handled push from the notification center. Grouping by conversation is not available in Expo Push. |
| TER-924 | #322 | §4: Expo receipts are read ~15 min after each push; `DeviceNotRegistered` clears the token, every error is logged with its code and shows in Aparelhos as "Notificação não entregue". |
| TER-925 | #330, #335 | New, opt-in: Ajustes → Notificações → "Avisar quando uma aba terminar" (per account, off by default). A project tab that was working and ends its turn (`waiting_input` or `finished`) or its agent (`idle`) pushes "{projeto}: aba terminou", unless a question card is open on it; at most once per tab every 5 min; not while the app is open in a chat. The tap opens the tab's session screen. P-06b becomes a push when the switch is on. |

New cases for the next run:

| Id | Steps | Expected |
|---|---|---|
| T-01 | Web Aparelhos → test push "Pergunta de aba" in 10 s, close the app. | Push "[Teste] … precisa de você"; tap opens the latest chat; Atividade shows "entregue à Apple/Google" within ~20 s. |
| T-02 | App Ajustes → "Enviar notificação de teste", close the app. | Push in 10 s; nothing new in Notificações. |
| F-01 | Turn on "Avisar quando uma aba terminar"; in a Claude tab, ask for a short task; close the app. | One push "{projeto}: aba terminou" when it ends; tap → PIN if locked → the tab's session screen. |
| F-02 | Same as F-01 with the switch off. | No push. |
| F-03 | A tab that ends with an AskUserQuestion. | Only "precisa de você" (P-03), not "aba terminou". |

## 1. How it works today (code map)

### 1.1 Token registration

| Step | Where | What happens |
|---|---|---|
| Permission | `apps/mobile/src/features/permissions` | No OS prompt at session start. The primer sheet ("Receba avisos das suas conversas") opens after the **first message the server accepts** in any chat, or when the Notificações tab opens while the status is `undetermined`. At most twice ("Agora não" counts). Ajustes → Notificações has "Ativar notificações" (undetermined) or "Abrir Ajustes do sistema" (denied). |
| Token | `apps/mobile/src/services/push.ts` `expoPushToken()` | Returns `null` on a simulator, when the permission is not `granted`, or without `extra.eas.projectId`. Creates the Android channel `default` ("Notificações", importance HIGH) first. |
| Upload | `createSessionStore.ts` `registerPush` | `PUT /api/m/v1/push-token` at **every session start** (activation after "Criar PIN", every unlock) and on `pushGranted` (only emitted when the primer or Ajustes gets a grant). Fire and forget. |
| Server | `apps/server/src/routes/m-devices.ts` `mobilePushTokenRoutes` | zod: `ExponentPushToken[…]`. A token held by another device row is taken from it first. Stores `devices.push_token` and records the device event `push_token_set`, shown in Aparelhos as "Notificações ativadas neste aparelho". |
| Cleanup | `apps/server/src/mobile/push.ts` `deliver` | Only an Expo **ticket** error `DeviceNotRegistered` clears the token. Expo **receipts** are never read (TER-924). A revoked device keeps its token but is filtered out (`status: 'active'`). |

Not covered: no listener for a token change, and re-enabling the permission in the system settings
does not upload the token until the next unlock (TER-921).

### 1.2 Events that send a push

`MobilePushService` (`apps/server/src/mobile/push.ts`) subscribes to `chatBus`, plus one direct call
from enrolment. Every push first writes a `user_notifications` row (the Notificações history), even
when nothing is sent. Text comes from `apps/server/src/mobile/push-text.ts` and never carries a
command, an argument, an action summary or a reply.

| # | Trigger | Title / body (pt-BR) | `data` | Who receives it |
|---|---|---|---|---|
| E1 | Concierge confirmation card (`confirmation`) | "{projeto} precisa de você" / "O chat do projeto {projeto} pediu confirmação para agir na aba {aba} ({máquina})." Account-wide chat: "O chat geral…". No tab: "…pediu sua confirmação." No project: title "termhub precisa de você". | `kind: confirmation`, `conversation_id`, `project_id`, `action_id`, `notification_id` | Active devices with a token **and no live socket** |
| E2 | Tab permission prompt (`tab_question`, kind `permission`) | "{projeto} precisa de você" / "A aba {aba} pede permissão para continuar." | `kind: tab_question`, `conversation_id`, `project_id`, `tab_question_id`, `notification_id` | Same as E1. History row kind is `confirmation`. |
| E3 | Tab multiple-choice question (`tab_question`, kind `choice`) | "{projeto} precisa de você" / "A aba {aba} fez uma pergunta." | as E2 | Same as E1 |
| E4 | Concierge run finished OK (`run_finished`, `ok`) | "Resposta pronta em {projeto}" / "O chat do projeto {projeto} terminou de responder." | `kind: reply`, `conversation_id`, `project_id`, `notification_id`; `collapseId: reply:<conversation>` | Same as E1, at most **one per conversation per minute** (the history row is still written) |
| E5 | New device asks to join the account | "Novo aparelho pede acesso" / "{modelo} ({cidade}) pediu acesso à sua conta. Confira o código e aprove ou recuse na web." | `kind: device_request`, `notification_id` | **Every** active device with a token, live socket or not |

Never pushed:

- a failed run (`run_finished` with `ok: false`);
- a tab question or confirmation brought back to the end of the chat (`resurfaced`, TER-477), or a
  confirmation re-published only to name its subagent (`origin_update`);
- an answered or closed question;
- a suggestion card (Claude `Stop` with a suggestion, Codex reply card, **agent exited**). So "aba que
  terminou" has no push today (TER-925);
- a tab waiting on its own background work (`waiting_background`, TER-644): it never opens a question;
- E2/E3 when the project has no project chat of its owner (`findLatestActiveForProject`): no card, no
  push.

"Live socket" means any open `/ws/m/chat` or `/ws/m/tab` socket of that device (`MobileSocketRegistry`,
in memory on the active color). The app does not close its sockets when it goes to the background.
The server drops a dead one only after a missed ping (every 30 s), so for up to ~60 s on iOS (longer
on Android, if JS keeps answering pings) a backgrounded phone counts as "open" and gets no push
(TER-922).

Known duplicate: a `tab_question` event is re-published when the card changes while still open
(concierge auto-answer countdown, concierge suggestion, "Cancelar", "Responder sozinho" turned off,
lost sender recovery). The push service does not tell these apart from a new question, so each one
sends another push and writes another history row (TER-919).

### 1.3 Deep link on tap

`apps/mobile/app/_layout.tsx`, `Notifications.useLastNotificationResponse()`:

- only the default action (a tap on the notification) is handled;
- `data.conversation_id` → `/chat/<id>`, immediately when unlocked, or stored as the pending route and
  opened after the PIN (a cold start is always locked);
- `data.notification_id` → that history row is marked read once unlocked (`markPushRead`);
- E5 (`device_request`) has no conversation: the app just opens;
- no case opens a tab screen or scrolls to a specific card (TER-925).

### 1.4 Badge, grouping and deduplication

- **Icon badge: none.** The server sends no `badge` and the foreground handler sets
  `shouldSetBadge: false`. The only count is the in-app badge on the Notificações tab (`unread` from the
  history) (TER-923).
- **Grouping:** only E4 has a `collapseId`. E1–E3 are one notification each, never grouped by project
  or conversation.
- **Clearing:** nothing removes a delivered notification from the notification center when the row is
  read, the card is answered (also on the web) or the chat is opened (TER-923).
- **Issue #208** is about the web's sidebar dot: a seen wait that lights again. Its push-side
  counterparts are the TER-919 duplicate above and the notification that stays in the center after
  being handled.
- **Foreground:** a push that arrives while the app is open is shown as a banner with sound (the server
  already skipped phones with a live socket).

### 1.5 Account deletion (TER-720)

Requesting deletion ends the web sessions and blocks the mobile API (`ACCOUNT_PENDING_DELETION`,
except `POST /devices/self/revoke`) and new mobile sockets. Devices stay `active` with their token, and
the push service does not check the pending deletion. Machine hooks still open tab questions, and a
device request for the address is still "real". So a phone of an account being deleted can still get
E2, E3, E4 (a run in flight) and E5 (TER-920).

## 2. Prerequisites

1. **Credentials on the Expo project** (`engenharia-inversa`, project `0614ffa1-…`): an APNs key for
   `dev.termhub.app` and an FCM V1 service account key of Firebase `apptermhub`. Check with the robot
   token (CLAUDE.md, "Mobile (EAS)"):
   `EXPO_TOKEN="$(security find-generic-password -s expo-token-pedrogoiania -w)" eas credentials`.
   Without the APNs key, iOS registers a token and never receives anything.
2. **Builds:** iOS TestFlight build of `expo.version` 0.6.0 (Ajustes shows version and build), with the
   latest OTA of the `production` channel. Android: a build installed from the Play internal track or an
   APK of the same version, if one exists. If not, run the iOS column and leave Android as "no build".
   The app does not show the OTA update id yet (TER-913). Note the OTA from the xprem MCP
   (`get_updates`) at test time.
3. **A test project** with a machine online, a project chat opened by you on the web (E2/E3 need it),
   and a Claude Code tab in normal permission mode (not auto-accept).
4. **A second way to request a device** for E5: another phone, a simulator with the app, or
   `npm run mobile-client -w @termhub/server -- --email <your e-mail> --server https://termhub.dev`
   on the Mac (the mobile API is served on `termhub.dev`, outside Cloudflare Access).
5. **Server logs** (optional): on jarvis, `docker logs termhub-app-<active color> 2>&1 | grep -i 'mobile push'`.
   Failures log ids and codes only.

### App states used below

| State | How to get there |
|---|---|
| **Fechado** | Swipe the app away in the app switcher. Wait 10 s. |
| **Segundo plano** | Home button or swipe to Home with the app unlocked. Wait **2 min** before firing the event, unless the case says otherwise (see TER-922). |
| **Aberto (chat)** | App in the foreground on any chat screen (the chat socket is live). |
| **Aberto (sem socket)** | Cold start, unlock, stay on Home without opening any chat. |

## 3. Cases

Record each case with ✅ / ❌ / n.a. per platform in the checklist (§5). "Push" means banner + sound +
entry in the notification center.

### 3.1 Registration and permission

| Id | Steps | Expected |
|---|---|---|
| R-01 | Fresh install, enrol, "Criar PIN". | No OS notification prompt. Aparelhos (web) shows no "Notificações ativadas neste aparelho" for this device yet. |
| R-02 | Send a first message in any chat. | The primer opens: "Receba avisos das suas conversas", "Ativar notificações" / "Agora não". "Ativar notificações" → OS prompt. Allow → Aparelhos shows "Notificações ativadas neste aparelho" within seconds. Android 13+: the OS prompt appears. Channel "Notificações" exists in the app's system settings. |
| R-03 | Close the app, open it, unlock. | A new "Notificações ativadas neste aparelho" event (one per session start). |
| R-04 | Publish or wait for an OTA, let the app reload, unlock. | Same as R-03, and E1 still arrives afterwards. |
| R-05 | Uninstall, reinstall, enrol again (old device not revoked). | The new device row gets the token. If Expo hands out the same token, the old row loses it. E1 arrives once, not twice. Revoke the old device in Aparelhos afterwards. |
| R-06 | Second install: "Agora não" in the primer, send another message after relaunch, "Agora não" again, then open Notificações. | Primer shows at most twice in total. Never again after that. Ajustes → Notificações: "Ainda não ativadas." with "Ativar notificações". |
| R-07 | From R-06, Ajustes → "Ativar notificações" → deny in the OS prompt. | Ajustes: "Desativadas. Para receber avisos, ative nos Ajustes do sistema." with "Abrir Ajustes do sistema", which opens the app's system settings. No push arrives for E1. |
| R-08 | From R-07, enable notifications in the system settings, return to the app **within 5 min**, then fire E1 with the app closed. | Ajustes shows "Ativadas neste aparelho." and E1 arrives. **Expected to fail today:** no token upload until the next unlock (TER-921). Repeat after a cold start + unlock: then it arrives. |
| R-09 | Disable notifications in the system settings, fire E1 with the app closed. | Nothing shown. The history row exists in Notificações. |
| R-10 | iOS simulator / Android emulator without Play services. | No token, no event in Aparelhos, no error on screen. |

### 3.2 Delivery matrix (event × app state)

Fire each event, then check the phone. Expected, per state:

- **Fechado** and **Segundo plano**: push with the exact title/body of §1.2. The project, tab and
  machine names are right. No command or text from the chat appears.
- **Aberto (chat)**: **no push** for E1–E4 (live socket). The card appears in the chat, and the
  Notificações tab badge goes up. E5 still shows a banner.
- **Aberto (sem socket)**: banner with sound, in the foreground.

| Id | Event and how to fire it | Fechado | Segundo plano | Aberto (chat) | Aberto (sem socket) |
|---|---|---|---|---|---|
| P-01 | **E1** On the web, in the test project chat, ask the concierge for a gated action (e.g. "rode `ls` na aba X"). | push | push | no push, card in chat | banner |
| P-02 | **E2** In the Claude tab: "crie o arquivo /tmp/th-push-test.txt" (a permission prompt). | push | push | no push, card in chat | banner |
| P-03 | **E3** In the Claude tab: "me pergunte com AskUserQuestion qual cor eu prefiro". | push | push | no push, card in chat | banner |
| P-04 | **E4** On the web, send a message in the test project chat and wait for the answer. | push "Resposta pronta…" | push | no push | banner |
| P-05 | **E5** Request a device for your e-mail (prerequisite 4). | push "Novo aparelho pede acesso" | push | **banner** (sent to every device) | banner |
| P-06 | **No push expected.** (a) Claude tab: ask it to run `sleep 300` in the background and end the turn → the tab shows "aguardando segundo plano" (TER-644). (b) `/exit` in a Claude tab (agent exited → suggestion card). (c) A concierge run that fails. | nothing | nothing | nothing | nothing |

Timing sub-cases for **Segundo plano** (TER-922), on P-01 and P-02. Fire the event **10 s**, **2 min**
and **6 min** after leaving the app. Expected: push every time. Likely today: no push at 10 s on iOS
(socket still counted live for up to ~60 s). On Android, possibly none even at 2 min. At 6 min the app
is also locked: the tap goes through the PIN.

### 3.3 Deep link on tap

| Id | Steps | Expected |
|---|---|---|
| D-01 | Tap the P-01 push with the app **Fechado**. | Cold start → PIN (or Face ID) → the project chat, with the confirmation card visible. In Notificações, that row is read. |
| D-02 | Tap the P-02/P-03 push with the app in **Segundo plano** < 5 min (unlocked). | Opens the project chat at once (no PIN), card visible. Row read. |
| D-03 | Same as D-02 after > 5 min in the background. | PIN first, then the chat. |
| D-04 | Tap the P-04 push. | Opens the chat that answered. |
| D-05 | Tap the P-05 push. | Opens the app on its current screen. No navigation. Approving happens on the web. |
| D-06 | Account-wide chat: fire E1 from the general chat (no project). | Title "termhub precisa de você", body "O chat geral pediu…". The tap opens the general chat. |
| D-07 | Swipe a push away without tapping, then open Notificações. | The row is still unread. |

Today the tap never opens the tab screen and never scrolls to the card. Record what you would have
wanted for TER-925.

### 3.4 Badge, grouping and deduplication (#208)

| Id | Steps | Expected today |
|---|---|---|
| B-01 | Leave 3 unanswered E1/E2 pushes, app closed. Look at the icon. | **No number on the icon** (TER-923). Notificações tab badge = 3 after opening. |
| B-02 | Two E4 for the same chat within one minute, app closed. | One push only (rate limit + collapse). Two rows in Notificações. |
| B-03 | E4 in two different project chats within one minute. | Two pushes. |
| B-04 | In the termhub chat, ask the concierge to bring the pending cards back ("manda aqui pra eu aprovar", tool `recap_pending_cards`) while an E1/E2 is pending. | No new push (`resurfaced`). |
| B-05 | Answer an E2 on the **web** while its push sits in the notification center. | The push stays in the center (TER-923). Tapping it opens the chat with the card already answered. |
| B-06 | Open a pushed question's chat directly (not through the push), answer it, check the center. | The push stays (TER-923). |
| B-07 | **Duplicate (TER-919).** With "Responder sozinho" on, open an E3 the concierge can answer from memory (a question you answered before). The concierge schedules a 60 s countdown. App closed. Variant: with the app open, tap "Cancelar" on the countdown, then close the app. Variant: turn "Responder sozinho" off while a countdown runs. | Expected (spec): one push per question. **Likely today:** a second "precisa de você" for the same question at each card change, and a second unread row. |
| B-08 | Let an E2 sit for 10+ minutes unanswered, app closed. | No reminder push for the same request. |

### 3.5 Account deletion (TER-720) and revocation

Use a **second test account** with its own phone enrolment, not your main account: requesting
deletion ends every web session of the account.

| Id | Steps | Expected |
|---|---|---|
| X-01 | Test account: request deletion (app → Ajustes → "Excluir minha conta", or the web). | The app shows the blocking screen. |
| X-02 | From X-01, fire E2/E3 from a tab of the test account's machine, and E5 for its e-mail. | **Expected: no push.** Likely today: both arrive (TER-920). |
| X-03 | Cancel the deletion (web login). Fire E1. | Push arrives again (tokens were kept). |
| X-04 | "Sair e remover este aparelho" on the blocking screen, or revoke in Aparelhos. Fire E1/E5. | No push to that phone. |

## 4. What the logs and the web show

- Aparelhos (web) → the device's event list: "Notificações ativadas neste aparelho" per token upload.
- Notificações (app): one row per notification, including the ones not pushed.
- Server: `mobile push failed` / `mobile push send failed` (warn, ids only). Without TER-924, a
  credential problem on the Expo side does **not** show up here: the send succeeds and nothing
  arrives. Use the Expo push tool (expo.dev → Tools → Push notifications) with a token from a test
  device to tell "server did not send" from "APNs/FCM did not deliver".

## 5. Checklist (fill in)

Platform / build: iOS ____ (version, build, OTA id) · Android ____ (version, versionCode, OTA id)

| Case | iOS | Android | Notes |
|---|---|---|---|
| R-01 … R-10 | | | |
| P-01 Fechado / 2º plano / Aberto chat / Aberto sem socket | | | |
| P-02 (… same four, plus 10 s / 2 min / 6 min) | | | |
| P-03 | | | |
| P-04 | | | |
| P-05 | | | |
| P-06 a / b / c | | | |
| D-01 … D-07 | | | |
| B-01 … B-08 | | | |
| X-01 … X-04 | | | |

A failure that has no card yet becomes a bug card on the board, linked to TER-901.

## 6. Cards from this reading

| Card | Kind | Cases |
|---|---|---|
| TER-913 | Test push for one's own device (endpoint + buttons) | all, for future runs |
| TER-919 | Bug: same tab question pushed again when its card changes | B-07 |
| TER-920 | Bug: account pending deletion still gets pushes | X-02 |
| TER-921 | Bug: re-enabling notifications in system settings does not upload the token | R-08 |
| TER-922 | Bug (to confirm): backgrounded app with a live socket gets no push | P-01/P-02 timing |
| TER-923 | Gap: icon badge, clearing handled notifications, grouping | B-01, B-05, B-06 |
| TER-924 | Gap: Expo receipts never read (dead tokens, credential errors) | §4 |
| TER-925 | Product decision: push for a finished tab, tap that opens the tab/card | P-06b, §3.3 |

## 7. Impact on other users

None. This is a test plan and a set of cards. No behavior changes. (The fixes it led to carry their own impact sections in their PRs; see §0.)
