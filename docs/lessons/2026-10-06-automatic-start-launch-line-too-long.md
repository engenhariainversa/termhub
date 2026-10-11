---
symptom: "run_blocked { code: LAUNCH_FAILED, stage: start } on every automatic card; server log 'agent rpc params rejected before send' (method tmux.sendText, issues 1); start_agent: 'A aba foi aberta, mas o agente não foi iniciado: Parâmetros inválidos para a máquina'"
tags: [automation, agent, tmux, start_agent, macos]
evidence: fixed
card: TER-987
agent: claude
date: 2026-10-06
---
## Cause

The CLI line typed into a new tab was longer than one `tmux.sendText` RPC carries (`TEXT_MAX_CHARS`, 4000,
checked by the server before sending and by every agent release). An automatic start's line is the prompt
(filled up to `PROMPT_MAX_CHARS`, 4000, with the card description) plus `--permission-mode`, the
`--allowedTools` list, the fixed `--disallowedTools` list added on 2026-10-05 (`ad7b5e99`), the tab MCP
flags and the account prefix: 4.5 KB with no description, 6.5 KB with a long one. So every automatic start
failed on agent machines once the deny list landed; the worktree had been created fine (git, clone and
credentials were not the problem). Manual `start_agent` calls with a prompt above about 2.5 KB hit the same
limit.

Splitting the line into several RPCs is not enough: a fresh tab's shell may still be starting when the line
arrives, and on macOS the tty keeps only about 1 KB of unread input, so a long typed line loses bytes (often
its start) and the shell hangs on an open quote.

## Fix

`typeCommandLine` (`apps/server/src/terminal/session-ops.ts`): a line over `TYPED_LINE_MAX_BYTES` (900) is
written to the machine's paste folder (`file.paste`, present in every agent) and only
`. '<file>'; command rm -f -- '<file>'` is typed. `startAgent` and the account swap use it. The
TER-988 closed the paths that still typed a long line whole: the follower's restart of an agent that exited
(an automatic tab's resume line, with the allow and deny lists, is about 2.5–3 KB: under the RPC cap, past
the ~1 KB a fresh macOS tab keeps) and the chat's resume card ("Enviar", which also refused anything over
2000 characters). Both go through `typeCommandInTab` (`apps/server/src/control/terminals.ts`), which calls
`typeCommandLine`. Any new code that types a shell line starting Claude or Codex must use one of those two,
never `sendInput` / `sendTextToSession`. The `run_blocked` of a failed start now carries `message` / `message_en` (the error's text), `attempt`,
`max_attempts` and `retry_at` (or `untagged`); the feed and the queue (`start_backoff`) show the reason.

## How to check

`list_automation_events` shows `run_started` (not `run_blocked`) for a tagged card and its tab runs Claude;
the tab's shell shows the short `. '…/paste-…-launch.sh'` line. Server log: no
`agent rpc params rejected before send` for `tmux.sendText`.
