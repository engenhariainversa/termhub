# Personal runs API: headless runs on your own AI accounts (TER-1176)

Status: Pedro asked on 2026-11-12 to go straight from spec to plan, cards and automatic implementation
("quando a spec tiver pronta, monta o plano, cria os cards no automatico e já implementa"). The open
choices below were decided by the author and are recorded here. Ships behind the `runs_api` flag.

## Why

Pedro wants to call his own AI subscriptions (Claude, Codex…) from scripts, over plain HTTP, without
knowing which CLI, account or machine runs the prompt. termhub already knows his accounts, their order
per project, their usage windows and which machines are online. The API reuses that routing and runs
the CLI headless on his machine, under his login. It is for the account owner only: the subscriptions'
terms do not allow handing an account to other people.

## Contract (REST, v1)

Base: `https://app.termhub.dev/api/v1`, `Authorization: Bearer thb_pat_…` (a personal token with the
`runs` scope). No cookie, no CSRF: this prefix is bearer-only. All bodies are JSON validated with zod.

- `POST /runs` → `202 { run_id, status: "queued", events_url }`
  ```json
  {
    "project": "TER",                         // id or key, required: picks accounts, folder and machines
    "prompt": "…",                            // ≤ 100 000 chars
    "capabilities": ["read"],                 // read (default) | edit | run_commands
    "model_class": "default",                 // fast | default | strong; or "model": "<exact id>"
    "provider": null,                         // optional pin: claude | codex
    "machine": null,                          // optional machine id or name, else routed
    "budget": { "timeout_s": 600 },           // ≤ 3600; default 600
    "idempotency_key": null                   // optional; same key within 24 h returns the same run
  }
  ```
- `GET /runs/:id` → the run: `status` (`queued | running | succeeded | failed | cancelled`),
  `provider`, `model`, `machine`, `account` (label only), `workspace` (`project | worktree`, path, branch),
  `result` (final text), `usage` (`input_tokens`, `output_tokens`, `cost_usd` when the CLI reports it),
  `error` (`code`, short message), timestamps.
- `GET /runs?project=&status=&limit=` → the token owner's runs, newest first.
- `GET /runs/:id/events` → `text/event-stream`. Each SSE `id:` is the event's `seq`; `Last-Event-ID`
  resumes. A finished run replays its events and closes. Keep-alive comment every 15 s.
- `POST /runs/:id/cancel` → `202`; the agent kills the process group; final event `done` with
  `status: cancelled`.

Errors: `{ error: { code, message } }` with `401 UNAUTHENTICATED`, `403 SCOPE_REQUIRED`,
`404 NOT_FOUND` (also for another user's run or project, and while the flag is off),
`409 NO_ACCOUNT_AVAILABLE` (with the reason per candidate), `409 AGENT_OUTDATED`,
`422 VALIDATION`, `429 RATE_LIMITED` (with `Retry-After`).

## GraphQL: later

Recommendation: not now. The server has no GraphQL stack, all live features use WebSockets or SSE, and
a `runEvents` subscription would need a second transport (graphql-ws) plus its own auth. REST + SSE
covers every use in the card with `curl`. The service layer (`runs/service.ts`) is written so that a
GraphQL schema (mutation `createRun`, query `run`, subscription `runEvents`) can sit on it later without
touching adapters or routing. A backlog card records it; it is not part of this epic's automatic work.

## Normalized events

One shape for every provider, stored in `api_run_events (run_id, seq, type, payload, at)`:

| type | payload |
|---|---|
| `started` | `provider`, `model`, `machine`, `account`, `workspace` |
| `text_delta` | `text` (partial; may be skipped by clients) |
| `text` | `text` (a complete assistant message) |
| `tool_use` | `id`, `name` (normalized: `read`, `edit`, `shell`, `search`, `web`, `other:<raw>`), `input` (truncated to 2 KB) |
| `tool_result` | `id`, `ok`, `summary` (≤ 500 chars) |
| `question` | `text`, `options` — reserved; v1 runs are non-interactive and never emit it |
| `usage` | `input_tokens`, `output_tokens`, `cost_usd?` (cumulative) |
| `error` | `code` (`account_limited`, `cli_failed`, `timeout`, `agent_offline`, `permission_denied`), `message` |
| `done` | `status`, `result`, `usage` |

Events carry run output, which is the owner's own data: they are never logged (only run id, seq, type,
sizes), are readable only by the owner's `runs` tokens, and are deleted after 7 days (the run row stays
with its usage and status).

## Adapters

An adapter is pure server code: `(capabilities, model) → agent run spec` and `(raw line) → events[]`.
The agent only spawns the CLI and streams stdout lines, so a CLI format change is a server deploy, not an
agent release.

- **Claude Code** (`claude -p --output-format stream-json --verbose --include-partial-messages
  --no-session-persistence`): `read` → `--tools Read,Grep,Glob`; `edit` adds `Edit,Write`;
  `run_commands` adds `Bash`. `--permission-mode dontAsk` (anything not pre-approved is denied, never asked), the same list in
  `--allowed-tools`, an empty `--strict-mcp-config` (no MCP, no termhub tools),
  prompt on stdin. Maps `stream_event` deltas, `assistant` messages, `tool_use`/`tool_result` blocks and
  the final `result` (with `total_cost_usd` and `usage`).
- **Codex** (`codex exec --json --ephemeral --skip-git-repo-check -C <cwd> -s <sandbox> -m <model> -`):
  `read` → `-s read-only`; `edit` or `run_commands` → `-s workspace-write`; approvals off (non-interactive).
  Maps the JSONL thread/turn/item events (agent message, command execution, file change, turn usage).
  The exact event names are captured as fixtures from codex-cli 0.159 in the adapter card before mapping.
- Later: Anthropic/OpenAI API with a key (no machine). Out of this epic.

`model_class` per provider: Claude fast=haiku, default=sonnet, strong=opus, filtered by the person's
blocked models (`chatBlockedModels`, read only, through `conciergeModel`); Codex uses the project
Setup's `models.chatgpt` for default/strong and the CLI default otherwise. An explicit `model` pins the
provider whose ids it matches.

## Routing

1. Project resolved through `scoped(...)` with the token owner's own scope (never view-as).
2. Candidates: the project Setup account order (`loadProjectAi` + `accountsOn`), providers `claude` and
   `chatgpt` only, filtered by `provider`/`model` when given, account and machine both owned by the token's
   user, machine of type `agent`, online, advertising `run.headless`, and linked to the project with a
   folder (`project_machines.cwd`).
3. Skip accounts with an `AiAccountExhaustion` row or a usage peak ≥ 90 % (`control/account-swap.ts`
   helpers, read only); logins about to expire go last (same rule as automatic placement).
4. Start on the first candidate. If it fails with a rate limit **before any `text` event**, mark the
   exhaustion and try the next one (each account once); after output started, end with
   `error account_limited`.
5. None left → `409 NO_ACCOUNT_AVAILABLE` with one reason per candidate.

The routing lives in its own module (`runs/routing.ts`). It reads automation and chat helpers but never
edits `automation/placement.ts`, `automation/dispatcher.ts` or `chat/*`, which other cards change now.

## Workspace

- `read` only → the project's folder on that machine (`project_machines.cwd`), read-only tools.
- `edit` or `run_commands` → a disposable worktree `<worktrees_dir>/<projectId>/run-<id>` from the
  project's default branch via `git.worktree.ensure`, with the run guard (`buildGuardSettings`) for
  Claude: no push, no writes outside the worktree. Kept 24 h so the caller can read or copy the result
  (path and branch in `workspace`), then removed by a sweeper in `runs/` (`git.worktree.remove`).

## Security

- **Owner only.** New scope `runs` in `API_TOKEN_SCOPES`; never granted to gated (concierge) or tab
  tokens. New resource `runs` in `RESOURCES` (admins and the roles that get it). Machines and accounts
  must have `owner_id = token.user_id`: shared or team machines are never used, even for admins.
- **Bearer-only prefix** `/api/v1`, registered outside `/api` with its own hook (`authenticateToken`,
  scope `runs`, `requireFeature('runs_api')`), like the mobile API is.
- **Limits** (database counts, survive restarts): per token 2 running and 30 created per hour; per
  user 4 running; prompt ≤ 100 000 chars; timeout ≤ 60 min. `429` with `Retry-After`.
- **Least privilege:** default capability `read`; no MCP servers; no termhub tools; no push; the CLI's
  own permission prompts are off because the tool list is closed.
- **Trail:** `audit(...)` writes `api_run.create` and `api_run.cancel` (run id, project, provider,
  capabilities; never the prompt); each call is an `ApiTokenEvent`. Runs show in Progresso.
- **Logs:** metadata only (run id, machine id, sizes, exit code); stderr never leaves the machine,
  only the failure label (as the concierge does today).

## Machine agent

Yes, a new agent release (minor, `0.37.0` or the next free one): a channel kind `run` whose open frame
carries a structured spec — `provider` (`claude | codex`), `config_dir`, `cwd`, `model`, `tools`
(Claude) or `sandbox` (Codex), `timeout_ms`, `guard` — never a raw argv. The agent builds the argv
itself from that spec (`packages/claude-cli` gains `buildHeadlessArgs`, new `buildCodexExecArgs`),
writes the prompt to stdin, streams stdout lines, kills the process group on close or deadline, and
advertises `CAPABILITY_RUN_HEADLESS = 'run.headless'`. The server refuses older agents with
`AGENT_OUTDATED` (`requireAgentVersion`). The existing `claude` channel is untouched.

## Screens (behind `runs_api`)

- Configurações › Tokens de API: the `runs` scope checkbox, with a line explaining it lets the token run
  prompts on your own accounts and machines.
- Progresso: a "Runs da API" list (status, provider, model, duration, cost) under the project.

## Impact on other users

None by default: the `runs_api` flag is off for everyone and is turned on per user. With it on, the
person only gains a token scope and a list in Progresso; nothing they already use changes. Agent
`0.37.0` only adds a channel kind; machines that do not update keep working and are skipped by routing.
