---
symptom: "mobile chat: the composer stays high after a drag-dismiss, sits behind the keyboard on reopen, and the + menu floats away from its button"
tags: [mobile, react-native, keyboard, ios, chat]
evidence: fixed
card: TER-1022
agent: claude
date: 2026-10-07
---
## Cause

The chat, project chat and Sessões screens wrapped their body in React Native's stock
`KeyboardAvoidingView` (`behavior="padding"`). On iOS it only listens to `keyboardWillShow` and
`keyboardWillHide`:

- The QuickType/suggestions bar and other height changes arrive as `keyboardWillChangeFrame` alone,
  so the padding kept the shorter height and the composer ended up partly behind the keyboard.
- An interactive dismiss (`keyboardDismissMode="interactive"`) can end with a frame change that puts
  the keyboard off screen, with no "will hide" the view listens to: the padding stayed.
- `_updateBottomIfNecessary` is async on the show path (it awaits
  `AccessibilityInfo.prefersCrossFadeTransitions()`) and sync on the hide path, so a hide that lands
  while a show is still resolving gets overwritten by the show's height.

The + menu is a `Modal` placed from the button's position measured once, when it opened. When the
keyboard went down, the button moved with the pill and the menu did not.

## Fix

`apps/mobile/src/ui/keyboard-inset.tsx`: `KeyboardInsetView` / `useKeyboardInset` listen to
`keyboardWillShow`, `keyboardWillChangeFrame`, `keyboardWillHide` and the `did` events. Each event
records only the keyboard's top from its own `endCoordinates`. The view then measures itself in
the window and pads by the overlap. A measurement that resolves late reads the latest keyboard
top, never the one it started with. The composer's + takes the keyboard down first and opens the
menu once it has landed (`useAfterKeyboardMoves`). While the menu is open, it is measured again
whenever the keyboard moves.

## How to check

`npm test -w @termhub/mobile -- src/ui/keyboard-inset src/features/chat` covers show, the QuickType
frame change, the drag-dismiss frame change, the hide/show race and the menu anchor. On an iPhone, open the keyboard,
drag the thread down, reopen it several times: the composer stays on the keyboard, suggestions bar
included, and lands on the safe area when it closes.
