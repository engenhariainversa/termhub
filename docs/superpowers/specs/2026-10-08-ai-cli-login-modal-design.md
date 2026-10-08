# AI CLI re-login through a modal (TER-1047)

When the login of a machine's Claude Code or Codex expires ("Login expired · Please run /login"), the
person redoes it from a modal in the web or the app, without going to the machine or opening a terminal.

## Flow

1. **Detection.** The agent can tell whether an account is logged in (`claude auth status` /
   `codex login status`, run with the account's config dir). The server keeps that per account, in memory
   (5 min cache), and a background check (every 10 min, agent machines that are online and have the
   `ai_login` capability) runs it. When an account goes from logged in (or unknown) to "login required",
   the machine owner gets a push. The web shows a red warning in the sidebar and on the account's card in
   Contas de IA; the app shows a red banner. The `auth_required` tab state (TER-1046) is not merged yet:
   when it lands it calls `markLoginRequired(accountId)`, the same entry point.
2. **Modal "Refazer login"** (account, machine):
   - The server asks the agent (`ai.login.start`) to run the CLI's login in a hidden, dedicated tmux session
     `termhub-login-<loginId>` (never a work tab), with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` set to the
     account's config dir (unset for the machine's default login).
     - Claude: `claude auth login`. It prints `https://claude.com/cai/oauth/authorize?...` and waits at
       `Paste code here if prompted >`.
     - Codex: `codex login --device-auth`. It prints `https://auth.openai.com/codex/device` and a one-time
       code (`ABCD-EFGH1`, valid 15 min), then polls on its own: there is no code to paste.
   - The agent captures the URL (and the device code) from the pane and returns it. The modal shows
     "Abrir página de login" (opens the browser, on the phone too) and, for Codex, the device code.
   - Claude: the person pastes the code into "Cole o código aqui"; the server sends it to the agent
     (`ai.login.submit`), which types it into the hidden session. Codex: the person presses "Já autorizei".
   - The agent polls the CLI's status until it is logged in (or the CLI fails / 45 s pass), kills the
     session and answers ok or error. The modal shows the result.
   - Other providers (Gemini, Antigravity): the modal shows the manual instruction.
3. **After the login.** The server lists the tabs of that account that are stuck on a login error (their
   screen shows "Please run /login", "Login expired", "Not logged in", "authentication_failed"). The modal
   asks "Retomar N abas?"; confirming types `continue` into each. Escalated automatic runs are not resumed
   by this card (follow-up: they need the TER-1046 `auth_required` reason to know which ones).
4. **MCP.** `start_ai_login(account_id)` returns the URL (and device code); `submit_ai_login_code(login_id,
   code?)` sends the code (or, for Codex, just confirms). Both are `irreversible` in the chat gate, so the
   concierge always asks first.

## Security

- The code and tokens are never logged nor persisted. The code travels in memory from the server to the
  agent over the authenticated WebSocket; the agent types it with `send-keys -l` and never returns it
  (any pane line that contains it is dropped from error messages). One exception: when the concierge
  sends it with `submit_ai_login_code`, the chat gate keeps the call's arguments on the confirmation row
  while it is open, because the model is told to repeat the approved call with them. Once the row closes
  (run, failed, denied or expired) the code is replaced by `[redacted]` (`SECRET_ARGS` in chat/gate.ts),
  right away in the gate's execute() and by the hourly sweep for the rest.
- A login flow lives 15 minutes; then the server cancels it (kills the hidden session) and its id stops
  working.
- Only the machine's owner can start or continue a flow (`machine.ownerId === request.scope.user.id`):
  an admin viewing as someone else cannot.
- Exclusive accounts (TER-990): re-login touches the account, not a project; resuming only types into tabs
  that already run on that account, so no project gets an account it may not use.

## Compatibility

New RPCs `ai.login.status|start|submit|cancel` and capability `ai_login` (agent 0.25.0). Older agents
are never sent them: the server answers 409 `AGENT_OUTDATED` and the UI says to update the agent. SSH
and local machines are not supported (the button is not shown). Flows live in the memory of the server
color that started them; a deploy in the middle of a flow loses it (the person starts again).

## Impact on other users

New, opt-in feature: nothing happens until someone presses "Refazer login". The only thing every user
with an agent machine gets by default is the red warning and one push when an account's login expires —
which is the moment they would want to know.
