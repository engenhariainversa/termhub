# Tab suggestions: the concierge stops mistaking them for typed text, and the chat offers them — design

Card: **TER-82** (bug, epic TER-1 · Chat). Subtasks are listed in the implementation plan
(`docs/superpowers/plans/2026-09-25-tab-suggestions.md`).

Project rule: everything the chat does must work in the mobile app too, in the same delivery.

## 1. Problem

Claude Code shows a *suggested next prompt* in its input box, dimmed (e.g. `❯ commit it`). The
concierge's `read_screen` returns plain text (`tmux capture-pane -p`), where a dimmed suggestion and
text the person actually typed are identical. A customer asked for the state of their tabs and the
concierge said three tabs had "a message typed and not sent" — all three were suggestions. Worse, the
concierge could offer to "press Enter" on them, running something nobody asked for.

The suggestion is also useful: the person may simply want to send it.

## 2. Decisions

| Topic | Decision |
|---|---|
| Fix | Capture with attributes (`capture-pane -e`) for the concierge's `read_screen`; dim runs become `⟦…⟧`; the tool description and the project prompt say `⟦…⟧` is dimmed text (a suggestion or a hint), never typed, and never a reason to press Enter. |
| Concierge behaviour | It may mention a suggestion ("o Claude sugere `…`; quer que eu envie?"); sending it goes through the normal gate (or a tab grant). |
| Old agents | They keep returning plain text; the prompt also says "text in a prompt can be a suggestion". |
| Suggestion card | New: when a tab stops and waits for input with a dimmed suggestion in its prompt, a card "«tab» sugere:" appears in the project's most recent conversation, with the text in an **editable** field and **Enviar** / **Dispensar**. |
| Push | None for suggestions (noise). |
| Sending | One click, no gate card, no PIN; requires `terminals:write`; live check first. |
| Other captures | Unchanged, plain text (TER-56 live check, settle-by-screen, hook spinner). |

## 3. What Claude Code shows (captured 2026-09-25, Claude Code 2.1.282)

Fixtures in `apps/server/src/chat/fixtures/tab-suggestions/` (from an isolated tmux `-L th-dim`):

- Suggestion: the prompt line is `❯ ` then `ESC[2m` + `commit it` + `ESC[0m` (SGR 2 = dim).
  Plain capture: `❯ commit it`.
- Typed text: `❯ roda a migration`, no SGR attribute on the text.
- The suggestion appears shortly after the turn ends (after the `Stop` hook).

## 4. Styled capture (server + agent)

- `captureStyledScreen(machine, session, lines)` in `apps/server/src/agent/screen.ts`: SSH/local
  machines run `capture-pane -p -e …`; agent machines call `tmux.capture` with a new optional
  `escapes: true` param (agent-protocol + agent, `@termhub/agent` 0.5.2). An agent that ignores the
  param returns plain text — the result carries `styled: boolean` so callers know.
- `renderStyled(ansi)` (pure, `apps/server/src/terminal/ansi.ts`): parses SGR sequences, drops every
  escape, and wraps each maximal run of dim (SGR 2, cleared by 0 or 22) non-blank text as `⟦…⟧`
  (trailing spaces inside a run stay outside the brackets). Other escapes (colours, cursor) are dropped.
- `promptSuggestion(ansi)` (pure): finds the last line starting with `❯` (after optional spaces);
  returns the dim text when the rest of that line is only dim text (whitespace allowed), else null.
  Returns null when anything non-dim is typed.

## 5. Concierge fix

- `readScreen` (MCP `read_screen`) uses the styled capture and `renderStyled`; the result gains
  `styled: boolean`. Not logged (as today).
- Tool description (`mcp/tools.ts`) and `project-prompt.ts`: `⟦…⟧` is dimmed text — usually Claude
  Code's suggested next prompt — the person did not type it; never report it as an unsent message,
  never send Enter because of it; you may mention it as a suggestion. When `styled` is false, text
  after `❯` may be a suggestion too.

## 6. Suggestion cards

### 6.1 Storage and lifecycle

- Reuse `tab_questions` with a new `kind = 'suggestion'` (plain text column: no migration), `payload = { text }` (≤ 2000 chars, one line, control chars stripped).
- Trigger: after ingesting a Claude `Stop` event (tab → `waiting_input`) for a tab whose project has
  a conversation (same owner rule as TER-56), wait `SUGGESTION_DELAY_MS = 5000`, capture styled (last
  15 lines), and if `promptSuggestion` finds text, open a suggestion row. The wait is fire-and-forget
  (never delays the hook POST); if any hook event of the tab arrives meanwhile, nothing opens.
  Machines whose capture is not styled (old agent) never get suggestion cards.
  A suggestion starting with `/` or `!` opens no card: Claude Code does suggest slash commands
  (`/compact` was seen live), and sending refuses both (§6.2), so such a card could only fail.
- A suggestion never takes part in the permission queue rules and never closes an open choice or
  permission question (there is none after `Stop`).
- Closing: like other questions, the tab's next closing hook event closes it (`answered_in_tab`);
  **Dispensar** closes it as `dismissed` (new status value) without touching the tab.

### 6.2 API (kept apart from `tab_questions` so older apps keep parsing)

- `GET /api/chat?project=` and `GET /api/m/v1/chat/...`: `tab_questions` excludes suggestions; a new
  `tab_suggestions` array carries them.
- Bus events: `tab_suggestion`, `tab_suggestion_closed` (answered, dismissed or closed) — added to
  `packages/mobile-api` (parity test) with their own schema.
- `POST /api/chat/tab-suggestions/:id/send` `{ text }` (web + mobile mirror): `terminals:write`;
  row open and the tab's latest; live check — styled capture, `promptSuggestion` still returns the
  same text (else `409 TAB_PROMPT_CHANGED` and the row closes as `answered_in_tab`); atomic claim;
  then type `text` literally and press Enter (`sendInput` with the same guards as TER-56: one line,
  no control chars, ≤ 2000, not starting with `!`). Logs: ids and counts only.
- `POST /api/chat/tab-suggestions/:id/dismiss` (web + mobile).

### 6.3 Concierge context

Sent suggestions join the "Enquanto isso: …" context of TER-56 ("a aba «X» sugeria «…»; o usuário
enviou «…»"), sanitised the same way. Dismissed ones are not reported.

### 6.4 Clients

Web `TabSuggestionCard` and mobile `tab-suggestion-card` in the timeline (by `created_at`): "«X»
sugere:", editable text field prefilled, **Enviar** (disabled while sending or empty) and
**Dispensar**; after: "Enviada", "Dispensada", "Respondida na aba", "A sugestão mudou na aba" on 409.

## 7. Testing

- Pure: `renderStyled` and `promptSuggestion` with the real fixtures (suggestion, typed, typed +
  suggestion remainder, no prompt), SGR variants (2 then 22, 0, combined `2;38;5;244`).
- Agent: `tmux.capture` with `escapes` passes `-e`; without it, unchanged.
- Server: styled capture on SSH/local and agent; `readScreen` returns `⟦…⟧`; Stop → delayed capture →
  suggestion row (and not when an event arrives meanwhile, not on unstyled capture); routes (send,
  dismiss, 409 + close, forbidden without terminals:write, double click); GET separation.
- Web and mobile component/store tests.
- E2E on jarvis in an isolated tmux: real suggestion → card → Enviar; typed text → no card.

## 8. Out of scope

- Codex / Cursor suggestions.
- Accepting the suggestion with Tab (we type the text, which also allows editing).

## 9. Adjustments found while planning

- TER-56's live check and permission excerpt go through `readScreen`; it takes `{ plain: true }` so
  they stay plain while the concierge's `read_screen` is styled.
- An agent's styled answer is flagged in the RPC result (`escapes: true`); an old agent drops the
  unknown param and answers plain text (`styled: false`).
- Suggestion rows share `tab_questions`, so: closed suggestions are published as their own events on
  every close path; the permission-queue "newest row" lookup skips suggestions; the choice/permission
  answer and screen routes answer 404 for a suggestion id.
- Sending refuses a text starting with `!` or `/` (same rule as TER-56's deny text).
- A failure after the claim marks the row `failed` and answers 502; dismissing an already-closed
  suggestion answers 200 without an event; dismiss needs only chat access (it never touches the tab).
- Every hook event of the tab cancels a pending suggestion check, even events the interpreter ignores.
- The suggestion was seen drawn 1.46–2.80 s after the `Stop`, so the wait is 5000 ms, not 3000.
- Dismissing is best effort past the row update, like sending: a failed announcement is logged by
  code and the dismissed card is still the answer.
