---
symptom: "Chat: a granted action card (\"Executed · trusted tab\") shows after the concierge's answer, though the call ran before it"
tags: [chat, timeline, mobile, web]
evidence: fixed
card: TER-984
agent: claude
date: 2026-10-05
---
## Cause

The chat thread (`apps/web/src/lib/chat-timeline.ts`, copied in `apps/mobile/src/features/chat/model/timeline.ts`)
orders messages and gate cards by time only. The assistant's row is created **empty when its turn
starts** (`addMessage({ role: 'assistant', text: '' })` in `chat/live-run.ts` / `chat/service.ts`) and
its text is filled in later with `updateMessage`, which never changes `created_at`. Every card the
turn makes is therefore newer than its own answer and sorts after the whole bubble. `chat_actions.message_id`
exists but is never filled in, so the client cannot link the card to its turn either.

## Fix

The timeline anchors a card that ran under a grant (`grant_id` set; written once by `insertApproved`,
so it never flips) to the latest message at or before it: when that message is an assistant answer,
the card sorts just before it (calls of the same turn keep their own order). Pending and click-decided
cards, and surfaced ones (`surfaced_at`), keep their own time. Granted cards also render as one
compact line that expands on a click/tap.

## How to check

`npx vitest run src/lib/chat-timeline.test.ts` in `apps/web` and `npx jest src/features/chat/model/timeline.test.ts`
in `apps/mobile`: the "actions that ran without asking (TER-984)" cases.
