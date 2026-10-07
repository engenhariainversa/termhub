---
symptom: "Mobile: opening a screen (a session from Chats → Sessões, a file preview…) lands on the Home tab instead"
tags: [mobile, expo-router, navigation, redirect]
evidence: fixed
card: TER-1002
agent: claude
date: 2026-10-07
---
## Cause

`usePhaseRedirect` (`apps/mobile/app/_layout.tsx`) runs on every route change and asks `redirectFor`
(`apps/mobile/src/features/session/model/redirect.ts`) whether the current screen belongs to the
session phase. For `unlocked` it was an allow-list of `(tabs)` and `chat` only, so any other screen
(`session/[tabId]`, `session/new`, `file-preview`, `chat-grants`, `project-ai`…) was replaced with
`/(tabs)` on its first render. The push and the route existed; the redirect undid them. A push to
`/session/<id>` looked fine for one render, then bounced once its `pendingRoute` was cleared.

## Fix

`unlocked` now owns every screen except the other phases' ones (root `index`, `enrol/*`, `unlock`,
`account-deletion`): a deny-list, so a new screen under `app/` works without touching the redirect.

## How to check

`npx jest --rootDir apps/mobile -c apps/mobile/jest.config.js redirect`: one test walks `app/` and
checks that an unlocked session stays on every screen there that belongs to no other phase.
