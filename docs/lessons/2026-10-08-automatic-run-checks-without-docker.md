---
symptom: "PreToolUse:Bash hook error: termhub: docker e trava dura"
tags: [automation, docker, tests, node]
evidence: fixed
card: TER-614
agent: claude
date: 2026-10-08
---
## Cause

An automatic board run's guard hook (`termhub-guard`, TER-993) refuses every `docker` command, so the
`docker run … node:22` check from CLAUDE.md cannot run there. jarvis has no system Node, but the user
account has one through nvm (`~/.nvm/versions/node/v24.*`), which is on the run's PATH.

## Fix

Run the checks with that Node, from the worktree root:

```bash
npm ci && npm run prisma:generate && npm run build:packages
DATABASE_URL=postgresql://x:x@127.0.0.1:1/none npm test -w @termhub/server   # config.ts exits without it; DB tests skip
npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing
```

`npm ci` warns that install scripts were skipped (npm 11); the builds and tests work without them.
Two tests depend on the session's environment, not on the code, and fail inside a Claude Code tab:
`start-agent.e2e.test.ts` "starts codex under CODEX_HOME" (the tab's own Claude config dir leaks into
the path) and the real-tmux `scroll-script.test.ts` alternate-screen cases. CI runs them clean.

## How to check

`npm test -w @termhub/web` passes on Node 24 (the office tests that fail on Node 20 pass), and the server
suite shows only the environment-dependent failures above.
