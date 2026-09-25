# Agent activity: what each agent is doing, under its person — design

Date: 2026-09-22. Status: **implemented on `feat/agent-activity`, pending review and merge.**
Builds on `2026-09-21-office-world-design.md` (the office city, in production). Where the
implementation settled something differently from this document's original text, that is noted
inline below.

## 1. Goal

Under each person on the office floor, say what that agent is doing right now — `codando`,
`lendo arquivos`, `pesquisando`, `planejando`, `no terminal` — instead of only that it is working.
The signal is the name of the tool the agent is about to call, which Claude Code reports through
its `PreToolUse` hook and which termhub today does not install. Nothing else about the tool call
travels: not its input, not the command, not the file.

The same signal is the only per-agent fact the planned public view of the city will show, so it
is designed here once, with the privacy rule it needs, and the public view inherits it.

Success:

- An agent editing files reads `codando` on the floor within a second or two of its first edit,
  and switches to `lendo arquivos` when it starts reading, with no reload.
- Twenty consecutive edits cost the server one request, not twenty.
- The server never receives a tool's input for a `PreToolUse` event — except `AskUserQuestion`'s, whose input is the question written to be shown to the person (see `2026-09-25-chat-tab-questions-design.md` §4.1).
- A machine whose agent has not updated, and any Codex tab, reads `trabalhando` — never a wrong
  category, never a blank.

## 2. What exists today

Verified in the repo on 2026-09-22:

- The monitor hook script (`packages/machine-ops/src/hooks.ts`, `HOOK_SCRIPT`) is a POSIX `sh`
  script installed under `~/.termhub/bin` on every machine, by the agent (RPC `hooks.install`,
  `apps/agent/src/rpc/hooks.ts`) or over ssh by the server (`apps/server/src/monitor/install.ts`).
  It reads the hook JSON from stdin, tags it with the tmux session and posts it whole to
  `POST /api/hooks/events`. It is wired into Claude Code's `settings.json` for
  `SessionStart`, `UserPromptSubmit`, `Notification`, `Stop` and `SessionEnd`
  (`CLAUDE_HOOK_EVENTS`) — **`PreToolUse` is not installed**. The server's `interpretClaude`
  (`apps/server/src/monitor/state.ts`) has a `case 'PreToolUse'` that maps to `working` and
  discards the payload; it never fires today.
- `Tab` carries `state`, `state_text`, `state_tool`, `state_at`, `state_seen_at`. A state change
  goes through `TabsRepository.recordEvent`, a transaction that inserts a `TabEvent`, updates the
  tab and prunes to the 200 newest events, then publishes on `monitorBus` → `/ws/monitor` → the
  browser's `MonitorProvider`, which pushes the whole `Tab` into every view — the office included.
- The agent (`@termhub/agent`, 0.4.0) updates itself and is published by CI; the server can ask a
  machine to install a given version (`agent.update`). Machines without the agent get the hook
  script over ssh.

## 3. Scope

**In:** the `PreToolUse` hook installed for Claude Code; the hook script posting a tool-name-only
event, and only when the tool name changed; the activity category decided on the server; one
nullable column on `Tab`; the label under the person in `/office`; the pieces the public view will
reuse.

**Out (recorded for later):** a pose per category (typing for `codando`, reading for
`lendo arquivos` — needs new frames in the art pack); finer categories that would need the
command text (`testando`, `commitando`); the hook handing events to the local agent over a socket
instead of posting HTTP itself (a spike of its own — it changes how every hook arrives); Codex
activity (Codex has no per-tool hook; it only reports at the end of a turn).

## 4. From the machine to the server

**The hook.** `CLAUDE_HOOK_EVENTS` gains `PreToolUse`, matcher `*`, same script. The agent's
`hooks.install` and the server's ssh install both write it; nothing else changes in how hooks are
installed or removed. Agents that have not updated keep sending the five events of today and
their tabs read `trabalhando` — the feature degrades to the current behaviour, never to a wrong
category.

**The script filters, minimally, without knowing categories.** For a `PreToolUse` event the
script:

1. Extracts `tool_name` from the JSON with POSIX parameter expansion, cutting at the first
   `"tool_name"` in the payload — Claude Code serialises the event's own `tool_name` before
   `tool_input`, so the first occurrence is always the right one. Not `sed`: a POSIX BRE's
   leading `.*` is greedy, so a `sed` extraction would take a `"tool_name"` nested inside a
   tool's input instead of the event's own. Only `[A-Za-z0-9_.-]` is accepted — the characters a
   bare Claude Code tool name or an MCP tool name can carry, hyphens included
   (`mcp__claude-in-chrome__click`) — because those are also the only characters the hand-built
   JSON body below cannot survive as-is; anything else, or no `tool_name` at all, posts nothing.
2. Compares it with the last tool name it sent for this tmux session, kept in a marker file under
   `${TMPDIR:-/tmp}`, named from the tmux session with everything but `[A-Za-z0-9_-]` reduced to
   `_` so the session name is always a safe filename. Writing the marker is best-effort: if it
   cannot be written (a read-only `TMPDIR`, say), the script stays silent and still posts the
   event — it does not fail loudly over a file it uses only to save a request.
3. Posts only when the name changed, and records the new name. Twenty consecutive `Edit` calls
   cost one request; `Edit, Read, Edit, Read` costs four, which is acceptable — each is a few
   hundred bytes, and the alternative is teaching the script the category table.

The script does not know categories; the category is decided on the server, so the product rule
lives in one place and the script stays dumb. On `SessionStart` and `UserPromptSubmit` the script
deletes the marker file, so the first tool of a new turn is always sent even when it equals the
last tool of the previous one.

**What travels.** For `PreToolUse` the script posts
`{"tool":"claude","session":"…","event":{"hook_event_name":"PreToolUse","tool_name":"Edit"}}`
— the tool name and nothing else. `tool_input` is cut before the request leaves the machine: the
server never sees it. Every other event is posted whole, as today. This is the privacy rule of
the hook, written in the script and pinned by the package's tests.

**Other machines.** Machines reached over ssh (no agent) receive the new script through the same
`hooks.install` path on their next install; the settings entry for `PreToolUse` is added like the
five others and removed with them.

## 5. On the server

**The category table** lives in `apps/server/src/monitor/activity.ts` as data, with one pure
function `activityOf(toolName: unknown): TabActivity`:

| `TabActivity` | tools |
|---|---|
| `coding` | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` |
| `reading` | `Read`, `Grep`, `Glob`, `LS` |
| `researching` | `WebSearch`, `WebFetch` |
| `planning` | `EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion`, `TodoWrite`, `TaskCreate`, `TaskUpdate` |
| `terminal` | `Bash` |
| `working` | anything else: `mcp__*` tools, `Agent`, `Skill`, unknown names, no name |

Matching is exact and looked up as the table's own property (`Object.hasOwn`, not a plain index),
so a tool name that collides with something `Object.prototype` carries — `toString`, say — cannot
read back as a function; both an unclassified name and a hostile one fall to `working`, never
something wrong.

**Interpretation.** `interpretClaude`'s `PreToolUse` case returns
`{ kind: 'working', text: null, activity: activityOf(ev.tool_name), meta: { event, tool: name } }`.
`tool_input`, should a payload ever carry it, stays ignored. `Interpreted` gains an optional
`activity`; every other event leaves it undefined.

**Storage.** One nullable column on `Tab`: `activity TabActivity?` (Prisma enum with the six
values). The migration is additive, so the previous container keeps serving during the
blue/green switch. `activity` is set while the tab is `working` and cleared whenever the tab
leaves `working` — an agent waiting for an answer is not `codando`, it is waiting. `TabEvent` does
not record activity: it is present state, not history.

**Cost.** A tool change must not cost what a state change costs. `recordEvent` is a transaction
with an insert and a prune; an active agent changes tool several times a minute. So a
`PreToolUse` that only changes the activity of a tab already `working` takes a lighter path:
`TabsRepository.setActivity(tabId, activity)` — a conditional `UPDATE` of `activity` and
`state_at`, with `state = 'working'` in its own `WHERE` (not just in the read that chose this
path), no event row — then the same `publishTabChange`. `ingestHookEvent` picks the path: state
changed or tab not `working` → `recordEvent` (with the activity); same activity as already stored
→ nothing (a defensive no-op, since the script already filters); otherwise → `setActivity`. If a
tab stops working — or is deleted — between the read that chose the light path and that `UPDATE`,
the `WHERE` matches nothing; the light path then has nothing to publish, so the request falls
through to the full `recordEvent` path rather than answering `unknown_session`, since the tab is
real and was found.

Because `setActivity` bumps `state_at` on every tool change, `state_at` on a `working` tab means
the tab's last sign of life, not when it started working. The no-op branch above — same activity
as already stored — writes nothing at all, `state_at` included; nothing reads `state_at` as
either "last sign of life" or "started working" across that gap, since nothing derives elapsed
working time from it today.

**Push.** `/ws/monitor` already carries the whole `Tab`; the new field reaches the browser with no
protocol change. The `Tab` returned by the API, and the web `Tab` type, gain `activity`.

**Route.** `POST /api/hooks/events` is unchanged: `{ tool, session, event }`, `event` opaque
until `interpretClaude`.

## 6. On the floor

**Where.** Under each person that is `working`, in place of the tab's name, a small pt-BR label:

| `TabActivity` | label |
|---|---|
| `coding` | codando |
| `reading` | lendo arquivos |
| `researching` | pesquisando |
| `planning` | planejando |
| `terminal` | no terminal |
| `working` | trabalhando |

The tab's name stays on hover, with the bound task's title. Other states are unchanged: a waiting
person shows its "!", a finished one sleeps.

**At which zoom.** The label follows the rule desk names already follow: the focused room's
desks, or every desk when the zoom is close enough. At the city rest nothing is drawn — signs and
markers already fill that space, and `codando` on forty desks would be noise.

**Pose.** A `working` person keeps typing with the screen flickering, whatever the category; a
pose per category needs new frames and is out of scope (section 3).

**Model.** `DeskModel` gains `activity: TabActivity | null`, from the snapshot and the monitor.
The merge rule — the monitor overrides only the state fields, and only when its `state_at` is
newer — now includes `activity`, which changes with the state. `buildModel` decides nothing:
`activityLabel(activity)` is a pure table with a test, and `DeskOverlay` swaps the label text
only when the desk's pose is `type` and there is an activity.

**Live.** `activity` rides on the `Tab` that `useMonitor` pushes, so the label changes as soon as
the server publishes; nothing new on the client.

**Codex and old agents** read `trabalhando`, which is honest.

**What the public view inherits.** Per agent, the public view needs exactly this — a category
derived from a tool name, which is metadata — and no tab name, project name or task title. Its
spec can start from a minimal payload (machine, agent count, one activity per agent) without
revisiting this one.

## 7. Testing

- `activityOf` and `activityLabel`: pure, table-driven tests.
- `state.test.ts`: `PreToolUse` with and without `tool_name`; a payload carrying `tool_input`
  yields the same result as one without it, and nothing of it reaches `text` or `meta`.
- `ingest`: the three paths (state change → `recordEvent` with activity; activity change on a
  `working` tab → `setActivity`; same activity → no write), with repository stubs.
- Repository (Postgres): `setActivity` writes `activity` and `state_at`; leaving `working`
  clears `activity`; `recordEvent` with an activity stores it.
- `packages/machine-ops` hook script: run under `sh` in a temp `HOME` with a fake `curl` on the
  `PATH` and `TMUX_PANE`/`tmux` stubbed — `PreToolUse` posts only the tool name; the same tool
  twice posts once; a different tool posts again; `UserPromptSubmit` resets the marker; a payload
  with no `tool_name` posts nothing; the five existing events still post whole. The settings
  merge test covers the sixth event.
- Web: `model.test.ts` (merge includes `activity`; label only for `type`), and the harness gains
  `?activity=` to force categories for a screenshot.

## 8. Risks

- **The hook fires a process per tool call** on the machine regardless of the filter — the
  filter saves the request, not the process. Claude Code already runs the `Stop`/`Notification`
  hooks this way; a parameter expansion and a file compare per call is well below a `curl`.
- **Marker files under `TMPDIR`** (falling back to `/tmp`) persist across Claude Code sessions
  with the same tmux session name; the reset on `SessionStart`/`UserPromptSubmit` covers it, and
  a stale marker at worst drops one first event, which the next tool change corrects.
- **Rollout lag.** Until an agent updates, its machine shows `trabalhando`; the label never lies.
