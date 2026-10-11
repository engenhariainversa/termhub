import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import type { AgentConnection } from '../agent/connection.js';
import { AgentRpcError } from '../agent/connection.js';
import { agents } from '../agent/registry.js';
import type { Machine } from '../db/repositories/types.js';
import { FRESH_GRACE_MS, PROBE_TTL_MS, cachedTmuxProbe, clearTmuxProbeMemo, listTmuxSessions, probeTmuxSessions, probeTmuxSessionsCached } from './machine-exec.js';

const machine = (type: Machine['type'], id = 'm1'): Machine =>
  ({ id, name: 'box', type, host: type === 'ssh' ? 'box.local' : null, ssh_user: 'u', ssh_port: 22, os: 'linux', capabilities: ['tmux'] }) as Machine;

/** Attaches a fake AgentConnection whose rpc() is driven by `rpcImpl` (same shape as agent/ops.test.ts). */
function attachFakeConn(machineId: string, rpcImpl: (method: string) => unknown) {
  const conn = {
    machineId,
    hello: { agent_version: '0.1.0', os: 'linux', tools: ['tmux'] },
    connectedAt: Date.now(),
    close: vi.fn(),
    rpc: vi.fn(async (method: string) => rpcImpl(method)),
    openPty: vi.fn(),
    on() {
      return this;
    },
  } as unknown as AgentConnection;
  agents.attach(machineId, conn);
  return conn;
}

/** Makes the next execFile() answer with this result, the way node's callback does. */
function execAnswers(result: { code: number | null; stdout?: string; stderr?: string; killed?: boolean }) {
  vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
    const err = result.code === 0 ? null : Object.assign(new Error('exec failed'), { code: result.code ?? undefined, killed: result.killed, signal: result.killed ? 'SIGTERM' : undefined });
    cb(err, result.stdout ?? '', result.stderr ?? '');
    return undefined as never;
  }) as never);
}

beforeEach(() => {
  agents.reset();
  vi.clearAllMocks();
});

describe('probeTmuxSessions', () => {
  it('reports the sessions of an online agent as reachable', async () => {
    attachFakeConn('m1', () => ({ sessions: ['th-a', 'th-b'] }));
    expect(await probeTmuxSessions(machine('agent'))).toEqual({ reachable: true, sessions: new Set(['th-a', 'th-b']) });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports an offline agent as unreachable instead of "no sessions"', async () => {
    const probe = await probeTmuxSessions(machine('agent', 'offline-agent'));
    expect(probe.reachable).toBe(false);
    expect(probe.sessions.size).toBe(0);
    expect(probe.cause).toBe('agent offline');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('waits for an agent on its way from the other colour (a deploy) before calling it unreachable', async () => {
    const moving = { ...machine('agent', 'moving-agent'), agent_last_seen_at: new Date().toISOString() } as Machine;
    const pending = probeTmuxSessions(moving);
    setTimeout(() => attachFakeConn('moving-agent', () => ({ sessions: ['th-a'] })), 20);
    expect(await pending).toEqual({ reachable: true, sessions: new Set(['th-a']) });
  });

  it('reports a failed agent RPC as unreachable', async () => {
    attachFakeConn('m1', () => {
      throw new AgentRpcError({ code: 'failed', message: 'tmux exploded' });
    });
    const probe = await probeTmuxSessions(machine('agent'));
    expect(probe.reachable).toBe(false);
    // metadata only: the machine's own message never reaches the log line
    expect(probe.cause).toBe('agent rpc failed');
  });

  it('reports an ssh failure (non-zero exit) as unreachable, not as an empty floor', async () => {
    execAnswers({ code: 255, stderr: 'ssh: connect to host box.local port 22: Connection refused' });
    const probe = await probeTmuxSessions(machine('ssh'));
    expect(probe.reachable).toBe(false);
    expect(probe.sessions.size).toBe(0);
    expect(probe.cause).toBe('exit 255');
  });

  it('reports a timed-out execution as unreachable', async () => {
    execAnswers({ code: null, killed: true });
    const probe = await probeTmuxSessions(machine('ssh'));
    expect(probe.reachable).toBe(false);
    expect(probe.cause).toBe('timeout');
  });

  it('is reachable with zero sessions when tmux answered that no server is running', async () => {
    // the remote command swallows tmux's own failure (`2>/dev/null || true`): exit 0, no output
    execAnswers({ code: 0, stdout: '' });
    expect(await probeTmuxSessions(machine('ssh'))).toEqual({ reachable: true, sessions: new Set() });
  });

  it('is reachable with zero sessions for a local machine whose tmux server is not running', async () => {
    // local runs tmux directly, so "no server" arrives as a non-zero exit with tmux's message
    execAnswers({ code: 1, stderr: 'no server running on /tmp/tmux-1000/default' });
    expect(await probeTmuxSessions(machine('local'))).toEqual({ reachable: true, sessions: new Set() });
  });

  it('parses the session names and ignores blank lines', async () => {
    execAnswers({ code: 0, stdout: 'th-a\n\nth-b\n' });
    expect(await probeTmuxSessions(machine('ssh'))).toEqual({ reachable: true, sessions: new Set(['th-a', 'th-b']) });
  });
});

describe('probeTmuxSessionsCached', () => {
  const probeCallCount = () => vi.mocked(execFile).mock.calls.length;

  beforeEach(() => clearTmuxProbeMemo());

  it('serves a reachable answer from memory for 15 s, then probes again', async () => {
    let t = 1_000;
    const now = () => t;
    const m = machine('ssh');
    execAnswers({ code: 0, stdout: 'th-a\n' });
    await probeTmuxSessionsCached(m, { now });
    const calls = probeCallCount();
    t += PROBE_TTL_MS.reachable - 1;
    await probeTmuxSessionsCached(m, { now });
    expect(probeCallCount()).toBe(calls);
    t += 2;
    await probeTmuxSessionsCached(m, { now });
    expect(probeCallCount()).toBe(calls + 1);
  });

  it('keeps an unreachable answer for 60 s — a machine that is down costs one timeout a minute', async () => {
    let t = 0;
    const now = () => t;
    const m = machine('agent', 'offline-agent');
    expect((await probeTmuxSessionsCached(m, { now })).reachable).toBe(false);
    t += PROBE_TTL_MS.unreachable - 1;
    const again = await probeTmuxSessionsCached(m, { now });
    expect(again).toEqual({ reachable: false, sessions: new Set(), cause: 'agent offline' });
  });

  it('keys by machine id', async () => {
    const now = () => 0;
    execAnswers({ code: 0, stdout: 'th-a\n' });
    const a = await probeTmuxSessionsCached(machine('agent', 'offline-agent'), { now });
    const b = await probeTmuxSessionsCached(machine('ssh', 'other'), { now });
    expect(a.reachable).toBe(false);
    expect(b.reachable).toBe(true);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    const now = () => 0;
    const m = machine('ssh');
    execAnswers({ code: 0, stdout: 'th-a\n' });
    const before = probeCallCount();
    const [x, y] = await Promise.all([probeTmuxSessionsCached(m, { now }), probeTmuxSessionsCached(m, { now })]);
    expect(probeCallCount()).toBe(before + 1);
    expect(x).toBe(y);
  });

  it('fresh bypasses the memo and refreshes it', async () => {
    let t = 0;
    const now = () => t;
    const m = machine('ssh');
    execAnswers({ code: 0, stdout: 'th-a\n' });
    await probeTmuxSessionsCached(m, { now });
    const calls = probeCallCount();
    t += FRESH_GRACE_MS;
    await probeTmuxSessionsCached(m, { now, fresh: true });
    expect(probeCallCount()).toBe(calls + 1);
    await probeTmuxSessionsCached(m, { now });
    expect(probeCallCount()).toBe(calls + 1); // served by the refreshed entry
  });

  it('serves a fresh call from an answer only seconds old: one tab opened, many watching tabs', async () => {
    let t = 1_000;
    const now = () => t;
    const m = machine('ssh');
    execAnswers({ code: 0, stdout: 'th-a\n' });
    await probeTmuxSessionsCached(m, { now });
    const calls = probeCallCount();
    // every browser tab watching this machine asks at once when a tab is opened on it
    t += FRESH_GRACE_MS - 1;
    await probeTmuxSessionsCached(m, { now, fresh: true });
    expect(probeCallCount()).toBe(calls);
    // past the grace it is a real question again, well before the 15 s the memo would serve
    t += 2;
    await probeTmuxSessionsCached(m, { now, fresh: true });
    expect(probeCallCount()).toBe(calls + 1);
  });

  it('does not poison the memo when the probe promise rejects', async () => {
    const now = () => 0;
    const m = machine('ssh');
    vi.mocked(execFile).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(probeTmuxSessionsCached(m, { now })).rejects.toThrow('boom');
    execAnswers({ code: 0, stdout: 'th-a\n' });
    const calls = probeCallCount();
    const probe = await probeTmuxSessionsCached(m, { now });
    expect(probeCallCount()).toBe(calls + 1);
    expect(probe.reachable).toBe(true);
  });
});

describe('cachedTmuxProbe', () => {
  const probeCallCount = () => vi.mocked(execFile).mock.calls.length;

  beforeEach(() => clearTmuxProbeMemo());

  it('answers undefined when nothing is memoised yet, and never touches the machine', () => {
    expect(cachedTmuxProbe(machine('ssh'), { now: () => 0 })).toBeUndefined();
    expect(probeCallCount()).toBe(0);
  });

  it('answers the memoised probe while it is warm, without another round-trip', async () => {
    const now = () => 1_000;
    const m = machine('ssh');
    execAnswers({ code: 0, stdout: 'th-a\n' });
    await probeTmuxSessionsCached(m, { now });
    const calls = probeCallCount();
    expect(cachedTmuxProbe(m, { now })).toEqual({ reachable: true, sessions: new Set(['th-a']) });
    expect(probeCallCount()).toBe(calls);
  });

  // The public channel only has the machine id a monitor change carries, not the row.
  it('answers the same memo by machine id', async () => {
    const now = () => 1_000;
    const m = machine('ssh');
    execAnswers({ code: 0, stdout: 'th-a\n' });
    await probeTmuxSessionsCached(m, { now });
    const calls = probeCallCount();
    expect(cachedTmuxProbe(m.id, { now })).toEqual(cachedTmuxProbe(m, { now }));
    expect(cachedTmuxProbe('m-unknown', { now })).toBeUndefined();
    expect(probeCallCount()).toBe(calls);
  });

  it('answers undefined once the memo has expired, and does not refresh it', async () => {
    let t = 0;
    const now = () => t;
    const m = machine('ssh');
    execAnswers({ code: 0, stdout: 'th-a\n' });
    await probeTmuxSessionsCached(m, { now });
    const calls = probeCallCount();
    t += PROBE_TTL_MS.reachable;
    expect(cachedTmuxProbe(m, { now })).toBeUndefined();
    // a caller that must not probe (the public city) gets "cold", not a fresh round-trip on its behalf
    expect(probeCallCount()).toBe(calls);
  });
});

describe('listTmuxSessions', () => {
  // Pinned on purpose: other routes read this as "no sessions" and changing it is not part of the
  // office work — probeTmuxSessions is what tells "could not ask" from "asked, nothing running".
  it('still answers an empty set on a failed execution', async () => {
    execAnswers({ code: 255, stderr: 'ssh: connect timed out' });
    expect(await listTmuxSessions(machine('ssh'))).toEqual(new Set());
  });

  it('leaves out the hidden AI CLI login sessions (TER-1047), over the agent and over ssh', async () => {
    attachFakeConn('m1', () => ({ sessions: ['th-a', 'termhub-login-0123abcd'] }));
    expect(await listTmuxSessions(machine('agent'))).toEqual(new Set(['th-a']));
    expect(await probeTmuxSessions(machine('agent'))).toEqual({ reachable: true, sessions: new Set(['th-a']) });
    execAnswers({ code: 0, stdout: 'th-b\ntermhub-login-ffff\n' });
    expect(await listTmuxSessions(machine('ssh'))).toEqual(new Set(['th-b']));
  });
});
