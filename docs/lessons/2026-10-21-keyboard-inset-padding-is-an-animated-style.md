---
symptom: "KeyboardInsetView test: expect(padding()).toBe(296) received 0 in CI, green on the branch"
tags: [mobile, jest, keyboard, reanimated, ci]
evidence: fixed
card: TER-1107
pr: https://github.com/engenhariainversa/termhub/pull/521
agent: claude
date: 2026-10-21
---
## Cause

CI runs a pull request against its merge with `main`, not the branch alone. TER-1103 had landed on
`main` in the meantime and turned the iOS `KeyboardInsetView` into an `Animated.View` whose
`paddingBottom` is a Reanimated animated style, driven by the keyboard frames from
`@/ui/keyboard-frames` (faked under jest by `test/fakes/keyboard-frames.js`). A test written before
that, reading `StyleSheet.flatten(view.props.style).paddingBottom`, only ever sees the static style,
so the padding read 0 even though the keyboard events arrived. Locally the branch passed because it
did not have TER-1103 yet.

## Fix

Merge `main` into the branch, then read the padding the way `keyboard-inset.test.tsx` does:
`getAnimatedStyle(screen.getByTestId('…')).paddingBottom`, and move the fake keyboard frames along
with the events (`jest.requireMock('@/ui/keyboard-frames').__setKeyboardFrame(KeyboardState.OPEN, h)`
after `keyboardWillShow`, `CLOSED, 0` after `keyboardWillHide`; `__resetKeyboardFrame()` in
`afterEach`).

## How to check

After merging `main`, rebuild the packages (`npm run build:packages`, the contract package may have
changed too) and run `npm test -w @termhub/mobile`: every suite passes.
