# Multi-repo — GitHub access, CI sync, merge and release per repository (TER-1067) — implementation plan

> Task 10 of `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`. Spec:
> `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md` (R7, R15, R17, §8, §9).

**Goal:** everything on the delivery path that reads `setup.repo` reads the **entry of the PR's repository**
in the project's effective list (`effectiveRepos`, TER-1070) instead. A single-repo project has one entry,
built from `setup.repo` and the project-wide `automation`, so it behaves exactly as before.

**CLIs covered:** not an agent CLI feature (server-side GitHub reads and merges). Claude Code ✅ · Codex ✅ ·
Cursor ✅ · Gemini ✅.

## Pieces

1. **`apps/server/src/automation/repo-entry.ts`** (new)
   - `RepoEntry`: the slice of `EffectiveRepo` the delivery path reads (full name, key, integration, base,
     deploy workflow, level, required checks, release workflows, release and store globs).
   - `loadRepoEntries(repos, projectId, setup)`: `effectiveRepos(setup, discovered rows)`. A partial setup
     (older callers and fakes) is normalized first; a `Repositories` without the discovery table reads the
     setup alone.
   - `activeEntries(list)`: enabled, status `ok`, a valid `owner/repo`.
   - `entryFor(list, repo)`: by name, without case.
   - `runEntry(list, setup)`: the repository the runs work on today (`setup.repo`, else the first active).
   - `legacyEntry(setup, repo)`: the entry read from the setup alone, for a caller that has no list
     (`followMerged` when its context has no entry).
2. **`githubAccess(repos, project, setup, entry)`** takes the entry: its integration, else the project's
   `setup.repo` integration (TER-1071 precedent: "integração efetiva do repo, senão a do projeto"), still
   only a GitHub integration of the project's owner. Callers: merge executor, approval, `projectPrCi`,
   `epicDied`, integrator.
3. **Merge executor (`merge.ts`)**
   - `runMergeExecutor` loops the active entries; each gets its own token and its own watched PRs.
   - `PullCtx.entry`: base branch, deploy workflow, required checks, globs and level come from it.
   - The red-base escalation map is keyed `(project, repo)`, so a red base in repo A never holds or
     escalates repo B (one delivery at a time per repo base branch).
   - `mergeApproved` finds the entry of `args.repo`.
   - `merged` and `merge_needs_approval` payloads get `repo`.
4. **Delivery (`delivery.ts`, `release.ts`)**: `deliveryPending` / `followsReleases` take the entry
   (optional, else the setup's). `DeliveryCtx.entry` (optional) gives the deploy workflow, release workflows
   and release globs of `followMerged`, `versionAt` and the deploy retry. `deploy_ok`, `deploy_failed`,
   `deploy_retried`, `release_ok`, `release_failed` payloads get `repo`.
5. **CI sync (`ci/sync.ts`, `ci/scheduler.ts`)** (R17)
   - `syncProjectCi` loops the active entries with access. ETag per `(project, repo)`
     (`ciEtagKey`).
   - With more than one active repo, a repo's pulls are listed only when it is in play: a watched PR in it,
     a card in doing or an automatic card in todo whose `repo_keys` name it, or (cards with empty
     `repo_keys`, and any active run) the run's repo. A single-repo project lists as before.
   - A GitHub error in one repo is noted and the others go on; a rate limit stops the pass (the scheduler
     pauses the project). All repos failing throws, as before, without the merge pass.
   - `projectSetup.listWithRepo` becomes "projects with any repository": `setup.repo`, an override or a
     discovered row, and an integration somewhere.
   - Scheduler busy check: a card in doing, or a watched PR in any active repo.
   - `tasks.repoKeysInPlay(projectId)`: the `repo_keys` of cards in doing and of automatic cards in todo.
6. **Policy text (`policy.ts`, `get_automation_policy`, prompts)**
   - `policyText(automation, deployWorkflow, repos?)`: with several active repos, a "Repositórios:" line
     right after the level line, one item per repo (`key (owner/repo): level, deploy "x", release: …,
     loja: …`), run's repos first. The single-repo text is unchanged.
   - The run prompt (dispatcher, integrator) lists only the run's repo, so the 660-character clip keeps it.
   - `get_automation_policy` lists every active repo, the run's first when called from a run's tab.
   - `pr_ci` reads the run's repo.
7. **Audit list**: `epic-lifecycle.ts` (base and branch delete on the run's entry), `integrator.ts` (base,
   access, policy), `unlisted-workflows.ts` (names of every entry), `health/snapshot.ts` (base branch of the
   repo whose base reading is worst). `noteBaseReading` keeps one reading per repo; `baseReadingOf`
   answers the worst one with its repo.
8. **A card's own repositories (`runBranchOf`)**: a PR counts as the card's in the run's repository, as
   before, and also in a repository the card names in `repo_keys`. Without it a PR in a second repository
   could never be a candidate, and the per-repo levels would have nothing to act on. A card with no
   `repo_keys` keeps R14 as it is: a PR of another repository from a branch of the same name is not its.
9. **No CI (TER-1188)**: `repoPrCi`, `noCiVerdict` and `baseState(noCi)` already read `c.repo`; with the
   per-repo context each repository's CI and protection are read on their own.

## Tests

- `repo-entry.test.ts`: entries, active filter, run entry, legacy entry.
- `merge.test.ts` (new block): two repos with different levels (A merges, B asks); a repo raised to the
  project's level merges; a red base in one repo that does not hold the other; a repo the card does not name
  stays out; events carry `repo`.
- `release.test.ts` (new block): the entry's deploy workflow, `deploy_ok` with `repo`.
- `sync.test.ts`: ETag per repo; an inactive (disabled) repo is not listed; a repo not in play is not listed.
- `policy.test.ts`: the repos line, run's repos first, single repo unchanged.
- Existing merge and release tests unchanged, except the two release assertions that compare a whole
  `deploy_ok` / `release_ok` payload, which now carry `repo` (the card asks for it).

## Impact on other users

A project with one repository has one entry and behaves exactly as before. The per-repo levels only show
up once a project has several repositories (discovery, TER-1071), and each new one starts at `pr`.
