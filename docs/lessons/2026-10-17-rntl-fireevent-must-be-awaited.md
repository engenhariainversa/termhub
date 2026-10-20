---
symptom: "You seem to have overlapping act() calls, this is not supported. / Unable to find an element with text (the next test renders null)"
tags: [mobile, jest, testing-library, react-native]
evidence: fixed
card: TER-1089
agent: claude
date: 2026-10-17
---
## Cause

In `apps/mobile`, `@testing-library/react-native`'s `fireEvent` (and `render`) return a promise: they run
inside an async `act()`. A test whose last steps fire events without `await` (here a press that calls
`Linking.openURL`, then a long press) can leave that `act()` open when it ends.
That test passes, but the next test's `render` overlaps it: Jest logs "overlapping act() calls" and the
new tree stays empty, so `screen.toJSON()` is `null` and every query of that test fails with "Unable to
find an element". The failure shows up one test later than its cause, and a test run alone with `-t`
passes, which makes it look like leaking spies or a cached parser.

## Fix

`await` every `fireEvent(...)` / `fireEvent.press(...)` in an async test, the same as `await render(...)`.

## How to check

`npm test -w @termhub/mobile -- <file>` passes as a whole file, not only test by test, and the output has
no "overlapping act()" line.
