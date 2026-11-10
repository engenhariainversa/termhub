---
symptom: "scroll-script.test.ts: alternate screen tests fail with \"Error: Command failed: tmux -L th-test-scroll-… capture-pane -p -t =-th_scroll-5:\"; a symlink to cat prints \"coreutils: unknown program 'pager'\""
tags: [ci, tmux, tests, coreutils, machine-ops]
evidence: fixed
agent: claude
date: 2026-11-10
---
## Cause

The CI runner (jarvis, Ubuntu 26.04) ships uutils coreutils: `cat` is one multicall Rust binary
(`/usr/lib/cargo/bin/coreutils/cat`) that picks the program from the path it was executed as — not from
`argv[0]`, so `exec -a cat` does not help. The test made fake `codex` and `pager` programs as symlinks to
`cat`; they exit at once with "unknown program", the tmux session dies with them, and `capture-pane` fails.
Every PR failed from 2026-11-10 on, whatever it changed; GNU coreutils (Debian's `node:22`, macOS) never did.

## Fix

The fake programs are symlinks to `perl` running a small script that echoes each byte the way `cat -v`
shows an escape (`packages/machine-ops/src/scroll-script.test.ts`). The process name stays the symlink's
(`ps -o comm=` says `codex`), which is what the test needs.

## How to check

On a host with tmux and uutils (`readlink -f "$(command -v cat)"` under `/usr/lib/cargo`):
`npx vitest run src/scroll-script.test.ts` in `packages/machine-ops` passes 9 of 9.
