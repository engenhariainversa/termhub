# MCP: link a project to a machine from the chat (TER-105)

Date: 2026-09-26 · Card: TER-105 · Unblocks TER-104 (link termhub to "capitão américa" for the TestFlight build).

Decisions below were taken without a review round (Pedro authorized deciding the details alone).

## Goal

The concierge (and any personal API token) can link a project to another machine with a working
directory, change that directory, and unlink it — the same operations the project settings screen
does through `POST/PATCH/DELETE /api/projects/:id/machines[/:machineId]`, with the same rules.

## Tools

| Tool | Input | Token scope | Grant | Gate class |
|---|---|---|---|---|
| `link_project_machine` | `project_id`, `machine_id`, `cwd`, `create_dir?` | `terminals` | `projects:create` | write |
| `set_project_machine_cwd` | `project_id`, `machine_id`, `cwd`, `create_dir?` | `terminals` | `projects:update` | write |
| `unlink_project_machine` | `project_id`, `machine_id`, `confirm?` | `terminals` | `projects:delete` | write; irreversible with `confirm: true` |

- **Grants** mirror the REST routes (`guarded('projects', …)` derives create/update/delete from
  POST/PATCH/DELETE), so a role that can do it on screen can do it by MCP, and no other.
- **Scope `terminals`**: no new token scope. A link decides where a project's terminals run; the
  `terminals` scope already allows opening tabs and running commands on the user's machines, which is
  strictly more than this. A new scope would force every existing token (and the concierge's mint)
  to change for a two-tool feature.
- **Scoping**: `ctx.scoped.project` / `ctx.scoped.machine` / `ctx.scoped.projectMachine` — a project or
  machine outside the user's scope is a 404, exactly like the routes.

## Behaviour

- `cwd` is absolute (`/…`, `~`, `~/…`; Windows `C:\…` stored unchecked, as in REST). The directory is
  checked on the machine with `ensureDirectory` (created with `mkdir -p` when `create_dir: true`), and
  the **resolved** absolute path is stored. A missing directory without `create_dir` fails with
  `DIR_NOT_FOUND` and a message that says what to do: repeat with `create_dir: true`, or clone the repo
  first (open a tab on that machine and `git clone`), then link. No clone option in the tool itself:
  cloning needs credentials and a URL the server does not have; a tab already does it.
- An offline agent machine fails with the agent's own error (the check needs the machine).
- The answer reports `{ project_id, machine_id, machine_name, cwd, created_dir, git_repo }`.
  `git_repo` is best effort: `true` when the directory holds a `.git` folder, `false` when it does not,
  `null` when the listing failed. Not a git repo is a warning in the answer, never a refusal.
- `link_project_machine` on an existing link fails with `MACHINE_ALREADY_LINKED` pointing at
  `set_project_machine_cwd`.
- `unlink_project_machine`: when the project has tabs on that machine and `confirm` is not true, it
  refuses with `CONFIRM_REQUIRED` naming how many tabs (and their names) would be closed; nothing
  changes. With `confirm: true`, or when there are no tabs, it does what the REST route does: kill the
  tmux sessions (best effort), delete the tabs, announce them removed, unlink, tell the public bus the
  robots left. The answer says how many tabs were closed.
- Side effects shared with REST (public bus on link of a published project, tab removal events on
  unlink) live in one helper used by both the route and the tool, so they cannot drift.
- `list_projects` reads the links from the database, so it shows the change immediately.

## Gate

`link_project_machine` and `set_project_machine_cwd` are `write` (reversible; the user confirms in
chat). `unlink_project_machine` is `write` without `confirm` (it either unlinks a machine with no tabs —
undone by linking again — or refuses), and `irreversible` with `confirm: true` (it kills sessions).
The confirmation card reads as a sentence: "vincular a pasta `~/termhub` no projeto termhub, no
capitão américa", "trocar a pasta para `…`", "desvincular a máquina (e fechar as abas dela)".

## Audit

Nothing new: the MCP route already writes one `api_token_events` row per call with `project_id` and
`machine_id` taken from the arguments.

## Tests

- Unit (`control/project-links.test.ts`, mocked repos/fs like `terminals.test.ts`): resolved cwd stored,
  `DIR_NOT_FOUND` message, already-linked, `git_repo` true/false/null, unlink refusal with tabs, unlink
  with confirm closes tabs, unlink without tabs.
- `gate.test.ts`: classes of the three tools, including `confirm`.
- `chat-actions-view` summaries for the three tools.
- `mcp/route.test.ts` / tools: the tools are listed only with scope `terminals` and the grants.
