---
symptom: "FAIL src/mcp/start-agent.e2e.test.ts > starts codex under CODEX_HOME for a ChatGPT account — AssertionError: expected '…' to contain 'fake-cli cfg=/tmp/termhub-start-agent-…/cfg'"
tags: [tests, server, tmux, environment]
evidence: observed
card: TER-1079
agent: claude
date: 2026-10-13
---
## Cause

Not a regression of the branch it fails on. The test's fake CLI prints `cfg=$CLAUDE_CONFIG_DIR$CODEX_HOME`,
expecting only one of the two to be set. Run from inside a Claude Code session that was itself started with
`CLAUDE_CONFIG_DIR` (any termhub agent tab on a second account), the Codex case inherits that variable, so
the line reads `cfg=<the tab's own config dir>/tmp/…/cfg` instead of `cfg=/tmp/…/cfg`. The Claude cases pass
because they set `CLAUDE_CONFIG_DIR` themselves. CI and a plain shell have no such variable.

## Fix

Run the server tests without it when working from an agent tab:

```bash
env -u CLAUDE_CONFIG_DIR DATABASE_URL=postgresql://postgres:postgres@localhost:5432/termhub npm test -w @termhub/server
```

(`DATABASE_URL` only has to be set for the config to load; the `.db.test.ts` suites stay skipped without
`TERMHUB_DB_TESTS=1` and run in CI.)

## How to check

`env -u CLAUDE_CONFIG_DIR … npm test -w @termhub/server -- src/mcp/start-agent.e2e.test.ts` passes (6 tests),
and the same command with the variable left in fails only "starts codex under CODEX_HOME".
