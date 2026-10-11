# Multi-repo automation — staged plan

> **For agentic workers:** each stage below is one card. Before you code a stage, write its detailed
> task-by-task plan (superpowers:writing-plans) at `docs/superpowers/plans/YYYY-MM-DD-multi-repo-<stage>.md`
> from this outline and the spec. The stages are ordered: do not start one before the stages it depends on
> are merged.

**Goal:** a project whose folder holds several git repositories gets automatic work on all of them.
Repositories are discovered by the machine agent, each has its own policy, a card can touch several of them
(one worktree, branch and PR per repo, merged as a group), and epics have one branch per repo.

**Spec:** `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md` (decisions P1–P4 from the
maintainer, R1–R19 taken there). Cite them in code comments (`// spec 2026-10-07 multi-repo R13`).

**Global constraints:** the same as the agentic board plan (`docs/superpowers/plans/2026-10-04-agentic-board.md`,
"Global Constraints"): additive migrations compatible with the previous colour, repositories only through
`db/repositories`, zod on every input, `scoped(...)`, `shellQuote`, agent RPCs with argv arrays, pt-BR UI copy
through `t()` with English catalog entries in the same PR, no terminal content in logs or events. Every stage
is harmless on its own. A project with one repository sees no change at any stage, and each PR says so in
**Impact on other users**.

## Why stages

The change touches setup, the agent (a new RPC and a new guard), the board, the concierge, the dispatcher,
the follower, the CI sync, the merge executor and the epics. Shipping it as one PR would put the hard-lock
guard and the merge executor in the same review as UI work. The stages below each ship something usable:

- After **E1–E4**, REA can run automatic cards that touch **one** repo each, on any of its repos.
- After **E5–E6**, cards spanning several repos work end to end, with linked PRs.
- After **E7**, epics have one branch per repo.

## Stages (proposed cards)

### E1 — Setup: repositories table and per-repo overrides

- Migration: `project_repositories`, `project_repository_checkouts` (spec §4). Repository
  `projectRepositories` with `listByProject`, `upsertDiscovered`, `markMissing`, `effective(projectId, setup)`
  (the union of R1, with each entry merged with its override and with `repo_defaults`, and autonomy clamped
  to the project's).
- `setup/schema.ts`: `repo_defaults`, `repos[]` (overrides), with validation (unique `full_name`, autonomy ≤
  project, globs). Mirror the first enabled repo into `repo` (R19). Tests: normalize from a v2 setup with only
  `repo`, mirror, clamp.
- Route and control: GET returns the effective list. PUT saves the overrides.
- Web Setup: "Repositórios" table (spec §9) fed by the effective list, without the scan button yet. The
  single-repo block stays when the list is empty.
- No behaviour change: nothing reads the table yet except Setup.
- Depends on: nothing.

### E2 — Discovery by the agent

- Protocol: `git.repos.scan` params and result, capability `repo_scan`.
- Agent: `apps/agent/src/rpc/repos.ts` (spec §5 step 2), with tests against temporary git repos (root repo,
  subfolders, hidden and `node_modules` skipped, worktree and submodule skipped, no `origin`, ssh and https
  URLs, description from `package.json` or `README.md`, home and `/` refused). Bump the agent minor
  (`apps/agent/package.json` + `src/version.ts`). This path asks for the `release` level, and CI publishes it.
- Server: `repos/discovery.ts`, which handles the triggers of R3 (agent connect, a 10-minute loop, Setup open
  with a throttle, on demand), the upsert, `missing_at`, the `status` check (`unsupported`, `no_access`) and
  the events `repo_discovered` / `repo_missing` with one chat line. The first scan of a project is one summary
  event.
- Web Setup: "Procurar agora", last scan time, presence per machine.
- Concierge tools: `list_project_repos`, `scan_project_repos`.
- Depends on: E1.

### E3 — Cards know their repositories

- Migration: `tasks.repo_keys text[] not null default '{}'`. Board repository read/write, keeping
  `lockProject` on structural writes (this is not one, but validate keys against the project).
- MCP `create_task` / `update_task`: `repos` (keys or `owner/repo`). `list_tasks` and tab `get_card` return
  them.
- Web board: chips, multi-select in the card form (only with more than one enabled repo). Mobile: chips,
  read-only.
- Concierge project prompt: the repo list with descriptions, and the inference rule (R9 a, spec §6).
- Queue: `repo_unknown`, `repo_missing`, `repo_disabled`, `repo_no_access`, `agent_no_repo_scan`. In a
  multi-repo project, a card is not eligible without repos.
- Dispatcher tick: wake the chat once per card without repos (R9 b), as a once-only event.
- Depends on: E1, E2.

### E4 — Single-repo runs on the card's repo

The first stage that changes automatic work. It covers cards with exactly one repo. A card with more than one
is not eligible yet ("vários repositórios: em breve"), until E5.

- Migration: `automation_run_repos`.
- Dispatcher `launch`: repo from the card, GitHub access per repo (`githubToken` → `githubAccess(repo)`),
  placement filtered on presence (R5), `ensureWorkspace` with `repoDir = join(link.cwd, dir)`. The worktree
  path stays `<root>/<pid>/<ref>` (one repo, today's layout). Also `cleanup.ts` and the disk-room check
  (`start.ts`) on the same `repoDir`.
- Follower `openPrOfRun` and `release.ts`: match by `(repo, head_ref)` (R14). This is a fix for single-repo
  projects too.
- CI sync: loop over active repos with an ETag per `(project, repo)` (R17). The scheduler lists projects with
  any repo.
- Merge executor and `policy.ts`: the PR's repo entry gives the base, the deploy workflow, required checks,
  globs and autonomy. "One delivery at a time" applies per repo base.
- `get_automation_policy` and the prompt's policy line, per repo (spec §9).
- Depends on: E1, E3.

### E5 — Runs across several repositories

- Guard v2 (`packages/machine-ops/src/guard-script.ts`): the `git -C <WORKTREE>/<key> push` forms (R13),
  with tests in `guard-script.test.ts`: allowed forms, `..` in the key, another branch, `-C` outside
  the workspace. Agent minor bump, and `GUARD_MIN_AGENT_VERSION` for multi-repo runs only.
- `gitRuleForms` per repo worktree. `startPermission` gets the workspace root.
- Workspace layout `<root>/<pid>/<ref>/<key>` for cards with more than one repo, one `ensureWorkspace` per
  repo, and the tab's cwd at the root.
- Tab tool `add_repo` (R12), added to `TAB_TOKEN_TOOLS`, with its checks and `run_repo_added`.
- `report_card` `pr_urls`. Done rule "every repo ahead of its base has an open PR" (R14, GitHub `compare`).
- Prompts: implementer, fixer, integrator with the repo lines (spec §7), inside the 4000-character budget,
  with tests on the length.
- Cleanup per repo, then the workspace folder.
- Before shipping, check in a real automatic tab that `cd <key>` in its own call needs no approval, and that
  the push from there passes the guard. Record what you find as a lesson if it is not obvious.
- Depends on: E4.

### E6 — Linked PRs: group merge

- Merge executor: group by primary card, check the whole group, merge in `merge_order`, and wait for each
  deploy in between (R15). State goes in events and `deploy_state`, so a colour switch resumes the group.
- One approval card per group above the level (`chat-actions-view.ts` text lists the repos).
- Partial failure: stop and escalate with `group_merge_partial`.
- Feed and Progresso: the card's PRs shown together, each with its repo.
- Tests: two-colour claim on a group (the `merge.colours.db.test.ts` pattern), order, a wait on deploy, a red
  PR holding the group, partial failure.
- Depends on: E5.

### E7 — Epic branch per repository

- `ensureEpicBranch` per repo, lazily on the first child touching it (R16). `targetOf` per repo.
- `candidateOf` / `epicCandidate`: the epic branch is checked per repo.
- Integrator: one run with a workspace of every repo that has an epic branch. It opens or updates one epic PR
  per repo, merged as a group (E6).
- The integrator playbook stays termhub's. Other projects use the generic text or `prompts.integrator`.
- Depends on: E6.

### E8 — Mobile read-only view and polish

- Mobile Setup: the repo list, levels, presence (read-only). Mobile Progresso: repo chips and grouped PRs.
- Depends on: E3 (chips), E6 (groups).

## Rollout for REA

1. Until E4: REA keeps its link pointing at the frontend checkout, with `setup.repo` =
   `reactivandoio/hub-community-frontend` (current state).
2. After E4 (not before: until then a run uses the link's folder as the checkout, and the parent folder is
   not a repo): point REA's link at the parent folder, `/Users/pedrogoiania/projects/reactivando` on the
   maintainer's machine. Discovery lists the ten repos, all at `pr`. Disable `hubcommunity-ios` and
   `hub-community-agreements` if wanted (P4 says all; that is the maintainer's call in Setup).
3. Then raise the frontend to `merge` with its `ci.yml` as a required check and `deploy-prod.yml` as its
   deploy workflow. The repos without PR CI stay at `pr` (spec §11).
4. After E6: set `merge_order` (backend and eventando-manager 1, BFF 2, frontend and mobile 3).
