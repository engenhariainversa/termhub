# Multi-repo done rule and `add_repo` — implementation plan (TER-1064)

> Outline: `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`, Task 13.
> Spec: `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md`, R12 and R14.

**Goal:** a run with several repositories (a workspace run, Task 12) ends `done` only when every repository
whose branch is ahead of its base has an open PR from it; and the agent can add a repository to its run.

**Single-repo runs do not change.** A run with zero or one `automation_run_repos` row keeps the current
`openPrOfRun` and `report_card` paths, with no GitHub call.

## Task 1 — the done rule (`apps/server/src/automation/run-done.ts`, new)

- `liveRunRepos(repos, runId)`: the run's rows not `removed` (`[]` when the repository is absent, as in fakes).
- `multiRepoVerdict(repos, run, rows, linked, gh)`: one verdict per row, in order:
  1. a PR linked to the card (`task_pull_requests`) from `row.branch` in that repository (open, or merged
     since the run began) → `pr_open`;
  2. no GitHub access for the repository → `unknown`;
  3. `gh.findOpenPull(repo, branch, base)` → `pr_open` (a PR the CI sync has not linked yet);
  4. `gh.compare(base, branch)`: `ahead_by > 0` → `missing`; `0`, or the branch not on GitHub (404) →
     `no_changes`; any other error → `unknown`.
- `done` = no `missing` and no `unknown`.
- `githubAccess` moves from `merge.ts` to `automation/github-access.ts` (re-exported), so the follower can use it
  without an import cycle.

## Task 2 — wire the rule (`follower.ts`)

- `openPrOfRun` takes a GitHub client. For a multi-repo run it needs a linked PR from the branch first (so the
  sweep never calls GitHub for a run with no PR at all), then asks `multiRepoVerdict`; it answers only when the
  verdict is done. Covers the D17 fallback (`onStopped`, `onExited`, a waiting run), `adoptBlockedRuns` and
  `report_card` from a blocked tab.
- `report_card` `done` in an active multi-repo run evaluates the verdict with no linked PR needed. Not done →
  `ControlError PRS_MISSING` naming the repositories (or `PRS_UNKNOWN` when GitHub could not be read). Done with
  no PR at all (every repository `no_changes`) is accepted, as a single-repo `done` without `pr_url` is.
- On done, the rows go `ready → pr_open | no_changes` (`AutomationRunReposRepository.setState`) and one
  `pr_opened` is recorded per PR; `run_done` carries `pr_count` when there is more than one (event payloads are flat).
- `report_card` gains `pr_urls` (≤ 10 URLs). A single-repo run reads `pr_url ?? pr_urls[0]`. In a multi-repo run
  the URLs are hints only: the verdict reads GitHub.
- `FollowerDeps.gh`, `adoptBlockedRuns(…, gh)` and `reportCard(…, gh)` take the client; the default is
  `createGithubWriteClient()`.

## Task 3 — `add_repo { key }` (`apps/server/src/automation/add-repo.ts`, new)

- Only from a tab with an active run (`RUN_ONLY_TOOLS`, `allowedIf: tabHasActiveRun`), listed in
  `TAB_TOKEN_TOOLS`.
- Refusals: no run; a run in one repository (its worktree is the repository itself, there is no workspace
  root to add under, and its guard covers one folder) → `ADD_REPO_SINGLE`; a key not in the project →
  `REPO_UNKNOWN`; a key disabled, not on GitHub or unreadable → `REPO_UNAVAILABLE`; a key with no present
  checkout on the run's machine → `REPO_NOT_ON_MACHINE`. A key already in the run answers `already: true`.
- Then: the epic branch in that repository when the card's epic is automatic (R16), `ensureWorkspace` at
  `<run worktree>/<key>` on the run's branch, the `automation_run_repos` row, the key appended to the card's
  `repo_keys` (`TasksRepository.addRepoKey`, under the project lock), and `run_repo_added`
  (`{ key, repo, tab_id }`).
- The allow list of a restart reads the run's rows (`runPermission`), so the new key's `-C` forms come with the
  next restart; until then a push from it may ask for permission.

## Task 4 — tests

- `run-done.test.ts`: two repositories with one PR missing (not done); a repository with no commits ahead
  (done, `no_changes`); a branch not on GitHub; an unreadable repository (`unknown`).
- `follower.test.ts`: the D17 fallback with one of two PRs (stays running), adoption with two PRs (two
  `pr_opened`), `report_card` refused with a PR missing, accepted with both, states written.
- `add-repo.test.ts`: every refusal, and the happy path (worktree, row, key, event).
- `tab-token` / `tools-schema` / start-agent e2e lists updated for the new tool.

## Impact on other users

Single-repo cards end exactly as today. Multi-repo runs (behind the existing multi-repo Setup) end only with
every PR open. `add_repo` is listed only in tabs running automatic work.

**CLIs covered:** Claude Code ✅ · Codex ✅ · Cursor ✅ · Gemini ✅ — both are server-side rules and an MCP tab
tool, which every supported CLI reaches through the tab's MCP server.
