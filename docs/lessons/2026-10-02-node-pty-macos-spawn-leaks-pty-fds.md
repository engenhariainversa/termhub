---
symptom: "forkpty: Device not configured on macOS; the termhub agent's /dev/ptmx count grows by one per terminal opened, even after every PTY exited"
tags: [agent, pty, node-pty, macos, file-descriptors, dependencies]
evidence: fixed
card: TER-850
agent: claude
date: 2026-10-02
---
## Cause

`node-pty@1.1.0` (the `latest` dist-tag) spawns on macOS through `pty_posix_spawn` in
`src/unix/pty.cc`, and that function leaks file descriptors in the calling process on every spawn:

- It opens up to three `posix_openpt()` masters (`low_fds`) so the real master never lands on fd
  0–2, then closes them with `for (; count > 0; count--) close(low_fds[count]);`. The first open
  is almost always already above fd 2, so `count` stays 0 and nothing is closed: one whole
  `/dev/ptmx` pair leaks per spawn.
- It opens the slave (`/dev/ttysNNN`) in the parent to set termios and the window size, and only
  closes it in the child (`posix_spawn_file_actions_addclose`). The parent's copy is never closed
  and never reaches JS, so nothing can close it.

Each leaked descriptor keeps a PTY pair allocated until the process exits, and on macOS
`kern.tty.ptmx_max` is 511 for the whole machine. A long-running agent ran it out. Linux uses
`forkpty`, which does not have this bug. Upstream: microsoft/node-pty#950 and #907. The fix
(both closes) ships in `1.2.0-beta.15`; there is no stable release with it yet.

The PTY open/close race fixed in #288 was a separate leak on top of this one.

## Fix

`@termhub/agent` pins `node-pty` to `1.2.0-beta.15` (exact version: `^1.0.0` never picks a
prerelease). The server keeps its own `node-pty` (`^1.0.0`, Linux only), so npm nests the beta under
`apps/agent/node_modules`. The JS API the agent uses is unchanged. The beta also ships Linux
prebuilds (glibc 2.28, the same floor as Node 20), so Linux agents no longer compile node-pty at
install time.

When a stable node-pty release has the fix, move the pin back to a caret range.

## How to check

On a Mac: `npx vitest run src/pty.fd-leak.real.test.ts` in `apps/agent`. It spawns real PTYs and
counts this process's `/dev/ptmx` and `/dev/ttys*` descriptors with `lsof`. On `node-pty@1.1.0` it
fails (10 left after 10 spawns, 20 after 10 open/close cycles through the PTY manager). On the beta
it passes. On a machine running the agent: `lsof -p <agent pid> | grep -cE '/dev/(ptmx|ttys)'` stays
flat across terminal open/close cycles.
