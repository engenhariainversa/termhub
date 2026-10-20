---
symptom: "PreToolUse:Bash hook error: termhub: docker e trava dura"
tags: [automation, guard, docker, verify, node]
evidence: fixed
card: TER-586
agent: claude
date: 2026-10-07
---
## Cause

CLAUDE.md says to typecheck and build through `docker run … node:22`, because jarvis has no Node. In an
automatic run (agentic board) the hard-lock guard (TER-993) refuses every `docker` command, so that
recipe cannot run at all from the run's tab.

## Fix

Verify with the user's nvm Node instead (`~/.nvm/versions/node/*/bin/node`, on PATH in the tab), from the
worktree root:

```bash
npm ci --no-audit --no-fund
npm run prisma:generate
npm run build:packages
npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing
```

The server's vitest suites load `src/config.ts`, which exits on a missing `DATABASE_URL`; tests that do
not touch the database only need any value: `DATABASE_URL=postgresql://x:x@127.0.0.1:1/none npm test -w @termhub/server`.
The suites that need a real Postgres are skipped then, and CI (`check.yml`) still runs them. That Node
is not the CI version (22), so say which one ran in the PR.

## How to check

`node -v` prints a version in the run's tab, and the commands above end without errors.
