# Web tab chat: a Claude Code tab read as a conversation in the web — design

TER-1003, asked for by the maintainer on 2026-10-07. Server and web; no migration, no agent release, no
change to the phone app. It brings the phone's "Sessões" (spec `2026-10-01-tab-chat-design.md`, TER-759)
to the web: the same transcript relay, the same contract, a web view on top.

## 1. What is reused

Everything below the view already exists for the phone and is used as is:

- `transcript.read` on the agent (≥ 0.15.0, capability `transcript`), the parser and the reader
  (`apps/server/src/tab-chat/`), and the hub that follows a watched tab (one follower per tab, poked by
  the hooks, shared by every viewer — a phone and a browser watching the same tab cost one follower).
- The routes of `routes/m-tabs.ts`: page, messages, actions (`interrupt`, `cycle_mode`, `clear`,
  `compact`), screen. The plugin is mounted a second time, at `/api/tab-chat` of the web API, under
  `terminals` (reads `terminals:read`, writes `terminals:write`), with every tab loaded through the
  caller's scope. Its only new option is the `surface` of a typed message's origin (TER-851): `app` on
  the phone (the default, unchanged), `web` here.
- The question and suggestion cards and their routes (`/api/chat/tab-questions/*`), with every option
  of the tab's dialog (TER-995).
- The paste route (`/api/tabs/:id/paste-file`) for files: a picked file is saved on the tab's machine,
  as a paste in the web terminal is, and its path goes at the end of the message.

## 2. What is new

| # | Topic | Decision | Why |
| --- | --- | --- | --- |
| W1 | Live socket | `/ws/tabs/:id/chat?after=<cursor>`, on the cookie upgrade router (origin check, `terminals:read`), the tab in the caller's scope (404 before the upgrade otherwise). Same frames as `/ws/m/tabs/:id`. Registered with the sockets the drain closes (1012). | The phone's socket authenticates with a device token and DPoP, which a browser does not have. The frames and the hub are the phone's, so both stay one contract. |
| W2 | Switching the view | A 💬 / ⌨ button on a terminal tab of the bar (TER-904) switches that tab between Terminal and Conversa, remembered per tab in the browser (`termhub:tab-view`). The terminal stays mounted and hidden, so its session and screen are there when switching back. Hidden for a tab whose hooks report another agent (Codex, Cursor). | The card asks for a button in the tab. Keeping the terminal mounted avoids a reconnect and a redraw on every switch. |
| W3 | A tab of its own, side by side | `chat:<terminal id>` is an editor-tab id, like `file:<path>` (TER-941): it opens pinned, sits in any pane, and goes with its terminal. "Abrir ao lado do terminal" turns a single pane into two columns, the terminal in one and its conversation in the other. | The layouts already take any tab id; a conversation tab is just another one. |
| W4 | Following only what is on screen | The view opens its socket only while it is on screen (a pane or the shown tab). | The server reads the transcript once a second per watched working tab; a tab in the bar but off screen should not cost that. |
| W5 | Timeline | The phone's rules (merge by id, consecutive tools folded and expandable with their result), plus a subagent (`Agent`/`Task` call) as a row of its own with its report rendered as Markdown. Messages render through the chat's Markdown path (`toHtml` of `ChatTurn`: sanitised, code blocks with the copy button, `.md` paths that open a preview tab). | The transcript of a subagent is a separate file (spec D9); its call and report are what the main thread holds. |
| W6 | Scroll | The list follows new items only while the reader is at the bottom; reading above, a live item never moves the screen and a "Novas mensagens ↓" pill appears; an earlier page keeps the reader's place (distance from the bottom). | TER-1001: a list that jumps when a message arrives. |
| W7 | Old or offline machines | The phone's availability lines ("Atualize o agente desta máquina", "Máquina offline", "Sem sessão do Claude nesta aba"…), with "Ver tela". Typing is refused only while the machine is offline: it goes through tmux, not the transcript. | Same words as the phone; an old agent can still be typed into. |

## 3. Impact on other users

- Nothing changes for someone who does not press 💬: the terminal tabs, the layouts and the chat behave
  as before. The view is opt-in per tab and per browser.
- The feature appears to whoever has `terminals:read`; sending needs `terminals:write`, as typing in the
  web terminal does. Answering a card needs the chat's grants, as in the chat.
- Transcript content crosses the server only while a conversation is on screen, and is neither stored
  nor logged (spec 2026-10-01 D4). The browser keeps it in memory only.
- The phone app is unchanged: its routes, socket and contract are untouched, and a message from it is
  still recorded as typed in the app.
- No assumption about config dirs or machines: the transcript path is the one the session's own hook
  reported, as for the phone.

## 4. Tests

- Server: the web socket (hello with the availability, subscribe from the cursor, release on close, 404
  outside the scope or for a simulator, nothing of a frame logged); the routes mounted for the web type a
  message as `surface: 'web'`.
- Web: the timeline rules (`lib/tab-chat.test.ts`) and the whole flow in `TabChat.e2e.test.tsx`
  (switching a tab, the history in Markdown with tools, subagent and copy button, a live frame, sending,
  a file's path, interrupting, a permission answered with the dialog's own option, the message refused
  while a dialog waits, an old agent, a reset, cycling the mode, opening beside the terminal, closing the
  conversation tab).
