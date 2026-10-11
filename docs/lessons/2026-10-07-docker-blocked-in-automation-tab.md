---
symptom: "PreToolUse:Bash hook error: termhub: docker e trava dura"
tags: [docker, tests, automation, node]
evidence: fixed
card: TER-743
agent: claude
date: 2026-10-07
---
## Cause

In an automation tab, termhub's PreToolUse hook refuses every `docker` command, so the `node:22`
container recipe in CLAUDE.md ("Verifying before pushing") cannot run there. The server tests also
exit at import (`process.exit unexpectedly called with "1"` from `src/config.ts`) when
`DATABASE_URL` is unset, because the config schema requires it even for unit tests.

## Fix

Use the Node on the host (nvm) instead of the container, from the worktree root:

```bash
npm ci && npm run prisma:generate && npm run build:packages
DATABASE_URL=postgresql://x:x@127.0.0.1:1/x npm test -w @termhub/server   # unit tests; DB tests stay skipped
npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing
```

The dummy `DATABASE_URL` only satisfies the config; never point it at the production database. The
`*.db.test.ts` suites need `TERMHUB_DB_TESTS=1` and a throwaway Postgres, so they run in CI. The host
Node may be newer than CI's 22; CI stays the reference.

`src/mcp/start-agent.e2e.test.ts` ("starts codex under CODEX_HOME…") can fail when run from inside a
termhub tab (it drives a real tmux); it is unrelated to most changes and passes in CI.

## How to check

`npm test -w @termhub/server` ends with the files passing and the DB suites listed as skipped.
