# Tab questions per subagent — design

Card: **TER-179**, epic TER-407. Front 8 of the roadmap
(`2026-09-29-chat-and-machine-agent-roadmap-design.md`). Hook script (`@termhub/machine-ops`, shipped by
`@termhub/agent`), server, one migration. No screen changes.

Every decision below was taken without the user (2026-09-30, asked to plan and execute by
recommendation); the reason is written next to each one. Section 3 is what was measured on a real
Claude Code before any of it was designed. The first version of this design was reviewed against the
code before any of it was written; section 9 says what that review changed.

## 1. Problem

The first attempt at closing a subagent's card was reverted (spec 2026-09-26 tab questions hardening,
§10): the hook script collapses a subagent's `agent_id` into `subagent: true`, so the server cannot tell
one subagent from another, and B's closing event closed A's card and ended the queue, after which B's
next card could approve A's dialog. The rule since then: a subagent's event never closes a card, its own
included. After the person answers a subagent's permission in the terminal, that card stays open and
pending until the main thread's next closing event, and the subagent's later permissions queue behind
it, answered in the terminal with no card.

The main thread has the opposite fault: its `Stop` fires while background subagents still run
(measured, section 3), closes every card of the tab and ends the queue, with a subagent's dialog on
screen.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| The hook script forwards the id | For Claude Code only, the reduced `PreToolUse` and `PermissionRequest` bodies carry `agent_id` as a value, next to `subagent: true`: the id as Claude Code sends it, kept only when it is 1 to 64 characters of `A-Za-z0-9_-`, dropped otherwise (the flag alone then travels). Codex's bodies are unchanged. | The id is what tells subagents apart. The boolean stays so an older server keeps today's behaviour with a newer script. Codex opens no subagent cards. |
| `SubagentStop` | Claude's `SubagentStop` is subscribed (`CLAUDE_HOOK_EVENTS`, no matcher). The script reduces it to `{"hook_event_name":"SubagentStop","subagent":true,"agent_id":"…"}` and posts nothing when the id was dropped. | A subagent that ends after its dialog (denied, or its last tool call) sends no other event. Its payload carries the subagent's last message, which must not travel. It fires once per subagent, so the cost is small. |
| No `PostToolUse` for Claude | Not subscribed. A subagent's card closes on that subagent's next `PreToolUse` or on its `SubagentStop`. | This is what the main thread's cards already do: nothing fires when the person approves, and the card closes on the next event. `PostToolUse` would gain the model's thinking time only, for one more hook process per tool call of every session, and the wait rule drops a `PostToolUse` on a waiting tab (`wait-decision.ts`, Codex's Esc tail). |
| The dedupe marker | The marker's key gains the agent: `<agent_id>:<tool>[ <verb>]` for a subagent, `<tool>[ <verb>]` as today for the main thread. | With one marker per tmux session, B's `PreToolUse Bash` has A's key and one of them is swallowed: the closing event of a card would never be posted. |
| The marker after a permission | Claude's `PermissionRequest` removes the marker, as Codex's already does. | The tool call that follows an answered dialog is what closes the card, and with the same tool and no spinner verb it has the key of the call before the dialog. The `Notification` that resets the marker today arrives late (section 3). |
| `Interpreted` | `meta.agent_id` (string) next to `meta.subagent`, for Claude only. `SubagentStop` interprets to an event flagged `closeOnly`: it records no tab state, cancels no suggestion check and only runs the card bookkeeping. | The interpreter is the one place that reads the payload. A subagent ending says nothing about the tab's state. |
| `TabQuestion.agent_id` | A nullable column. Set from the opening event's `agent_id`; null for the main thread, for Codex and Cursor, and for an old script. No index: closes filter by `tab_id` and the open statuses, which `tab_questions_tab_id_status_idx` serves. | The card must know whose dialog it is. |
| What closes a card | An event closes the rows of its own agent only: an event with `agent_id` X closes X's rows; a main-thread event closes the main thread's rows (`agent_id` null). Two main-thread events close every row of the tab: `SessionEnd`, and a `Stop` with no background task running. What never closes is what never closes today: an event that opens a question, a `Notification`, AskUserQuestion's own `PermissionRequest`, and an event with `subagent: true` and no `agent_id` (an old script). | This is the fix. The main thread's `Stop` with background tasks must not close a running subagent's card; a subagent's next event is what closes its own. The two that close everything are the moments that prove nothing runs (a subagent blocked on its dialog is listed as running in `background_tasks`, measured). They are also what cleans up after a subagent that was killed and sent nothing. A `UserPromptSubmit` is not one of them: a prompt typed during the main turn is submitted when the turn ends, and whether that can happen with a subagent's dialog on screen was not measured. A Claude Code older than `background_tasks` sends none, which reads as nothing running: today's behaviour. |
| A new question | As today: a question that opens closes whatever the tab still had open, of any agent. | One open card per tab is what the screens and `findOpenForTab` assume. |
| Queue | As today a permission that arrives while a permission card of the tab is open closes that card, marks the queue and opens nothing, and every permission until the queue ends is answered in the terminal. New: the mark carries the agents in the queue (`queue_agents`: the closed card's agent and each queued permission's, `''` for the main thread). A subagent leaves the list only when it ends (`SubagentStop`); the main thread leaves it on any of its closing events, as today. The queue ends when the list is empty, and a close of every row, or a choice that opens, ends it at once. | Claude Code shows one dialog at a time and the next right after an answer (measured). Ending the queue on any closing event is the original bug: B's event ended a queue A was still in. A subagent's tool call is not proof that it has no dialog pending: hooks are posted in the background, and the `PreToolUse` of a parallel call can land after the `PermissionRequest` of the one that waits. A card closed too early is the safe side; a queue ended too early is not. Marks written by the previous release carry no list and end on the first close that may end a queue, as they do today. |
| Live check | For a permission card, the dialog on screen must not be another tool's: when the capture shows a dialog title the server knows (the line under the lowest box rule: `Bash command`, `Edit file`, `Fetch`) and it is not the title of the card's tool, the answer is refused. A title the server does not know changes nothing. `permissionDialogVisible` (the gate) is unchanged. | The footer and "Do you want" are the same for every dialog. The check is written to fail open: if Claude Code renames a title, cards behave as today instead of all being refused. Titles come from the repository's fixtures and the measurement of section 3. |
| The tool's input | Not sent. The card shows the tool's name, as today. | A hint of the command would tell two `Bash` dialogs apart, but "only the tool's name travels, never its input" is a rule of the hook script (spec 2026-09-25 §4.1) and reversing it stores command text, which may hold secrets, in the database. That is the person's decision, written up as a follow-up card. The queue is what keeps two dialogs of one tool apart. |
| Logs | Ids only: `agent_id` may be logged. | It is an opaque id of the session. |
| Agent release | A patch version of `@termhub/agent`, published by CI. `heal()` rewrites the script and merges the new event on reconnect; ssh machines need "Reinstalar hooks". A Claude Code session already running may keep the hooks it started with (not verified): it then sends the id and no `SubagentStop` until it restarts, and its subagents' cards close on their next tool call or on a close of every row. | The script ships with the agent. |
| Migration | `ALTER TABLE "tab_questions" ADD COLUMN "agent_id" TEXT, ADD COLUMN "queue_agents" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];` | The previous release keeps serving and never names them: its rows get null and an empty list, and are the main thread's, as today. |
| Codex and Cursor | Unchanged: their rows have no agent, so a main-thread close is a close of every row, and their queue has one member. A Codex subagent's event still closes nothing. | Out of scope. |

## 3. What was measured (2026-09-30, Claude Code 2.1.285 on hulk, `--permission-mode default`)

One prompt launched two background subagents, A and B, each running one `Bash` command that needs a
permission. Every hook payload was written to a file by a measuring hook (termhub subscribes to fewer
events: see `CLAUDE_HOOK_EVENTS`). In order:

| Event | `agent_id` | Notes |
|---|---|---|
| `PreToolUse` Agent, `PostToolUse` Agent, twice | none | the main thread launches A and B |
| `Stop` | none | the main thread's turn ends; `background_tasks` lists A and B as running |
| `PreToolUse` Bash, `PermissionRequest` Bash | A | the command in `tool_input.command`; A's dialog is drawn |
| `PreToolUse` Bash, `PermissionRequest` Bash | B | while A's dialog is still on screen; no dialog for B yet |
| `SubagentStop` | other ids, `agent_type` empty | helper agents of the run; nothing to do with the dialogs |
| `Notification` permission_prompt, twice | none | for A's dialog |
| the person answers A in the terminal | | |
| `PostToolUse` Bash, `SubagentStop` | A | `SubagentStop` is what closes A's row |
| `Notification` permission_prompt | none | B's dialog is now on screen |
| `Stop` | none | the main thread relays A's result; `background_tasks` lists B. **Today this closes every card and ends the queue.** |
| the person answers B | | |
| `PostToolUse` Bash, `SubagentStop` | B | |
| `Stop` | none | `background_tasks` empty |

The dialog reads "Bash command · from the general-purpose agent" under a box rule, then the command and
its description, "Do you want to proceed?", the options, "Esc to cancel · Tab to amend". `agent_id` (17
hex characters) and `agent_type` sit before `hook_event_name` in every subagent payload, `SubagentStop`
included, which also carries `last_assistant_message`. `Notification` carries no `agent_id`.

With the rules of section 2, the same sequence gives: A's card opens; B's permission closes it and starts
the queue with A and B (today's rule, kept); the main thread's `Stop` touches neither; A's `SubagentStop`
takes A out of the queue; B's takes B out and the queue ends; the last `Stop` closes whatever is left.
Not measured: the order of a parallel call's `PreToolUse` against the `PermissionRequest` of the call
that waits, and whether a prompt queued during the main turn is submitted with a subagent's dialog on
screen. The rules of section 2 assume the unsafe answer to both.
The case this front is for is the sequential one: a subagent asks, the person answers in the terminal,
the subagent's next tool call closes its card, and its next permission opens a new one.

## 4. Shapes

```ts
// packages/machine-ops/src/hooks.ts
export const CLAUDE_HOOK_EVENTS = [..., 'SubagentStop'] as const;
// reduced bodies (Claude)
{"hook_event_name":"PreToolUse","tool_name":"Bash","verb":"Moonwalking","subagent":true,"agent_id":"ac5724783efd1ee13"}
{"hook_event_name":"PermissionRequest","tool_name":"Bash","subagent":true,"agent_id":"ac5724783efd1ee13"}
{"hook_event_name":"SubagentStop","subagent":true,"agent_id":"ac5724783efd1ee13"}

// apps/server/src/monitor/state.ts
interface Interpreted { /* as today, plus */ closeOnly?: true }
meta: { event, tool?, subagent?: true, agent_id?: string }

// apps/server/src/db/repositories/tab-questions.ts
/** Which rows a close reaches: one agent's (null is the main thread), or every row of the tab. */
export type CloseScope = { agent: string | null; leavesQueue: boolean } | 'all';
interface OpenTabQuestionInput { /* as today, plus */ agent_id: string | null }
closeForTab(tabId: string, status: TabQuestionCloseStatus, scope: CloseScope = 'all', now = new Date())

// apps/server/src/chat/tab-questions.ts
/** Which rows a hook event closes, or null when it closes nothing. Replaces closesOpenQuestion. */
export function closingScope(next: Interpreted): CloseScope | null
closeTabQuestions(repos, tabId, status, scope: CloseScope = 'all')

// apps/server/src/chat/permission-dialog.ts
/** The tool whose known dialog title sits under the lowest box rule of the capture, or null. */
export function dialogTool(screen: string): string | null
```

## 5. Rules

- `closingScope(next)`, in this order: null when `next.question`; null for a `Notification`; null for a
  `PermissionRequest` of `AskUserQuestion`; for an event with `meta.subagent`, null when it has no
  `meta.agent_id`, else `{ agent: meta.agent_id, leavesQueue }` with `leavesQueue` true only for a
  `SubagentStop`; `'all'` for `SessionEnd` and for a `Stop` whose `backgroundTasks` is absent or 0;
  `{ agent: null, leavesQueue: true }` for anything else. A `PermissionRequest` that opens
  no card (ExitPlanMode, a rejected tool name, Codex's) closes its own agent's rows, as it closes today.
- `closeForTab` with `{ agent }` closes the open and answered rows of the tab whose `agent_id` is that
  agent (null matches null). When the scope `leavesQueue`, it then removes the agent's key (`agent ?? ''`)
  from `queue_agents` of every marked row of the tab and clears the mark of a row whose list is now
  empty. With `'all'` it closes
  every row and clears every mark and list. The tab's lock is taken as today, and the pre-check that
  skips the lock stays (a marked row counts as something to do).
- `open` stores `agent_id`. A permission that finds the tab's newest row an open permission marks it
  and sets its `queue_agents` to the two keys (one when both are the same agent); one that finds it
  already marked adds its key when absent. A choice that opens clears every mark and list of the tab,
  with or without a conversation. Everything else in `open` is as today, including closing every open
  row of the tab.
- `promptVisible` for a permission row: today's rule (footer, "Do you want"), and `dialogTool(screen)`
  is null or the row's `tool_name`. `dialogTool` takes the lowest box rule (`RULE`) of the capture and
  reads the non-blank line under it, trimmed and lower-cased: a known title, or one followed by a space
  and more, answers its tool (`bash command` → `Bash`, `edit file` → `Edit`, `fetch` → `WebFetch`);
  anything else, and a capture with no rule, answers null. It never looks above that rule: what is up
  there is the transcript.
- `ingestHookEvent`: an interpreted event with `closeOnly` skips the suggestion cancel, the Claude
  session note and the tab's record, calls `noteHookEvent` with the tab as read, and answers ok.
- `answerTabQuestion` is unchanged: `promptVisible` is what refuses a stale card (409
  `TAB_PROMPT_CHANGED`).

## 6. Tests

- Hook script (`packages/machine-ops`): a subagent's reduced `PreToolUse` and `PermissionRequest` carry
  `agent_id`; the main thread's carry neither key; an id with a quote, or 65 characters long, is dropped
  and the flag stays; Codex's bodies carry no `agent_id`; `SubagentStop` is reduced to its three keys and
  never carries `last_assistant_message`; a `SubagentStop` with no usable id posts nothing; two agents
  interleaving `Bash` both get posted, and one agent repeating it is still deduped; an agent's `Bash`
  after its own `PermissionRequest` is posted; the settings merge
  installs `SubagentStop` with no matcher.
- `state.test.ts`: `meta.agent_id` on a subagent's `PreToolUse`, `PermissionRequest` and whole
  AskUserQuestion; none on the main thread's, on an id that fails the pattern, or on Codex's;
  `SubagentStop` with an id is `closeOnly`, without one is ignored.
- `ingest.test.ts`: a `closeOnly` event records nothing, cancels no suggestion and reaches
  `noteHookEvent`.
- `tab-questions.test.ts`: the table of `closingScope` (section 5, one row per branch, ExitPlanMode
  included); the measured sequence of section 3 through `noteHookEvent`, asserting the scope of each
  close and the `agent_id` of each open.
- `tab-questions.db.test.ts`: a scoped close closes its agent's card only; the queue with A and B ends
  only after both ended (`leavesQueue`), and a tool call of either in between closes its card and keeps
  the queue; a main-thread close in between changes nothing of theirs; a choice that opens ends it; `'all'` ends it at
  once; a mark with an empty list (the previous release's) ends on the first close that leaves the queue; `open`
  stores `agent_id`.
- `permission-dialog.test.ts`: a `Bash` card against the Bash, Edit and WebFetch fixtures (passes,
  refused, refused); an `Edit` card against the Edit fixture; a card of a tool with no known title
  (`Skill`) against its own fixture passes and against the Bash fixture is refused; "Bash command · from
  the general-purpose agent" counts as Bash; a capture with no rule passes as today; a known title above the lowest rule (the transcript) is not
  read;
  `permissionDialogVisible` answers the same as before for every fixture.

## 7. Out of scope

- Cards for queued dialogs (a queued permission opens nothing, as today).
- Showing, and checking on screen, what a permission approves (a hint of the tool's input): a product
  decision about what leaves the machine, written up as a follow-up card. Decided in TER-614 as an
  opt-in per machine (`2026-10-08-permission-hints-design.md`).
- Two dialogs of the same tool in a row with a lost or late hook in between: the queue covers the
  ordinary case, and only the hint above would cover this one.
- Codex and Cursor subagents.

## 8. Impact on other users

The default for everyone, with no setting: it corrects when a card closes, and adds no behaviour a person
could want off.

- Anyone who runs Claude Code subagents in a tab: a subagent's permission card now closes when that
  subagent moves on, and its next permission gets a card; with background subagents, the main thread
  ending its turn no longer closes their cards.
- Anyone who never uses subagents: nothing changes. Every row has no agent, and the main thread's events
  close them as today. The one difference is a `UserPromptSubmit`, which now closes the main thread's
  rows only, which are all of them.
- Codex and Cursor users: nothing changes.
- Machines: each gets one more Claude hook entry (`SubagentStop`) in `~/.claude/settings.json`, written by
  the same install and repair that write the others, and removed by the same uninstall. The script posts
  one more small request per subagent that ends. Nothing new leaves the machine but an opaque id of the
  session's subagent: no tool input, no message text.
- A machine whose agent has not updated keeps today's behaviour.

## 9. What the review of the first version changed

| First version | Problem found | Now |
|---|---|---|
| A subagent's `PostToolUse` closes its card | termhub does not subscribe Claude's `PostToolUse`, and the wait rule drops one on a waiting tab | The subagent's next `PreToolUse` or its `SubagentStop`, newly subscribed and close-only |
| The queue unchanged, ended by any scoped close | Any agent's close ended a queue another agent was still in: the bug of the first attempt | `queue_agents`: the queue ends when every agent in it has left |
| A's card survives B's permission in the measured sequence | It does not: a queued permission closes the open card | Said as it is (section 3); kept, since keeping the card would need the hint to be safe |
| A hint of the input, sent, stored, shown and checked | Multi-line commands, accents and absolute paths made it miss real dialogs; it reverses "never its input" | Out of this front (section 7) |
| The tool's title required on screen | `WebFetch` draws "Fetch", `Skill` and MCP tools draw other titles: valid cards refused | Refuse only a known title of another tool; fail open |
| One dedupe marker key per tool | Another agent's identical tool call swallowed the closing event | The key carries the agent |
| Only `SessionEnd` closes everything | A killed subagent's card stayed open for the session | A `Stop` with nothing in the background too |
| `PermissionRequest` never closes | Today one that opens no card closes (ExitPlanMode) | Kept as today, scoped |
| An index on `(tab_id, agent_id)` | No query uses it | Dropped |
| `agent_id` for Codex too | Out of scope, and changes Codex's bodies | Claude only |

The second review, of the version above, changed four more things: Claude's `PermissionRequest` resets
the dedupe marker (the closing `PreToolUse` had the key of the call before the dialog); a
`UserPromptSubmit` closes the main thread's rows only; a subagent leaves the queue only when it ends;
`dialogTool` reads the lowest rule only.
