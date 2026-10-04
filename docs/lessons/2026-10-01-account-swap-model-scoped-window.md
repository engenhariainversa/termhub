---
symptom: "Nenhuma outra conta do Claude desta máquina tem limite livre agora — while another account still had room"
tags: [chat, account-swap, usage-limit, claude]
evidence: fixed
card: TER-837
agent: claude
date: 2026-10-01
---
## Cause

The swap ranked accounts by the fullest of *all* their usage windows (`peakUtilization`). Claude's usage
endpoint also reports windows that cap a single model (`seven_day_opus`, `seven_day_sonnet`, and
`limits[]` entries with `scope.model`, e.g. the weekly Fable allowance). A chat running on Opus hit its
account's 7-day limit, and the other account (7 days at 69%) was dropped because its "7 dias · Fable"
window was at 100%, a limit that does not apply to Opus.

## Fix

Usage windows now carry `model` (the lowercase family they cap). `peakUtilization` / `rankCandidates`
take the run's model and leave out the windows of other models. When the model is unknown, every window
still counts. The chat reads the model from the CLI's `init` frame (the model the account's default
actually resolved to), uses it to pick the account, and passes it to the re-run so the new account's
own default cannot land on the exhausted model.

## How to check

`npx vitest run src/control/account-swap.test.ts src/chat/account-fallback.test.ts src/chat/service.test.ts`
in `apps/server`. In production, the log line `chat: usage limit, answering on another account` shows up
instead of `no account to fall back to` for that case.
