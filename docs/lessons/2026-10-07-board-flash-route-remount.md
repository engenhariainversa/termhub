---
symptom: "The board flashes (blank / \"Carregando…\") when a card is opened, or edited and saved"
tags: [web, react-router, board, remount]
evidence: fixed
card: TER-976
agent: claude
date: 2026-10-07
---
## Cause

Opening a card navigated from `/projects/:id/tasks` to `/project/:ref`, a different `<Route>` whose
element was `CardPage`, not `ProjectPage`. React Router swaps the element, so React unmounted the whole
`ProjectPage` (board, and the terminals it keeps mounted) and mounted `CardPage`, which showed
"Carregando…" while it resolved the ref and then mounted a fresh `ProjectPage` → `TasksBoard` that
fetched the board again ("Carregando o board…"). Saving closes the editor, which navigated back to
`/projects/:id/tasks` — another element swap, another remount and refetch. The save itself was already
optimistic; the flash was the route change, not the PATCH.

## Fix

The open card lives in the board's own URL as a query parameter (`/projects/:id/tasks?card=TER-12`,
`CARD_PARAM` / `boardCardPath` in `apps/web/src/lib/board.ts`). Opening pushes the query with
`{ boardCard: true }` history state; closing goes `navigate(-1)` for such an entry (so the browser's
back and the editor's close agree) or drops the parameter with `replace` for a pasted link. Only the
search changes, so the route element stays and nothing remounts. `/project/:ref` became a read-only
card page of its own (`CardPage`).

General rule: never move an overlay (modal, drawer) to a sibling route that renders a different
element than the page under it — use a query parameter or a nested route under the same element.

## How to check

`npm test -w @termhub/web -- src/components/TasksBoard.test.tsx src/pages/ProjectPage.test.tsx`: the
"card URLs" tests assert `api.tasks.list` is called once across open → save → close, and the
ProjectPage test asserts the board mounts once while `?card=` comes and goes.
