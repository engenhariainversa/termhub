---
symptom: "Claude Code in auto mode: \"This shell -c script runs rm and could not be checked … Claude Code will automatically block this request in 1:56, to avoid holding up an unattended session\"; no card in the chat and the request was blocked by the timeout"
tags: [claude-code, auto-mode, permission, tab-questions, monitor]
evidence: fixed
card: TER-1210
agent: claude
date: 2026-11-25
---
## Cause

Not the hook. Claude Code 2.1.331 fires `PermissionRequest` (tool `Bash`) and then `Notification`
`permission_prompt` for this dialog, the same as for any other one (reproduced in a throwaway `th-` tmux
session with `--permission-mode auto` and a logging hook). The server opened the card (prod log
`tab question opened`, 23:00:58), and the next `PreToolUse`, right after Claude Code refused the request at
the end of its 2-minute countdown, closed it as `answered_in_tab`. The person opened the chat hours later:
by then `list_tab_questions` was empty. "No card" really meant "card gone".

What was missing was an answer: only tabs with an automatic run had their permissions answered by the
server; a manual tab's card waited for the person, and an auto mode dialog does not wait.

The dialog is Claude Code's own safety check (`removalRule: inline_shell_unchecked`, `classifierApprovable:
false`): auto mode's classifier is never asked, so no allow rule in Claude Code's settings covers it. Its only
on-screen mark of auto mode is the countdown line; the same dialog in manual mode has none.

## Fix

`chat/auto-mode-permission.ts` reads the Bash dialog and its command off the screen (the hook sends only the
tool name) and judges it against the hard lock; `chat/auto-mode-answer.ts` answers "Yes" through the normal
card path (`via: 'auto_mode'`) for a person on "liberado por padrão", re-checking the same screen read just
before typing. Wrapped rows are read twice (rows glued, and joined with a space), because a capture cannot tell
a row cut inside a word from one cut at a space. A command must pass in both readings.

## How to check

`npx vitest run src/chat/auto-mode` (captures in `chat/fixtures/permission-dialogs/claude-*-unchecked*.txt`).
In production, the log line `auto mode permission allowed` (or `… left to the person` with a `reason` code)
follows `tab question opened` within a few seconds, and the card shows "Aprovada no auto mode".
