# Agentic board: automatic work on the board — design

Epic TER-852, written on 2026-10-04. Server, machine agent, web and mobile app; several additive
migrations.

The maintainer took five decisions in the chat on 2026-10-04 (memory `note:fgzdq4ehq0is`, from
`message:wkk8gwhe5len`); they are in section 2.1 and are not reopened here. This document took every
other decision, and the reason sits next to each one. Section 15 lists what only the maintainer can
settle.

## 1. Problem

Read from the code at `63a57a18`.

For days, cards sat on the board while machines and AI accounts were idle. Every step needs the
maintainer: opening a tab, telling the agent to start, answering its questions, approving the merge,
following the deploy. The epic asks for the opposite: cards marked for automatic work are picked up
and carried to production without anyone waiting, inside rails each project sets.

What already exists and is reused:

| Piece | Where | What it gives |
| --- | --- | --- |
| Starting an agent on a card | `control/agents.ts` `startAgent` (l.282), `placeAgent` (l.213), `attachTask` (l.273) | Opens a tab, types the CLI line, links the card, moves it to the agent column (`tasks.startWork`, `projects.agent_column_id`). It runs without HTTP through `controlContextFor(repos, user)` (`control/context.ts:37`), as `chat/auto-answer.ts:194` already does. |
| Account choice | `ai/project-accounts.ts` `accountsOn`, `agents.ts` `firstWithRoom`/`hasRoom`, `control/account-swap.ts` (`SWAP_MAX_UTILIZATION` 90) | Project accounts in priority order; "room" = live usage below 90 %. |
| Tab state | `monitor/state.ts`, `monitor/ingest.ts`, `monitor/bus.ts` (`monitorBus`) | `working`, `waiting_input`, `waiting_permission`, `idle`, `error`, `waiting_background`, from hooks. A Claude `StopFailure` with `rate_limit` sets `tabs.rate_limited_at`; `stale-working.ts` notices an agent that exited. |
| Questions from tabs | `chat/tab-questions.ts`, `chat/auto-answer.ts`, `chat/wake.ts`, `memory/blocklist.ts` | Question cards, the repeat-from-memory path (`REPEAT_MIN_SIMILARITY` 0.98), the 60 s countdown (`AUTO_ANSWER_DELAY_SECONDS`), waking the chat on an unanswered card (gated by "Responder sozinho" and `AUTO_WAKE_MAX_PER_HOUR` 12), and the keyword block on deploy/merge/delete/publish. |
| Chat gate | `chat/gate.ts`, `chat/gate-runtime.ts` `applyGate`, `routes/m-chat.ts:302` | Classes `read`/`self_mediated`/`write`/`irreversible`; grants per tab, project and standing; PIN on the phone for anything but a `write` approval. |
| PRs, CI and deploy per card | `ci/scheduler.ts` (60 s), `ci/sync.ts`, `task_pull_requests` | Polling with the owner's GitHub integration token; PRs linked to cards by `KEY-n` refs; `ci_state`, `deploy_state` (on the merge commit, when `repo.deploy_workflow` is set). No base branch is stored; nothing merges. |
| Project setup | `setup/schema.ts` (`SETUP_VERSION` 2), `routes/setup.ts`, `SetupForm.tsx` | `repo` (base branch, `branch_pattern` `{ticket}-{slug}`, `draft_pr`, `deploy_workflow`), `runner` (`setup_command`, `worktree`), `approvals` (six `ask`/`auto` switches), `ai` (accounts, models). `runner` and `approvals` are stored and shown but no server code reads them. |
| Push | `mobile/push.ts` `MobilePushService` | Push for confirmations, tab questions and replies, to devices without a live socket. |
| Background jobs across blue/green | `auto-answer.ts:164`, `chat-live-runs.ts`, `ws/drain.ts` | Two colours overlap during a deploy. Coordination is by conditional `UPDATE` claims and row locks; there is no leader election and no advisory lock. A draining instance stops claiming. |

What is missing:

1. A way to mark cards for automatic work (no tags or flags on `tasks`).
2. Something that starts agents without a person: there is no loop that reads the board.
3. Isolation: a tab's cwd is always `project_machines.cwd`; nothing creates branches or worktrees,
   and the agent has no RPC that runs git.
4. A policy: nothing says how far an agent may go. `approvals` is unread.
5. Carrying code to production: nothing merges, opens the epic PR, or reacts to a red CI.
6. Measurement and brakes: tabs have no token or cost count, and there is no pause.

## 2. Decisions

### 2.1 Taken by the maintainer (2026-10-04)

| # | Question | Answer |
| --- | --- | --- |
| M1 | Concurrency ceiling | None at first: neither per machine, per account, nor on cost. Cost is still measured and a kill switch exists. |
| M2 | What makes a card eligible | A tag "automático" on the card. Marking an epic propagates the tag to its cards, existing and future; unmarking removes it. |
| M3 | Autonomy | As much as possible: open PR, merge with green CI, deploy, npm publish and OTA, alone. Stores are out for now. |
| M4 | Branches | Each card opens a PR against its epic's branch; the epic branch reaches main later through the integrator. |
| M5 | Hours | 24 h. |

### 2.2 Taken here

| # | Topic | Decision | Why |
| --- | --- | --- | --- |
| D1 | Shape of the tag | A boolean column `tasks.auto`, shown as the tag "automático". No generic labels. | The board has no labels and the epic needs one. A labels system is a feature of its own (YAGNI). The boolean on epics too makes propagation a plain update. |
| D2 | Propagation | Marking an epic sets `auto` on every top-level card of that epic and on the epic. Unmarking clears them all, including cards that were marked one by one. A card created in, or moved into, an automatic epic gets `auto = true`. Moving a card out of an automatic epic keeps its value. | M2, read literally. Clearing everything on unmark is the predictable brake; keeping the value on move-out avoids a card silently leaving the queue. |
| D3 | Opt-in | Nothing runs until the project turns on `automation.enabled` in its setup (default `false`). The tag can be set while it is off; the queue then shows "trabalho automático desligado no projeto". | Section 3: no other user gets agents started on their machines without asking. |
| D4 | Autonomy levels | `automation.autonomy`: `pr` < `merge` < `deploy` < `release`. Default `release`, which is M3. Store submissions are never automatic at any level. | M3 asks for the maximum. npm and OTA are both "publication of an artifact" and in termhub both are CI workflows that run on a push to main, so they are one level with a per-project list of what counts as a release (D6). A fifth level would only split two workflows that always ship together. |
| D5 | Who merges | The server merges, through the GitHub API with the project's integration token, after checking CI, mergeability and the policy. Agents in automatic tabs push branches and open PRs; they never merge. | The policy must be enforced, not requested. A prompt can be ignored; a server check cannot. It also gives one place to record every merge (feed, card). |
| D6 | What level a PR needs | Computed by the server from the PR's changed files and its base: into the epic branch → `merge`; into the base branch → `merge`, or `deploy` when `repo.deploy_workflow` is set; any changed file matching `automation.release_paths` → `release`; any file matching `automation.store_paths` → `store` (never automatic). Paths are globs in the setup. | Generic for every project; termhub fills its own globs (`apps/agent/package.json`, `apps/mobile/**`, `packages/mobile-api/**` for release; `apps/mobile/app.json`, `apps/mobile/app.config.js` for store). The rule follows the CLAUDE.md fact that a native change needs a store build. |
| D7 | Above the level | The merge waits and an approval card appears in the chat, class `irreversible` (PIN on the phone). Approving merges once. | The epic's rule ("vira card de aprovação, nunca execução silenciosa"). Reuses the gate's pending card and PIN path. |
| D8 | Branch names | Epic: `automation.epic_branch_pattern`, default `epic/{ref}-{slug}` (e.g. `epic/TER-852-termhub-agentico`). Card: the existing `repo.branch_pattern` (`{ticket}-{slug}`), cut from the epic branch. A card whose epic is not automatic (tagged alone) is cut from, and opens its PR against, `repo.base_branch`. | M4 for epics. A lone card has no epic branch to target, and creating one per stray card would make every small fix wait for an integrator. |
| D9 | Where code is written | A git worktree per card and one per epic on the machine, under `automation.worktrees_dir` (default `~/.termhub/worktrees`), path `<dir>/<project id>/<ref>`. Created and removed by a new agent RPC. The tab opens with that cwd. The epic branch itself is created on GitHub by the server. | Two agents of the same epic must not share a directory. Creating the branch through the API needs no machine and makes it visible before any tab exists. |
| D10 | Machines | Automatic runs need an agent machine with the `worktree` capability (agent 0.16.0). `ssh` and `local` machines are never chosen; a card with only such machines waits with the reason. | New machines are already agent-only (`routes/machines.ts:115`). Building git over ssh too doubles the code for a path the maintainer does not use. |
| D11 | Dispatcher | A server loop: a tick every 15 s plus a tick on relevant events (tag set, tab stopped, run ended, setup saved, pause lifted). Each card is claimed through a row in `automation_runs` with a partial unique index on the active statuses. A draining instance stops claiming. | Same coordination as the auto-answer sweeper; two colours never start the same card. 15 s keeps "less than a minute" (TER-859) with no hot loop. |
| D12 | Who the agent runs as | The project owner: `controlContextFor(repos, owner)`. | Automation acts for the owner of the project's data; there is no session at 3 a.m. |
| D13 | Concurrency | No ceiling (M1). `automation.max_parallel` exists, default `null` (no ceiling), so a ceiling is one setting away. | M1, and the epic asks for the limit to stay configurable. |
| D14 | Account choice | The existing order and "room" rule (`firstWithRoom`), minus accounts marked exhausted (D16). With no account with room, the card waits ("sem conta com folga"); it is never started on a full account. | `startAgent` falls back to the first account with a note; automation must not, or it would start into a wall. |
| D15 | When a tab stops | `waiting_input` after a Stop with no open question card: the server types a resume message, at most `automation.resume_max` (default 3) times per run, then wakes the chat to read the last answer and decide (TER-887), then escalates. `waiting_background` is not a stop (lesson TER-615). An agent that exited (`stale-working` → `idle`) is restarted once in the same worktree. | Bounded retries; the agent's own background work is respected. |
| D16 | Rate limit | `StopFailure rate_limit` (already detected) marks the account exhausted until the reset that `getAccountUsage` reports (or 1 h when unknown). The existing auto swap runs if the machine allows it; otherwise the run waits and is resumed after the reset. A run is never resumed into a limit. | No loop, as TER-859 requires; reuses `account-swap.ts`. |
| D17 | How a run ends | The agent calls the tab tool `report_card` (`done` with the PR URL, or `blocked` with a reason). Without the call, the run also counts as done when the CI sync links an open PR from the card's branch and the tab has stopped. | An explicit signal is reliable; the fallback covers an agent that forgets. |
| D18 | Questions in automatic tabs | Choice: (1) memory repeat (existing, 0.98); (2) the option marked "(Recomendado)" when the keyword block does not fire, scheduled with the 60 s countdown; (3) wake the chat; (4) escalate. Permission: answered "allow" only when the request matches the project's allowed rules (D19) and the level; otherwise escalate. "Responder sozinho" is not required for automatic tabs: `automation.enabled` is the opt-in. | The epic's "memória primeiro, Pedro por último". The keyword block keeps deploy/merge/delete out of guesses. |
| D19 | Permissions of automatic agents | Claude Code starts with `--permission-mode acceptEdits` and `--allowedTools` from `automation.allowed_tools` (default: git except push --force, `gh pr create/view/checks`, the project's test and build commands). Never a bypass flag. | Edits in its own worktree are the job; everything else stays visible. A bypass flag is a question for the maintainer (section 15). |
| D20 | Integrator | When every non-epic card of an automatic epic is `done` and their PRs are merged into the epic branch, the server opens (or updates) the epic PR to the base branch and starts an integrator run in the epic worktree: merge the base branch in, resolve conflicts with the playbook (section 9.3), run the checks, push. The server then merges per D5/D6 and follows CI, deploy and release workflows. | M4 and TER-872, with the merge kept on the server (D5). |
| D21 | Red CI | The run that owns the PR receives "CI falhou" with the failing jobs' names and is asked to fix, up to `automation.fix_attempts` (default 3) per PR; then the card or epic is escalated. | No endless loop (TER-900). |
| D22 | After the deploy | The server records the deploy and release workflow runs on the merge commit (existing `deploy_state`, plus `automation.release_workflows`). Automatic rollback is out of this epic: a failed deploy freezes automation for the project and escalates. | blue/green already keeps the old colour until the new one is healthy; the spike (TER-900) decides on smoke tests and automatic rollback. |
| D23 | Cost | Tokens per tab read from the Claude Code transcript (`transcript.read`, agent 0.15.0) on each Stop, stored as counts per tab, summed per card, epic and account. Cost is an API-price estimate from a price table in the server. Codex tabs show "—". | The transcript is the only per-turn usage source; counts are metadata, never content. Subscription accounts are not billed per token, so the number is "equivalente em API". |
| D24 | Kill switch | `automation_paused_at` on users (global) and projects. Pausing stops the dispatcher, the merge executor and the automatic answers within 5 s (checked before every action and broadcast). Running tabs finish their current turn and are not resumed; "Pausar e interromper" also sends Escape to them. | The main brake (M1). Interrupting is optional because killing a turn mid-edit can leave a worktree half-written. |
| D25 | Feed | Table `automation_events`; shown in Progresso (web and app); the chat receives only escalations, merges, deploys, quota events and the daily summary; push only for escalations and the summary. | A message per started card would bury the chat. |
| D26 | Daily summary | Per user, at `automation.summary_hour` in the user's IANA time zone (saved from the client when the setting is saved), default off. | Different people, different hours; never assume the maintainer's zone. |
| D27 | Prompts | Server-side templates per role (implementer, integrator, fixer), pt-BR, editable per project (`automation.prompts.*`, `null` = default). Server-typed messages start with `[termhub automático]`. | TER-895. A marker lets the agent tell the termhub's messages from text pasted by someone. |

## 3. Impact on other users

- Nothing changes for a project that does not turn on "Trabalho automático" in its setup: the default
  is off (D3), no loop touches its cards, no column or prompt changes.
- The tag "automático" appears on every board and can be set by anyone with `tasks:update`; while
  the project's automation is off it only shows the reason.
- When a project turns it on, the autonomy level shown is `release` (the maintainer's M3). Turning
  automation on, and raising the level to `deploy` or above, asks for confirmation (and the PIN on
  the phone). See section 15, item 1.
- Automatic runs need agent 0.16.0 on the machine; older machines keep working as today and are
  skipped by the dispatcher with a reason.
- Level: per project (setup), plus a per-user global pause.

## 4. Data model

All migrations are additive and backward compatible (the old colour keeps serving during a deploy).

- `tasks.auto boolean not null default false` (D1). Index `(project_id, auto)` where `auto`.
- `task_pull_requests.base_ref text null`, filled by the CI sync from `pull.base.ref`;
  `task_pull_requests.changed_level text null` (D6), filled when the merge executor classifies it.
- `projects.automation_paused_at timestamptz null`, `users.automation_paused_at timestamptz null`,
  `users.time_zone text null` (D24, D26).
- `automation_runs`:
  `id`, `project_id`, `task_id` (card or epic), `role` (`implementer` | `integrator` | `fixer`),
  `status` (`queued` | `starting` | `running` | `waiting` | `done` | `blocked` | `failed` | `cancelled`),
  `waiting_reason` (text: `quota`, `question`, `ci`, `approval`, …), `tab_id`, `machine_id`,
  `account_id`, `branch`, `worktree_path`, `resume_count`, `fix_count`, `claimed_by` (instance id),
  `heartbeat_at`, `started_at`, `ended_at`, `created_at`.
  Partial unique index on `(task_id)` where status in (`queued`, `starting`, `running`, `waiting`):
  never two active runs on a card (TER-861).
- `automation_events`: `id`, `project_id`, `task_id null`, `run_id null`, `kind`, `payload jsonb`
  (ids, urls, counts; never terminal content), `created_at`. Index `(project_id, created_at desc)`.
- `ai_account_exhaustions`: `account_id` (pk), `until`, `reason`, `created_at` (D16).
- `tab_usage`: `tab_id` (pk), `task_id null`, `account_id null`, `model`, `input_tokens`,
  `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd_estimate numeric`,
  `transcript_offset bigint`, `updated_at` (D23).

Setup (`setup/schema.ts`) gains a block; no `SETUP_VERSION` bump is needed because
`normalizeSetup` fills defaults:

```ts
automation: {
  enabled: false,
  types: ['story', 'task', 'bug'],          // eligible card types (TER-853)
  autonomy: 'release',                       // 'pr' | 'merge' | 'deploy' | 'release' (D4)
  release_paths: [],                         // globs (D6)
  store_paths: [],                           // globs (D6)
  release_workflows: [],                     // workflow names to follow after a merge (D22)
  epic_branch_pattern: 'epic/{ref}-{slug}',  // (D8)
  worktrees_dir: '~/.termhub/worktrees',     // (D9)
  allowed_tools: null,                       // null = the default list (D19)
  max_parallel: null,                        // null = no ceiling (D13)
  resume_max: 3, fix_attempts: 3,            // (D15, D21)
  daily_budget_usd: null,                    // null = off (TER-892)
  summary_hour: null,                        // 0..23, null = off (D26)
  prompts: { implementer: null, integrator: null, fixer: null },  // (D27)
}
```

The legacy `approvals` block stays as it is (stored, unread). It is not reused: its six switches do
not map onto cumulative levels, and nothing reads them today.

## 5. Eligibility (TER-853)

`automation/eligibility.ts` (pure): a card is eligible when all hold, and otherwise carries the first
failing reason, in this order:

| Check | Reason (pt-BR, shown on the card) |
| --- | --- |
| project `automation.enabled` | "Trabalho automático desligado no projeto" |
| no pause (user or project) | "Automático pausado" |
| `auto` | — (not in the queue) |
| top-level, type in `automation.types` | "Tipo não permitido no automático" |
| sits in a `todo` column | — (backlog and doing are not taken; done is finished) |
| has a description or subtasks | "Sem descrição" |
| no active run, no live linked tab | "Já tem um agente" |
| an agent machine with `worktree` capability is linked | "Nenhuma máquina com agente 0.16 ligada ao projeto" |
| repo configured (`repo.full_name`, integration) | "Repositório não configurado no Setup" |

Order of the queue: board order (column position, then card position) — the board order is the
priority (TER-853). The eligibility of a card whose tag is set but which fails a check is returned by
the API so web and app can show the reason.

## 6. Policy (TER-878)

`automation/policy.ts` (pure):

- `LEVELS = ['pr', 'merge', 'deploy', 'release'] as const`; `allows(level, needed)`; `store` is never
  allowed.
- `requiredLevel({ base, epicBranch, baseBranch, files, setup })` implements D6.
- `get_project_setup` returns the `automation` block, and the tab MCP gains `get_automation_policy`
  (level, what each level covers in pt-BR, and "o merge é feito pelo termhub").
- Raising the level to `deploy` or `release`, or turning automation on, is a confirmed change; on the
  phone it asks for the PIN, like an irreversible approval.
- The chat gate: the concierge's own tools are unchanged. A merge above the level becomes a pending
  card through the same path as `ask()` with a new tool name `automation_merge`, class
  `irreversible` (D7). Project grants never cover it: approving one merges that PR only.

## 7. Branches and worktrees (TER-866)

- Agent 0.16.0: RPCs `git.worktree.ensure { repo_dir, path, branch, base }` (fetch, `git worktree
  add -B <branch> <path> origin/<base>` when missing, returns `{ path, head }`) and
  `git.worktree.remove { repo_dir, path }`, capability `worktree`. `repo_dir` is the project's cwd on
  that machine. Paths are checked to stay under the expanded `worktrees_dir`. Arguments are passed as
  argv to `git`, never through a shell.
- The server creates the epic branch through the GitHub API (`POST /repos/{repo}/git/refs` from the
  base branch head) when the first card of an automatic epic is claimed; the card branch is created
  by `git.worktree.ensure` from `origin/<epic branch>`.
- `openTab` gains an optional `cwd` (the worktree path), used by `ensureSession`; the tab row keeps
  it so a restart reopens in the same place. `runner.setup_command`, when set, is typed before the
  CLI line in the same tab (`<setup> ; <cli line>`), so a failed install is visible to the agent.
- Cleanup: a card's worktree is removed after its PR is merged; the epic worktree after the epic PR
  is merged. A worktree with uncommitted changes is kept and the event says so.

## 8. Dispatcher and runs (TER-859)

`automation/dispatcher.ts`, started in `app.ts` with the other jobs:

1. On each tick, for each owner with an enabled, unpaused project: read the eligible queue (section
   5), then for each card, in order, while `max_parallel` (if set) has room:
2. Claim: `insert into automation_runs (…, status 'queued')`; the partial unique index makes the
   second colour's insert fail, which counts as "already taken".
3. Place: an agent machine linked to the project with `worktree` capability and online, and a
   project account with room that is not exhausted (D14). No place → run deleted, card keeps a
   `waiting` reason shown on the board (not an error, not an event per tick).
4. Prepare: epic branch (API), worktree (RPC), status `starting`.
5. Start: `startAgent(controlContextFor(repos, owner), { project_id, machine_id, account_id, task_id,
   prompt: implementerPrompt(…) }, { cwd, permission, setupCommand })` — the third argument holds
   server-only options; the MCP tool's input does not change.
   Status `running`, tab id recorded, event `run_started`.
6. Follow: a `monitorBus` subscriber maps state changes of tabs with an active run (D15–D18):
   `waiting_input` after Stop → resume or wake; question card → section 9.1; `rate_limit` → D16;
   agent exited → restart once; `report_card` → done or blocked.
7. Heartbeat: the claiming instance updates `heartbeat_at` every 30 s; a run whose heartbeat is
   older than 2 min is taken over by the other colour (the tab survives a deploy, the run follows it).

Pause (D24) is checked at steps 1, 5 and 6 and before every typed message.

## 9. Answers and escalation (TER-884)

### 9.1 Choice questions

D18, in order. Each automatic answer is recorded as a decision with `by: 'automation'` and shows the
"Decisão automática" badge (existing `auto-decision-view.ts`).

### 9.2 Permission questions

The request is matched against `automation.allowed_tools` and the policy; "allow" is sent through the
existing answer path (`chat/tab-question-answer.ts`), otherwise escalate. A request matching the
keyword block (`memory/blocklist.ts`) is always escalated.

### 9.3 Escalation

Escalating sets the run to `waiting` with a reason, keeps the question card in the chat with a line
"Automático parou aqui: <motivo>", sends a push (existing `tabQuestionText`), and frees the slot: the
dispatcher may start another card (TER-888). Answering the card resumes the run.

## 10. Integration and release (TER-872)

1. Card PRs: the CI sync stores `base_ref`. The merge executor (`automation/merge.ts`, run after each
   CI sync of a project) takes open PRs of automatic cards whose `ci_state` is green, asks GitHub for
   mergeability and changed files, computes the needed level (D6), and either merges (squash, the
   card's title as subject) or opens the approval card (D7). A PR that does not merge cleanly gets a
   `fixer` run on the card ("atualize a branch com a branch do épico e resolva os conflitos").
2. Trigger: an automatic epic whose non-epic cards are all `done` and whose card PRs are merged into
   the epic branch. The server opens the epic PR (`epic branch → base`), not draft, titled with the
   epic, and starts an `integrator` run in the epic worktree.
3. Integrator playbook (prompt, D27): merge `origin/<base>` into the epic branch; migrations with a
   timestamp older than the newest on the base are renamed after it (Prisma); generated clients are
   regenerated, never edited; lockfiles are regenerated by reinstalling; run the project's checks;
   push; `report_card done`.
4. CI on the epic PR: green → merge per policy; red → D21.
5. After the merge: follow `deploy_workflow` and `release_workflows` on the merge commit; record the
   result on the epic (event, feed, chat). A failed deploy pauses automation for the project and
   escalates (D22).
6. Lone cards (D8) skip steps 2–3: their PR targets the base branch and step 1 applies with the base
   branch level.

## 11. Visibility and control (TER-889)

- Events (D25) of kinds: `run_started`, `run_resumed`, `run_done`, `run_blocked`, `question_answered`,
  `escalated`, `pr_opened`, `merged`, `merge_needs_approval`, `deploy_ok`, `deploy_failed`,
  `release_ok`, `release_failed`, `quota_hit`, `quota_reset`, `paused`, `resumed`, `budget_hit`.
- Progresso (web `ProgressPanel.tsx`, app `features/progress`): a "Automático" section with the last
  events, the badge "automático" on tabs started by a run, and the cost per card and epic.
- Cost (D23): `automation/usage.ts` reads new transcript lines of a Claude tab on each Stop and adds
  their `usage` to `tab_usage`. The price table lives in `automation/prices.ts`.
- Budget (TER-892): when `daily_budget_usd` is set and the project's estimate for the day reaches it,
  the dispatcher stops starting runs for that project until midnight in the owner's zone (event
  `budget_hit`). Off by default (M1).
- Kill switch (D24): REST + MCP tool `pause_automation { scope: 'all' | project_id, interrupt? }` and
  `resume_automation`; buttons in the web header, the app's settings and Progresso; the chat answers
  "pausar tudo". The pause and the resume are recorded as events.
- Daily summary (D26): what was done (cards done, PRs merged, deploys), what waits on the person
  (escalations, approvals), cost of the day; posted as a chat message and a push.

## 12. Prompts (TER-895)

`automation/prompts.ts` builds, in pt-BR: the card ref and URL, title and description, the spec and
plan named in the description, the branch and worktree, the policy line ("abra o PR; o merge é feito
pelo termhub conforme a política do projeto — consulte get_automation_policy"), how to report
(subtasks, `report_card`), when to stop and ask, and the lessons reminder (`LESSONS_REMINDER`). No
template contains an absolute "não faça merge": in a manual tab, the agent follows the policy; in an
automatic tab, the merge is the server's job, and the prompt says why.

The concierge prompt (`chat/concierge-prompt.ts`) gains one line: an automatic project's policy is
the authority for merges and deploys of that project. Messages typed by the server start with
`[termhub automático]`; the implementer prompt tells the agent that such messages and messages
relayed by the chat come from the termhub on behalf of the project owner (TER-851).

## 13. Errors and edge cases

| Case | Behaviour |
| --- | --- |
| Two colours tick at once | The partial unique index lets one insert win. |
| Server restarts mid-run | Runs keep their rows; heartbeats expire; the new instance takes them over and re-subscribes; tabs are untouched. |
| Card moved out of `todo` by a person while queued | Claim re-checks eligibility inside the transaction; a run never starts on a card that left. |
| Card's tag removed while running | The run finishes its current turn and is not resumed (like a pause for that card). |
| Card deleted | Run `cancelled`; worktree removed if clean. |
| Machine goes offline | Run `waiting` (`machine_offline`); resumed when it returns; after 1 h, the card is released for another machine. |
| Worktree already exists with another branch | `ensure` fails with `WORKTREE_CONFLICT`; run `blocked` with the reason. |
| GitHub token missing or revoked | Card waits with "Integração do GitHub sem acesso"; the merge executor does nothing. |
| PR needs the store | Approval card with "precisa de build nas lojas"; never merged automatically. |
| Prompt longer than 4000 chars | The prompt names the card and tells the agent to read it via MCP; the template stays under the limit (test). |

## 14. Tests

- Pure: eligibility reasons and order; policy levels and `requiredLevel` per file set; prompt
  templates (no "não faça merge", under 4000 chars, marker present); price table.
- Repositories (`*.db.test.ts`, `TERMHUB_DB_TESTS=1`): propagation on mark/unmark/create/move;
  partial unique index (two claims, one wins); heartbeat takeover; exhaustion window.
- Dispatcher with fakes (start, monitor events, GitHub client): no place → waits; rate limit → no
  resume until reset; `waiting_background` never resumed; resume cap then wake then escalate; pause
  stops within one tick; restart takes over runs.
- Merge executor with a fake GitHub: green + level → merge; above level → approval card; red → fixer
  up to the cap; store paths → never.
- Agent: `git.worktree.ensure/remove` against a temp repo (argv only, path guard).
- One end-to-end test of the integrator playbook on a temp repo with two branches adding migrations
  (rename resolves the conflict).

## 15. Open decisions for the maintainer

1. Default autonomy for other users. M3 sets `release` as the default. CLAUDE.md says what is
   specific to the maintainer never becomes default behaviour. This design keeps `release` as the
   value shown when a project turns automation on (opt-in, with confirmation). Alternative: default
   `pr` for everyone, and the termhub project set to `release` in its own setup.
2. Stores. "Pode manter lojas" was read as "stores stay out". This design never submits to a store
   and blocks PRs that need a store build (D6). Confirm, or say what "manter" should cover.
3. Permission mode of automatic tabs. D19 uses `acceptEdits` plus an allow list; every other request
   is answered by rule or escalated. A bypass flag would remove almost every escalation but also the
   last check before a command runs on a machine that is also production (jarvis). Keep D19?
4. Review. With M4, the maintainer can review a card's PR in the epic branch before integration. Is
   a "Revisar" column wanted, or is the daily summary plus PR history enough?
5. Rollback. D22 stops at "pause and escalate" after a failed deploy. Whether to roll back by itself
   (`deploy/blue-green.sh --rollback`) is left to the spike TER-900.

## 16. Out of scope

Store submissions; automatic rollback (spike first); Codex/Cursor cost; machines without the agent;
generic labels on cards; a review column; the subscription limits of TER-686 (the trial's three
terminals will cap automatic tabs on trial accounts once that ships — the dispatcher then shows the
plan's error as the waiting reason).

## 17. Delivery order

Each step is harmless without the next, and nothing runs until a project turns automation on.

1. Data and policy: tag, setup block, eligibility, policy (no behaviour change).
2. Worktree RPC in agent 0.16.0 (published by CI).
3. Kill switch and events (the brake exists before the engine).
4. Dispatcher, runs, prompts, resume, quota.
5. Answers and escalation.
6. Merge executor, integrator, deploy and release follow-up.
7. Cost, budget, daily summary.
8. Turn on in the termhub project, after the spike TER-900 report.
