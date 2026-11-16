# Multi-repo: Web Setup "Repositórios" table (TER-1072)

Epic TER-1060, card 5 of 16. Spec: `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md` §4, §9.
Parent plan: `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`, Task 5.

The server side is on `main`: `GET/PUT /projects/:id/setup` answer `effective_repos` (TER-1076), the setup
holds `repo_defaults` and `repos[]` overrides, and discovery (TER-1071) fills `project_repositories`. This
card is web only.

## Goal

In the Setup's "Repositório" card, a project with more than one repository edits each repository's policy
in a full-width table. A project with one repository sees the Setup as today.

## Steps

1. **Types** (`apps/web/src/lib/types.ts`): `RepoDefaults`, `RepoOverride`, `EffectiveRepo` (mirrors
   `apps/server/src/setup/repos.ts`), `repo_defaults?` and `repos?` on `ProjectSetupData` (absent from an
   older server, sent back as received). `api.setup.get/save` answer `effective_repos?`.
2. **Overrides helper** (`apps/web/src/lib/repo-overrides.ts`, tested):
   - `overrideFor(entry, overrides)`: the person's override, or a new one seeded from the effective entry —
     level, checks, globs, deploy and merge order as shown, and `null` for the fields that fall back
     (integration, description, base, pattern), so creating an override never changes what the repo does;
   - `setOverride(overrides, entry, patch)`: replaces or appends by `owner/repo` (no case);
   - `dropOverride(overrides, fullName)`: "Restaurar padrão".
   - `showRepoTable(effective)`: more than one entry.
3. **Component** `apps/web/src/components/RepoTable.tsx`:
   - above: default integration (`repo_defaults.integration_id`) and scan depth (1..3);
   - table, full width: key, `owner/repo` (+ description), folder per linked machine or "ausente", status,
     base, level, deploy, merge order, on/off switch;
   - a row expands into: base branch, branch pattern, deploy workflow, level (capped at the project's),
     integration, required checks, release workflows, release paths, store paths, merge order, description,
     and "Restaurar padrão" when an override exists.
   - values shown = override ?? effective; nullable fields show the effective value as placeholder.
4. **SetupForm**: keeps `effective_repos` from the GET/PUT. With the table shown, the old single-repo
   fields (integration, `owner/repo`, base, deploy) give way to the table; the project-wide fields stay
   (branch pattern hint, require ticket, draft PR). `RepoDiscovery` goes inside the card, without its own
   read-only table, and a scan refreshes the effective list. With one entry, nothing changes.
5. **i18n**: pt-BR keys, `en` and `es` entries in `src/locales/{en,es}/setup.json` (or the file the Setup
   already uses). `components/` is already in `GUARDED`.
6. **Tests**: helper unit tests; SetupForm test for a single-repo project (no table) and a two-repo project
   (table, edit a level, save sends `repos`).
7. Verify on Node 22: `npm test -w @termhub/web`, `npm run i18n:check -w @termhub/web`,
   `npm run build -w @termhub/web`.

## Impact on other users

A project with one repository sees no change. The table appears only with more than one repository.
