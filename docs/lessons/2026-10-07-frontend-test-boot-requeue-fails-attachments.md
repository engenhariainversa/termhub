---
symptom: "chat-attachments.db.test 'attach binds only the eligible ids and the message read carries them' fails intermittently: AssertionError: expected 1 to be 2"
tags: [tests, postgres, chat-attachments, vitest, flaky]
evidence: fixed
card: TER-1022
pr: https://github.com/engenhariainversa/termhub/pull/439
agent: claude
date: 2026-10-07
---
## Cause

`frontend.test.ts` boots the real `buildApp` against the same CI database the other `*.db.test.ts` files
use, in parallel with them. At boot, `buildApp` calls `requeuePending` with no age filter, which queues every
pending `chat_attachments` row in the database, including the ones `chat-attachments.db.test.ts` has just
created. Their files do not exist in that app's store, so extraction marks them `failed / ATTACHMENT_INVALID`,
and `attach` (which refuses invalid rows) binds 1 row instead of 2. It only fails when the boot lands between
the test's `create` and its `attach`, so it looks like a flake on a PR that never touched the server.

## Fix

`BuildAppOptions.requeueAttachments` (default true); `frontend.test.ts` passes `false`. Production still
re-queues every pending row at boot.

## How to check

`TERMHUB_DB_TESTS=1 npx vitest run src/frontend src/db/repositories/chat-attachments` with a migrated
Postgres: green, and no `relatorio.pdf` row of the attachments test ends up `ATTACHMENT_INVALID`.
