---
symptom: "TypeError: Cannot read properties of undefined (reading 'prototype') at node_modules/expo-audio/src/ExpoAudio.ts"
tags: [mobile, jest, expo-audio, tests]
evidence: fixed
card: TER-1036
agent: claude
date: 2026-10-07
---
## Cause

`expo-audio` reaches its native module when it is imported, and the mobile `ui` jest project has no
binding for it. Until TER-1036 only `use-voice.ts` imported it, and every suite that rendered the
composer mocked `../viewmodel/use-voice`, so nothing loaded the real module. Importing `expo-audio` from a
view that many screens render (the bubble's audio player in `message-attachments.tsx`) made every
suite that renders a message bubble fail to load, before any test ran.

## Fix

`apps/mobile/test/ui-setup.js` mocks `expo-audio` with `test/fakes/expo-audio.js`: a player whose
methods are spies and whose status a test sets with `__setStatus`. A suite about the recorder still
mocks the module itself (`use-voice.test.tsx`), which overrides the global fake. A native module used
by a widely rendered view gets the same treatment: a fake in `test/fakes`, wired in `ui-setup.js`. For
`expo-file-system`, import it lazily (`await import('expo-file-system')`) inside the function that
needs it, as `services/api/transport.ts` and `features/chat/viewmodel/audio-cache.ts` do.

## How to check

`npx jest src/features/chat` from `apps/mobile` loads every suite (no "Test suite failed to run").
