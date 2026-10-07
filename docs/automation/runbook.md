# Automation runbook (termhub project, TER-945)

How to turn automatic board work on in the termhub project, watch it, stop it and recover from it.
Design: `docs/superpowers/specs/2026-10-04-agentic-board-design.md`. Safety inputs:
`docs/superpowers/specs/2026-10-04-automation-safety-spike.md`. Deploy smoke test and rollback:
`deploy/README.md`. Integrator steps: `docs/automation/integrator-playbook.md`.

UI labels are in Portuguese (the product language) and are quoted as they appear.

## 1. What automation does

Cards tagged as automatic ("Trabalho automático" on the card) are picked up by the dispatcher, one agent tab
per card, each in its own git worktree on its own branch. The agent implements, opens a PR, and the server
follows the PR: it fixes red CI and conflicts (`fix_attempts`), merges when the project's level allows it,
watches the deploy and the release workflows, and cleans the worktree up. Everything is off until
`enabled` is set in the project Setup.

Levels ("Até onde os agentes vão sozinhos"), each one includes the previous:

| Setup value | Label | The agents do |
| --- | --- | --- |
| `pr` | Só código e PR | open PRs; a person merges |
| `merge` | Merge com CI verde | also merge when the checks are green |
| `deploy` | Deploy | also merge and let the deploy run |
| `release` | Publicação (npm, OTA) | also merge changes in `release_paths` (npm, OTA publishes) |

Store submissions are never automatic at any level. A PR touching `store_paths` always stops for a person.

## 2. Decisions behind the setup

- Default for everyone else is `pr`. What is specific to the maintainer is never the default.
- The termhub project itself runs at `release` (opt-in, set in its own Setup).
- Stores: never. A PR that needs a store build waits for a person (`merge_store`).
- Permission mode of automatic tabs (TER-993, the maintainer's decision of 2026-10-07 that replaces
  "acceptEdits plus a list"): Claude Code's `auto` mode (`--permission-mode auto`, `AUTOMATION_PERMISSION_MODE`
  in `apps/server/src/control/agents.ts`). Claude Code's own classifier answers what no rule covers, so a
  typical run (read, edit, test, build, commit, push its branch, open the PR) asks nothing. A run started
  before takes the mode on its next restart or resume. Auto mode needs a recent model (Opus 4.6, Sonnet 4.6
  or newer on the Anthropic API) and may be turned off by an organisation; then Claude Code starts the
  session in its manual mode instead, and the requests escalate as before. The termhub MCP tools for
  reading and adding cards (`AUTOMATION_MCP_TOOLS`) are answered yes by the server, and the ones that reach
  past the card (`AUTOMATION_MCP_DENIED_TOOLS`: automation policy, other tabs, agents, machines, deleting
  cards…) never are.
- Hard-lock PreToolUse hook (TER-993): every automatic run also carries a PreToolUse hook,
  `~/.termhub/bin/termhub-guard` (bundled in the agent, 0.19.0+, installed next to the monitor hook),
  registered through `--settings <the run's ~/.termhub/tabs/<tab>/guard.json>` on its launch line. It
  answers Claude Code's PreToolUse with a `deny`, whatever the mode, for: a `git push` that is not the
  run's own branch; `gh pr merge`/`workflow`/`release`/`api`/`secret`; `npm`/`pnpm`/`yarn publish`,
  `npm run release*`, `eas`, `fastlane`; `docker`, `ssh`/`scp`/`rsync`/`kubectl`, `psql`; `rm -r`/`-rf`
  outside the worktree (or `/tmp`); and reading or editing `.env`, `.npmrc`, `.netrc`, git credentials,
  `~/.ssh`, `~/.termhub` config/token and `.credentials.json`, or any write outside the worktree. It is
  the second wall after `--disallowedTools`, and it is what closes auto mode's gap: the classifier can
  no longer approve a push to another ref. Only automatic tabs get it (manual and `start_agent` tabs
  have no worktree, so no `--settings`). Each `deny` is listed in the feed as `guard_blocked`.
  The server writes `guard.json` before it types any line that names it — the start, the follower's
  restart of an agent that exited, the resume card and the account swap (`installRunGuard`, TER-1005).
  A run never starts or comes back without the lock: a machine whose agent is older than 0.19.0 is left
  out by the dispatcher (the card says "agente sem a trava; atualize o agente (0.19)"), a start there is
  refused with "Atualize o agente de <máquina>…", and an exited run there ends blocked as
  `agent_outdated`. A run whose tab is back at its shell with no hook after 3 minutes escalates as
  `agent_not_started` (the launch line failed; the error is on screen), not as `trust_prompt`.
- Permissions of automatic tabs: the mode above plus an allow list; no bypass flag. A fixed deny list
  (force/delete/mirror pushes, `.env` reads, `git -c`, release commands, ...) sits in
  `apps/server/src/control/automation-tools.ts` (`AUTOMATION_DENIED_TOOLS`) and beats any project allow
  rule. Every automatic tab also gets a fixed list of read rules (`AUTOMATION_READ_TOOLS`: `grep`, `rg`,
  `find`, `ls`, `cat`, `git show`/`grep`/`blame`…, TER-989) on top of the project's allow list, so a search
  never asks. Any other permission request is answered by rule or escalated (`permission_needed`); the hook
  does not forward Bash commands, so in practice every Bash request that reaches the server escalates, and
  only what lies outside the rules reaches it. A command with several `cd` always asks (Claude Code's own
  check); the run prompt tells the agent to avoid it. Every git rule also comes as `git --no-pager …` and as
  `git -C <the run's worktree> …` (`gitRuleForms`, TER-991), with the matching denies
  (`AUTOMATION_FORM_DENIED_TOOLS`), on the start and account-swap lines; a `-C` to any other folder asks.
  A line typed whole (an exited agent brought back) leaves them out until it goes through a launch file
  (TER-988).
- No "Revisar" column. Review is the PR of each card plus the daily summary.

## 3. Before turning it on

1. Agent `>= 0.18.0` (the first with the worktree RPC) on the machines linked to termhub. Check the version
   in Máquinas; update there or let `agent_auto_update` do it.
2. Claude folder trust for the worktrees directory (TER-1025: nothing to do by hand). A new folder makes
   Claude Code ask "Is this a project you created or one you trust?". Checked in Claude Code 2.1.292: trust
   lives in `projects[<folder>].hasTrustDialogAccepted` of the account's `.claude.json` (`~/.claude.json`,
   or `$CLAUDE_CONFIG_DIR/.claude.json`), and inside a git repository Claude only looks at the repository's
   root, so a trusted parent folder does not cover a worktree. Agent `>= 0.21.0` therefore marks each new
   worktree trusted in every Claude account of the machine when it creates it. When the question still shows
   (an older agent, an account added later), the server reads the tab after 30 s and, if the screen shows
   the question with "1. Yes, I trust this folder" selected, presses Enter (event `trust_auto_accepted`, at
   most 3 times a run, never while paused). Only when that fails is the run parked as `trust_prompt`.
3. Machine switch. In Máquinas, "Aceita trabalho automático" must be unchecked for jarvis: it is the
   production host, and the automation must never start cards there. Check it on every machine that
   should not run cards, and on the others make sure it is checked. The chat can flip it too
   (`set_machine_automation`, section 4a): unchecking runs at once, checking asks you first.
4. Project accounts. In the project Setup, "Contas de IA e modelo", check the Claude accounts automatic
   runs may use and click "Salvar contas e modelo". The automation only starts under accounts in that list,
   in its order; it never falls back to a machine's own login. Accounts shown there unchecked are only
   offered, not chosen: with the list empty, every card waits as "Sem conta com folga", and the reason
   says "nenhuma conta escolhida em Setup → Contas de IA e modelo" (TER-985).
5. Optional: `SMOKE_API_TOKEN` in jarvis's `.env` turns on the authenticated step of the deploy smoke test
   (`deploy/README.md`). Without it the step is skipped; rollback still works.
6. GitHub ruleset on `main` (requires the maintainer's explicit approval, do not apply without it):
   require a PR, require the `CI e Deploy` check, "Require branches to be up to date before merging",
   block force pushes and deletion. The up-to-date rule closes the gap between the executor's compare and
   its merge (the base may move in between): GitHub refuses the merge (405), and the next pass updates the
   branch and waits for CI again. This is the real
   backstop: the deny list and the merge gate live in termhub, the ruleset is enforced by GitHub even if
   the automation or its token misbehaves.

## 4. Setup values for termhub

Project Setup, "Trabalho automático" section. Fields not listed keep their defaults.

| Field (label) | Value |
| --- | --- |
| Tipos de card | Story, Tarefa, Bug (default; Spike off) |
| Até onde os agentes vão sozinhos (`autonomy`) | `release` (Publicação). Consider `deploy` for the first week; the spike leaves that to the maintainer |
| Caminhos de release (`release_paths`) | `apps/agent/package.json`, `apps/mobile/**`, `packages/mobile-api/**` |
| Caminhos das lojas (`store_paths`) | `apps/mobile/app.json`, `apps/mobile/app.config.js`, `apps/mobile/package.json`, `apps/mobile/plugins/**` |
| Workflows de release (`release_workflows`) | `Publish @termhub/agent`, `Publish mobile OTA` |
| Checks obrigatórios (`required_checks`) | `CI e Deploy` |
| Pasta dos worktrees (`worktrees_dir`) | default `~/.termhub/worktrees`, or a folder outside every checkout; the trust prompt above applies to it |
| Hora do resumo diário (`summary_hour`) | an hour of the day, 0 to 23 (e.g. 18); empty = no summary |
| Orçamento diário / por card (USD) | leave empty the first week, then set from the measured days (spike section 2) |
| Máximo em paralelo (`max_parallel`) | 1 or 2 the first week, not "no cap": every `release` merge redeploys termhub, and each deploy interrupts the starts in flight (three in a row untag a card). Raise it once a week went by without that |
| Retomadas por card, Tentativas de correção do CI | defaults (3, 3) |

Also under the project's repository section: `repo.deploy_workflow` = `CI e Deploy`. Leave the runner's
`setup_command` empty. Never set it to something that can run longer than 3 minutes (an `npm ci` on a fresh
worktree, say): the start watchdog reads 3 minutes without a hook as Claude's folder-trust question, so every
run would be parked as `trust_prompt` and send an escalation push before the agent even began.

Notes:

- `required_checks` is matched against the workflow's name or file (`CI e Deploy` or `deploy.yml`). That
  workflow runs on pull requests to `main` and `epic/**` as well as on push, so the name works for the PR
  head and for the delivery that follows the merge. With the list empty the executor wants every run of the
  PR green on two readings; with it filled, each listed workflow needs a successful run on the head.
- The store paths include `apps/mobile/package.json` and `apps/mobile/plugins/**` because they change the
  native binary (CLAUDE.md, "Mobile OTA updates"); `apps/mobile/**` in `release_paths` alone would let them
  through as an OTA.
- Saving with `enabled` checked, or raising the level to Deploy or Publicação, asks for confirmation. Read
  the text it shows before confirming. Through the chat the rule is stricter (section 4a).
- Setting `release_workflows` makes the base branch count as "pending" while those workflows run, so merges
  go one delivery at a time.

## 4a. Doing it from the chat (MCP)

The chat's assistant (and any MCP client with the `terminals` scope and the matching permission) can do
what the Setup screen, the machine form and the board do for automatic work:

| Tool | What it does | Asks you first |
| --- | --- | --- |
| `update_task` / `create_task` with `auto` | tags or untags a card; on an epic, every card of the epic (same rule as the board) | no: it is "mexer no quadro", covered by the chat's defaults unless you restricted it |
| `set_automation_policy` | reads the Setup (only `project_id`), or changes `enabled`, `autonomy`, `release_paths`, `store_paths`, `release_workflows`, `required_checks`, `max_parallel` | turning it on, raising the level (any raise, `pr` to `merge` included), changing a path, workflow or check list, raising `max_parallel` or lifting its cap |
| `set_machine_automation` | flips a machine's "Aceita trabalho automático" | checking it (`accept: true`) |

What never asks is a brake: turning automation off, lowering the level, lowering `max_parallel`,
unchecking a machine, `pause_automation`. A call that mixes a brake with a widening asks. No chat grant
("Permitir sempre", "Liberar sem prazo") and no default covers the calls that ask: each one is a card you
approve. The tool checks the rule again when it runs, so a call that reaches it without your approval
changes nothing. Other Setup fields (card types, budgets, prompts, `worktrees_dir`) stay on the Setup
screen.

Every change, from the chat, an MCP client, the web or the app, is an automation event with `via`
(`chat`, `mcp`, `web`, `app`): `automation_on`, `automation_off`, `setup_changed` (with the changed
`fields`), `tagged` / `untagged` (with how many `cards`), `machine_opt_in` / `machine_opt_out` (on every
project linked to the machine). They show in the feed and in `list_automation_events`.

## 5. First card, end to end

1. Pick a small, low-risk card (docs or a one-file fix, no `release_paths`/`store_paths`) and tag it as
   automatic. In the queue ("Automático" panel) it shows eligible, or why it is not (`reason_text`).
2. Follow it: tab opens in a worktree, the agent works, a PR opens, CI runs, the merge happens at the
   configured level, the deploy runs and `termhub-app` flips colour (`docker ps --filter name=termhub-app`,
   and the curl checks in CLAUDE.md), the worktree is removed.
3. Write what happened in the PR that lands this runbook (start time, PR number, merge, deploy, anything
   that parked the run) and fix this file where it was wrong.
4. Only then tag more cards, and only then think about `release_paths` cards.

## 6. Pausing

- "Pausar automático" (header button): nothing new is started, typed, answered or merged; running tabs are
  left as they are. "Retomar automático" lifts it (it asks first).
- "Pausar e interromper as abas" (the arrow next to the button): the same, and the automatic tabs are
  interrupted.
- Chat: say "pausar tudo" to the chat agent. Same effect as the button. To turn a project off (not just
  pause it), ask the chat: it calls `set_automation_policy` with `enabled: false`, without a card.
- Per project: unchecking `enabled` in Setup stops new cards for that project only. Runs already active stay
  active: nothing is typed into them while it is off, and they are followed (resumed, merged) again as soon
  as `enabled` is checked again. To stop a card for good, remove its tag or close its tab (below).
- A failed deploy on a merge the automation made pauses the project by itself (`deploy_failed`).
- Removing the automatic tag from a card ends its run (`cancelled`, `untagged` in the feed history) the next
  time the follower looks at it, whether the run was working or parked for you. The tab is left open.
- Closing an automatic run's tab ends its run the same way (`cancelled`, `tab_closed`), within a sweep
  (30 s): the card and its `max_parallel` slot are free again. The worktree and the branch stay.

## 7. Reading the feed and the summary

The feed shows each step of a card (started, PR opened, CI, merge, deploy, worktree cleanup) and every
escalation with its reason text. The chat posts the same lines, and the phone app gets a push for
escalations. The daily summary is posted at `summary_hour` and lists what merged, what is parked and, when
budgets are set, what it cost. With no review column, this plus the PRs is the review: read the summary,
open any PR you want a second look at.

A PR belongs to the automatic card whose run worked on its head branch. Other cards it cites in its title
or body are only references (TER-1004): the merge does not move them to done, and deploys and releases are
reported on the PR's own card. A cited manual card that is not done yet holds the merge for a person
(`merge_person_card` in the queue and, once the PR is green, an escalation once per head); a done one does not.

## 8. Approving a merge above the level

When a PR needs more than the project's level (for example a `release_paths` change at `deploy`, or any PR
at `pr`), the executor opens an approval card and the card waits as "Merge esperando sua aprovação no
chat". Approve it in the chat on the web, or on the phone (the app asks for the PIN). A change in
`store_paths` is a different case: it shows "precisa de build nas lojas" and an approval does not stand in
for the store build; merge it by hand once the build exists.

## 9. Unblocking a parked or escalated run

Reasons from `apps/server/src/automation/escalation-text.ts`; the feed shows the Portuguese text.

| Reason | What it means | What to do |
| --- | --- | --- |
| `trust_prompt` | Stopped at the folder-trust question and the server could not answer it (section 3) | Accept it in the tab; the run goes on by itself once the agent reports again |
| `github_transient` | The agent hit GitHub errors on a push or PR and termhub already resumed it `github_retries` times | Check githubstatus.com and the tab; resume the run when GitHub is back |
| `question_unanswered` | A question nothing automatic could answer | Answer it on the card |
| `question_expired` | The question card closed unanswered while the tab still asks | Answer in the tab |
| `answer_cap` | Too many automatically answered questions in an hour | Look at the tab, answer on the card |
| `permission_needed` | A permission the project rules do not allow | Allow or deny on the card; add a narrow allow rule in Setup only if it should always pass |
| `resume_cap` | Stopped several times, the chat could not continue | Open the tab and continue by hand |
| `start_failed` | Start failed three times in a row; the tag was removed | Read the reason on the failed starts (below), fix the cause (machine, agent version, folder), tag the card again |
| `agent_exited` | The agent exited again after its restart | Open the tab, see why |
| `card_budget` | The card passed `card_budget_usd` | Check the tab, resume if worth it |
| `reported_blocked` | The agent said it is stuck | Read its report, unblock or take over |
| `ci_cap` | CI still red after the fix attempts | Open the PR, fix it, push; the merge follows when green |
| `conflict_cap` | Conflict after the fix attempts | Resolve it; the merge follows when CI is green |
| `merge_person_card` | The PR is green but also cites a manual card that is not done (refs in `cards`) | Merge it by hand, or remove the citation from the PR text (or finish that card); the next pass merges it |
| `deploy_failed` | The deploy failed after a merge; the project is paused | Section 10, then "Retomar automático" |
| `deploy_failed_not_paused` | Same, and the pause could not be applied | Pause the project yourself first, then section 10 |
| `release_failed` | A release workflow failed after a merge; nothing is paused | Section 10 |

A failed start (any code, `LAUNCH_FAILED` included) is not an escalation by itself: its `run_blocked` event
(`stage: start`) carries the reason (`message`, `message_en`), the attempt (`attempt` of `max_attempts`) and
when the next one comes (`retry_at`), and the card shows "O início falhou (1 de 3); nova tentativa em N min"
with that reason in the queue (`start_backoff`). The next attempt waits 2 minutes after the first failure
and 10 after the second; the third failure removes the tag and escalates `start_failed`. The wait is read
from the runs table, so both colours keep it.

`ci_cap` and `conflict_cap` also come before the cap when a fix ended without a push (the PR head did not
move after its fixer, or after the fix typed into the card's own run): the escalation then carries
`cause: fixer_no_push`, once per PR head. Read the fixer's tab to see why it stopped. For a red CI, a fix
that ended without a push while githubstatus.com reports trouble with Git, the API or pull requests is not
escalated: the card waits (`merge_github_down`) and gets one more fixer once GitHub works again (TER-1025).

GitHub errors do not reach you on the first failure (TER-1025). An agent whose `git push` or `gh pr create`
fails on GitHub's side (5xx, "commit_refs", "Something went wrong") calls `report_card` blocked with
`code: github_transient`: the run waits (event `github_wait`, card and tab kept) and is resumed with a
"try again" message after 5, 10 and 15 minutes, each time only when githubstatus.com shows Git, the API and
pull requests working. Past `github_retries` (Setup, default 3) it escalates as `github_transient`.

A `conflict_cap` escalation is about one PR head and holds nothing by itself: the executor reads the PR on
every pass, so a push (a new head) or a head GitHub no longer finds in conflict merges once CI is green.
The queue says which head still waits ("Escalado por conflito em a058efd; aguardando um push que
resolva") and so does the feed line. When a run of the card ends after the escalation and the head did not
move (it reported done but pushed nothing), the person is told once more for that head, with
`cause: run_done_no_push` (TER-1016): check that the run really pushed its merge with the base.

## 10. After a failed deploy or release

A deploy that failed on GitHub's side does not pause the project (TER-1025): a run with no job, with no
failed step, ended `startup_failure`, or during an Actions incident on githubstatus.com is run again (the
same run, the same SHA) after 5, 15 and 30 minutes, up to `deploy_retries` (Setup, default 3; 0 = pause at
once), with a `deploy_retried` event and a chat line per try. Only a failed step, or the last try, pauses.
See `docs/lessons/2026-10-07-deploy-job-missing-github-incident.md`.

- Deploy: `deploy/post-deploy.sh` runs the smoke test and rolls back to the previous colour on its own. The
  run summary of "CI e Deploy" says `revertido para <cor> (<sha>)` or `sem rollback automático: <motivo>`;
  the escalation links that run. `main` still holds the broken commit and the next push redeploys it, so
  fix or revert it on `main` first. Then "Retomar automático" (the unfreeze). See `deploy/README.md`.
- `@termhub/agent` (npm): a published version cannot be republished. Revert the change, bump the patch
  version in `apps/agent/package.json`, merge; CI publishes it. `npm deprecate` on the bad version is run
  by hand from the maintainer's own authenticated machine (jarvis is not authenticated). Machines with
  `agent_auto_update` take the fix within the hour; an agent that cannot connect needs a manual reinstall.
- Mobile OTA (xprem): with the xprem MCP, `get_updates` and `get_update_health` to see the reach,
  `republish_update` to put an earlier update back on branch `production`, or `rollback_branch` to fall back
  to the bundle in the binary. Devices that ran the bad bundle take the fix on their next update check.
- Automation never undoes a release by itself.

## 11. Removing a stuck worktree

After a merge the server removes the card's worktree itself (the card's runs share one, and it goes when
all of them are ready); a worktree with uncommitted changes is kept and the feed says so. To remove one by
hand, on the machine that holds it (path: `<worktrees_dir>/<...>`, shown on the run):

```bash
cd <the project's checkout on that machine>
git worktree list
git worktree remove <worktree path>            # add --force only after looking at what is uncommitted
git worktree prune
git branch -D <the card's branch>              # only when its PR is merged or abandoned
```

Never run these on jarvis against a path outside `worktrees_dir`, and never touch the production
containers.

A run that is stuck (its tab hangs, or it waits on something you do not want to answer) is ended by closing
its tab: the run becomes `cancelled` (`tab_closed`) within 30 s, and the card and the slot are free. Its
worktree stays, with whatever the agent left uncommitted; nothing is lost from the branch. If the card should
run again, move it back to the "A fazer" column with its tag on: the next run reuses that worktree and
branch. A cleanup that was waiting on the stuck run (after a merge) goes on by itself once the run ends.

## 12. Known limits

- Allowed commands run edited project code. `npm test`, a build or a hook the agent edited executes on the
  machine as that user. The deny list and `acceptEdits` narrow this, they do not sandbox it. That is why
  jarvis (production) stays off the machine switch and why the GitHub ruleset matters.
- Release rollbacks are manual: xprem `republish_update` / `rollback_branch` for OTA, a new npm patch for
  the agent. A bad agent release reaches every user's machines.
- Signals are flaky. A check GitHub has not queued yet, a cancelled deploy superseded by a newer merge, or a
  base branch whose last run is still pending delay a merge (`merge_checks_pending`,
  `merge_base_pending`); they are not errors. Cancelled deploys and releases count as superseded, not
  failed.
- Concurrency: one delivery at a time; "CI e Deploy" keeps one pending run on `main`, so a quick second
  merge cancels the first queued run (shows as cancelled, not failed).

## Impact on other users

None by default: automation is off until a project turns it on, the default level for anyone who does is
`pr`, and `release` is set only in termhub's own Setup. This runbook changes no product code.
