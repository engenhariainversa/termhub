# Spike: automatic mode for a project with several repositories (TER-1034)

Written on 2026-10-07 against the code at `c6ed07b2`. A research document: no code changes. It asks
whether the automatic mode of the agentic board
(`docs/superpowers/specs/2026-10-04-agentic-board-design.md`, "the board spec") can run a project made
of several git repositories, using reactivando as the real case, and recommends a shape and a card
breakdown.

Source note: the card description of TER-1034 could not be read from the tab that wrote this (the tab
tools have no card reader and the card was not yet in memory). The scope below comes from the task
brief: "spike: automatic mode for a project with several repositories, the reactivando case". Check
it against the card before acting on the cards in section 8.

## 1. Summary

- Automatic mode today assumes **one repository per project**. `setup.repo` is one object, and every
  automatic run has one worktree, one branch and one `guard.json`. CI sync and the merge executor watch
  only `repo.full_name`. Only the PR link table (`task_pull_requests`, unique on
  `(task_id, repo, number)`) already handles several repos.
- reactivando is **10 independent GitHub repositories** under one parent folder, with no monorepo
  tooling. The ones that matter ship separately, each deploying on its own push to `main` (section 2).
- **Recommendation (option B): one repository per card.** The project keeps a list of repositories,
  and each card targets exactly one of them. A run stays single-repo, so the worktree, the guard, the
  branch, the PR, CI, the merge and the deploy keep working as they do now, keyed by the card's repo.
  A change that spans repos becomes an epic with one card per repo, plus a **"depends on"** link so
  the BFF card waits for the backend card to be delivered.
- Runs that edit several repos at once (option C) are not recommended now. They multiply every
  safety mechanism the TER-900 spike just added, and reactivando does not need them (section 5).
- Single-repo projects see no change: `repos` holds one entry with `dir: "."`, and the previous
  release's `repo` field stays mirrored (the same pattern as `tickets` / `ticket_sources[0]`).

## 2. The reactivando case (inspected read-only)

The parent folder `/Users/pedrogoiania/projects/reactivando` is **not** a git repository. It holds a
`.claude/` folder and ten checkouts, all under the GitHub organisation `reactivandoio`:

| Folder | Stack | Default branch | PR CI | Deploy |
| --- | --- | --- | --- | --- |
| `hub-community-frontend` | Next 16, pnpm | `main` | `ci.yml` (tests + build on PRs into `main`) | `deploy-prod.yml`: push to `main` → SSH `make update` |
| `hub-community-bff` | Express + Apollo GraphQL | `main` | none | `deploy-prod.yml`: push to `main` → SSH `make update` |
| `hub-community-backend` | Strapi 5 | `main` | none | `deploy-prod.yml`: push to `main` → SSH `make update` |
| `eventando-manager` | Strapi 4 (the BFF calls it over REST) | `main` | none | none in the repo |
| `hub-community-mobile` | Expo 57 | `main` | none | none (store/EAS) |
| `startupweekendsummit` | Next 16 | `main` | none | `deploy.yml`: self-hosted runner on jarvis, `docker compose` |
| `eventando-landing` | Next 14 | `main` (checkout on `feat/sw-landing`) | none | AWS Amplify (`amplify.yml`) |
| `reactivando-landing-page` | Next 16 | `main` | none | none in the repo |
| `hubcommunity-ios` | Xcode | `main` | none | none; last commit 2025-07 |
| `hub-community-agreements` | — | `main`, **no commits** | — | — |

What matters for the design:

1. **The repos are independent products with one cross-repo chain**: frontend and mobile → BFF
   (GraphQL) → backend + eventando-manager. A feature like "new field on the event page" usually
   touches backend, then BFF, then frontend, and each ships separately, on merge to its own `main`.
   Merge order matters (the BFF needs the backend change deployed first), but nothing needs one
   atomic commit across repos.
2. **Only the frontend has PR CI.** Under spike R1 (`required_checks`, where `none` is never green),
   only the frontend can go past autonomy `pr`. The others stay at `pr` until they get a CI workflow.
   That workflow is reactivando's own work, not termhub's.
3. **The repos assume they are siblings.** `hub-community-frontend/docker-compose.hub.yml` builds
   `../hub-community-backend`, `../eventando-manager` and `../hub-community-bff`. An automatic tab
   cannot run docker (fixed deny list, R5), so this does not break automatic runs. It does mean that
   a worktree is not a working local stack, and the implementer prompt must not promise one (section 6.4).
4. **Several repos carry their own `CLAUDE.md` / `AGENTS.md`.** A run whose cwd is the repo's own
   worktree reads them, which is what we want. A run rooted in the parent folder would not.
5. **One GitHub integration can serve every repo** (same organisation), as long as its token sees
   them all. termhub only uses the token when the integration's owner is the project's owner, which
   still holds.

## 3. What assumes one repository today

From the code at `c6ed07b2` (paths under `apps/server/src` unless noted):

- **Setup**: `repo` is a single nullable object (`setup/schema.ts:13-23,154`), and eligibility is
  `repo.full_name && repo.integration_id` (`automation/queue.ts:88`, `automation/eligibility.ts:92`).
- **GitHub access**: the token and the repo come from `setup.repo` alone (`automation/dispatcher.ts:172-178`,
  `automation/merge.ts:91-97`, `ci/sync.ts:80-88`).
- **Machine folder**: the worktree's source checkout is `ProjectMachine.cwd`, one per (project,
  machine) (`dispatcher.ts:304`, `automation/cleanup.ts:130`, `automation/start.ts:64`). For
  reactivando that folder is the parent, which is not a repo, so `git -C <cwd> worktree add` fails.
- **Run**: `automation_runs` has one `branch` and one `worktree_path`, and at most one active run per
  card. The worktree path is `<worktrees_dir>/<projectId>/<ref>` (`automation/branches.ts:97`).
- **Guard**: `buildGuardSettings(branch, worktree)` (`packages/machine-ops/src/guard-script.ts:211`)
  allows push to one branch and writes / `rm -r` inside one worktree. `branchPushRules` and
  `startPermission` use the same single branch.
- **Prompts** name one branch and one base, and tell the agent its cwd is the worktree
  (`automation/prompts.ts:32-110`). The integrator playbook is termhub-specific (Prisma migrations).
- **Follower**: a run is done when an open PR has `head_ref === run.branch`, with no repo dimension
  (`automation/follower.ts:318`). `release.ts:106-113` matches the same way.
- **CI sync**: one repo, one ETag per project (`ci/sync.ts:98-107`).
- **Merge executor**: it watches `access.repo` only (`merge.ts:236`). `requiredLevel` compares
  against one `base_branch` / `deploy_workflow`, and `release_paths` / `store_paths` are globs from
  one repo root (`automation/policy.ts:17-60`).
- **Epic**: one epic branch created in one repo (`branches.ts:79-84`), with one epic PR and one
  integrator (`automation/integrator.ts`).

Already able to handle several repos: `task_pull_requests`, the merge key (`merge.ts:62`, which
includes the repo) and `ticket_sources`.

## 4. Options

### A. One termhub project per repository (works today)

Create `hub-community-frontend`, `hub-community-bff`, … as separate termhub projects, each linked to
its folder.

- Pros: zero code. Every safety mechanism applies unchanged.
- Cons: ten boards for one product. A feature that crosses repos is split across projects with no
  link between its cards, the epic can't hold them, and the chat has to know which project to file a
  card in. Budgets, accounts and the daily summary are counted per repo instead of per product.
- Verdict: acceptable as a stopgap; it is what the maintainer can do this week. It is not the answer
  the card asks for.

### B. One project, several repositories, one repository per card (recommended)

The project lists its repositories, and each card says which one it changes. A run is exactly
today's run, aimed at the card's repo.

- Pros: one board, one epic for the cross-repo feature, one budget. Runs, guard, merge and deploy
  keep their single-repo invariants, so the TER-900 safety analysis still holds per run. The change
  is mostly "look up the repo from the card instead of from the project".
- Cons: a cross-repo change becomes several cards, which needs a dependency link (it does not exist
  yet) so they ship in order. Someone, either a person or the chat when it files cards, must pick the
  repo for each card.

### C. One project, one run may span several repositories

A run gets a workspace with one worktree per touched repo, one branch per repo, a guard that allows
all of them, and one PR per repo, merged together.

- Pros: one card per feature, and the agent sees the whole change at once.
- Cons: every invariant goes plural: the guard (N branches, N worktrees), the follower (when is a
  run "done": all PRs open?), the merge executor (all-or-nothing across repos, with no atomic merge
  on GitHub), the rollback (deploys happen per repo), and the fixer runs (which PR is red?). It also
  breaks "one active run per card", the cleanup and the budget estimate. reactivando's repos deploy
  independently anyway, so the "together" merge buys nothing there.
- Verdict: not now. Section 5 names what would make it worth revisiting.

## 5. Why not C, and when to revisit

C pays off only when changes **must** land atomically across repos, for example a shared schema
package consumed by version pinning, or a coordinated release. Each reactivando repo ships on its
own merge to `main`, so a cross-repo change is already a sequence of separate deploys. B models that
sequence honestly: one card, one PR, one deploy per repo, in dependency order.

Revisit C if a project shows up where (a) most cards touch 2+ repos, or (b) the repos release
together. Even then, the first step is probably a read-only multi-repo view for the agent (siblings
mounted read-only), not multi-repo writes.

## 6. Design sketch for option B

This is a direction for the plan, not a final spec.

### 6.1 Setup: `repos[]`

- `setup.repos`: an array of up to 20 entries. Each entry is today's `repoSchema` plus:
  - `key`: a short slug, unique in the project (`frontend`, `bff`). It is shown on the card chip
    and used in the worktree path.
  - `dir`: a path **relative to the machine link's `ProjectMachine.cwd`** (`hub-community-frontend`;
    `.` for a single-repo project). It is resolved on the agent, which checks that it is a git repo
    (the same RPC `git.worktree.ensure` already runs).
  - Optional per-repo overrides of the automation policy: `autonomy`, `required_checks`,
    `release_workflows`, `release_paths`, `store_paths`. The project values are the ceiling. For
    `autonomy`, a repo can only lower it. A PR with no CI run (`ci_state = none`) is still never green
    (R1).
- Migration and backward compatibility follow `tickets` / `ticket_sources`: the read path builds
  `repos = [ { key: 'main', dir: '.', ...repo } ]` when `repos` is empty. The write path mirrors
  `repos[0]` into `repo` for one release, so the previous container (blue/green) keeps working.
  No database migration is needed, because setup is JSON.
- Eligibility becomes "the card's repo exists in `repos` and has `full_name` and `integration_id`".

### 6.2 Card: which repo

- A new nullable column, `tasks.repo_key`. With exactly one repo in `repos`, null means that repo.
  With several, a card with no `repo_key` is **not eligible**: the queue shows "escolha o
  repositório" instead of guessing.
- Set by: the card form (a select with the project's repos), the chat / MCP `create_task` and
  `update_task` (a `repo` argument, validated against `repos`), and ticket sync when a GitHub ticket
  source's `owner/repo` matches an entry.
- Epics have no repo. Their children can target different repos.

### 6.3 Dependencies between cards

- A new table `task_dependencies (task_id, depends_on_id)`, within one project, with no cycles
  (checked under `lockProject`).
- The dispatcher does not start a card while one of its dependencies is not **delivered**, meaning
  it reached the delivery level its repo allows. At autonomy `pr`, "delivered" means "PR merged by a
  person". Dependencies help single-repo projects too. In a multi-repo project they become the main
  way to order work.

### 6.4 Run, worktree, guard

- The worktree path becomes `<worktrees_dir>/<projectId>/<repo_key>/<ref>`. Two cards in two repos
  never share a path, even with the same ref pattern.
- `ensureWorkspace` gets `repoDir = join(link.cwd, repo.dir)`. `cleanup.ts` and the disk-room check
  use the same path.
- `automation_runs` gets `repo_key`. The run's branch, worktree and guard stay single-valued, and
  `guard.json` does not change.
- The follower and `release.ts` match a PR by `(repo, head_ref)`, not by `head_ref` alone. This
  closes a real gap: two repos can each have a branch named `TER-12-x`.
- The prompt names the repo (`owner/repo`) the agent works in. The implementer prompt must not
  suggest running the cross-repo local stack, since docker is denied anyway.
- The integrator playbook (Prisma migrations) stays termhub's. Other projects use the generic
  integrator, or a custom prompt through `prompts.integrator`, which already exists.

### 6.5 CI sync and merge executor

- `syncProjectCi` loops over `repos`, with one ETag per `(project, repo)`. To stay within the
  GitHub rate limit, it only lists a repo that has eligible cards, active runs or open linked PRs.
  A ten-repo project where two repos are active costs two calls per tick, not ten.
- The merge executor reads the PR's repo entry for `base_branch`, `deploy_workflow`,
  `required_checks` and the globs. The one-delivery-at-a-time rule (R1) applies **per repo base
  branch**, since each repo's `main` is a different base.

### 6.6 Epics across repos

- The epic branch is created **per repo, lazily**: the first child card of repo X creates
  `epic/{ref}-{slug}` in X. Each repo then gets its own epic PR and its own integrator run, opened
  when that repo's children are done.
- Recommended default for multi-repo projects: an epic whose children span more than one repo
  delivers its children **straight to each repo's base branch**, ordered by dependencies, with no
  epic branches. A cross-repo epic branch is a fork of the product per repo, and keeping several in
  sync is exactly the coordination C was rejected for. Whether to keep epic branches per repo as
  an opt-in is an open question for the maintainer (section 9).

### 6.7 What the policy text says

`get_automation_policy` gains the repo dimension: it lists the repos with their level ("frontend:
merge; bff, backend: pr, sem CI no PR"). From a run's tab, it names the run's own repo first.
Strings follow the i18n rule (pt-BR keys through `t()`, English in the catalog).

## 7. Impact on other users

- **Projects with one repo (everyone today)**: no change. `repos` is derived from `repo`, cards need
  no repo, and paths and prompts are the same. The one visible change is the worktree path gaining a
  `<repo_key>` segment for **new** runs only. Runs in flight keep `worktree_path` as stored.
- **Multi-repo** is opt-in per project: it exists only when someone adds a second repository in the
  project setup.
- **Card dependencies** are opt-in per card. Nobody gets a dependency they did not add.
- Nothing here is specific to the maintainer's machines. `dir` is relative to whatever folder the
  machine link points at.

## 8. Proposed cards (to create in the board)

The cards were not created from this tab, which has no card-writing tool. Proposed order:

1. **Setup: `repos[]` com espelho em `repo`** — schema, read compatibility, mirror for one release,
   project setup UI (web and mobile) with `key` / `dir` / policy overrides, and an agent check that
   `dir` is a git repo.
2. **Card: repositório alvo (`repo_key`)** — column, form select, MCP `create_task` / `update_task`
   argument, chip on the card, eligibility "escolha o repositório".
3. **Automação: run por repositório** — `automation_runs.repo_key`, worktree path, `ensureWorkspace` /
   cleanup / disk room on `join(link.cwd, dir)`, follower and release matching by `(repo, head_ref)`,
   prompt names the repo. Depends on 1 and 2.
4. **CI e merge por repositório** — sync loop with per-repo ETag and only active repos, merge executor
   reading the repo's entry, one delivery at a time per repo base. Depends on 3.
5. **Dependências entre cards** — table, cycle check under `lockProject`, dispatcher waits for
   delivery, UI to add and remove them. Independent of 1–4, useful on its own.
6. **Épico multi-repo** — direct delivery for cross-repo epics (6.6), plus per-repo epic branches if
   the maintainer wants them. Depends on 3 and 4.
7. **Política por repositório no `get_automation_policy`**. Depends on 1.

Outside termhub (reactivando's own work, not a termhub card): add PR CI to `hub-community-bff` and
`hub-community-backend` before raising them above `pr`.

Until 1–4 ship, reactivando can use option A (one termhub project per active repo) at autonomy `pr`.

## 9. Open questions for the maintainer

1. Cross-repo epics: direct delivery only (recommended), or also per-repo epic branches as an opt-in?
2. Should a card ever be allowed to target **two** repos (a narrow C, for example a GraphQL schema
   change in BFF plus frontend), or is "split into dependent cards" enough?
3. Repo selection by the chat: may the concierge infer the repo from the card text and set it, or
   must it always ask when the project has more than one repo?
4. Which reactivando repos go into the project? Leaving `hubcommunity-ios` (dormant) and
   `hub-community-agreements` (empty) out is the obvious default.
