# Tab chat: a terminal tab read as a conversation — design

Discovery of 2026-10-01, asked for by the maintainer. Agent, server and mobile app; no migration.

The approach (A below) and the four answers in section 2 were chosen by the maintainer during the
discovery. Every other decision was taken while writing this document, and the reason is written
next to each one.

## 1. Problem

Read from the code at `98792656`.

The phone app has one way to reach an agent: the chat. The chat is a headless `claude -p` (the
concierge, `apps/server/src/chat/service.ts`, argv in `packages/claude-cli`) that reaches the Claude
Code sessions of the tabs through MCP tools (`send_input`, `wait_for_state`, `read_last_answer`). A
request is paid twice: the concierge writes the prompt for the tab and reads its answer back, and the
session in the tab does the work.

The concierge is still the right tool to drive several tabs at once. For one session it is a
middleman. The person wants to talk to the session of the tab itself, on the phone, and a raw terminal
on a phone screen is not usable.

What already reaches the server without a model:

- The tab's state, from the hooks (`monitor/state.ts`): working, waiting, error.
- The last answer of a turn (`TabLastAnswer`, from `Stop.last_assistant_message`).
- Questions and permission dialogs, as cards answered by tmux keys (`chat/tab-questions.ts`,
  `chat/tab-question-answer.ts`).
- Where the session's transcript is: `tabs.agent_session_id` and `tabs.agent_transcript_path`, kept
  up to date by every Claude hook (`monitor/ingest.ts`, `noteClaudeSession`).

What is missing is the conversation itself. Nothing reads the transcript; the path is used only to
symlink a session into another account (`claude.linkSession`). The phone receives no tab content:
`/ws/m/chat` carries the concierge's events only.

## 2. Decisions

Asked to the maintainer:

| Question | Answer |
| --- | --- |
| How does an answer appear while Claude works? | Block by block: each text block and each tool call when it is complete, with a working indicator in between. No token streaming. |
| Which sessions can the app open? | Tabs that already run Claude (opened anywhere) and new sessions started from the app. |
| Must the history open with the machine offline? | No. The server relays the transcript and stores nothing. |
| What else in the first version? | Interrupt, commands and modes, voice and attachments, and a view of the raw screen. |

Taken here:

| # | Topic | Decision | Why |
| --- | --- | --- | --- |
| D1 | Source of the conversation | The session's JSONL transcript, read on the machine. State keeps coming from the hooks, input keeps going through tmux. | The transcript is structured (text, tool calls, results). Scraping the TUI breaks with every layout change of Claude Code and loses what scrolled away. |
| D2 | Who understands the format | The server. The agent returns the lines of the types the server asks for, shrunk by a rule that knows nothing about their shape (D8). | The format is internal to Claude Code and changes without notice. A change is then fixed by a deploy, not by a release of `@termhub/agent` that every machine has to install. |
| D3 | How new lines arrive | One RPC, `transcript.read`, called by the server: when a viewer connects, on every hook event of the tab, and once a second while the tab is working and someone is watching. No new channel kind. | A channel per watched tab would spend the 64 channels an agent has, and needs a manager on the agent. The hooks alone are not enough: `PreToolUse` is posted only when the tool or the verb changes. One call a second per watched tab is cheap. |
| D4 | Storage | None. Transcript content lives in memory only while it is relayed, and is never logged. | The repo's rule on terminal content, and the maintainer's answer. Storing it would mean keeping every user's code and tool output. |
| D5 | Machines | Agent machines only. A tab on an `ssh` or `local` machine reads `unsupported_machine`. | The maintainer runs every machine through the agent and does not want the other path built. The code still accepts `ssh` and `local` (`routes/machines.ts`, `seed.ts`), so those tabs must say why they cannot be opened instead of failing. |
| D6 | Tools | Claude Code only. A Codex or Cursor tab reads `unsupported_tool`. | Their transcripts are other formats. Out of scope (section 9). |
| D7 | Gate for old agents | A capability, `transcript`, advertised in `hello` from agent 0.15.0. It covers `transcript.read` and the new `BTab` key. | An old agent drops an RPC it does not know, which would read as a timeout. Capabilities are the newer of the two gates the code has (`messages.ts`). |
| D8 | Size of what travels | The agent truncates every string longer than `max_string` and replaces a line still over 64 KB by a stub. | A transcript line holds whole file contents and pasted images in base64; a frame is at most 1 MB (`frames.ts`). The rule is generic, so D2 holds. |
| D9 | Thread shown | The main thread only. A subagent shows as its `Agent` tool call and result. | Subagent transcripts are separate files (`<session>/subagents/`). Reading them is a second feature. |
| D10 | Transport to the phone | REST for a page of history and for commands; a WebSocket per open screen, `/ws/m/tabs/:id`, for live items. | Content must go only to a phone that has the screen open (D4). `/ws/m/chat` is one stream of everything per user. An open socket is the subscription, so there is nothing to forget to unsubscribe. |
| D11 | Permissions | Reading needs `terminals:read`; sending text or keys and starting a session need `terminals:write`. Tabs are loaded through `scoped(...)`. | It is the web terminal's access under another shape. No new resource. |
| D12 | No gate card | A message typed in this screen goes to the tab with no confirmation card. | It is what typing in the web terminal does. The gate exists because the concierge acts on its own; here the person typed the text. |
| D13 | Questions and permissions | The existing cards (`TabQuestion`), shown inside the tab's conversation as well as in the project chat. Same rows, same answer routes. | They already work without a model. |
| D14 | Where it lives in the app | A second segment, "Sessões", in the Chats tab, and a screen `session/[tabId]`. | The Chats tab is where conversations are. No new tab in the tab bar. |
| D15 | App release | JavaScript only: no native module, so it ships over the air to 0.5.0 binaries. `MOBILE_API_VERSION` stays 1. | The composer, voice and attachments already exist in the binary. The routes are additions. |

Approaches set aside:

- **A headless session (`stream-json`) with the normal tools.** Documented format and token streaming,
  but there is no terminal underneath, it cannot attach to a tab that already runs, and permissions
  would need their own protocol.
- **Scraping `tmux capture-pane`.** Nothing new on the agent and any CLI works, but see D1. It stays
  as the raw screen view.

## 3. Impact on other users

- Nothing changes for someone who does not open the new segment. The chat, the web terminal and the
  hooks behave as before.
- The feature is opt-in by use, per person: it appears to whoever has `terminals:read`.
- A machine with an agent older than 0.15.0 shows its tabs with "Atualize o agente desta máquina".
  Nothing else on that machine changes.
- Transcript content crosses the server only while a phone has the screen open, and is neither stored
  nor logged.
- `transcript.read` lets the server read Claude Code transcripts on a machine. It reads nothing else:
  the agent refuses any path that is not `<dir>/projects/<slug>/<session id>.jsonl` (section 4.2).
- No assumption about config dirs: the path is the one the session's own hook reported.

## 4. The agent

### 4.1 Protocol (`packages/agent-protocol`)

```ts
export const CAPABILITY_TRANSCRIPT = 'transcript';

// rpc.ts
export const TMUX_KEYS = [..., 'BTab'] as const;   // Shift+Tab: Claude Code's mode switch

'transcript.read': def(
  z.object({
    transcript_path: machinePath,
    session_id: z.string().regex(CLAUDE_SESSION_ID_RE),
    direction: z.enum(['forward', 'backward']),
    /** forward: read from here. backward: read what ends here; null = the end of the file. */
    offset: z.number().int().min(0).nullable(),
    max_bytes: z.number().int().min(1024).max(512 * 1024),
    types: z.array(z.string().min(1).max(32)).min(1).max(16),
    max_string: z.number().int().min(256).max(16_384),
  }),
  z.object({
    status: z.enum(['ok', 'missing']),
    /** shrunk JSON lines of the asked types, in file order */
    lines: z.array(z.string()),
    /** the byte range the call covered, on line boundaries: [start, end) */
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    size: z.number().int().min(0),
  }),
  10_000,
),
```

`BTab` in `TMUX_KEYS` is sent by the server only to an agent that claims `transcript`: an older
agent's schema refuses the key as `invalid`.

### 4.2 `transcript.read` (`apps/agent/src/rpc/transcript.ts`)

- **Path.** `isClaudeTranscriptPath(path, session_id)` from `@termhub/machine-ops`, then `realpath`,
  then the same check on the real path (a link into another account is fine: it is the same shape),
  then a regular file. Anything else is `invalid`. `~` is expanded as for the other RPCs.
- **Moved transcript.** When the file is not there, look for `<root>/projects/*/<session id>.jsonl`
  and take the newest, as `claudeLinkScript` does (lesson
  `claude-transcript-moves-when-worktree-removed`). None: `status: 'missing'`, empty `lines`.
- **Forward.** Read from `offset` at most 4 MB of the file. Take whole lines only; `end` is the byte
  after the last whole line taken. Stop adding lines once the output would pass `max_bytes`. A line
  longer than the 4 MB window is skipped by scanning to its newline and counts as covered.
- **Backward.** Read the window that ends at `offset` (or at the end of the file). Drop the first,
  partial line unless the window starts at byte 0. Take lines from the end until `max_bytes`; `start`
  is the first byte of the earliest line taken.
- **Each line.** `JSON.parse`; a line that does not parse, or whose `type` is not in `types`, is
  dropped. Then shrink: every string longer than `max_string` becomes its first `max_string`
  characters plus `…[+N]`; every array longer than 200 keeps its first 200. If the result is still
  over 64 KB the line becomes `{"type":…,"uuid":…,"timestamp":…,"termhub_dropped":true}`.
- Nothing of a line is ever logged, only counts and sizes.

`apps/agent/src/run.ts` adds `CAPABILITY_TRANSCRIPT` to `CAPABILITIES`. Version 0.15.0
(`package.json` and `version.ts` together).

## 5. The server (`apps/server/src/tab-chat/`)

### 5.1 `transcript.ts`: lines to items (pure)

```ts
export const TRANSCRIPT_TYPES = ['user', 'assistant', 'system', 'permission-mode'];

type TabChatItem =
  | { kind: 'user'; id: string; at: string; text: string; images: number }
  | { kind: 'assistant'; id: string; at: string; text: string }
  | { kind: 'tool'; id: string; at: string; name: string; summary: string | null }
  | { kind: 'tool_result'; id: string; at: string; tool_id: string; error: boolean; preview: string | null }
  | { kind: 'command'; id: string; at: string; name: string; args: string | null }
  | { kind: 'command_output'; id: string; at: string; text: string }
  | { kind: 'notice'; id: string; at: string; notice: 'compacted' | 'interrupted' | 'truncated' };

export function parseLines(lines: string[]): { items: TabChatItem[]; mode: string | null; unknown: number; known: number };
```

Rules, checked against a real transcript (2 399 lines; types `user`, `assistant`, `system`,
`attachment`, `permission-mode`, `mode`, `queue-operation`, `ai-title`, `last-prompt`,
`file-history-snapshot` and others):

- `isSidechain: true` and `isMeta: true` lines are skipped.
- `assistant`: one item per content block. `text` gives `assistant`; `tool_use` gives `tool`, with
  `id` the tool-use id; `thinking` is skipped. Item id: `<uuid>:<block index>`.
- `user` with a string content: `<command-name>` gives `command`; `<local-command-stdout>` gives
  `command_output`; a content that is only a known wrapper (`<task-notification>`,
  `<system-reminder>`, `<local-command-caveat>`) is skipped; `isCompactSummary` gives `notice
  compacted`; the interrupt marker (`[Request interrupted by user…`) gives `notice interrupted`;
  anything else is a `user` item.
- `user` with blocks: `text` blocks joined give a `user` item (the same wrapper rules apply),
  `image` blocks are counted in `images`, each `tool_result` gives a `tool_result` with `tool_id` its
  `tool_use_id` and `preview` its text (first 2 000 characters).
- `tool.summary`, by tool name: `Bash` the command, `Read`/`Edit`/`Write`/`NotebookEdit` the file
  path, `Grep`/`Glob` the pattern, `Agent`/`Task` the description, `WebFetch` the URL, `WebSearch` the
  query; any other tool, `null`. Capped at 300 characters.
- `system`: only `subtype: 'compact_boundary'` gives `notice compacted`. The rest is skipped.
- `permission-mode`: no item; the last one read is the page's `mode`.
- A `termhub_dropped` line gives `notice truncated`.
- A line of an asked type that yields nothing and is not one of the skips above counts in `unknown`.
  A page where `unknown` is more than half of `known + unknown` is `degraded`.

### 5.2 `reader.ts`: availability and pages

```ts
type TabChatAvailability =
  'ready' | 'no_session' | 'unsupported_tool' | 'unsupported_machine' | 'agent_outdated' | 'offline';

export function availabilityOf(tab: Tab, machine: Machine): TabChatAvailability;
export async function readPage(machine, tab, before: Cursor | null): Promise<Page>;
export async function readForward(machine, tab, after: Cursor): Promise<Forward>;
```

- `unsupported_machine`: the machine is not an agent machine. `offline`: its agent is not connected.
  `agent_outdated`: no `transcript` capability. `unsupported_tool`: `state_tool` is set and is not
  `claude`. `no_session`: no `agent_transcript_path`. Else `ready`.
- A cursor is `<session id>.<byte offset>`, opaque to the app. A cursor of another session, or an
  offset past `size`, is a reset: the caller starts again from the end.
- `readPage` asks backward for 256 KB with `max_string` 4 000 and returns the items, the `before`
  cursor (`null` at byte 0), the `live` cursor (`end`) and `degraded`.
- `status: 'missing'` gives an empty page with `availability: 'no_session'`.

### 5.3 `hub.ts`: who is watching

One follower per watched tab, created by the first socket and dropped with the last.

- It holds the tab's cursor and reads forward: once when created, on `poke(tabId)`, and every second
  while `tab.state === 'working'`. One read in flight at a time; a poke during a read marks one more.
- `poke` is called from `ingestHookEvent` for every Claude hook event of the tab, after the tab row
  is updated.
- A socket joins with its own `after` cursor. Behind the follower, it is caught up by its own forward
  reads first.
- `agent_session_id` changed (a `/clear`, a resume in another account): the follower sends `reset`
  and starts at the end of the new file.
- The tab's own changes (`monitorBus`) are forwarded as `state`.
- A failed read (agent offline, timeout) sends `unavailable` with the reason and retries on the next
  poke or tick; three failures in a row stop the ticking until the next poke.

### 5.4 Routes (`routes/m-tabs.ts`, `guarded('terminals', …, '/tabs')`)

| Route | Action | Does |
| --- | --- | --- |
| `GET /tabs` | read | Terminal tabs in the caller's scope: tab, project, machine, state, `needs_you`, activity, `availability`. |
| `POST /tabs` | write | `{ project_id, machine_id?, prompt }`. `startAgent` with the project's account and model. Answers `{ tab_id }`. |
| `GET /tabs/:id/chat?before=` | read | A page (5.2), the tab's summary, `mode`, and its open question and suggestion cards. |
| `POST /tabs/:id/chat/messages` | write | `{ text }`, at most 4 000 characters. `sendInput`. A tab waiting on a permission answers 409 `WAITING_PERMISSION`. |
| `POST /tabs/:id/chat/actions` | write | `{ action }`: `interrupt` (Escape), `cycle_mode` (`BTab`), `clear` (`/clear`), `compact` (`/compact`). `cycle_mode` answers the mode read from the screen. |
| `POST /tabs/:id/chat/files` | write | A file, at most 20 MB. `saveFileOnMachine`. Answers `{ path, name }`; the app puts the path in the message. |
| `GET /tabs/:id/screen?lines=` | read | The last lines of the pane as plain text (`readScreen`, `plain`), at most 200. |

- Every input is a zod schema from `packages/mobile-api/src/tab-chat.ts`.
- Each route loads the tab through `scoped(repos, request).tab(id)`.
- The control functions are reused through `controlContextFor`, as `m-chat.ts` does for the tab
  question routes.
- `cycle_mode`: after the key, the server captures the pane and `claudeFooterMode(screen)`
  (`monitor/screen-state.ts`) returns `default`, `acceptEdits`, `plan`, `bypassPermissions` or
  `unknown`. The transcript's `permission-mode` line is written with a prompt, not with the key, so it
  cannot answer this.

### 5.5 Live socket (`mobile/tab-ws.ts`, `/ws/m/tabs/:id?v=1&after=<cursor>`)

Authenticated like `/ws/m/chat`: bearer token, DPoP proof over the path, device re-check, registered
in `MobileSocketRegistry`. The upgrade checks move into a function both sockets call. Then
`terminals:read` and the scoped tab (4404 when it is not the caller's).

Server to phone only:

```ts
{ type: 'hello', protocol, server_time, availability }
{ type: 'items', items: TabChatItem[], live: string, mode: string | null }
{ type: 'state', tab: TabSummary }
{ type: 'reset', session_id: string | null }
{ type: 'unavailable', availability }
```

`reset` tells the app to drop its items and fetch the first page again.

## 6. The app (`apps/mobile/src/features/tab-chat/`)

- **Sessões** (segment of the Chats tab): tabs grouped by project, each with its state dot, activity
  and "precisa de você". A tab that is not `ready` is listed with its reason ("Máquina offline",
  "Atualize o agente desta máquina", "Sem sessão do Claude", "Só Claude Code por enquanto"). "Nova
  sessão" asks for the project, the machine when the project has more than one, and the first message.
- **Session screen** (`app/session/[tabId].tsx`):
  - The timeline: `user` and `assistant` as the chat's bubbles (same markdown), consecutive `tool`
    items folded in one row ("5 ferramentas") that opens to name, summary, status and result preview,
    `command`, `command_output` and `notice` as small lines.
  - A `tool` with no `tool_result` yet shows as running while the tab works.
  - Pull up loads the previous page (`before`).
  - The tab's open question and permission cards at the end, with the existing components.
  - The header shows the state ("Trabalhando · Bash", "Esperando você") and the mode.
  - The composer of the chat, with voice and attachments. While the tab works, the send button is an
    interrupt button. A menu holds "Limpar conversa (/clear)", "Compactar (/compact)", "Alternar modo"
    and "Ver tela".
  - "Ver tela" opens a sheet with the raw screen in a monospace font, with a refresh.
  - `degraded` shows a line: "Não consegui ler parte do histórico. Use Ver tela."
- **State**: a store per open tab (zustand, as the chat's): the first page over REST, then the socket
  with `after: live`; items are merged by `id`, and a `tool_result` marks its `tool`. Nothing is
  persisted on the phone.
- Copy is pt-BR.

## 7. Errors

| Case | What the person sees |
| --- | --- |
| Agent offline | The list says "Máquina offline". An open screen keeps its items, shows the line and a disabled composer; it resumes when the agent returns. |
| Agent older than 0.15.0 | "Atualize o agente desta máquina" on the list and on the screen. |
| No session yet (the hook has not fired) | "Sem sessão do Claude nesta aba" with "Ver tela". The composer works. |
| Transcript gone | The same as no session. |
| `/clear` or an account swap | The screen empties and loads the new session. |
| Waiting on a permission | The card is at the end of the timeline; sending text answers "Responda a pergunta acima". |
| Transcript format not understood | The `degraded` line; items that did parse are shown. |
| Text over 4 000 characters | Refused by the composer before sending. |

## 8. Tests

- **Protocol**: `transcript.read` params and result; `BTab` accepted; an old `hello` still parses.
- **Agent** (`rpc/transcript.test.ts`, on temporary files): path refusals (outside `projects`, wrong
  name, `..`, a link that leaves the shape), the moved transcript, forward and backward on line
  boundaries, a partial last line left for the next call, `max_bytes`, the type filter, the shrink
  rule, the stub over 64 KB, a line longer than the window.
- **Parser**: one fixture per rule of 5.1, built by hand from the key shapes measured (no real
  content), plus the `degraded` count.
- **Reader and hub**: availability table, cursor of another session, reset on a new session id, one
  read in flight, catch-up of a late socket, stop with the last socket, three failures.
- **Routes**: scope (404 outside it), `terminals:write` for the writes, each action's key or text,
  409 while waiting on a permission, the file route's size limit.
- **Socket**: the upgrade refusals of `/ws/m/chat`, 4404, the frames in order.
- **Contract** (`packages/mobile-api`): every frame and body, and an unknown item kind dropped by the
  app rather than failing the page.
- **App**: timeline folding, merge by id, `reset`, the unavailable states, the interrupt button.
- **By hand**, before release, on a real machine: open a tab that runs, send a message, answer a
  permission, interrupt, `/clear`, cycle the mode, attach an image, read the raw screen; then the
  footer strings `claudeFooterMode` reads.

## 9. Out of scope

- The web. It has the real terminal.
- Codex and Cursor tabs.
- `ssh` and `local` machines.
- Subagent transcripts.
- Token-by-token streaming.
- Storing or searching sessions on the server.
- New push notifications: the existing ones for questions and finished turns are unchanged.
- Replacing the concierge chat.

## 10. Release order

1. `@termhub/agent` 0.15.0 (published by CI on merge).
2. The server.
3. The app, over the air.

Each step is harmless without the next: the agent only answers a new RPC, and the server's routes
have no caller until the app ships.
