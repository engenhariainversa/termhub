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
  (tabs)/_layout.tsx              the three tabs; Notificações carries the unread badge
  (tabs)/index.tsx                Chats
  (tabs)/notifications.tsx        Notificações
  (tabs)/settings.tsx             Ajustes
  chat/[id].tsx                   a conversation (deep link target: termhub://chat/<conversation_id>)

src/features/
  session/    enrolment, PIN and activation, unlock, silent renewal, relock, biometrics, leaving/revocation
  chat/       projects, a conversation, live events, decisions, the account-wide chat's host picker
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

src/ui/       Screen, Text, Button, Field, PinInput, Sheet, Card, Banner… (NativeWind v4)
src/theme/tokens.ts  the termhub palette (CSS variables), both colour schemes
test/         jest setup, fakes for MMKV/SecureStore/expo-device/expo-local-authentication/the
              hardware key module, and shared test helpers (`test/helpers/enrolled-session.ts`,
              `test/helpers/ui-stores.ts`)
```

### Mock mode

`EXPO_PUBLIC_API_MODE=mock` (the fallback when the variable is unset) makes `src/services/api/index.ts` build the app's one `MobileApi` over `MockTransport` instead of `FetchTransport`: an in-memory implementation of the exact same contract (`src/services/api/contract/`), answering the same URLs with the same status codes, bodies and socket frames a real server would. Nothing else in the app knows the difference — the same `HttpMobileApi` client builds DPoP proofs, retries once on a renewed token and so on, whether the transport underneath is real or not. This is how the app runs on the simulator, on a phone with no server, and in every Jest test.

Two things exist only under `mock`: the *Aguardando aprovação* screen's "Simular aprovação na web" / "Simular recusa" buttons (`mockControls`, `null` in `http` mode — nothing approves a request by itself otherwise), and the fake `ExponentPushToken[mock-…]` registered after each unlock. The "Diagnóstico da chave" row in Ajustes (`src/features/settings/model/key-diagnostic.ts`) is *not* mode-dependent: on any build it always runs on `HardwareDeviceKey`, under its own tag `dev.termhub.diagnostic` (never the enrolled device key), so it exercises the Secure Enclave / Keystore even in mock mode, with no server; only Jest swaps in `SoftwareDeviceKey` (vault key `key.diagnostic`).

### How the flow works

Enrolment (P§4): `requestDevice(email)` generates the device key, shows the verification code and polls until approved (or, in mock mode, the person taps "Simular aprovação"). Approval moves the session to `pin_setup`; `createPin` activates the device, wraps the server's `pin_secret` with a PIN-derived key (scrypt) in SecureStore, and the app is `unlocked`. From there: `locked` after 5 minutes in the background or a cold start (`unlock(pin)` never compares the PIN locally — every guess costs a server call, P§5.4); a wrong PIN three times locks the device for a while; biometrics is a SecureStore item guarded by `requireAuthentication`, a shortcut to the same unwrap. The chat store owns the app's one `/ws/m/chat` socket, opened by the first conversation `open()`; messages only ever land in state through socket events, never by appending locally on send. A `confirmation` event both updates the open conversation's action list and — through `subscribeEvents` — prepends a placeholder row into `useNotificationsStore` before the server's own notification row is fetched. "Sair e remover este aparelho" revokes the device and wipes every vault item and persisted store (`sessionEnded`).

### Env vars

See `.env.example`. `EXPO_PUBLIC_API_MODE` (`mock` | `http`; the code falls back to `mock` when it is unset, `.env.example` sets `http`) and `EXPO_PUBLIC_TERMHUB_URL` (the server `http` mode talks to, and the host Ajustes shows as "Servidor", e.g. from `expo start`). `eas.json` sets both per build profile: `development` and `production` both use `http` and `https://termhub.dev` — there is no server picker in the app, spec §11.1. Set `EXPO_PUBLIC_API_MODE=mock` in `.env` to run with no server at all.

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

The app needs a **development build** (native modules; Expo Go cannot load it):

```bash
cd apps/mobile
npx eas init                      # once per Expo account: writes extra.eas.projectId into app.json
npx eas build --profile development --platform ios      # or android; installs on a device/simulator
npm start                         # Metro; the development build connects to it
```

Copy `.env.example` to `.env` for `expo start`: it points the app at `https://termhub.dev` in `http` mode; with no `.env` at all the app runs in mock mode, with no server needed. Development and production builds bake `http` mode and `https://termhub.dev` in through `eas.json`.

Before a production build: APNs key and FCM v1 service account in EAS credentials (`npx eas credentials`), store listings, and the reviewer notes of spec §12.3.

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

## Conventions

- Code, comments and commits in English; every string a person sees in pt-BR.
- Bundle / package id `dev.termhub.app`, URL scheme `termhub`.
- Pure logic (`model/`) and viewmodels must not import React Native or `expo-router`: the `logic` jest project runs them in plain Node and fails otherwise.
- The monorepo pins a single React version (root `package.json` `overrides`); Expo SDK upgrades bump it for every workspace.
