# Tab questions and suggestions: hardening (TER-83) and suggestion context (TER-96) — design

Card: **TER-83** (epic TER-1 · Chat), with subtask **TER-96**. Builds on
`2026-09-25-chat-tab-questions-design.md` (TER-56) and `2026-09-25-tab-suggestions-design.md` (TER-82).
Subtasks are listed in the implementation plan (`docs/superpowers/plans/2026-09-26-tab-questions-hardening.md`).

Project rule: everything the chat does must work in the mobile app too, in the same delivery.

## 1. Problem

The TER-56 and TER-82 reviews deferred a list of items. None of them blocks: each fails safe, and the
person can still answer in the tab. TER-96 is a new report: a suggestion card shows only the text
Claude Code suggests ("C, pode seguir"), without the agent message it answers. Without that message the
person cannot tell what the suggestion approves.

## 2. Decisions

Decided by the implementer on the requester's instruction ("siga até o fim sem perguntar, decida pela
sua recomendação e registre as decisões"), 2026-09-26.

| Topic | Decision |
|---|---|
| Scope | Every item of TER-83 plus TER-96. The items marked "document/evaluate" were investigated first (§3); they become code only where the investigation found a cheap, safe fix. |
| Subagents closing cards | Fix it. The hook script flags subagent events, and a subagent's event never closes a card (§4.5). |
| Old Claude Code and `PermissionRequest` | Document only, no code (§4.6). |
| Dead card after blue/green | Close on the next attempt to use the card, and sweep rows whose tab no longer exists (§4.7). |
| `pending_confirmations` | Also counts open questions (`choice`, `permission`). Suggestions are not counted. The field name and the app's label stay the same (§4.9). |
| Old agents and suggestions | Skip the capture on agents older than 0.5.2 (§5.5). |
| New-session placeholder | Never a suggestion card. `read_screen` still marks it `⟦…⟧`, and the prompt explains it (§5.6). |
| Suggestion context (TER-96) | Stored with the suggestion: the tab's `state_text` at the time of the check, which is the `Stop` event's `last_assistant_message`. No screen excerpt (§6). |
| `state_text` overwritten by `idle_prompt` | Fixed as part of TER-96: a continuation keeps the text the wait already has (§6.1). |

## 3. What was verified (2026-09-26, Claude Code 2.1.283 on jarvis)

- **Changelog** (`anthropics/claude-code` `CHANGELOG.md`):
  - The `PermissionRequest` hook exists since **2.0.45**.
  - Before **2.1.122**, a malformed hooks entry in `settings.json` invalidated the entire file.
  - `agent_id` / `agent_type` reach hook events for subagents since **2.1.69**.
  - `last_assistant_message` reaches `Stop` since **2.1.47**.
- **Subagent capture.** A `claude -p` run with a logging hook, through `--settings`, in a scratch dir:
  - The subagent's `PreToolUse` carries `agent_id` and `agent_type`. Both come before
    `hook_event_name`: the key order is `session_id, transcript_path, cwd, prompt_id, permission_mode,
    agent_id, agent_type, hook_event_name, tool_name, tool_input, tool_use_id`.
  - The main thread's events have no `agent_id`.
  - The subagent ends with `SubagentStop`, which we ignore.
  - The main `Stop` carries `last_assistant_message`, `stop_hook_active` and `background_tasks`.
- **Placeholder capture.** A new interactive session in an isolated tmux (`-L th-probe83`):
  - The prompt line is `ESC[39m❯` + NBSP + `ESC[2m` + `Try "create a util logging.py that..."` + `ESC[0m`,
    so the placeholder is dimmed like a suggestion.
  - The workspace-trust dialog also uses `❯` (coloured, not dim) for its selected option.
  - The fixture is saved as `apps/server/src/chat/fixtures/tab-suggestions/screen-placeholder.{ansi,txt}`,
    trimmed to the input box.
- **TER-96's empty `state_text`.** In the reported cases the text was "Claude is waiting for your
  input". That is the `Notification idle_prompt` message, which arrives about a minute after the `Stop`
  and replaced the `Stop`'s `last_assistant_message` (`TabsRepository.recordEvent` keeps the old text
  only when the continuation has none).

## 4. TER-56 items

### 4.1 Permission queue under one lock

- `TabQuestionsRepository.closeForTab`:
  - Keeps its cheap pre-check outside the transaction.
  - Inside the transaction, first locks the tab row (`SELECT … FROM "tabs" WHERE id = … FOR UPDATE`,
    the same statement `open()` uses), then closes and clears the `QUEUED` mark.
  - A shared private helper `lockTab(tx, tabId)` serves both methods.
- The no-conversation path of a question event goes through the same queue rules as `open()`:
  - `open()` accepts `conversation_id: null`. It then applies the lock, the queue marking and the
    close, and inserts nothing (`question: null`).
  - `openTabQuestion` calls it instead of `closeTabQuestions(…, { endsQueue: false })`.
  - `CloseForTabOptions.endsQueue` goes away if nothing else uses it.
- Result: a permission that arrives while another is open marks the open one `QUEUED`, even when the
  project has no conversation, so a conversation created mid-queue does not open a card for the third
  prompt.

### 4.2 `QUEUED` stays on the server

`toTabQuestionView` maps `error_code === 'QUEUED'` to `null`. The mark is internal bookkeeping: clients
read `error_code` only for `failed`, and the wire no longer carries it. There is no schema change.

### 4.3 Indexes

A new migration `20260926120000_tab_questions_indexes`:
- `CREATE INDEX "tab_questions_tab_id_created_at_idx" ON "tab_questions"("tab_id", "created_at")`,
  mirrored by `@@index([tabId, createdAt])` in `schema.prisma`. It serves the "newest row of the tab"
  reads.
- `CREATE INDEX "tab_questions_queued_tab_id_idx" ON "tab_questions"("tab_id") WHERE "error_code" = 'QUEUED'`.
  It serves the per-event pre-check. The index lives only in the migration, with a `///` note on the
  model, the same pattern as `chat_grants_one_active_per_tab`.

Both are additive, so the previous release keeps working.

### 4.4 Choice free text refuses `!` and `/`

The free text of a choice answer gets the same rule as the deny text and the suggestion text: after
trim, it cannot start with `!` or `/`. One shared zod schema, `typedText`, in `tab-question-payload.ts`
serves all three. This is defence in depth: the choice text is typed into Claude Code's dialog field,
not into its prompt.

### 4.5 Subagents do not close cards

- **Hook script** (`HOOK_SCRIPT`):
  - For every Claude event it checks whether the part of the payload before the first
    `"hook_event_name"` contains the key `"agent_id":`. A value that holds that text would have escaped
    quotes, and only a key is followed by `:`.
  - The reduced `PreToolUse` and `PermissionRequest` bodies gain `"subagent":true`. An `AskUserQuestion`
    `PreToolUse` travels whole and already carries `agent_id`.
  - The dedupe marker is unchanged.
- **Server:**
  - `interpretClaude` puts `subagent: true` in `meta` when `ev.subagent === true` or `ev.agent_id` is a
    non-empty string.
  - `closesOpenQuestion` returns `false` for such an event. This is the final rule (see §10): a scoped
    close (`closingScope` / `payload.subagent`) was tried and reverted — `meta.subagent` is a boolean, so
    it cannot tell one subagent from another in a run with several running at once.
  - The tab state still updates (`working`), as today.
  - A subagent's `PermissionRequest` or `AskUserQuestion` still opens a card: the dialog is real and
    shown in the tab.
- **Consequence (final rule, see §10):** a subagent's event never closes a card, its own included. After
  the person answers a subagent's permission in the tab, that card stays open — and counts as a pending
  confirmation — until the main thread's next closing event; a later permission from the same run (or
  another subagent of it) is answered in the terminal with no card, effectively queued behind the stale
  one. This is the accepted, safe-side limitation: an answer from the stale card still fails the live
  check (409 `TAB_PROMPT_CHANGED`) and closes it.
- **Rollout:**
  - A new `@termhub/agent` patch version bundles the script. `heal()` rewrites the script on reconnect.
  - SSH machines get it on "Reinstalar hooks".
  - An old script sends no flag and keeps today's behaviour.

### 4.6 Old Claude Code without `PermissionRequest` — documented, no code

- **Who is affected:** only a Claude Code older than 2.0.45 (November 2025). Such a version could reject
  the hooks block, or, before 2.1.122, the whole `settings.json`.
- **Why no code:**
  - Claude Code updates itself by default.
  - Detecting the version on every machine and config dir (SSH and agent, `heal()` included) costs a
    remote `claude --version` per install for a case we have not seen.
- **Where it is recorded:** a comment on `CLAUDE_HOOK_EVENTS` states the minimum (2.0.45) and the
  reason, and this spec records it.

### 4.7 Dead cards (tab removed by another process)

- **On use:** when the answer, send or excerpt routes of a row cannot load its tab through the scope
  (404), the row closes as `expired` (conditionally, while `closed_at` is null), `tab_question_closed`
  or `tab_suggestion_closed` is published, and the 404 is returned as today.
- **Sweep:** at boot and in the existing hourly purge interval, rows with `closed_at IS NULL` whose
  `tab_id` has no `tabs` row are closed as `expired` (status `expired` when `open`; `closed_at` set in
  every case) and published. Repository method `expireOrphans(now)`, one `UPDATE … WHERE NOT EXISTS …
  RETURNING`.

### 4.8 Project prompt line

The concierge never sees the cards, so "while such a card is open" is replaced by what it can see:

> Questions a tab asks (a multiple-choice question or a permission prompt) usually reach the person as
> cards in this chat, which you do not see: do not relay them as text. When a tab is waiting_permission
> or shows such a question, point the person to the card instead of answering with send_key or
> send_input, unless they explicitly ask you to answer it.

`project-prompt.test.ts` pins the new sentence. The prompt stays under its 4000-character cap.

### 4.9 Pending count includes open questions

- **Server:** `ChatService.projectStatuses` adds `tabQuestions.countOpenByConversation(ids)` (groupBy,
  `status = 'open'`, `kind != 'suggestion'`) to `pending_confirmations`. The mobile archived-project rule
  (a project stays listed while something is pending) now also keeps a project with an open question.
- **Web:** `project-chat.tsx` also re-reads on `tab_question`, `tab_question_answered` and
  `tab_question_closed`.
- **Mobile:** the chat list already re-reads on its events; the plan confirms which ones and adds the
  question events where missing.

### 4.10 Tests that were weak or missing

- **Hook script "dropped" cases** (`hook-script.test.ts`): instead of `sleep(300)` and "no log", each
  runs a sentinel event afterwards and asserts that only the sentinel was posted.
- **Never throws:** `noteHookEvent` gets two more cases: the closing path (`closeForTab` rejects) and the
  no-conversation path.
- **Expiry test:** `vi.waitFor` replaces the 10 ms `setTimeout`.
- **`CHAT_BUSY`:** a new test pins that a start refused as busy neither reads (`listToInject`) nor marks
  (`markInjected`) answered questions.
- **`stopTabSuggestions`:** a scheduled check does not run after it (fake timers).

### 4.11 Concierge context sanitising

The "Enquanto isso" sanitiser (`tab-question-context.ts`) also replaces the following with a space
before collapsing whitespace:
- C1 (`\u0080-\u009f`);
- bidi and format controls (`؜`, `​-‏`, `‪-‮`, `⁠-⁩`, `﻿`);
- U+2028 / U+2029, already covered by `\s` and now listed explicitly.

### 4.12 Accessibility

- **Web `TabQuestionCard`:**
  - Each tab gets an `id` and `aria-controls`; the question's fieldset becomes `role="tabpanel"` with
    `aria-labelledby`; only the selected tab is in the tab order.
  - Each option input gets an `aria-label` ("Blue, recomendada" for the recommended one) and an
    `aria-describedby` pointing at its description.
- **Mobile `tab-question-card`:**
  - The question tabs report `accessibilityState={{ selected }}`.
  - The options' `accessibilityLabel` includes "recomendada" and an `accessibilityHint` carries the
    description.

### 4.13 Mobile: per-card busy and errors

- **Store:** `createChatStore` keeps per-id errors (`questionErrors`, `suggestionErrors`) alongside
  `answeringQuestionId` and `busySuggestionId`. A 409 `TAB_PROMPT_CHANGED` (and any other answer/send
  failure) goes to the card's error, not the global banner.
- **Screen:** it passes `busy={answeringQuestionId === q.id}` and `error` to each card, like the web
  `ChatPanel`.
- **Cards:** both mobile cards render the error inside the card.
- **Concurrency:** answering two different cards at once is allowed (the web allows it). The same card
  cannot be sent twice.

## 5. TER-82 items

### 5.1 C1 control characters

- **Refused** (validation): the answer and suggestion text (`answerText` / `typedText`).
- **Stripped** (sanitisers): `cleanSuggestion`, `renderStyled`'s printable filter (which also drops
  `\x9b`, the 8-bit CSI), and the context sanitiser (§4.11).
- One exported regex `CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/` in `tab-question-payload.ts` is reused
  where the rule is the same.

### 5.2 ANSI parser

`ESCAPE` in `terminal/ansi.ts` gains:
- an unterminated CSI alternative (`\x1b\[[0-?]*[ -\/]*`, tried after the complete one), which consumes
  `ESC[31` at the end of the input;
- a fallback that never swallows an ESC (`\x1b[^[\]\x1b]?`), so `ESC ESC[2m` keeps the second escape
  and dim is still recognised.

Tests cover the three examples: truncated CSI at the end, double ESC, and a CSI interrupted by another
CSI.

### 5.3 `cleanSuggestion` never splits a surrogate pair

After the 2000-unit slice, a trailing lone high surrogate is dropped. The same helper
(`sliceUnits(text, max)`) caps the new context text (§6).

### 5.4 `stopTabSuggestions` test

Covered in §4.10.

### 5.5 Old agents skip the suggestion capture

- `STYLED_CAPTURE_MIN_AGENT_VERSION = '0.5.2'`.
- `checkTabSuggestion` returns before any RPC when the machine is an agent whose
  `agents.info(id)?.agent_version` is known and older (`versionAtLeast`).
- An unknown version still tries, as today, and the `styled: false` answer still opens nothing.

### 5.6 The new-session placeholder

- `promptSuggestion` returns `null` when the dim text is `Try "…"` (`/^Try ".*"$/`). A real suggestion
  never has that shape, and the placeholder never becomes a card.
- `read_screen` keeps marking it `⟦…⟧`: it is dimmed text.
- The prompt line about `⟦…⟧` gains: "a dimmed `Try "…"` in an empty prompt is Claude Code's
  placeholder, not a suggestion — do not mention it".
- Tests use the real fixture (§3).

## 6. TER-96 — the suggestion card shows what it answers

### 6.1 `state_text` keeps the agent's last message

`TabsRepository.recordEvent`: a continuation (`continuesWait`, i.e. Claude's `idle_prompt` after its
`Stop`, or Cursor's `stop` after its answer) keeps the wait's current `state_text` when it has one, and
uses its own text only when the wait has none. Claude's `idle_prompt` no longer replaces the `Stop`'s
`last_assistant_message` with "Claude is waiting for your input", so `list_tabs` / `wait_for_state`
return the agent's message.

### 6.2 Storage

- A suggestion row's payload becomes `{ text, context }`. `context` is the tab's `state_text` read in
  `checkTabSuggestion`, which runs 5 s after the `Stop`; any hook event in between cancels the check,
  so the text is that `Stop`'s message.
- `context` is sanitised: newlines kept, every other C0/C1 and bidi/format control removed, runs of
  more than two blank lines collapsed, capped at `STATE_TEXT_MAX` (2000) without splitting a pair. It
  is `null` when the tab has no text or only Claude's generic idle message.
- It is the agent's own message, already stored on the tab and in `tab_events` today. It is not screen
  content and is never logged: logs keep `chars` only.
- A tab whose `Stop` came from a Claude Code older than 2.1.47 has no message, and its card shows no
  context.

### 6.3 Contract

- `TabQuestionView` for a suggestion carries `payload: { text, context: string | null }`.
- `packages/mobile-api` `tabSuggestionSchema.payload` becomes
  `z.object({ text: z.string(), context: z.string().nullable().optional() })`. A new app reading an old
  server sees the field missing; an old app strips it (zod object, not strict).
- Web type `TabSuggestion.payload.context?: string | null`.
- The mock handlers get a context in their sample suggestion.

### 6.4 Cards (web and mobile)

The copy is pt-BR (product language):

- **Title:** "«X» está esperando sua resposta". It replaces "«X» sugere:" while open; closed states keep
  their labels.
- **Context** (when present): the agent's message as plain text in a quoted block.
  - Collapsed, it shows the last paragraph (the text after the last blank line, up to 400 characters,
    with "…" when cut): the question usually closes the message.
  - "Ver mensagem inteira" / "Recolher" toggles the full text.
  - A pure helper `lastParagraph(text, max)` exists in web `tab-suggestion-text.ts` and mobile
    `model/tab-suggestion-text.ts`, with the same tests.
- **Field label:** "Sugestão do Claude Code (opcional — edite ou dispense)".
- **Buttons:** unchanged (Enviar / Dispensar).
- **Closed cards:** they keep the context, collapsed.

## 7. Testing

- **Pure (server):** `ansi.test.ts` (parser cases, placeholder fixture, C1); `tab-question-payload`
  (`typedText`, C1); `tab-suggestions` (surrogate, context cleaning, version skip, stop); context
  sanitiser.
- **Repository, real Postgres** (`tab-questions.db.test.ts`, `TERMHUB_DB_TESTS=1` with a throwaway
  `th-test-db`): `open` with `conversation_id: null` marks `QUEUED` and inserts nothing; `closeForTab`
  under the lock; `expireOrphans`; `countOpenByConversation`; the migration applies.
- **Repository:** `tabs` continuation keeps the text (db test, next to the existing `recordEvent` tests).
- **Service, route and ingest tests** (fakes): no-conversation path, subagent flag in
  `interpretClaude`, `closesOpenQuestion` table, 404 → expired + event, `pending_confirmations`,
  `CHAT_BUSY`, view drops `QUEUED`, suggestion context stored.
- **`machine-ops`:** the hook script flags `agent_id` events, leaves the main-thread events alone,
  ignores `"agent_id"` inside a value, and the sentinel-based drop tests.
- **Web:** `TabQuestionCard` (aria), `TabSuggestionCard` (context collapsed and expanded, no context),
  `project-chat` refresh on question events.
- **Mobile:** store per-card errors and busy, both cards (error, a11y, context), mock.
- **E2E on jarvis** (isolated tmux `-L th-*`, local server stand-in as in TER-82's Task 8, if the setup
  from that plan is reusable): a real `Stop` with a suggestion yields a card whose context is the
  agent's last message; a new session's placeholder yields no card.

## 8. Out of scope

- Remembering decisions (TER-57), batched confirmations (TER-94), grant list (TER-67).
- Showing a live screen excerpt on suggestion cards.
- Gating hooks on the Claude Code version (§4.6).

## 9. Adjustments found while planning

- §4.13: the mobile store tracks busy cards as id lists (`answeringQuestionIds`, `busySuggestionIds`),
  since a single id cannot let two different cards act at once.
- §4.9: the mobile chat list re-reads on focus and pull-to-refresh, not on socket events; the new count
  reaches it from the server, and only the app's mock changes.
- §4.1: with no conversation, a permission that is not queued leaves no row, so a prompt queued behind
  it cannot be recognised if a conversation appears in between. Accepted: it fails safe (the card's
  live check refuses a stale answer). A no-conversation choice clears the `QUEUED` marks, as a choice
  row would.
- §4.7: dead cards close through a new `expireOne` (while `closed_at` is null; an `answered` row keeps
  its status), not `closeOne`, which only matches `open` rows.
- §6.2: the context is only taken when the tab's `state_tool` is `claude`; a tab character becomes a
  space; rows stored before TER-96 have no `context` (optional in the type, `null` in the view).
- §5.6: the placeholder rule also accepts curly quotes (`/^Try ["“].*["”]$/`).
- §4.12: the web tab list gets ←/→ keys and `aria-label="Perguntas"` (WAI-ARIA tabs pattern).
- `@termhub/agent` goes 0.5.2 → 0.5.3 (it bundles `HOOK_SCRIPT`); CI publishes it on merge.

## 10. Adjustments found while implementing

- §4.1: `closeForTab` keeps its pre-check outside the transaction (as specified), so a close for a tab
  with nothing committed yet does not wait on the lock. If an `open()` of that tab is in flight, the new
  card stays until the tab's next closing event. Accepted: the card's live check refuses a stale answer.
- §6.1: the continuation rule is narrower than written above: a continuation keeps the wait's text only
  when it brings no text, or when it is Claude's `idle_prompt` (interpreter flag `keepsWaitText`). Cursor's
  `afterAgentResponse` is also a continuation but carries the fresh answer, which must replace a stale
  text.
- §7 E2E (2026-09-26): the placeholder gave no card and `state_text` kept the agent's message after
  `idle_prompt`; the live "suggestion card with context" step could not run because Claude Code 2.1.283
  drew no suggestion during the test window. That path is covered by unit tests only.
- §4.5 (final review, reverted): a scoped close was tried — `closesOpenQuestion` became `closingScope` →
  `'tab' | 'subagent' | null`, a card opened by a subagent event stored `payload.subagent: true`, and a
  subagent's closing event ran `closeSubagentForTab` to close only those rows. It was reverted:
  `meta.subagent` is a boolean, not an id, so it cannot tell one subagent from another in a run with
  several going at once. With two subagents running, B's closing event closed A's still-open card (both
  are just "a subagent's row"), and B's next permission card could then approve A's dialog — the live
  check only compares "Do you want" plus the footer, which is the same across a run's own tools, so it did
  not catch the mismatch. §4.5's original rule stands: a subagent's event never closes a card, its own
  included. Accepted, safe-side limitation: a stale card from an answered subagent permission stays open
  (and pending) until the main thread's next closing event, and later permissions of the same run are
  answered in the terminal with no card until then. Follow-up: forward the hook's `agent_id` (already read
  for the boolean flag, see §4.5) as a value instead of collapsing it to `subagent: true`, and close or
  queue per `agent_id` rather than per tab.
- §4.7: a card also expires when its tab leaves the person's scope (machine unlinked from the project,
  project owner changed): the 404 path covers scope loss, not only removed tabs. Only a 404 does — a
  transient error loading the tab propagates (`scoped.tab` maps only an `HttpError` from the
  project–machine check to 404), so a DB blip never expires a live card.
