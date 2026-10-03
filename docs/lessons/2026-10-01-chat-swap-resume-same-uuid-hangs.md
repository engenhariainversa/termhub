---
symptom: "Chat stuck on \"pensando\" after \"chat: usage limit, answering on another account\"; the resumed `claude -p` writes nothing"
tags: [chat, account-swap, claude-cli, stream-json]
evidence: fixed
card: TER-837
agent: claude
date: 2026-10-01
---
## Cause

On a usage limit, the streamed chat re-ran the turn on another account by resuming the same session and
writing the same stream-json user line, **with the same `uuid`**. The process that met the limit had already
recorded that message in the session. A resumed Claude Code that reads a user message whose uuid it already has
replays it (`isReplay`) and answers nothing. With `--input-format stream-json` stdin stays open, so the run
waited forever and the conversation stayed busy (no new message could start). Reproduced with
`claude -p --resume <sid> --input-format stream-json --replay-user-messages`: same uuid gives a replay and no
assistant/result; a new uuid gets an answer.

## Fix

`LiveRun.retryElsewhere` gives every waiting turn (and every pending note) a new uuid before the next process
starts, as a server restart already did.

## How to check

`npx vitest run src/chat/live-run.test.ts src/chat/service.test.ts` in `apps/server`. In production, after
`answering on another account` the agent log shows `claude run ended` for the new channel and the answer arrives.
To unblock a stuck one: kill the `claude -p --resume <sid>` child of the termhub agent; the turn ends as a failure.
