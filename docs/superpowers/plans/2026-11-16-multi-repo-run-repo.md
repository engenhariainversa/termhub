# Multi-repo: a single-repo run works in the card's repository (TER-1066)

Epic TER-1060, card 11 of 16. Spec: `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md`
(R5, R11, §7). Outline: `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`, Task 11 and "Rollout
for REA". Audit of 2026-11-16: the API runs (TER-1181) are covered here too.

## Goal

An automatic run works in the checkout of the card's repository, not in the folder of the project/machine
link. A project whose link points at a parent folder (REA) can then run cards on any of its repositories, one
repository per card. A project with one repository gets byte-for-byte today's worktree path, prompt, allow
list and guard.

## Steps

1. **Data** — migration `automation_run_repos` (`run_id`, `repository_id`, `branch`, `base`,
   `worktree_path`, `state` default `ready`, `created_at`; PK `(run_id, repository_id)`; both foreign keys
   cascade). Additive: the release still serving never reads it. Repository
   `db/repositories/automation-run-repos.ts`: `add` (idempotent on the key), `listByRun`, `copy(from, to)`.
   A run whose repository discovery has not stored yet (a single-repo project read from `setup.repo`) writes
   no row: there is no `project_repositories` id to point at.
2. **Which repository** — new `automation/run-repo.ts`:
   - `resolveRunRepo(repos, projectId, setup, keys)` → `RunRepo` (`entry`, `repositoryId`, `dirOn(machineId)`).
     One key: that enabled, readable entry; no key: the project's run entry (`runEntry`, the single repo);
     more keys: refused (`REPO_MULTI`, workspace runs are Task 12). With no entry at all (an old setup with
     no `setup.repo.full_name`), the legacy target: the link's folder and `setup.repo`.
   - `dirOn(machineId)`: the machine's checkout dir when present, null when the scan marked it missing; with
     no checkout row, `.` in a single-repo project (agent without `repo_scan`, discovery not run: today's
     behaviour) and null in a multi-repo one (R5).
   - `repoDirOf(cwd, dir)`: `cwd` itself for `.` (never normalized, so the RPC gets the same string),
     else `path.posix.join(cwd, dir)`.
3. **Placement** (`placement.ts`): `placeRun(…, tick, repo?)` leaves out linked machines whose `dirOn` is
   null (verdict `no_checkout`) and returns `waiting: 'repo_not_on_machine'` when that leaves none. The
   placement carries `repoDir`. The queue shows it as `repo_not_on_machine`.
4. **Launch** (`dispatcher.ts`): `dispatchProject` and `startTriggered` resolve the repository from the
   card's `repo_keys` before placing (a refusal releases the claim). `launch`:
   - `targetOf(card, setup, entry)` and `implementerBranchOf(task, branchRepo)` read the entry's base and
     pattern; the epic branch is created in the entry's repository with its own integration
     (`githubAccess`);
   - `ensureWorkspace({ repoDir })`, worktree path unchanged (`<root>/<pid>/<ref>`);
   - one `automation_run_repos` row (state `ready`) once the worktree exists;
   - the prompt names `owner/repo` (and its base) only in a multi-repo project, and the policy excerpt
     lists the card's repository (`runPolicyRepos`);
   - `existingWork` asks GitHub about the card's repository.
   - A fixer taking over the card's tab copies the previous run's rows.
5. **Cleanup** (`cleanup.ts`): the repo dir comes from the run's row (its repository's checkout on the run's
   machine), else from the project's run entry on that machine, else the link's folder. Cancelled runs go
   through the same path.
6. **`branches.ts`**: `targetOf(card, setup, entry?)` takes the base from the entry.
7. **Machine room** (`machine-room.ts`): unchanged. It only uses the folder as a hint for `~` in
   `worktrees_dir`, and the link's folder and the checkout share the home.
8. **API runs** (`runs/service.ts`, `runs/sweeper.ts`): the worktree is cut in the run entry's checkout on
   the chosen machine (`repoDirOf`) from the entry's base branch; the workspace JSON keeps `repo_dir`, and the
   sweeper removes the worktree there (old rows: the link's folder). A read-only run stays in the link's
   folder (every repository readable).

## Tests

- `run-repo.test.ts` (pure): one key, no key, several keys, a disabled key, missing checkout, no row in a
  single- and a multi-repo project, the legacy target, `repoDirOf('.')` returns the cwd unchanged.
- `prompts.test.ts`: the repository line only when given; the single-repo prompt snapshot is unchanged.
- `dispatcher.db.test.ts`: two machines whose folders hold the repository at different subfolders, each run
  cut from its own checkout; a missing checkout waits with `repo_not_on_machine`; a single-repo project keeps
  `repoDir`, worktree path, prompt and allow list (existing assertions plus a discovered `.` checkout); the
  run row is written; cleanup removes the worktree from the checkout.
- `cleanup.test.ts`: the repo dir from the run's row.
- `runs` tests: the API run's worktree in the run entry's checkout, the sweeper with `repo_dir`.

## Impact on other users

None for single-repo projects: same folder, path, prompt and allow list. A checkout the scan marked missing
on a machine makes the card wait for another machine instead of failing its start there.

## CLIs covered

Claude Code ✅ (automatic runs start Claude Code only, as before) · Codex ✅ for API runs (same worktree
rule) · Cursor, Gemini: not account providers of automatic or API runs (unchanged, `docs/agent-cli-parity.md`).
