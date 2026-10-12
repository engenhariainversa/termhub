---
symptom: "Variáveis de ambiente inválidas: { DATABASE_URL: [ 'Required' ] } / Error: process.exit unexpectedly called with \"1\""
tags: [tests, server, vitest, env]
evidence: fixed
card: TER-1011
agent: claude
date: 2026-10-07
---
## Cause

`npm test -w @termhub/server` outside CI, with no `.env`, has no `DATABASE_URL`. Any test file that imports
`src/config.ts` (directly or through `control/agents.ts`, `control/memory.ts`, the automation modules…) fails
before a single test runs, because `config.ts` validates the environment and calls `process.exit(1)`. Every
suite in the run shows up as FAIL, which looks like a broken change but isn't one.

## Fix

Give the run any syntactically valid URL. The unit tests never connect, and the `*.db.test.ts` files skip
unless `TERMHUB_DB_TESTS=1`:

```bash
DATABASE_URL=postgresql://x:x@127.0.0.1:1/x npm test -w @termhub/server -- src/automation
```

In an automatic tab, `docker` is refused by the hard lock, so the DB tests (Postgres with pgvector) only run in
CI.

## How to check

The same command reports `Tests  N passed` instead of the env error.
