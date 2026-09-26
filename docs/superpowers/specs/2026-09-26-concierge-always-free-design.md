# Concierge always free: messages at any time, work in background subagents — design

Card: **TER-59** (story). This spec covers scope **A** agreed on 2026-09-26: the input never blocks,
delegated work always goes to a background subagent, and its result reaches the person. TER-63 (gate
card naming the subagent), TER-64/65's subagent panel with cancel, and TER-66 (resume after a server
restart) are out of scope and get their own specs. Subtasks are listed in the implementation plan
(`docs/superpowers/plans/2026-09-26-concierge-always-free.md`).

Project rule: everything the chat does must work in the mobile app too, in the same delivery.

## 1. Problem

A project chat's concierge opened a subagent (the `Agent` tool) in the foreground and the turn stayed
busy for as long as it ran. While an answer is pending, the server refuses every new message and the
web disables the box, so the person cannot talk to the concierge at all.

## 2. Root cause (read in the code, confirmed against Claude Code 2.1.283)

- **Server.** `ChatService` keeps one lock per conversation (`running`) from the moment a run starts
  until the `claude -p` process ends. `startIn` answers any other message with 409 `CHAT_BUSY`.
- **Web.** `ChatPanel.send` awaits `POST /api/chat/messages`, which only answers when the whole run is
  over. `sending` stays true for that time and `ChatComposer` disables the send button ("aguarde a
  resposta terminar").
- **Mobile.** `POST /m/chat/messages` answers 202 at once (`ChatService.start`). The app is blocked
  only by the server's 409 (`CHAT_MSG.busy`).
- **Background delegation did not help either.** In `-p` mode the CLI does not exit while a background
  subagent runs. When the subagent finishes it runs one more turn for the `task_notification` and emits
  a second `result`. So the lock was held for the subagent's whole life anyway.
- **The prompt goes in once.** Both runners write the prompt to stdin and close it. There is no way to
  hand a live process a second message.
- **Write disabled in subagents.** This comes from the concierge's own config: `DISALLOWED_TOOLS`
  (`Bash,Read,Write,Edit,WebFetch,WebSearch`, in `@termhub/claude-cli`) is passed as
  `--disallowed-tools`, and the CLI applies it to the whole session, subagents included. That is
  intentional (spec 2026-09-21 §4.1: every write goes through the MCP gate) and **stays**.

## 3. What the CLI does (probed 2026-09-26, Claude Code 2.1.283, haiku)

| Probe | Result |
|---|---|
| `--input-format stream-json`, stdin kept open, 2nd message sent while a background subagent runs | Answered at once (`Paris` 2 s later); the subagent's notification turn came afterwards with its own `result`. |
| 2nd message sent during an active turn | Queued by the CLI and answered as a separate turn, with its own `result`. |
| `--replay-user-messages` | Each consumed message is echoed as `{"type":"user", …, "isReplay":true}` when its turn starts, **keeping the `uuid` we sent**. |
| stdin closed (EOF) while a background subagent runs | The CLI waits for the subagent, runs the notification turn, then exits 0. |
| Subagent frames | `assistant`/`user`/`stream_event` frames of a subagent carry `parent_tool_use_id` ≠ null. |
| Background state | `{"type":"system","subtype":"background_tasks_changed","tasks":[…]}` whenever the set changes. |
| `--settings` with a `PreToolUse` hook on `Agent` that exits 2 | The call is blocked and stderr reaches the model as the tool result. |

## 4. Decisions

| Topic | Decision |
|---|---|
| Runs | A chat run becomes a **long-lived process with streamed input** (`--input-format stream-json --replay-user-messages`). A message that arrives while the process is alive is **injected** into its stdin. |
| Turn ↔ message | Each injected message carries a fresh `uuid`. Its replay starts that message's turn, and the next `result` ends it. A turn with no replay (a subagent's notification) gets a **new assistant message of its own**. |
| Closing | The server ends the input (`END_INPUT_LINE`) when a turn ends with nothing pending and no background task, or when the background set empties with no turn in progress. The CLI still finishes what it has. |
| Always background | Two layers. (1) The **orchestrator prompt**, composed by the server and sent in `append_system_prompt`. (2) A **`PreToolUse` hook** fixed in `@termhub/claude-cli`, loaded with `--settings`, that refuses `Agent`/`Task` without `run_in_background: true`. The hook lives in the agent's code, not in the open frame: the server never ships a shell command to someone's machine. |
| Subagent output | Frames with `parent_tool_use_id` are ignored by the chat stream. The person sees what the concierge relays, not the subagent's raw text. |
| Old agents | Without the new capability the run stays one-shot. A message typed while it is alive is **queued**: its question and empty answer are stored and shown at once, and it runs as the next process when the lock frees up. |
| Decisions (gate) | `resumeAfterDecision` injects into a live process that accepts input. Otherwise it keeps today's path (409 `CHAT_BUSY` → queued note → drain). |
| "Nova conversa" | Unchanged: 409 while a process is alive. With background subagents that can be minutes (listed as pending). |
| Deadlines | Streamed runs: 60 min in the agent (61 min on the server). One-shot runs keep 10/11 min. |
| Write in subagents | Stays disabled (§2). |
| Container runner (`apps/concierge`) | Unused since `agentRunner`; unchanged, stays one-shot. |

## 5. Components

### 5.1 `@termhub/claude-cli`

- `ClaudeRunSpec.stream_input?: boolean`. When true, `buildClaudeArgs` adds, right after
  `--disallowed-tools`: `--input-format stream-json --replay-user-messages --settings
  <CONCIERGE_SETTINGS>`. The argv without it is byte-for-byte what it is today.
- `BACKGROUND_AGENT_HOOK`: a POSIX `sh` command. It reads the payload. If the payload has `"agent_id"`
  (a call made inside a subagent), it exits 0. If the payload has `"run_in_background": true`, it
  exits 0. Otherwise it writes a pt-BR sentence to stderr and exits 2.
- `CONCIERGE_SETTINGS`: `{"hooks":{"PreToolUse":[{"matcher":"Agent|Task","hooks":[{"type":"command","command":…}]}]}}`.

### 5.2 `@termhub/agent-protocol`

- `CAPABILITY_CLAUDE_STREAM_INPUT = 'claude.stream_input'`.
- `streamUserMessageLine(text, uuid)`: `{"type":"user","uuid":…,"message":{"role":"user","content":text}}`,
  and `STREAM_END_INPUT_LINE = '{"type":"termhub_end_input"}'`. These are wire format between the
  server and the agent, so they live here and not in `@termhub/claude-cli`. The server already loads
  this package at runtime, and the Docker image does not ship `claude-cli` (decided while planning,
  2026-09-26).
- `claudeOpenParams.stream_input: z.boolean().optional()`.
- `append_system_prompt` cap goes from 4000 to 8000. It only reaches agents that advertise the new
  capability, whose schema already allows it. `projectSystemPrompt` keeps its own 4000 cap, so what
  goes to older agents is unchanged.

### 5.3 Agent (`apps/agent/src/claude/run.ts`, version 0.6.0)

- `hello.capabilities` adds `claude.stream_input`.
- In a `stream_input` open, channel data is line-buffered:
  - each complete line is written to stdin with its newline;
  - the `END_INPUT_LINE` line closes stdin, and anything after it is dropped (size logged, never the
    content);
  - the first write clears the prompt timer, as today.
- Run timeout is 60 min in stream mode.
- The version is bumped in `package.json` and `version.ts`. CI publishes it after the merge.

### 5.4 Server runner (`agent-runner.ts`)

- `RunnerInput.stream_input?: boolean` goes to the open params.
- `RunnerClient.run` returns a `RunStream`: the same `AsyncIterable<string>` plus `write(line):
  boolean`. `write` sends a channel frame while the channel is open, buffers lines until the channel
  opens, and returns false once the channel has ended.
- In stream mode, `input.text` is the first line(s) as given (the service builds them), and the
  deadline is 61 min.

### 5.5 Stream parsing (`stream.ts`)

- Any frame with a non-null `parent_tool_use_id` → `null` (ignored).
- A `user` frame with `isReplay: true` → `{ type: 'turn_started', uuid }`.
- `system`/`background_tasks_changed` → `{ type: 'background', count }`.
- A `result` with `is_error` keeps mapping to `error`/`run_failed`, now with `turn_ended: true`, so a
  live run fails that turn only and keeps going.

### 5.6 `ChatService`

The lock keeps its meaning: at most one process per conversation. What changes is what happens when a
message finds it held.

- **`startIn`**, lock held:
  - a live stream run accepts input → inject (§5.7);
  - it is a decision (`beforeRun`) → 409 `CHAT_BUSY` as today;
  - otherwise → **enqueue**: store the question and the empty answer, publish both, keep them in
    memory, and return a `StartedRun` whose `done` settles when that turn runs.
- **`startIn`**, lock free: as today. It then chooses the driver:
  - the stream driver when the host advertises `claude.stream_input`;
  - otherwise `finishRun`, unchanged.
- **Release** (end of a process): if messages are queued, start the next process with them. A stream
  run takes all of them, injected in order. A one-shot run takes the first; the rest wait for the next
  release. If nothing is queued, the decision drain runs as today.
- **Orchestrator prompt** (`concierge-prompt.ts`): sent only to stream-capable hosts, joined with the
  project's prompt (`ORCHESTRATOR_PROMPT + "\n\n" + projectSystemPrompt(...)`). Old hosts get exactly
  what they get today.
- **Tab-question context** (`tabQuestionContextFor`) is prepended to the text of every message
  written to the CLI, injected ones included, as today.

### 5.7 Stream driver (`live-run.ts`)

A per-process object that `ChatService` owns:

- **State:** the turns written but not yet started (by uuid), the current turn, the number of
  background tasks, whether input is still open, and the session id.
- **`turn_started`:** the matching pending turn becomes current.
- **`text` / `action` / `action_result`:** go to the current turn. With no current turn (a
  notification turn), a new assistant row is created and published, and becomes current.
- **`done`:** saves the session id, stores the current turn's text and usage, publishes `message` and
  `run_finished`, and resolves its `done`. Then, if nothing is pending and `background` is 0, it ends
  the input.
- **`error` with `turn_ended`:** the current turn fails with `RUN_FAILED`, and the process goes on.
- **`background`:** records the count. If it is 0 with no current turn and nothing pending, it ends
  the input.
- **Injecting:**
  1. store the question and answer rows;
  2. check that input is still open (it can close during those awaits);
  3. add the turn to the pending set, then write the line.
  If input closed in between, the message goes to the queue instead. Nothing is lost.
- **End of stream:** every turn still pending or current is stored with the process's error code
  (from a `termhub_error` frame) or `RUNNER_FAILED`, and its `done` resolves.
- **`missing_session` before any turn ended on a resumed session:** start a fresh session once with
  the same turns. Each turn's partial text is dropped (`reset` event), as `finishRun` does today.
- **Setup failure** (`run()` throws `CONCIERGE_DISABLED`/`CONCIERGE_FAILED`): the answer rows of every
  turn are deleted, the questions republished, `run_finished SETUP_FAILED` published, and every `done`
  rejects with the error. That is today's behaviour, per turn.
- **Token failure:** every turn is stored with `TOKEN_FAILED`.

### 5.8 Web (`ChatPanel`, `ChatComposer`)

- `send` no longer refuses while another send is in flight. An in-flight counter replaces the
  `sending` flag.
- `ChatComposer` loses its `sending` prop, and with it the "aguarde a resposta terminar" line. The box
  only refuses for a host that cannot run it, or while a dictation clip is on its way to the server.
- A bubble shows "pensando…" whenever its row is started (`live.started`), not only on the newest row:
  with queued or injected turns, several answers can be pending at once.
- "Nova conversa" stays disabled while anything is being answered, as today.

### 5.9 Mobile

The app already sends without waiting for the run, and marks started rows per message. It needs no
code change beyond what the server does: the 409 it showed (`CHAT_MSG.busy`) no longer happens for a
typed message. A store test pins that a second send while an answer is pending is accepted.

## 6. Orchestrator prompt (content)

In English, like the project prompt:

- You orchestrate. The person must be able to talk to you at any moment, so never do long work inside
  your own turn.
- Delegate anything that is more than a quick lookup or one tool call (investigating, driving
  terminals, waiting on an agent, several cards) to a subagent: `Agent` with
  `run_in_background: true`. A foreground subagent is refused.
- Right after launching, say in one or two sentences what you delegated and end your turn. Do not wait
  for it or poll it.
- When a subagent finishes you are notified: relay its result, short and in the person's language.
- Messages can arrive while subagents run: answer them right away. To change a delegated task, launch
  a new subagent with the correction.
- Subagents use the same tools and the same confirmation gate. When one stops waiting for the person's
  confirmation, say so.
- Answer quick questions (one read, a status) yourself.

## 7. Error handling summary

| Case | Result |
|---|---|
| Message while an old agent's run is alive | Queued, shown at once, answered by the next process. |
| Message while a stream run is closing its input | Queued (same). |
| Decision while a run cannot take input | 409 `CHAT_BUSY` → queued note → drained at release (today's path). |
| Process dies with turns open | Each open turn stored with the process's reason or `RUNNER_FAILED`, `run_finished` for each. |
| Resumed session missing | One fresh retry with every open turn. |
| Hook refuses a foreground `Agent` | The model gets the pt-BR reason and repeats the call in background. |
| Host goes offline between messages | The queued turn's host is resolved again when it runs. A host that is not ready stores the turn with `HOST_GONE`. |

## 8. Testing

- `claude-cli`: the argv with and without `stream_input`. The hook, run with `sh` on real payloads:
  foreground refused (exit 2, stderr), background allowed, a subagent's call allowed.
- `agent-protocol`: `stream_input` parses, the 8000 cap holds, and old frames still parse.
- Agent: a fake CLI in stream mode receives several lines, `END_INPUT_LINE` closes stdin, data after
  it is dropped, and the run timeout is 60 min.
- `agent-runner`: `write` before open is buffered, after open it is framed, after the end it returns
  false. `stream_input` reaches the open params.
- `stream.ts`: subagent frames ignored, replay → `turn_started`, `background_tasks_changed` →
  `background`, `is_error` → `turn_ended`.
- `live-run` / `ChatService`:
  - injection while a background subagent runs answers the second message at once;
  - a notification turn becomes its own message;
  - input ends when idle;
  - a message during closing is queued;
  - an old host queues and drains;
  - decisions are injected into a live run;
  - missing-session retry, setup failure and token failure;
  - the orchestrator prompt goes only to stream hosts.
- Web: the composer accepts a second message while the first is answering; "pensando…" appears on
  every started row.
- Mobile: the store accepts a second send while an answer is pending.
- Typecheck and builds through Docker as `CLAUDE.md` says.

## 9. Pending (outside scope A)

- Panel of active subagents with cancel (TER-64/65).
- The gate card naming the subagent that asked (TER-63).
- Resuming a live process after a server restart or deploy (TER-66). Today a deploy ends the process,
  and open turns fail as they do now.
- "Nova conversa" while subagents run (it could end the process instead of answering 409).
- `Glob`/`Grep` are not in `DISALLOWED_TOOLS` and need no permission in `-p`. The concierge and its
  subagents can therefore search the host's files without going through the gate. This predates this work and is
  worth its own card.
