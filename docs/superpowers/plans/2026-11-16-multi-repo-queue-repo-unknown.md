# Multi-repo: the queue waits for a card's repositories and the chat is woken once (TER-1068)

Epic TER-1060, card 9 of 16. Spec: `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md`
(R9 b, §6, §9). Outline: `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`, Task 9.

## Goal

In a project with more than one enabled repository (`isMultiRepo`), an automatic card only runs once its
repositories are known and ready. A card left with no repository wakes the project's chat once, and the
concierge infers them (or asks). A single-repo project gets no new reason and no wake.

## Steps

1. **Readiness per card** — new `apps/server/src/automation/repo-readiness.ts`, pure:
   `cardRepoBlock(keys, effective, linkedMachineIds, repoScan)` returns `null` (every repo of the card is
   ready) or `{ reason, repo? }`, checked in this order:
   - `repo_unknown`: no keys;
   - `repo_multi_soon`: more than one key (lifted by the workspace-runs card, outline Task 12);
   - `repo_disabled`: the key is gone from the project, or turned off in Setup;
   - `repo_no_access`: discovery marked it `no_access`, or it is not on GitHub (`unsupported`);
   - `repo_missing`: it has no GitHub integration (same text as today: "Repositório não configurado no Setup");
   - `agent_no_repo_scan`: no capable machine of the project answers `git.repos.scan`;
   - `repo_not_on_machine`: no linked machine has a present checkout of it.
2. **Eligibility** (`eligibility.ts`): the new reason codes and texts; `EligibilityInput.card.repo_block`.
   At the old `repo_missing` slot: `card.repo_block ?? (project.repo_ready ? null : 'repo_missing')`.
   For a multi-repo project the queue passes `repo_ready: true` and the card's own block, so `repo_ready`
   reads "every repo of the card is ready".
3. **Queue** (`queue.ts`): loads the effective repos once; computes the block per card only when
   `isMultiRepo`; the text names the key (`…: api`). Each `QueueItem` gets `repo_keys` (chips) and
   `created_at` stays internal.
4. **Wake** (`dispatcher.ts` + `chat/wake.ts`):
   - the tick looks at the full queue for `repo_unknown` cards older than the new-card grace;
   - each one is claimed with an `automation_events` row of kind `repo_unknown`, under the new unique
     index `automation_events_repo_unknown_once` (`task_id` WHERE kind = 'repo_unknown'), via `insertOnce`;
   - the cards this colour claimed in the pass go into **one** wake (`wakeForRepoUnknown`, the automation's
     hourly budget), at most 10 named;
   - when the wake did not start (budget, no owner), the claims are given back so a later tick tries again,
     at most once per 5 min per project (in memory);
   - two colours: the index lets one claim each card, so a card is named once.
5. **Health** (`health/signals.ts`): `repo_unknown` (the chat was told) and `repo_multi_soon` (structural
   until Task 12) do not count as a stalled queue. `card_orphan` reads doing cards only, so it is unaffected.
6. **Project prompt** (`chat/project-prompt.ts`): `repoCount` param; with 2+ repos, the line
   "Projeto com N repositórios: veja list_project_repos." The tickets line of the tail is shortened (32
   characters); the prompt stays under its 4000 cap because the machine list gives way, as for every other
   optional line. `service.ts` passes the count of enabled effective repos (best effort: 0 on a read error).
7. **MCP**: `list_automation_queue` description lists the new reasons and `repo_keys`.
8. **Web**: `AutomationQueueItem.repo_keys?`, `CardProgress.repo_keys?`; Progresso's `CardRow` shows
   `RepoChips`.
9. **i18n**: new server strings in `apps/server/src/locales/{en,es}`; nothing new in the web.

## Tests

- `repo-readiness.test.ts`: every reason, the order, a single ready repo.
- `eligibility.test.ts`: the block replaces `repo_missing` at its slot; earlier reasons win.
- `queue.db.test.ts`: multi-repo project — no keys, two keys, a ready key, a disabled key; single-repo
  project unchanged.
- `dispatcher.db.test.ts`: two dispatchers (blue/green) on the same database wake once per card; the claim is
  given back when the wake does not start.
- `wake.test.ts`: the text and the budget.
- `project-prompt.test.ts`: the line only with 2+ repos; `concierge-prompt.test.ts` still under 8000.
- `signals.test.ts`: `repo_unknown` cards alone raise no `queue_stalled`.

## Impact on other users

A single-repo project (every project today but the multi-repo ones) gets no new reason, no wake and no new
prompt line. In a multi-repo project, automatic cards without repositories stop being taken (they could
not run in the right folder anyway) and the chat is woken once per card to fill them.
