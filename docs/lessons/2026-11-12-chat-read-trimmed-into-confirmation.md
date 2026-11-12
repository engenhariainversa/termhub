---
symptom: "The chat asks for a confirmation card to read a CI log (clear; gh run view <id> --log-failed | tail -40), nobody answers, and it sits silent for over an hour after promising to report back"
tags: [run_command, command-rules, gate, concierge, health]
evidence: fixed
card: TER-1168
agent: claude
date: 2026-11-12
---
## Cause

Two gaps, found in the PDA project's chat on 2026-11-12 (a deploy failed at 00:21; the card waited until the person asked):

1. **The shape, not the command, asked.** The concierge wrote `clear; gh run view 43011412477 --repo … --log-failed | tail -40`
   to get a clean, short screen. `gh run view` is on the read-only default list (`isReadOnlyCommand`,
   `apps/server/src/chat/command-rules.ts`), but `parseCommand` refuses any unquoted `;` or `|` (`operator`), so
   no rule or default list could cover it and the gate asked. The trimming was never needed: `run_command`
   already returns only the last `lines` of the screen. The same happened to `git --no-pager log`: `--no-pager`
   sat where the list expected the subcommand.
2. **A pending card has no clock.** The gate's card waits until the hourly sweep expires it. Nothing told the
   chat that what it promised depended on a card nobody answered, so it never tried another way or said so.

## Fix

- The gate (`trimmedCommand` in `chat/gate-runtime.ts`) refuses, with no card, a `run_command` that would ask only
  because of a leading `clear;`/`clear &&` or a trailing `| tail -N`, `| head -N`, `| cat` (and `2>&1`), naming the
  simple form and `lines`. Any other pipe or chain still asks: the core that always asks is unchanged.
- The default list reads `git --no-pager|-P <read>`, `git shortlog/rev-list/blame/ls-files`, `git remote [-v]` and
  `gh pr diff`. The `run_command` description says to write reads in the simple form.
- New health sign `approval_stalled` (TER-1121 watcher): a chat card still pending past 10 min wakes the card's own
  conversation once, also without automatic work, to take a path that needs no card or `notify` needs_you once.

## How to check

Ask the chat in a shell tab to read a failed run's log: `gh run view <id> --log-failed` runs with no card; the same
with `clear;` or `| tail -40` comes back `COMMAND_TRIMMED` naming the simple form. Leave any card unanswered 10 min:
the chat is woken with `[approval_stalled]` and the card's `action_id`.
