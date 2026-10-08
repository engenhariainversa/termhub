# Spike: a PR opened by hand after a `blocked` run (TER-1031)

Written on 2026-10-07 against the code at `243b7d0b` (main), with PR #446 (TER-1025, still open) read
as the next state of `follower.ts`. A research document: no code changes. It complements TER-1025
(retry GitHub failures instead of escalating) with the case TER-586 / PR #432 showed: what happens to a
run that already ended `blocked` when the work is finished by hand afterwards.

Source note: the tab that wrote this has no card reader (`get_card` only answers inside a running
automatic run), so the card text comes from `search_memory`, which returns its first paragraphs only.
The question below is taken from that excerpt and the card title. Check it against the full card
before turning section 7 into cards.

## 1. The case

1. The automatic run of TER-586 tried `gh pr create` during the GitHub incident of 2026-10-07
   (15:06–15:50 UTC). It failed, and the agent called `report_card` with `status: blocked`. The run
   ended `blocked` (`reported_blocked`), the person was told (event `escalated`, push, chat line).
2. Once GitHub was back, the PR was opened from the same tab (PR #432, head
   `TER-586-termhub-agent-doctor-testar-tambem-o-end`, base `main`, not draft).
3. From that tab, `report_card` answered "só está disponível numa aba com trabalho automático em
   andamento", and `resume_automation_run` refused with "Esta execução automática já terminou".
4. There is no `run_done` and no `pr_opened` for the card. The feed and the progress panel still end on
   "bloqueado". At the time of writing, PR #432 is open, its `check` is green and GitHub reports it as
   `CONFLICTING`, and no fixer has run for it.

## 2. Summary

- **A `blocked` run is final, and nothing reconciles it with a PR that appears later.** The D17 PR
  fallback (`openPrOfRun`, which ends a run `done` when the CI sync links a PR from its branch) only runs
  for `running` and `waiting` runs. `report_card` and `get_card` need an active run in the tab.
  `resume_automation_run` only takes a `waiting` run.
- **The merge executor is not keyed by the run's status, though.** It takes a PR as an automatic card's
  own when the card is still tagged and the PR head is one of the branches its runs worked on
  (`branchesOfTask`, any status). So a PR from a blocked run's branch is, in principle, merged, fixed on
  a red CI or a conflict, and deployed like any other. What is missing is the bookkeeping and the
  signal, not the pipeline.
- **PR #432 shows the pipeline does not always pick such a PR up either.** It should have started a
  conflict fixer. Section 4 lists the likely reasons; the most likely one (the body cites TER-543) has
  nothing to do with `blocked`, but nobody noticed because nothing told the person the PR was being
  watched or held.
- **TER-1025 removes the most common way into this case**, not the case itself. With PR #446 a GitHub
  error is reported as `blocked` + `code: github_transient`, the run stays `waiting`, and the existing
  fallback ends it `done` once the PR is linked. A run blocked for any other reason (the agent gave up,
  `agent_exited` after the restart, an outdated agent, an exclusive account) and then finished by the
  person still ends up here.
- **Recommendation:** let the server *adopt* a PR that shows up from a blocked run's branch: the run
  goes `blocked → done` once, through the same `finishDone` path (`via: 'pull_request_after_blocked'`),
  so `run_done` and `pr_opened` are recorded and the feed says the PR is being followed. Let
  `report_card done` from the same tab trigger the same adoption instead of failing. Do not reopen
  blocked runs (`resume_automation_run` stays as it is).

## 3. What the code does today

| Step | Where | Keyed by | Works after `blocked`? |
| --- | --- | --- | --- |
| PR linked to the card | `ci/sync.ts` `cardsNamed` (refs in head, title, body) | the card ref | yes |
| Run ends `done` on a linked PR (D17) | `follower.ts` `openPrOfRun` + `finishDone`, from `onStopped`, `onExited` and the sweep of `waiting` runs | the run, only `running`/`waiting` | **no** |
| `run_done` / `pr_opened` events | `finishDone` | the run | **no** (never called) |
| `report_card` / `get_card` | `mcp/tab-token.ts` `RUN_ONLY_TOOLS`, `follower.ts` `runOfTabToken` (`activeByTab`) | an active run in the tab | **no** |
| `resume_automation_run` | `follower.ts` `resumeAutomationRun` | a `waiting` run in `SLOT_FREE_REASONS` | **no** |
| PR is a merge candidate | `merge.ts` `candidateOf`: card `auto`, head ∈ `branchesOfTask`, base is the base or epic branch, no undone person card cited | the card and its branches | yes |
| Red CI fix | `merge.ts` `onRedCi`: typed into the active run, else a fixer run | the card | yes, as a **new fixer run** |
| Conflict fix | `merge.ts` `onConflict`: a fixer run per head | the card | yes, as a new fixer run |
| Cleanup after merge | `markCleanupDue` on every run of the card with a worktree or tab | the card | yes |
| Deploy follow | `release.ts`, from the merged PR | the PR | yes |

Two consequences follow from that table:

- Downstream of the PR, "nobody follows it" is not literally true; the card's runs and the PR are just
  disconnected. The card shows a blocked run, the escalation is the last thing the person heard, and if
  the merge executor holds or ignores the PR, nothing says so on the card's run.
- After a blocked run, a red CI or a conflict starts a **fixer in a new tab**, while the tab where the
  person finished the work may still be open. `launch` reuses the card's worktree (`ensureWorkspace` is
  keyed by project and card ref), so on the same machine both tabs work in one worktree. This exists
  today for any blocked card with an open tab; adoption (section 5) does not make it worse, and
  section 5.4 proposes a way to use the open tab instead.

## 4. Why PR #432 was not picked up (to confirm on the board)

`onConflict` should have started a fixer for PR #432. Candidates, most likely first. The tab that wrote
this cannot read the board or the database, so none is confirmed:

1. **The PR is held for a person (TER-1004).** Its body says "from the IT checklist, TER-543". The CI
   sync links every ref in the body, so TER-543 is one of its rows. If TER-543 is a manual card that is
   not done, `candidateOf` returns `held` and the PR waits for a person (`merge_person_card`), with one
   escalation per head once the CI is green. Check: the card TER-586 should show "O PR cita um card
   manual que não está em Feito; uma pessoa mescla", and the feed an `escalated` with
   `merge_person_card`.
2. The card lost its `auto` tag, or the project was paused, when the person took over.
3. The run's `branch` differs from the PR head (the branch was renamed by hand before pushing).

If (1) holds, it is a separate problem worth a card of its own: a PR body that mentions where the work
came from should not hold the merge. Section 7, card 4.

## 5. Design sketch: adopting the PR

### 5.1 Which runs, which PRs

A run is adoptable when all of these hold:

- `status = 'blocked'`, `role` is the implementer (not `integrator` nor `fixer`: their PR existed
  before the run, the same exclusion `openPrOfRun` already makes), `branch` is set, and it ended less
  than `ADOPT_WINDOW` ago (proposal: 7 days, so an old blocked run never comes back to life by surprise).
- No other run of the card is active, and no later run of the card exists (the card was dispatched
  again: that run owns the PR).
- The card still exists and is tagged `auto`, and the project's automation is on.
- `openPrOfRun` finds a linked PR from `run.branch`: open, or merged after the run was created.

Marker runs (`insertMarker`, `blocked` without a tab, used for once-per-head escalations) are excluded:
they have no `branch` and their `trigger_sha` is set.

### 5.2 The write

A new repository method, `finishBlockedAsDone(runId)`, conditional on `status = 'blocked'`, sets
`status = 'done'` and keeps `ended_at` (the run did end then) and `waiting_reason` (the reason it was
blocked stays readable). Only one colour wins the write, so `run_done` is still recorded once per run.
Then the existing steps of `finishDone`: `placeDoneCard`, `run_done` with
`via: 'pull_request_after_blocked'`, `pr_opened`. The feed shows "PR aberto depois do bloqueio; o
automático acompanha" (pt-BR key, English in the catalog).

The alternative, leaving the run `blocked` and recording only `pr_opened` for the card, keeps "a run ends
once" literally, but leaves the run's status wrong wherever it is read later (the run's own row, any
future count of outcomes) and gives the feed no single event to say "taken over". `blocked → done` is the one
terminal-to-terminal move allowed, it happens at most once, and only on evidence (a linked PR from the
run's branch).

### 5.3 Who runs it

The CI sync already links the PR, so adoption runs right after `replaceLinks`, in the same per-project
pass: `adoptBlockedRuns(projectId)` reads the project's adoptable runs (one query, covered by the
existing `automation_runs_project_status_idx` on `(project_id, status)`) and calls `openPrOfRun` for each. It does not need the follower (which
only holds active runs of its own instance) and it runs on whichever colour syncs. Cost: one small query
per sync for projects with automation on, plus one PR lookup per blocked run in the window.

### 5.4 `report_card` from the same tab

Today the agent in that tab, asked to "tell termhub", gets an error it cannot act on. Proposal:

- `tabHasActiveRun` becomes `tabRunFor(tool)`: `report_card` with `status: done` and a `pr_url` is also
  accepted when the tab's latest run (`latestByTab`) is adoptable (5.1, without the linked-PR condition).
- It adopts at once when the PR is already linked; otherwise it answers `{ ok: true, pending: true }`
  with a message saying the PR is followed once the CI sync links it (within about `PR_GRACE_MS`), and
  5.3 does the rest. The URL given is never trusted on its own: adoption still needs the linked row
  whose head is `run.branch`.
- `status: blocked` from such a tab is refused as today (the run is already blocked), with a message
  that says so instead of "only in a tab running automatic work". `get_card` stays run-only.

### 5.5 Red CI and conflicts after adoption

Once adopted, the run is `done`, so `onRedCi` and `onConflict` behave as for any done card: a fixer run
per head. The open tab of the adopted run is not used. Typing the fix into it (the
"owner run" path of `onRedCi`) would need a `done` run to accept input again, which the follower does not
support; a fixer is the safer default. The shared-worktree risk of section 3 is left to a card of its own
(section 7, card 3).

### 5.6 What stays as it is

- `resume_automation_run` does not take blocked runs. Reopening a run means typing into its tab, and a
  blocked run's tab is the person's now.
- `escalate_automation_run` is unchanged.
- No migration: `status` already takes `done`, and the query uses the existing
  `(project_id, status)` index.

## 6. Impact on other users

- Default for every project with automation on, no setting: a blocked run whose branch later gets a PR
  ends `done` and the card's feed says the PR is followed. Before this, that PR was already merged,
  fixed and deployed by the merge executor under the project's autonomy level, so the change is in what
  the person sees, not in what termhub does with the PR.
- The adoption window (7 days) means an old blocked card that someone picks up much later is not
  adopted. That is deliberate: past the window, the person opens the PR as a manual one.
- Projects without automation, and cards without the `auto` tag, see nothing new.
- `report_card` answers in one more case (a tab whose run was blocked); every other tab gets the same
  refusal as today.

## 7. Proposed cards

1. **Server: adopt a PR from a blocked run's branch** (5.1–5.3). `finishBlockedAsDone`,
   `adoptBlockedRuns` after the CI sync, feed text (pt-BR + en). Tests: adopted once across two
   colours; not adopted for an integrator, a fixer, a marker run, an untagged card, a run outside the
   window, or when a later run of the card exists.
2. **MCP: `report_card done` from a tab whose run was blocked** (5.4). Clear message when the PR is not
   linked yet, and a precise refusal for `blocked`.
3. **Fixer vs the open tab of the card** (section 3, 5.5): decide whether a fixer may start while the
   card's previous tab is still open in the same worktree, or whether it waits / types into that tab.
   Applies to blocked and done runs alike.
4. **Only if section 4 (1) is confirmed:** a PR body that cites a card as its origin holds the merge
   (TER-1004). Options: link only refs in the head and title for the merge decision, or ignore cards
   cited in the body when deciding `held`. Needs its own short design; it changes TER-1004's rule.

## 8. Open questions for the maintainer

- Is 7 days the right adoption window, or should it be "until the card leaves Fazendo"?
- Should adoption also post a chat line ("PR #n do TER-x aberto depois do bloqueio; o automático
  acompanha"), or is the feed enough? The escalation went to the chat, so the all-clear probably should
  too.
- For PR #432 itself: confirm the cause in section 4 on the board before deciding on card 4.
