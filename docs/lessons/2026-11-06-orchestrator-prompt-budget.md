---
symptom: "concierge-prompt.test.ts > ... fits the protocol cap with the longest project prompt: AssertionError: expected 8098 to be less than or equal to 8000"
tags: [chat, concierge, prompt, tests]
evidence: fixed
card: TER-1163
agent: claude
date: 2026-11-06
---
## Cause

`ORCHESTRATOR_PROMPT` (`apps/server/src/chat/concierge-prompt.ts`) and a project prompt of up to 4000
characters, joined by `\n\n`, must fit in 8000. On 2026-11-06 the orchestrator prompt was 3975 characters,
so only 23 were left: a new line of about 120 characters for a new tool blew the cap. Several lines are
pinned verbatim by `concierge-prompt.test.ts` (the pause line in pt-BR, the machines line up to "no
commands"), so they cannot be reworded to make room.

## Fix

Keep the prompt to a pointer (the tool's name) and put the rules in the tool's description, which is not
under this cap. For TER-1163 `Projects: create_project` was appended to the machines line and "right
away" became "at once" in a line no test pins (22 characters in all).

## How to check

`DATABASE_URL=postgresql://x:x@127.0.0.1:1/x npx vitest run src/chat/concierge-prompt.test.ts` in
`apps/server` passes; print `ORCHESTRATOR_PROMPT.length` with `npx tsx -e` to see what is left (≤ 3998).
