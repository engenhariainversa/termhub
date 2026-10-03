import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AgentSocket } from './client.js';
import { createPtyManager, type SpawnFn } from './pty.js';

/**
 * The PTY descriptors this process holds: masters (`/dev/ptmx`) and slaves (`/dev/ttysNNN`). On
 * macOS every open pair counts against `kern.tty.ptmx_max`, whichever side keeps it open.
 */
function ptyDescriptors(): number {
  const out = execFileSync('lsof', ['-n', '-P', '-p', String(process.pid), '-Fn'], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line === 'n/dev/ptmx' || /^n\/dev\/ttys\d+$/.test(line)).length;
}

/** Polls until the count drops back to `baseline` (a closed master socket is released asynchronously). */
async function settledDescriptors(baseline: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = ptyDescriptors();
  while (count > baseline && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    count = ptyDescriptors();
  }
  return count;
}

const CYCLES = 10;

// node-pty 1.1.0's macOS spawn (pty_posix_spawn) leaked a /dev/ptmx master and the slave of every
// PTY it created, for the life of the process: an agent that opened enough terminals ran the whole
// machine out of PTYs (TER-850). Only the darwin native path had the bug, so only darwin runs this.
describe.runIf(process.platform === 'darwin')('PTY descriptors on macOS (real node-pty)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'th-pty-leak-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it(`returns to baseline after ${CYCLES} spawns that exit on their own`, async () => {
    const { spawn } = await import('node-pty');
    const baseline = ptyDescriptors();

    for (let i = 0; i < CYCLES; i++) {
      const proc = spawn('/bin/sh', ['-c', 'exit 0'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: tmp, env: { PATH: '/usr/bin:/bin' } });
      await new Promise<void>((resolve) => proc.onExit(() => resolve()));
    }

    expect(await settledDescriptors(baseline)).toBe(baseline);
  });

  it(`returns to baseline after ${CYCLES} open/close cycles through the PTY manager`, async () => {
    // Stands in for tmux: ignores the tmux argv and stays up until the manager kills it (SIGHUP).
    const fakeTmux = path.join(tmp, 'fake-tmux');
    fs.writeFileSync(fakeTmux, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const { spawn } = await import('node-pty');
    const exits: Promise<void>[] = [];
    // Real node-pty, wrapped only to know when each process is gone.
    const tracked: SpawnFn = (file, args, options) => {
      const proc = spawn(file, args, options);
      exits.push(new Promise((resolve) => proc.onExit(() => resolve())));
      return proc;
    };
    const manager = createPtyManager({ spawn: tracked, tmuxPath: fakeTmux, log: vi.fn() });
    const socket: AgentSocket = { sendControl: vi.fn(), sendStream: vi.fn() };
    const baseline = ptyDescriptors();

    for (let ch = 1; ch <= CYCLES; ch++) {
      await manager.open(ch, { session: `th-leak-${ch}`, cwd: tmp, cols: 80, rows: 24 }, socket);
      manager.close(ch);
    }
    await Promise.all(exits);

    expect(exits).toHaveLength(CYCLES);
    expect(await settledDescriptors(baseline)).toBe(baseline);
  });
});
