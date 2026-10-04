---
symptom: "double click on a sidebar terminal sometimes keeps the old preview tab, sometimes replaces it"
tags: [web, react-router, dblclick, tabs]
evidence: fixed
card: TER-904
agent: claude
date: 2026-10-04
---
## Cause

The sidebar row is a `<Link to="/projects/:id?tab=…">`. A double click fires `click`, `click`, `dblclick`.
The click only navigates; the preview is opened later, by the project's terminal view reacting to `?tab=`
in an effect. The `dblclick` handler pinned the tab right away. When the clicks come fast (Playwright's
`dblclick()`, or a quick hand), the pin lands before the effect: the tab opens pinned next to the old
preview, which stays. When they come slower, the effect runs first: the preview is replaced, then pinned.
jsdom tests (`fireEvent.doubleClick`) never show it, because they fire no clicks before the `dblclick`.

## Fix

The `dblclick` handler does what the first click would have done, then pins:
`updateEditorTabs(p.id, (s) => pinTab(previewTab(s, tab.id), tab.id))`. The `?tab=` effect then finds the
tab already open and only focuses it, so the result does not depend on timing.

## How to check

`apps/web/src/components/Sidebar.test.tsx`, "a double click replaces the preview…". In a real browser
(Playwright harness against `apps/web/dist` with a mocked `/api`), double-click a sidebar terminal while
another one is in preview: only the double-clicked one stays open, pinned.
