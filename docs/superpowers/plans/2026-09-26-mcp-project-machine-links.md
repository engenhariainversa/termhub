# MCP project ↔ machine links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP tools `link_project_machine`, `set_project_machine_cwd`, `unlink_project_machine` that do what the project settings screen does with machine links.

**Architecture:** A control module (`apps/server/src/control/project-links.ts`) holds the operations and the side effects shared with the REST route (`routes/projects.ts` is refactored to call the same helpers). `mcp/tools.ts` registers the tools; `chat/gate.ts` classifies them; `db/repositories/chat-actions-view.ts` writes their confirmation sentence.

**Tech Stack:** TypeScript, Fastify, zod, vitest (mocked repos, like `control/terminals.test.ts`).

**Spec:** `docs/superpowers/specs/2026-09-26-mcp-project-machine-links-design.md`

## Global Constraints

- Messages returned to the user/model are pt-BR; code, comments, identifiers English.
- Load projects/machines only through `ctx.scoped.*` (never `repos.*.findById`).
- Anything run on a machine goes through the existing `ensureDirectory` / `browseMachine` / `killTmuxSession` (they already shell-quote).
- Token scope `terminals`; grants `projects:create` (link), `projects:update` (set cwd), `projects:delete` (unlink).
- Terminal content never logged.

## Review Focus

- `cwd` relative (`termhub`, `./x`) → refused by zod before anything runs on the machine.
- Missing directory without `create_dir` → `DIR_NOT_FOUND` whose message tells how to proceed (create_dir, then clone inside a tab).
- Link to a machine or project outside the user's scope → 404, nothing written (scoped loaders).
- Unlink with open tabs and no `confirm` → nothing killed, nothing deleted.
- `git_repo` listing failure (offline agent after the check, Windows path) → `null`, never an error.

---

### Task 1: control/project-links.ts (+ REST route uses it)

**Files:**
- Create: `apps/server/src/control/project-links.ts`
- Create: `apps/server/src/control/project-links.test.ts`
- Modify: `apps/server/src/routes/projects.ts` (use `PROJECT_CWD`, `resolveLinkCwd`, `announceLinked`, `removeProjectMachineLink`; drop its local `cwdSchema`, `isPosixPath`, `resolveCwd`, and the inline unlink body)

**Interfaces (Produces):**
```ts
export const PROJECT_CWD: z.ZodType<string>; // trim, 1..1024, absolute (/, ~, C:\), message 'cwd deve ser um caminho absoluto'
export async function resolveLinkCwd(machine: Machine, cwd: string, createDir: boolean | undefined): Promise<{ path: string; created: boolean }>;
export function announceLinked(project: Project): void; // publicBus.publish({ project_id, is_public: true }) when project.is_public
export async function removeProjectMachineLink(repos: Repositories, projectId: string, machine: Machine, tabs: Tab[]): Promise<number>; // kill tmux (allSettled), delete tabs, publishTabsRemoved, unlink, publicBus.publishRobotsGone; returns tabs.length
export interface LinkResult { project_id: string; machine_id: string; machine_name: string; cwd: string; created_dir: boolean; git_repo: boolean | null; note?: string }
export async function linkProjectMachine(ctx: ControlContext, input: { project_id: string; machine_id: string; cwd: string; create_dir?: boolean }): Promise<LinkResult>;
export async function setProjectMachineCwd(ctx: ControlContext, input: { project_id: string; machine_id: string; cwd: string; create_dir?: boolean }): Promise<LinkResult>;
export async function unlinkProjectMachine(ctx: ControlContext, input: { project_id: string; machine_id: string; confirm?: boolean }): Promise<{ unlinked: true; project_id: string; machine_id: string; closed_tabs: number }>;
```

Behaviour details:
- `linkProjectMachine`: `ctx.scoped.project` then `ctx.scoped.machine`; existing link (`repos.projectMachines.find`) → `ControlError('MACHINE_ALREADY_LINKED', 'O projeto X já está vinculado à máquina Y; para trocar a pasta use set_project_machine_cwd')` *before* touching the machine; then `checkedDir`; `repos.projectMachines.link` (a `ProjectRuleError` becomes `ControlError(e.code, e.message)`); `announceLinked`; result.
- `checkedDir` (private): `resolveLinkCwd`, but an `HttpError` with code `DIR_NOT_FOUND` becomes `ControlError('DIR_NOT_FOUND', 'A pasta <cwd> não existe na máquina <name>. Repita com create_dir: true para criá-la vazia; para ter o repositório, depois de vincular abra uma aba nesse projeto e máquina e rode git clone <url> . dentro dela.')`.
- `gitRepo` (private): Windows path → `null`; else `browseMachine(machine, path)` → `entries.some(e => e.name === '.git')`; any throw → `null`.
- `note` only when `git_repo === false`: `'A pasta não é um repositório git (não tem .git).'`
- `setProjectMachineCwd`: `ctx.scoped.projectMachine` (404 when not linked), `checkedDir`, `repos.projectMachines.updateCwd`, result.
- `unlinkProjectMachine`: `ctx.scoped.projectMachine`; `tabs = repos.tabs.listByProjectMachine(project.id, machine.id)`; tabs and `confirm !== true` → `ControlError('CONFIRM_REQUIRED', 'Desvincular a máquina Y do projeto X fecha N aba(s) abertas nela (Terminal 1, …); repita com confirm: true para confirmar')`; else `removeProjectMachineLink`.

- [ ] **Step 1: Write failing tests** in `project-links.test.ts`, mocking `../terminal/machine-fs.js` (`ensureDirectory`, `browseMachine`), `../terminal/machine-exec.js` (`killTmuxSession`), `../public/bus.js` (`publicBus`), `../monitor/tab-events.js` (`publishTabsRemoved`) with `vi.hoisted` + `vi.mock`, and a `ctxWith()` fake like `control/terminals.test.ts`. Cases:
  - link stores the resolved path (`ensureDirectory` returns `{ path: '/home/u/app', created: false }` for `~/app`), returns `git_repo: true` when `browseMachine` lists `.git`, calls `announceLinked` path (publicBus.publish) only for a public project.
  - link with `create_dir: true` passes `true` to `ensureDirectory` and reports `created_dir: true`.
  - `DIR_NOT_FOUND` from `ensureDirectory` (`new HttpError(400, '…', 'DIR_NOT_FOUND')`) → ControlError code `DIR_NOT_FOUND`, message contains `create_dir: true` and `git clone`.
  - already linked → `MACHINE_ALREADY_LINKED`, `ensureDirectory` not called, `link` not called.
  - `git_repo: false` + `note` when no `.git`; `git_repo: null` when `browseMachine` throws.
  - set cwd updates via `updateCwd` with the resolved path.
  - unlink with tabs and no confirm → `CONFIRM_REQUIRED`, `killTmuxSession`/`tabs.delete`/`unlink` not called.
  - unlink with confirm → kills each tab's session, deletes tabs, `unlink` called, `closed_tabs: 2`, `publishRobotsGone` called.
  - unlink without tabs → unlinks, `closed_tabs: 0`.
  - `PROJECT_CWD` refuses `termhub` and `./x`, accepts `/a`, `~`, `~/a`, `C:\\a`.
- [ ] **Step 2: Run** `npx vitest run src/control/project-links.test.ts` (in `apps/server`, through Docker) → FAIL (module missing).
- [ ] **Step 3: Implement** `project-links.ts` as specified.
- [ ] **Step 4: Refactor** `routes/projects.ts` to use the helpers (behaviour unchanged: POST still 201 `{ link }`, DELETE still `{ ok: true, closed_tabs }`).
- [ ] **Step 5: Run** the new test plus `src/routes` tests and `npm run typecheck -w @termhub/server` → PASS.
- [ ] **Step 6: Commit** `Control: project machine link operations shared with the REST route`.

### Task 2: MCP tools, gate classes and confirmation sentences

**Files:**
- Modify: `apps/server/src/mcp/tools.ts` (three `ToolDef`s after `list_projects`… place them after `close_tab`/before `start_agent` is fine; keep them together)
- Modify: `apps/server/src/chat/gate.ts`
- Modify: `apps/server/src/db/repositories/chat-actions-view.ts` (`verbPhrase`)
- Test: `apps/server/src/mcp/tools.test.ts`, `apps/server/src/chat/gate.test.ts`, `apps/server/src/db/repositories/chat-actions-view.test.ts`

**Interfaces (Consumes):** Task 1's `PROJECT_CWD`, `linkProjectMachine`, `setProjectMachineCwd`, `unlinkProjectMachine`.

Tool defs:
```ts
{
  name: 'link_project_machine',
  description: 'Link a project to one more of your machines, with the working directory its terminals open in there (cwd: absolute path, ~ allowed). The directory is checked on the machine (create_dir: true creates it empty) and the resolved path is stored; git_repo says whether it holds a .git folder. Fails if the machine is already linked (use set_project_machine_cwd). list_projects shows the link at once.',
  scope: 'terminals', resource: 'projects', action: 'create',
  input: { project_id: id, machine_id: id, cwd: PROJECT_CWD, create_dir: z.boolean().optional() },
  run: (ctx, a) => linkProjectMachine(ctx, a as { project_id: string; machine_id: string; cwd: string; create_dir?: boolean }),
},
{
  name: 'set_project_machine_cwd',
  description: "Change the working directory of an existing project ↔ machine link (same checks as link_project_machine). Open tabs keep running where they are; new tabs open in the new directory.",
  scope: 'terminals', resource: 'projects', action: 'update',
  input: { project_id: id, machine_id: id, cwd: PROJECT_CWD, create_dir: z.boolean().optional() },
  run: (ctx, a) => setProjectMachineCwd(ctx, a as { project_id: string; machine_id: string; cwd: string; create_dir?: boolean }),
},
{
  name: 'unlink_project_machine',
  description: "Remove a machine from a project. If the project has tabs open on that machine they are closed (tmux sessions killed), which needs confirm: true; without it the answer says which tabs would close and nothing happens.",
  scope: 'terminals', resource: 'projects', action: 'delete',
  input: { project_id: id, machine_id: id, confirm: z.boolean().optional() },
  run: (ctx, a) => unlinkProjectMachine(ctx, a as { project_id: string; machine_id: string; confirm?: boolean }),
},
```
(Verify "Open tabs keep running where they are" against `routes/projects.ts` PATCH — it does not touch tabs; if tabs read cwd from the link at attach time, reword to "tabs opened after this use the new directory".)

Gate: add `'link_project_machine'` and `'set_project_machine_cwd'` to `writeTools`; in `actionClass`, `unlink_project_machine` → `(args as { confirm?: unknown })?.confirm === true ? 'irreversible' : 'write'`.

Sentences in `verbPhrase`:
- `link_project_machine` → ``vincular a pasta `${cwd}` ``
- `set_project_machine_cwd` → ``trocar a pasta para `${cwd}` ``
- `unlink_project_machine` → `args.confirm === true ? 'desvincular a máquina e fechar as abas do projeto nela' : 'desvincular a máquina'`

- [ ] **Step 1: Failing tests**
  - `tools.test.ts`: the three tools exist with scope `terminals` and grants `projects:create|update|delete`; `parseArgs` refuses `cwd: 'termhub'` and accepts `cwd: '~/termhub'`.
  - `gate.test.ts`: `actionClass('link_project_machine', {})` and `set_project_machine_cwd` are `write`; `unlink_project_machine` is `write` without confirm and `irreversible` with `confirm: true`.
  - `chat-actions-view.test.ts`: a row `{ tool: 'link_project_machine', args: { project_id, machine_id, cwd: '~/termhub' }, project_id, machine_id }` reads ``vincular a pasta `~/termhub` no projeto <name>, no <machine>`` (follow the file's existing fixtures; if the view omits the machine when a project is present, assert what it actually renders for project+machine rows and keep the sentence readable). Same for unlink with/without confirm.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three test files + `src/mcp` + `src/chat/gate*.test.ts` + typecheck → PASS.
- [ ] **Step 5: Commit** `MCP: link, re-point and unlink a project's machines`.
