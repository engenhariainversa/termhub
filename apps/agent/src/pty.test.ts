import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSocket } from './client.js';
import * as execModule from './exec.js';
import { createPtyManager, type SpawnFn, type PtyLike } from './pty.js';

function makeSocket(): { socket: AgentSocket; sendControl: ReturnType<typeof vi.fn>; sendStream: ReturnType<typeof vi.fn> } {
  const sendControl = vi.fn();
  const sendStream = vi.fn();
  return { socket: { sendControl, sendStream }, sendControl, sendStream };
}

/** A fake node-pty process the tests fully control: capture the wired-up callbacks so tests can emit data/exit. */
function makeFakePty(): {
  proc: PtyLike;
  emitData: (s: string) => void;
  emitExit: (exitCode: number, signal?: number) => void;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  disposeData: ReturnType<typeof vi.fn>;
  disposeExit: ReturnType<typeof vi.fn>;
} {
  let dataCb: ((s: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  const write = vi.fn();
  const resize = vi.fn();
  const kill = vi.fn();
  // Like node-pty's IDisposable: a disposed listener is never called again.
  const disposeData = vi.fn(() => {
    dataCb = undefined;
  });
  const disposeExit = vi.fn(() => {
    exitCb = undefined;
  });
  const proc: PtyLike = {
    pid: 4242,
    onData: (cb) => {
      dataCb = cb;
      return { dispose: disposeData };
    },
    onExit: (cb) => {
      exitCb = cb;
      return { dispose: disposeExit };
    },
    write,
    resize,
    kill,
  };
  return {
    proc,
    emitData: (s) => dataCb?.(s),
    emitExit: (exitCode, signal) => exitCb?.({ exitCode, signal }),
    write,
    resize,
    kill,
    disposeData,
    disposeExit,
  };
}

const openParams = { session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 };

describe('createPtyManager', () => {
  it('sends opened and spawns tmux with the exact argv (including -A)', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(1, openParams, socket);

    expect(spawn).toHaveBeenCalledWith('tmux', ['-u', 'new-session', '-A', '-s', 'th-a', '-c', '/tmp'], expect.objectContaining({ name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp' }));
    expect(sendControl).toHaveBeenCalledWith({ type: 'opened', ch: 1 });
  });

  it('spawns with a UTF-8 env carrying TERM, LANG, TERMHUB and the tab id', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(2, openParams, socket);

    const call = spawn.mock.calls[0]!;
    const env = call[2].env as Record<string, string>;
    expect(env.TERM).toBe('xterm-256color');
    expect(env.LANG).toMatch(/utf-?8/i);
    expect(env.TERMHUB).toBe('1');
    expect(env.TERMHUB_TAB_ID).toBe('th-a');
    expect(env.TERMHUB_SESSION).toBe('th-a');
  });

  it('forwards data from the fake pty as stream bytes on the channel', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendStream } = makeSocket();

    await manager.open(3, openParams, socket);
    fake.emitData('hello');

    expect(sendStream).toHaveBeenCalledWith(3, Buffer.from('hello', 'utf8'));
  });

  it('write() forwards to the underlying pty as utf8', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(4, openParams, socket);
    manager.write(4, Buffer.from('ls\n', 'utf8'));

    expect(fake.write).toHaveBeenCalledWith('ls\n');
  });

  it('resize() clamps and forwards to the underlying pty', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(5, openParams, socket);
    manager.resize(5, 1000, 1);

    expect(fake.resize).toHaveBeenCalledWith(500, 2);
  });

  it('close() kills the pty, acks with exactly one closed {code: null} and forwards no data after it', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl, sendStream } = makeSocket();

    await manager.open(6, openParams, socket);
    sendControl.mockClear();
    manager.close(6);
    // Whatever tmux still emits after the kill ("[lost tty]", resets, in-flight output) must
    // not reach the server: it already dropped its side of the channel.
    fake.emitData('[lost tty]');
    fake.emitExit(0);

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(sendStream).not.toHaveBeenCalled();
    const closedMsgs = sendControl.mock.calls.map((c) => c[0]).filter((m: { type: string }) => m.type === 'closed');
    expect(closedMsgs).toEqual([{ type: 'closed', ch: 6, code: null }]);
  });

  it('close() acks the server even when the pty never reports an exit', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(7, openParams, socket);
    sendControl.mockClear();
    manager.close(7);

    expect(sendControl).toHaveBeenCalledWith({ type: 'closed', ch: 7, code: null });
  });

  it('sends closed with the exit code when the process exits on its own', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(7, openParams, socket);
    fake.emitExit(17);

    expect(sendControl).toHaveBeenCalledWith({ type: 'closed', ch: 7, code: 17 });
  });

  it('open_error no_tmux when spawn throws ENOENT', async () => {
    const spawn = vi.fn<SpawnFn>(() => {
      const err = new Error('spawn tmux ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(8, openParams, socket);

    expect(sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 8, error: { code: 'no_tmux', message: 'tmux not found' } });
  });

  it('repairs the spawn-helper and retries once when the first spawn fails with posix_spawnp', async () => {
    const fake = makeFakePty();
    const spawn = vi
      .fn<SpawnFn>()
      .mockImplementationOnce(() => {
        throw new Error('posix_spawnp failed.');
      })
      .mockImplementationOnce(() => fake.proc);
    const repairSpawnHelper = vi.fn(() => ({ path: '/x/spawn-helper', executable: true, repaired: true }));
    const log = vi.fn();
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log, repairSpawnHelper });
    const { socket, sendControl } = makeSocket();

    await manager.open(10, openParams, socket);

    expect(repairSpawnHelper).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(sendControl).toHaveBeenCalledWith({ type: 'opened', ch: 10 });
    expect(log).toHaveBeenCalledWith('spawn-helper exec bit repaired on open', { path: '/x/spawn-helper' });
  });

  it('does not retry when there was nothing to repair', async () => {
    const spawn = vi.fn<SpawnFn>(() => {
      throw new Error('posix_spawnp failed.');
    });
    const repairSpawnHelper = vi.fn(() => ({ path: '/x/spawn-helper', executable: true, repaired: false }));
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn(), repairSpawnHelper });
    const { socket, sendControl } = makeSocket();

    await manager.open(11, openParams, socket);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 11, error: { code: 'internal', message: 'failed to start pty' } });
  });

  it('open_error internal when spawn throws something else', async () => {
    const spawn = vi.fn<SpawnFn>(() => {
      throw new Error('boom');
    });
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(9, openParams, socket);

    expect(sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 9, error: { code: 'internal', message: 'failed to start pty' } });
  });

  it('open_error internal (and resolves, never rejects) when building the env throws before spawn is even reached', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    // Regression for a bug where `agentEnv()` (called while building the pty env, before the
    // try/catch around spawn) could throw synchronously — e.g. a malformed REMOTE_PATH_PREFIX
    // in agentEnv()'s pathPrefixDirs() — and that exception escaped open() entirely instead of
    // being reported as open_error, leaving the channel with neither `opened` nor `open_error`.
    const agentEnvSpy = vi.spyOn(execModule, 'agentEnv').mockImplementation(() => {
      throw new Error('unexpected REMOTE_PATH_PREFIX format');
    });

    await expect(manager.open(13, openParams, socket)).resolves.toBeUndefined();

    agentEnvSpy.mockRestore();
    expect(sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 13, error: { code: 'internal', message: 'failed to start pty' } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('open_error invalid when the channel is already open', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(10, openParams, socket);
    sendControl.mockClear();
    await manager.open(10, openParams, socket);

    expect(sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 10, error: { code: 'invalid', message: 'channel in use' } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('cancels an opening when closeAll runs before spawn resolution', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    const opening = manager.open(1, openParams, socket);
    manager.closeAll();
    await opening;

    expect(spawn).not.toHaveBeenCalled();
    expect(sendControl).not.toHaveBeenCalledWith({ type: 'opened', ch: 1 });
    await manager.open(1, openParams, socket);
    expect(spawn).toHaveBeenCalledTimes(1);
    manager.closeAll();
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  it('cancels an opening and acknowledges close before spawn resolution', async () => {
    const spawn = vi.fn<SpawnFn>(() => makeFakePty().proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    const opening = manager.open(2, openParams, socket);
    manager.close(2);
    await opening;

    expect(spawn).not.toHaveBeenCalled();
    expect(sendControl.mock.calls.map(([message]) => message)).toEqual([{ type: 'closed', ch: 2, code: null }]);
  });

  it('kills a PTY if closeAll runs during spawn', async () => {
    const fake = makeFakePty();
    let manager: ReturnType<typeof createPtyManager>;
    const spawn = vi.fn<SpawnFn>(() => {
      manager.closeAll();
      return fake.proc;
    });
    manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(3, openParams, socket);

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(sendControl).not.toHaveBeenCalledWith({ type: 'opened', ch: 3 });
    manager.close(3);
    expect(sendControl).not.toHaveBeenCalled();
  });

  it('reserves a channel before awaiting spawn resolution', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    const first = manager.open(4, openParams, socket);
    const second = manager.open(4, openParams, socket);
    await Promise.all([first, second]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sendControl.mock.calls.map(([message]) => message)).toEqual([
      { type: 'open_error', ch: 4, error: { code: 'invalid', message: 'channel in use' } },
      { type: 'opened', ch: 4 },
    ]);
    manager.closeAll();
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  it('write/resize/close on an unknown channel are no-ops', () => {
    const spawn = vi.fn<SpawnFn>();
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });

    expect(() => manager.write(99, Buffer.from('x'))).not.toThrow();
    expect(() => manager.resize(99, 80, 24)).not.toThrow();
    expect(() => manager.close(99)).not.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('closeAll kills every open proc', async () => {
    const fakeA = makeFakePty();
    const fakeB = makeFakePty();
    let call = 0;
    const spawn = vi.fn<SpawnFn>(() => (call++ === 0 ? fakeA.proc : fakeB.proc));
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(1, openParams, socket);
    await manager.open(2, { ...openParams, session: 'th-b' }, socket);
    manager.closeAll();

    expect(fakeA.kill).toHaveBeenCalledTimes(1);
    expect(fakeB.kill).toHaveBeenCalledTimes(1);
  });

  it('expands a leading ~ cwd against HOME', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(11, { ...openParams, cwd: '~' }, socket);

    const call = spawn.mock.calls[0]!;
    expect(call[2].cwd).toBe(os.homedir());
  });

  it('falls back to HOME when cwd does not exist', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(12, { ...openParams, cwd: '/does/not/exist/at/all' }, socket);

    const call = spawn.mock.calls[0]!;
    expect(call[2].cwd).toBe(process.env.HOME || '/');
  });
});

describe('createPtyManager — opening races (TER-850)', () => {
  /** Every PTY spawn() handed out, so a test can check none of them is left alive. */
  function trackingSpawn() {
    const fakes: ReturnType<typeof makeFakePty>[] = [];
    const spawn = vi.fn<SpawnFn>(() => {
      const fake = makeFakePty();
      fakes.push(fake);
      return fake.proc;
    });
    return { spawn, fakes };
  }

  const types = (sendControl: ReturnType<typeof vi.fn>) => sendControl.mock.calls.map((c) => (c[0] as { type: string }).type);

  it('open -> closeAll -> spawn resolves: no live PTY and no late opened', async () => {
    const { spawn, fakes } = trackingSpawn();
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl, sendStream } = makeSocket();

    // open() runs up to its first await (the spawn import) before closeAll() gets in.
    const opening = manager.open(1, openParams, socket);
    manager.closeAll();
    await opening;

    for (const fake of fakes) expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(types(sendControl)).not.toContain('opened');
    // The channel is gone: nothing is forwarded to or from it.
    for (const fake of fakes) fake.emitData('late');
    manager.write(1, Buffer.from('x'));
    expect(sendStream).not.toHaveBeenCalled();
    for (const fake of fakes) expect(fake.write).not.toHaveBeenCalled();
  });

  it('open -> close(ch) -> spawn resolves: no live PTY, no opened, exactly one closed ack', async () => {
    const { spawn, fakes } = trackingSpawn();
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    const opening = manager.open(1, openParams, socket);
    manager.close(1);
    await opening;
    for (const fake of fakes) fake.emitExit(0);

    for (const fake of fakes) expect(fake.kill).toHaveBeenCalledTimes(1);
    // The server sent close after its open timeout and keeps the number reserved until it
    // sees `closed` (or `open_error`): the cancelled opening still acks, once.
    expect(sendControl.mock.calls.map((c) => c[0])).toEqual([{ type: 'closed', ch: 1, code: null }]);
  });

  it('a PTY produced by an opening cancelled during spawn is killed at once and never announced', async () => {
    const fake = makeFakePty();
    const manager = createPtyManager({
      // The cancel lands while spawn is handing the PTY back (the in-flight window the race lives in).
      spawn: vi.fn<SpawnFn>(() => {
        manager.closeAll();
        return fake.proc;
      }),
      tmuxPath: 'tmux',
      log: vi.fn(),
    });
    const { socket, sendControl } = makeSocket();

    await manager.open(1, openParams, socket);

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(types(sendControl)).not.toContain('opened');
  });

  it('concurrent open of the same channel: one PTY at most, the second open is rejected', async () => {
    const { spawn, fakes } = trackingSpawn();
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await Promise.all([manager.open(1, openParams, socket), manager.open(1, openParams, socket)]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 1, error: { code: 'invalid', message: 'channel in use' } });
    expect(types(sendControl).filter((t) => t === 'opened')).toHaveLength(1);
    // The one PTY that exists is the tracked one: closeAll reaches it.
    manager.closeAll();
    expect(fakes.map((f) => f.kill.mock.calls.length)).toEqual([1]);
  });

  it('the channel can be opened again once a cancelled opening has settled', async () => {
    const { spawn, fakes } = trackingSpawn();
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    const cancelled = manager.open(1, openParams, socket);
    manager.closeAll();
    await cancelled;
    sendControl.mockClear();
    await manager.open(1, openParams, socket);

    expect(sendControl).toHaveBeenCalledWith({ type: 'opened', ch: 1 });
    const live = fakes[fakes.length - 1]!;
    expect(live.kill).not.toHaveBeenCalled();
  });

  it('double close is idempotent: one kill, one closed ack, listeners released', async () => {
    const fake = makeFakePty();
    const manager = createPtyManager({ spawn: vi.fn<SpawnFn>(() => fake.proc), tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(1, openParams, socket);
    sendControl.mockClear();
    manager.close(1);
    manager.close(1);
    manager.closeAll();
    fake.emitExit(0);
    manager.close(1);

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(sendControl.mock.calls.map((c) => c[0])).toEqual([{ type: 'closed', ch: 1, code: null }]);
    expect(fake.disposeData).toHaveBeenCalledTimes(1);
    expect(fake.disposeExit).toHaveBeenCalledTimes(1);
  });

  it('process exit is idempotent: one closed, listeners released, a later close is a no-op', async () => {
    const fake = makeFakePty();
    const manager = createPtyManager({ spawn: vi.fn<SpawnFn>(() => fake.proc), tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(1, openParams, socket);
    sendControl.mockClear();
    fake.emitExit(3);
    fake.emitExit(3);
    manager.close(1);
    manager.closeAll();

    expect(fake.kill).not.toHaveBeenCalled();
    expect(sendControl.mock.calls.map((c) => c[0])).toEqual([{ type: 'closed', ch: 1, code: 3 }]);
    expect(fake.disposeData).toHaveBeenCalledTimes(1);
    expect(fake.disposeExit).toHaveBeenCalledTimes(1);
  });

  it('logs a PTY that has not exited some time after the kill', async () => {
    vi.useFakeTimers();
    try {
      const stuck = makeFakePty();
      const exits = makeFakePty();
      let call = 0;
      const log = vi.fn();
      const manager = createPtyManager({ spawn: vi.fn<SpawnFn>(() => (call++ === 0 ? stuck.proc : exits.proc)), tmuxPath: 'tmux', log, killGraceMs: 5000 });
      const { socket } = makeSocket();

      await manager.open(1, openParams, socket);
      await manager.open(2, openParams, socket);
      manager.closeAll();
      exits.emitExit(0);
      vi.advanceTimersByTime(5000);

      const stuckLogs = log.mock.calls.filter((c) => c[0] === 'pty did not exit after kill');
      expect(stuckLogs).toEqual([['pty did not exit after kill', { ch: 1, pid: 4242, waitedMs: 5000 }]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
