---
symptom: "Unable to find an element with role: button, name: Fechar / the next test's render is null after a sync act()"
tags: [mobile, jest, testing-library, modal, accessibility]
evidence: fixed
card: TER-1041
agent: claude
date: 2026-10-07
---
## Cause

Two separate surprises while testing the mobile `ActionSheet` (`apps/mobile/src/ui/action-sheet.tsx`):

1. A view with `accessibilityViewIsModal` hides its siblings from `@testing-library/react-native`
   queries (as VoiceOver would). The sheet's backdrop sits next to the panel, so
   `getByRole('button', { name: 'Fechar' })` and even `getByTestId('action-sheet-backdrop')` find
   nothing, although the element is rendered.
2. RNTL 14 renders asynchronously. A plain `act(() => …)` (not awaited) inside a test left the
   renderer in a state where every later test in the same file rendered `null`
   (`screen.toJSON()` was `null`), so the failure showed up in the *next* test, not the one at fault.

## Fix

1. Query elements outside the modal view with `{ includeHiddenElements: true }`.
2. Always `await act(async () => …)` in the mobile `ui` tests.

## How to check

`npx jest src/ui/action-sheet.test.tsx` from `apps/mobile`: all tests pass, and running them in any
order (`-t` subsets) gives the same result.
