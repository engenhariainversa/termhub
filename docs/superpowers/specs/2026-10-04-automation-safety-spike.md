# Spike: safety and limits of the automatic mode (TER-900)

Epic TER-852, plan Task 1, written on 2026-10-04. A research document: no code changes. It answers
the six questions of TER-900 against the agentic board design
(`docs/superpowers/specs/2026-10-04-agentic-board-design.md`, "the spec") and the code at
`7c3d7826`. Every recommendation names the setting, the existing plan task or the new card that
implements it.

It must be merged before Task 25 (merge executor, TER-883) and before Task 35 (turning automation on
in the termhub project, TER-945).

## 0. Ground rules this spike works inside

Decisions the maintainer took on 2026-10-04, which override the spec where they differ:

- `automation.autonomy` defaults to `pr` for every project; only the termhub project sets `release`
  in its own setup (spec §15.1 settled).
- Store submissions are always out, at every level (§15.2).
- Automatic tabs run with `--permission-mode acceptEdits` plus an allow list; never a bypass flag
  (§15.3).
- No "Revisar" column (§15.4).
- Automation ships disabled (`automation.enabled = false`); the maintainer turns it on at the end
  (Task 35).
- M1 stands: no concurrency ceiling and no cost ceiling by default. Every limit below is either a
  safety brake against a malfunction (a loop, a broken main) or an opt-in setting.

Spec §15.5 (automatic rollback) was left to this spike: see section 4.

## 1. Summary of recommendations

| # | Recommendation | Implemented by | Must land before |
| --- | --- | --- | --- |
| R1 | Merge only on explicitly green CI (`required_checks`, `none` is never green), only onto a green base, one delivery at a time on the base branch, up to date with the base | **TER-964** (new) | Task 25 |
| R2 | Server-started runs (conflict fixer, integrator) keyed by SHA and capped | **TER-965** (new) | Task 25 |
| R3 | termhub repo: CI on PRs into `epic/**`; main requires a PR and the check (ruleset only with the maintainer's explicit approval) | **TER-966** (new) | Task 35 |
| R4 | termhub deploy: smoke test after the switch, automatic rollback to the previous colour | **TER-967** (new) | Task 35 |
| R5 | Fixed deny list for automatic tabs; `git push` only to the run's own branch | **TER-968** (new) | Task 35 |
| R6 | Machine room (memory, disk, load from `hw.probe`), account headroom, machine opt-out | **TER-969** (new) | Task 35 |
| R7 | Cycle detector for automatic answers | **TER-970** (new) | Task 35 |
| R8 | Budget early warning, no resumes past the budget, optional per-card budget | **TER-971** (new) | — (after Task 33; not blocking) |
| — | Resume cap, restart once, quota exhaustion, red-CI fix cap, deploy freeze, kill switch, daily budget, cost measurement | Existing plan tasks 18, 19, 29, 28, 9/10, 33, 32 | as planned |

Cards created in epic TER-852, all type `task`, in the backlog:

- [TER-964](https://app.termhub.dev/project/TER-964) — Executor de merge: checks exigidos, base verde
  e uma entrega por vez na base. **Before Task 25.**
- [TER-965](https://app.termhub.dev/project/TER-965) — Teto das runs que o servidor dispara
  (conflito e integrador), por SHA. **Before Task 25.**
- [TER-966](https://app.termhub.dev/project/TER-966) — Repositório termhub: CI nos PRs para
  `epic/**` e regra de PR + check na main. **Before Task 35** (the ruleset part only with the
  maintainer's explicit approval, section 4.2).
- [TER-967](https://app.termhub.dev/project/TER-967) — Deploy do termhub: smoke test depois da troca
  e rollback automático para a cor anterior. **Before Task 35.**
- [TER-968](https://app.termhub.dev/project/TER-968) — Abas automáticas: lista fixa de proibições e
  push só na própria branch. **Before Task 35.**
- [TER-969](https://app.termhub.dev/project/TER-969) — Despachante: folga de máquina, folga de conta
  e máquina que recusa o automático. **Before Task 35.**
- [TER-970](https://app.termhub.dev/project/TER-970) — Detector de ciclo nas respostas automáticas
  por run. **Before Task 35.**
- [TER-971](https://app.termhub.dev/project/TER-971) — Orçamento: aviso aos 80 %, teto opcional por
  card e nada de retomar ao estourar. After Task 33; does not block Task 35.

## 2. Cost

**What exists in the plan.** Task 32 (TER-891) measures tokens per tab from the Claude Code
transcript and estimates an "API-equivalent" cost per tab, card, epic and account. Task 33 (TER-892)
adds an optional per-project `daily_budget_usd` (null = off): when reached, the dispatcher starts no
new run for that project until midnight in the owner's zone. Task 31 shows it; Task 34 puts the
day's cost in the summary.

**Per account.** No budget per account. The accounts termhub drives are Claude Code subscription
logins: their real budget is the provider's usage windows, which `getAccountUsage` already reads and
which D14/D16 already respect (no start on an account without room; an account that hits a limit is
exhausted until its reset, Task 19). A dollar figure on top of a window the provider enforces adds a
second number that disagrees with the first. What is missing is headroom for the person: automatic
runs share accounts with manual tabs, and an automation that fills an account to 90 % leaves the
maintainer at the wall. **R6** (TER-969): automatic starts need the account's peak below 80 %
(`AUTOMATION_MAX_UTILIZATION`), and at most one start per account per dispatcher tick, so the next
usage reading includes the previous run. The 90 % swap threshold (`SWAP_MAX_UTILIZATION`,
`control/account-swap.ts`) does not change.

**Per project and day.** Task 33 as planned, off by default (M1). For the termhub project: leave it
off for the first week, read the daily cost from Task 32, then set it at roughly twice a normal day.
It is then a runaway detector, not a spending plan.

**Per card.** The resume and fix counters (section 3) cap the *number* of attempts, not their size:
one run that keeps an agent busy for six hours on a single turn never trips a counter. **R8**
(TER-971): optional `automation.card_budget_usd` (default null). When a card's estimate passes it,
its run is not resumed and is escalated ("orçamento do card estourado").

**When a budget is reached.** Today's Task 33 stops starts. **R8** extends it: no resumes, no new
fixer or integrator runs; the turn in progress finishes (interrupting mid-edit leaves a half-written
worktree, the same reasoning as D24). Merges of PRs that are already green continue: they cost no
tokens and unblock work.

**Early warning.** **R8**: an event `budget_warning` at 80 % of the daily budget, once a day, in the
chat (no push — D25 keeps pushes for escalations and the summary).

## 3. Loops

Inventory of the caps that already exist or are planned, and the gaps:

| Loop | Cap | Where |
| --- | --- | --- |
| A tab stops without a question | resume up to `resume_max` (3), then wake the chat once, then escalate; `waiting_background` never counts | Task 18 (TER-863), Task 23 (TER-887) |
| The agent process exits | restart once in the same worktree | Task 18 |
| Account at its limit | exhausted until the reset (or 1 h); never resumed into a limit; auto swap at most once per tab per 10 min (`AUTO_SWAP_COOLDOWN_MS`) | Task 19 (TER-864), `account-swap.ts` |
| Red CI | one fixer message per new red SHA, up to `fix_attempts` (3) per PR, then escalate | Task 29 (TER-876) |
| Waking the chat | `AUTO_WAKE_MAX_PER_HOUR` 12, plus Task 21's own budget | `chat/wake.ts`, Task 21 |
| The same card restarted by the dispatcher | `startWork` moves the card out of `todo` when a run starts (`tasks.ts:340`, always, with or without `agent_column_id`), and eligibility only takes `todo` cards (spec §5). A blocked or failed run leaves the card in "doing": it is never re-claimed until a person moves it back | Task 4, Task 17 — keep this property under test (Task 20) |
| **Merge conflict** | none: Task 25 starts a fixer run on a conflict, and nothing stops the next CI sync (60 s) from starting another | **gap → R2** |
| **Integrator** | none: an epic stays "ready" (Task 26 `epicReady`) after a blocked integrator run, so the next sync starts a new one | **gap → R2** |
| **Automatic answers** | none per run: the agent can ask the same question again after the recommended answer, and Task 21 answers again every 60 s | **gap → R7** |
| An expensive single run | none | **gap → R8** (per-card budget) |

**R2** (TER-965, before Task 25): every run the server starts by itself carries a trigger key
`(task_id, role, sha)` — the PR head for a conflict fixer, the epic branch head for an integrator —
and there is never a second run for the same key. Conflict fixes count in the same `fix_count` as
red-CI fixes (one cap per PR, `fix_attempts`). An epic gets at most two integrator runs until a person
acts (answers, retries, or pushes to the epic branch). A run that ended `blocked` or `failed` is
never recreated by the same trigger.

**R7** (TER-970, before Task 35): per run, the server counts automatic answers and keeps a hash of
each answered question's text (the hash only; question text is terminal content and is never
stored). The same question answered twice escalates on the third ask ("pergunta repetida"); more than
ten automatic answers in one run escalate ("muitas perguntas").

How R7 relates to `memory/blocklist.ts`. `autoAnswerBlocked` is the deterministic floor under every
automatic answer (its own comment: "a deterministic floor under the concierge's judgement"; reused by the agentic board's D18 and §9.2): a question whose header,
text or chosen labels contain a stem such as `deploy`, `prod`/`producao`, `push`, `merge`, `delete`/
`apagar`/`excluir`/`remover`, `drop`, `reset`, `force`, `rm`, `publish`/`publicar`, `release`, `pay`
or `destroy` (accents stripped, prefix match for stems of four letters or more, exact match for `rm`,
`prod` and `apaga`) is never answered automatically, only suggested. It is crude on purpose — it
cannot tell "não fazer deploy" from "fazer deploy" — and errs towards escalation. It decides *what*
may be answered, one question at a time. It does not see *how often*: a harmless question ("qual
nome de arquivo?") answered with the recommended option passes the blocklist every time it is asked,
which is exactly the cycle R7 counts. R7 adds the per-run memory the blocklist lacks; it does not
replace or loosen it — a blocked question still escalates on its first ask.

## 4. Broken main and rollback

### 4.1 What can break main

- **A PR merged without its CI.** `ci/rules.ts` `ciOf` reports `passed` when every *latest* run on the
  head SHA passed. If the main workflow has not been created yet and a faster workflow already
  passed, the state is `passed` for one sync. With no runs at all the state is `none`.
- **PRs into epic branches have no CI in termhub.** `deploy.yml` listens to `pull_request` on
  `branches: [main]` only, and `ci-base-change.yml` likewise. Every card PR (M4: card → epic branch)
  would sit at `none` forever — or be merged untested, depending on how Task 25 reads `none`.
- **No required check on main.** `main` has no branch protection; its only ruleset blocks deletion
  and non-fast-forward pushes. Nothing on GitHub stops a merge with a red or missing check. The
  server's own check (D5) is the only gate.
- **Merge skew.** Two PRs, each green against an older base, merged one after the other. The second
  one was never tested with the first.
- **Merging onto a red main.** If main is already red (a manual push), merging more on top makes the
  cause harder to find and can hide the first failure.
- **Coalesced deploys.** "CI e Deploy" keeps a single pending run on main (memory: a new merge
  cancels the pending one). Several automatic merges in a row ship as one deploy; a failure can no
  longer be pinned on one merge, and rollback (one step back) jumps over several.
- **An agent pushing straight to main.** D19's default allow list permits "git except push
  --force", which includes `git push origin HEAD:main` with the machine's own git credentials. That
  bypasses D5 entirely. See section 5.
- **A release that ships beyond the server.** A merge at level `release` does more than deploy the
  app: on the same push to main, `publish-agent.yml` publishes `@termhub/agent` to npm when the
  version in `apps/agent/package.json` is new, and `publish-mobile-ota.yml` publishes an OTA bundle
  when the push touches `apps/mobile/**` or `packages/mobile-api/**`. These run in parallel with the
  deploy, not after it, and nothing in section 4.4 undoes them. See section 4.5.

### 4.2 Recommendations

**R1** (TER-964, before Task 25) — the merge gate in the merge executor:

- New setting `automation.required_checks: string[]` (workflow names or files, default `[]`). With a
  list, merge only when every listed workflow has a `success` run on the head SHA. With an empty list:
  at least one run, all passed, and the same reading on two consecutive CI syncs. `none` is never
  green.
- Merge into the base branch only when the base head itself is green (its CI and its
  `deploy_workflow`); otherwise the PR waits with "main vermelha".
- One delivery at a time on the base branch, per project: no merge into the base while the previous
  merge's `deploy_workflow` or a `release_workflows` entry is queued or running. Epic branches deploy
  nothing and are not throttled. This also keeps each deploy to one merge, which is what makes the
  rollback below a single, attributable step.
- A PR into the base that is behind it is updated through the API (`update-branch`) and waits for CI
  again: no merge of code that was never tested together with the base. (Epic PRs are already brought
  up to date by the integrator, Task 27.)

**R3** (TER-966, before Task 35) — the termhub repository:

- `deploy.yml` and `ci-base-change.yml`: `pull_request.branches: [main, 'epic/**']`. The `deploy`
  job stays gated on a push to main, so this adds checks, never deploys.
- GitHub ruleset on main: require a pull request and the `check` status before merging. The server
  merges through the PR API, which the rule allows. Epic branches do not require a PR: the integrator
  pushes to them directly.
- The termhub setup (Task 35) sets `automation.required_checks = ["CI e Deploy"]`.

**The ruleset on main needs the maintainer's explicit approval.** It changes his own flow: main would
stop accepting direct pushes, including manual hotfixes. This epic does not apply it without that
approval: in TER-966 the CI change on `epic/**` (needed for Task 35) lands on its own, and the
ruleset is applied by hand in GitHub only after he says yes. Without it, R1's server-side gate is
still the gate for automatic merges.

**Freezing.** Task 28 (TER-875) already pauses the project's automation and escalates when the
`deploy_workflow` fails on a merge commit, and treats `cancelled` as superseded, not failed
(`deployOf` in `ci/rules.ts` already skips cancelled runs). A red check job on main also concludes
the "CI e Deploy" run as failed, so it freezes the same way. Nothing to add beyond R1's "red base →
no merge".

### 4.3 Smoke test after the deploy

Today `deploy/blue-green.sh` checks health *before* the switch only: `wait_healthy` (l.146) polls the
container's Docker healthcheck (`/api/ready` from inside the container) up to 40 × 5 s. After
`switch_proxy` nothing tests the path users take (proxy nginx → new colour), the web bundle, or an
authenticated route.

**R4** (TER-967, before Task 35): `deploy/smoke.sh`, run by `deploy.yml` right after
`blue-green.sh`, through the local proxy nginx on jarvis (which sits behind Cloudflare Access, so the
local `Host:` header path needs no Access token):

1. `GET /api/ready` with `Host: app.termhub.dev` → 200.
2. `GET /` with `Host: app.termhub.dev` → 200 (the web bundle is served).
3. One authenticated call: MCP `tools/list` with a personal API token of scope `read`
   (`SMOKE_API_TOKEN` in the server's `.env`, never printed). This proves auth, the database and the
   route tree, without writing anything.
4. `Host: termhub.dev` → 200 (landing; reported, never a rollback trigger — the landing is a
   separate container the rollback does not touch).

Up to three attempts over about 30 seconds, so a cold start is not taken for a failure.

### 4.4 Automatic rollback (spec §15.5)

**Recommendation: yes, roll back automatically, but only inside the deploy job, only one step, and
only when the smoke test fails right after the switch.** No automatic revert commit on main.

Why `blue-green.sh --rollback` (l.291) is safe in that window:

- It refuses unless the active colour is blue or green and the other colour exists and is stopped
  (l.296–315). Right after the very first blue/green deploy there is no stopped colour: it exits 1
  and nothing changes.
- It starts the stopped colour and runs `wait_healthy` on it *before* switching the proxy. If the old
  colour cannot become healthy (for example the database is the problem, not the release), it stops
  that colour and exits before the switch — the new colour keeps serving. It cannot leave the site
  with nothing behind the proxy.
- Migrations: CLAUDE.md requires each migration to be backward compatible with the previous release,
  because the old colour already serves while the new one migrates. The old container's entrypoint
  runs `prisma migrate deploy` with its own, older migrations folder against the newer database.
  **Verified in this spike** (Prisma 7.10.0, throwaway `th-spike-db` Postgres): a database with
  migrations `a` and `b` applied, then `migrate deploy` from a folder holding only `a`, prints "No
  pending migrations to apply" and exits 0. So the old colour starts.
- With R1's one-delivery-at-a-time rule, the stopped colour is exactly the release before this one,
  which the compatibility rule covers. Rolling back further than one step is never automatic.

When **not** to roll back automatically (fail the job and escalate instead):

- The release's new migrations contain `DROP`, `RENAME`, `ALTER … TYPE` or `SET NOT NULL`: the
  compatibility rule may have been broken, and the old code may fail against the new schema in ways a
  healthcheck does not show.
- The active colour is not blue or green (first deploy, legacy container): the manual procedure in
  CLAUDE.md applies.
- The failure happened before the switch: `blue-green.sh` already left the old colour serving.

Order inside `deploy.yml`: `blue-green.sh` → "Conferir migrations aplicadas" (`prisma migrate
status`, which would itself fail on the rolled-back colour's older folder) → smoke → on failure,
`--rollback`, write the run summary, fail the job.

Why no automatic revert of the merge commit: the release's migrations are already applied; reverting
the code removes them from the migrations folder and leaves the schema ahead of the code (`migrate
status` and the CI drift check then fail). It also hides the work. After a rollback, main still holds
the broken commit and the next push to main redeploys it; that is why the project's automation stays
frozen (Task 28) until a person fixes main.

**How the person is told.** The deploy workflow fails, so Task 28 records `deploy_failed`, pauses
automation for the project and escalates with a push; the escalation links the workflow run, whose
summary says "revertido para <cor> (<sha>)" or "sem rollback automático: <motivo>". No new channel is
needed, and the product stays generic: other projects' deploy workflows report success or failure the
same way, and whether they roll back is their pipeline's business.

Impact on other users: R3 and R4 change only the termhub repository's own pipeline. They apply to
manual pushes to main too, which is intended.

### 4.5 Releases: what the rollback does not undo

`blue-green.sh --rollback` swaps the app container back. It does not touch the two artifacts a
`release` merge publishes, and those reach further than termhub.dev:

| Artifact | Workflow | Who receives it | Can it be undone? |
| --- | --- | --- | --- |
| `@termhub/agent` on npm | `publish-agent.yml`: on every push to main, publishes when the package version is not on npm yet (OIDC trusted publishing, then tags `agent-vX.Y.Z`). Runs on GitHub-hosted runners, in parallel with the deploy | Every machine of **every termhub user** that installs or updates the agent; machines with `agent_auto_update` take it within the hour | No. A published version cannot be republished or reused. Recovery is a newer version: revert the change, bump the patch version, merge; CI publishes it. `npm deprecate` on the bad version needs an authenticated npm, which jarvis does not have — the maintainer runs it from his own machine. A bad agent that still connects auto-updates to the fix; one that cannot connect or update needs a manual reinstall on each machine |
| Mobile OTA bundle (xprem, branch `production`) | `publish-mobile-ota.yml`: on a push to main touching `apps/mobile/**` or `packages/mobile-api/**`, on jarvis; skips (and says so) when `app.json`, `app.config.js` or the app's `package.json` changed without an `expo.version` bump | Every installed app on that runtime version, for **every user** of the app | Yes, by hand: the xprem MCP's `republish_update` puts an earlier update back on the branch, `rollback_branch` falls back to the bundle embedded in the binary; `get_update_health` and `count_online_devices` show the reach. Devices that already ran the bad bundle take the fix on their next update check |

What this means for automation:

- **Never roll back a release automatically.** The npm side cannot be rolled back at all, and an OTA
  republish is a product decision (which earlier update, for which runtime). A failed `release_workflows`
  run already freezes the project and escalates (Task 28); a successful publish of a bad build is
  found by people, not by a workflow conclusion. The escalation and the runbook (Task 35) carry the
  recovery steps above.
- **A release merge is always its own delivery.** R1's one-delivery-at-a-time rule already holds the
  next merge into the base until the previous merge's `deploy_workflow` and every `release_workflows`
  run finished. Keep `release_workflows` listing both publish workflows in the termhub setup (Task
  35), or that hold does not see them.
- **The level is the lever, and no new code is needed.** The maintainer decided `release` for the
  termhub project. The agent package is the widest blast radius in the system — it runs on other
  users' machines and a broken one can cut off its own fix — so this spike recommends, as the
  maintainer's call, to turn automation on at `deploy` for the first week: every PR that touches a
  `release_paths` glob then becomes an approval card (D7, PIN on the phone) instead of merging, while
  everything else ships alone. Raise to `release` once the first automatic deploys were clean. This
  does not reopen his decision; it is the order in which to reach it.
- Store builds stay out entirely (`store_paths`), so no release path can produce a native change
  the OTA guard would then have to catch.

## 5. Secrets and scope

What an automatic agent never touches, and the layer that enforces each:

| Never | Enforced by |
| --- | --- |
| Store submissions | `store_paths` → level `store`, never automatic (D6, Task 5, Task 25); `eas`/`fastlane` denied (R5) |
| Merging, or pushing to main, the base or an epic branch | Server-side merge only (D5); `gh pr merge` refused (Task 22); **`git push` restricted to the run's own branch, other pushes and `gh api` denied (R5)**; main ruleset requires a PR (R3) |
| Production data | No production credentials exist in a worktree; reading `**/.env*` denied (R5); `psql`, `docker` denied (R5) |
| Secrets | Read/Edit denied on `**/.env*`, `~/.ssh/**`, `~/.config/gh/**`, `~/.claude*/.credentials.json`, `~/.aws/**`; `security` (macOS Keychain) and `gh secret` denied (R5). The GitHub integration token stays on the server and is never handed to a tab (Task 12). Terminal and transcript content are never logged (global constraint) |
| Other projects' worktrees | The worktree path guard (Task 8: paths stay under `worktrees_dir`); `acceptEdits` only auto-accepts edits in the session's working directory, so an edit elsewhere is a permission request, which Task 22 escalates |
| Production containers on jarvis | `docker` denied (R5); the machine opt-out (R6) keeps automatic runs off jarvis entirely; the user-level hook `protect-prod-containers.py` exists only on the maintainer's accounts and is not counted on |
| Publishing (npm, OTA) by hand | `npm publish` denied (R5); publishing happens only through the CI workflows after a merge at level `release` (Task 28) |

**R5** (TER-968, before Task 35): a fixed deny list in the server, not editable per project, passed
to Claude Code as `--disallowedTools` and applied again in Task 22's `permissionAllowed`, where it
beats any `allowed_tools` entry. `git push` is allowed only as a per-run rule for the run's own
branch (and the epic branch for an integrator run). Anything else is escalated, never answered
"allow". This closes the `git push origin HEAD:main` hole in D19's default and makes D5 a property of
the system instead of a line in the prompt.

How R5 relates to `memory/blocklist.ts`. The blocklist guards *answers*: a choice or permission
question that names deploy, push, merge, delete, drop, publish, release and the like is never
answered automatically (section 3; spec §9.2 applies it to permission requests too). It does not
guard *commands*: a permission request for `git push origin HEAD:main` is phrased by Claude Code as
a Bash approval, and a command allowed by `allowed_tools` never produces a question at all, so the
blocklist never sees it. R5 closes that side: the deny list acts before any question exists
(`--disallowedTools`, enforced by the CLI) and again in the server's permission rule. The two are
layered, not merged: the blocklist keeps escalating risky questions, R5 removes risky commands from
what an automatic tab can run even when nobody asks.

## 6. Concurrency

M1: no ceiling. The spike keeps that — there is no `max_parallel` default — but separates a ceiling
from *room*, the rule D14 already applies to accounts.

Measured on jarvis on 2026-10-04: a Claude Code session holds about 0.4 GB of RSS; the termhub
`node_modules` is 1.4 GB per checkout, so each card worktree that installs dependencies costs about
1.5 GB of disk; typecheck, builds and tests add 1–2 GB of memory at their peak. jarvis has 12 CPUs,
60 GB of RAM (42 GB available), 93 GB free on `/` (78 % used), and it is also the production host —
its disk already filled once with build cache (2026-09-29).

**R6** (TER-969, before Task 35) — checked before every start, read live from `hw.probe` (the agent
RPC that collects CPU, memory, load and disks; cached 60 s per machine; a failed reading counts as no
room):

- start only when available memory ≥ 4 GB, free disk on the mount that holds `worktrees_dir` ≥ 20 GB,
  and the 1-minute load is below the CPU count; otherwise the card waits with "máquina sem folga
  (memória/disco/carga)";
- at most one start per machine and per account per tick, so each reading includes the previous run;
- account headroom 80 % for automatic starts (section 2);
- a machine-level switch `machines.automation_allowed` (default `true`, "Aceita trabalho automático"
  in Máquinas). The maintainer turns it off for jarvis in Task 35; nothing assumes a server machine is
  dedicated to termhub.

These numbers adapt to the machine instead of capping it: on jarvis today they allow roughly as many
runs as the load allows (about a dozen light runs, fewer while builds run), and they stop new starts
before the disk or the memory of the production host runs out.

## 7. What changes for other users

Nothing, by default. Automation ships disabled and every recommendation above applies only to
projects that turn `automation.enabled` on: the new settings (`required_checks`, `card_budget_usd`)
default to the generic behaviour or to off; the machine switch defaults to on and changes nothing
until someone turns it off (level: machine). R3 and R4 touch only the termhub repository's own CI and
deploy pipeline.

## 8. Inputs to existing plan tasks (no new card)

- Task 17/20: keep "a started card leaves `todo`" under test — it is what prevents the dispatcher
  from re-claiming a card whose run failed.
- Task 28: the escalation after a failed deploy links the workflow run, whose summary carries the
  rollback outcome (R4).
- Task 33: for the termhub project, leave `daily_budget_usd` off for the first week and set it from
  measured days (section 2).
- Task 35: set `required_checks = ["CI e Deploy"]`, turn the machine switch off on jarvis, keep both
  publish workflows in `release_workflows`, consider starting at `deploy` for the first week (section
  4.5, maintainer's call), and put in the runbook how to read a rollback, how to unfreeze, and how to
  recover a bad agent release (newer patch version, `npm deprecate` by hand) or a bad OTA (xprem
  `republish_update` / `rollback_branch`).
- Task 28: the escalation after a failed `release_workflows` run names the artifact (npm or OTA) and
  points at the recovery steps of section 4.5; it never tries to undo a release by itself.
