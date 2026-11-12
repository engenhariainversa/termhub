# Feature flags

A feature that is not released yet ships **dark**: its code is merged and deployed, but it stays off
until an admin turns it on in **Configurações → Recursos em teste** (`/settings/feature-flags`),
without a deploy. Introduced by TER-1040 for the subscriptions epic (TER-645).

## How a flag is resolved

The server is the only place that decides. For a person, in this order:

1. their own **override** (`feature_flag_overrides`), set by an admin for testing, either way;
2. the **instance value** (`feature_flags`), the admin's switch for everyone;
3. the **default in code** (`FEATURE_FLAGS` in `apps/server/src/features/flags.ts`), which is off.

There is no cache: blue and green read the same rows, so a switch holds on both at once. Changes go
on the security trail (`feature_flag.update`, `feature_flag.override`). Overrides go away with the
account (cascade).

## Where to read it

| Where | How |
| --- | --- |
| Server | `isEnabled('subscriptions', { repos, userId })` from `apps/server/src/features/flags.ts`. Never read the tables directly. |
| Server routes | `preHandler: requireFeature('subscriptions', repos)`: answers `404 NOT_FOUND`, the same as a route that does not exist. |
| Provider webhooks | `preHandler: webhookGate('subscriptions', repos)`: inert (`200 { ok: true, ignored: true }`, nothing read or written) unless the instance or at least one tester has the flag on. Once the handler knows whose event it is, it checks `isEnabled` for that person and drops the event when off. |
| Web | `useFeatureFlag('subscriptions')` or `<FeatureGate flag="subscriptions">` from `apps/web/src/lib/feature-flags.tsx`. The values come in `user.features` on `/auth/me`. |
| Mobile app | `useFeatureFlag('subscriptions')` from `apps/mobile/src/features/feature-flags/viewmodel/useFeatureFlagsStore.ts`. Read from `GET /api/m/v1/me` (`features`) when a session starts; off until then. |
| Landing | `useFeatureFlag('subscriptions')` from `apps/landing/src/features.ts`, over `GET /api/public/features` (instance values only: the landing has no session, so overrides never apply there). |

Every client treats a missing flag as off, so an older server, a slow answer or an error never
shows a gated screen.

## Adding a flag

1. Add it to `FEATURE_FLAGS` (server), with `default: false`, a **`title`** (a short readable name) and a
   **`description`** (what changes for whoever turns it on, and any risk), both pt-BR keys through `tk()`
   with English and Spanish in `apps/server/src/i18n/locales/{en,es}/misc.json`, and the **`card`** it
   came from (`TER-1171`). The type requires all three and `features/flags.test.ts` fails on a flag
   without them or without its translations, so no flag reaches Recursos em teste as its bare key
   (TER-1187). The screen reads them, already translated, from `GET /api/feature-flags`: the web keeps
   no copy of its own.
2. Add the key to `FeatureFlagKey` (web `lib/types.ts`), to `meResponse.features` (mobile contract,
   defaulted to `false`) and, when the landing needs it, to `FeatureFlag` in `apps/landing/src/features.ts`.
3. Gate every screen, route, webhook and job of the feature behind it, with tests for both values.
4. Give it a pt-BR name and description in `FEATURE_FLAG_COPY` (server, the screen's copy): the chat lists it
   with `list_feature_flags`. A flag the chat must never switch goes into `MCP_HIDDEN_FLAGS`.

## Through the chat (TER-1186)

Whoever can open Recursos em teste (`feature_flags:read` to list, `feature_flags:update` to switch) can
also ask the chat: `list_feature_flags` shows each flag's value for them and where it comes from
(`default`, `instance` or `override`), and `set_feature_flag(flag, enabled | null)` sets or removes
**their own** override, the same row the screen's "Valor próprio por pessoa" writes. Never the instance
value, never another person's, never a flag in `MCP_HIDDEN_FLAGS` (`subscriptions`). Turning one on, or
back to the instance value, is a confirmation card (also under `chat_open_permissions`, where it is part
of the core); turning one off is a brake and runs at once. Agent tabs cannot call either tool. Every
change is written to the security trail as `feature_flag.override` with `meta.via: "mcp"`.

## Subscriptions (TER-645)

**Every card of the subscriptions epic (TER-645) ships behind the `subscriptions` flag.** While it is
off for a person:

- no plans, checkout, paywall or trial-limit notice shows on the web, in the app or on the landing;
- billing routes answer 404 (`requireFeature`);
- the payment provider's webhooks are inert (`webhookGate`, then `isEnabled` per person);
- no trial limit is enforced: every limit check calls `isEnabled('subscriptions', …)` first and
  lets the action through when it is off.

With the flag on for a test account (an override), the whole flow works for that account only.

## Chat: allowed by default (`chat_open_permissions`, TER-1164)

With the flag on for a person, the chat's gate inverts: the chat acts without a confirmation card and the
person lists what it must not do (blocks, per project or for every project, "pedir antes" or "nunca"). A
fixed core always asks (`OPEN_CORE_TEXT` in `apps/server/src/chat/open-permissions.ts`). With it off, the
grants model applies as before. Server: `openPermissionsOn` in `apps/server/src/chat/blocks.ts`; the
`/api/chat/blocks` routes answer 404 while off. Spec:
`docs/superpowers/specs/2026-11-06-chat-open-permissions-design.md`.

## Agent tab collector (`tab_gc`, `tab_gc_live`, TER-1171)

`tab_gc` turns the agent tab GC on for a person in **dry run**: every 10 min it classifies their agent tabs
and records in the project feed (`tab_collected` with `dry_run: true`) what it would close, closing
nothing. `tab_gc_live` (with `tab_gc`) makes it warn 30 min ahead and close for real, and the TER-1138
"Fechar abas paradas" timer steps aside for that person. The MCP tools `list_gc_candidates` and `run_gc`
answer `TAB_GC_OFF` while `tab_gc` is off; `run_gc` with `dry_run: false` answers `TAB_GC_NOT_LIVE`
while `tab_gc_live` is off. Server: `monitor/tab-gc/`. Spec:
`docs/superpowers/specs/2026-11-11-agent-tab-gc-design.md`.

## Personal runs API (`runs_api`, TER-1176)

`runs_api` turns on the personal runs API for a person: the `runs` token scope (Configurações › Tokens
de API refuses it with `422` while off), the bearer-only `/api/v1/runs` routes and "Runs da API" in
Progresso (`GET /api/runs`). While it is off every `/api/v1` route answers `404 NOT_FOUND` for that
person's tokens, the same as a route that does not exist. `runs` is never granted to a gated (concierge)
or tab token, flag or not. Server: `apps/server/src/runs/`, `routes/runs-v1.ts`, `routes/runs-web.ts`.
Spec: `docs/superpowers/specs/2026-11-11-personal-runs-api-design.md`.

## Impact on other users

None while a flag is off, which is the default: no screen, route or limit changes for anyone. The
switch is per instance (admin), with per-person overrides for testing.

## Epic in order (`sequential_epics`, TER-1170)

The flag only gates the **"Executar em ordem"** checkbox of an epic in the card editor (web). The rule
itself is not gated: an epic marked `sequential` (through the MCP `update_task` or the web's `PATCH /tasks/:id`)
runs its cards one at a time for everyone. A card of the epic in progress (a doing column, waiting ones
included, or done with its PR still open) holds every to-do card of the epic; with none, only the first to-do
card in board order is eligible, and the others show `epic_sequence` with the ref they wait on
(`sequenceHeads` in `apps/server/src/automation/queue.ts`). No epic is sequential unless someone marks it.
