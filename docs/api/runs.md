# Personal runs API (`/api/v1/runs`)

Run a prompt headless with **your own** Claude Code or Codex subscription, on **your own** machine, over
plain HTTP. termhub picks the account and the machine from the project's Setup, runs the CLI through the
termhub agent and streams normalized events back over Server-Sent Events. Design:
`docs/superpowers/specs/2026-11-11-personal-runs-api-design.md`.

It is for the account owner only: the subscriptions' terms do not allow handing an account to other
people, so a run only ever uses accounts and machines that belong to the token's owner — never a shared
or team machine, not even for an admin.

## Before you start

- The `runs_api` feature must be on for you (it is off by default while the feature is in testing).
- A personal API token with the `runs` scope: Configurações → Tokens de API. Chat and tab tokens never
  carry it.
- The project's Setup lists at least one Claude Code or Codex account, on a machine of yours that:
  runs the termhub agent **0.37.0 or newer** (it advertises `run.headless`), is online, and is linked to
  the project with a folder.

```bash
export TERMHUB=https://app.termhub.dev   # or your own server
export TOKEN=thb_pat_...
```

> `app.termhub.dev` sits behind Cloudflare Access: from a script, add a service token
> (`-H "CF-Access-Client-Id: …" -H "CF-Access-Client-Secret: …"`) or call your own server.

## Create a run

```bash
curl -sS -X POST "$TERMHUB/api/v1/runs" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "project": "TER",
    "prompt": "Resuma o README em três tópicos.",
    "capabilities": ["read"],
    "model_class": "fast",
    "budget": { "timeout_s": 300 },
    "idempotency_key": "readme-summary-2026-11-12"
  }'
# 202 {"run_id":"…","status":"queued","events_url":"/api/v1/runs/…/events"}
```

| Field | Default | Notes |
|---|---|---|
| `project` | required | Project id or key (`TER`), one of yours. |
| `prompt` | required | Up to 100 000 characters. Sent to the CLI on stdin, never stored, never logged. |
| `capabilities` | `["read"]` | `read` works in the project's folder with read-only tools. `edit` (Edit, Write) and `run_commands` (shell) work in a disposable git worktree. |
| `model_class` | `default` | `fast` / `default` / `strong` (Claude: haiku / sonnet / opus; Codex: the Setup's model, CLI default for `fast`). |
| `model` | — | An exact model id; it also pins the provider it belongs to. Claude families you blocked for the chat are never used. |
| `provider` | — | Pin `claude` or `codex`. |
| `machine` | — | Pin a machine by id or name. |
| `budget.timeout_s` | 600 | At most 3600. |
| `idempotency_key` | — | The same key within 24 h answers the same run instead of starting another. |

Unknown fields are refused (`422 VALIDATION`).

## Stream the events

```bash
curl -N "$TERMHUB/api/v1/runs/$RUN_ID/events" -H "Authorization: Bearer $TOKEN"
```

```
id: 1
event: started
data: {"seq":1,"type":"started","at":"…","provider":"claude","model":"haiku","machine":"jarvis","account":"pessoal","workspace":{"kind":"project","path":"/home/me/termhub","branch":null}}

id: 2
event: text
data: {"seq":2,"type":"text","at":"…","text":"…"}

id: 5
event: done
data: {"seq":5,"type":"done","at":"…","status":"succeeded","result":"…","usage":{"input_tokens":1200,"output_tokens":310,"cost_usd":0.004}}
```

- Each SSE `id` is the event's `seq`. Reconnect with `Last-Event-ID: <seq>` (or `?after=<seq>`) and you get
  only the events after it. A finished run replays its events and the stream closes after `done`.
- A comment line (`: keep-alive`) goes out every 15 s.
- Closing the stream never cancels the run: it goes on, and you can reconnect or read `GET /runs/:id`.

| Event | Payload |
|---|---|
| `started` | `provider`, `model`, `machine`, `account` (label), `workspace` (`kind`, `path`, `branch`). A second `started` means the run moved to the next account before any output (rate limit). |
| `text_delta` | `text` — partial; may be ignored. |
| `text` | `text` — a complete assistant message. |
| `tool_use` | `id`, `name` (`read`, `edit`, `shell`, `search`, `web`, `other:<raw>`), `input` (≤ 2 KB). |
| `tool_result` | `id`, `ok`, `summary` (≤ 500 chars). |
| `usage` | `input_tokens`, `output_tokens`, `cost_usd` when the CLI reports it (Claude does). Cumulative. |
| `error` | `code` (`account_limited`, `cli_failed`, `timeout`, `agent_offline`, `permission_denied`), `message`. |
| `done` | `status` (`succeeded`, `failed`, `cancelled`), `result`, `usage`. Always last. |

Events are kept for 7 days; the run itself (status, result, usage) stays.

## Read and list

```bash
curl -sS "$TERMHUB/api/v1/runs/$RUN_ID" -H "Authorization: Bearer $TOKEN"
curl -sS "$TERMHUB/api/v1/runs?project=TER&status=running&limit=20" -H "Authorization: Bearer $TOKEN"
```

## Cancel

```bash
curl -sS -X POST "$TERMHUB/api/v1/runs/$RUN_ID/cancel" -H "Authorization: Bearer $TOKEN"
# 202 {"run_id":"…","status":"cancelled"}
```

The agent kills the CLI's whole process group; the stream ends with `done` `cancelled`. A run that already
ended stays as it was.

## Routing

The run tries the project's Setup accounts in order (Claude Code and Codex only), skipping an account
whose machine is offline, runs an older agent, is not linked to the project, or whose account is marked
at its usage limit or has a usage window at 90 % or more; a login about to expire goes last. If the CLI
hits a rate limit **before any output**, the account is marked at its limit and the run moves to the next
one. After output started it ends with `error account_limited` instead, so two accounts' answers never mix.

## Workspace

- `read` → the project's folder on the machine.
- `edit` / `run_commands` → a worktree `<worktrees_dir>/<projectId>/run-<id>` on branch
  `termhub/run-<id>`, from the project's base branch. Claude runs with termhub's guard (no push, no writes
  outside the worktree); Codex runs in its `workspace-write` sandbox. The worktree is kept 24 h so you can
  read or copy the result (`workspace.path` in the run), then removed — unless it holds changes nobody
  committed, which git keeps; remove those yourself.

A run never gets MCP servers or termhub's tools, and never pushes.

## Limits and errors

- Per token: 2 runs at once and 30 created per hour. Per person: 4 at once.
- A run lives in the server process that started it: a server restart (a deploy) ends the runs in flight
  with `failed` / `cli_failed` ("server restarted"). Retry them.

Errors answer `{ "error": { "code", "message" } }`:

| Status | Code | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | No token, or a revoked/unknown one. |
| 403 | `SCOPE_REQUIRED` | The token has no `runs` scope. |
| 404 | `NOT_FOUND` | Not your run or project — or the feature is off for you. |
| 409 | `NO_ACCOUNT_AVAILABLE` | No account could take the run; `error.candidates` lists `{ account, machine, reason }` per account. |
| 409 | `AGENT_OUTDATED` | Every machine runs an agent older than 0.37.0. |
| 422 | `VALIDATION` | The body or the query is not valid. |
| 429 | `RATE_LIMITED` | A limit above; wait `Retry-After` seconds. |

Skip reasons: `machine_offline`, `agent_outdated`, `machine_not_linked`, `machine_not_agent`,
`machine_missing`, `exhausted`, `usage_peak`, `exclusive` (the account is exclusive to another project),
`folder_not_absolute` (an old link saved the folder as `~/…`: link the project to the machine again).
