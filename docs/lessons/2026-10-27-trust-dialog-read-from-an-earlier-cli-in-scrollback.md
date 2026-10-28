---
symptom: "A Codex trust dialog was answered as Claude's (feed payload cli: 'claude'); the e2e test expected cli: 'codex'"
tags: [monitor, trust, codex, cursor, gemini, screen]
evidence: fixed
card: TER-1122
agent: claude
date: 2026-10-27
---
## Cause

The screen rules read the last 30 non-blank rows of the pane, and a pane keeps what ran before: Claude Code
answered its trust dialog and exited, then Codex started in the same tab. The rows still held Claude's
"❯ 1. Yes, I trust this folder" above Codex's "Trust this folder?", and Claude's question pattern
(`/trust this folder/i`) matches Codex's question too. The first rule that matched anywhere on the screen won,
so Codex's dialog was read as Claude's with "Yes" selected — had Codex's "Quit" been the selected option, Enter
would have quit it.

Found because the e2e tests reuse tab id `t1` and its tmux session; the same file also showed a second trap:
the 15 s hold against a repeated Enter (`ANSWERED_HOLD_MS`) is per tab id, so a test right after another one
on `t1` was held back until `resetAnsweredForTests()`.

## Fix

`apps/server/src/monitor/trust-dialogs.ts`: among the CLIs' rules, only the dialog whose option row is lowest on
the screen counts, and whether its trust option is selected is read from its own rows only (from its question
down). A test covers Claude's old dialog above Codex's with "Quit" selected.

## How to check

`npm test -w @termhub/server -- trust-dialogs start-agent.e2e` (the e2e needs tmux; unset `CLAUDE_CONFIG_DIR`
first when running inside a Claude Code session, or the Codex test sees it concatenated with `CODEX_HOME`).
