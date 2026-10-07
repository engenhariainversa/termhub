---
symptom: "chat-attachments.db.test.ts > attach binds only the eligible ids ... AssertionError: expected 1 to be 2"
tags: [ci, tests, postgres, flaky, attachments]
evidence: fixed
card: TER-578
pr: https://github.com/engenhariainversa/termhub/pull/416
agent: claude
date: 2026-10-07
---
## Cause

CI runs every `*.db.test.ts` file in parallel against one shared Postgres. `frontend.test.ts` boots the
real `buildApp`, and on boot `buildApp` calls `requeuePending` on **every** pending chat attachment in the
database. The extraction worker finds no file on disk for rows another test file just created, so it marks
them `failed` / `ATTACHMENT_INVALID`, and `attach` then skips them. The failure depends on timing and has
nothing to do with the PR that hits it.

## Fix

`BuildAppOptions.requeuePendingOnBoot` (default `true`) lets a test skip the boot-time re-queue, and
`frontend.test.ts` passes `false`. Any new test that boots `buildApp` against the shared DB should do the
same, along with anything else that works on rows across the whole table.

## How to check

`grep -rn "buildApp(" apps/server/src --include=*.test.ts`: each call against the DB passes
`requeuePendingOnBoot: false`. The `check` job's server tests pass.
