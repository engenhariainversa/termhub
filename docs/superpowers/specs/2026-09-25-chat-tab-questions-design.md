# Chat: answering a tab's questions from a selection widget — design

Card: **TER-56** (epic TER-1 · Chat). Subtasks are listed in the implementation plan
(`docs/superpowers/plans/2026-09-25-chat-tab-questions.md`).

Project rule: everything the chat does must work in the mobile app too, in the same delivery.

## 1. Problem

When an agent in a tab asks a multiple-choice question (Claude Code's `AskUserQuestion`) or a
permission ("Do you want to proceed?"), the chat can only read the screen and summarise it. The
user types an answer, the concierge relays it with `send_key` / `send_input`, and every relay is a
confirmation card. The chat should instead show the question itself — options, descriptions, the
recommended one, a free-text field — and one click answers in the right tab.

## 2. Decisions

| Topic | Decision |
|---|---|
| Source of the question | **Claude Code hooks**, not screen parsing. The hook script forwards `AskUserQuestion`'s `tool_input` (questions/options) and `tool_use_id`; a new `PermissionRequest` hook forwards the tool's **name only**. Machines with the old script send neither and keep today's text flow. |
| Where it shows | **Pushed** by the server into the **most recent non-archived conversation of the tab's project** (by last activity), with or without a concierge run in progress. A project with no conversation gets nothing (the question stays in the tab, as today). |
| Answering | A click is the confirmation: no gate card, no model turn. |
| PIN on the phone | **No PIN on any platform** for now (the app's access is already restrictive and the chat must stay fluid). **Revisable:** the route is built so that requiring the PIN for `kind = permission` "yes" answers is a one-place change (§5.3). |
| Concierge awareness | Answers do not start a run. On the user's next turn, answered questions not yet told to the model are prepended as context. |
| Terminal content | Never stored. The permission card fetches a live excerpt of the screen when it opens (same data `read_screen` / the terminal view already give the user); it is not persisted nor logged. |

## 3. What Claude Code sends (captured 2026-09-25, Claude Code 2.1.282)

Captured in an isolated tmux (`-L th-probe`) with a logging hook; fixtures live in
`apps/server/src/chat/fixtures/tab-questions/`.

- `PreToolUse` for `AskUserQuestion`:
  `tool_input = { questions: [{ question, header, options: [{ label, description }], multiSelect }] }`
  and `tool_use_id`. The recommended option is marked **in its label**: `"Blue (Recommended)"`.
- `AskUserQuestion` **also** fires `PermissionRequest` (same `tool_input`) and
  `Notification{notification_type:"permission_prompt", message:"Claude needs your permission"}` —
  so the tab already goes `waiting_permission` while a question is on screen.
- A real permission (`Bash`) fires `PreToolUse`, `PermissionRequest{tool_name, tool_input,
  permission_suggestions}`, then the same generic `Notification`.
- Screen and keys:
  - Question tabs header `←  ☐ Color  ☐ Fruits  ✔ Submit  →` (only when there are 2+ questions).
  - Single-select: a digit picks the option and moves to the next question (or submits when it is
    the only question).
  - Multi-select: a digit toggles `[ ]`/`[✔]` without moving the focus; `Tab` moves to the next
    question / the Submit tab. The Submit tab is shown even for a lone multi-select question, so
    `Tab` after it lands on "Review your answers" (seen in the e2e run).
  - Free text, single-select: the digit right after the last option ("Type something.") focuses an
    inline field; the text is typed literally, then `Enter` (which submits a lone question at once).
  - Free text, multi-select: the "[ ] Type something" row takes text only while focused (a digit
    only toggles it, and with the focus there digits are typed into it): `Down` once per option
    reaches it, typing checks it, `Tab` moves to the question's "Next"/"Submit" row and `Enter`
    leaves the question (seen in the e2e run).
  - Submit tab ("Review your answers") answers `1` = "Submit answers".
  - Permission: options vary ("Yes", "Yes, and always allow…", "Yes, and switch to auto mode",
    "No"); `1` is always "Yes"; `Escape` always rejects.
- Confirmed by the e2e task (Task 10): a digit on a single-question single-select submits at once;
  `Tab` after a single-question multi-select reaches the review step, which still needs `1`.
- Every key needed is already in `TMUX_KEYS` (`1`–`9`, `Tab`, `Enter`, `Escape`, `Down`): no protocol change.

## 4. Capture (machine → server)

### 4.1 Hook script (`packages/machine-ops/src/hooks.ts`)

- `CLAUDE_HOOK_EVENTS` gains `PermissionRequest`. Our script prints nothing, which Claude Code reads
  as "no decision" — the hook never allows or denies (a script test pins empty stdout).
- `PreToolUse` with `NAME = AskUserQuestion`: the **whole event** is forwarded as-is (like `Stop`
  and `Notification` already are) and the dedupe marker is skipped (two questions in a row are two
  questions). The server keeps only `tool_use_id` and `tool_input` and drops the rest.
- `PermissionRequest`: reduced on the machine exactly like `PreToolUse` today —
  `{"hook_event_name":"PermissionRequest","tool_name":"<NAME>"}`, never its input. When `NAME` is
  `AskUserQuestion` it is dropped (the `PreToolUse` already carried it).
- Privacy rule amendment (agent-activity spec §"The server never receives a tool's input"): the one
  exception is `AskUserQuestion`, whose input is text written *to be shown to the user*. The
  agent-activity spec gets a line pointing here.
- Rollout: SSH machines get the script on "Reinstalar hooks" (Máquinas); agent machines get it
  from a new `@termhub/agent` version (the agent bundles `HOOK_SCRIPT`), then reinstall.

### 4.2 Ingestion (`apps/server/src/monitor/state.ts`, `ingest.ts`)

- `interpretClaude` `PreToolUse`: unchanged state (`working`), plus — when the tool is
  `AskUserQuestion` and `tool_input` parses (zod: 1–4 questions, 2–4 options each, strings capped) —
  a `question` payload on the interpretation. An input that does not parse is dropped silently
  (the tab falls back to the text flow).
- `PermissionRequest` (name only): interpretation `waiting_permission` with a `question` of kind
  `permission` carrying `tool_name`. Its state effect is the same as the `permission_prompt`
  notification that follows.
- The ingest step hands any `question` to the tab-question service (§5) after the tab row is
  updated; every other event of the same tab closes its open question (§5.2).

## 5. Tab questions (server)

### 5.1 Table `tab_questions`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `newId()` |
| `tab_id` | text | not a FK (tabs come and go) |
| `project_id` | text FK → projects, cascade | the tab's project |
| `conversation_id` | text FK → chat_conversations, cascade | where it was pushed |
| `kind` | text | `choice` \| `permission` |
| `payload` | jsonb | `choice`: `{ questions: [...] }` normalised (§5.4); `permission`: `{ tool_name }` |
| `tool_use_id` | text, nullable | `AskUserQuestion` only |
| `status` | text | `open` \| `answered` \| `answered_in_tab` \| `expired` \| `failed` |
| `answer` | jsonb, nullable | `choice`: `{ answers: [{ selected: number[], text?: string }] }`; `permission`: `{ allow: boolean, text?: string }` |
| `error_code` | text, nullable | when `failed` |
| `answered_by` | text, nullable | user id |
| `answered_at`, `closed_at`, `injected_at` | timestamptz, nullable | |
| `created_at` | timestamptz | |

Index `(tab_id, status)`. Additive migration only (backward compatible: the old container never
reads it). Repository in `db/repositories/tab-questions.ts`.

### 5.2 Lifecycle

- **Open:** on a `question` from ingestion, the tab's open question (if any) is closed as
  `answered_in_tab`, then a new row is inserted in the project's most recent non-archived
  conversation and `tab_question` is published on the chat bus. Tabs without a project, or
  projects without a conversation, create nothing.
- **Close:** the next hook event of that tab that is not the question's own companion
  (`PermissionRequest` / `permission_prompt` notification right after the `AskUserQuestion`)
  closes it: `answered_in_tab` if nobody answered from the chat. A deleted tab closes it `expired`.
  Each close publishes `tab_question_closed`.
- Mirror: when the chat answers, the row goes `answered` first, so the close from the next hook
  event keeps `answered`.

### 5.3 Answer route

`POST /api/chat/tab-questions/:id/answer` (web) and `POST /m/chat/tab-questions/:id/answer`
(mobile), resource `chat`, body validated with zod against the row's kind:

- `choice`: `{ answers: [{ selected: number[] (0-based option indexes), text?: string ≤ 2000 }] }`,
  one entry per question; single-select takes exactly one of `selected` / `text`.
- `permission`: `{ allow: boolean, text?: string ≤ 2000 }` (`text` only with `allow: false`).

Steps: load through scope (the row's tab via `scoped(...).tab`) → row must be `open` and the tab's
latest open question, else `409 TAB_PROMPT_CHANGED` → live check: capture the screen and require the
first question's text (`choice`) or "Do you want to proceed?" / the tool name (`permission`) to be
visible, else `409 TAB_PROMPT_CHANGED` → claim the row (`open → answered`, conditional update, so a
double click sends once) → send the key plan (§5.4) → on failure mark `failed` with the code.
Publishes `tab_question_answered`. Logs only ids, kind and counts.

`requirePinFor(kind, answer)` returns `false` today; the mobile route calls it before sending, so
turning the PIN on for `permission` + `allow` is a change in that one function plus the app's
proof flow (same `decisionProofMessage` pattern as action decisions).

### 5.4 Key plan (pure, `chat/tab-question-keys.ts`)

Input: normalised payload + answer. Output: a list of steps `{ key }` / `{ text }` for
`sendKey` / literal typing (no Enter). Rules from §3:

- per question i: single-select → digit `selected+1`; multi-select → digit per selected index, then
  `Tab`; free text on a single-select → digit `options.length+1`, `{ text }`, `Enter`; free text on
  a multi-select → `Down` × `options.length`, `{ text }`, `Tab`, `Enter`.
- after the last question, when there are 2+ questions or the last one is a multi-select: `1`
  (Submit tab).
- permission: `allow` → `1`; deny → `Escape`, then, with `text`, `{ text }` + `Enter` (Claude is
  back at its prompt after the rejection).
- Options beyond 9 are impossible (Claude Code caps at 4); the zod schema rejects them anyway.

Normalisation: a label ending in `(Recommended)` becomes `{ label: "Blue", recommended: true }`.
Steps are sent with the existing short pause between keys; the free text goes through the same
literal send used by `sendInput` (bracketed paste), bypassing its `WAITING_PERMISSION` guard on
purpose (this *is* the answer to the prompt).

### 5.5 Concierge context

`service.startIn` prepends answered, not-yet-injected questions of the conversation to the user's
turn: "Enquanto isso: a aba «X» perguntou «…»; o usuário respondeu «…»." and stamps `injected_at`.
`project-prompt.ts` gets one line: questions from tabs appear to the user as cards; do not relay
them as text nor answer them with `send_key` while such a card is open.

## 6. Clients

### 6.1 Contract

`GET /api/chat/conversations/:id` and the mobile `GET /m/chat/...` return `tab_questions` alongside
messages/actions/grants. New bus events (also in `packages/mobile-api/src/events.ts`, enforced by
the parity test): `tab_question` (row), `tab_question_answered`, `tab_question_closed`. Push
notification on `tab_question` (same channel as `confirmation`).

Live excerpt for permission cards: `GET /api/chat/tab-questions/:id/screen` (and mobile mirror)
returns the last ~20 non-blank lines of the pane while the row is `open`; 409 otherwise.

### 6.2 Web (`apps/web/src/components/chat/TabQuestionCard.tsx`)

In the timeline by `created_at`, like action cards. `choice`: the tab name, one section per
question (a tab strip when 2+), options as radio (single) or checkbox (multi) with description, the
recommended option highlighted ("Recomendada"), a "Outra resposta" text field, and "Responder".
`permission`: "A aba «X» pede permissão para usar «Bash»", the live excerpt (monospace, collapsible),
buttons "Permitir" / "Negar" and "Negar e dizer…" (text field). After answering: read-only summary
and state ("Respondida", "Respondida na aba", "Expirada", "Falhou — …"). Errors `TAB_PROMPT_CHANGED`
show "A pergunta mudou na aba".

### 6.3 Mobile

Same card in `apps/mobile/src/features/chat/view/tab-question-card.tsx`; store actions in
`createChatStore`; event reducer; timeline merge; API client; mock handlers. No PIN.

## 7. Testing

- `machine-ops`: hook-script tests — AskUserQuestion forwards the event unchanged and skips the
  dedupe; PermissionRequest is reduced to the name; AskUserQuestion's PermissionRequest is dropped;
  stdout stays empty.
- Server unit: payload normalisation (fixtures), key plan (every rule in §5.4), interpretation of
  the new events, lifecycle (open/close/answered_in_tab/expired), answer route (scope, stale,
  double click, failure), concierge injection.
- Web and mobile component tests for both kinds and every state.
- Manual e2e on jarvis in an isolated tmux (`-L th-*`): a real `AskUserQuestion` (single, multi,
  multi-question, free text) and a `Bash` permission answered through the route.

## 8. Out of scope

- Remembering decisions and answering alone (TER-57 builds on `tab_questions`).
- Codex / Cursor prompts (no equivalent hook data).
- Parsing screens of machines with the old hook script.

## 9. Adjustments found while planning

- Routes: the conversation read is `GET /api/chat?project=`; the mobile mirror lives under
  `/api/m/v1/chat/...` (not `/m/chat/...`).
- Columns use Prisma's `TIMESTAMP(3)` like every other table; a second index
  `(conversation_id, created_at)` serves `GET /chat`.
- `tabs.project_id` is required, so "tabs without a project" does not occur.
- Push keeps notification kind `confirmation` with `data.kind = 'tab_question'` (the mobile-api
  notification enum is closed; a new kind would break older apps).
- Closing: every `Notification` is exempt (an `idle_prompt` reminder must not close an open question).
- Live check is anchored to the dialog the tab shows now: the last non-blank line of the capture
  must contain the dialog footer "Esc to cancel", and the marker must appear within the last 25
  non-blank lines — the first question's text for a choice, "Do you want" (only) for a permission
  (Claude Code also asks "Do you want to make this edit…?"; the tool name alone does not count).
- Answer text is one line without control characters; a deny text starting with `!` or `/` is
  rejected (after `Escape` it lands at Claude's prompt, where `!` runs bash and `/` a slash command).
- After the keys are sent, recording or announcing the result is best effort: a db/bus error there
  never changes the HTTP result (the send error, if any, is kept).
- Keys are sent with a new `KEY_STEP_PAUSE_MS = 150` between steps (no such pause existed).
- Agent machines: the agent's `heal()` rewrites the script and merges the new settings entry on
  reconnect, so they need no manual reinstall after updating the agent.
- "Exactly one of selected / text" applies to every question, not only single-select.
- Found in the e2e run (Claude Code 2.1.282): `AskUserQuestion` no longer fires `PermissionRequest`
  (only `PreToolUse` and the `permission_prompt` notification), so dropping it is only a safeguard;
  the key plan gained the lone multi-select review step and the multi-select free-text rule (§3, §5.4).
