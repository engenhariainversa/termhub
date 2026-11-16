# Multi-repo — app: repositories in Setup, grouped PRs in Progresso (TER-1061)

> Task 16 of `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`. Spec:
> `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md`.

**Goal:** the phone shows a multi-repo project's repositories (level and presence per machine) in its
"Trabalho automático" screen, and Progresso shows a card's PRs grouped by repository. Read-only, JavaScript
only (no native dependency, no `app.json` / `app.config.js` / `expo.version` change), so the OTA ships it.

**Already done elsewhere:** the repository chips on Progresso cards (TER-1069). This task does not touch
them.

## Tasks

1. **Contract** (`packages/mobile-api/src/repos.ts`, exported from the index): `projectReposResponse`,
   the subset of the server's `list_project_repos` view (`control/repos.ts`) the phone reads — per repo
   `key`, `full_name`, `status`, `enabled`, `autonomy`, `machines[{machine_id, machine, dir, missing}]`,
   plus the project's linked `machines[{machine_id, machine}]`. Statuses and levels stay strings so a value
   a newer server adds still parses on an older app.
2. **Server** (`routes/m-automation.ts`): `GET /api/m/v1/projects/:id/repos` answers
   `listProjectRepos(controlContextForRequest(...))` — the same scoped view the web Setup and the concierge
   read. It only reads the database (no scan; the web Setup's open is what scans). Test in
   `m-automation.test.ts`: the view comes back, and a project outside the scope is 404.
3. **App API** (`services/api/{types,client}.ts`, mock handler): `getProjectRepos(auth, projectId)`.
4. **App model** (`features/automation/model/repos.ts`, tested):
   - `repoRows(view)`: one row per repo with its label (key, else `owner/repo`), level label, and
     one presence entry per linked machine (`dir`, or "ausente" when the machine has no checkout or it went
     missing).
   - `showRepos(view)`: only for more than one repository (a single-repo project sees the screen as before).
5. **App view** (`automation-screen.tsx`): a read-only "Repositórios" block under the level, loaded
   alongside the block. A failed load (an older server answers 404) hides the block, never an error.
6. **Progresso** (`features/progress/model/pr-groups.ts`, tested): `prGroups(card)` groups the card's PRs
   by the `owner/repo` of their URL, in first-seen order. The repository name heads its group only when the
   card has `repo_keys` or its PRs span more than one repository; otherwise one unnamed group, so a
   single-repo card renders exactly as before.
7. **i18n**: pt-BR keys, `en` and `es` entries; `npm run i18n:check -w @termhub/mobile` passes.

## Verification

```bash
th 'npm test -w @termhub/server -- src/routes/m-automation'
th 'npm run typecheck -w @termhub/server'
th 'npm run typecheck -w @termhub/mobile && npm test -w @termhub/mobile -- automation progress && npm run i18n:check -w @termhub/mobile'
```

## Impact on other users

Nothing changes for single-repo projects: the repositories block is hidden with one repository and a card
whose PRs are all in one repository (no `repo_keys`) shows its PRs as before.

**CLIs covered:** not agent-specific (a read-only view of the project's repositories and PRs).
