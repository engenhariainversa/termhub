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

1. Add it to `FEATURE_FLAGS` (server), with `default: false`.
2. Add the key to `FeatureFlagKey` (web `lib/types.ts`), its label and description to `FLAG_COPY`
   in `apps/web/src/components/FeatureFlagsView.tsx` (through `tk()`, English in
   `locales/en/settings.json`), to `meResponse.features` (mobile contract, defaulted to `false`) and,
   when the landing needs it, to `FeatureFlag` in `apps/landing/src/features.ts`.
3. Gate every screen, route, webhook and job of the feature behind it, with tests for both values.

## Subscriptions (TER-645)

**Every card of the subscriptions epic (TER-645) ships behind the `subscriptions` flag.** While it is
off for a person:

- no plans, checkout, paywall or trial-limit notice shows on the web, in the app or on the landing;
- billing routes answer 404 (`requireFeature`);
- the payment provider's webhooks are inert (`webhookGate`, then `isEnabled` per person);
- no trial limit is enforced: every limit check calls `isEnabled('subscriptions', …)` first and
  lets the action through when it is off.

With the flag on for a test account (an override), the whole flow works for that account only.

## Impact on other users

None while a flag is off, which is the default: no screen, route or limit changes for anyone. The
switch is per instance (admin), with per-person overrides for testing.
