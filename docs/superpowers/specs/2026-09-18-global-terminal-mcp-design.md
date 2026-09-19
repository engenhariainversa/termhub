# Global terminal (MCP control plane) — design

Date: 2026-09-18. Status: approved in conversation (sections 1–4), written for implementation.

## 1. Why

termhub already knows every machine, project, tab and AI CLI login of an account, and
its monitor knows which tabs are working or waiting for the user. What it lacks is a
way to drive all of that from **one place, by an agent**: "on the MacBook Pro M4, with
the Claude account *pedrogoiania*, in project Hub Community, write a spec and a plan for
task XPTO", or "create a task in project XPTO with these subtasks".

The "global terminal" is not a new LLM inside termhub. It is any Claude Code session
(on jarvis, on a laptop, on claude.ai) with termhub plugged in as **MCP tools**. The
agents it starts on other machines always run inside ordinary termhub tabs (tmux
sessions), so the user can open the app, watch them and take over.

Success: from a Claude Code session with only the termhub MCP configured, the user can
(a) resolve machines/projects/accounts by name, (b) open a tab and run a command on any
online machine, (c) start Claude Code / Codex / Gemini / Antigravity there under a
chosen account with an initial prompt, follow it and answer its questions, and
(d) create a task with subtasks — all scoped to their own data, with a revocable token.

## 2. Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Form | MCP server. No CLI, no in-app chat in this spec. |
| Where it runs | Inside `apps/server`, Streamable HTTP, stateless, published at `https://termhub.dev/mcp` (public route + bearer token, like `/api/hooks/events`; no Cloudflare Access on that host). |
| Auth | Personal API tokens with per-token scopes `read`, `tasks`, `terminals`. Hash only in the DB, shown once, optional expiry, revocable, last-used visible. |
| Authority | A token never exceeds its user: effective permission = token scopes ∩ the user's `resource:action` grants, always scoped to the user as owner (no "view as"). |
| Tool implementation | Approach A: a shared service layer (`apps/server/src/control/`) called by both REST routes and MCP tools. Official `@modelcontextprotocol/sdk`. |
| Remote agents | Always a visible tab. No headless mode (`claude -p`). Never pass permission-bypass flags. |
| Tasks | Subtasks are in this spec: one level, local only. |
| Delivery | Five small PRs, each deployable alone; the public route ships read-only first. |

## 3. API tokens and the `/mcp` route

### 3.1 Data

`api_tokens`: `id`, `user_id` (FK, cascade), `name`, `token_hash` (unique, sha256 hex),
`scopes` (`text[]`, subset of `read|tasks|terminals`), `expires_at?`, `last_used_at?`,
`revoked_at?`, `created_at`.

`api_token_events`: `id`, `token_id` (FK, cascade), `tool`, `machine_id?`, `project_id?`,
`tab_id?`, `ok`, `error_code?`, `duration_ms`, `created_at`. **Metadata only** — typed
text, screen content, prompts and task bodies are never stored or logged (CLAUDE.md:
terminal content is never logged). Rows older than 30 days are pruned by the hourly
purge timer in `app.ts` (the one that already calls `authService.purgeExpired()`).

Token format: `thb_pat_` + 32 random bytes base64url (43 chars), following
`monitor/token.ts` / the agent token. Both migrations are additive.

### 3.2 Management

New resource `api_tokens` in the `RESOURCES` catalog, routes registered through
`guarded('api_tokens', …, '/api-tokens')`: list own tokens (never the hash), create
(`name`, `scopes`, `expires_in_days?` → returns the plain token once), revoke. Users
only ever see and revoke their own tokens; admins get no cross-user view in this spec.
Web: Configurações → "Tokens de API" (create dialog with scope checkboxes and a
copy-once token panel including the ready-made `claude mcp add` command; list with
scopes, last use, expiry; revoke). UI copy in pt-BR.

### 3.3 Route

`POST /mcp` (plus the `GET`/`DELETE` the transport requires, answered 405 in stateless
mode), registered outside `/api`, `config: { public: true }` so the session/CSRF
middleware skips it, with its own `onRequest`:

1. `Authorization: Bearer thb_pat_…` → hash → lookup. Missing, unknown, revoked or
   expired → `401` with a constant body; the response never distinguishes the cases.
2. Load the user, role and grants; build the same `request.scope` a web request gets,
   with `ownerId = createAs = user.id`.
3. Update `last_used_at` at most once a minute per token.

A fresh MCP server instance handles each request (stateless transport), so a revoked
token stops working on the next call and there is no server-side session to invalidate.
`tools/list` is **filtered by the token's effective scopes** — the model never sees a
tool it cannot call. Every `tools/call` writes one `api_token_events` row.

Per-token limits, enforced in the control layer: 10 concurrently open tabs created by
the token; 120 tool calls per minute.

### 3.4 nginx

`deploy/nginx/termhub.dev.conf.tmpl`, vhost `termhub.dev`: `location = /mcp` proxied to
the active color like `/api/hooks/events`, with its own zone
`limit_req_zone $http_cf_connecting_ip zone=termhub_mcp:1m rate=10r/s` (burst 20),
`limit_req_status 429`, `client_max_body_size 256k`, `proxy_read_timeout 120s` (for
`wait_for_state`) and `proxy_buffering off`.

## 4. Control layer and tools

`apps/server/src/control/` holds the operations; routes and MCP tools are thin callers.
Every function takes `(repos, scope, input)`, loads entities through `scoped()`
(outside the owner's scope → not found) and validates input with zod. Tool names and
schemas are English; error messages are pt-BR and say what to do next.

### 4.1 Scope `read`

| Tool | Returns |
|---|---|
| `list_machines` | id, name, os, `online`, capabilities |
| `list_projects` | id, name, cwd, status, machine; optional `machine_id` filter |
| `list_tabs` | id, name, `alive`, monitor `state`, `state_text`, linked task; filter by project or machine |
| `list_ai_accounts` | id, provider, label, machine. Never the `configDir` path or any credential |
| `find` | fuzzy name lookup across machines, projects and AI accounts (case/diacritic-insensitive substring, ranked), so "MacBook Pro M4" / "Hub Community" / "pedrogoiania" resolve in one call |
| `read_screen` | last N lines of a tab (default 200, max 2000) via `captureScreen` |
| `wait_for_state` | blocks until the tab leaves `working` or the timeout (max 90 s); subscribes to `monitor/bus.ts`, no polling. Timeout is not an error: `{ timed_out: true, state }`. For tabs with no hook state it returns at once with a note pointing to `read_screen` (there is no tmux-polling fallback: the monitor is hook-driven) |

### 4.2 Scope `terminals`

| Tool | Does |
|---|---|
| `open_tab` | creates the tab and **ensures its tmux session detached** in the project's cwd, so it is alive without a browser |
| `send_input` | literal text + optional Enter (Enter sent separately after a pause, as today); 4000-char cap. If the tab is `waiting_permission`, requires `answering_permission: true` |
| `send_key` | one key from a closed list: `Enter`, `Escape`, `C-c`, `Up`, `Down`, `Tab`, `y`, `n`, `1`–`9` |
| `run_command` | `send_input` + Enter, then waits for the tab to settle and returns the screen. No exit code — it is an interactive session |
| `close_tab` | kills the session and removes the tab. Only tabs created by this token unless `force: true` |
| `start_agent` | see 4.4 |

Tabs record `created_by_token_id?` (nullable column, additive) for the `close_tab` rule
and the open-tab limit.

### 4.3 Agent machines: three new named RPCs

Today `sendKeysToSession` runs shell through `runOnMachine`, which **throws for
`agent` machines** (`POST /tabs/:id/input` answers 409 for them), and a tab's tmux
session is only created when a browser attaches a PTY. Machines are agent-only going
forward, so this spec adds to `packages/agent-protocol` and `apps/agent`:

| RPC | Params | Notes |
|---|---|---|
| `tmux.ensure` | `session`, `cwd` (`machinePath`) | `has-session` else `new-session -d -s … -c …`; idempotent; returns `{ created }` |
| `tmux.sendText` | `session`, `text` (≤ 4000), `enter` | `send-keys -l --`, pause, `send-keys Enter`; args passed as argv, never through a shell |
| `tmux.sendKey` | `session`, `key` (the closed enum above) | |

This keeps the agent rule "only named RPCs, the server never sends shell text to be
executed by the agent": the agent runs fixed `tmux` argv. It does not widen what the
server can do on a machine — the server can already write arbitrary bytes into a
session through the PTY stream the browser uses. The local/ssh transports get the same
three operations through `runOnMachine` + `shellQuote`. `sendKeysToSession` is
reimplemented on top of them, which also removes the 409 from the existing monitor
input route.

`PROTOCOL_VERSION` stays 1 (additive RPCs). Each route that calls one of these RPCs on
an agent machine first calls the existing `requireAgentVersion(machine, '0.2.0')` from
`apps/server/src/agent/errors.ts` (added with the monitor hooks' `hooks.install`, PR #46,
agent 0.1.4). It checks the connected agent's reported version and answers **409
`AGENT_OUTDATED`** with the same update message the hooks use. An offline agent passes
through, and the RPC itself answers 503. No second version check and no new message:
an MCP tool that hits it returns that message as its `isError` result (§6) and records
`AGENT_OUTDATED` as the audit row's `error_code`. The three RPCs go into
`packages/agent-protocol/src/rpc.ts` and `apps/agent/src/rpc/index.ts` next to
`hooks.install` / `hooks.uninstall`. Operations that fail for a reason meant for the
user use the `failed` RPC error code from the same PR.

### 4.4 `start_agent`

Input: `project_id`, `account_id`, `prompt` (≤ 4000), optional `task_id`, `tab_name`.

1. Load project and account through the scope. The account must belong to the
   project's machine; otherwise the error lists the accounts that exist there.
2. Check the provider binary in the machine's `capabilities`. `DETECT_TOOLS` gains
   `codex`, `gemini` and the Antigravity CLI binary (exact name confirmed during
   implementation against an installed CLI).
3. `open_tab` (named after the task or `tab_name`) + ensure session.
4. Build the launch line from a fixed per-provider table; every value goes through
   `shellQuote`:

   | Provider | Command | Account selection |
   |---|---|---|
   | `claude` | `claude` | `CLAUDE_CONFIG_DIR=<configDir>` |
   | `chatgpt` | `codex` | `CODEX_HOME=<configDir>` |
   | `gemini` | `gemini` | default login only |
   | `antigravity` | Antigravity CLI | default login only |

   `configDir = null` → no variable. A non-default `configDir` on `gemini` /
   `antigravity` → explicit "not supported yet" error rather than silently starting
   the wrong account. No permission-bypass flag is ever added.
5. Type the launch line, wait for the TUI to be ready (`idle`/`waiting_input`, or a
   time fallback when the machine has no hooks), then send the prompt and the Enter
   separately.
6. With `task_id`: set `task.tabId` and move the task to `doing`.
7. Return `tab_id` and the app URL of the tab.

If anything fails after the tab exists, the tab is **kept** and the error carries its
`tab_id`, so the screen can be inspected. Nothing is queued for offline machines:
terminal tools fail within 10 s with "A máquina não respondeu".

## 5. Subtasks

### 5.1 Schema and rules

`Task.parentId String? @map("parent_id")`, self-relation, `onDelete: Cascade`, index
`[parentId, position]`. Additive migration. Rules live in `repos.tasks`:

- **One level.** A task with a parent cannot be a parent; enforced in the repository.
- A subtask takes its parent's `projectId`; a parent from another project is rejected.
- A subtask has its own `status` but no board column; `position` orders siblings.
  `move` (column move) rejects subtasks; they get `reorder`.
- Deleting a parent cascades; `tickets.unlinkTask` runs for the parent and each child.
- Synced tasks (`externalKey` set) stay flat; subtasks are always local
  (`externalKey = null`), so the `[projectId, externalKey]` upsert is untouched.
- The parent's status never changes automatically; the card shows `done/total`.

### 5.2 REST

`listByProject` returns top-level tasks with nested `subtasks` and
`subtask_counts: { done, total }`. `POST /projects/:id/tasks` accepts `parent_id`.
New `POST /tasks/:id/subtasks` (`{ items: [{ title, description? }] }`, ≤ 50, one
transaction) and `POST /tasks/:id/reorder`. `PATCH /tasks/:id` works for subtasks.
No new resource: existing `tasks:*` grants and `scoped(...).task(id)`.

### 5.3 MCP tools, scope `tasks`

`list_tasks` (nested, optional status filter); `create_task` (`title`,
`description?`, `status?`, `subtasks?: [{ title, description? }]` — one call, one
transaction, returns ids and the board URL); `add_subtasks`; `update_task` (task or
subtask); `move_task` (top-level only); `delete_task` (`confirm: true`; reports how
many subtasks went with it).

### 5.4 Web

`TasksBoard.tsx`: cards show `✓ 3/5` when there are subtasks; the task detail lists
subtasks with a checkbox (`todo` ↔ `done`), inline title edit, "Adicionar subtarefa"
and drag reorder. A subtask in `doing` (set by an agent) shows an "em andamento"
marker. No new screen.

## 6. Errors

Tool failures return an MCP result with `isError: true` and an actionable pt-BR
message; JSON-RPC errors are reserved for malformed requests. Insufficient scope:
"Este token não tem o escopo `terminals`". Revoked/expired token: `401` on the next
HTTP call. Rate or tab limit exceeded: tool error naming the limit.

## 7. Testing

- Unit: token generation/hash/expiry; scopes ∩ grants; the `start_agent` launch table
  (exact output; `configDir` and `cwd` containing quotes, spaces and `;` stay inert);
  subtask rules (one level, same project, cascade, unlink); `find` ranking.
- `/mcp` through `fastify.inject`: no token → 401; **another user's token sees none of
  the first user's machines/projects/tabs/tasks**; `tools/list` filtered by scope;
  `send_input` text and `read_screen` output absent from logs and `api_token_events`.
- Agent: the three RPCs against real tmux on an isolated socket (`-L`), never the
  server the test runs inside; `tmux.ensure` idempotent.
- Integration: `open_tab` → `send_input` → `read_screen` round trip; `start_agent`
  with a fake "agent" script that prints a prompt (no CLI login needed in CI).
- Web: existing typecheck + build.
- Before every push: the Docker `node:20` typecheck/build from CLAUDE.md; CI's
  `prisma migrate diff --exit-code`.

## 8. Delivery order

1. **Subtasks** — migration, repository, REST, board.
2. **API tokens** — tables, `api_tokens` resource, settings UI. No route accepts them yet.
3. **`/mcp` read-only + nginx** — control layer, SDK, scope `read` tools, vhost
   location. Validated from outside with a `read` token before continuing.
4. **Tasks + terminals** — needs PR #46 (monitor hooks on agents, `requireAgentVersion`)
   merged first; agent RPCs (`@termhub/agent` 0.2.0 published),
   `sendKeysToSession` on the new operations, scopes `tasks` and `terminals` except
   `start_agent`.
5. **`start_agent`** — `DETECT_TOOLS`, launch table, README section with
   `claude mcp add --transport http termhub https://termhub.dev/mcp --header "Authorization: Bearer …"`.

Each merge to `main` deploys. All migrations are additive, so the previous color keeps
serving during the blue/green switch.

## 9. Out of scope

In-app chat/agent; a `termhub` CLI; OAuth for MCP; per-token machine allowlists;
headless agent runs; queuing commands for offline machines; nested subtasks; syncing
subtasks with Linear/Jira/GitHub; automatic parent status; live screen streaming over
MCP; admin cross-user token management; custom config dirs for Gemini/Antigravity.
