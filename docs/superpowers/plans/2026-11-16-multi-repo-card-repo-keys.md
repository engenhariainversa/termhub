# Cards: `repo_keys` — implementation plan (TER-1070)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a card says which of the project's repositories it touches. Nothing reads the field for eligibility
yet (outline Task 9 does).

**Architecture:** one pure module, `apps/server/src/setup/repo-keys.ts`, turns what a caller names (a key or
`owner/repo`) into the keys a card stores, against the project's effective repositories (`effectiveRepos`).
The tasks repository calls it under the project lock on every create and update that carries the field, so
the REST routes, the MCP tools and later callers share one rule. Ticket import computes the key of a GitHub
ticket's repository with `ticketRepoKeys` (in `setup/tickets-sync.ts`) and hands it to `createFromTicket`.

**Tech stack:** TypeScript, Prisma, zod, vitest (`@termhub/server`).

**Spec:** `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md` (R8, R9a, §6). Outline:
`docs/superpowers/plans/2026-10-07-multi-repo-automation.md`, Task 7.

## Global constraints

- Additive migration: `tasks.repo_keys text[] not null default '{}'`. The previous colour neither reads nor
  writes it, and its new rows get the default.
- A single-repo project sees no change: its cards keep `[]` (spec §3.1).
- Board writes take `lockProject` first (they already do; the repository check runs inside the same lock).
- New error texts go through `msg`/`tk` with `en` and `es` entries; `npm run i18n:check -w @termhub/server`.
- The queue does not read `repo_keys` (card acceptance).

## Decisions

| Question | Options | Choice | Why |
| --- | --- | --- | --- |
| What "multi-repo project" means | (a) more than one repository listed; (b) more than one **enabled** repository | (b) | Matches the board's chip rule (outline Task 8: "shown only when the project has more than one enabled repo"); a disabled repository takes no automatic work. |
| A valid ref in a single-repo project | (a) store it; (b) store `[]` | (b) | R8: empty means the single repository. Storing the legacy key `main` would go stale once discovery names the repository after its folder (R4). |
| A disabled repository | (a) accept; (b) refuse | (b) refuse, naming it | The person turned it off for automatic work; a card targeting it could never run. Turning it back on lets the call through. |
| A repository named by hand that discovery has not keyed yet | (a) invent a key; (b) refuse | (b) | Keys are given by discovery and never change (R4); inventing one here would fork that rule. |
| Order of the stored keys | (a) as given; (b) the project's order | (b) | The same set always reads the same (chips, logs, comparisons). Repeats count once. |
| Epics and subtasks | (a) allow; (b) refuse a non-empty list | (b) | Runs are per work card; an epic's repositories come from its cards (Task 15). `[]` is accepted so a generic clear does not fail. |
| `update_task` semantics | (a) add to the list; (b) replace it | (b) replace, `[]` clears | One call says the whole set, as the board's multi-select will. |
| Where the GitHub ticket key is set | (a) on every sync, for linked cards; (b) at import, when the card is born | (b) | The sync only stages tickets; the card is created by `importTickets`. A sync rewriting keys would undo the concierge's corrections. |
| Output field | `repos` or `repo_keys` | `repo_keys` on work cards only | It says what is stored (keys, never `owner/repo`); epics and subtasks leave it out to keep `list_tasks` short. |

## Tasks

- [x] **Migration and model.** `prisma/migrations/20261116020000_task_repo_keys`, `Task.repoKeys String[]
  @default([]) @map("repo_keys")`, `Task.repo_keys` in `db/repositories/types.ts` and `mapTask`.
- [x] **Resolver.** `setup/repo-keys.ts`: `REPO_KEYS_MAX = 10`, `isMultiRepo`, `resolveRepoKeys(refs, repos)`
  → `{ keys }` or `{ problem: TOO_MANY | UNKNOWN | DISABLED | NO_KEY }`. Tests: `setup/repo-keys.test.ts`.
- [x] **Rules.** `task-rules.ts`: codes `REPOS_NOT_FOR_TYPE`, `TOO_MANY_REPOS`, `REPO_UNKNOWN`,
  `REPO_DISABLED`, `REPO_NO_KEY`; `repoKeysError(problem)` names the repository.
- [x] **Repository.** `loadEffectiveRepos(tx, projectId)` in `project-repositories.ts`; `TaskInput.repo_keys`,
  `TaskPatch.repo_keys`, checked in `insertCard` and `update` under the lock; `createFromTicket` takes resolved
  keys. Tests: `tasks-repo-keys.db.test.ts` (Postgres).
- [x] **Control and MCP.** `createTask`/`updateTask` take `repos`; `taskOut` returns `repo_keys` on work cards,
  so `list_tasks` and the tab tool `get_card` carry them. Tool descriptions carry the inference rule (spec §6).
  Tests: `control/tasks.test.ts`.
- [x] **Ticket import.** `ticketRepoKeys(ticket, repos)` in `setup/tickets-sync.ts`, used by `importTickets`.
  Tests: `setup/tickets-sync.test.ts`, `control/tickets.test.ts`.

## Impact on other users

None. The field is born empty, and empty means "the single repository". A project with one enabled
repository keeps every card at `[]` whatever a tool sends.

## CLIs covered

Claude Code ✅ · Codex ✅ · Cursor ✅ · Gemini ✅ — the field travels through termhub's MCP tools
(`create_task`, `update_task`, `list_tasks`, `get_card`), which every supported CLI reaches the same way.
