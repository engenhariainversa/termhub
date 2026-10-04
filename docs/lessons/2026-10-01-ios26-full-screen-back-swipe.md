---
symptom: "iOS: a right drag inside a screen (on a chat card) leaves the screen as if swiping back, though it did not start at the edge"
tags: [mobile, ios, gestures, react-native-screens, expo-router]
evidence: fixed
card: TER-849
agent: claude
date: 2026-10-01
---
## Cause

On iOS 26, react-native-screens (4.x) turns on the full-screen back swipe by default: a screen whose
`fullScreenSwipeEnabled` is unset counts as enabled (`isFullScreenSwipeEffectivelyEnabled` in
`ios/RNSScreen.mm`), which enables UIKit's `interactiveContentPopGestureRecognizer`
(`ios/RNSScreenStack.mm`). expo-router's `Stack` passes `fullScreenGestureEnabled` through as
`fullScreenSwipeEnabled`, so leaving it unset means "pop on a right drag from anywhere in the content".
Before iOS 26 the same default meant edge-only, which is why the app never set it.

A view with its own horizontal recognizer wins the drag (the chat bubbles' drag-to-answer, a
react-native-gesture-handler `Pan`); anything else does not. In the chat, the gate cards and the tabs'
question cards had no recognizer, so a right drag on them popped the conversation. Nothing shows in
jest: the native recognizers never run there.

## Fix

- Give the screen edge-only back: `<Stack.Screen name="chat/[id]" options={{ fullScreenGestureEnabled: false }} />`
  in `apps/mobile/app/_layout.tsx`. The edge swipe (`gestureEnabled`) stays on.
- A row that should answer a horizontal drag still needs its own recognizer (`SwipeToReply`): the
  option only stops the screen from taking the drag.

## How to check

On an iPhone with iOS 26: in a conversation, drag a card to the right from its middle — the screen stays
(and the card is quoted); drag from the screen's left edge — the screen goes back. Under jest,
`apps/mobile/src/root-layout.test.tsx` pins the option. Any other screen with horizontal content (a
carousel, a drag handle) needs the same check on iOS 26.
