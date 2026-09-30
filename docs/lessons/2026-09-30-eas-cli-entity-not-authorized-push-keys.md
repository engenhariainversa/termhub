---
symptom: "Entity Not Authorized: Entity not authorized: AppEntity[<projectId>] (viewer = RegularUserViewerContext[...], action = READ)"
tags: [mobile, expo, eas, push, credentials]
evidence: fixed
agent: claude
date: 2026-09-30
---
## Cause

Two separate problems showed up while uploading the mobile push credentials (APNs key, FCM V1
service account) to Expo:

1. `eas-cli` on the machine was logged in to a different Expo account than the one that owns the
   project's `owner` in `apps/mobile/app.json`. Accounts with similar usernames are easy to mix up;
   the browser session and the CLI session can be different users. Any `eas` command against the
   project then fails with `Entity Not Authorized ... AppEntity[<projectId>]`.
2. The expo.dev web wizard ("Add bundle identifier" / "Add application identifier") insists on
   build credentials first (iOS distribution certificate + provisioning profile, Android upload
   keystore). There is no way to register only a push key there when the app is built outside EAS.

## Fix

1. Compare `npx eas-cli whoami` with the project's owner (`npx eas-cli project:info`, or the
   Members page of the Expo organization). Log the CLI in as a member of that organization.
2. Upload push credentials with the CLI, which does not require build credentials, from a checkout
   whose `app.json` has the right `owner`/`projectId` (a minimal `eas.json` with one build profile
   is enough if the repo has none):
   - iOS: `eas credentials -p ios` → Push Notifications → "Set up your project to use Push
     Notifications" → do not generate a new key → path to the `.p8`, Key ID, Apple Team ID.
     Without Apple login the key is not validated, which is fine.
   - Android: `eas credentials -p android` → Google Service Account → "Manage your Google Service
     Account Key for Push Notifications (FCM V1)" → "Set up ..." → path to the service account JSON.

Keep the `.p8` and the service account JSON outside the repository.

## How to check

On expo.dev → project → Credentials, the iOS bundle identifier shows the Push key (Key ID, Team)
under "Service credentials", and the Android application identifier shows the "FCM V1 service
account key" with the Firebase project ID.
