# Agentic Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cards tagged "automático" are picked up by a server dispatcher, worked by agents in their own worktrees, answered from memory, merged by the server within the project's autonomy level, and followed through deploy and release, with a kill switch, a feed, cost per card and a daily summary.

**Architecture:** A boolean `tasks.auto` and an `automation` block in the project setup decide what is eligible and how far it may go. A server loop (`apps/server/src/automation/`) claims cards through `automation_runs` (a partial unique index makes the claim safe across the blue/green colours), prepares a worktree through a new agent RPC, and starts the agent with the existing `startAgent`. A `monitorBus` follower resumes, answers or escalates. The merge executor, run after each CI sync, merges green PRs through the GitHub API when the policy allows and opens approval cards otherwise.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, zod, vitest (server, agent, protocol); React + Vite (web); Expo / React Native, zustand, jest (app).

**Spec:** `docs/superpowers/specs/2026-10-04-agentic-board-design.md`. Read it before any task: section 2 holds the decisions (M1–M5 from the maintainer, D1–D27 taken in the spec), section 4 the data model, section 13 the edge cases. Cite the decision number in code comments where a rule comes from it (`// spec 2026-10-04 agentic board D16`).

## Global Constraints

- Code comments, identifiers, commit messages and PR texts in English. UI copy, prompts typed into tabs, chat notices and push texts in pt-BR; copy the strings given in the tasks as written.
- Commit subject: imperative, at most 72 characters, prefixed by the area (`Board:`, `Setup:`, `Automation:`, `Agent:`, `Protocol:`, `Web:`, `Mobile:`, `Docs:`). End the message with the attribution line your own session's instructions give.
- One PR per task, against `main` (this epic predates its own epic-branch flow). Each PR is harmless alone: nothing runs until a project sets `automation.enabled`. Each PR carries a short **Impact on other users** section (CLAUDE.md).
- Routes never import Prisma; go through `apps/server/src/db/repositories`. Every request input is validated with zod.
- Load projects, tabs, tasks, machines and AI accounts through `scoped(repos, request).<kind>(id)` in routes, and through `ctx.scoped` in control functions. Server jobs build their context with `controlContextFor(repos, owner)` (`apps/server/src/control/context.ts:37`).
- New route plugins go through `guarded(resource, plugin, prefix)` in `app.ts`; check `resource:action` grants, never role names. Automation routes use the existing resources: `tasks` for the tag and the queue, `projects` for setup and pause.
- Board writes take `lockProject` first (`db/repositories/task-board.ts:22`). Never write `tasks.number`. `status` stays in sync with `column_id`.
- Migrations: `apps/server/prisma/migrations/YYYYMMDDHHMMSS_snake_case/migration.sql`, additive only, backward compatible with the previous release. Use timestamps after the newest migration on `main` when you write it.
- Terminal content, transcript content and prompts are never logged or stored. Events and usage rows hold ids, URLs, counts and reasons only.
- Anything typed into a tab goes through the existing session functions; every value in a shell line goes through `shellQuote`. Agent RPCs run `git` with an argv array, never a shell string.
- Server-typed messages start with `[termhub automático]` (spec D27).
- The agent version for the worktree RPC is the next minor after the published one (0.16.0 at the time of writing). Bump `apps/agent/package.json` and `apps/agent/src/version.ts` together. Never run `npm publish`: CI publishes.
- The app changes are JavaScript only: no new native dependency, no change to `app.json`, `app.config.js` or `expo.version`.
- Throwaway containers are named `th-<something>`. Never touch the production containers.
- Before debugging an error, search `docs/lessons/` and the project's lessons; after fixing a non-obvious one, add `docs/lessons/YYYY-MM-DD-<slug>.md` in the same PR.

### Running things

Run from the worktree root. The CI uses Node 22:

```bash
th() { docker run --rm --name "th-agentic-$$" -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c "$1"; }
th 'npm ci && npm run build:packages'                 # once per worktree
th 'npm test -w @termhub/server -- src/automation'    # pure and fake-driven tests
th 'npm run typecheck -w @termhub/server'
th 'npm test -w @termhub/agent -- worktree'
th 'npm run build -w @termhub/web'
th 'npm test -w @termhub/mobile -- automation'
rm -rf .npm
```

`*.db.test.ts` run only with `TERMHUB_DB_TESTS=1` and a database. Start a throwaway one with
`docker run -d --name th-agentic-db -e POSTGRES_PASSWORD=th -p 55432:5432 pgvector/pgvector:pg16`, set
`DATABASE_URL=postgresql://postgres:th@host.docker.internal:55432/postgres` (add
`--add-host=host.docker.internal:host-gateway` to `th`), run `npx prisma migrate deploy -w @termhub/server`, and
remove the container at the end (`docker rm -f th-agentic-db`).

Before every push: `th 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'`.

## Review Focus

1. **Two colours during a deploy**: a card must never get two runs, and a run must survive the switch (spec D11, §8 step 7). Tests in Task 11 and Task 20.
2. **A merge above the level**: it must become an approval card and never run, including store paths (D6, D7). Tests in Task 5 and Task 25.
3. **Loops**: a tab that keeps stopping, a CI that keeps failing, an account at its limit — each must stop after its cap and escalate (D15, D16, D21). Tests in Tasks 18, 19 and 29.
4. **The kill switch**: after "Pausar tudo", nothing is started, typed, answered or merged (D24). Tests in Task 9 and Task 17.
5. **Other users**: a project that never turns automation on behaves exactly as before (D3). Each server task has a test with `automation.enabled = false`.

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/server/prisma/schema.prisma` + migrations | `tasks.auto`, `task_pull_requests.base_ref/changed_level`, pauses, `users.time_zone`, `automation_runs`, `automation_events`, `ai_account_exhaustions`, `tab_usage` |
| `apps/server/src/setup/schema.ts` | `automationSchema` inside `setupSchema` |
| `apps/server/src/db/repositories/tasks.ts` | `setAuto`, tag inheritance in `insertCard` and `update` |
| `apps/server/src/db/repositories/automation-runs.ts` | Claim, heartbeat, takeover, status changes |
| `apps/server/src/db/repositories/automation-events.ts` | Append and list events |
| `apps/server/src/db/repositories/automation-pauses.ts` | User and project pause flags |
| `apps/server/src/db/repositories/ai-account-exhaustions.ts` | Exhausted accounts until reset |
| `apps/server/src/db/repositories/tab-usage.ts` | Token counts per tab |
| `apps/server/src/automation/eligibility.ts` | Pure eligibility and reasons |
| `apps/server/src/automation/queue.ts` | The ordered queue for a project |
| `apps/server/src/automation/policy.ts` | Levels, `requiredLevel`, `allows` |
| `apps/server/src/automation/branches.ts` | Branch names, epic branch on GitHub, workspaces |
| `apps/server/src/automation/prompts.ts` | Prompt templates per role, the marker |
| `apps/server/src/automation/dispatcher.ts` | Tick, claim, place, prepare, start |
| `apps/server/src/automation/follower.ts` | `monitorBus` → resume, restart, answer, end |
| `apps/server/src/automation/quota.ts` | Rate limit → exhaustion, resume after reset |
| `apps/server/src/automation/answers.ts` | Choice and permission answers in automatic tabs, escalation |
| `apps/server/src/automation/merge.ts` | Merge executor and approval cards |
| `apps/server/src/automation/integrator.ts` | Epic trigger, epic PR, integrator runs |
| `apps/server/src/automation/release.ts` | Deploy and release workflow follow-up |
| `apps/server/src/automation/usage.ts`, `prices.ts` | Tokens from transcripts, cost estimate |
| `apps/server/src/automation/summary.ts` | Daily summary |
| `apps/server/src/automation/events.ts` | `recordEvent` + bus for the feed |
| `apps/server/src/integrations/github-write.ts` | Create ref, open PR, mergeability, files, merge |
| `apps/server/src/routes/automation.ts` | Queue, pause/resume, events, usage |
| `apps/server/src/mcp/tools.ts`, `mcp/tab-token.ts` | New tools; tab tools `get_automation_policy`, `report_card` |
| `packages/agent-protocol/src/{rpc,messages}.ts` | `git.worktree.ensure/remove`, capability `worktree` |
| `apps/agent/src/rpc/worktree.ts` | The worktree RPC on the machine |
| `packages/mobile-api/src/automation.ts` | App contract |
| `apps/web/src/components/{TasksBoard,TaskEditor,SetupForm,ProgressPanel}.tsx`, `AutomationSetup.tsx`, `PauseAutomationButton.tsx` | Web |
| `apps/mobile/src/features/automation/*`, `features/progress/*` | App |

---

## Phase 0 — Research

### Task 1: Spike — safety and limits of the automatic mode (TER-900)

**Files:**
- Create: `docs/superpowers/specs/2026-10-0X-automation-safety-spike.md` (date of writing)

This task writes a document, not code. It must be merged before Task 25 (merge executor) and before Task 35 (turning automation on).

- [ ] **Step 1:** Read spec sections 2, 10 and 13, `deploy/blue-green.sh` (`wait_healthy` l.146, `--rollback` l.291), `.github/workflows/deploy.yml`, `publish-agent.yml`, `publish-mobile-ota.yml`, `apps/server/src/control/account-swap.ts`, `apps/server/src/memory/blocklist.ts`.
- [ ] **Step 2:** Answer, each with a recommendation and the setting or card that implements it: cost (budget per account/day/card; what to do when it is reached; early warning); loops (agent restarting a card, CI fixes without end, auto-answers in a cycle: detectors and caps); broken main (required CI gate, post-deploy smoke test against `/api/ready` and one authenticated route, freezing the project's automation); automatic rollback (when `blue-green.sh --rollback` is safe given backward-compatible migrations; how to tell the person); secrets and scope (what an automatic agent never touches: stores, production data, secrets, other projects' worktrees, the production containers on jarvis); concurrency (safe numbers per machine from `hw.probe`, per account).
- [ ] **Step 3:** For every recommendation that changes behaviour, create a card in epic TER-852 (`create_task`, type `task`), and list the refs in the document.
- [ ] **Step 4:** Commit and open the PR.

```bash
git add docs/superpowers/specs/2026-10-0X-automation-safety-spike.md
git commit -m "Docs: automation safety and limits spike (TER-900)"
```

---

## Phase 1 — Tag, setup, eligibility, policy

### Task 2: Tag "automático" on cards, with epic propagation (TER-855)

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (`model Task`, l.450)
- Create: `apps/server/prisma/migrations/<ts>_task_auto/migration.sql`
- Modify: `apps/server/src/db/repositories/tasks.ts` (`insertCard` l.221, `update` l.282, new `setAuto`), `apps/server/src/db/repositories/types.ts` (Task type gains `auto`)
- Modify: `apps/server/src/routes/tasks.ts` (PATCH body), `apps/server/src/control/tasks.ts` (`createTask`, `updateTask`), `apps/server/src/mcp/tools.ts` (`create_task`, `update_task` inputs)
- Test: `apps/server/src/db/repositories/tasks-auto.db.test.ts`, `apps/server/src/control/tasks.test.ts`

**Interfaces:**
- Produces: `Task.auto: boolean`; `TasksRepository.setAuto(taskId: string, auto: boolean): Promise<{ changed: number }>`; PATCH `/tasks/:id` and MCP `update_task` accept `auto: boolean`; `create_task` accepts `auto?: boolean`.

- [ ] **Step 1: Write the failing DB tests**

```ts
// tasks-auto.db.test.ts — run with TERMHUB_DB_TESTS=1
describe.skipIf(!process.env.TERMHUB_DB_TESTS)('tasks.auto', () => {
  it('marking an epic marks the epic and every top-level card in it', async () => {
    const { epic, a, b } = await seedEpicWithTwoCards();
    await repos.tasks.setAuto(epic.id, true);
    expect((await repos.tasks.findById(epic.id))!.auto).toBe(true);
    expect((await repos.tasks.findById(a.id))!.auto).toBe(true);
    expect((await repos.tasks.findById(b.id))!.auto).toBe(true);
  });
  it('unmarking an epic clears cards marked one by one too (spec D2)', async () => {
    const { epic, a } = await seedEpicWithTwoCards();
    await repos.tasks.setAuto(a.id, true);
    await repos.tasks.setAuto(epic.id, true);
    await repos.tasks.setAuto(epic.id, false);
    expect((await repos.tasks.findById(a.id))!.auto).toBe(false);
  });
  it('a card created in an automatic epic is born automatic', async () => {
    const { epic, projectId } = await seedEpicWithTwoCards();
    await repos.tasks.setAuto(epic.id, true);
    const c = await repos.tasks.create(projectId, { title: 'novo', epic_id: epic.id });
    expect(c.auto).toBe(true);
  });
  it('moving a card into an automatic epic marks it; moving out keeps it', async () => { /* update epic_id both ways */ });
  it('subtasks never carry the tag', async () => { /* setAuto on a subtask throws TaskRuleError('AUTO_NOT_FOR_SUBTASK') */ });
});
```

- [ ] **Step 2: Run them and see them fail** — `th 'TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- tasks-auto'` → FAIL (`auto` does not exist).
- [ ] **Step 3: Migration**

```sql
ALTER TABLE "tasks" ADD COLUMN "auto" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "tasks_project_id_auto_idx" ON "tasks" ("project_id") WHERE "auto";
```

Schema: `auto Boolean @default(false)` in `model Task`. Run `npx prisma generate -w @termhub/server`.

- [ ] **Step 4: Repository.** `setAuto` takes `lockProject`, refuses subtasks (`AUTO_NOT_FOR_SUBTASK`, add it to `TaskRuleCode` in `task-rules.ts`), updates the card; for an epic also `updateMany({ where: { projectId, epicId: id, parentId: null }, data: { auto } })`. In `insertCard`, after resolving `epicId`, read the epic's `auto` and pass `auto: input.auto ?? epicAuto` (an explicit `false` on a card in an automatic epic is ignored: the epic rules, D2). In `update`, when `epic_id` changes to an epic with `auto = true`, set `auto = true`. `createFromTicket` and `createSubtasks` are unchanged (tickets land in the default epic; subtasks never carry it).
- [ ] **Step 5: Routes and MCP.** PATCH body zod gains `auto: z.boolean().optional()`, routed to `setAuto`. MCP `update_task` gains `auto` (description: "true marks the card for automatic work (tag \"automático\"); on an epic it marks or clears every card of the epic"). `list_tasks` returns `auto`. Add a control test: `updateTask({ auto: true })` on an epic marks its children.
- [ ] **Step 6: Run the tests** — DB tests and `th 'npm test -w @termhub/server -- src/control/tasks'` → PASS; `th 'npm run typecheck -w @termhub/server'`.
- [ ] **Step 7: Commit**

```bash
git add apps/server/prisma apps/server/src/db/repositories apps/server/src/routes/tasks.ts apps/server/src/control/tasks.ts apps/server/src/mcp/tools.ts
git commit -m "Board: tag cards for automatic work, propagated by the epic"
```

### Task 3: Setup block `automation` (TER-879)

**Files:**
- Modify: `apps/server/src/setup/schema.ts` (new `automationSchema`, add to `setupSchema` l.103)
- Modify: `apps/server/src/control/integrations.ts` (`getProjectSetup` l.80 returns `automation`), `apps/server/src/mcp/tools.ts` (`get_project_setup` description)
- Test: `apps/server/src/setup/schema.test.ts`

**Interfaces:**
- Produces: `automationSchema`, `type ProjectAutomation`, `AUTONOMY_LEVELS = ['pr','merge','deploy','release'] as const`, `type AutonomyLevel`; `ProjectSetupData['automation']`.

- [ ] **Step 1: Failing tests**

```ts
it('a setup saved before the block reads automation as off with the spec defaults', () => {
  const s = normalizeSetup({ repo: null }, 2);
  expect(s.automation).toEqual({
    enabled: false, types: ['story', 'task', 'bug'], autonomy: 'release', release_paths: [], store_paths: [],
    release_workflows: [], epic_branch_pattern: 'epic/{ref}-{slug}', worktrees_dir: '~/.termhub/worktrees',
    allowed_tools: null, max_parallel: null, resume_max: 3, fix_attempts: 3, daily_budget_usd: null,
    summary_hour: null, prompts: { implementer: null, integrator: null, fixer: null },
  });
});
it('refuses an epic branch pattern without {ref}', () => { /* setupInputSchema.safeParse(...).success === false */ });
it('refuses epic and subtask in types', () => { /* only story, task, bug, spike */ });
it('keeps the other blocks when automation is invalid (normalizeSetup field-by-field fallback)', () => { /* … */ });
```

- [ ] **Step 2: Run** `th 'npm test -w @termhub/server -- src/setup/schema'` → FAIL.
- [ ] **Step 3: Implement**

```ts
export const AUTONOMY_LEVELS = ['pr', 'merge', 'deploy', 'release'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
const glob = z.string().trim().min(1).max(200);
const promptText = z.string().trim().min(1).max(3000).nullable().default(null);
export const automationSchema = z.object({
  enabled: z.boolean().default(false),
  types: z.array(z.enum(['story', 'task', 'bug', 'spike'])).min(1).default(['story', 'task', 'bug']),
  autonomy: z.enum(AUTONOMY_LEVELS).default('release'),
  release_paths: z.array(glob).max(50).default([]),
  store_paths: z.array(glob).max(50).default([]),
  release_workflows: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  epic_branch_pattern: z.string().trim().min(1).max(100).refine((p) => p.includes('{ref}'), 'use {ref}').default('epic/{ref}-{slug}'),
  worktrees_dir: z.string().trim().min(1).max(512).default('~/.termhub/worktrees'),
  allowed_tools: z.array(z.string().trim().min(1).max(200)).max(100).nullable().default(null),
  max_parallel: z.number().int().min(1).max(100).nullable().default(null),
  resume_max: z.number().int().min(0).max(10).default(3),
  fix_attempts: z.number().int().min(0).max(10).default(3),
  daily_budget_usd: z.number().positive().max(100000).nullable().default(null),
  summary_hour: z.number().int().min(0).max(23).nullable().default(null),
  prompts: z.object({ implementer: promptText, integrator: promptText, fixer: promptText }).default({}),
});
```

Add `automation: automationSchema.default({})` to `setupSchema`. `getProjectSetup` returns `{ repo, automation, integration, updated_at }`.

- [ ] **Step 4: Run** the tests → PASS; typecheck.
- [ ] **Step 5: Commit** — `git commit -m "Setup: add the automation block (off by default)"`

### Task 4: Eligibility and the ordered queue (TER-857)

**Files:**
- Create: `apps/server/src/automation/eligibility.ts`, `apps/server/src/automation/queue.ts`, `apps/server/src/routes/automation.ts`
- Modify: `apps/server/src/app.ts` (register `guarded('tasks', projectAutomationRoutes, '/api/projects')`), `apps/server/src/mcp/tools.ts` (`list_automation_queue`, resource `tasks:read`), `apps/server/src/chat/gate.ts` (add `list_automation_queue` to `readTools`)
- Test: `apps/server/src/automation/eligibility.test.ts`, `apps/server/src/automation/queue.db.test.ts`

**Interfaces:**
- Consumes: `Task.auto` (Task 2), `ProjectAutomation` (Task 3).
- Produces:

```ts
export type IneligibleReason = 'automation_off' | 'paused' | 'type_not_allowed' | 'not_in_todo' | 'no_description'
  | 'has_agent' | 'no_capable_machine' | 'repo_missing';
export const REASON_TEXT: Record<IneligibleReason, string>; // pt-BR, spec §5
export interface EligibilityInput {
  card: { type: TaskType; parent_id: string | null; auto: boolean; column_category: TaskStatus | null; description: string | null; subtask_count: number; tab_alive: boolean; active_run: boolean };
  project: { automation: ProjectAutomation; paused: boolean; repo_ready: boolean; capable_machines: number };
}
export function eligibilityOf(i: EligibilityInput): { eligible: true } | { eligible: false; reason: IneligibleReason } | null; // null = not tagged
export async function automationQueue(ctx: ControlContext, projectId: string): Promise<Array<{ task_id: string; ref: string; title: string; eligible: boolean; reason: IneligibleReason | null; reason_text: string | null }>>;
```

`GET /api/projects/:id/automation/queue` returns `{ items }`. `capable_machines` counts linked agent machines whose `agents.capabilities(id)` includes `worktree` (Task 8 defines `CAPABILITY_WORKTREE` in `@termhub/agent-protocol`; if Task 8 is not merged yet, define `CAPABILITY_WORKTREE = 'worktree'` in `packages/agent-protocol/src/messages.ts` in this task and let Task 8 reuse it).

- [ ] **Step 1: Failing pure tests** — one per row of spec §5 in that order (the first failing check wins), plus: untagged → `null`; a subtask → `null`; spike allowed only when listed in `types`; a card in `doing` → `not_in_todo`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `eligibilityOf` as a straight sequence of checks; `automationQueue` loads cards with `listByProject`, sorts by column position then card position (board order), and resolves `paused` (Task 9 adds the pause columns; until then `false`), `repo_ready` (`repo.full_name && repo.integration_id`) and `capable_machines`.
- [ ] **Step 4: DB test** — two tagged cards in two `todo` columns come out in board order; a card with `automation.enabled = false` reads `automation_off`.
- [ ] **Step 5: Run, typecheck, commit** — `git commit -m "Automation: eligibility rules and the ordered queue"`

### Task 5: Policy levels and `requiredLevel`; policy for tab agents (TER-882)

**Files:**
- Create: `apps/server/src/automation/policy.ts`
- Modify: `apps/server/src/mcp/tab-token.ts` (`TAB_TOKEN_TOOLS` gains `get_automation_policy`), `apps/server/src/mcp/tools.ts` (the tool), `apps/server/src/chat/gate.ts` (`readTools`)
- Test: `apps/server/src/automation/policy.test.ts`, `apps/server/src/mcp/tab-token.test.ts`

**Interfaces:**

```ts
export type NeededLevel = AutonomyLevel | 'store';
export function allows(level: AutonomyLevel, needed: NeededLevel): boolean; // store → always false
export function requiredLevel(i: { base: string; epicBranch: string | null; baseBranch: string; deployWorkflow: string | null; files: string[]; releasePaths: string[]; storePaths: string[] }): NeededLevel;
export function policyText(a: ProjectAutomation, deployWorkflow: string | null): string; // pt-BR, for get_automation_policy
```

Glob matching: use `picomatch` if already in the dependency tree (`npm ls picomatch -w @termhub/server`); otherwise write a 20-line matcher for `**`, `*` and literal segments with its own tests. Do not add a dependency for it.

- [ ] **Step 1: Failing tests**

```ts
it('a card PR into its epic branch needs merge', () =>
  expect(requiredLevel({ base: 'epic/TER-1-x', epicBranch: 'epic/TER-1-x', baseBranch: 'main', deployWorkflow: 'CI e Deploy', files: ['apps/server/a.ts'], releasePaths: [], storePaths: [] })).toBe('merge'));
it('into main with a deploy workflow needs deploy', () => { /* base 'main', deployWorkflow set → 'deploy' */ });
it('into main without a deploy workflow needs merge', () => { /* deployWorkflow null → 'merge' */ });
it('a release path anywhere needs release', () => { /* files ['apps/agent/package.json'], releasePaths ['apps/agent/package.json'] → 'release' */ });
it('a store path wins over everything and is never allowed', () => {
  const n = requiredLevel({ base: 'main', epicBranch: null, baseBranch: 'main', deployWorkflow: 'x', files: ['apps/mobile/app.json'], releasePaths: ['apps/mobile/**'], storePaths: ['apps/mobile/app.json'] });
  expect(n).toBe('store');
  expect(allows('release', n)).toBe(false);
});
it('levels are cumulative', () => { expect(allows('deploy', 'merge')).toBe(true); expect(allows('merge', 'deploy')).toBe(false); });
it('a tab token lists get_automation_policy', () => expect(TAB_TOKEN_TOOLS).toContain('get_automation_policy'));
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** The tab tool resolves the tab's project from the token (`ctx.token.tab`), and returns `{ enabled, autonomy, text: policyText(...) }`. `policyText` says, in pt-BR, what the level covers and ends with "O merge é feito pelo termhub quando o CI fica verde e a política permite; abra o PR e avise com report_card."
- [ ] **Step 4: Run, typecheck, commit** — `git commit -m "Automation: autonomy levels and the policy tool for tabs"`

### Task 6: Web — tag, badge, reason and the Setup section (TER-858 web, TER-856, TER-880 web)

**Files:**
- Modify: `apps/web/src/lib/types.ts` (Task `auto`, setup `automation`), `apps/web/src/components/TasksBoard.tsx` (`TaskCard` l.419: badge), `apps/web/src/components/TaskEditor.tsx` (toggle), `apps/web/src/components/BacklogView.tsx` (badge on epics), `apps/web/src/components/SetupForm.tsx` (embed the section)
- Create: `apps/web/src/components/AutomationSetup.tsx`, `apps/web/src/lib/automation.ts` (queue fetch)

**Interfaces:**
- Consumes: PATCH `/tasks/:id { auto }` (Task 2), setup `automation` (Task 3), `GET /api/projects/:id/automation/queue` (Task 4).

UI copy (pt-BR, exact):
- Badge: `automático`. Toggle in the editor: `Trabalho automático` with help `O termhub pega este card sozinho quando ele estiver numa coluna "a fazer".` On an epic: `Marca todos os cards deste épico (os novos também).`
- Ineligible: the badge gets a warning dot and a tooltip with `reason_text`.
- Setup section title `Trabalho automático`; switch `Ligar trabalho automático neste projeto`; `Tipos de card` (Story, Tarefa, Bug, Spike); `Até onde os agentes vão sozinhos` with options `Só código e PR`, `Merge com CI verde`, `Deploy`, `Publicação (npm, OTA)`; note `Envio às lojas nunca é automático.`; inputs for release paths, store paths, release workflows, epic branch pattern, worktrees dir, max parallel (`Sem limite` when empty), resume and fix caps, daily budget (`Desligado` when empty), summary hour.
- Turning automation on, or raising the level to Deploy or Publicação, opens a confirm dialog: `Os agentes vão abrir PRs, fazer merge e {nível} sem perguntar. Confirmar?`.

- [ ] **Step 1:** Implement the badge and toggle; the board reloads the queue with the cards (one request per board load) and maps `task_id → reason_text`.
- [ ] **Step 2:** Implement `AutomationSetup.tsx` as a controlled block of `SetupForm` (same `patch('automation', …)` pattern as `approvals`, l.343). Pages keep full width (no `max-w-*`).
- [ ] **Step 3:** `th 'npm run build -w @termhub/web'` → OK. Check the board and the Setup with the Playwright harness against the mocked API (memory "Harness Playwright para layout do web"); attach the screenshots to the PR.
- [ ] **Step 4: Commit** — `git commit -m "Web: automatic-work tag, badge and Setup section"`

### Task 7: App — contract, Setup section, badge (TER-880 app, TER-858 app)

**Files:**
- Create: `packages/mobile-api/src/automation.ts` (zod: `AutomationSetup`, `AutomationQueueItem`, `PauseState`), export from the package index
- Create: `apps/mobile/src/features/automation/{model,viewmodel,view}/*`, `apps/mobile/app/project-automation/[projectId].tsx`
- Modify: `apps/mobile/src/services/api/client.ts` (setup GET/PUT already exist at l.304-306 for AI; add the automation calls), `apps/mobile/src/features/progress/*` (badge `automático` on cards), the project screen that links to `project-ai` (add a row `Trabalho automático`)
- Modify: `apps/server/src/routes/` mobile setup route (`/api/m/v1/projects/:id/setup/automation` GET/PUT) with PIN required when enabling or raising the level to `deploy`/`release` (same proof check as `routes/m-chat.ts` `proofOk` l.81)
- Test: `apps/mobile/src/features/automation/viewmodel/*.test.ts`, server route test

The mobile app has no board: the tag toggle lives on the card rows of Progresso (long-press → `Trabalho automático`), and the badge shows there.

- [ ] **Step 1:** Contract + server route (+ test: raising to `deploy` without a PIN proof → 403 `PIN_REQUIRED`; lowering never asks).
- [ ] **Step 2:** View model test: enabling shows the confirm sheet; the PIN sheet opens when the server answers `PIN_REQUIRED`.
- [ ] **Step 3:** Screens with the same pt-BR copy as Task 6.
- [ ] **Step 4:** `th 'npm test -w @termhub/mobile-api && npm test -w @termhub/mobile -- automation'` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Mobile: automatic-work setup and badge"`

---

## Phase 2 — Machine agent

### Task 8: Agent RPC `git.worktree.ensure` / `git.worktree.remove` (TER-868)

**Files:**
- Modify: `packages/agent-protocol/src/rpc.ts` (two entries in `RPC`, timeout 120 s for ensure — a fetch can be slow), `packages/agent-protocol/src/messages.ts` (`CAPABILITY_WORKTREE = 'worktree'`, advertised in `hello`)
- Create: `apps/agent/src/rpc/worktree.ts`; Modify: `apps/agent/src/rpc/index.ts`
- Modify: `apps/agent/package.json`, `apps/agent/src/version.ts` (next minor), `apps/server/src/agent/errors.ts` (`WORKTREE_MIN_AGENT_VERSION`)
- Test: `packages/agent-protocol/src/rpc.test.ts`, `apps/agent/src/rpc/worktree.test.ts`

**Interfaces:**

```ts
// params / results (zod in rpc.ts)
'git.worktree.ensure': { repo_dir: string; root: string; path: string; branch: string; base: string } → { path: string; head: string; created: boolean }
'git.worktree.remove': { repo_dir: string; root: string; path: string; force: false } → { removed: boolean; dirty: boolean }
```

Rules: expand `~` in `root` and `repo_dir`; `path` must resolve inside `root` (refuse `..` and symlinks out, error `PATH_OUTSIDE_ROOT`); `branch` and `base` must match `^[A-Za-z0-9._/-]{1,200}$` and not start with `-`; run `git -C repo_dir fetch origin <base>` then, if `path` is not a worktree, `git -C repo_dir worktree add -B <branch> <path> origin/<base>`; if it is one on another branch → `WORKTREE_CONFLICT`. `remove` refuses a dirty worktree (`git -C path status --porcelain` non-empty → `{ removed: false, dirty: true }`). Use `execFile('git', argv)` only.

- [ ] **Step 1: Failing agent tests** with a temp bare repo as `origin`: ensure creates the worktree on a new branch from `origin/main`; calling it twice returns `created: false`; another branch at the same path → `WORKTREE_CONFLICT`; `path: root + '/../x'` → `PATH_OUTSIDE_ROOT`; branch `--upload-pack=x` → refused; remove on a dirty tree → `dirty: true`, tree kept.
- [ ] **Step 2: Run** `th 'npm test -w @termhub/agent -- worktree'` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `th 'npm test -w @termhub/agent-protocol'` and the version sync test.
- [ ] **Step 5: Commit** — `git commit -m "Agent: git worktree ensure/remove RPC (capability worktree)"`. After merge, check the "Publish @termhub/agent" run (filter by `workflowName`) and `npm pack @termhub/agent@<version>` for `dist/rpc/worktree.js` (CLAUDE.md).

---

## Phase 3 — The brake and the event log (before the engine)

### Task 9: Pause (global and per project) and `automation_events`, server side (TER-893)

**Files:**
- Modify: `apps/server/prisma/schema.prisma`; Create: `apps/server/prisma/migrations/<ts>_automation_pause_events/migration.sql`
- Create: `apps/server/src/db/repositories/automation-pauses.ts`, `apps/server/src/db/repositories/automation-events.ts` (register both in `db/repositories/index.ts`)
- Create: `apps/server/src/automation/events.ts` (`recordEvent` + `automationBus`), `apps/server/src/automation/pause.ts`
- Modify: `apps/server/src/routes/automation.ts` (pause/resume/events), `apps/server/src/mcp/tools.ts` (`pause_automation`, `resume_automation`, `list_automation_events`), `apps/server/src/chat/gate.ts` (`pause_automation` and `list_automation_events` → `self_mediated`/`read`; `resume_automation` → `write`), `apps/server/src/monitor/ws.ts` or the existing user WS (`automation` frames), `apps/server/src/automation/queue.ts` (`paused` from the repository)
- Test: `apps/server/src/automation/pause.test.ts`, `apps/server/src/db/repositories/automation-events.db.test.ts`

**Interfaces:**

```sql
ALTER TABLE "users" ADD COLUMN "automation_paused_at" TIMESTAMPTZ, ADD COLUMN "time_zone" TEXT;
ALTER TABLE "projects" ADD COLUMN "automation_paused_at" TIMESTAMPTZ;
CREATE TABLE "automation_events" (
  "id" TEXT PRIMARY KEY, "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "task_id" TEXT REFERENCES "tasks"("id") ON DELETE SET NULL, "run_id" TEXT, "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}', "created_at" TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX "automation_events_project_created_idx" ON "automation_events" ("project_id", "created_at" DESC);
```

```ts
export type AutomationEventKind = 'run_started' | 'run_resumed' | 'run_done' | 'run_blocked' | 'question_answered' | 'escalated'
  | 'pr_opened' | 'merged' | 'merge_needs_approval' | 'deploy_ok' | 'deploy_failed' | 'release_ok' | 'release_failed'
  | 'quota_hit' | 'quota_reset' | 'paused' | 'resumed' | 'budget_hit';
export async function recordEvent(repos: Repositories, e: { project_id: string; task_id?: string | null; run_id?: string | null; kind: AutomationEventKind; payload?: Record<string, string | number | boolean | null> }): Promise<void>;
export const automationBus: { publish(e: AutomationEvent & { owner_id: string }): void; subscribe(fn): () => void };
export async function isPaused(repos: Repositories, ownerId: string, projectId: string): Promise<boolean>;
export async function pauseAutomation(ctx: ControlContext, i: { scope: 'all' | string; interrupt?: boolean }): Promise<{ paused_at: string }>;
export async function resumeAutomation(ctx: ControlContext, i: { scope: 'all' | string }): Promise<void>;
```

`interrupt: true` sends Escape (existing `send_key` path) to every tab with an active run of that scope; Task 17 wires the run list, so in this task `interrupt` only records the request on the event and Task 17 adds the keys (its test covers it). Events are retained 30 days (add the purge to the hourly `purge` in `app.ts:312`).

- [ ] **Step 1: Failing tests** — `isPaused` true for a user pause and for a project pause, false otherwise; pause then resume records `paused` then `resumed`; the payload type refuses nested objects (compile-time) and `recordEvent` drops strings over 500 chars (run-time).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** migration, repositories, functions, routes (`POST /api/automation/pause`, `POST /api/automation/resume`, `GET /api/projects/:id/automation/events?before=`), MCP tools, WS frame `{ type: 'automation', event }` to the owner's sockets.
- [ ] **Step 4: Run, typecheck, commit** — `git commit -m "Automation: pause switch and event log"`

### Task 10: "Pausar tudo" on the web, the app and in the chat (TER-893, clients)

**Files:**
- Create: `apps/web/src/components/PauseAutomationButton.tsx`; Modify: the web header component and `ProgressPanel.tsx`
- Modify: `packages/mobile-api/src/automation.ts` (`PauseState`), `apps/mobile/src/features/automation/*`, `apps/mobile/src/features/settings/*` and `features/progress/*`
- Modify: `apps/server/src/chat/concierge-prompt.ts` (one line: "Quando a pessoa pedir para pausar o automático, use pause_automation sem pedir confirmação.")

Copy: button `Pausar automático` / `Retomar automático`; menu item `Pausar e interromper as abas`; banner while paused `Automático pausado desde {hora}.`

- [ ] **Step 1:** Web button reads `GET /api/automation/state` (add it in this task: `{ paused_at, projects: [{ id, paused_at }] }`) and listens to the `automation` WS frame; the state flips in under 5 s on every open client (manual check with two browsers; note it in the PR).
- [ ] **Step 2:** App: same state in Settings and Progresso; pausing never asks for the PIN; resuming asks for confirmation (not PIN).
- [ ] **Step 3:** Builds and tests (`@termhub/web`, `@termhub/mobile -- automation`) → PASS.
- [ ] **Step 4: Commit** — `git commit -m "Web, Mobile: pause and resume automatic work"`

---

## Phase 4 — Dispatcher

### Task 11: `automation_runs` and `ai_account_exhaustions` (TER-861, data)

**Files:**
- Modify: `apps/server/prisma/schema.prisma`; Create: `apps/server/prisma/migrations/<ts>_automation_runs/migration.sql`
- Create: `apps/server/src/db/repositories/automation-runs.ts`, `apps/server/src/db/repositories/ai-account-exhaustions.ts`
- Test: `apps/server/src/db/repositories/automation-runs.db.test.ts`

**Interfaces:**

```sql
CREATE TABLE "automation_runs" (
  "id" TEXT PRIMARY KEY, "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "task_id" TEXT NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE, "role" TEXT NOT NULL,
  "status" TEXT NOT NULL, "waiting_reason" TEXT, "tab_id" TEXT, "machine_id" TEXT, "account_id" TEXT,
  "branch" TEXT, "worktree_path" TEXT, "resume_count" INT NOT NULL DEFAULT 0, "fix_count" INT NOT NULL DEFAULT 0,
  "claimed_by" TEXT NOT NULL, "heartbeat_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "started_at" TIMESTAMPTZ, "ended_at" TIMESTAMPTZ, "created_at" TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX "automation_runs_one_active_per_task" ON "automation_runs" ("task_id")
  WHERE "status" IN ('queued', 'starting', 'running', 'waiting');
CREATE INDEX "automation_runs_project_status_idx" ON "automation_runs" ("project_id", "status");
CREATE TABLE "ai_account_exhaustions" ("account_id" TEXT PRIMARY KEY REFERENCES "ai_accounts"("id") ON DELETE CASCADE,
  "until" TIMESTAMPTZ NOT NULL, "reason" TEXT NOT NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT now());
```

```ts
export type RunRole = 'implementer' | 'integrator' | 'fixer';
export type RunStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'done' | 'blocked' | 'failed' | 'cancelled';
export class AutomationRunsRepository {
  claim(i: { project_id: string; task_id: string; role: RunRole; instance: string }): Promise<AutomationRun | null>; // null = already active (unique violation)
  update(id: string, patch: Partial<Pick<AutomationRun, 'status' | 'waiting_reason' | 'tab_id' | 'machine_id' | 'account_id' | 'branch' | 'worktree_path' | 'started_at' | 'ended_at'>>): Promise<void>;
  bump(id: string, field: 'resume_count' | 'fix_count'): Promise<number>;
  heartbeat(instance: string): Promise<void>;                                   // every active run claimed by instance
  takeOver(instance: string, staleBefore: Date): Promise<AutomationRun[]>;     // conditional UPDATE … WHERE heartbeat_at < $2 RETURNING
  activeByTab(tabId: string): Promise<AutomationRun | null>;
  activeByProject(projectId: string): Promise<AutomationRun[]>;
  countActive(projectId: string): Promise<number>;
}
export class AiAccountExhaustionsRepository { mark(accountId: string, until: Date, reason: string): Promise<void>; activeIds(now: Date): Promise<Set<string>>; clearExpired(now: Date): Promise<string[]>; }
```

- [ ] **Step 1: Failing DB tests** — two concurrent `claim` on the same task: exactly one row; after `update(status: 'done')` a new claim succeeds; `takeOver` returns runs with an old heartbeat only once when two instances race (both call it; the union has no duplicate); `activeIds` ignores expired rows.
- [ ] **Step 2–4:** Run → FAIL, implement (catch Prisma `P2002` in `claim` → `null`), run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: runs table with one active run per card"`

### Task 12: GitHub write client (TER-872, support)

**Files:**
- Create: `apps/server/src/integrations/github-write.ts`, `apps/server/src/integrations/github-write.test.ts`

**Interfaces:**

```ts
export interface GithubWriteClient {
  branchSha(token: string, repo: string, branch: string): Promise<string | null>;
  createBranch(token: string, repo: string, branch: string, fromSha: string): Promise<'created' | 'exists'>;
  openPull(token: string, repo: string, i: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }>;
  findOpenPull(token: string, repo: string, head: string, base: string): Promise<{ number: number; url: string } | null>;
  pull(token: string, repo: string, n: number): Promise<{ mergeable: boolean | null; mergeable_state: string; head_sha: string; base_ref: string }>;
  files(token: string, repo: string, n: number): Promise<string[]>;           // paginated, up to 3000
  merge(token: string, repo: string, n: number, i: { sha: string; title: string; method: 'squash' | 'merge' }): Promise<{ merged: boolean; sha: string | null }>;
}
export function createGithubWriteClient(fetchImpl?: typeof fetch): GithubWriteClient;
```

Reuse `GithubCiError` and the `failure()` mapping from `github-ci.ts` (export `failure` from there instead of copying it). `merge` passes `sha` so GitHub refuses if the head moved since CI was checked (409 → `{ merged: false }`). The token is only ever a header and is never logged.

- [ ] **Step 1: Failing tests** with a fake `fetch`: each call hits the right URL and method; 422 on `createBranch` "Reference already exists" → `'exists'`; 409 on merge → `{ merged: false }`; 403 with `x-ratelimit-remaining: 0` → `GithubCiError('rate_limited')`; `files` follows `Link: rel="next"`.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Integrations: GitHub client for branches, pulls and merges"`

### Task 13: Branches and workspaces on the server; `base_ref` in the CI sync (TER-869)

**Files:**
- Create: `apps/server/src/automation/branches.ts`
- Modify: `apps/server/prisma/schema.prisma` + migration `<ts>_task_pull_request_base_ref` (`base_ref TEXT`, `changed_level TEXT`), `apps/server/src/integrations/github-ci.ts` (`GithubPull.base_ref`), `apps/server/src/ci/sync.ts` (store it), `apps/server/src/db/repositories/task-pull-requests.ts`
- Test: `apps/server/src/automation/branches.test.ts`, `apps/server/src/ci/sync.test.ts`

**Interfaces:**

```ts
export function slugOf(title: string): string;                                  // ascii, lower, dashes, ≤ 40 chars
export function epicBranchName(pattern: string, epic: { ref: string; title: string }): string;
export function cardBranchName(pattern: string, card: { ref: string; title: string }): string; // repo.branch_pattern, {ticket} = ref
export function targetOf(card: { epic: { auto: boolean; ref: string; title: string } | null }, setup: ProjectSetupData): { base: string; epicBranch: string | null };
export async function ensureEpicBranch(deps: { gh: GithubWriteClient; token: string; repo: string }, baseBranch: string, epicBranch: string): Promise<void>;
export async function ensureWorkspace(machine: Machine, i: { repoDir: string; root: string; projectId: string; ref: string; branch: string; base: string }): Promise<{ path: string; created: boolean }>; // agentRpc('git.worktree.ensure'), path = <root>/<projectId>/<ref>
```

- [ ] **Step 1: Failing tests** — `slugOf('termhub agêntico: trabalho automático!')` → `termhub-agentico-trabalho-automatico`; `epicBranchName('epic/{ref}-{slug}', …)` → `epic/TER-852-termhub-agentico-trabalho-automatico` (trimmed to 40 chars of slug); a card in a non-automatic epic targets `repo.base_branch` with `epicBranch: null` (D8); `ensureEpicBranch` creates from the base head and treats `'exists'` as success; `ensureWorkspace` on an agent without the capability → `ControlError('AGENT_TOO_OLD')`; the CI sync stores `base_ref` from the pull.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: branch names, epic branch and card worktrees"`

### Task 14: `startAgent` and `openTab` take a cwd, permission flags and the setup command (TER-870)

**Files:**
- Modify: `apps/server/src/control/terminals.ts` (`openTab` l.60: optional `cwd`), `apps/server/src/terminal/session-ops.ts` (`ensureSession` uses it), `apps/server/src/db/repositories/tabs.ts` + migration `<ts>_tab_cwd` (`tabs.cwd TEXT NULL`, used when the session is recreated), `apps/server/src/control/agents.ts` (`startAgent` internal options, `launchLine` flags)
- Test: `apps/server/src/control/agents.test.ts`, `apps/server/src/control/terminals.test.ts`

**Interfaces:**

```ts
// internal only: the MCP tool's zod input does not change
export interface StartAgentInternal { cwd?: string; permission?: { mode: 'acceptEdits'; allowedTools: string[] }; setupCommand?: string | null; promptIsFinal?: boolean }
export async function startAgent(ctx: ControlContext, input: StartAgentInput, internal?: StartAgentInternal): Promise<StartAgentResult>;
export const DEFAULT_AUTOMATION_TOOLS: string[]; // spec D19: 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push origin HEAD:*)', 'Bash(git fetch:*)', 'Bash(git merge:*)', 'Bash(gh pr create:*)', 'Bash(gh pr view:*)', 'Bash(gh pr checks:*)', 'Bash(npm test:*)', 'Bash(npm run:*)'
```

`launchLine` for Claude gains ` --permission-mode acceptEdits --allowedTools <each quoted>` when `permission` is set; Codex ignores it (automation runs only Claude in this epic; the dispatcher filters accounts by provider `claude`). With `setupCommand`, the typed line is `<setupCommand> ; <cli line>` (both pieces already shell-safe: `setupCommand` comes from the owner's setup and is typed as the owner would; document that in a comment). `cwd` must be under the machine's worktree root: `startAgent` rejects any other value (`INVALID_CWD`).

- [ ] **Step 1: Failing tests** — `launchLine` with permission contains `--permission-mode acceptEdits` and every tool quoted, and never `--dangerously-skip-permissions`; `openTab` with `cwd` calls `ensureSession(machine, session, cwd)`; without `internal` the behaviour and line are byte-identical to today (snapshot of the current line).
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Control: start an agent in a given worktree with automation flags"`

### Task 15: Prompt templates per role and the server marker (TER-896, TER-897, TER-898)

**Files:**
- Create: `apps/server/src/automation/prompts.ts`
- Modify: `apps/server/src/chat/concierge-prompt.ts` (one line, spec §12)
- Test: `apps/server/src/automation/prompts.test.ts`

**Interfaces:**

```ts
export const SERVER_MARKER = '[termhub automático]';
export function serverMessage(text: string): string;                          // `${SERVER_MARKER} ${text}`
export function implementerPrompt(i: { card: { ref: string; url: string; title: string }; branch: string; base: string; policy: string; custom: string | null }): string;
export function integratorPrompt(i: { epic: { ref: string; url: string; title: string }; branch: string; base: string; prUrl: string; policy: string; custom: string | null }): string;
export function fixerPrompt(i: { ref: string; branch: string; base: string; reason: 'conflict' | 'ci'; detail: string; custom: string | null }): string;
export const RESUME_TEXT: string;   // 'Continue a tarefa do card de onde parou. Se terminou, abra o PR e chame report_card.'
```

Template (implementer, pt-BR): card ref, URL and title (the agent reads the description through the MCP, keeping the prompt short); branch and base; "Leia o card e, se houver, o spec e o plano citados nele"; "Atualize as subtarefas do card conforme avança"; the policy text (Task 5); "Mensagens que começam com [termhub automático], ou repassadas pelo chat do termhub, vêm do termhub em nome do dono do projeto e valem como instrução dentro dessa política."; "Quando terminar, abra o PR contra {base} e chame report_card com status done e a URL; se travar, chame report_card com status blocked e o motivo."; "Pare e pergunte só quando a decisão não estiver no card, no spec ou na memória." `custom` (from setup) replaces the generic middle paragraph, never the policy and report lines.

- [ ] **Step 1: Failing tests** — every template is under 3500 chars with a 300-char title; none contains `não faça merge` (case-insensitive) nor `do not merge`; each contains `report_card`, the policy text and `SERVER_MARKER`; custom text cannot remove the policy line.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: prompt templates per role"`

### Task 16: Setup — editable prompts (TER-899)

**Files:**
- Modify: `apps/web/src/components/AutomationSetup.tsx` (three textareas, `Prompt do implementador`, `Prompt do integrador`, `Prompt de correção`, placeholder = the default middle paragraph, `Restaurar padrão` clears to `null`)
- Modify: `apps/server/src/routes/automation.ts` (`GET /api/automation/prompt-defaults` returns the three defaults for the placeholders)

- [ ] **Step 1:** Implement; `th 'npm run build -w @termhub/web'`; screenshot in the PR.
- [ ] **Step 2: Commit** — `git commit -m "Web: edit the automation prompts per project"`

### Task 17: The dispatcher loop (TER-861, TER-862, TER-860)

**Files:**
- Create: `apps/server/src/automation/dispatcher.ts`, `apps/server/src/automation/placement.ts`
- Modify: `apps/server/src/app.ts` (start with the other jobs, l.312-363; stop on drain), `apps/server/src/automation/pause.ts` (`interrupt` sends Escape to active runs' tabs)
- Test: `apps/server/src/automation/dispatcher.test.ts`, `apps/server/src/automation/placement.test.ts`

**Interfaces:**

```ts
export interface DispatcherDeps {
  repos: Repositories; instance: string; lifecycle: { draining: boolean }; now(): Date;
  startAgent: typeof startAgent; ensureWorkspace: typeof ensureWorkspace; ensureEpicBranch: typeof ensureEpicBranch;
  gh: GithubWriteClient; usage: (accountId: string) => Promise<number | null>; // peak utilization, from getAccountUsage
}
export function startDispatcher(deps: DispatcherDeps, opts?: { tickMs?: number }): { tick(reason: string): Promise<void>; stop(): void }; // tickMs default 15000
export async function placeRun(deps: DispatcherDeps, project: Project, setup: ProjectSetupData): Promise<{ machine: Machine; account: AiAccount } | { waiting: 'no_machine' | 'no_account' | 'machine_offline' }>;
```

Tick (spec §8): skip when `lifecycle.draining`; list owners with an enabled project (`projectSetup.listWithAutomation()`, add it next to `listWithAutoSync`); per project skip when paused; respect `max_parallel` (`countActive`); for each eligible card: `claim` → `placeRun` (agent machines online with `CAPABILITY_WORKTREE`, Claude accounts of the project setup in order, minus `exhaustions.activeIds`, with utilization `< SWAP_MAX_UTILIZATION`) → when no place, delete the run row and keep the reason in memory for the queue API (`waiting_reason` of the card) → `ensureEpicBranch` when the card's epic is automatic → `ensureWorkspace` → `startAgent(controlContextFor(repos, owner), { project_id, machine_id, account_id, task_id, prompt }, { cwd, permission, setupCommand, promptIsFinal: true })` → run `running` + `recordEvent('run_started')`. Any thrown error marks the run `failed` with the error code and records `run_blocked`; the card is not retried by the next tick for 10 minutes (in-memory backoff per card; a restart clears it, which is fine). Event triggers: `automationBus`/task tag change/setup saved/resume call `tick(reason)` (debounced 1 s). A heartbeat interval (30 s) calls `heartbeat(instance)` and `takeOver(instance, now - 2 min)`.

- [ ] **Step 1: Failing tests (fakes for every dep)** — an eligible card becomes one `startAgent` call with the worktree cwd and `task_id`; two dispatchers ticking at once start it once; draining → no call; paused → no call; `max_parallel: 1` with one active run → no call; no capable machine → no call and the queue reads `no_capable_machine`; all accounts exhausted → `no_account`; `automation.enabled = false` → no call and no DB writes; a thrown `startAgent` → run `failed`, `run_blocked` event, no retry within 10 min; `pause({ interrupt: true })` sends Escape to the active runs' tabs.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: dispatcher that starts agents on eligible cards"`

### Task 18: Following a run: resume, restart, `report_card`, the PR fallback (TER-863)

**Files:**
- Create: `apps/server/src/automation/follower.ts`
- Modify: `apps/server/src/mcp/tab-token.ts` (`report_card` in `TAB_TOKEN_TOOLS`), `apps/server/src/mcp/tools.ts` (the tool), `apps/server/src/app.ts` (subscribe to `monitorBus`)
- Test: `apps/server/src/automation/follower.test.ts`

**Interfaces:**

```ts
export function startFollower(deps: FollowerDeps): () => void;       // monitorBus.subscribe
export async function onTabChange(deps: FollowerDeps, change: TabStateChange): Promise<void>;
export async function reportCard(ctx: ControlContext, i: { status: 'done' | 'blocked'; pr_url?: string; reason?: string }): Promise<{ ok: true }>; // the tab's run, from ctx.token.tab
```

`report_card` is a tab-token tool (add it to `TAB_TOKEN_TOOLS`; its `allowedIf` accepts only a tab token whose tab has an active run, so the read/memory scopes of the tab token are not widened for anything else). Rules (spec D15, D17): only tabs with an active run; `waiting_background` and `working` → nothing; `waiting_input` with an open question card → nothing (Task 21 owns it); `waiting_input` after Stop with no card → if the CI sync has an open PR whose `head_ref` is the run's branch → run `done` (`run_done`, `pr_opened`); else if `resume_count < resume_max` → `bump` + `sendInput(serverMessage(RESUME_TEXT))` + `run_resumed`; else → Task 23's `wakeOrEscalate`. `idle` with `AGENT_EXITED_TEXT` → restart once (`startAgent` in the same cwd with `RESUME_PROMPT`); a second exit → `blocked`. `report_card done` → run `done`, card stays where the agent put it; `blocked` → run `blocked` + escalation (Task 24). Every typed message checks `isPaused` first.

- [ ] **Step 1: Failing tests** — one per rule above; `resume_max: 0` escalates on the first stop; a paused project types nothing; `report_card` from a tab without a run → `ControlError('NO_RUN')`.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: resume stopped tabs and end runs on report or PR"`

### Task 19: Rate limits — exhausted accounts and resume after the reset (TER-864)

**Files:**
- Create: `apps/server/src/automation/quota.ts`
- Modify: `apps/server/src/automation/follower.ts` (a rate-limited tab), `apps/server/src/automation/dispatcher.ts` (a timer that clears expired exhaustions and ticks)
- Test: `apps/server/src/automation/quota.test.ts`

**Interfaces:**

```ts
export async function onRateLimit(deps: FollowerDeps, run: AutomationRun, tab: Tab): Promise<void>;
export function resetAt(usage: AccountUsage | null, now: Date): Date;     // the soonest window reset ≥ now, else now + 1 h
```

When a run's tab gets `rate_limited_at` (the follower sees `waiting_input` with `RATE_LIMIT_TEXT`): `exhaustions.mark(account, resetAt(...), 'rate_limit')`, event `quota_hit`; if `autoSwapOnLimit` swapped the tab (existing, `control/account-swap.ts:267`), update the run's `account_id` and do nothing else; otherwise run `waiting` (`quota`). On each dispatcher tick, `clearExpired` → for each run `waiting/quota` whose account is clear: `sendInput(serverMessage(RESUME_PROMPT))`, run `running`, event `quota_reset`. A run is never resumed while its account is in `activeIds`.

- [ ] **Step 1: Failing tests** — `resetAt` picks the soonest future reset; unknown usage → +1 h; a limited tab without swap waits and is not resumed by the Task 18 rule; after the reset it is resumed once; with swap the account id changes and nothing is typed.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: mark exhausted accounts and resume after the reset"`

### Task 20: Dispatcher integration tests — two colours, restart, many cards (TER-865)

**Files:**
- Create: `apps/server/src/automation/dispatcher.db.test.ts`

- [ ] **Step 1:** With a real database and fakes for the agent and GitHub: two dispatcher instances (`instance: 'blue'`, `'green'`) ticking concurrently over 10 eligible cards start exactly 10 runs, no card twice; stopping `blue` and advancing time by 3 min makes `green` take over its runs (heartbeats), with no second `startAgent`; a dispatcher started on an existing set of `running` runs (boot) starts nothing for them; 20 eligible cards with no ceiling start 20 runs (M1).
- [ ] **Step 2:** `th 'TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- dispatcher.db'` → PASS (fix the code under test if not, in this PR).
- [ ] **Step 3: Commit** — `git commit -m "Automation: integration tests for the dispatcher across colours"`

---

## Phase 5 — Answers and escalation

### Task 21: Choice questions in automatic tabs (TER-885)

**Files:**
- Create: `apps/server/src/automation/answers.ts`
- Modify: `apps/server/src/chat/tab-questions.ts` (`openTabQuestion` ~l.108: after `maybeScheduleRepeat`, call `automationAnswer` when the tab has an active run), `apps/server/src/chat/wake.ts` (an `automatic: true` wake skips the "Responder sozinho" check and uses its own hourly budget `AUTOMATION_WAKE_MAX_PER_HOUR`, default 30, in `config.ts`)
- Test: `apps/server/src/automation/answers.test.ts`

**Interfaces:**

```ts
export async function automationAnswer(deps: AnswerDeps, q: TabQuestionRow, run: AutomationRun): Promise<'repeat' | 'recommended' | 'woken' | 'escalated'>;
export function recommendedOption(payload: ChoicePayload): string | null;    // the single option whose label ends with "(Recomendado)" or "(Recommended)"
```

Order (spec D18): a repeat already scheduled by memory → `'repeat'`; else `recommendedOption` when `autoAnswerBlocked(blocklistParts(...))` is false and the card holds a single question → `scheduleAutoAnswer` with `by: 'automation'` and the usual 60 s countdown → `'recommended'`; else wake the chat with `automatic: true` → `'woken'`; else (budget spent, or the wake fails) → Task 24's `escalate` → `'escalated'`. Every path records `question_answered` or `escalated`.

- [ ] **Step 1: Failing tests** — repeat wins; recommended is chosen and scheduled; a "(Recomendado)" option whose label says "deploy" is not chosen (blocklist); two "(Recomendado)" options → none; multi-question cards skip the recommended path; budget spent → escalated; a tab without a run → untouched (manual tabs keep today's behaviour).
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: answer choice questions in automatic tabs"`

### Task 22: Permission requests follow the project policy (TER-886)

**Files:**
- Modify: `apps/server/src/automation/answers.ts` (`automationPermission`), `apps/server/src/chat/tab-questions.ts` (call it for `permission` cards of tabs with a run)
- Test: `apps/server/src/automation/answers.test.ts`

**Interfaces:**

```ts
export function permissionAllowed(req: { tool: string; command: string | null }, allowed: string[], level: AutonomyLevel): boolean;
export async function automationPermission(deps: AnswerDeps, q: TabQuestionRow, run: AutomationRun): Promise<'allowed' | 'escalated'>;
```

`permissionAllowed` matches the request against the Claude Code rule syntax used in `allowed_tools` (`Tool` or `Tool(prefix:*)`). A command matching `autoAnswerBlocked` is never allowed (force pushes, recursive deletes, container removal, `gh pr merge` — merging is the server's job, D5). Allowed → the existing answer path (`chat/tab-question-answer.ts`) with "allow once"; else escalate.

- [ ] **Step 1: Failing tests** — `Bash(npm test:*)` allows `npm test -w x`; `gh pr merge 3` is refused at every level; a container removal command is refused; a tool outside the list escalates.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: answer permission requests by project rules"`

### Task 23: A tab that stopped without a question (TER-887)

**Files:**
- Modify: `apps/server/src/automation/follower.ts` (`wakeOrEscalate`), `apps/server/src/chat/wake.ts` (`wakeForStoppedTab`: the wake text names the card and asks the chat to read the last answer and either `send_input` a continuation or call `escalate_automation_run`)
- Modify: `apps/server/src/mcp/tools.ts` (`escalate_automation_run { run_id, reason }`, class `self_mediated`)
- Create: migration `<ts>_automation_runs_woken_at` (`automation_runs.woken_at TIMESTAMPTZ NULL`)
- Test: `apps/server/src/automation/follower.test.ts`

- [ ] **Step 1: Failing tests** — after `resume_max` stops, the chat is woken once per run (persisted in `woken_at`); a second stop after the wake escalates; the wake text is pt-BR and starts with "Automático:" like `wakeText()`.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: wake the chat for a tab that keeps stopping"`

### Task 24: Escalation with a reason, push, and the slot freed (TER-888)

**Files:**
- Modify: `apps/server/src/automation/answers.ts` (`escalate`), `apps/server/src/mobile/push-text.ts` (`automationEscalationText`), `apps/server/src/mobile/push.ts` (handle `escalated` events), `apps/server/src/automation/dispatcher.ts` (`waiting` runs with reason `question` or `escalated` do not count in `max_parallel`)
- Modify: `apps/server/src/mcp/tools.ts` (`resume_automation_run { run_id }`, class `write`)
- Test: `apps/server/src/automation/answers.test.ts`, `apps/server/src/mobile/push.test.ts`

**Interfaces:**

```ts
export async function escalate(deps: AnswerDeps, run: AutomationRun, reason: string): Promise<void>; // run waiting('escalated'), event, chat line, push
```

Copy: chat line `Automático parou em {ref}: {motivo}`; push title `{projeto} precisa de você`, body `{ref} parou: {motivo}`. Answering the open card, or `resume_automation_run`, sets the run back to `running`.

- [ ] **Step 1: Failing tests** — escalation sets `waiting`, records `escalated`, sends one push to an offline device; an escalated run does not block `max_parallel: 1`; answering the card resumes.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: escalate to the owner and free the slot"`

---

## Phase 6 — Integration and release

Task 1 (spike) must be merged before Task 25.

### Task 25: The merge executor and approval cards (TER-883)

**Files:**
- Create: `apps/server/src/automation/merge.ts`
- Modify: `apps/server/src/ci/sync.ts` (after `syncProjectCi` writes, call `runMergeExecutor(project)` when automation is on), `apps/server/src/chat/gate.ts` (`automation_merge` in `irreversibleTools`), `apps/server/src/chat/gate-runtime.ts` (an exported `askForAutomation(ownerId, projectId, payload)` that creates the pending card through the same code as `ask()`, l.332), the approval handler (on approve → `mergeApproved`)
- Test: `apps/server/src/automation/merge.test.ts`

**Interfaces:**

```ts
export async function runMergeExecutor(deps: MergeDeps, projectId: string): Promise<void>;
export async function mergeApproved(deps: MergeDeps, actionId: string): Promise<void>;
```

For each open PR of an automatic card (or epic) with a green `ci_state`: skip when paused; `pull()` → `mergeable === false` → start a `fixer` run (reason `conflict`) unless one is active; `files()` → `requiredLevel` → store `changed_level`; `allows(autonomy, needed)` → `merge(squash, sha: head_sha, title: '<ref> <card title> (#n)')` → event `merged` (+ chat notice); else → `askForAutomation` once per PR head (idempotency key `automation_merge:<repo>#<n>@<sha>`) and event `merge_needs_approval` with the needed level (`store` → text `precisa de build nas lojas`). A PR whose head moved since CI (`merged: false`) waits for the next sync.

- [ ] **Step 1: Failing tests (fake GitHub)** — green + `merge` level into the epic branch → merged; into main with a deploy workflow at level `merge` → approval card, no merge; store path at `release` → approval card with the store text; red CI → nothing; not mergeable → one fixer run; paused → nothing; approving the card merges once even if approved twice; a project with automation off → the executor is never called (sync test).
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: merge green PRs within the policy, ask above it"`

### Task 26: Integration trigger, the epic PR and the integrator run (TER-873)

**Files:**
- Create: `apps/server/src/automation/integrator.ts`
- Modify: `apps/server/src/automation/dispatcher.ts` (the tick also checks automatic epics), `apps/server/src/automation/merge.ts` (an epic PR is handled like a card PR, with base = base branch)
- Test: `apps/server/src/automation/integrator.test.ts`

**Interfaces:**

```ts
export function epicReady(i: { cards: Array<{ type: TaskType; status: TaskStatus }>; prs: Array<{ task_id: string; state: PrState; base_ref: string | null }>; epicBranch: string }): boolean;
export async function integrateEpic(deps: DispatcherDeps, epic: Task, setup: ProjectSetupData): Promise<void>;
```

`epicReady`: every non-epic top-level card of the epic is `done`, each card that has a PR has it `merged` into the epic branch, and there is at least one card. `integrateEpic`: `findOpenPull(epicBranch → base)` or `openPull` (not draft; title `<ref> <epic title>`; the body lists the cards and ends with "Aberto pelo termhub (automático)."), event `pr_opened`, then claim an `integrator` run on the epic and start it in the epic worktree with `integratorPrompt`.

- [ ] **Step 1: Failing tests** — `epicReady` false with a card in `doing`, false with a card PR still open, true otherwise; `integrateEpic` opens the PR once (a second call finds it) and starts one integrator run.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: open the epic PR and start the integrator"`

### Task 27: Integrator playbook, with an end-to-end conflict test (TER-874)

**Files:**
- Modify: `apps/server/src/automation/prompts.ts` (`integratorPrompt` body)
- Create: `docs/automation/integrator-playbook.md` (the playbook the prompt points to; English), `scripts/automation/rename-migrations.mjs`
- Create: `apps/server/src/automation/playbook.e2e.test.ts`

Playbook steps (prompt in pt-BR, doc in English): `git fetch origin && git merge origin/<base>`; Prisma migrations: when both sides added migrations, rename the epic's folders to timestamps after the newest one on the base (`YYYYMMDDHHMMSS`), never edit an applied migration (`node scripts/automation/rename-migrations.mjs <base>`); generated Prisma client: never edit, run `npx prisma generate`; lockfiles: take the base's version and run `npm install` to regenerate; run the project's checks; push; `report_card done`.

- [ ] **Step 1:** The e2e test builds a temp repo: `main` adds `20261010120000_a`, the epic branch adds `20261009120000_b`; it runs `rename-migrations.mjs` and asserts `b` is renamed after `a` and `git merge` completes.
- [ ] **Step 2:** Run → FAIL, implement the script, run → PASS.
- [ ] **Step 3: Commit** — `git commit -m "Automation: integrator playbook and migration rename script"`

### Task 28: Follow deploy and release workflows; record them on the card (TER-875, TER-877)

**Files:**
- Create: `apps/server/src/automation/release.ts`
- Modify: `apps/server/src/ci/sync.ts` (for merged PRs of automatic cards, also read the runs of `automation.release_workflows` on the merge commit, like `deployOf`), `apps/web/src/components/CardPullRequests.tsx` (show release runs), `apps/server/src/progress/aggregate.ts`
- Test: `apps/server/src/automation/release.test.ts`, `apps/server/src/ci/sync.test.ts`

Rules (spec D22): deploy run `success` → `deploy_ok`; `failure` → `deploy_failed`, `pauseAutomation({ scope: projectId })` with reason `deploy_failed`, escalation; `cancelled` is not a failure (existing rule, `ci/rules.ts:59`). Each release workflow → `release_ok` / `release_failed` (escalation, no pause). Events carry the run URL and, for an npm publisher, the version read from the merged `package.json` (payload `version`).

- [ ] **Step 1: Failing tests** — a failed deploy pauses only that project and escalates once; a cancelled deploy does nothing; release workflows are matched by name or file.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: follow deploy and release runs after a merge"`

### Task 29: Red CI — fix attempts and escalation (TER-876)

**Files:**
- Modify: `apps/server/src/automation/merge.ts` (red CI on a PR of an automatic card/epic), `apps/server/src/automation/follower.ts`
- Test: `apps/server/src/automation/merge.test.ts`

Rules (D21): on a red `ci_state` for a head SHA not seen before: if the owning run's tab is alive → `sendInput(serverMessage('O CI falhou em {jobs}. Corrija e faça push.'))`; else start a `fixer` run with `fixerPrompt(reason 'ci', detail = failing job names)`; `bump('fix_count')`; at `fix_attempts` → `escalate`. The same SHA is never reported twice.

- [ ] **Step 1: Failing tests** — three red SHAs → three fix requests, the fourth escalates; the same red SHA seen on two syncs → one request; `fix_attempts: 0` escalates at once.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: bounded CI fix attempts"`

### Task 30: Remove worktrees after the merge (TER-871)

**Files:**
- Modify: `apps/server/src/automation/merge.ts` (after a card PR merges → `git.worktree.remove` for the card), `apps/server/src/automation/release.ts` (after the epic PR merges → remove the epic worktree and any card worktree left); close the run's tab (the `close_tab` path) when the run is `done`
- Test: `apps/server/src/automation/merge.test.ts`

- [ ] **Step 1: Failing tests** — merged card PR → one remove RPC and the run's tab closed; dirty worktree → kept, and the `run_done` event carries `worktree_kept: true`; machine offline → retried on the next sync.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: clean up worktrees and tabs after merges"`

---

## Phase 7 — Visibility

### Task 31: The feed in Progresso and in the chat; the badge on automatic tabs (TER-890)

**Files:**
- Modify: `apps/server/src/progress/aggregate.ts` (tab `automatic: boolean` from its runs; the last 50 events), `apps/web/src/components/ProgressPanel.tsx` (section `Automático`), `packages/mobile-api/src/automation.ts`, `apps/mobile/src/features/progress/*`
- Modify: the chat notice path in `apps/server/src/chat/service.ts` (a system notice in the owner's latest conversation for `merged`, `deploy_ok`, `deploy_failed`, `release_*`, `quota_hit`, `escalated`, `merge_needs_approval`, `paused`)
- Test: `apps/server/src/progress/aggregate.test.ts`, the app view model test

Copy (pt-BR): `{ref} iniciado em {máquina} ({conta})`, `{ref}: PR aberto`, `{ref}: merge feito na {branch}`, `Deploy concluído ({épico})`, `Deploy falhou ({épico}) — automático pausado no projeto`, `Publicado {pacote} {versão}`, `Conta {conta} no limite até {hora}`, `{ref} precisa de você: {motivo}`.

- [ ] **Step 1:** Failing tests: the aggregate flags a tab as automatic and lists events newest first; `run_started` does not reach the chat.
- [ ] **Step 2:** Implement; builds and tests pass.
- [ ] **Step 3: Commit** — `git commit -m "Progress: automatic-work feed and badges"`

### Task 32: Tokens and cost per tab, card, epic and account (TER-891)

**Files:**
- Create: `apps/server/src/automation/usage.ts`, `apps/server/src/automation/prices.ts`, `apps/server/src/db/repositories/tab-usage.ts`, migration `<ts>_tab_usage` (spec §4)
- Modify: `apps/server/src/monitor/ingest.ts` (on a Claude main-thread Stop, `void meterTab(tab)`), `apps/server/src/routes/automation.ts` (`GET /api/projects/:id/automation/usage?from=&to=`), `TaskEditor.tsx` and Progresso (cost per card and epic)
- Test: `apps/server/src/automation/usage.test.ts`, `apps/server/src/automation/prices.test.ts`

**Interfaces:**

```ts
export async function meterTab(deps: UsageDeps, tab: Tab): Promise<void>; // transcript.read from tab_usage.transcript_offset, 'assistant' lines only, sums message.usage, stores counts + the new offset
export function costOf(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | null; // null = unknown model
```

Only counts and the byte offset are stored; the lines are dropped after summing (spec D23; tab chat spec D4). Tabs on agents without the `transcript` capability, and Codex tabs, are skipped. Prices: a table keyed by model family (`opus`, `sonnet`, `haiku`) with a comment naming the provider's price page and the date it was read; an unknown model → `null`, shown as `—`.

- [ ] **Step 1: Failing tests** — two Stops read only the new range; an unknown model → cost `null`; nothing but counts reaches the repository (spy on the call arguments).
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: meter tokens and estimate cost per tab"`

### Task 33: Optional daily budget (TER-892)

**Files:**
- Modify: `apps/server/src/automation/dispatcher.ts` (skip a project whose estimate for the owner's day reached `daily_budget_usd`; event `budget_hit` once per day)
- Test: `apps/server/src/automation/dispatcher.test.ts`

- [ ] **Step 1: Failing tests** — a `null` budget never blocks (M1); reaching it stops new runs but not running ones; the next day (the owner's time zone, UTC when unknown) runs again.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: optional daily budget per project"`

### Task 34: Daily summary in the chat and by push (TER-894)

**Files:**
- Create: `apps/server/src/automation/summary.ts`
- Modify: `apps/server/src/app.ts` (a 5-minute timer; an event `summary_sent` per user and day, inserted with a unique key `(owner, day)` in the payload index or a small table, makes one colour send it), `apps/server/src/mobile/push-text.ts`, the web and app settings that save `users.time_zone` from `Intl.DateTimeFormat().resolvedOptions().timeZone`
- Test: `apps/server/src/automation/summary.test.ts`

Content (pt-BR): `Resumo do automático — {data}`; `Feitos: {n} cards, {m} merges, {d} deploys`; `Esperando você: {refs com motivo}`; `Custo estimado do dia: US$ {x}` (or `—`).

- [ ] **Step 1: Failing tests** — sent once at `summary_hour` in the user's zone; `summary_hour: null` → never; two colours → one summary.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Automation: daily summary in the chat and by push"`

---

## Phase 8 — Turning it on

### Task 35: Turn automation on in the termhub project, with a runbook

**Files:**
- Create: `docs/automation/runbook.md` (English: turning it on, pausing, reading the feed, approving a merge, recovering a blocked run, removing a stuck worktree)
- No product code.

Prerequisites: Tasks 1–34 merged and deployed; the agent with the worktree RPC installed on the machines linked to termhub; the spike's follow-up cards it marks as blocking are done.

- [ ] **Step 1:** In the termhub Setup (by the maintainer, or with their confirmation in the chat): `release_paths` = `apps/agent/package.json`, `apps/mobile/**`, `packages/mobile-api/**`; `store_paths` = `apps/mobile/app.json`, `apps/mobile/app.config.js`; `release_workflows` = `Publish @termhub/agent`, `Publish mobile OTA`; `repo.deploy_workflow` = `CI e Deploy`; the autonomy as settled in spec §15 item 1; then `enabled`.
- [ ] **Step 2:** Tag one small card as automático and follow it end to end (start, PR, merge, deploy); write what happened in the runbook PR.
- [ ] **Step 3: Commit** — `git commit -m "Docs: automation runbook"`

---

## Self-review against the spec

| Spec | Tasks |
| --- | --- |
| §4 data model | 2, 9, 11, 13, 14, 23, 32 |
| §5 eligibility | 4, 6, 7 |
| §6 policy, D4–D7 | 3, 5, 6, 7, 25 |
| §7 branches and worktrees, D8–D10 | 8, 12, 13, 14, 30 |
| §8 dispatcher, D11–D17 | 11, 17, 18, 19, 20 |
| §9 answers, D18–D19 | 14, 21, 22, 23, 24 |
| §10 integration, D20–D22 | 25, 26, 27, 28, 29 |
| §11 visibility and control, D23–D26 | 9, 10, 31, 32, 33, 34 |
| §12 prompts, D27 | 15, 16 |
| §13 edge cases | 17 (card moved or deleted), 18 (tag removed → not resumed), 13 (worktree conflict), 25 (token revoked, store) |
| §15 open decisions | Task 35 step 1 waits on item 1; D19 (item 3) is built as written until the maintainer says otherwise |
