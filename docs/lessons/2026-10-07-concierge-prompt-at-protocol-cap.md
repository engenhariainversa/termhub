---
symptom: "concierge-prompt.test.ts: fits the protocol cap with the longest project prompt — expected 8253 to be less than or equal to 8000"
tags: [chat, concierge, prompt, mcp]
evidence: fixed
card: TER-1038
agent: claude
date: 2026-10-07
---
## Cause

`ORCHESTRATOR_PROMPT` (`apps/server/src/chat/concierge-prompt.ts`) plus the longest project prompt must
fit the agent protocol's 8000-character `append_system_prompt` cap, and in October 2026 it already sat
about 10 characters under it. One more rule line (here, "call get_chat_context when asked about
context") pushed it past.

## Fix

Do not add the line to the prompt. Put the "when to call it" guidance in the new MCP tool's
`description` (`apps/server/src/mcp/tools.ts`): the concierge reads tool descriptions too, and they
do not count toward the cap. Only add to `ORCHESTRATOR_PROMPT` what no tool description can carry,
and shorten another line in the same change when you do.

## How to check

`DATABASE_URL=postgresql://x:x@127.0.0.1:1/x npx -w @termhub/server vitest run src/chat/concierge-prompt.test.ts`
passes.
