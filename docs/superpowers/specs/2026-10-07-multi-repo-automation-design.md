# Automatic work in projects with several repositories — design

Card TER-1033, written on 2026-10-07 against the code at `243b7d0b`. Server, machine agent, web and
(read-only, later) mobile. Additive migrations only.

This design follows the spike of TER-1034 (PR #443,
`docs/superpowers/specs/2026-10-07-multi-repo-automation-spike.md`). Its inventory of what assumes one
repository (spike §3) and its reading of the reactivando folder (spike §2) still hold and are not repeated
here. Its **recommendation does not**: the spike recommended "one repository per card" (option B) and left
four questions open. The maintainer answered them on 2026-10-08 in the reactivando chat, and the answers put
multi-repo runs (the spike's option C) in scope. Section 2.1 records those answers. Everything else in this
document is a decision taken here, with its reason.

## 1. Problem

A project's setup holds one GitHub repository (`setup.repo`, `apps/server/src/setup/schema.ts`), and every
piece of automatic work hangs off it:

- the dispatcher's GitHub token and the epic branch (`automation/dispatcher.ts` `githubToken`, `launch`);
- the worktree's source checkout, which is the machine link's folder, `project_machines.cwd`
  (`dispatcher.ts` `ensureWorkspace({ repoDir: place.link.cwd })`, `cleanup.ts`, `start.ts` disk check);
- the run's single `branch` and `worktree_path` (`automation_runs`), the hard-lock guard of the tab, which
  allows one branch and one worktree (`packages/machine-ops/src/guard-script.ts` `buildGuardSettings`),
  and the prompt, which names one branch and one base (`automation/prompts.ts`);
- the follower, which finds the run's PR by `head_ref` alone (`automation/follower.ts` `openPrOfRun`);
- the CI sync, which lists one repo with one ETag per project (`ci/sync.ts`), and the merge executor,
  which reads one base branch, one deploy workflow and one set of path globs (`automation/merge.ts`,
  `automation/policy.ts`, `automation/release.ts`);
- the epic branch, epic PR and integrator, all in that one repo (`automation/branches.ts`,
  `automation/integrator.ts`).

reactivando (REA) is ten repositories side by side in a folder that is not a git repository. With its
link's folder pointing at that parent folder, `git worktree add` fails ("não é um repositório git"); with
`setup.repo` set to `reactivandoio/hub-community-frontend`, automatic work can only ever reach the
frontend. Until this ships, REA points its link at the frontend checkout and its setup at that one repo.

What already handles several repositories and is reused: `task_pull_requests` (unique on
`(task_id, repo, number)`), the merge key, which includes the repo, and `ticket_sources`.

## 2. Decisions

### 2.1 Taken by the maintainer (2026-10-08, reactivando chat)

| # | Question (spike §9) | Answer |
| --- | --- | --- |
| P1 | Epic branches in a multi-repo project | Yes, **one epic branch per repository**. |
| P2 | May a card touch more than one repository? | Yes, **two or more**. The run gets one worktree, one branch and one PR per repository, all linked to the card. |
| P3 | Who picks the card's repositories? | The concierge **infers** them and **asks only when in doubt**. |
| P4 | Which repositories enter the project? | **All of them in the project folder**. A repository added to the folder later must be **found by termhub on its own**, by the machine agent looking in the project folder. |

### 2.2 Taken here

| # | Topic | Decision | Why |
| --- | --- | --- | --- |
| R1 | Where repositories come from | **Discovery** fills a table, `project_repositories`. The setup holds only the person's **overrides**, keyed by `owner/repo`. The effective list is the union: every discovered repo, plus any repo the person added by hand that discovery has not seen yet. | P4. Discovery is a background writer; the setup is saved last-write-wins (`projectSetup.save` is an upsert of the whole JSON). If discovery wrote into the setup, a person saving a form loaded before the scan would wipe the new repo. Two owners, two places. |
| R2 | How discovery finds repos | A new agent RPC `git.repos.scan { dir, depth }` lists the git checkouts under the project folder: the folder itself, and its subfolders to `depth` (default 1, max 3). It skips hidden folders and `node_modules`, and does not descend into a checkout. For each one it returns `dir` (relative), the `origin` URL, the default branch (`origin/HEAD`), and whether it has commits. | P4. The machine is the only place that sees the folder. Depth 1 covers REA and every layout seen so far. A deeper nesting is one setting away. |
| R3 | When discovery runs | When an agent connects; every 10 min for each project with automation on, or with more than one repo; when the Setup screen opens (throttled to one scan per project and machine per minute); and on demand ("Procurar agora" on the screen, plus a concierge tool). A **new** repo records a `repo_discovered` event and one chat line. A repo whose folder is gone is marked `missing` on that machine, never deleted. | P4 asks that a new folder be noticed without anyone saying so. Ten minutes keeps the cost to one `readdir` and a few `git` calls per project. Connecting and opening the screen catch the moments when a person is looking. |
| R4 | Identity of a repo | `owner/repo`, parsed from the `origin` URL (GitHub https or ssh forms). Each repo also gets a short **key**, unique in the project: the folder's base name, slugged (`hub-community-frontend`), or `main` for a checkout at the project folder itself. The key never changes once given. A checkout with no GitHub `origin` is listed as `unsupported` and never eligible. | The same repo can sit in different folders on two machines; `owner/repo` is what GitHub, the PRs and the CI sync speak. The key is for paths and chips. Keeping it stable keeps worktree paths stable. |
| R5 | Presence per machine | `project_repository_checkouts (repository_id, machine_id, dir, default_branch, seen_at, missing_at)`. Placement only picks a machine that has **every** repo the card needs (`missing_at` null). Otherwise the card waits with "repositório X não está em nenhuma máquina do projeto". | A project can be linked to several machines whose folders differ. "All repos on one machine" is what a multi-repo run needs. |
| R6 | A repo found by discovery starts safe | A discovered repo with no override gets: the project's GitHub integration (`repo_defaults.integration_id`), its own default branch as `base_branch`, **autonomy `pr`**, no deploy workflow, no required checks, no path globs. A person raises it in Setup. | No repo gets merge or deploy rights just by appearing in a folder. `pr` only opens a PR. The person who drops a repo into the folder did not ask for anything to ship. |
| R7 | Per-repo policy | Each repo entry may set `base_branch`, `branch_pattern`, `deploy_workflow`, `autonomy`, `required_checks`, `release_workflows`, `release_paths`, `store_paths`, `merge_order`, `enabled`. The project's `automation.autonomy` is a **ceiling**: a repo can only lower it. Globs are relative to the repo's root. `enabled: false` takes a repo out (it stays in the table, so it is not "rediscovered"). | Every REA repo deploys differently (spike §2). The ceiling keeps one project-wide brake. Excluding instead of deleting is what makes P4's "all of them" compatible with "except this dormant one". |
| R8 | Which repos a card touches | A new column `tasks.repo_keys text[] not null default '{}'`. In a project with one repo, an empty list means that repo, so nothing changes. In a project with several, an **empty list is not eligible**: the queue shows "sem repositório". | P2 makes the target a set. Never guessing silently at dispatch time keeps P3's "ask when in doubt" honest. |
| R9 | Who fills it (P3) | (a) The concierge, when it creates or edits a card (`create_task` / `update_task` gain `repos`), infers the keys from the card's text and the repo descriptions, and asks a question card only when it is in doubt. (b) A card left without repos in a multi-repo project, for example one made by hand on the board, **wakes the chat** once per card (`chat/wake.ts`, under the existing hourly cap) with "card X sem repositório", and the concierge decides or asks. (c) During a run, the agent may **add** a repo it found it needs, through a new tab tool `add_repo` (R12). | (a) and (b) are P3. (c) covers the doubt that only shows up in the code. The agent already reads the project folder (reads are not limited by the guard). |
| R10 | Repo descriptions for inference | Discovery also reads, per repo, the `description` from `package.json` (or the first heading of `README.md`), up to 200 characters, stored on the repository row. The concierge sees the list "key — owner/repo — description" in the project prompt. A person may override the description in Setup. | The concierge cannot tell `hub-community-bff` from `eventando-manager` by name alone. One short line per repo is enough to route a card. |
| R11 | Run layout | One run per card, as today: the "one active run per card" index stays. A multi-repo run's tab opens in a **workspace** folder, `<worktrees_dir>/<projectId>/<ref>/`, which holds one worktree per repo at `<ref>/<key>/`. The **same branch name** is used in every repo (`{ticket}-{slug}` from the project's pattern). A new table, `automation_run_repos (run_id, repository_id, branch, base, worktree_path, state)`, keeps one row per repo. A project with a single repo keeps today's layout, with the worktree at `<ref>/` and one row. | P2. One branch name means the guard still allows pushing to exactly one name, the CI sync links every PR to the card through `KEY-n` in the branch, and the agent has a single name to remember. The workspace root is the one folder the guard confines writes to (R13). |
| R12 | Adding a repo during a run | Tab tool `add_repo { key }`: the server checks that the key is in the project, enabled and present on the run's machine, creates the worktree (`git.worktree.ensure` with the repo's base or epic branch), adds the `automation_run_repos` row, and appends the key to `tasks.repo_keys`. It records `run_repo_added`. Removing a repo is not offered: a repo with no commits on the branch at the end gets no PR, and its worktree goes at cleanup. | Lets inference be corrected from inside the run without a person. Adding is safe: it creates a worktree under the run's own root. |
| R13 | Guard and allow list | The guard keeps one `BRANCH` and one `WORKTREE`. For a multi-repo run, `WORKTREE` is the **workspace root**, so writes and `rm -r` stay confined to the card's folder. The push rule also accepts `git -C <WORKTREE>/<key> push …` in its four plain forms. `gitRuleForms` emits the `git -C` forms for each repo's worktree. The prompt tells the agent that each repo is in `<key>/`, to `cd <key>` in its own call before running that repo's commands, and to push with `git push -u origin <branch>` from there. | The safety analysis of TER-993 and TER-968 holds unchanged, because still only one branch name can be pushed and only inside the card's folder. The only new surface is the `-C` form, which is also limited to subfolders of the workspace. This changes the guard script, so it needs a new agent version (R18). |
| R14 | When a run is done | `report_card` accepts `pr_urls` (a list) next to `pr_url`. The run is done when every repo of the run that has the branch on GitHub with commits ahead of its base has an open PR from it (`compare` in the GitHub API). A repo with no commits ahead gets no PR and is fine. The D17 fallback (stopped tab + linked PR) uses the same rule, matching PRs by `(repo, head_ref)` instead of `head_ref` alone. | P2 says one PR per repo. "Ahead of base" tells a repo that was only read from one the agent forgot to open. Matching by repo also closes a real gap that exists today: two repos can each have a `TER-12-x` branch. |
| R15 | Linked PRs and the merge | A card's PRs merge as a **group**. None is merged until every one of them is green, mergeable and within its repo's level. Then they merge one at a time in `merge_order` (lowest first; equal order merges in key order). The next one waits until the previous repo's deploy workflow has passed, when that repo has one. Above the level, one approval card covers the whole group. If a merge fails after an earlier one went in, the group stops and escalates; nothing is reverted automatically. | P2 says the PRs are linked. GitHub has no atomic merge across repos, so the honest version is "all ready, then in dependency order". REA's chain (backend → BFF → frontend, spike §2) is what `merge_order` encodes. Automatic revert is out of scope, as in board spec D22. |
| R16 | Epics (P1) | The epic branch is created **per repo, lazily**: when the first child card touching repo X starts, `epic/{ref}-{slug}` is created in X from X's base. Each repo with an epic branch gets its own epic PR. When every child of the epic is done, one integrator run opens a workspace with every repo that has an epic branch (the R11 layout, on the epic branch). The integrator's PRs then merge as a group (R15), like a card's. | P1, with the same "one active run per task" invariant. One integrator for all of an epic's repos avoids N integrator runs racing over one epic. |
| R17 | CI sync and rate limit | The sync loops over the project's enabled repos with one ETag per `(project, repo)`. It **lists** a repo's pulls only when that repo has an active run, an eligible card, or an open linked PR. Other repos cost nothing. | A ten-repo project with two active repos makes two list calls per tick, not ten. |
| R18 | Agent capabilities | Discovery needs `git.repos.scan`, and multi-repo runs need the new guard. Both ship in the next agent minor, as capability `repo_scan` and guard version 2. A machine without them keeps working for single-repo projects. For a multi-repo project, the queue says "Atualize o agente de X". | Same pattern as `worktree` (0.16.0) and the guard (0.19.0). |
| R19 | Backward compatibility | `setup.repo` stays and keeps working: in a project with no discovered repos, it is the single entry (key `main`, dir `.`). When the project has repos, the server writes its first enabled repo (lowest `merge_order`) into `repo`, for one release, so the previous colour keeps syncing it. Existing runs keep their stored `branch` and `worktree_path`, and the new tables are only read when rows exist. | Same pattern as `tickets` / `ticket_sources[0]`. Blue/green runs both releases side by side. |

## 3. Impact on other users

- **Projects with one repository (every project today)**: no change. Discovery finds the one checkout at
  the link's folder, which is the repo already in `setup.repo`. Cards need no repo, and the worktree path,
  prompt and guard are the same.
- **Discovery** runs on machines linked to projects. It reads folder names, `git remote`, the default
  branch and a one-line description, never file contents or terminal output. It stores `owner/repo`, the
  relative folder and that line. It is on for every project, and it only adds rows that nobody acts on until
  the project has automation on.
- **A repository found by discovery** never merges or deploys on its own: it starts at autonomy `pr`, with
  no deploy workflow (R6).
- **Multi-repo** behaviour, meaning cards without repos waiting, the chat being woken to pick repos, and
  workspaces, appears only in a project whose folder holds more than one repository.
- **Opt-in level**: per project (automation on, and per-repo levels in Setup). Per-repo exclusion is
  `enabled: false`.
- Nothing assumes the maintainer's machines or folders. The folder is whatever the machine link points at.

## 4. Data model

All migrations are additive.

- `project_repositories`: `id`, `project_id`, `full_name` (`owner/repo`, unique per project), `key`
  (unique per project, never changed), `description text null`, `status` (`ok` | `unsupported` |
  `no_access`), `discovered_at`, `updated_at`.
- `project_repository_checkouts`: `repository_id`, `machine_id`, `dir` (relative to the link's folder;
  `.` for the folder itself), `default_branch null`, `has_commits bool`, `seen_at`, `missing_at null`.
  Primary key `(repository_id, machine_id)`.
- `tasks.repo_keys text[] not null default '{}'`.
- `automation_run_repos`: `run_id`, `repository_id`, `branch`, `base`, `worktree_path`, `state` (`ready` |
  `pr_open` | `no_changes` | `removed`), `created_at`. Primary key `(run_id, repository_id)`.
  `automation_runs.worktree_path` holds the workspace root of a multi-repo run.
- `task_pull_requests` is unchanged (it already has `repo`).
- `automation_events` gains the kinds `repo_discovered`, `repo_missing`, `run_repo_added`,
  `group_merge_waiting`, `group_merge_partial`. The existing PR, merge, deploy and release events gain a
  `repo` field in their payload.

Setup (`setup/schema.ts`), with no `SETUP_VERSION` bump (`normalizeSetup` fills the defaults):

```ts
repo_defaults: {
  integration_id: null,        // the GitHub integration discovered repos use (R6)
  scan_depth: 1,               // 1..3 (R2)
},
repos: [                       // overrides only, keyed by full_name (R1, R7); max 50
  {
    full_name: 'reactivandoio/hub-community-bff',
    enabled: true,
    integration_id: null,      // null = repo_defaults.integration_id
    description: null,         // null = what discovery read (R10)
    base_branch: null,         // null = the checkout's default branch
    branch_pattern: null,      // null = the project's
    deploy_workflow: null,
    autonomy: 'pr',            // ≤ automation.autonomy
    required_checks: [], release_workflows: [], release_paths: [], store_paths: [],
    merge_order: 0,
  },
],
```

## 5. Discovery (R2–R6, R10)

1. Triggered as R3 describes, per `(project, machine link)`. Throttled through an in-memory map per
   instance plus `seen_at`, so both colours scanning at once is harmless (the upsert is idempotent).
2. `git.repos.scan { dir: link.cwd, depth }`. The agent resolves `dir` (with `~`), refuses `/` and the home
   folder (the same rule as `worktrees_dir`), and walks with `readdir`, never a shell. For each checkout it
   runs `git -C <dir> rev-parse --git-dir`, `remote get-url origin`, `symbolic-ref --short
   refs/remotes/origin/HEAD` and `rev-list -n1 --all` (commits), each with an argv array and the quick
   timeout. It reads at most 4 KiB of `package.json` or `README.md` for the description. A git worktree
   (`.git` file pointing at `worktrees/`) is skipped, so the worktrees folder is never "discovered".
3. The server upserts `project_repositories` by `full_name`, and checkouts by `(repository, machine)`. A
   checkout that was there and is not anymore gets `missing_at`. A new repo records `repo_discovered`
   (feed, plus one chat line: "Novo repositório na pasta do projeto: owner/repo (nível pr)."). The first
   scan of an existing project records one summary event instead of N.
4. `status`: `unsupported` when `origin` is not GitHub. `no_access` when the integration's token cannot read
   the repo (checked once on discovery and on Setup save, through `GET /repos/{full_name}`).

## 6. Cards and the concierge (R8–R10)

- Board: a chip per repo key on the card, and a multi-select in the card form, shown only when the project
  has more than one enabled repo.
- MCP: `create_task` / `update_task` take `repos: string[]` (keys or `owner/repo`), validated against the
  project. `list_tasks` and the tab tool `get_card` return them. New concierge tool `list_project_repos` (key, owner/repo,
  description, level, machines), and `scan_project_repos` (R3, on demand).
- Project prompt (`chat/project-prompt.ts`): for a project with several repos, the list of repos, and the
  rule "ao criar ou editar um card de trabalho automático, preencha repos; deduza pelo texto e pelas
  descrições; pergunte só quando houver dúvida real (card de pergunta)".
- Wake (R9 b): the dispatcher tick notices an `auto` card in a todo column with empty `repo_keys` in a
  multi-repo project and wakes the project's chat once per card (an `automation_events` row of kind
  `repo_unknown`, guarded by the same once-only index pattern as `ci_fix_requested`).

## 7. Runs (R11–R14)

- `launch` resolves the card's repos (`repo_keys`, or the single repo), picks a machine that has all of them
  (R5), and builds `automation_run_repos`. For each repo it computes the base (that repo's epic branch when
  the card's epic is automatic, created lazily through the API, R16; else that repo's base branch) and runs
  `ensureWorkspace` with `repoDir = join(link.cwd, checkout.dir)` and `path = <root>/<pid>/<ref>/<key>`.
- The tab's cwd is the workspace root, or the worktree itself for a single-repo run. The guard gets the
  workspace root (R13).
- Prompt (implementer, fixer, integrator): "Você trabalha nos repositórios: frontend
  (reactivandoio/hub-community-frontend, base main), bff (…)." It also says each repo is in `<key>/`, to
  `cd <key>` in its own call, to use the same branch everywhere, to open one PR per repo with changes, and to
  call `report_card` with `pr_urls`. It must not promise a local cross-repo stack (docker is denied, spike §2.3).
  The 4000-character budget holds: the repo lines take the room of the description excerpt first.
- Follower, release and cleanup match PRs by `(repo, head_ref)` and walk `automation_run_repos`. Cleanup
  removes each worktree, then the empty workspace folder.
- Fixer (red CI or conflict on one PR of the group): one fixer run on the card, in the same workspace, told
  which repo and PR failed. The "one active run per card" index still serializes it.

## 8. CI sync and the merge executor (R15, R17)

- `syncProjectCi` loops the active repos (R17). Each repo's entry gives `deploy_workflow` and
  `release_workflows`.
- `requiredLevel` and `required_checks` read the PR's repo entry. Globs are matched against paths in that
  repo.
- The merge executor groups the candidate PRs by primary card (or epic), checks the whole group, and merges
  in `merge_order`, waiting for each deploy in between (state stored as `group_merge_waiting` events plus
  the existing `deploy_state` rows, so a colour switch resumes where it was). The "one delivery at a time"
  rule applies per repo base branch.
- Approval above the level: one chat card for the group, listing each repo and its needed level. Approving
  merges the group once.

## 9. Setup screen, queue and policy text

- **Setup → Repositórios** (web): a full-width table with key, `owner/repo`, folder per machine (or
  "ausente"), status, base, level, deploy, merge order and an on/off switch. Each row expands into the
  per-repo policy fields. Above the table: the default integration, scan depth, "Procurar agora" and the time
  of the last scan. The old single-repo block stays for projects with no discovered repos. Mobile shows the
  list read-only in a later stage.
- **Queue** (`list_automation_queue`, Progresso): each item shows its repo chips. New reasons: `repo_unknown`
  ("sem repositório: o chat vai escolher"), `repo_missing` ("repositório X não está em nenhuma máquina do
  projeto"), `repo_no_access` ("a integração não vê X"), `repo_disabled`, `agent_no_repo_scan`.
  `repo_ready` becomes "every repo of the card is ready".
- **`get_automation_policy`**: lists the repos with their levels ("frontend: merge, deploy-prod.yml; bff,
  backend: pr"). From a run's tab, it lists the run's repos first. The 900-character policy clip in the
  prompt keeps the run's repos and drops the others.
- **Events**: `repo` in every PR, merge, deploy and release payload; the feed groups a card's PRs.
- All new copy goes through `t()` with pt-BR keys and English entries in the catalogs (CLAUDE.md).

## 10. Edge cases

- **Two machines with different layouts**: presence is per machine (R5), and placement filters on it.
- **A folder renamed**: same `owner/repo`, new `dir`. The key stays, and the checkout row is updated.
- **Two checkouts of the same repo in one folder** (a fork, a second clone): the first in sort order is
  used, and the other is reported in the scan summary.
- **The project folder is itself a repo and also holds repos** (submodule-like): the root is key `main`,
  and subfolders that are their own checkouts are separate repos. Submodules are skipped (`.git` file).
- **A run's repo is disabled or goes missing mid-run**: the run goes on, since its worktree exists. New
  runs wait.
- **The project goes from one repo to two**: runs started under the old layout keep it (stored paths).
  Cards with empty `repo_keys` stop being eligible until the concierge fills them.
- **A card with ten repos**: allowed, with a cap of 10 per card, and the queue warns above 5 (cost and disk
  room, checked per worktree by `machine-room.ts`).

## 11. Out of scope

- Automatic revert of an earlier merge in a group when a later one fails (board spec D22).
- PR CI in REA's repos that have none: that is reactivando's own work. Until then those repos stay at `pr`,
  because `required_checks` with no run is never green (spike R1).
- Mobile editing of the repo list (read-only view only, at the end).
- Repositories hosted outside GitHub.

## 12. Delivery

In stages, one card each. See `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`.
