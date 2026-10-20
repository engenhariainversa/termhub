---
symptom: "Tab chat (web and app) does not work when the tab runs Codex: \"Só Claude Code por enquanto\", no history, no Conversa switch on the web"
tags: [codex, tab-chat, transcript, hooks]
evidence: fixed
card: TER-1095
agent: claude
date: 2026-10-20
---
## Cause

The tab conversation reads the agent CLI's own session file on the machine, found through the
`session_id` / `transcript_path` its hooks report. Until TER-1095 every layer assumed Claude Code:

- the server answered `unsupported_tool` for any `state_tool` other than `claude` (`tab-chat/reader.ts`),
  and the web hid the Terminal ⇄ Conversa switch for those tabs (`TabBar.tsx`);
- only Claude hook events wrote `agent_session_id` / `agent_transcript_path` (`monitor/ingest.ts`), although
  Codex's hooks send the same pair (the path is `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`);
- the agent's `transcript.read` refused any path that is not `<dir>/projects/<slug>/<id>.jsonl`;
- the file is another format: JSONL with `session_meta`, `event_msg`, `response_item`, `turn_context`…
  lines. The conversation is in the `event_msg` lines (`item_completed` with `UserMessage`,
  `AgentMessage`, `CommandExecution`, `FileChange`; `turn_aborted` on Esc). The `response_item` lines
  also carry the instructions Codex injects into the model (`developer` and `<environment_context>`
  messages), so they must not be shown.

On top of that, Codex runs its hooks only after the person trusts them in Codex ("Hooks need review").
Without that trust (the case on jarvis), no event carries the session, so the conversation stays empty
even with everything above fixed; `notify` still runs but has no transcript path.

## Fix

Agent 0.31.0 reads Codex rollouts (capability `transcript.codex`, path checked by
`isCodexTranscriptPath`); the server records the Codex session from its hooks, reads it with
`parseCodexLines` (`tab-chat/codex-transcript.ts`) and, for a Codex tab with no session on a machine whose
Codex does not trust the hooks, answers `empty_reason: codex_untrusted`, which the app and the web turn
into "trust the hooks" instructions. Sending needed no change: the same paste + Enter submits in Codex.

## How to check

On a machine with agent 0.31.0 and trusted Codex hooks, open a Codex tab as a conversation and send a
message: the prompt, Codex's messages and its commands appear. `get_machine_hooks` shows
`codex.trusted: "all"`. With untrusted hooks the conversation explains how to trust them.
