import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { agents } from './registry.js';
import {
  autoUpdateTick,
  fetchLatestAgentVersion,
  isOutdated,
  latestAgentRelease,
  latestAgentVersion,
  resetAutoUpdateAttempts,
  setLatestAgentRelease,
  startAgentVersionPoller,
  REFRESH_MS,
} from './latest-version.js';

const log = { info: vi.fn(), warn: vi.fn() };
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const release = (version: string) => ({ version, integrity: INTEGRITY });
const json = (status: number, body: unknown) => vi.fn(async () => ({ status, body, text: JSON.stringify(body), headers: new Headers() }));

afterEach(() => {
  setLatestAgentRelease(null);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('isOutdated', () => {
  it('is true only when both versions parse and current < latest', () => {
    expect(isOutdated('0.2.0', '0.2.1')).toBe(true);
    expect(isOutdated('0.2.1', '0.2.1')).toBe(false);
    expect(isOutdated('0.3.0', '0.2.9')).toBe(false);
    expect(isOutdated(null, '0.2.1')).toBe(false);
    expect(isOutdated('0.2.0', null)).toBe(false);
    expect(isOutdated('dev', '0.2.1')).toBe(false);
    expect(isOutdated('0.2.0', '0.2.1-beta')).toBe(false);
  });
});

describe('fetchLatestAgentVersion', () => {
  it('reads dist-tags latest from the registry', async () => {
    const f = json(200, { name: '@termhub/agent', version: '0.2.5' });
    expect(await fetchLatestAgentVersion(f)).toBe('0.2.5');
    expect(f).toHaveBeenCalledWith('https://registry.npmjs.org/@termhub/agent/latest', expect.objectContaining({ timeoutMs: 10_000 }));
  });
  it('returns null on a non-200, a malformed body or a thrown fetch', async () => {
    expect(await fetchLatestAgentVersion(json(503, {}))).toBeNull();
    expect(await fetchLatestAgentVersion(json(200, { version: 'latest' }))).toBeNull();
    expect(await fetchLatestAgentVersion(vi.fn(async () => { throw new Error('boom'); }))).toBeNull();
  });
});

describe('startAgentVersionPoller', () => {
  /** Poller deps: one agent connected, a registry answering `version`, a verifier that approves. */
  function deps(version: string | null, over: Record<string, unknown> = {}) {
    const fetchJson = json(version ? 200 : 500, version ? { version } : {});
    const verify = vi.fn(async (v: string) => release(v));
    const online: (() => void)[] = [];
    return {
      fetchJson,
      verify,
      online,
      d: {
        fetchJson,
        connectedAgents: () => 1,
        onAgentOnline: (cb: () => void) => {
          online.push(cb);
          return () => {};
        },
        ...over,
      },
    };
  }
  async function start(onRefresh: (() => Promise<void>) | undefined, x: ReturnType<typeof deps>) {
    return startAgentVersionPoller(log, onRefresh, { ...x.d, verify: x.verify } as never);
  }

  it('fetches at boot, verifies, caches, refreshes hourly and calls onRefresh after each read', async () => {
    vi.useFakeTimers();
    const x = deps('0.2.5');
    const onRefresh = vi.fn(async () => {});
    const stop = await start(onRefresh, x);
    expect(latestAgentVersion()).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(latestAgentVersion()).toBe('0.2.5');
    expect(latestAgentRelease()).toEqual(release('0.2.5'));
    expect(x.verify).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(x.fetchJson).toHaveBeenCalledTimes(2);
    expect(x.verify).toHaveBeenCalledTimes(1); // same version: already verified
    stop();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(x.fetchJson).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous value and warns when a refresh fails', async () => {
    vi.useFakeTimers();
    setLatestAgentRelease(release('0.2.4'));
    const stop = await start(undefined, deps(null));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(latestAgentVersion()).toBe('0.2.4');
    expect(log.warn).toHaveBeenCalled();
    stop();
  });

  it('keeps the previous verified release when a new one fails verification, and retries it only on the next poll', async () => {
    vi.useFakeTimers();
    setLatestAgentRelease(release('0.2.4'));
    const x = deps('0.2.5');
    x.verify.mockRejectedValue(new Error('sigstore verification failed: bad signer'));
    const onRefresh = vi.fn(async () => {});
    const stop = await start(onRefresh, x);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(latestAgentRelease()).toEqual(release('0.2.4'));
    expect(log.warn).toHaveBeenCalledWith({ version: '0.2.5', err: 'sigstore verification failed: bad signer' }, 'agent release failed provenance verification');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // an agent connecting does not trigger another attempt (the tick was not skipped)
    for (const cb of x.online) cb();
    await vi.advanceTimersByTimeAsync(10);
    expect(x.verify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(x.verify).toHaveBeenCalledTimes(2);
    x.verify.mockImplementation(async (v: string) => release(v));
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(latestAgentVersion()).toBe('0.2.5');
    stop();
  });

  it('does not ask the registry while no agent is connected, and asks once one connects', async () => {
    vi.useFakeTimers();
    let connected = 0;
    const x = deps('0.2.5', { connectedAgents: () => connected });
    const stop = await start(undefined, x);
    await vi.advanceTimersByTimeAsync(2_000 + REFRESH_MS);
    expect(x.fetchJson).not.toHaveBeenCalled();
    connected = 1;
    for (const cb of x.online) cb();
    await vi.advanceTimersByTimeAsync(10);
    expect(x.fetchJson).toHaveBeenCalledTimes(1);
    expect(latestAgentVersion()).toBe('0.2.5');
    // later connections do not trigger extra polls
    for (const cb of x.online) cb();
    await vi.advanceTimersByTimeAsync(10);
    expect(x.fetchJson).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('autoUpdateTick', () => {
  function attach(id: string, version: string, channels: number, rpc = vi.fn(async () => ({ installed_version: '0.2.5', restart: 'service' }))) {
    const conn = Object.assign(new EventEmitter(), {
      hello: { type: 'hello', protocol: 1, agent_version: version, os: 'macos', tools: ['tmux'] },
      connectedAt: Date.now(),
      openChannels: channels,
      rpc,
      close: vi.fn(),
    });
    agents.attach(id, conn as never);
    return rpc;
  }
  const machine = (id: string) => ({ id, type: 'agent', agent_auto_update: true }) as never;
  /** `busy`: how many tabs of that machine have a tool mid-task (working / waiting on input or permission). */
  const repos = (ids: string[], busy: Record<string, number> = {}) =>
    ({
      machines: { listAutoUpdate: async () => ids.map(machine) },
      tabs: { countBusyByMachine: async (id: string) => busy[id] ?? 0 },
    }) as unknown as Repositories;

  afterEach(() => {
    agents.reset();
    resetAutoUpdateAttempts();
  });

  it('updates only online, outdated, idle machines that know the RPC — once per version', async () => {
    setLatestAgentRelease(release('0.2.5'));
    const idle = attach('idle', '0.2.1', 0);
    const busy = attach('busy', '0.2.1', 2);
    const fresh = attach('fresh', '0.2.5', 0);
    const old = attach('old', '0.2.0', 0);
    await autoUpdateTick(repos(['idle', 'busy', 'fresh', 'old', 'offline']), log);
    expect(idle).toHaveBeenCalledWith('agent.update', { version: '0.2.5', integrity: INTEGRITY }, 180_000);
    expect(busy).not.toHaveBeenCalled();
    expect(fresh).not.toHaveBeenCalled();
    expect(old).not.toHaveBeenCalled();
    await autoUpdateTick(repos(['idle']), log);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  // A restart drops the agent's socket for a few seconds. An attached terminal is not the only
  // sign of a machine in use: a tool working (or waiting for the person) inside a *detached*
  // tmux session opens no channel at all, and that is precisely when an update must wait.
  it('skips a machine whose tabs report a tool mid-task, even with no channel open', async () => {
    setLatestAgentRelease(release('0.2.5'));
    const working = attach('working', '0.2.1', 0);
    const quiet = attach('quiet', '0.2.1', 0);
    await autoUpdateTick(repos(['working', 'quiet'], { working: 1 }), log);
    expect(working).not.toHaveBeenCalled();
    expect(quiet).toHaveBeenCalledWith('agent.update', { version: '0.2.5', integrity: INTEGRITY }, 180_000);
  });

  it('does nothing before the latest version is known and survives a failing agent', async () => {
    const rpc = attach('idle', '0.2.1', 0, vi.fn(async () => { throw new Error('boom'); }));
    await autoUpdateTick(repos(['idle']), log);
    expect(rpc).not.toHaveBeenCalled();
    setLatestAgentRelease(release('0.2.5'));
    await expect(autoUpdateTick(repos(['idle']), log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
