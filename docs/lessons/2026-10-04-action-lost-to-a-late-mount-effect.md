---
symptom: "Unable to find role=\"combobox\" and name \"Aba deste painel\" / expected \"spy\" to be called with arguments: [ 'c4', { name: 'Em revisão' } ] — Number of calls: 0 (web test fails now and then on CI, passes on rerun)"
tags: [web, react, tests, flaky, useEffect, waitFor]
evidence: fixed
card: TER-911
pr: https://github.com/engenhariainversa/termhub/pull/303
agent: claude
date: 2026-10-04
---
## Cause

Not a slow runner: an action that was really lost. The screen appears in one commit (after a mocked
request resolves, so outside `act`), and a `useEffect` from that same commit then writes state: the
terminal view loads the saved layout (`setLayout(saved)`), and a board column row syncs its draft name
(`setName(column.name)`). React runs passive effects in a later scheduler task. `waitFor`/`findBy` can
resolve in between (its MutationObserver fires right after the commit); the test then clicks or types,
and the late effect overwrites it: the preset goes back to `single`, the typed name back to `QA`. The
wait then fails after the full 5 s, which is why it looked like a timeout. On an idle machine React
usually flushes the effects in the same task first, so the gap is rarely hit locally.

## Fix

Make the state right in the commit that shows the screen, instead of a passive effect after it:

- `TerminalsView`: the saved layout loads in a `useLayoutEffect`.
- `BoardColumnsSettings` `ColumnRow`: the draft follows `column.name` by adjusting state during render
  (`if (shownName !== column.name) { … }`), not in an effect.

Do not raise `asyncUtilTimeout`: the wait was failing because the state was wrong, not because it was slow.

## How to check

`apps/web/src/test-commit.ts` (`actRightAfterCommit`) acts exactly in that gap, so the failure is
deterministic: the "… the moment the tabs/columns appear" tests in `TerminalNavigation.e2e.test.tsx`
and `BoardColumnsSettings.test.tsx` fail without the fix and pass with it. Use the same helper for any
screen whose mount effect writes state the user can also change.
