# Tab attention: yellow only when the person has to act (TER-1046)

## Problem
On 2026-10-08 most yellow tabs did not need the person:
- automatic runs that finished with a report and an open PR read as `waiting_input`, because the report
  listed next steps or "você pode…" (TER-972's rule kept any offer or pending item as a wait);
- runs blocked on another card (TER-1020) were `waiting_input` too, though automation resolves them;
- "Login expired · Please run /login" on three tabs showed as `waiting_input` with the generic
  "Claude is waiting for your input" — urgent, but hidden among the others;
- the folder trust dialog ("Is this a project you created or one you trust?") left three tabs with no
  state at all, unnoticed since the day before.

## Decisions
1. **Three new `TabState` values** (additive enum migration): `blocked`, `auth_required`, `trust_prompt`.
2. **Turn-end classifier** (`monitor/turn-end.ts`): a Claude `Stop` is `waiting_input` only for a direct
   question — a `?` in the last block, or an explicit request for the person's decision, approval or action
   ("Preciso que você decida", "Para o Pedro decidir", "let me know"), or a blocker the agent could not get
   past ("Não consegui…"). Offers ("se quiser", "posso", "é só me pedir"), next steps, "você pode…" and
   pending lists are a report: `finished`. A short message that is Claude Code's login error is
   `auth_required`. A blank message still waits.
3. **The automatic run decides** (`monitor/attention.ts`): a Claude main-thread `Stop` within 15 min of the
   tab's run ending `done` is `finished`, `blocked` is `blocked`, whatever the wording.
4. **`auth_required`** comes from the `Stop` text, from `StopFailure` `authentication_failed` /
   `oauth_org_not_allowed` (was `error`), and from the screen: after Claude's idle reminder the screen is
   read, and the stale-working sweep reads it too. It pushes the owner once per occurrence, to every
   device, with the machine and the account label, and the push lands in the notification history.
5. **`trust_prompt`** comes from the screen only (no hook fires): a new sweep reads tabs that never
   reported, opened between 2 min and 7 days ago, with Claude Code in front, every 5 min at most per tab.
   It also turns the login error of a fresh session into `auth_required`. A plain shell or a Claude Code
   without hooks stays without state (nothing to classify). Automatic runs already answer the trust
   question in their own worktrees (TER-1025: the agent pre-trusts the worktree and the follower presses
   Enter on "Yes"); nothing new there.
6. **Needs you**: `waiting_input`, `waiting_permission`, `auth_required`, `trust_prompt`. `blocked` and
   `finished` never alert. `error` keeps its red dot but is not counted (unchanged).
7. **Colours (web)**: orange blink for an unseen wait and the trust dialog; red for `auth_required` (blinks
   until seen) and `error`; neutral grey with a check for `finished`; neutral grey with a lock for `blocked`.
   The "Precisa de você" counts in the sidebar and rail follow the needs-you rule above. The quick reply of
   the needs-you list is offered only for questions and permissions, never for the login or trust dialog.
8. **App**: the contract's `state` enum is unchanged; the new states travel as older ones with flags
   (`blocked` → `idle`, `auth_required` → `error`, `trust_prompt` → `waiting_input`), so an app that predates
   them shows something true. The app shows their labels; it keeps its own palette (no yellow token).
9. **MCP**: `list_tabs` documents the new states; `wait_for_state` returns on them (they are not working).
10. **Auto-close of finished automatic tabs**: not a new timer. The merge cleanup (TER-871) already closes the
    tab of a `done` run once it is `idle` or `finished`; those tabs were misread as `waiting_input`, which the
    cleanup skips. With decision 3 they read `finished` and close on merge. A tab is kept open until the
    merge on purpose: CI fixes resume into it.

## Impact on other users
Default for everyone, no setting. Fewer false alarms: a report that only offers or lists next steps no
longer shows "esperando você" nor counts in "Precisa de você"; a blocked automatic run shows grey with a
lock. An expired Claude login is red, counted and pushed (new push for everyone with the app). A tab stuck
on the folder trust dialog now shows up instead of having no indicator. Older app versions show the new
states as idle, error or waiting.
