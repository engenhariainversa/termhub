---
symptom: "mobile chat/session: while the thread is dragged and the keyboard slides down, the composer stays in the middle of the screen with a gap above the keyboard"
tags: [mobile, react-native, keyboard, ios, chat, reanimated]
evidence: observed
card: TER-1103
agent: claude
date: 2026-10-21
---
## Cause

The TER-1022 fix (`KeyboardInsetView`, see `2026-10-07-mobile-composer-out-of-sync-with-keyboard.md`)
only moves on keyboard *events*. During an interactive dismiss (`keyboardDismissMode="interactive"`)
the keyboard follows the finger and iOS sends no event at all until the finger lets go, so the
padding kept the keyboard's full height while the keyboard was already half way down. That is the
"box floating in the middle" frame. It was not a missing OTA: the 0.6.0 line already carried TER-1022.
Both the chat and the session screen share the component, so both had it.

## Fix

On iOS, `KeyboardInsetView` also reads Reanimated's `useAnimatedKeyboard` (through
`apps/mobile/src/ui/keyboard-frames.ts`). Its iOS observer watches the keyboard view's `center` with
KVO, so it moves frame by frame during the drag. While the state is `CLOSING`, the padding is the
keyboard's frame-by-frame overlap, capped by the last inset the events set (`trackedInset`). Otherwise
the events' inset still rules, so the QuickType bar keeps working, and it is eased in once on the
keyboard's duration. Android keeps the event-only path: `useAnimatedKeyboard` changes how the window
handles insets there. Reanimated was already in the binary, so this ships over OTA.

## How to check

`npm test -w @termhub/mobile -- src/ui/keyboard-inset src/features/tab-chat/view/session-screen`
drives the fake in `test/fakes/keyboard-frames.js` through a drag. On an iPhone, open a session's
conversation, bring the keyboard up, and drag the thread down slowly: the composer stays glued to the
keyboard's top, lands on the safe area when it closes, and goes back up with it when the drag is let
go early.
