---
symptom: "Tab refuses an order relayed by the chat concierge: the origin note says the assistant sent it on its own; the agent asks for send_input with on_behalf_of"
tags: [chat, concierge, mcp, provenance, on_behalf_of]
evidence: fixed
card: TER-1037
agent: claude
date: 2026-10-07
---
## Cause

`send_input` already had `on_behalf_of` (TER-851), but it only took a `message:<memory item id>` ref
from `search_memory`. Nothing ever handed the concierge the ref of the message the person had just
typed: it would have had to search for its own conversation's last message, and it never did. Work
driven from a background subagent was worse off, since the subagent never saw the person's message.
So every relayed order reached the tab as `assistant` ("on its own"), and the tab rightly refused it.

## Fix

Each message the person types (`ChatService.start`, never a wake or a re-injected decision) now reaches
the concierge with a first line `[termhub] … its ref is message:<chat message id> …`
(`apps/server/src/chat/message-ref.ts`). `verifyOnBehalfOf` accepts that id as well as the memory item
id, still requiring the `message` memory item `indexMessage` writes, so only typed messages pass.

The instruction lives in that per-message line, not in `ORCHESTRATOR_PROMPT`: the orchestrator prompt
plus the longest project prompt must fit 8000 characters (`concierge-prompt.test.ts`), and it had 7
characters left.

## How to check

Send an order in a project chat and let the concierge relay it: the tab's origin note reads "Sent by the
termhub chat assistant on behalf of <name>", with the person's own words quoted.
