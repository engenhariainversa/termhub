# Multi-repo automation — implementation plan

> **For agentic workers:** each task below is one card and one PR. Before coding a task, write its
> task-by-task plan (superpowers:writing-plans) at `docs/superpowers/plans/YYYY-MM-DD-multi-repo-<slug>.md`
> from this outline and the spec, and commit it in the same PR. Do not start a task before the tasks it
> depends on are merged.

**Goal:** a project whose folder holds several git repositories gets automatic work on all of them.
The machine agent discovers the repositories, and each one has its own policy. A card can touch several
repositories, with one worktree, branch and PR per repo, merged as a group. Epics get one branch per repo.

**Architecture:** discovered repos live in `project_repositories` (plus `project_repository_checkouts`, one
row per repo per machine). The setup keeps only per-repo overrides keyed by `owner/repo`. A card lists its
repos in `tasks.repo_keys`, and a run keeps one row per repo in `automation_run_repos`. A multi-repo run
opens in a workspace folder with one worktree per repo and the same branch name in every repo, so the
hard-lock guard still allows one branch inside one folder. Every consumer of `setup.repo` reads the PR's
or card's repo entry instead.

**Tech stack:** TypeScript, Fastify, Prisma/PostgreSQL, zod, vitest (server, agent, protocol,
machine-ops); React + Vite (web); Expo / React Native, jest (app).

**Spec:** `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md` (revised 2026-10-12). Section 2
holds the decisions: P1–P4 from the maintainer, R1–R19 taken in the spec. §3.1 covers the migration of
single-repo projects, §4 the data model and §10 the edge cases. Cite the decision in code comments
(`// spec 2026-10-07 multi-repo R13`).

## Global constraints

- The rules of the agentic board plan (`docs/superpowers/plans/2026-10-04-agentic-board.md`, "Global
  Constraints") apply as written:
  - additive migrations, compatible with the previous colour;
  - repositories only through `db/repositories`, and zod on every input;
  - `scoped(...)` / `ctx.scoped`;
  - `shellQuote`, and agent RPCs with argv arrays;
  - `lockProject` for structural board writes;
  - no terminal content in logs or events;
  - server-typed messages start with `[termhub automático]`.
- **A project with one repository sees no change at any task.** Every task that touches the run path has a
  test showing that a single-repo project gets the same worktree path, prompt, allow list and guard
  (spec §3.1).
- UI copy goes through `t()` with pt-BR keys, with the `en` and `es` entries in the same PR, and
  `npm run i18n:check -w <app>` passes (CLAUDE.md).
- Agent changes bump `apps/agent/package.json` and `apps/agent/src/version.ts` together, to the next minor
  after the one on `main`. CI publishes. Never `npm publish`. Do not raise `MIN_AGENT_VERSION` (spec R18).
- App changes are JavaScript only: no native dependency, and no change to `app.json`, `app.config.js` or
  `expo.version`.
- Concierge prompt: do not add lines to `ORCHESTRATOR_PROMPT` or `chat/project-prompt.ts` without shortening
  another one. Guidance goes in tool descriptions (lesson `2026-10-07-concierge-prompt-at-protocol-cap.md`).
- Each PR has an **Impact on other users** section. Throwaway containers are named `th-<something>`.

### Running things

Run these from the worktree root on Node 22 (CLAUDE.md, "Verifying before pushing"):

```bash
th() { docker run --rm --name "th-multirepo-$$" -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c "$1"; }
th 'npm ci && npm run prisma:generate && npm run build:packages'   # once per worktree
th 'npm test -w @termhub/server -- src/automation'
th 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web'
th 'npm test -w @termhub/agent -- repos'
rm -rf .npm
```

## File structure

| Area | Files |
| --- | --- |
| Data | `apps/server/prisma/schema.prisma`, new migrations; `apps/server/src/db/repositories/project-repositories.ts` (new), `automation-run-repos.ts` (new), `tasks.ts`, `automation-runs.ts` |
| Setup | `apps/server/src/setup/schema.ts`, `apps/server/src/routes/setup.ts`, `apps/server/src/control/integrations.ts`, `apps/server/src/automation/setup-tools.ts` |
| Discovery | `packages/agent-protocol/src/rpc.ts` and `messages.ts`, `apps/agent/src/rpc/repos.ts` (new), `apps/agent/src/run.ts` (`CAPABILITIES`), `apps/server/src/repos/discovery.ts` (new) |
| Cards and concierge | `apps/server/src/mcp/tools.ts`, `apps/server/src/control/tasks.ts`, `apps/server/src/chat/project-prompt.ts`, `apps/server/src/chat/wake.ts`, `apps/server/src/setup/tickets-sync.ts`, `apps/server/src/automation/eligibility.ts`, `queue.ts` |
| Runs | `apps/server/src/automation/{dispatcher,placement,branches,start,cleanup,machine-room,prompts,permission,follower,card-tab}.ts`, `apps/server/src/control/automation-tools.ts`, `apps/server/src/mcp/tab-token.ts`, `packages/machine-ops/src/guard-script.ts` |
| CI, merge and release | `apps/server/src/ci/{sync,scheduler}.ts`, `apps/server/src/automation/{merge,release,policy,integrator}.ts`, `apps/server/src/db/repositories/chat-actions-view.ts` |
| Web | `apps/web/src/components/SetupForm.tsx`, `AutomationSetup.tsx`, the board card and card form, Progresso |
| App | the Setup and Progresso screens under `apps/mobile/src`, `packages/mobile-api` |

## Tasks

The order below is the dependency order. Tasks 1–4 are independent of each other and can run in parallel.

- After task 11, REA can run automatic cards that touch **one** repo each, on any of its repos.
- After task 14, cards that span several repos work end to end, with linked PRs.
- After task 15, epics get one branch per repo.

### Task 1: Setup — repository tables and per-repo overrides (server)

- Migration: `project_repositories` and `project_repository_checkouts` (spec §4), additive.
- Repository `projectRepositories`:
  - `listByProject`, `upsertDiscovered`, `markMissing`;
  - `effective(projectId, setup)`: the R1 union, each entry merged with its override and with `repo_defaults`,
    autonomy clamped to the project's (R7), and `setup.repo` as the single entry, key `main`, when the
    table is empty (R19);
  - `setup.repo`'s fields read as the matching repo's override (§3.1 step 2).
- `setup/schema.ts`: `repo_defaults` and `repos[]` (overrides, max 50), validated: unique `full_name`,
  autonomy ≤ project, globs. `normalizeSetup` fills defaults with no `SETUP_VERSION` bump. On save, mirror the
  first enabled repo (lowest `merge_order`) into `repo` (R19).
- Route `routes/setup.ts` GET returns `effective_repos`. PUT accepts the overrides. `get_project_setup`
  returns the effective list.
- Tests: normalize a v2 setup with only `repo`; the effective list of an empty table; the mirror; the clamp;
  an override for a repo that discovery has not seen.
- Acceptance: nothing outside Setup reads the table. Existing setups load and save unchanged.

### Task 2: Agent — `git.repos.scan` RPC (capability `repo_scan`)

- Protocol: params `{ dir, depth }` and result `{ repos: [{ dir, origin, default_branch, has_commits,
  description }] }` in `packages/agent-protocol`. Add `CAPABILITY_REPO_SCAN` and `REPO_SCAN_MIN_AGENT_VERSION`.
- Agent `apps/agent/src/rpc/repos.ts` (spec §5 step 2):
  - walk with `readdir`, never a shell, depth 1..3;
  - skip hidden folders and `node_modules`, and do not descend into a checkout;
  - skip a git worktree or submodule (a `.git` file);
  - refuse `/` and the home folder;
  - run `git` with an argv array and the quick timeout;
  - read at most 4 KiB of `package.json` or `README.md` for the description, kept to 200 characters.
- Register it in `rpc/index.ts` and add the capability to `CAPABILITIES` in `run.ts`. Bump the agent minor.
- Tests, against temporary repos:
  - a repo at the root, and repos in subfolders;
  - hidden folders, `node_modules`, worktrees and submodules skipped;
  - a checkout with no `origin`;
  - ssh and https `origin` URLs;
  - descriptions from `package.json` and from `README.md`;
  - `/` and the home folder refused.
- Acceptance: CI publishes the new agent. Nothing calls the RPC yet.

### Task 3: Automation — match a run's PR by repository and branch

- `follower.ts` `openPrOfRun`, `release.ts` `runBranchOf` / `deliveryRow`,
  `automationRuns.branchesOfTask`, and `merge.ts` `candidateOf` all match on `(repo, head_ref)`. The repo
  is the project's single repo for now (`setup.repo.full_name`). This covers the D17 fallback,
  `adoptBlockedRuns` (TER-1049), `report_card` from a blocked tab (TER-1050), `holdForBudget` and the
  parked-run path (spec R14).
- Tests: a card linked to two PRs with the same `head_ref` in two repos adopts only the one in the project's
  repo. The existing follower, release and adoption tests pass.
- Acceptance: a fix that stands alone. Single-repo behaviour is unchanged, except that a PR from another
  repo with the same branch name is no longer taken as the run's.

### Task 4: Guard v2 and allow-list forms for repo subfolders

- `packages/machine-ops/src/guard-script.ts`: accept `git -C <WORKTREE>/<key> push …` in the four plain
  push forms, only for a `<key>` that matches the key charset (no `/`, no `..`), and only to `BRANCH`
  (spec R13). Mark it as guard version 2.
- `apps/server/src/control/automation-tools.ts`: `gitRuleForms` / `runBranchRules` take an optional list of
  repo keys and emit the `-C <workspace>/<key>` forms by exact path. Without keys the output is identical to
  today's.
- Add `MULTI_REPO_GUARD_MIN_AGENT_VERSION` next to `GUARD_MIN_AGENT_VERSION` (`terminal/tab-mcp.ts`). Bump
  the agent minor.
- Tests in `guard-script.test.ts`:
  - allowed forms;
  - `..` in the key, and a key with `/`;
  - another branch;
  - `-C` outside the workspace;
  - `-C` on the workspace root itself.
  - `automation-tools` tests: the single-repo output is unchanged, and the multi-repo forms are exact.
- Acceptance: no run uses the keys yet, so this is inert.

### Task 5: Web Setup — "Repositórios" table

- `apps/web/src/components/SetupForm.tsx` (the "Repositório" card), fed by `effective_repos`.
- Above the table: the default integration and the scan depth.
- Columns: key, `owner/repo`, folder per machine (or "ausente"), status, base, level, deploy, merge order,
  and an on/off switch.
- Each row expands into the per-repo policy fields (spec §9). Full width, no `max-w-*`.
- The old single-repo block stays when the list holds only the `main` entry from `setup.repo`.
- i18n in pt-BR, `en` and `es`. Add the folder to `GUARDED` in `apps/web/scripts/i18n-check.mjs` once its
  copy is translated.
- Acceptance: a single-repo project sees the same Setup. Overrides save and reload.

### Task 6: Server — repository discovery

- `apps/server/src/repos/discovery.ts`, with the triggers of R3:
  - agent connect;
  - a 10-minute loop over projects with automation on or with more than one repo;
  - Setup open, throttled to one scan per project and machine per minute;
  - on demand.
- Each scan does three things:
  - Upsert through `projectRepositories`.
  - Set `missing_at` on checkouts that are gone.
  - Set the `status` check: `unsupported` for a non-GitHub `origin`, and `no_access` through
    `GET /repos/{full_name}` with the integration's token.
- Events `repo_discovered` and `repo_missing`, and one chat line per new repo: "Novo repositório na pasta do
  projeto: owner/repo (nível pr)." The first scan of a project records one summary event.
- Every discovered repo except the one in `setup.repo` starts at autonomy `pr` (R6, §3.1). An instance-level
  throttle map makes two colours scanning at once harmless (the upsert is idempotent).
- Machines without `repo_scan` are skipped.
- Concierge tools `list_project_repos` (key, owner/repo, description, level, machines) and
  `scan_project_repos`. The "when to call" guidance goes in their descriptions.
- Web Setup: "Procurar agora", the time of the last scan, and presence per machine.
- Tests: a fake agent with one repo (single-repo project, key `main`, no event noise); ten repos; a repo
  that disappears; a repo renamed to another folder; an `origin` that is not GitHub.
- Acceptance: discovery only adds rows. No automatic behaviour changes.

### Task 7: Cards — `repo_keys`

- Migration: `tasks.repo_keys text[] not null default '{}'`.
- The task repository reads and writes it, validating keys against the project's effective list. The cap is
  10 per card.
- MCP `create_task` / `update_task` (`mcp/tools.ts`, `control/tasks.ts`) take `repos: string[]`, as keys or
  `owner/repo`. Their descriptions carry the inference rule (spec §6). `list_tasks` and the tab tool
  `get_card` return the keys.
- Ticket sync (`setup/tickets-sync.ts`): a card imported from a GitHub source whose `owner/repo` is a project
  repo gets that key.
- Tests: validation; the `owner/repo` → key conversion; ticket sync; an empty list in a single-repo project.
- Acceptance: nothing reads `repo_keys` for eligibility yet.

### Task 8: Board — repository chips and selection (web and app)

- Web board card: one chip per key. The card form gets a multi-select of enabled repos, shown only when the
  project has more than one.
- App: chips, read-only, through `packages/mobile-api` (JavaScript only).
- i18n in pt-BR, `en` and `es`.
- Acceptance: a single-repo project's cards look the same.

### Task 9: Concierge and queue — infer, ask and wait for a card's repositories

- Queue (`eligibility.ts`, `queue.ts`):
  - In a multi-repo project, a card with empty `repo_keys` is not eligible (`repo_unknown`).
  - New reasons: `repo_not_on_machine`, `repo_disabled`, `repo_no_access`, `agent_no_repo_scan`.
  - A card with more than one repo is not eligible yet: `repo_multi_soon` ("vários repositórios: em breve"),
    removed in task 12.
  - `repo_ready` means "every repo of the card is ready". The existing `repo_missing` keeps its meaning.
- Dispatcher tick: wake the project's chat once per card without repos (R9 b). Use an `automation_events`
  row of kind `repo_unknown`, with a once-only unique index like `ci_fix_once`, under the `chat/wake.ts`
  hourly cap.
- Project prompt: one line, only for a project with several repos ("projeto com N repositórios: veja
  list_project_repos"), and another line shortened. `concierge-prompt.test.ts` must still fit the 8000 cap.
- Queue items show repo chips on the web Progresso page.
- Tests: the reasons; the once-only wake across two colours; the prompt cap.
- Acceptance: single-repo projects get no new reason and no wake.

### Task 10: Automation — per-repo GitHub access, CI sync, merge and release policy

- `githubAccess` (`merge.ts`) takes the repo entry, and the integration comes from the entry.
- CI sync (`ci/sync.ts`, `ci/scheduler.ts`) loops over enabled repos with an ETag per `(project, repo)`. It
  lists a repo only when the repo has an active run, an eligible card or an open linked PR (R17).
  `projectSetup.listWithRepo` becomes "projects with any repo".
- `policy.ts` `requiredLevel`, `merge.ts` (`baseState`, base branch, required checks, globs, autonomy) and
  `release.ts` (deploy workflow, deploy retry) read the PR's repo entry. "One delivery at a time" applies
  per repo base branch.
- `get_automation_policy` and `policyText` list the repos and their levels. The prompt's clip keeps the
  run's repos within `POLICY_MAX` (660).
- Each PR, merge, deploy and release event payload gets a `repo` field.
- Tests: two repos with different levels; a red PR in repo A that does not hold repo B's base; the ETag per
  repo; inactive repos skipped; a single-repo project unchanged.
- Acceptance: existing merge and release tests pass unchanged.

### Task 11: Automation — single-repo runs on the card's repository

- Migration: `automation_run_repos` (spec §4).
- Dispatcher `launch`:
  - takes the repo from `repo_keys`, or the single repo;
  - places through `placement.ts` only on machines whose checkout of that repo is present (R5);
  - creates the worktree with `ensureWorkspace` and `repoDir = join(link.cwd, checkout.dir)`;
  - writes one `automation_run_repos` row.
- The worktree path stays `<root>/<pid>/<ref>`.
- `cleanup.ts` (cancelled runs included) and `start.ts` / `machine-room.ts` use the same `repoDir`.
- `branches.ts` `targetOf` / `ensureEpicBranch` work on the card's repo (one repo per epic for now).
- The prompt names the repo (`owner/repo`, base).
- Tests: two machines with different layouts; a missing checkout; a single-repo project with byte-for-byte
  the same worktree path, prompt and allow list.
- Acceptance: after this task, REA can point its link at the parent folder (plan "Rollout").

### Task 12: Automation — multi-repo workspace runs

- Lift `repo_multi_soon`. For a card with several repos:
  - the workspace `<root>/<pid>/<ref>/`, with one `ensureWorkspace` per repo at `<ref>/<key>`;
  - the same branch name everywhere (R11);
  - the tab's cwd at the root;
  - the guard and allow list from task 4 with the repo keys (requires `MULTI_REPO_GUARD_MIN_AGENT_VERSION`
    in placement).
- Prompts (implementer, fixer, integrator):
  - repo lines, which take the room of the description excerpt first;
  - the multi-repo `SHELL_LINE` (spec R13);
  - "one PR per repo with changes";
  - within `PROMPT_MAX_CHARS`, with length tests.
- Disk room multiplied by the repo count. Cleanup removes each worktree, then the empty workspace.
- Fixer takeover (`takeOverTab`, TER-1051) copies the run's `automation_run_repos`. A fixer that needs a
  repo the old run lacked starts a new tab.
- Before shipping, check in a real automatic tab that `cd <key>` and `git -C <key> push` pass without
  approval. Write a lesson if anything is not obvious.
- Acceptance: a single-repo project keeps its layout. A two-repo card gets two worktrees and one guard.

### Task 13: Automation — multi-repo done rule and `add_repo`

- `report_card` takes `pr_urls`. The done rule (R14): every repo whose branch is ahead of its base (GitHub
  `compare`) has an open PR from it. The same rule applies to the D17 fallback, `adoptBlockedRuns` and
  `report_card` from a blocked tab.
- `automation_run_repos.state` moves through `ready` → `pr_open` / `no_changes`.
- Tab tool `add_repo { key }` (R12), in `TAB_TOKEN_TOOLS` and `RUN_ONLY_TOOLS`. It checks that the key is
  enabled and present on the run's machine. It then:
  - creates the worktree;
  - adds the row;
  - appends the key to `repo_keys`;
  - records `run_repo_added`.
- Tests: two repos with one PR missing (not done); a repo with no commits ahead (done); adoption with two
  PRs; `add_repo` refusals.
- Acceptance: a two-repo card ends done only with both PRs open.

### Task 14: Automation — group merge of a card's PRs

- Merge executor (R15):
  - groups candidate PRs by primary card (or epic);
  - merges only when the whole group is green, mergeable and within each repo's level;
  - merges in `merge_order`, with equal orders in key order;
  - waits for each repo's deploy before merging the next.
- State lives in `group_merge_waiting` events plus `deploy_state`, so a colour switch resumes the group.
- One approval card per group above the level (`chat-actions-view.ts` lists the repos). A partial failure
  stops the group and escalates with `group_merge_partial`, with no revert.
- Feed and Progresso show a card's PRs together, each with its repo.
- Tests: a two-colour claim on a group (the `merge.colours.db.test.ts` pattern); order; a wait on a deploy;
  a red PR holding the group; a partial failure.
- Acceptance: single-PR cards merge exactly as before.

### Task 15: Automation — epic branch per repository

- `ensureEpicBranch` per repo, created lazily on the first child that touches the repo (R16). `targetOf` is
  per repo, and `candidateOf` / `epicCandidate` check the epic branch per repo.
- Integrator: one run whose workspace holds every repo with an epic branch. It opens or updates one epic PR
  per repo, merged as a group (task 14). The termhub playbook stays termhub's; other projects use the generic
  text or `prompts.integrator`.
- Tests: an epic whose children touch two repos; a repo touched by no child (no epic branch); the integrator
  workspace.
- Acceptance: single-repo epics behave as before.

### Task 16: App — repositories in Setup and grouped PRs in Progresso (read-only)

- App Setup: the repo list, levels and presence, read-only. App Progresso: repo chips and a card's PRs
  grouped. JavaScript only, through `packages/mobile-api`.
- Acceptance: a single-repo project's screens look the same. The OTA guard publishes it (no `expo.version`
  change).

## Dependencies

| Task | Depends on |
| --- | --- |
| 1, 2, 3, 4 | none |
| 5 | 1 |
| 6 | 1, 2 |
| 7 | 1 |
| 8 | 7 |
| 9 | 6, 7 |
| 10 | 1, 3 |
| 11 | 6, 7, 9, 10 |
| 12 | 4, 11 |
| 13 | 12 |
| 14 | 13 |
| 15 | 14 |
| 16 | 8, 14 |

## Rollout for REA

1. Until task 11, REA keeps its link pointing at the frontend checkout, with `setup.repo` set to
   `reactivandoio/hub-community-frontend`.
2. After task 11, and not before (until then a run uses the link's folder as the checkout, and the parent
   folder is not a repo):
   - Point REA's link at the parent folder on the maintainer's machine. Discovery lists the ten repos. The
     frontend keeps its level, and the others start at `pr`.
   - Disable `hubcommunity-ios` and `hub-community-agreements` if wanted. P4 says all repos, so that is the
     maintainer's call in Setup.
3. Raise the frontend to `merge`, with its `ci.yml` as a required check and `deploy-prod.yml` as its deploy
   workflow. The repos with no PR CI stay at `pr` (spec §11).
4. After task 14, set `merge_order`:
   - 1: backend and eventando-manager;
   - 2: BFF;
   - 3: frontend and mobile.
