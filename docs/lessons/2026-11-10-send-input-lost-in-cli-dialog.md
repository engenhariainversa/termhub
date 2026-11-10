---
symptom: "send_input answers sent: true but the agent never gets the message; the tab sits on \"Teach auto mode about your environment?\" (or Codex \"Hooks need review\") and stays finished / state null"
tags: [monitor, send_input, claude-code, codex, tmux]
evidence: fixed
card: TER-1166
agent: claude
date: 2026-11-10
---
## Cause

A modal dialog of the CLI takes the input over. In Claude Code 2.1.322 the letters typed with tmux
`send-keys` are dropped and Enter acts on the dialog; in Codex 0.159.3 the letters even move the dialog's
selection, so the Enter that follows can pick an option. No hook fires (no UserPromptSubmit), so the tab keeps
the state it had. `sendInput` (`apps/server/src/control/terminals.ts`) only checked `waiting_permission` and
always answered `sent: true`, and the screen sweeps only read `working` tabs (`listStaleWorking`) and tabs that
never reported (only for the trust dialog and the login error). A dialog that opens after the Stop
("Teach auto mode") or before any hook (Codex's hooks review) was seen by nobody.

The same day, Claude Code 2.1.322 also changed its folder trust dialog: options without numbers and
"❯ No, exit" first and selected. The old rule (`1. Yes, I trust this folder`) no longer matched, so that
dialog read as a generic one.

## Fix

`monitor/cli-dialogs.ts` reads the dialog off the screen (title rules per CLI, plus any Claude Code dialog: a
footer hint with no input box). `sendInput` reads the screen first and fails with `CLI_DIALOG_OPEN` naming the
dialog; `sendKey` says which dialog is still open after the key. `sweepDialogs` reads tabs at rest and records
`cli_dialog`; the health watcher alerts after 2 minutes. The Claude trust rule accepts unnumbered options.

## How to check

Start Claude Code in a throwaway tmux session (`th-…`), open `/hooks`, type text and Enter: the prompt box
is empty afterwards. With the fix, `send_input` into such a tab returns `CLI_DIALOG_OPEN`, and
`npx vitest run src/monitor/cli-dialogs.test.ts` passes against the captures in
`apps/server/src/monitor/fixtures/cli-dialogs/`.
