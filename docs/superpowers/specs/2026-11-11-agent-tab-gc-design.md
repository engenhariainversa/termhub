# Agent tab garbage collector (TER-1171)

Status: requested by Pedro on 2026-11-11 (card TER-1171). Defaults decided by Pedro on 2026-11-11 in the
tab's question card: X = 24 h, Y = 6 h, no per-machine tab cap by default, and on by default (can be turned
off) once the flag is released. Ships behind the `tab_gc` flag, in dry run (`tab_gc_live` off) for the first
week.

## Why

Agent tabs pile up: agents that finished, tmux sessions that died, CLIs at rest for days. TER-1138 added
`machines.idle_tab_close_hours`, a per-machine timer that is off on most machines and blind to the card,
the run and the person (it closes a `finished` tab whose card is still in doing, and a tab of yesterday's
work the person wanted to keep). Pedro: find and close idle agents by themselves without killing work in
progress, always with a grace period and a "manter" button.

## What already exists and is reused

| Piece | Where | Use here |
| --- | --- | --- |
| Idle sweep every 10 min, "quiet" check (run active, rate limit, foreground process, Claude screen at its prompt, last hook not a session end), no-room early close, `tab_auto_closed` event | `monitor/idle-tabs.ts` (TER-1138) | The GC is built from it: `quiet()` and the room check move to the GC unchanged. While `tab_gc_live` is on for a project's owner, the old sweep skips that owner's tabs; while it is off, the old sweep runs exactly as today. |
| Hook states incl. `cli_dialog` (TER-1166), `waiting_background`, `blocked`, `auth_required`, `trust_prompt` | `TabState` | Inputs of the classification. |
| Agent left / pane dead (`AGENT_EXITED_TEXT`, `paneForeground` → `shell`/`dead`) | `chat/agent-exited.ts`, TER-643 / TER-1168 | "Agent is gone" is not "session is gone": a tab whose agent left keeps its tmux session and follows the idle rule. |
| `probeTmuxSessions` (tells "machine unreachable" from "no such session") | `terminal/machine-exec.ts` | Detects a dead tmux session without guessing. |
| Health watcher, `tab_waiting`, `card_orphan`, `done_unmerged` | `health/*` (TER-1121) | Tabs that wait on the person are already alerted there (`tab_waiting`). PR 2 adds the GC's own lines. |
| Automation events + project feed | `automation/events.ts`, `progress/aggregate.ts` | `tab_gc_warned`, `tab_gc_kept`, `tab_collected` (with reason) go to the feed and the automation trail. |
| `close_tab` (control) | `control/terminals.ts` | Closing a tab: kills tmux and removes the row, as today. |
| Feature flags | `features/flags.ts` | `tab_gc` (runs, dry run) and `tab_gc_live` (really closes). |

## Classification

Pure function `classifyTab(facts, config, now)` → `{ action, reason }`, `action` ∈ `keep` · `candidate` ·
`remove`. Facts: state, `state_at`, last monitor event time, `gc_reset_at` (last "manter"), pinned, run active, rate limited, card status
(`backlog`/`todo`/`doing`/`done`/none), machine online, tmux session (`alive` / `gone` / `unknown`),
"quiet" (foreground check of TER-1138, read only for a would-be candidate).

Rules, first match wins:

1. Not an agent tab (never reported a state: `state_tool` null), or not a terminal tab → `keep` (`not_agent`).
   Plain shells are never touched.
2. Pinned (`tabs.gc_pinned`) → `keep` (`pinned`).
3. Machine offline (agent) or unreachable → `keep` (`machine_offline`). Nothing is closed, warned or removed.
4. tmux session `gone` (the machine answered and the session is not listed) → `remove` (`session_gone`), no
   grace: there is nothing left to lose; the folder and the agent's session on disk stay.
5. Run automatic active on the tab → `keep` (`run_active`).
6. State `working`, `waiting_background`, `blocked` → `keep` (`busy`). State `waiting_input`,
   `waiting_permission`, `auth_required`, `trust_prompt`, `cli_dialog` → `keep` (`needs_you`); the health
   watcher's `tab_waiting` already flags them as "esperando você". (TER-1138 closed a `waiting_input` whose
   last answer was a report after 3 × X; the card now says never.)
7. Rate limited → `keep` (`rate_limited`).
8. `finished`/`idle` with the card in `doing` → `keep` (`card_in_progress`); PR 2 raises a health line so a
   person reviews it.
9. Rest = now − max(`state_at`, last monitor event, `gc_reset_at`).
   - `finished`/`idle` (card done, backlog/todo, or no card) and rest ≥ X → `candidate` (`idle`).
   - `error` and rest ≥ Y → `candidate` (`error`).
   - Over the machine's cap (`max_agent_tabs`) or machine short of room (TER-1138), rest ≥ 2 h →
     `candidate` (`over_cap` / `no_room`), oldest first, at most 3 per machine per sweep.
   - Otherwise `keep` (`recent`).
10. A `candidate` that is not "quiet" (something else runs in front, a hook says session end while the agent
    is still in front, the Claude screen is not at its prompt) → `keep` (`not_quiet`).

`waiting_background` covers "finished with subagents in background": the turn ended but work still runs.

## Grace period

A `candidate` is not closed at once:

1. First sweep that sees it: the tab is marked (`gc_warned_at` = now, `gc_warned_state_at` = its `state_at`)
   and `tab_gc_warned` is recorded (feed; PR 2 adds the badge "fecha em 30 min" with "manter" and the chat
   line).
2. Each later sweep re-classifies it. If it is no longer a candidate or its `state_at` moved (the agent ran
   again: the tab was reopened and used), the mark is cleared and `tab_gc_kept` is recorded (`activity`).
   Only looking at a tab is no sign (`state_seen_at` is written only while a tab waits on the person);
   "manter" is.
3. "Manter" clears the mark and sets `gc_reset_at` = now: the rest clock starts again.
4. Still a candidate, unchanged, and `now − gc_warned_at ≥ grace` (default 30 min) → collect.

Collecting: copy the agent's last answer and a short record of the tab (name, machine, tool, state, reason,
card, agent session id, folder) into `tab_gc_archive`, record `tab_collected` (ids and reason only, with the
archive id), then `close_tab` as the project's owner (forced). The archive row stays with the project
(cascade) and the card's history shows it (PR 2); the last answer was already kept in the database under
the "keep while the account exists" decision, this only keeps it past the tab.

Idempotent: every step is decided from the row (marks) and the clock, so two sweeps (blue and green during a
deploy) at worst both record the same warning; a second close of a removed tab is a no-op.

## Dry run

`tab_gc` on, `tab_gc_live` off (the first week): the sweep classifies every agent tab of the person but never
warns, closes or removes anything. Each tab it would collect (or remove) is recorded once as `tab_collected`
with `dry_run: true`, and its `gc_reset_at` is set to now, so the same tab is reported again only after
another X hours at rest rather than every 10 min. Nothing else is written; the person sees no badge.

`list_gc_candidates` and `run_gc` with `dry_run` (the default) are a third mode, **plan**: they answer what a
pass would do and write nothing at all (no mark, no event, no clock reset), so asking never changes the
scheduled pass.

## Configuration

Three levels, each a partial object `{ enabled?, idle_hours?, error_hours?, grace_minutes?, max_agent_tabs? }`:
user (`users.tab_gc`), project (`setup.tab_gc`), machine (`machines.tab_gc`). Resolution for one tab:

- `enabled`: off when any level says `false`; default on.
- numbers: machine, else project, else user, else default. A machine's TER-1138 `idle_tab_close_hours` is its
  `idle_hours` when `tab_gc.idle_hours` is unset there.
- Defaults: X `idle_hours` 24 (2–720), Y `error_hours` 6 (1–720), `grace_minutes` 30 (10–240),
  `max_agent_tabs` none (1–200).

Screens for the three levels come in PR 2; until then the defaults hold.

## Execution

A job in the server every 10 min (the TER-1138 interval), one pass at a time per process. Per project owner,
`tab_gc` off → nothing (the TER-1138 sweep keeps its job). Logs ids, states, reasons and counts only.

## MCP

- `list_gc_candidates(project_id?, machine_id?)`: every agent tab in scope with its action, reason, rest and,
  when marked, when it closes. Read only.
- `run_gc(project_id?, machine_id?, dry_run = true)`: one pass now over the scope; with `dry_run` it is a plan
  (writes nothing). `dry_run: false` needs `tab_gc_live` and, in the chat, is always the person's card
  (irreversible: no grant nor default covers it). Automatic tabs never get it.

The concierge prompt is not touched (prompt budget, docs/lessons/2026-11-06-orchestrator-prompt-budget.md):
the tools describe themselves.

## Delivery

- PR 1 (this spec): spec, plan, migration, classification, config resolution, sweep with grace and archive,
  dry run, flags, events, MCP tools, tests.
- PR 2: web — badge and "manter" on the tab, "fixar" toggle, settings at the three levels, chat line on
  warning, health/daily summary lines (`finished` with card in doing; GC counts), card history entry.

## Impact on other users

None while `tab_gc` is off (the default): the TER-1138 timer keeps working as today. With `tab_gc` on and
`tab_gc_live` off, only events are recorded. Once released (`tab_gc_live` on), the GC is **on by default
for everyone** and can be turned off per user, project or machine: agent tabs finished or idle for 24 h
(error: 6 h) are closed after a 30-minute warning, never while working, waiting on the person, running an
automatic run, with the card in doing, or pinned. A tab whose tmux session is gone is removed at once.
Plain shell tabs are never touched.
