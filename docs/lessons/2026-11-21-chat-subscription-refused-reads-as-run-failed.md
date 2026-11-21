---
symptom: "Every chat message answers \"O Claude parou no meio da resposta. Mande a mensagem de novo.\" (RUN_FAILED); agent.log shows `claude run ended {\"code\":1,\"stderrBytes\":0}` and sending again never helps"
tags: [chat, claude-cli, subscription, billing, stream-json]
evidence: fixed
card: TER-1195
agent: claude
date: 2026-11-21
---
## Cause

Anthropic refused the subscription of the account the chat ran on (a payment past due). Claude Code
2.1.330 says so only on stdout, in the `stream-json` frames, and exits 1 with an empty stderr:

- a synthetic `assistant` message (`model: "<synthetic>"`) with a top-level `error: "oauth_org_not_allowed"`
  and the text "Claude Code can't use your Claude subscription, usually because a payment is past due…";
- a `result` with `is_error: true`, `terminal_reason: "api_error"` and `api_error_status: 403`.

`parseFrame` only named `rate_limit`, `model_not_found` and `authentication_failed` (TER-588), so the
refused subscription fell through to the generic `run_failed`.

## Fix

`API_ERRORS` in `apps/server/src/chat/stream.ts` maps `oauth_org_not_allowed` and `billing_error` to
the reason `subscription_blocked` (code `SUBSCRIPTION_BLOCKED`), with its own sentence in the web
(`ChatTurn.tsx`) and the app (`copy.ts`). Fixture: `apps/server/src/chat/fixtures/stream-subscription-blocked.ndjson`.
To unblock a person right away, move the chat to another account (`set_chat_account`, or the
project's Setup).

## How to check

Find the failing account by running a one-line prompt on each login of the host:
`CLAUDE_CONFIG_DIR=<dir> claude -p --output-format stream-json --verbose "oi"`. The blocked one
prints the frames above. The concierge's session `.jsonl` (under `<dir>/projects/`) also ends with
the synthetic message and its `error`.
