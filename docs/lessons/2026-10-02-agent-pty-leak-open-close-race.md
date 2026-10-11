---
symptom: "forkpty: Device not configured — new terminals fail on macOS; lsof /dev/ptmx shows hundreds of descriptors held by the termhub agent's node process"
tags: [agent, pty, node-pty, macos, race, tmux]
evidence: fixed
card: TER-850
pr: https://github.com/engenhariainversa/termhub/pull/288
agent: claude
date: 2026-10-02
---
## Cause

`createPtyManager().open(ch)` in `apps/agent/src/pty.ts` checked `procs.has(ch)`, then awaited the
lazy `node-pty` import, and only registered the PTY in `procs` after spawning. `close(ch)` (the
server sends it when its open times out) and `closeAll()` (every disconnect/reconnect, from
`run.ts`) only see `procs`, so a close that landed during that await found nothing to kill. The open
then finished, registered the PTY under a connection that no longer existed and sent a late
`opened`. Nothing ever killed that tmux client, so its `/dev/ptmx` descriptor stayed open for the
life of the agent. Two concurrent opens of the same channel also spawned two PTYs and tracked one.

On macOS, `kern.tty.ptmx_max` is 511, so after enough reconnects the whole machine runs out of PTYs.
Killing the agent process released them at once, which is how this race differs from tmux sessions
(those are meant to persist).

This is not the only cause. `node-pty@1.1.0` leaks one `/dev/ptmx` descriptor on every successful
spawn on macOS (off-by-one in `pty_posix_spawn`, node-pty#950 / #907), even when cleanup runs. That
is a dependency issue and is tracked separately on #287.

## Fix

`open()` takes the channel slot synchronously (`state: 'opening'`) before its first await. `close()`
and `closeAll()` cancel an opening by dropping that slot. `open()` checks the slot is still its own
after the await (and does not spawn) and again right after spawn (and kills the new PTY without
sending `opened`). The reservation also rejects a concurrent open of the same channel. The
`onData`/`onExit` disposables are released, and a PTY that has not exited 10 s after its kill is
logged as `pty did not exit after kill`.

## How to check

`npx vitest run src/pty.test.ts` in `apps/agent`: the "opening races (TER-850)" tests fail without
the fix and pass with it. On a Mac, compare `lsof -p <agent pid> 2>/dev/null | grep -c ptmx`
before and after a batch of open/close/reconnect cycles. With this fix, the count should not grow
by more than the node-pty leak above (one per spawn on node-pty 1.1.0).
