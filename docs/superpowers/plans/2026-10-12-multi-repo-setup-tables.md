# Multi-repo: repository tables and per-repo overrides (server) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** give a project a place to hold several repositories: two tables that discovery will fill, per-repo
overrides in the setup, and one function that answers "which repositories does this project have, and with
which policy". Card TER-1076, task 1 of `2026-10-07-multi-repo-automation.md`.

**Architecture:** discovered repositories live in `project_repositories` / `project_repository_checkouts`
(written only by discovery, a later card). The setup JSON gains `repo_defaults` and `repos[]`, the person's
overrides keyed by `owner/repo`. A pure module, `setup/repos.ts`, merges the two into the effective list and
mirrors the first enabled repo into the old `setup.repo` block. The repository class only loads rows and calls
it. Nothing outside Setup (the route and `get_project_setup`) reads the table.

**Tech stack:** TypeScript, Prisma/PostgreSQL, zod, Fastify, vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md` — R1, R6, R7, R19, §3.1, §4, §10.

## Global constraints

- Additive migration, compatible with the previous colour: two new tables, no change to an existing one.
- Routes never import Prisma; they go through `repos.projectRepositories`. Every input goes through zod.
- No `SETUP_VERSION` bump: `normalizeSetup` fills the new defaults.
- **A project with one repository sees no change**: with an empty table and no overrides, a setup loads and
  saves as before, and `setup.repo` is never rewritten.
- Server messages are pt-BR keys through `tk()` / `msg()`, with `en` and `es` entries in
  `apps/server/src/i18n/locales/{en,es}/routes.json`; `npm run i18n:check -w @termhub/server` passes.
- The Prisma client under `apps/server/src/generated/prisma` is committed: run `npm run prisma:generate` after
  the schema change and commit the result. CI fails on a stale client and on a migration that differs from
  the schema (`prisma migrate diff --exit-code`).
- Cite the decision in code comments (`// spec 2026-10-07 multi-repo R7`).

### Running things

Docker is refused in an automatic tab (lesson `2026-10-07-docker-blocked-in-automation-tab.md`), so use the
host's Node from the worktree root:

```bash
npm ci && npm run prisma:generate && npm run build:packages        # once
DATABASE_URL=postgresql://x:x@127.0.0.1:1/x npm test -w @termhub/server -- src/setup src/routes/setup src/control/integrations
DATABASE_URL=postgresql://x:x@127.0.0.1:1/x npm test -w @termhub/server
npm run typecheck -w @termhub/server && npm run i18n:check -w @termhub/server
```

`*.db.test.ts` suites need a migrated Postgres and run in CI only.

## Review focus

1. **A repo gains rights by becoming the mirror.** `setup.repo` is "the legacy repo", which gets the
   project-wide policy. When the mirror moves to another repo, that repo must not inherit the project's
   autonomy. Pinned by "moving the mirror writes explicit overrides for both repos" (Task 2).
2. **A save from a client that does not know `repos`** (a form loaded before the deploy, the phone app) must
   not wipe the overrides. Pinned by the route test "keeps the stored overrides when the body omits them"
   (Task 4).
3. **`owner/repo` differs only in case** between the setup, the override and what `git remote` says. All
   matching is case-insensitive. Pinned in Task 2 and Task 3.
4. **The project's autonomy is lowered after a repo was raised.** The stored override stays above the
   ceiling; the effective list must clamp it. Pinned by "clamps" (Task 2).
5. **Two folders slug to the same key**, or a subfolder is literally named `main`. Keys stay unique and are
   never reassigned. Pinned by the key tests (Task 2) and the DB test (Task 3).

## Decisions taken here

| # | Question | Choice | Why |
| --- | --- | --- | --- |
| 1 | Which repo is `setup.repo` in the effective list when rows exist but none matches it? | It stays in the list as a hand-added repo (key `null`, `discovered: false`). | R1's union: it is a repo the person added by hand. Dropping it would stop a working project the moment a scan finds another checkout. |
| 2 | Tie on `merge_order` when choosing the mirror | The repo already in `setup.repo` wins, then key order, then `owner/repo`. | Every repo starts at `merge_order` 0. Without this the first scan could move the mirror, and the previous colour would start syncing another repo. |
| 3 | Mirror moves to another repo | Before `setup.repo` is rewritten, the old and the new repo each get an explicit entry in `repos[]` with their effective values, when they have none. | The repo in `setup.repo` with no override reads the project-wide policy (§3.1). Without the entries, the old repo would lose its level and the new one would jump from `pr` to the project's. |
| 4 | No enabled repo left | `setup.repo` is left as it is. | The mirror only writes a repo, never clears one: clearing would drop base branch, pattern and deploy workflow. Honouring `enabled: false` for the last repo belongs to the cards that move the run path (tasks 10–11). |
| 5 | `null` in an override of the legacy repo | `integration_id`, `base_branch`, `branch_pattern` and `deploy_workflow` fall back to `setup.repo`'s value. | §3.1 step 2. An override added only to set `merge_order` must not silently stop deploy tracking. To clear the workflow, clear it in the `repo` block. |
| 6 | Override autonomy above the project's | Refused on save (400), clamped on read. | The plan asks for the validation; the clamp covers a project level lowered later through `set_automation_policy`. |
| 7 | "Valid glob" | Relative to the repo root: no leading `/`, no `\`, no `..` segment, 1–200 chars. Applied to the per-repo globs only. | R7. The project-wide globs keep their rule, so no stored setup becomes invalid. |
| 8 | Where the mirror runs | Inside `ProjectSetupRepository.save`. | Six callers save the setup; one place cannot be forgotten. Costs one indexed query per save. |
| 9 | Checks at save vs at read | Unique name, ceiling and globs are checked in `setupInputSchema` only. | Same as `allowed_tools`: a stored value that fails a later rule must not reset the whole block on read. |

## File structure

| File | Responsibility |
| --- | --- |
| `apps/server/prisma/schema.prisma`, `prisma/migrations/20261018090000_project_repositories/migration.sql` | The two tables |
| `apps/server/src/generated/prisma/**` | Regenerated client |
| `apps/server/src/db/repositories/types.ts` | `ProjectRepository`, `ProjectRepositoryCheckout`, `RepoStatus`, mapper |
| `apps/server/src/setup/schema.ts` | `repo_defaults`, `repos[]`, save-time checks |
| `apps/server/src/setup/repos.ts` (new) | Pure: `effectiveRepos`, `withRepoMirror`, `repoKeyFor`, `uniqueRepoKey` |
| `apps/server/src/db/repositories/project-repositories.ts` (new) | `listByProject`, `upsertDiscovered`, `markMissing`, `effective` |
| `apps/server/src/db/repositories/project-setup.ts` | `save` applies the mirror |
| `apps/server/src/routes/setup.ts`, `apps/server/src/control/integrations.ts`, `apps/server/src/mcp/tools.ts` | `effective_repos` on GET/PUT, `repos` on `get_project_setup` |

## Tasks

### Task 1: Setup schema — `repo_defaults` and `repos[]`

**Files:** modify `apps/server/src/setup/schema.ts`, `apps/server/src/setup/schema.test.ts`,
`apps/server/src/i18n/locales/{en,es}/routes.json`.

**Produces:**

```ts
export const REPOS_MAX = 50;
export const repoDefaultsSchema: z.ZodObject<…>;   // { integration_id: string | null = null, scan_depth: 1..3 = 1 }
export const repoOverrideSchema: z.ZodObject<…>;   // see below
export type RepoDefaults = z.infer<typeof repoDefaultsSchema>;
export type RepoOverride = z.infer<typeof repoOverrideSchema>;
export const sameRepo = (a: string | null | undefined, b: string | null | undefined) => boolean; // case-insensitive
export const DUPLICATE_REPO, REPO_AUTONOMY_ABOVE_PROJECT, INVALID_REPO_GLOB;                      // tk('…')
// setupSchema gains: repo_defaults: repoDefaultsSchema.default({}), repos: z.array(repoOverrideSchema).max(REPOS_MAX).default([])
```

`repoOverrideSchema`: `full_name` (`owner/repo`, required), `enabled` (true), `integration_id` (null),
`description` (≤ 200, null), `base_branch` (≤ 100, null), `branch_pattern` (≤ 100, null), `deploy_workflow`
(≤ 200, null), `autonomy` (`pr`), `required_checks` (≤ 20), `release_workflows` (≤ 10), `release_paths` and
`store_paths` (≤ 50 each), `merge_order` (int 0..999, 0).

`setupInputSchema.superRefine` adds, per `repos[i]`: `DUPLICATE_REPO` on `['repos', i, 'full_name']` for a name
seen before (case-insensitive); `REPO_AUTONOMY_ABOVE_PROJECT` on `['repos', i, 'autonomy']` when its index in
`AUTONOMY_LEVELS` is above `automation.autonomy`'s; `INVALID_REPO_GLOB` on the glob's path.

- [ ] **Step 1: failing tests** in `schema.test.ts`, `describe('setup repositories (TER-1076)')`:
  - a v2 setup with only `repo` normalizes to `repo_defaults: { integration_id: null, scan_depth: 1 }`,
    `repos: []`, and `repo` deep-equal to what it was before;
  - an override with only `full_name` gets every default listed above;
  - save refuses: a repeated `full_name` (`acme/api` and `Acme/API`), `autonomy: 'merge'` under a project at
    `pr`, the globs `/abs`, `../x`, `a/../b`, `a\\b`, 51 overrides, `scan_depth` 0 and 4;
  - save accepts `autonomy: 'merge'` under a project at `deploy`, and the glob `apps/**/package.json`;
  - a stored override above the project's level is still read as stored (`normalizeSetup`);
  - a corrupt `repos` value falls back to `[]` and keeps the other blocks.
- [ ] **Step 2:** run `npm test -w @termhub/server -- src/setup/schema` — the new tests fail.
- [ ] **Step 3:** implement; add the three messages to both catalogs.
- [ ] **Step 4:** tests and `npm run i18n:check -w @termhub/server` pass.
- [ ] **Step 5:** commit `Setup: per-repo overrides and repo defaults in the schema`.

### Task 2: `setup/repos.ts` — effective list, mirror, keys

**Files:** create `apps/server/src/setup/repos.ts`, `apps/server/src/setup/repos.test.ts`; modify
`apps/server/src/db/repositories/types.ts` (types only in this task).

**Produces:**

```ts
// types.ts
export type RepoStatus = 'ok' | 'unsupported' | 'no_access';
export interface ProjectRepositoryCheckout { machine_id: string; dir: string; default_branch: string | null; has_commits: boolean; seen_at: string; missing_at: string | null }
export interface ProjectRepository { id: string; project_id: string; full_name: string; key: string; description: string | null; status: RepoStatus; discovered_at: string; updated_at: string; checkouts: ProjectRepositoryCheckout[] }

// setup/repos.ts
export const LEGACY_REPO_KEY = 'main';
export interface EffectiveRepo {
  full_name: string;
  key: string | null;          // null: added by hand, discovery has not named it yet
  discovered: boolean;
  has_override: boolean;
  status: RepoStatus;          // 'ok' while not discovered
  enabled: boolean;
  integration_id: string | null;
  description: string | null;
  base_branch: string;
  branch_pattern: string;
  draft_pr: boolean;
  deploy_workflow: string | null;
  autonomy: AutonomyLevel;
  required_checks: string[]; release_workflows: string[]; release_paths: string[]; store_paths: string[];
  merge_order: number;
  checkouts: ProjectRepositoryCheckout[];
}
export function effectiveRepos(setup: ProjectSetupData, discovered: ProjectRepository[]): EffectiveRepo[];
export function withRepoMirror(setup: ProjectSetupData, discovered: ProjectRepository[]): ProjectSetupData;
export function repoKeyFor(dir: string): string;                       // '.' -> 'main', else the slugged base name
export function uniqueRepoKey(base: string, taken: Iterable<string>): string;   // base, base-2, base-3 …
```

Rules of `effectiveRepos` (`legacy` = `setup.repo` when it has a `full_name`; `o` = the override of the same
name; `row` = the discovered row of the same name):

| Field | Value |
| --- | --- |
| members | every row, every override, and `legacy`; one entry per name (case-insensitive) |
| `key` | `row.key`; else `main` for `legacy` when there is no row at all (R19); else `null` |
| `enabled`, `merge_order` | `o`'s, else `true` / `0` |
| `integration_id` | `o` → `legacy` (same repo) → `repo_defaults.integration_id` |
| `description` | `o` → `row` |
| `base_branch` | `o` → `legacy` (same repo) → default branch of the first present checkout → `main` |
| `branch_pattern` | `o` → `setup.repo.branch_pattern` (the project's) → `{ticket}-{slug}` |
| `draft_pr` | `setup.repo.draft_pr`, else `true` |
| `deploy_workflow` | `o` → `legacy` (same repo) → `null` |
| policy, with `o` | `o`'s `required_checks`, `release_*`, `store_paths`; `autonomy` = min(`o.autonomy`, project's) |
| policy, no `o`, legacy repo | the project's `automation` values (§3.1 step 2) |
| policy, no `o`, any other | `pr`, and empty lists (R6) |
| order | `merge_order`, then key (`null` last), then name |

Rules of `withRepoMirror`: unchanged when there are no rows and no overrides. Candidates are the enabled
entries with status `ok` and a name in `owner/repo` form, ordered by `merge_order`, then "is the current
`setup.repo`", then key, then name. No candidate: unchanged. Same repo as `setup.repo`: `repo` is rewritten
with the entry's `integration_id`, `full_name`, `base_branch`, `branch_pattern`, `draft_pr`,
`deploy_workflow`. Another repo: first append to `repos[]` an explicit override for the old repo and for the
new one, each from its effective entry, when it has none (decision 3); if that would pass `REPOS_MAX`, leave
the setup unchanged.

- [ ] **Step 1: failing tests** in `repos.test.ts`:
  - empty table, no `repo`: `[]`;
  - empty table, `repo` set: one entry, key `main`, the repo's base/pattern/deploy/integration, the project's
    autonomy and required checks, `discovered: false`;
  - `repo` with `full_name: null`: `[]`;
  - rows `api` (legacy) and `web`: `api` keeps the project's level, `web` is at `pr` with empty lists and its
    checkout's default branch as base;
  - override for a repo discovery has not seen: listed, key `null`, `repo_defaults.integration_id`;
  - clamps: override `deploy` under a project at `merge` reads `merge`;
  - names match case-insensitively across `repo`, override and row (one entry, not three);
  - legacy repo with an override whose nullable fields are `null`: base, pattern, deploy and integration come
    from `repo`; autonomy from the override;
  - a missing checkout (`missing_at` set) is not used for the base branch;
  - order by `merge_order`, key, name;
  - mirror: unchanged object for no rows and no overrides; same repo rewritten idempotently; `merge_order`
    tie keeps the current repo; current repo disabled → moves, both repos get explicit overrides, the new
    one at `pr`, and a second call changes nothing; no enabled repo → unchanged; `repo: null` with one
    discovered repo → that repo, at `pr`; an `unsupported` row is never the mirror;
  - `repoKeyFor`: `.` → `main`, `Hub Community_BFF` → `hub-community_bff`, `apps/web/` → `web`, `..` and
    `@@@` → `repo`, 80 chars cut to 64; `uniqueRepoKey('main', ['main', 'main-2'])` → `main-3`.
- [ ] **Step 2:** run `npm test -w @termhub/server -- src/setup/repos` — fails (module missing).
- [ ] **Step 3:** implement.
- [ ] **Step 4:** tests pass.
- [ ] **Step 5:** commit `Setup: effective repository list and the repo mirror`.

### Task 3: tables and the `projectRepositories` repository

**Files:** modify `apps/server/prisma/schema.prisma`, `apps/server/src/db/repositories/{types,index,project-setup}.ts`;
create `apps/server/prisma/migrations/20261018090000_project_repositories/migration.sql`,
`apps/server/src/db/repositories/project-repositories.ts`, `project-repositories.db.test.ts`; regenerate
`apps/server/src/generated/prisma`.

**Consumes:** `effectiveRepos`, `withRepoMirror`, `repoKeyFor`, `uniqueRepoKey`, `sameRepo`, `lockProject`.

**Produces:**

```ts
export interface DiscoveredCheckoutInput { full_name: string; dir: string; default_branch: string | null; has_commits: boolean; description?: string | null; status?: RepoStatus }
export async function loadProjectRepositories(db: PrismaClient | Tx, projectId: string): Promise<ProjectRepository[]>;
export class ProjectRepositoriesRepository {
  listByProject(projectId: string): Promise<ProjectRepository[]>;
  /** Stores what one machine's scan found. `created` are the repos new to the project; `duplicates` the extra checkouts of a repo already seen in this scan (spec §10). */
  upsertDiscovered(projectId: string, machineId: string, found: DiscoveredCheckoutInput[]): Promise<{ repositories: ProjectRepository[]; created: ProjectRepository[]; duplicates: DiscoveredCheckoutInput[] }>;
  /** Marks this machine's checkouts of the project that the scan did not return. Returns the repos newly marked. Never deletes. */
  markMissing(projectId: string, machineId: string, presentRepositoryIds: string[]): Promise<ProjectRepository[]>;
  effective(projectId: string, setup: ProjectSetupData): Promise<EffectiveRepo[]>;
}
```

Models: `ProjectRepository` (`@@unique([projectId, fullName])`, `@@unique([projectId, key])`, cascade on the
project) and `ProjectRepositoryCheckout` (`@@id([repositoryId, machineId])`, `@@index([machineId])`, cascade on
both). `status` is a `String` defaulting to `ok`, like `task_pull_requests.state`.

`upsertDiscovered` runs in one transaction that takes `lockProject` first, so two machines scanning at once
cannot give two repos the same key. It sorts `found` by `dir`, keeps the first checkout per name, creates a
row with `uniqueRepoKey(repoKeyFor(dir), keys in the project)` for a new name, updates `description` and
`status` of a known one (never `key`), and upserts the checkout with `seen_at = now`, `missing_at = null`.

`ProjectSetupRepository.save` becomes `withRepoMirror(withLegacyMirror(data), await loadProjectRepositories(db, projectId))`.

- [ ] **Step 1:** add the models; generate the SQL with
  `npx prisma migrate diff --from-schema <schema at HEAD> --to-schema prisma/schema.prisma --script` (run in
  `apps/server`), and save it under the migration folder with a header comment saying it is additive.
- [ ] **Step 2:** `npm run prisma:generate`.
- [ ] **Step 3: DB tests** (`describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')`, same fixture as
  `project-machines.db.test.ts`):
  - a first scan creates the repos with keys `main` (dir `.`) and the folder's slug, and reports them in `created`;
  - a second scan of the same folder creates nothing and refreshes `seen_at`;
  - a renamed folder keeps the key and updates `dir`; a second machine with another folder gets its own checkout row;
  - two folders that slug alike get `x` and `x-2`; the same repo twice in one scan uses the first by `dir`
    and reports the other in `duplicates`;
  - the name matches case-insensitively (`Acme/API` then `acme/api`: one row);
  - `markMissing` marks only this machine's absent checkouts, returns them once, and a later scan that sees
    the folder again clears `missing_at`;
  - `effective` with an empty table returns the `setup.repo` entry with key `main`;
  - `projectSetup.save` mirrors the first enabled repo into `repo` once rows exist, and leaves a setup with
    no rows and no overrides byte-for-byte as it was given;
  - deleting the project or the machine removes the rows.
- [ ] **Step 4:** `npm run typecheck -w @termhub/server` passes (the DB suite runs in CI).
- [ ] **Step 5:** commit `Data: project_repositories tables and repository`.

### Task 4: Setup route and `get_project_setup`

**Files:** modify `apps/server/src/routes/setup.ts`, `routes/setup.test.ts`, `control/integrations.ts`,
`control/integrations.test.ts`, `mcp/tools.ts`.

**Consumes:** `repos.projectRepositories.effective(projectId, setup)`.

- GET `/:id/setup` → `{ setup, effective_repos }`. PUT → the same, after the save.
- PUT keeps the stored `repos` when the body has no `repos` key, and the stored `repo_defaults` when it has no
  `repo_defaults` key (same reason as `automation`).
- PUT answers 400 `Integração do repositório inexistente` for a `repo_defaults.integration_id` or
  `repos[].integration_id` outside the scope.
- `getProjectSetup` returns `repos: EffectiveRepo[]`; the tool description says so.

- [ ] **Step 1: failing tests**: GET returns `effective_repos`; PUT with overrides saves them and returns the
  list; PUT without the keys keeps the stored ones; PUT with a foreign integration in an override is 400; PUT
  with an override above the project's level is 400; `getProjectSetup` returns the single `main` entry for a
  setup with only `repo`, and `[]` with none.
- [ ] **Step 2:** run `npm test -w @termhub/server -- src/routes/setup src/control/integrations` — fails.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** the full server suite, typecheck and `i18n:check` pass.
- [ ] **Step 5:** commit `Setup: effective repositories on the route and get_project_setup`.

## Known gap, closed by later cards

Until tasks 10–11 make the run path read the repo entry, every consumer still reads `setup.repo` with the
project-wide policy. So a repo that becomes the mirror runs at the project's level even if its override says
`pr`. It cannot happen through the product yet: the table is empty until discovery (task 6) and there is no
screen for overrides until task 5; only a hand-written PUT with `repos[]` reaches it.
