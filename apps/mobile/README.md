# @termhub/mobile

The termhub chat as a native app (iOS and Android), built with Expo and `expo-router`, against the real server (`/api/m/v1`, see "Against the real server" below) or an in-memory mock of it (see "Mock mode"). Design: `docs/superpowers/specs/2026-09-24-mobile-chat-app-design.md` (the *product* spec — §11 is the app, §9 push and notifications) and `docs/superpowers/specs/2026-09-24-mobile-app-mock-design.md` (the *app* architecture this workspace implements — the folder layout, the mock and everything below is delivered against it). The server side (`/api/m/v1`, `/ws/m/chat`, device enrolment, push) is delivered separately, by `docs/superpowers/plans/2026-09-24-mobile-chat-server.md`.

## Architecture

MVVM by feature, `src/features/<feature>/{model,viewmodel,view}`: views never call the API directly, and viewmodels never import React Native or `expo-router` (the `logic` jest project enforces the second rule — it throws if either is imported).

```
app/                             expo-router routes — thin, each file renders one feature view
  index.tsx                      Início — "Continuar com e-mail"
  enrol/waiting.tsx               Aguardando aprovação (verification code, simulated approval in mock mode)
  enrol/create-pin.tsx            Criar PIN
  unlock.tsx                      Desbloquear (PIN / biometrics)
  (tabs)/_layout.tsx              the tab bar, Home first; Notificações carries the unread badge
  (tabs)/index.tsx                Home — the projects pinned in Favoritos (where the app opens)
  (tabs)/chats.tsx                Chats — every project, each with its pin
  (tabs)/notifications.tsx        Notificações
  (tabs)/settings.tsx             Ajustes
  chat/[id].tsx                   a conversation (deep link target: termhub://chat/<conversation_id>)

src/features/
  session/    enrolment, PIN and activation, unlock, silent renewal, relock, biometrics, leaving/revocation
  chat/       projects, a conversation, live events, decisions, the account-wide chat's host picker
  home/       Home: the pinned projects (Favoritos, the web sidebar's group), in their order
  notifications/  the account's notification history and unread count (a live `confirmation` also
                   taps into the chat store's socket — see `viewmodel/createNotificationsStore.ts`)
  settings/   this device (`GET devices/self`), the key diagnostic, and Ajustes' remaining sections
              (biometrics, the chat host and the theme each already live in their own store above)
  theme/      the light/dark/system preference
  shared/     signals (e.g. `sessionEnded`, which every persisted store resets on), relative-time

src/services/
  api/        MobileApi = HttpMobileApi over a Transport (FetchTransport for `http`, MockTransport
              for `mock`); api/contract/ re-exports `@termhub/mobile-api` (the zod contract the
              server validates against) plus the app's own `local.ts` schemas;
              api/mock/ is the whole in-memory server (router, state, fixtures, DPoP verification)
  key/        the DeviceKey port — SoftwareDeviceKey (P-256, @noble/curves, SecureStore-backed;
              backs the device key in mock mode and every Jest run) and HardwareDeviceKey
              (@pagopa/io-react-native-crypto, Secure Enclave / Keystore; backs the device key in
              http mode, and the key diagnostic in every mode outside Jest)
  vault.ts    the SecureStore wrapper for the app's few secrets (a closed set of `VaultKey`s)
  storage.ts  the MMKV instance and the zustand StateStorage every persisted store uses
  push.ts     expo-notifications: the phone's Expo push token, the foreground handler, a push's chat

src/ui/       Screen, Text, Button, Field, PinInput, Sheet, Card, Banner… (NativeWind v4)
src/theme/tokens.ts  the termhub palette (CSS variables), both colour schemes
src/i18n/     i18next setup, the language choice, date/number helpers (see "Languages")
src/locales/  the English catalogs (and pt-BR plural forms), one JSON file per area
test/         jest setup, fakes for MMKV/SecureStore/expo-device/expo-local-authentication/expo-notifications/the
              hardware key module, and shared test helpers (`test/helpers/enrolled-session.ts`,
              `test/helpers/ui-stores.ts`)
```

### Mock mode

`EXPO_PUBLIC_API_MODE=mock` (the fallback when the variable is unset) makes `src/services/api/index.ts` build the app's one `MobileApi` over `MockTransport` instead of `FetchTransport`: an in-memory implementation of the exact same contract (`src/services/api/contract/`), answering the same URLs with the same status codes, bodies and socket frames a real server would. Nothing else in the app knows the difference — the same `HttpMobileApi` client builds DPoP proofs, retries once on a renewed token and so on, whether the transport underneath is real or not. This is how the app runs on the simulator, on a phone with no server, and in every Jest test.

Two things exist only under `mock`: the *Aguardando aprovação* screen's "Simular aprovação na web" / "Simular recusa" buttons (`mockControls`, `null` in `http` mode — nothing approves a request by itself otherwise), and the fake `ExponentPushToken[mock-…]` registered after each unlock. The "Diagnóstico da chave" row in Ajustes (`src/features/settings/model/key-diagnostic.ts`) is *not* mode-dependent: on any build it always runs on `HardwareDeviceKey`, under its own tag `dev.termhub.diagnostic` (never the enrolled device key), so it exercises the Secure Enclave / Keystore even in mock mode, with no server; only Jest swaps in `SoftwareDeviceKey` (vault key `key.diagnostic`).

### How the flow works

Enrolment (P§4): `requestDevice(email)` generates the device key, shows the verification code and polls until approved (or, in mock mode, the person taps "Simular aprovação"). Approval moves the session to `pin_setup`; `createPin` activates the device, wraps the server's `pin_secret` with a PIN-derived key (scrypt) in SecureStore, and the app is `unlocked`. From there: `locked` after 5 minutes in the background or a cold start (`unlock(pin)` never compares the PIN locally — every guess costs a server call, P§5.4); a wrong PIN three times locks the device for a while; biometrics is a SecureStore item guarded by `requireAuthentication`, a shortcut to the same unwrap. The chat store owns the app's one `/ws/m/chat` socket, opened by the first conversation `open()`; messages only ever land in state through socket events, never by appending locally on send. A `confirmation` event both updates the open conversation's action list and — through `subscribeEvents` — prepends a placeholder row into `useNotificationsStore` before the server's own notification row is fetched. "Sair e remover este aparelho" revokes the device and wipes every vault item and persisted store (`sessionEnded`).

### Env vars

See `.env.example`. `EXPO_PUBLIC_API_MODE` (`mock` | `http`; the code falls back to `mock` when it is unset, `.env.example` sets `http`) and `EXPO_PUBLIC_TERMHUB_URL` (the server `http` mode talks to, and the host Ajustes shows as "Servidor", e.g. from `expo start`). `scripts/ios-release.sh` exports both for a release build: `http` and `https://termhub.dev` — there is no server picker in the app, spec §11.1. Set `EXPO_PUBLIC_API_MODE=mock` in `.env` to run with no server at all.

### Against the real server

`HttpMobileApi` over `FetchTransport` talks to `/api/m/v1` and `/ws/m/chat` on `EXPO_PUBLIC_TERMHUB_URL`; the contract comes from the `@termhub/mobile-api` workspace package, the same one the server validates with. The flow:

1. Início: enter the e-mail of a termhub account and note the verification code.
2. On the web, as that account's owner, approve the request in Configurações → Aparelhos; the code shown there must match the phone's.
3. Criar PIN on the phone; the app unlocks into the tabs.
4. Chat as usual; actions the chat proposes are approved with the PIN.

The server refuses an app whose `X-Termhub-App` version is below `MOBILE_MIN_APP_VERSION` (when set) with `426 APP_TOO_OLD`. A socket upgrade with an expired token is refused with HTTP 401 before it opens; the client renews its token before the next attempt.

## Running

Jarvis has no Node: run everything through Docker as CLAUDE.md shows, or on a Mac with Node 22.

```bash
npm run typecheck -w @termhub/mobile
npm test -w @termhub/mobile
```

The app needs a **development build** (native modules; Expo Go cannot load it). On a Mac with Xcode:

```bash
cd apps/mobile
npm run ios                       # expo run:ios — prebuild, build and install on a simulator or a plugged-in phone
npm start                         # Metro; the development build connects to it
```

Copy `.env.example` to `.env` for `expo start`: it points the app at `https://termhub.dev` in `http` mode; with no `.env` at all the app runs in mock mode, with no server needed. Release builds bake `http` mode and `https://termhub.dev` in through `scripts/ios-release.sh`.

## Releasing to TestFlight (iOS)

Builds are made locally on a Mac, without EAS: iOS goes to TestFlight, Android to Firebase App Distribution (next section). `ios/` and `android/` are generated each time and never committed.

Prerequisites on the Mac: Xcode, CocoaPods, Node 22, and an Apple ID of team **8020 DIGITAL LTDA (`S873WHF2TZ`)** signed in to Xcode → Settings → Accounts with a role that may use cloud-managed distribution certificates (Admin or Account Holder). The distribution certificate is cloud-managed, so its private key is not in the keychain: Xcode signs the export through Apple, and `-allowProvisioningUpdates` creates or refreshes the App Store provisioning profile for `dev.termhub.app`.

1. From an up-to-date `main`: `npm ci`, then `npm run build:contract -w @termhub/mobile`, `npm run typecheck -w @termhub/mobile` and `npm test -w @termhub/mobile`. If the typecheck rejects a route that exists under `app/` (e.g. `"/chat-grants"`), `apps/mobile/.expo/types/router.d.ts` is a stale generated file from an older checkout: delete it and run the typecheck again.
2. Bump `expo.version` (the marketing version, e.g. `0.2.0`) and/or `expo.ios.buildNumber` in `app.json`. App Store Connect refuses a build number it has already seen for that version; the build number is the build's local date and time as a plain integer (`YYYYMMDDHHMM`, e.g. `202609261624`), so it only grows. It must stay a plain integer: the app sends it in `X-Termhub-App` (`ios/0.2.0+202609261624`) and the server rejects anything else.
3. `npm run release:ios -w @termhub/mobile` — `expo prebuild --platform ios --clean`, `xcodebuild archive`, then `xcodebuild -exportArchive` into `apps/mobile/build/export/termhub.ipa`. Check the permission strings (camera, photo library, microphone, Face ID) in `apps/mobile/build/termhub.xcarchive/Products/Applications/termhub.app/Info.plist`.
4. `npm run release:ios -w @termhub/mobile -- --upload` repeats the build and exports with `destination = upload`, which sends it to App Store Connect under the same Apple ID.
   To sign and upload with an App Store Connect API key instead of the Xcode account (so the release does not depend on an Apple ID staying signed in to Xcode), set `ASC_KEY_ID` and `ASC_ISSUER_ID`, and `ASC_KEY_PATH` when the `.p8` is not at `~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8`. The key needs access to team `S873WHF2TZ` (App Manager or Admin). Without these variables the script uses the Xcode account, as before.
5. In App Store Connect → TestFlight, wait for the build to finish processing, answer the export compliance question if asked (`ITSAppUsesNonExemptEncryption` is `false`, so it normally is not), fill in "What to Test" and add it to the testers' group.

Push needs the APNs key registered with Expo (see "Push notifications" below); without it, iOS phones register a token but never receive a push.

## Releasing to Firebase App Distribution (Android)

Android builds are made on the same Mac and handed to testers through Firebase App Distribution (project `apptermhub`, group `termhub-testers`); nothing goes to Google Play yet.

Prerequisites: the Android SDK (`ANDROID_HOME`), JDK 17, Node 22, and a Google account with access to the Firebase project signed in to the Firebase CLI (`npx firebase-tools login`, once).

1. The same checks as for iOS (step 1 above), from the same commit: one version is one commit, on both platforms.
2. Bump `expo.android.versionCode` in `app.json`, together with `expo.version`. It is a plain counter (`2`, `3`, …), not the iOS date: Android refuses a version code above 2100000000, and a phone only takes an update whose code is not below the installed one. The app sends it in `X-Termhub-App` (`android/0.3.1+2`).
3. `npm run release:android -w @termhub/mobile` — `expo prebuild --platform android --clean`, then `gradlew assembleRelease` into `apps/mobile/build/android/termhub.apk`.
4. `npm run release:android -w @termhub/mobile -- --upload "what changed"` repeats the build and sends it to the `termhub-testers` group with those release notes (pt-BR: testers read them).

The APK is signed with the keystore Expo's template generates into `android/app/debug.keystore`, the same file on every prebuild, so a tester's phone takes each build as an update of the last one. That is enough for App Distribution, not for Google Play: a Play release needs an upload key of its own, kept out of the repository.

## OTA updates

JS-only changes reach installed builds over the air, through the self-hosted [xprem](https://github.com/mercuretechnologies/xprem) server at `https://ota.engenhariainversa.com.br` (dashboard at `/dashboard`), with `expo-updates` in the app and the `eoas` CLI to publish. `app.config.js` adds the `updates` config on top of `app.json`.

**One line of updates per app version.** `runtimeVersion` uses the `appVersion` policy, so the runtime version is `expo.version`: a 0.3.2 binary asks only for `0.3.2` updates and never gets a bundle published from 0.3.3 code. Every build points at the `production` channel, which maps to the `production` branch; the branch holds one line per runtime version (`get_runtime_versions` in the xprem MCP, or Branches in the dashboard).

- **JS-only change** for the version testers already have: publish, and the next cold start downloads it in the background; it runs from the launch after that.
- **Native change** (a new native module, a config plugin, an `app.json` field that prebuild reads, an Expo SDK bump): bump `expo.version` and ship a new binary (TestFlight / App Distribution). Its updates then go out under the new version, and older binaries keep their own line.
- **Older builds that take the same JS.** When a bump only changed native metadata (a privacy manifest, a permission string) and no native module, list the previous versions in `ota-runtimes.js`: every publish then also goes out under their runtime, so a phone still on the older build keeps getting updates. The list is pinned to the `expo.version` it was checked against (`for`) and stops applying when the version moves, until someone checks the new native diff. Without it, a phone on the older build silently stays on that line's last update.

**Publishing is automated.** The "Publish mobile OTA" workflow (`.github/workflows/publish-mobile-ota.yml`, on the jarvis runner) publishes on every push to `main` that touches `apps/mobile/**` or `packages/mobile-api/**`. It skips a push that changes `app.json`, `app.config.js` or this `package.json` without bumping `expo.version` (the run summary says so): for a JS-only change it was too cautious about, run it by hand with `gh workflow run "Publish mobile OTA" --ref main -f message="what changed"`.

By hand, from a clean working tree on the Mac (eoas refuses a dirty one, so an update always matches a commit):

```bash
npm run release:ota -w @termhub/mobile                                  # message: last commit subject
npm run release:ota -w @termhub/mobile -- -m "what changed"
npm run release:ota -w @termhub/mobile -- --rollout-percentage 20
```

The token is a publishing API key of the termhub app on xprem: `EOO_TOKEN` when set, otherwise the macOS Keychain item `xprem-token-termhub`; CI uses the `XPREM_TOKEN` repository secret. Keys are listed, created and revoked with the xprem MCP (`get_api_keys`, `create_api_key`, `revoke_api_key`) or in the dashboard.

The script bakes in the same `EXPO_PUBLIC_*` values as the store builds and runs `eoas publish --branch production --platform all`. A rollout is then widened, ended or reverted in the dashboard; a bad update is reverted by republishing an earlier one or with a rollback to the embedded bundle (dashboard, or `republish_update` / `rollback_branch` in the MCP).

Ajustes → Versão shows the binary (`0.5.0 (build)`) and the running bundle: `OTA: binário`, or the update's full id and publish time, to match against the server (`get_updates` in the xprem MCP).

Manifests are code-signed: the server holds the app's private key, and `certs/certificate.pem` (public, committed) goes into every build. `expo start` cannot sign development manifests without the private key, so `npm start`, `npm run ios` and `npm run android` set `DISABLE_CODE_SIGNING=1`; the release scripts leave it unset. A development build loads its JS from Metro, not from the OTA server.

## Sessões (a terminal tab as a conversation)

The Chats tab has two segments: "Conversas" (the concierge chat) and "Sessões". Sessões lists the terminal tabs of your projects and opens one that runs Claude Code as a conversation, with no concierge in between (spec `docs/superpowers/specs/2026-10-01-tab-chat-design.md`).

- **What it reads.** The session's own Claude Code transcript, read on the machine by the agent (`transcript.read`, agent **0.15.0** or newer) and turned into items by the server (`apps/server/src/tab-chat/`). Tabs on an older agent show "Atualize o agente desta máquina"; only agent machines and Claude Code tabs open. The tab's state comes from the hooks, as everywhere else.
- **Nothing is stored.** The server relays the transcript while a phone has the screen open (`GET /api/m/v1/tabs/:id/chat` for a page, `/ws/m/tabs/:id` for live items) and keeps nothing; the app keeps the items in memory only. Neither side logs content.
- **Writing.** A message is typed into the tab as in the web terminal (no confirmation card). While the tab waits on a permission, sending answers "Responda a pergunta acima antes de enviar uma mensagem": the question card sits at the end of the conversation. While Claude works, the send button interrupts (Escape); a long press still sends. The menu holds `/clear`, `/compact`, "Alternar modo" (Shift+Tab, the mode is read back from the footer) and "Ver tela" (the raw pane). An attachment is saved on the tab's machine and its path goes into the message.
- **Permissions.** Reading needs `terminals:read`; writing and "Nova sessão" need `terminals:write`.

## File preview (TER-941)

A `.md`/`.markdown` path in an answer (the concierge chat, and Sessões) is a link: tapping it pushes
`/file-preview` (`features/file-preview`), which reads the file on its machine through
`GET /api/m/v1/file-preview` — the chat's project, or the session's tab. The agent decides what can be
read (spec `docs/superpowers/specs/2026-10-04-file-preview-design.md`); the screen says why when it
cannot, and "Atualize o agente" for an agent older than 0.16.0. Images show as a tappable
"imagem: …" line and are never fetched by the screen; links open another preview (relative `.md`) or
the browser (http/https only). Actions: **Compartilhar** (the share sheet also copies and saves),
**Abrir no GitHub**, **Mandar para o chat** (an attachment chip in the project chat's composer, not
sent). In mock mode, `~/relatorio-termhub-10-dias.md`, `notas.txt`, `~/.ssh/notas.md`,
`~/grande.md` and `~/antigo/x.md` show each state.

**Arquivos** (TER-953): a project chat's host line (and its "Conta e modelo" sheet) leads to
`/file-recent` (`features/file-recent`), the project's recent Markdown files across its machines through
`GET /api/m/v1/file-recent` (spec `docs/superpowers/specs/2026-10-04-recent-md-files-design.md`): chips
per group (Specs, Planos, Lições, Jurídico, Outros) and Citados, pull-to-refresh, and a notice for each
machine left out (offline, an agent too old to list files, no termhub agent). A tap opens the preview on
the machine that listed the file; a file over the preview's limit is listed but does not open.

## Push notifications

`expo-notifications` (spec §9). The server sends through the Expo Push Service to the token the app registers with `PUT push-token`; `src/services/push.ts` reads that token:

- **Registration.** At every session start (activation or unlock, never a silent renewal), and right after the primer gets a grant, the session store asks for the phone's Expo push token and sends it, fire-and-forget. The token is read only once the permission is granted: the OS prompt comes from the notification primer (after the first message the server accepts, or on the Notificações tab) or from Ajustes, never from a session start. A simulator, a permission not granted or a build without `extra.eas.projectId` has no token, and nothing is sent. Mock mode keeps sending the fake `ExponentPushToken[mock-…]`.
- **Tokens are per EAS project.** `getExpoPushTokenAsync` needs `extra.eas.projectId` (`app.json`, project `0614ffa1-…` of the `engenharia-inversa` Expo account). If that id changes, every phone's token changes with it.
- **Taps.** `app/_layout.tsx` opens `data.conversation_id` the same way as a `termhub://chat/<id>` deep link, straight away when unlocked or after the PIN otherwise; a cold start from a tap works the same way. A `device_request` push names no conversation and just opens the app. Every push also carries `data.notification_id`, its row in the Notificações history: the tap marks that row read (`markPushRead`, once unlocked).
- **"Aba terminou" (TER-925, opt-in).** Ajustes → Notificações → "Avisar quando uma aba terminar" (per account, off by default, `GET`/`PUT push-settings`): the server pushes when a project tab that was working ends its turn or its agent, unless a question card is open on it, at most once per tab every 5 minutes. Its `data.tab_id` makes the tap open that tab's session screen (`/session/<id>`); older app versions open the project's chat instead.
- **In the foreground** a push is still shown as a banner: the server only skips phones with a live chat socket, so one that arrives while the app is open is about something the screen may not be showing.

- **Test push (TER-913).** Ajustes → Notificações → "Enviar notificação de teste" (only once notifications are granted) asks the server for a sample `confirmation` push to this phone in 10 s, time to close the app. The web's Aparelhos page does the same for any of your active phones, with a choice of kind and delay. A test push carries "[Teste]" in its title and `data.test: true`, ignores the live-socket rule, opens your latest conversation on tap and never enters the Notificações history. About 15 s after the send, the server reads Expo's receipt and records the outcome in the device's trail (Aparelhos → Atividade): "entregue à Apple/Google" or the error code (e.g. `InvalidCredentials` = the APNs/FCM key below is missing or wrong). Ajustes → Versão also shows the running bundle (`OTA: <update id>` or `OTA: binário`), for test notes.

Delivery to real phones needs credentials on the Expo project, set once with `eas credentials` (or expo.dev → the project → Credentials), logged in to `engenharia-inversa` (see the root `CLAUDE.md`, "Mobile (EAS)"): an **APNs key** for `dev.termhub.app` (iOS) and a **FCM V1 service account key** of the Firebase project `apptermhub` (Android). If the Expo account enables enhanced push security, the server's `EXPO_PUSH_ACCESS_TOKEN` must be an access token of that same account.

### Permission prompts

`src/features/permissions` (spec `docs/superpowers/specs/2026-09-30-mobile-permission-prompts-design.md`) asks for two things in context: notifications (a primer sheet, at most twice) and ad measurement (a Home card; ATT on iOS, our own yes on Android). Ad consent is denied by default in `firebase.json` and only granted by the person; it can be changed in Ajustes → Privacidade.

## Firebase

Both apps (`dev.termhub.app`) are registered in the Firebase project `apptermhub`; `google-services.json` (Android) and `GoogleService-Info.plist` (iOS) are committed next to `app.json` (they identify the app, they are not secrets). `@react-native-firebase/app` and `@react-native-firebase/analytics` are installed for Firebase App Distribution and Analytics: `src/services/analytics.ts` logs a `screen_view` per expo-router route pattern (`/chat/[id]`, never the resolved id).

On iOS, the Firebase pods are resolved through CocoaPods (`disableSPM`), which needs static frameworks: `expo-build-properties` sets `ios.useFrameworks: "static"` for every pod. AdSupport is linked (`withoutAdIdSupport: false`) so the IDFA can be read after the App Tracking Transparency prompt; the ad signals (`ad_storage`, `ad_user_data`, `ad_personalization`) are denied by default in `firebase.json` and only granted by the person (see "Permission prompts"); screen views (`analytics_storage`) are unchanged.

## Store privacy declarations

**iOS privacy manifest.** `expo.ios.privacyManifests` in `app.json` becomes `ios/termhub/PrivacyInfo.xcprivacy` at prebuild. With static frameworks Apple does not reliably read each pod's own manifest, so the app's manifest repeats every required-reason API the native code uses: the union of the `PrivacyInfo.xcprivacy` files in `node_modules` (React Native, Expo modules) and of the Firebase pods (FirebaseCore, FirebaseCoreInternal, FirebaseInstallations, GoogleUtilities; GoogleAppMeasurement ships no manifest). `src/app-config.test.ts` fails when a native package adds a reason the app does not declare; the Firebase list in that test is kept by hand and must be re-checked when the Firebase iOS SDK moves.

- `NSPrivacyTracking` is `true` (IDFA after ATT) and `NSPrivacyTrackingDomains` lists only `googleadservices.com`, the IDFA ad-conversion endpoint. `app-measurement.com` is deliberately left out: it also carries the first-party screen views, and iOS blocks a tracking domain for everyone who has not allowed ATT.
- `NSPrivacyCollectedDataTypes` follows the App Privacy draft in `docs/legal/duvidas-advogado.md` (annex B), plus "Other Diagnostic Data" (not linked, analytics) that FirebaseInstallations declares. App Store Connect → App Privacy must say the same.

**Android advertising id.** Firebase Analytics (`play-services-measurement-api`) merges `com.google.android.gms.permission.AD_ID` into the manifest, and the app does use the advertising id for ad measurement once the person agrees. `app.json` declares the permission itself so it does not depend on the merge. Play Console → App content → Advertising ID: "yes", for Analytics and Advertising or marketing.

Any change here is native: bump `expo.version` (see "OTA updates").

## Manual checklist (design spec §10)

Everything below is automated except this: run it by hand, on a development build, before trusting a change that touches enrolment, the PIN, biometrics or the key.

1. **Full flow, in mock mode** — on a development build with no server running:
   1. Início: enter an e-mail, see the verification code.
   2. Aguardando aprovação: "Simular aprovação na web".
   3. Criar PIN: set a 6-digit PIN.
   4. The app unlocks into the tabs.
   5. Send a message in a project chat and watch the answer stream in.
   6. Trigger a pending action (send a message containing "confirma") and approve it with the PIN.
   7. Lock the device with three wrong PINs in a row.
   8. Turn biometrics on, then off, in Ajustes.
   9. "Sair e remover este aparelho" in Ajustes, and confirm the app returns to Início.
2. **The key diagnostic** — `Ajustes → Diagnóstico da chave → "Testar a chave do aparelho"`, on both a real iOS device and a real Android device (P§11.1's first on-device check). It always uses `HardwareDeviceKey` (tag `dev.termhub.diagnostic`, never the enrolled key), in mock mode as well as http, so a development build with no server is enough to exercise the Secure Enclave / Keystore — only Jest runs the software key instead. Every step (`create`, `exists`, `publicJwk`, `thumbprint`, `sign+verify`, `destroy`) should say "ok".

## iPad

The build is universal (`ios.supportsTablet: true`): the iPhone stays in portrait, the iPad rotates freely and supports Split View and Slide Over (Expo writes every `UISupportedInterfaceOrientations~ipad` because full screen is not required). From 700 pt of window width Chats shows the list and the conversation side by side; other screens keep a 720 pt column. Design and manual check: `docs/superpowers/specs/2026-09-28-mobile-ipad-design.md` (§5). Enter-to-send on a hardware keyboard is not there yet (spec §2.5).

An `ios/` folder generated before this change stays iPhone-only (prebuild does not rewrite it): after pulling, re-run `npx expo prebuild --clean` before building (e.g. `npm run ios`); `npm run release:ios` already prebuilds with `--clean`, so a TestFlight build picks it up by itself.

## Languages (i18n)

The app speaks pt-BR (the source language and the fallback) and English (spec `docs/superpowers/specs/2026-10-04-i18n-english-design.md`). `src/i18n` sets up `i18next` + `react-i18next` (plain JS, so a language change ships over OTA):

- **The pt-BR text is the key.** Views call `const { t } = useTranslation()` and write `t('Salvar')`; models, viewmodels and services import `t` from `@/i18n` and call it when the text is built. English lives in `src/locales/en/<area>.json`, one file per area of the source tree, merged in `src/i18n/resources.ts`; `src/locales/pt-BR/` holds only plural forms (`t('{{count}} abas', { count })` needs `_one`/`_other` in both languages). A label kept in a table is marked with `tk('…')` and translated where it is shown.
- **Which language:** Ajustes → Idioma (Automático / Português (Brasil) / English), kept in MMKV on this device (it survives "Sair e remover este aparelho"); automatic follows the phone's language from `Intl` (no `expo-localization`, which is native): `pt*` → pt-BR, `en*` → English, anything else → pt-BR. Hermes has no `Intl.PluralRules`, so `src/i18n/plural-rules.ts` installs the CLDR rules of both languages.
- **The server answers in the same language:** every HTTP call and socket upgrade sends `Accept-Language`, so API errors arrive translated; the app never re-translates server text.
- **Dates and numbers** go through `src/i18n/format.ts` (`formatDate`, `formatTime`, …); no locale literal in `toLocale*`/`Intl`.
- **`npm run i18n:check -w @termhub/mobile`** (also a jest test) fails on a key with no English entry, placeholders that differ, an unused entry, and — in the folders listed in `GUARDED` (all of `app/` and `src/`) — JSX text, text attributes (`title`, `label`, `placeholder`, `accessibilityLabel`…) or `Alert.alert` text outside `t()`. `// i18n-ignore` skips a line.
- **Tests run in pt-BR** (`TERMHUB_TEST_LOCALE` in the jest setup), so they query the Portuguese text; a test that needs English calls `setLocale('en')` and `setLocale(null)` afterwards.
- The native permission texts in `app.json` (camera, microphone, Face ID…) stay pt-BR: translating them needs native localisation files and a new store build.

## Conventions

- Code, comments and commits in English; every string a person sees goes through `t()` with the pt-BR text as key, and its English entry is added in the same change.
- Bundle / package id `dev.termhub.app`, URL scheme `termhub`.
- Pure logic (`model/`) and viewmodels must not import React Native or `expo-router`: the `logic` jest project runs them in plain Node and fails otherwise.
- The monorepo pins a single React version (root `package.json` `overrides`); Expo SDK upgrades bump it for every workspace.
