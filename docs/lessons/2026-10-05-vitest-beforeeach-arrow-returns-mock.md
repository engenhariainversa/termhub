---
symptom: "a vitest test fails with the error a mock rejects with, although every assertion passed and the component caught it"
tags: [web, vitest, tests, mocks]
evidence: fixed
card: TER-953
agent: claude
date: 2026-10-05
---
## Cause

`beforeEach(() => someMock.mockReset())` returns the mock: `mockReset()` returns the spy itself, and
vitest runs a function returned from `beforeEach` as that test's teardown. So after the test the mock is
called once more, outside the component; in a test where it was set to `mockRejectedValue(err)`, that
call's rejection fails the test, pointing at the line that built the error. Tests where the mock
resolves pass, which makes it look like the component leaks a rejection.

## Fix

Give the hook a block body so it returns nothing:

```ts
beforeEach(() => {
  someMock.mockReset();
});
```

## How to check

The failing test passes; the component's catch path was never the problem (a `console.log` in its
`catch` shows the error was handled).
