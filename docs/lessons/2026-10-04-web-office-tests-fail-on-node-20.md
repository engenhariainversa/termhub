---
symptom: "ReferenceError: navigator is not defined (src/office/scene/*.test.ts) when running the web tests in node:20"
tags: [web, vitest, docker, node]
evidence: fixed
card: TER-912
agent: claude
date: 2026-10-04
---
## Cause

The office scene tests import pixi.js, which reads the global `navigator` at import time. Node only has
a global `navigator` from version 21 on. The CI job ("CI e Deploy" → check) runs Node 22, so the tests
pass there, but the `node:20` image in the CLAUDE.md verification command fails five scene test files
before running a single test. The server typecheck in a fresh container also fails with
`Cannot find module '@termhub/agent-protocol'` until the internal packages are built.

## Fix

Run the web tests the way CI does: in `node:22`, after `npm run prisma:generate` and
`npm run build:packages`:

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 \
  sh -c 'npm ci && npm run prisma:generate && npm run build:packages && npm test -w @termhub/web'
```

## How to check

`npm test -w @termhub/web` reports every test file passed, including `src/office/scene/*.test.ts`.
