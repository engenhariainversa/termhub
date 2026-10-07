# Mobile: contextual permission prompts (notifications and ad measurement) — design

Card: **TER-628**. Phone app only (`@termhub/mobile`). No server, web, contract or migration change. Needs a new native
build (a new native module and the AdSupport framework), so it ships in a new app version.

The decisions in §2 marked "maintainer" were taken on 2026-09-30; the others follow from the code
and carry their reason.

## 1. Problem

Read from the code at `30cdd6d0`.

- **Notifications.** The session store registers the push token at every session start
  (`createSessionStore.ts`, `startSession` → `registerPush` → `deps.pushToken()`), and
  `expoPushToken()` (`src/services/push.ts`) calls `requestPermissionsAsync()` when the permission
  is not granted. So the OS prompt shows right after "Criar PIN", with no context. iOS gives one
  prompt only: someone who refuses there can only turn notifications on in the system settings.
- **Ad measurement.** Firebase Analytics runs with `withoutAdIdSupport: true` on iOS (no AdSupport,
  no IDFA) and logs only `screen_view` with route patterns. The team is going to run install
  campaigns and measure them, which needs the advertising id (IDFA / GAID) and Google's ad consent
  signals. On iOS, reading the IDFA requires App Tracking Transparency (ATT); on Android there is no
  system prompt, but the same consent should be asked (LGPD).

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Walkthrough style | Contextual prompts, no fixed walkthrough screens. | Maintainer. |
| Why ATT | The team will measure ads (campaign conversion / install attribution). | Maintainer. Without that, analytics without IDFA needs no ATT. |
| When the notification primer shows | After the **first message sent successfully** in any chat; also when the Notificações tab opens while the permission is still undetermined. | Maintainer. That is when being told about a reply or confirmation makes sense. |
| Session start no longer asks | `expoPushToken()` only reads the token when the permission is already granted; it never requests. | The prompt moves to the primer. Someone who already granted sees no difference. |
| Primer frequency | At most twice ("Agora não" counts); never again after that, nor once the OS status is decided. | Asking forever is nagging; the Ajustes row stays. |
| When the ad consent card shows | On Home, from the **first unlocked session after "Criar PIN"**. For an existing install, from the first unlock after the update, while consent is still unknown. | Maintainer: earliest signal for install attribution. |
| Android | The same card, with our own "Permitir" / "Agora não" and no system prompt. | Maintainer. Same behaviour on both platforms; LGPD. |
| Default | Ad consent **denied** until the person accepts; set natively in `firebase.json` so it holds before any JS runs. Analytics storage stays granted (today's screen views are unchanged). **Changed by TER-583:** the same consent now covers usage analytics too (`analytics_storage`, collection and `screen_view` wait for a yes). | Opt-in per device. |
| iOS accept | The card has a single "Continuar" that always opens the ATT prompt; only `authorized` grants consent. Any other answer stores `denied`. | ATT is the source of truth on iOS. App Review rejects pre-prompts that can be dismissed without the system request or that mirror its "Allow". Android keeps "Permitir" / "Agora não". |
| Changing one's mind | Ajustes → "Privacidade" → "Medição de anúncios" switch. Android: toggles consent. iOS: turns it off directly; turning it on when ATT is `denied` opens the system settings (iOS never shows the ATT prompt twice). | A choice must be reversible. |
| Notifications in Ajustes | Ajustes → "Notificações": shows the status; when undetermined, "Ativar notificações" (the OS prompt); when denied, "Abrir Ajustes do sistema" (`Linking.openSettings()`). The status is re-read when the app returns to the foreground. | The only way back after a refusal. |
| Mock mode | The primer and the card show as in http mode; permission calls go to the real OS modules (a simulator answers them), and push registration keeps sending the fake mock token. | Keeps the flows testable in the simulator. |
| Session wipe | The prompt flags live in MMKV and are cleared with the other persisted stores; the OS status still wins (a decided status never shows a prompt). | A new enrolment is a new start; the OS remembers what matters. |
| Logs and analytics | New events: none. Consent changes are not logged. | Nothing to measure yet; keep it minimal. |

## 3. Components

All new code sits in `src/features/permissions/`, following the feature layout (`model/`,
`viewmodel/`, `view/`).

### 3.1 Signals (`src/features/shared/signals.ts`)

Three new payload-free signals, so no feature imports another (the pattern of `sessionEnded`):

- `sessionStarted` — emitted by the session store's `startSession` (activation and unlock).
- `messageSent` — emitted by the chat store's `send` right before `return true` (covers retry and
  "Proponha de novo", which go through `send`).
- `pushGranted` — emitted by the permissions store when the OS grants notifications; the session
  store subscribes and re-runs `registerPush` with the in-memory token (no-op when locked).

### 3.2 `createPermissionsStore` (viewmodel, logic project — no React Native import)

Persisted with zustand `persist` + `mmkvStateStorage` (name `permissions`), reset on
`sessionEnded`. State:

```ts
type AdConsent = 'unknown' | 'granted' | 'denied';
type NotificationStatus = 'granted' | 'denied' | 'undetermined';
type TrackingStatus = 'authorized' | 'denied' | 'restricted' | 'undetermined' | 'unavailable'; // 'unavailable' on Android
interface PermissionsState {
  firstMessageSent: boolean;          // persisted
  pushPrimerDismissals: number;       // persisted, 0..2
  adConsent: AdConsent;               // persisted
  pushPrimerOpen: boolean;            // memory
  platform: 'ios' | 'android';        // memory, from the deps; the ad card reads it
  notificationStatus: NotificationStatus | null; // memory, last read from the OS
  trackingStatus: TrackingStatus | null;         // memory, last read from the OS
}
```

Injected dependencies (`PermissionsDeps`): `platform: 'ios' | 'android'`, `notificationStatus()`,
`requestNotifications()`, `trackingStatus()`, `requestTracking()`, `setAdConsent(granted)`,
`openSystemSettings()`.

Actions:

- `refreshStatuses()` — reads both OS statuses into state (on `sessionStarted` and when Ajustes or
  Home focus).
- `maybeOpenPushPrimer()` — opens the primer when the OS status is `undetermined` and dismissals < 2.
  Runs on the first `messageSent` (then `firstMessageSent = true`) and when the Notificações tab
  gets focus.
- `acceptPush()` — closes the primer, `requestNotifications()`; on `granted` emits `pushGranted`.
- `dismissPush()` — closes the primer, increments dismissals.
- `acceptAds()` — iOS: `requestTracking()`, granted only on `authorized`. Android: granted.
  Calls `setAdConsent(granted)` and stores `granted` / `denied`.
- `declineAds()` — stores `denied`, `setAdConsent(false)`.
- `setAdsFromSettings(on)` — off: `declineAds()`. On: Android → `acceptAds()`; iOS → ATT
  `undetermined` → `acceptAds()`; `denied`/`restricted` → `openSystemSettings()`, consent unchanged.
- `syncAdConsent()` — on `sessionStarted`: on iOS a stored `granted` whose ATT is no longer
  `authorized` becomes `denied`; then re-applies the stored consent to Firebase (`unknown` = false).

Derived: `showAdCard(state)` = `adConsent === 'unknown'` and (Android, or ATT `undetermined` /
`authorized`). Home is only reachable unlocked, so the card first shows on the first session after
"Criar PIN", and on the first unlock after the update for an existing install.

### 3.3 Services

- `src/services/push.ts`: `expoPushToken()` no longer requests; new `notificationStatus()` and
  `requestNotifications()` wrap `getPermissionsAsync` / `requestPermissionsAsync` (the Android
  `default` channel is created before requesting, as today).
- `src/services/tracking.ts` (new): wraps `expo-tracking-transparency`; `unavailable` on Android.
- `src/services/analytics.ts`: `setAdConsent(granted)` → `setConsent(getAnalytics(), { ad_storage,
  ad_user_data, ad_personalization: granted, analytics_storage: true })`; never throws.

### 3.4 Views (pt-BR copy)

- `PushPrimerSheet` — global, mounted in `app/_layout.tsx` next to `PinPromptSheet`, built on
  `@/ui` `Sheet`. Title "Receba avisos das suas conversas"; body: "O termhub avisa quando uma aba
  pede confirmação, faz uma pergunta ou responde no chat."; buttons "Ativar notificações" (primary)
  and "Agora não" (ghost). It only presents while the session is unlocked and no PIN sheet is up
  (`pushPrimerOpen` stays set meanwhile, so it shows once those go away).
- `AdConsentCard` — on Home, in the header block after the error `Banner`. Title "Ajude a medir
  nossos anúncios"; body: "Com sua permissão, usamos o identificador de publicidade do aparelho só
  para saber quais anúncios trouxeram novas pessoas ao termhub. Você pode mudar isso em Ajustes.";
  buttons: on iOS a single full-width "Continuar" that always opens the ATT prompt (App Review
  rejects pre-prompts that can be dismissed without the system request or mirror its "Allow"); on
  Android "Permitir" and "Agora não".
- Ajustes: section "Notificações" (status text + "Abrir Ajustes do sistema" when denied) and
  section "Privacidade" (switch "Medição de anúncios"), both following the "Biometria" row.

### 3.5 Native configuration

- `app.json`: `@react-native-firebase/analytics` → `ios.withoutAdIdSupport: false`; add the
  `expo-tracking-transparency` plugin with `userTrackingPermission`: "Usamos o identificador de
  publicidade só para medir quais anúncios trouxeram você ao termhub.".
- `apps/mobile/firebase.json` (new): `react-native` →
  `analytics_default_allow_analytics_storage: true`,
  `analytics_default_allow_ad_storage: false`,
  `analytics_default_allow_ad_user_data: false`,
  `analytics_default_allow_ad_personalization_signals: false`.
- Bump the app version (minor): `runtimeVersion` follows `appVersion`, so older binaries never get
  this JS over the air (it imports a native module they lack).

## 4. Error handling

Every native call is wrapped: a failure leaves state unchanged and never blocks the flow (as push
registration is fire-and-forget today). Firebase missing (old dev client) → `setAdConsent` is a
no-op. `Linking.openSettings()` failure is ignored.

## 5. Testing

- Logic (`createPermissionsStore.test.ts`, fakes for every dep): primer opens after the first send
  only when undetermined; never after two dismissals or once decided; accept grants and
  emits `pushGranted`; `showAdCard` visibility; iOS accept with each ATT answer; Android
  accept; settings toggle on iOS with ATT denied opens settings; `syncAdConsent` downgrade;
  persisted fields survive a rehydrate; wipe clears them.
- `push.test.ts`: `expoPushToken()` never calls `requestPermissionsAsync`.
- Session and chat store tests: `sessionStarted` and `messageSent` fire on session start and successful send
  (not on failure).
- UI: primer sheet, ad card and the two Ajustes sections render and call the store.
- Fakes: `test/fakes/expo-tracking-transparency.js`, `test/fakes/react-native-firebase-analytics.js`
  registered in both setup files; `expo-notifications` fake gains a configurable status.
- `app-config.test.ts`: ATT plugin present with a pt-BR string, `withoutAdIdSupport` false,
  `firebase.json` consent defaults false.
- Manual: iOS simulator (idb) and an Android emulator — fresh enrolment shows the card; first sent
  message shows the primer; Ajustes toggles.

## 6. Outside the code (maintainer)

- App Store Connect privacy label: add "Device ID" and "Product Interaction" as **used to track**
  (third-party advertising / measurement).
- Play Console Data safety: advertising ID collected, optional.
- Privacy policy on termhub.dev: ad measurement paragraph.
- Firebase: link `apptermhub` to the Google Ads account when campaigns start.

## 7. Impact on other users

Every phone app user gets it. Someone who has not yet decided on notifications no longer gets the
bare OS prompt after "Criar PIN" and sees the primer after their first message instead; someone who
already decided sees nothing new about notifications. Ad measurement is **opt-in per device**,
denied by default, reversible in Ajustes. Server, web and landing are unchanged.
