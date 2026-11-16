# Multi-repo: board chips and repository selection (TER-1069)

Epic TER-1060, card 8 of 16. Spec: `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md` §6.
Parent plan: `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`, Task 8.

TER-1070 is on `main`: tasks carry `repo_keys` (checked under the project lock against the effective
repositories, `[]` in a single-repo project), and the MCP tools take `repos`. The REST routes the web uses do
not take the field yet, and the app's Progresso does not get it.

## Goal

A card shows the repositories it touches, and the web edits them. A single-repo project sees its cards as
today: its cards always have `repo_keys: []`, so no chip renders, and the form shows no selector.

## Steps

1. **Server REST** (`apps/server/src/routes/tasks.ts`): `repo_keys` (array of ≤ 10 strings of ≤ 200 chars,
   the `REPO_KEYS_MAX` / `REPO_REF_MAX` limits) on `POST /projects/:id/tasks` and `PATCH /tasks/:id`, passed
   to the repository, which already validates and maps errors (`REPO_UNKNOWN` … → 400). Route test.
2. **Server progress** (`db/repositories/progress.ts`, `progress/aggregate.ts`): each card row carries
   `repo_keys`; `aggregateCard` copies it.
3. **Contract** (`packages/mobile-api/src/progress.ts`): `cardProgress.repo_keys`, `z.array(z.string())
   .default([])` so an older server still parses.
4. **Web**
   - `Task.repo_keys?` and `TaskPatchInput.repo_keys?` in `lib/types.ts`.
   - `lib/project-repos.ts`: `selectableRepos(view)` — the enabled, keyed repositories of
     `GET /projects/:id/repos`, and `multi` when more than one is enabled (same rule as the server's
     `isMultiRepo`). Hook `useSelectableRepos(projectId)`; a failed read (no `projects:read`, older server)
     means "no selector".
   - `components/RepoChips.tsx`: one small mono chip per key; renders nothing for `[]`.
   - Board card (`TasksBoard.tsx` `TaskCard`): chips under the title row.
   - Card editor (`TaskEditor.tsx`): prop `repos` (from the board's hook); for a story/task/bug/spike in a
     multi-repo project, a "Repositórios" checkbox group. "Salvar" sends `repo_keys` only when the set
     changed. A key the card holds that is no longer selectable (turned off later) stays listed, checked, so
     saving other fields never drops it silently.
5. **App** (`progress-screen.tsx`): read-only chips next to the card's title in Progresso. JS only.
6. **i18n**: new web strings in `src/locales/{en,es}/board.json` (or the area the editor uses); app strings in
   its catalogs. `npm run i18n:check` in web and app.

## Tests

- Route: PATCH with `repo_keys` reaches `repos.tasks.update`; a 400 from `REPO_UNKNOWN`.
- `aggregateCard` copies `repo_keys`.
- Web: `selectableRepos`; `TaskEditor` hides the selector in a single-repo project, shows it in a multi-repo
  one and saves the picked keys; `RepoChips` renders nothing for `[]`.
- App: progress screen shows the chips.

## Impact on other users

Only projects with more than one enabled repository see something new. Single-repo projects look the same.

**CLIs covered**: not an agent feature (board UI only).
