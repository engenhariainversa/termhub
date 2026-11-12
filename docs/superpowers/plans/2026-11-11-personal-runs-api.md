# Personal runs API Implementation Plan (TER-1176)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /api/v1/runs` runs a prompt headless (Claude Code or Codex) on the token owner's own
machine and AI account, routed by termhub, and streams normalized events over SSE.

**Architecture:** A bearer-only `/api/v1` plugin on the server stores runs and events in two new tables.
A routing module picks account + machine from the project Setup order; a service opens a new agent
channel kind `run`, feeds raw stdout lines to a per-provider adapter and stores the normalized events.
The agent only builds the argv from a structured spec, spawns the CLI and streams lines.

**Tech Stack:** Fastify, zod, Prisma/Postgres, vitest; `@termhub/agent` (Node); React web.

**Spec:** `docs/superpowers/specs/2026-11-11-personal-runs-api-design.md`

## Global Constraints

- Everything behind the `runs_api` feature flag (`features/flags.ts`), off by default; routes 404 while off.
- Token scope `runs`; never on gated (concierge) or tab tokens.
- Machines and accounts used must have `owner_id = token.user_id`; no view-as, no shared machines, even for admins.
- Limits: per token 2 running and 30 created per hour; per user 4 running; prompt ≤ 100 000 chars; timeout default 600 s, max 3600 s.
- Default capability `read`; no MCP servers and no termhub tools in a run; no push.
- Never log prompts, events or stderr: metadata only (run id, machine id, sizes, exit code).
- Events deleted after 7 days; run rows kept. Worktrees of edit runs kept 24 h, then removed.
- UI copy in pt-BR through `t()`, with `en` and `es` catalog entries; `npm run i18n:check -w @termhub/web` passes.
- Routes go through repositories (no Prisma in routes); inputs validated with zod.
- Verify with Docker `node:22` before pushing (CLAUDE.md "Verifying before pushing").
- Agent version bump: take `main`'s current `apps/agent/package.json` version and bump the minor in both `package.json` and `src/version.ts` (another PR may have bumped it meanwhile).
- Do not edit `automation/placement.ts`, `automation/dispatcher.ts`, `chat/*`, tab GC or memory code: other cards (TER-1168…1171) change them now. Import read-only helpers only.

## Review Focus

- A token without `runs`, a revoked token, or a run id of another user → 403/401/404, never data. Test in Task 3 and Task 4.
- The client disconnects from SSE mid-run → the run keeps going; reconnect with `Last-Event-ID` gets only the missing events. Test in Task 4.
- The machine goes offline mid-run → run ends `failed` with `error agent_offline` within 60 s, not `running` forever. Test in Task 4.
- A rate limit after the first `text` event → no silent switch to another account (output would mix); `error account_limited`. Test in Task 4.
- An unknown line format from a newer CLI → adapter emits nothing for it and keeps going (no crash, no lost `done`). Test in Task 2.

---

## Card order and dependencies

| # | Card | Depends on | Automatic |
|---|---|---|---|
| 1 | Agent: headless `run` channel (Claude + Codex), release | — | now |
| 2 | Server: normalized events + Claude/Codex adapters | — | now |
| 3 | Server: `runs_api` flag, `runs` scope, tables, `/api/v1` auth, read routes, limits | — | now |
| 4 | Server: routing, execution, `POST /runs`, SSE, cancel, worktrees, docs | 1, 2, 3 merged | after 1–3 merge |
| 5 | Web: `runs` scope on the token screen + "Runs da API" in Progresso | 3 merged | after 3 merges |
| — | GraphQL over the same service | 4 | backlog, not automatic |

Cards 1, 2 and 3 touch disjoint files and can run in parallel.

---

### Task 1: Agent headless `run` channel

**Files:**
- Modify: `packages/agent-protocol/src/messages.ts` (add `runOpenParams`, `openRun`, `CAPABILITY_RUN_HEADLESS`)
- Modify: `packages/claude-cli/src/index.ts` (add `buildHeadlessArgs`, `buildCodexExecArgs`)
- Create: `apps/agent/src/run/headless.ts`, `apps/agent/src/run/headless.test.ts`
- Modify: `apps/agent/src/dispatch.ts:111` (route `kind === 'run'`), the hello capabilities list
- Modify: `apps/agent/package.json`, `apps/agent/src/version.ts` (minor bump)
- Test: `packages/claude-cli/src/index.test.ts`, `packages/agent-protocol/src/messages.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CAPABILITY_RUN_HEADLESS = 'run.headless';
  export const runOpenParams = z.object({
    provider: z.enum(['claude', 'codex']),
    config_dir: z.string().nullable(),          // CLAUDE_CONFIG_DIR / CODEX_HOME; null = machine default
    cwd: machinePath,
    model: z.string().max(100).nullable(),
    tools: z.array(z.enum(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'])).max(6).optional(), // claude
    sandbox: z.enum(['read-only', 'workspace-write']).optional(),                               // codex
    timeout_ms: z.number().int().min(10_000).max(3_600_000),
    guard: z.object({ branch: z.string(), worktree: machinePath }).nullable(),                    // claude, edit runs
  }).strict();
  export type RunOpenParams = z.infer<typeof runOpenParams>;
  // stdin: the prompt (first and only `data` frame from the server, then EOF); stdout lines → `data` frames;
  // end → `closed { code, reason }` with reason in 'timeout' | 'killed' | 'cli_failed' | 'rate_limited' | undefined.
  export function buildHeadlessArgs(p: { tools: string[]; model: string | null; settingsPath: string | null; mcpConfigPath: string }): string[];
  export function buildCodexExecArgs(p: { cwd: string; sandbox: 'read-only' | 'workspace-write'; model: string | null }): string[];
  ```

- [ ] **Step 1: Failing tests for the argv builders** (`packages/claude-cli/src/index.test.ts`)
  ```ts
  it('headless claude: closed tool list, no MCP, no session', () => {
    expect(buildHeadlessArgs({ tools: ['Read', 'Grep', 'Glob'], model: 'sonnet', settingsPath: null, mcpConfigPath: '/t/mcp.json' })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence',
      '--mcp-config', '/t/mcp.json', '--strict-mcp-config',
      '--tools', 'Read,Grep,Glob', '--allowed-tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk',
      '--model', 'sonnet',
    ]);
  });
  it('codex exec: prompt from stdin, sandbox, ephemeral', () => {
    expect(buildCodexExecArgs({ cwd: '/w', sandbox: 'read-only', model: null })).toEqual(
      ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-C', '/w', '-s', 'read-only', '-']);
  });
  ```
  The MCP config file holds `{"mcpServers":{}}` (empty, so the person's own MCP servers never load).
  `settingsPath`, when set, adds `--settings <path>` with the guard hook (`buildGuardSettings` from
  `packages/machine-ops`).
- [ ] **Step 2: Run** `npm test -w @termhub/claude-cli` (check the workspace name in its package.json) → FAIL.
- [ ] **Step 3: Implement** the two builders; first confirm the flags on the installed CLIs
  (`claude --help`, `codex exec --help`): `dontAsk` and `--no-session-persistence` exist in Claude Code,
  `--json --ephemeral --skip-git-repo-check -C -s -m` in codex-cli 0.159. If `-` for stdin is not
  accepted by codex, pass no positional prompt (codex reads stdin when it is not a TTY) and adjust the test.
- [ ] **Step 4: Protocol schema + test**: `runOpenParams` rejects an unknown key (`argv`), `timeout_ms`
  over 3 600 000 and a relative `cwd`. Add `openRun` to the server message union next to `openClaude`.
- [ ] **Step 5: Agent manager** `apps/agent/src/run/headless.ts`, modeled on `apps/agent/src/claude/run.ts`
  (detached spawn, process-group kill, deadline): env `CLAUDE_CONFIG_DIR` or `CODEX_HOME` from
  `resolveConfigDir(config_dir, home)` (null deletes the var), spawn `claude`/`codex` with the built argv,
  write the prompt on stdin then end it, one `data` frame per stdout line, stderr kept in memory only to
  classify `closed.reason` (`rate_limited` when it matches the same limit phrases the chat already
  recognizes; reuse the existing classifier if exported, else add one with tests), temp files (MCP config,
  settings) removed on exit. Tests with a fake binary on `PATH` (pattern used by `claude/run.test.ts`):
  lines arrive in order; close kills the group; deadline → `timeout`; stderr never in a frame.
- [ ] **Step 6: Dispatch + capability**: `kind === 'run'` → `deps.run.open(...)`; advertise
  `CAPABILITY_RUN_HEADLESS` only when the manager is wired. Bump the agent minor version.
- [ ] **Step 7: Verify** in Docker node:22: `npm test -w @termhub/agent`, protocol and claude-cli tests,
  `npm run typecheck -w @termhub/server` (the union change must still compile). Commit:
  `Agent: headless run channel for Claude and Codex (TER-1176)`.

**Done when:** tests pass; agent version bumped; after merge, the "Publish @termhub/agent" run publishes
it and `npm pack @termhub/agent@<version>` shows `run/headless` in `dist`.

---

### Task 2: Normalized events and adapters (server, pure)

**Files:**
- Create: `apps/server/src/runs/events.ts`, `apps/server/src/runs/adapters/claude.ts`,
  `apps/server/src/runs/adapters/codex.ts`, `apps/server/src/runs/models.ts`
- Create: `apps/server/src/runs/adapters/fixtures/claude-*.jsonl`, `codex-*.jsonl`
- Test: `apps/server/src/runs/adapters/claude.test.ts`, `codex.test.ts`, `apps/server/src/runs/models.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RunEvent =
    | { type: 'started'; provider: Provider; model: string | null; machine: string; account: string; workspace: Workspace }
    | { type: 'text_delta'; text: string }
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }   // name: read|edit|shell|search|web|other:<raw>
    | { type: 'tool_result'; id: string; ok: boolean; summary: string }
    | { type: 'usage'; input_tokens: number; output_tokens: number; cost_usd?: number }
    | { type: 'error'; code: RunErrorCode; message: string }
    | { type: 'done'; status: RunStatus; result: string | null; usage: Usage | null };
  export type Provider = 'claude' | 'codex';
  export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  export type RunErrorCode = 'account_limited' | 'cli_failed' | 'timeout' | 'agent_offline' | 'permission_denied';
  export interface Adapter { parse(line: string): RunEvent[]; finish(): { result: string | null; usage: Usage | null; ok: boolean } }
  export function claudeAdapter(): Adapter; export function codexAdapter(): Adapter;
  export type Capability = 'read' | 'edit' | 'run_commands';
  export function claudeTools(caps: Capability[]): Array<'Read'|'Grep'|'Glob'|'Edit'|'Write'|'Bash'>;
  export function codexSandbox(caps: Capability[]): 'read-only' | 'workspace-write';
  export function resolveModel(provider: Provider, req: { model?: string; model_class?: 'fast'|'default'|'strong' },
    ctx: { blocked: string[]; setupModels: { claude?: string | null; chatgpt?: string | null } }): string | null;
  export function providerOfModel(model: string): Provider | null;
  ```

- [ ] **Step 1: Capture fixtures** (no prompts with private data): on a machine with the CLIs logged in,
  `echo 'Say hi, then list the files here' | claude -p --output-format stream-json --verbose --include-partial-messages --tools Read,Glob --allowed-tools Read,Glob --permission-mode dontAsk --no-session-persistence > claude-read.jsonl`
  and `echo 'Say hi, then run ls' | codex exec --json --ephemeral --skip-git-repo-check -s read-only - > codex-read.jsonl`.
  If no logged-in CLI is reachable, build fixtures from each CLI's documented stream format and say so in
  the PR. Strip ids/paths that identify the machine.
- [ ] **Step 2: Failing tests**: feeding `claude-read.jsonl` line by line yields, in order, `text_delta`s,
  a `tool_use` named `read`/`search`, its `tool_result`, a `text`, a `usage`; `finish()` returns the final
  `result` text and `cost_usd` from the `result` line. Same for Codex (agent message → `text`, command
  execution → `tool_use` `shell` + `tool_result`, turn usage → `usage`). Plus: a garbage line and an
  unknown `type` yield `[]` and do not throw; `tool_use.input` over 2 KB is truncated; `summary` ≤ 500 chars.
- [ ] **Step 3: Implement** the adapters (`JSON.parse` in try/catch; map by `type`).
- [ ] **Step 4: models.ts tests**: `claudeTools(['read'])` = `['Read','Grep','Glob']`; with `edit` adds
  `Edit`,`Write`; with `run_commands` adds `Bash`. `codexSandbox(['read'])` = `read-only`, else
  `workspace-write`. `resolveModel('claude', {model_class:'strong'}, {blocked:['opus'],…})` falls back
  through `conciergeModel` (import from `chat/concierge-model.ts`, read only). `providerOfModel('gpt-6-astra')` = `codex`, `('sonnet')` = `claude`.
- [ ] **Step 5: Verify** `npx vitest run src/runs` in `apps/server` (Docker node:22) and typecheck. Commit:
  `Runs API: normalized events and Claude/Codex adapters (TER-1176)`.

**Done when:** adapter and model tests pass on real (or documented) fixtures; no other module imports these yet.

---

### Task 3: Flag, scope, tables, `/api/v1` auth, read routes, limits

**Files:**
- Modify: `apps/server/src/features/flags.ts` (add `runs_api`, default off), `docs/feature-flags.md`
- Modify: `apps/server/src/auth/api-tokens.ts` (`API_TOKEN_SCOPES` + `runs`), token creation route: refuse `runs` on gated/tab tokens
- Modify: `apps/server/src/auth/permissions.ts` (`RESOURCES` + `runs`)
- Modify: `apps/server/prisma/schema.prisma` + new migration `<ts>_api_runs`
- Create: `apps/server/src/db/repositories/api-runs.ts` (+ `.db.test.ts`), register in the repos factory
- Create: `apps/server/src/runs/limits.ts`, `apps/server/src/runs/v1-auth.ts`, `apps/server/src/routes/runs-v1.ts`, `apps/server/src/routes/runs-web.ts`
- Modify: `apps/server/src/app.ts` (register `/api/v1` outside `/api`, like `registerMobileApi`; `guarded('runs', runsWeb, '/runs')` under `/api`)
- Modify: `SECURITY_EVENT_ACTIONS` (`api_run.create`, `api_run.cancel`)
- Test: `apps/server/src/routes/runs-v1.test.ts`, `apps/server/src/runs/limits.test.ts`

**Interfaces:**
- Produces:
  ```prisma
  model ApiRun {
    id          String   @id                 // same id helper as other tables
    userId      String   @map("user_id")
    tokenId     String?  @map("token_id")
    projectId   String   @map("project_id")
    machineId   String?  @map("machine_id")
    accountId   String?  @map("account_id")
    provider    String?
    model       String?
    capabilities String[]
    status      String   @default("queued")   // queued|running|succeeded|failed|cancelled
    workspace   Json?                          // { kind, path, branch }
    result      String?
    usage       Json?
    errorCode   String?  @map("error_code")
    errorMessage String? @map("error_message")
    idempotencyKey String? @map("idempotency_key")
    timeoutMs   Int      @map("timeout_ms")
    createdAt   DateTime @default(now()) @map("created_at")
    startedAt   DateTime? @map("started_at")
    endedAt     DateTime? @map("ended_at")
    events      ApiRunEvent[]
    @@unique([userId, idempotencyKey])
    @@index([userId, createdAt]) @@index([tokenId, status])
    @@map("api_runs")
  }
  model ApiRunEvent {
    runId String @map("run_id"); seq Int; type String; payload Json; at DateTime @default(now())
    run ApiRun @relation(fields: [runId], references: [id], onDelete: Cascade)
    @@id([runId, seq]) @@map("api_run_events")
  }
  ```
  Foreign keys to users, projects, machines (SetNull), ai_accounts (SetNull), api_tokens (SetNull).
  Repository `repos.apiRuns`: `create`, `findForUser(userId, id)`, `listForUser(userId, {projectId?, status?, limit})`,
  `setStatus(id, patch)`, `appendEvents(runId, events: RunEventRow[])` (assigns `seq` in a transaction),
  `eventsAfter(runId, seq)`, `countRunning({userId}|{tokenId})`, `countCreatedSince(tokenId, since)`,
  `deleteEventsBefore(date)`, `findByIdempotency(userId, key)`.
  `limits.ts`: `checkRunLimits(repos, {userId, tokenId}) → { ok: true } | { ok: false; retryAfterS: number; reason: string }`
  with the constants from Global Constraints.
  `v1-auth.ts`: Fastify plugin hook that sets `request.runsAuth = { user, token }` or answers 401/403/404 (flag off → 404).
  Web route: `GET /api/runs?project=&limit=` (session user only, never view-as) for Progresso.

- [ ] **Step 1: Failing route tests** (`runs-v1.test.ts`, with the app test harness used by `mcp/route.test.ts`):
  no header → 401; token without `runs` → 403 `SCOPE_REQUIRED`; flag off for the user → 404; revoked → 401;
  `GET /api/v1/runs/:id` of another user's run → 404; own run → 200 with the documented shape;
  `GET /api/v1/runs?status=running` lists only own runs; cookie-only request to `/api/v1/runs` → 401 (no cookie auth).
  Token creation with `runs` on a gated token → 422.
- [ ] **Step 2: Failing limit tests**: 2 running for the token → `{ok:false}`; 30 created in the last hour
  → `retryAfterS` > 0; a different token of the same user with 4 running user-wide → refused.
- [ ] **Step 3: Implement** flag, scope, resource, schema + migration (`npx prisma migrate dev --create-only`
  inside Docker against a `th-test-db` throwaway Postgres; additive only, backward compatible), repository with
  `.db.test.ts`, limits, auth hook, routes. `ApiTokenEvent` rows for each v1 call (tool name = `REST <METHOD> <route pattern>`).
- [ ] **Step 4: Verify** server tests touched + typecheck + web build (Docker node:22). Commit:
  `Runs API: flag, scope, tables and read routes (TER-1176)`.

**Done when:** read routes work end to end with a `runs` token while the flag is on for that user, and 404 while off; no `POST` yet.

---

### Task 4: Routing, execution, `POST /runs`, SSE, cancel, worktrees, docs

Depends on Tasks 1, 2 and 3 merged (uses `runOpenParams`, the adapters and `repos.apiRuns`).

**Files:**
- Create: `apps/server/src/runs/routing.ts`, `apps/server/src/runs/service.ts`, `apps/server/src/runs/sweeper.ts`
- Modify: `apps/server/src/agent/registry.ts` (add `openRun` next to `openClaude`)
- Modify: `apps/server/src/routes/runs-v1.ts` (POST, events, cancel)
- Create: `docs/api/runs.md` (curl examples, event table, limits); link from `README.md`
- Test: `apps/server/src/runs/routing.test.ts`, `service.test.ts`, `routes/runs-v1.test.ts`

**Interfaces:**
- Consumes: `RunOpenParams`, `CAPABILITY_RUN_HEADLESS` (Task 1); `claudeAdapter`, `codexAdapter`, `claudeTools`,
  `codexSandbox`, `resolveModel` (Task 2); `repos.apiRuns`, `checkRunLimits`, `request.runsAuth` (Task 3).
- Produces:
  ```ts
  export type Candidate = { account: AiAccount; machine: Machine; provider: Provider; cwd: string };
  export async function routeRun(deps, input: { userId: string; projectId: string; provider?: Provider; model?: string; machineId?: string })
    : Promise<{ candidates: Candidate[]; skipped: Array<{ account: string; reason: string }> }>;
  export class RunService {
    create(auth, body): Promise<ApiRun>;            // validates, limits, idempotency, audit, starts async
    cancel(userId, runId): Promise<void>;
    subscribe(runId, afterSeq, onEvent): () => void; // live bus + replay from the table
  }
  ```

- [ ] **Step 1: Routing tests** (fake repos): Setup order kept; account on another user's machine excluded;
  offline machine, machine without `run.headless`, exhausted account, peak ≥ 90 % → skipped with a reason;
  `provider: 'codex'` keeps only `chatgpt` accounts; machine not linked to the project → skipped; empty → `skipped` explains each.
- [ ] **Step 2: Implement `routeRun`** with `loadProjectAi` + `accountsOn` (`ai/project-accounts.ts`),
  `AiAccountExhaustion` repo, `peakUtilization` (`control/account-swap.ts`), registry `capabilities()`.
- [ ] **Step 3: Service tests** with a fake registry channel: lines → stored events with increasing `seq`;
  `started` first, `done` last; status `succeeded`/`failed`; `closed.reason = rate_limited` before any `text`
  → next candidate, exhaustion recorded; after a `text` → `error account_limited`, `failed`; channel drops
  (agent offline) → `error agent_offline` within 60 s; cancel → `done cancelled`; timeout → `error timeout`.
- [ ] **Step 4: Implement `RunService`**: workspace (read → `project_machines.cwd`; edit/run_commands →
  `git.worktree.ensure` at `<worktrees_dir>/<projectId>/run-<id>` + guard for Claude), open the `run` channel,
  send the prompt as the only `data` frame, adapt + store, in-process bus per run for live subscribers,
  `audit(... 'api_run.create' ...)`. On server shutdown, mark running runs `failed` with `cli_failed`
  ("server restarted"); a run cannot survive a deploy in v1, and the docs say so.
- [ ] **Step 5: Routes**: `POST /api/v1/runs` (zod body from the spec, 202), `GET /runs/:id/events` (SSE via
  `reply.hijack()` + `reply.raw`, `Last-Event-ID`, 15 s keep-alive, closes after `done`), `POST /runs/:id/cancel`.
  Route tests: SSE replay after reconnect returns only `seq > Last-Event-ID`; client disconnect does not cancel
  the run; idempotency key returns the same run; 429 with `Retry-After`; 409 `NO_ACCOUNT_AVAILABLE`; 409 `AGENT_OUTDATED`.
- [ ] **Step 6: Sweeper**: hourly, delete events older than 7 days and remove worktrees of runs ended more than
  24 h ago (`git.worktree.remove`), only for `api_runs` rows (never automation worktrees). Test with fakes.
- [ ] **Step 7: Docs** `docs/api/runs.md` with curl for create, events and cancel. Verify (Docker node:22). Commit:
  `Runs API: routing, execution and SSE events (TER-1176)`.

**Done when:** with the flag on and a machine on the new agent, `curl -N` on a created run streams `started … done`
for a Claude read run and a Codex read run; cancel stops the process; tests pass.

---

### Task 5: Web — token scope and "Runs da API" in Progresso

Depends on Task 3 merged (`runs` scope, `GET /api/runs`).

**Files:**
- Modify: `apps/web/src/components/ApiTokensView.tsx` (scope `runs`, only when `useFeatureFlag('runs_api')`)
- Create: `apps/web/src/components/ApiRunsList.tsx`; Modify: `apps/web/src/components/ProgressPanel.tsx`
- Modify: `apps/web/src/locales/en/*.json`, `es/*.json` (same area files the components already use)
- Test: component tests next to the existing ones for these views

- [ ] **Step 1: Failing tests**: flag off → no `runs` checkbox, no list; flag on → checkbox labeled
  `t('Executar prompts nas suas contas e máquinas')`, list renders status, provider, model, duration and cost
  from a mocked `GET /api/runs?project=`, empty state `t('Nenhuma run da API neste projeto')`.
- [ ] **Step 2: Implement**; dates and numbers through `apps/web/src/lib/format.ts`; full page width.
- [ ] **Step 3: Verify** web tests + `npm run i18n:check -w @termhub/web` + web build (Docker node:22). Commit:
  `Web: runs scope on tokens and API runs in Progresso (TER-1176)`.

**Done when:** with the flag on, a token can be created with `runs` and the project's API runs show in Progresso; with it off, nothing changes on screen.

---

## Impact on other users

None by default: everything is behind `runs_api`, off for everyone. The agent release only adds a channel kind.
