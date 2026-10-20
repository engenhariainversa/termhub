# Match a run's PR by repository and branch — implementation plan (TER-1074)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the PR of an automatic run is found by `(repo, head_ref)`, not by `head_ref` alone, so a PR from
another repository with the same branch name is never taken as the run's.

**Architecture:** one small module, `apps/server/src/automation/run-pr.ts`, says which repository a
project's runs work on (`runRepoOf(setup)`, today `setup.repo.full_name`) and whether a PR row is the head of
a run branch in it (`isRunHead`). The follower (`openPrOfRun`), the delivery follower (`runBranchOf`,
`deliveryRow`) and the merge executor (`candidateOf`) all ask it, so the multi-repo tasks that follow change
one place.

**Tech stack:** TypeScript, vitest (`@termhub/server`).

**Spec:** `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md` (R14, §7). Outline:
`docs/superpowers/plans/2026-10-07-multi-repo-automation.md`, Task 3.

## Global constraints

- A project with one repository sees no change, except that a PR from another repository with the same
  branch name is no longer taken as the run's (spec §3.1; card "Impact on other users").
- The existing follower, release, adoption and merge tests pass unchanged. A test harness may gain an
  optional field; no existing test or expectation is edited.
- No migration and no new column: a run has no repository of its own until `automation_run_repos` (outline
  Task 12). The repository is the project's single one, `setup.repo.full_name`.
- Routes and automation code reach the database only through `db/repositories`.
- Cite the decision in code comments: `// spec 2026-10-07 multi-repo R14`.

## Decisions

| Question | Options | Choice | Why |
| --- | --- | --- | --- |
| Where the pairing lives | (a) repeat `row.repo === setup.repo.full_name` at each of the four places; (b) one helper module | (b) `run-pr.ts` | Tasks 12–15 replace "the project's single repo" with the run's repos. One place to change. |
| `automationRuns.branchesOfTask` | (a) add a `repo` argument the query cannot use yet; (b) keep the query and pair the repo in `isRunHead` | (b) | `automation_runs` has no repo column, so an argument would be decoration. The doc comment says the branches are of the project's repository, and nothing calls it outside `runBranchOf`. |
| A project whose Setup names no repository | (a) no PR ever matches; (b) the branch alone decides, as before | (b) | With no repository there is nothing to tell two PRs apart, and the CI sync links nothing new anyway. It also keeps every existing test (their setups name no repo) unchanged. |
| Comparing names | exact, or case-insensitive | case-insensitive | GitHub names are case-insensitive, and the Setup field is typed by a person while `task_pull_requests.repo` is written from that same field at sync time; a renamed case must not drop a run's PR. |

## Review focus

1. A card linked to two PRs with the same `head_ref`, one in the project's repo and one in another: only the
   first ends or adopts the run (Task 2 tests).
2. Only the other repository's PR is linked: the run is not ended, and a blocked run is not adopted (Task 2).
3. Setup names no repository: the branch alone decides, as today (Task 1 unit test; existing follower tests).
4. `Acme/App` in Setup against `acme/app` on the row: still the run's PR (Task 1).
5. A merged PR of another repository is not reported as the card's delivery, and is not a merge candidate
   (Task 3 tests).

---

### Task 1: `run-pr.ts` — the run's repository and the head match

**Files:**
- Create: `apps/server/src/automation/run-pr.ts`
- Test: `apps/server/src/automation/run-pr.test.ts`

**Interfaces:**
- Produces:
  - `runRepoOf(setup: Pick<ProjectSetupData, 'repo'>): string | null`
  - `inRunRepo(runRepo: string | null, repo: string): boolean`
  - `isRunHead(runRepo: string | null, branches: readonly string[], pr: { repo: string; head_ref: string }): boolean`

- [ ] **Step 1: failing test** — `run-pr.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { inRunRepo, isRunHead, runRepoOf } from './run-pr.js';

describe('the repository a run works on (spec 2026-10-07 multi-repo R14)', () => {
  it('is the project repository of Setup, or none', () => {
    expect(runRepoOf({ repo: { full_name: 'acme/app' } } as never)).toBe('acme/app');
    expect(runRepoOf({ repo: { full_name: '' } } as never)).toBeNull();
    expect(runRepoOf({ repo: null } as never)).toBeNull();
    expect(runRepoOf({} as never)).toBeNull();
  });

  it('a PR is the head of a run only in that repository, whatever the case of the name', () => {
    expect(isRunHead('acme/app', ['TER-12-x'], { repo: 'acme/app', head_ref: 'TER-12-x' })).toBe(true);
    expect(isRunHead('Acme/App', ['TER-12-x'], { repo: 'acme/app', head_ref: 'TER-12-x' })).toBe(true);
    expect(isRunHead('acme/app', ['TER-12-x'], { repo: 'acme/site', head_ref: 'TER-12-x' })).toBe(false);
    expect(isRunHead('acme/app', ['TER-12-x'], { repo: 'acme/app', head_ref: 'TER-12-y' })).toBe(false);
    expect(isRunHead('acme/app', [], { repo: 'acme/app', head_ref: 'TER-12-x' })).toBe(false);
  });

  it('with no project repository the branch alone decides', () => {
    expect(inRunRepo(null, 'acme/site')).toBe(true);
    expect(isRunHead(null, ['TER-12-x'], { repo: 'acme/site', head_ref: 'TER-12-x' })).toBe(true);
    expect(isRunHead(null, ['TER-12-x'], { repo: 'acme/site', head_ref: 'other' })).toBe(false);
  });
});
```

- [ ] **Step 2:** `npm test -w @termhub/server -- src/automation/run-pr.test.ts` → FAIL (module not found).
- [ ] **Step 3: implement** `run-pr.ts`:

```ts
import type { ProjectSetupData } from '../setup/schema.js';

/**
 * The repository the project's automatic runs work on (spec 2026-10-07 multi-repo R14): its single
 * repository for now, `setup.repo.full_name`. Null when Setup names none.
 */
export const runRepoOf = (setup: Pick<ProjectSetupData, 'repo'>): string | null => setup.repo?.full_name || null;

/** Whether a PR's repository is the run's. GitHub names are case-insensitive. With no project repository
 *  there is nothing to tell two PRs apart, and every one passes. */
export const inRunRepo = (runRepo: string | null, repo: string): boolean => !runRepo || repo.toLowerCase() === runRepo.toLowerCase();

/** Whether a PR is the head of one of these run branches, in the run's repository: two repositories can each
 *  have a `TER-12-x` branch, and only one of them is the run's. */
export const isRunHead = (runRepo: string | null, branches: readonly string[], pr: { repo: string; head_ref: string }): boolean =>
  branches.includes(pr.head_ref) && inRunRepo(runRepo, pr.repo);
```

- [ ] **Step 4:** run the test → PASS.
- [ ] **Step 5:** commit `Automation: name the repository a run's PR belongs to`.

### Task 2: follower — `openPrOfRun` matches `(repo, head_ref)`

**Files:**
- Modify: `apps/server/src/automation/follower.ts` (`openPrOfRun`)
- Test: `apps/server/src/automation/follower.test.ts` (harness: optional `repo` on `prs`, optional
  `projectRepo`; new tests in the D17 and the adoption blocks)

**Interfaces:**
- Consumes: `runRepoOf`, `isRunHead` (Task 1).
- Produces: `openPrOfRun(repos, run)` unchanged in signature. It covers the D17 fallback (`onStopped`,
  `onExited`), the parked run (`followRun`, `status === 'waiting'`), and `adoptBlockedRuns` (TER-1049, which
  is also what `report_card` from a blocked tab relies on, TER-1050).

- [ ] **Step 1: harness** — in `world()`, `prs` items take `repo?: string`, the options take
  `projectRepo?: string`, and `projectSetup.get` returns `repo: { full_name: o.projectRepo }` when it is set.
- [ ] **Step 2: failing tests**

```ts
// in the adoption block
it('two PRs from the same branch name in two repositories: only the one in the project repository adopts the run (spec 2026-10-07 multi-repo R14)', async () => {
  const other = { ...PR, repo: 'acme/site', url: 'https://github.com/acme/site/pull/3', number: 3 };
  const own = { ...PR, repo: 'acme/app' };
  const w = blocked({ projectRepo: 'acme/app', prs: [other, own] });
  expect(await adoptBlockedRuns(w.repos, 'p1', undefined, NOW)).toBe(1);
  expect(w.events).toEqual([
    expect.objectContaining({ kind: 'run_done', payload: expect.objectContaining({ pr_url: own.url }) }),
    expect.objectContaining({ kind: 'pr_opened', payload: expect.objectContaining({ pr_url: own.url, number: 9 }) }),
  ]);
  // the other repository's PR alone adopts nothing
  expect(await adoptBlockedRuns(blocked({ projectRepo: 'acme/app', prs: [other] }).repos, 'p1', undefined, NOW)).toBe(0);
});
```

```ts
// next to the D17 tests ("a stopped tab with an open PR…")
it('a PR from the same branch name in another repository does not end the run (spec 2026-10-07 multi-repo R14)', async () => {
  const w = world({ projectRepo: 'acme/app', prs: [{ state: 'open', head_ref: 'TER-1-card', url: 'https://github.com/acme/site/pull/3', number: 3, repo: 'acme/site' }] });
  await followRun(w.deps, w.run.id);
  expect(w.run.status).toBe('running');
  expect(w.kinds()).not.toContain('run_done');
  w.setPrs([{ state: 'open', head_ref: 'TER-1-card', url: 'https://github.com/acme/app/pull/9', number: 9, repo: 'Acme/App' }]);
  await followRun(w.deps, w.run.id);
  expect(w.run.status).toBe('done');
});
```

- [ ] **Step 3:** `npm test -w @termhub/server -- src/automation/follower.test.ts` → the two new tests FAIL
  (the other repository's PR is taken).
- [ ] **Step 4: implement**

```ts
async function openPrOfRun(repos: Repositories, run: AutomationRun): Promise<{ url: string; number: number; merged: boolean } | null> {
  if (!run.task_id || !run.branch || run.role === 'integrator' || run.role === 'fixer') return null;
  const ofRun = (p: { state: string; merged_at: Date | null }) => p.state === 'open' || (p.state === 'merged' && p.merged_at !== null && p.merged_at.getTime() >= run.created_at.getTime());
  const fromBranch = (await repos.taskPullRequests.listByTasks([run.task_id])).filter((p) => p.head_ref === run.branch && ofRun(p));
  if (fromBranch.length === 0) return null;
  // spec 2026-10-07 multi-repo R14: … only the one in the run's repository is its PR
  const repo = runRepoOf((await repos.projectSetup.get(run.project_id)).data);
  const pr = fromBranch.find((p) => inRunRepo(repo, p.repo));
  return pr ? { url: pr.url, number: pr.number, merged: pr.state === 'merged' } : null;
}
```

  The Setup is read only when a PR from the branch exists, so a sweep with no PR costs what it did.
- [ ] **Step 5:** run `src/automation/follower.test.ts` and `src/automation` → PASS, nothing else changed.
- [ ] **Step 6:** commit `Follower: match a run's PR by repository and branch`.

### Task 3: release and merge — `runBranchOf`, `deliveryRow`, `candidateOf`

**Files:**
- Modify: `apps/server/src/automation/release.ts` (`runBranchOf`, `deliveryRow`, `followMerged`)
- Modify: `apps/server/src/ci/sync.ts` (the `deliveryRow` call)
- Modify: `apps/server/src/automation/merge.ts` (`candidateOf`)
- Modify: `apps/server/src/db/repositories/automation-runs.ts` (doc comment of `branchesOfTask`)
- Test: `apps/server/src/automation/release.test.ts`, `apps/server/src/automation/merge.test.ts`,
  `apps/server/src/ci/sync.test.ts`

**Interfaces:**
- Consumes: `runRepoOf`, `isRunHead` (Task 1).
- Produces:
  - `runBranchOf(repos: Repositories, setup: ProjectSetupData, taskId: string, pr: { repo: string; head_ref: string }): Promise<boolean>`
  - `deliveryRow(repos: Repositories, setup: ProjectSetupData, rows: TaskPullRequest[]): Promise<TaskPullRequest>`

- [ ] **Step 1: failing tests**
  - `release.test.ts`: a merged PR of `acme/site` whose head is the card's run branch, in a project whose
    Setup names `acme/app`: the deploy result is stored on the row, and no `deploy_ok` event is recorded.
  - `ci/sync.test.ts` (`deliveryRow` through `syncProjectCi`): a merged PR of `acme/site` with two rows (one
    card each), one of them the card whose run branch has that name → no event on either card.
  - `merge.test.ts`: the PR row's `repo` is `acme/site` while Setup names `acme/app` → `mergeReadyPulls`
    merges nothing and asks nothing (the row is fed straight through `listWatched`'s mock).
- [ ] **Step 2:** run both files → the new tests FAIL.
- [ ] **Step 3: implement**

```ts
// release.ts
export async function runBranchOf(repos: Repositories, setup: ProjectSetupData, taskId: string, pr: { repo: string; head_ref: string }): Promise<boolean> {
  const repo = runRepoOf(setup);
  if (!inRunRepo(repo, pr.repo)) return false;
  return isRunHead(repo, await repos.automationRuns.branchesOfTask(taskId), pr);
}

export async function deliveryRow(repos: Repositories, setup: ProjectSetupData, rows: TaskPullRequest[]): Promise<TaskPullRequest> {
  for (const row of rows) {
    if ((await repos.tasks.findById(row.task_id))?.auto && (await runBranchOf(repos, setup, row.task_id, row))) return row;
  }
  return rows[0]!;
}
// followMerged: runBranchOf(repos, c.setup, w.task_id, w)
// sync.ts:      deliveryRow(repos, setup, watched.filter(…))
// merge.ts candidateOf: task.auto && (await runBranchOf(repos, base.setup, task.id, row))
```

- [ ] **Step 4:** `npm test -w @termhub/server -- src/automation src/ci` → PASS.
- [ ] **Step 5:** `npm run typecheck -w @termhub/server` → clean.
- [ ] **Step 6:** commit `Merge and delivery: a run branch counts only in the run's repository`.

### Task 4: verify and hand over

- [ ] `npm test -w @termhub/server` (whole server suite) and `npm run typecheck -w @termhub/server`.
- [ ] `git diff main --stat` shows no edited expectation in an existing test.
- [ ] PR against `main` with **Impact on other users** and **Decisões tomadas**; `report_card`.
