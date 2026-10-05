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
- Permissions of automatic tabs: `acceptEdits` plus an allow list; no bypass flag. A fixed deny list
  (force/delete/mirror pushes, `.env` reads, `git -c`, release commands, ...) sits in
  `apps/server/src/control/automation-tools.ts` (`AUTOMATION_DENIED_TOOLS`) and beats any project allow
  rule. Any other permission request is answered by rule or escalated (`permission_needed`).
- No "Revisar" column. Review is the PR of each card plus the daily summary.

## 3. Before turning it on

1. Agent `>= 0.18.0` (the first with the worktree RPC) on the machines linked to termhub. Check the version
   in Máquinas; update there or let `agent_auto_update` do it.
2. Claude folder trust for the worktrees directory. A new folder makes Claude Code ask "trust this
   folder?", which parks the run (`trust_prompt`). Accept it once: open the first parked run's tab, answer
   the question with "Yes, I trust this folder" and the run continues. If trust is stored per parent
   directory in your Claude version, one answer covers the worktrees of every later card; otherwise expect
   it once per worktree and accept each (this is not confirmed in code, see the end of this file).
3. Machine switch. In Máquinas, "Aceita trabalho automático" must be unchecked for jarvis: it is the
   production host, and the automation must never start cards there. Check it on every machine that
   should not run cards, and on the others make sure it is checked.
4. Optional: `SMOKE_API_TOKEN` in jarvis's `.env` turns on the authenticated step of the deploy smoke test
   (`deploy/README.md`). Without it the step is skipped; rollback still works.
5. GitHub ruleset on `main` (requires the maintainer's explicit approval, do not apply without it):
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
  the text it shows before confirming.
- Setting `release_workflows` makes the base branch count as "pending" while those workflows run, so merges
  go one delivery at a time.

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
- Chat: say "pausar tudo" to the chat agent. Same effect as the button.
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
| `trust_prompt` | Stopped at the folder-trust question | Accept it in the tab (section 3) |
| `question_unanswered` | A question nothing automatic could answer | Answer it on the card |
| `question_expired` | The question card closed unanswered while the tab still asks | Answer in the tab |
| `answer_cap` | Too many automatically answered questions in an hour | Look at the tab, answer on the card |
| `permission_needed` | A permission the project rules do not allow | Allow or deny on the card; add a narrow allow rule in Setup only if it should always pass |
| `resume_cap` | Stopped several times, the chat could not continue | Open the tab and continue by hand |
| `start_failed` | Start failed several times; the tag was removed | Fix the cause (machine, agent version, folder), tag the card again |
| `agent_exited` | The agent exited again after its restart | Open the tab, see why |
| `card_budget` | The card passed `card_budget_usd` | Check the tab, resume if worth it |
| `reported_blocked` | The agent said it is stuck | Read its report, unblock or take over |
| `ci_cap` | CI still red after the fix attempts | Open the PR, fix it, push; the merge follows when green |
| `conflict_cap` | Conflict after the fix attempts | Resolve it; the merge follows when CI is green |
| `deploy_failed` | The deploy failed after a merge; the project is paused | Section 10, then "Retomar automático" |
| `deploy_failed_not_paused` | Same, and the pause could not be applied | Pause the project yourself first, then section 10 |
| `release_failed` | A release workflow failed after a merge; nothing is paused | Section 10 |

`ci_cap` and `conflict_cap` also come before the cap when a fix ended without a push (the PR head did not
move after its fixer, or after the fix typed into the card's own run): the escalation then carries
`cause: fixer_no_push`, once per PR head. Read the fixer's tab to see why it stopped.

## 10. After a failed deploy or release

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
