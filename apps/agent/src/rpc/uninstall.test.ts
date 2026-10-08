import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcFailure } from '../exec.js';
import { makeUninstall, type UninstallDeps } from './uninstall.js';

// Everything with a side effect is injected: a real stop would boot out the agent serving this
// very machine (see test-setup.ts), and a real exit would end the test run.
function deps(overrides: Partial<UninstallDeps> = {}) {
  const events: string[] = [];
  const d = {
    removeServiceDefinition: vi.fn(async () => {
      events.push('remove-definition');
      return true;
    }),
    deleteConfig: vi.fn(() => {
      events.push('delete-config');
    }),
    stopService: vi.fn(async () => {
      events.push('stop');
    }),
    exit: vi.fn((code: number) => {
      events.push(`exit(${code})`);
    }),
    log: vi.fn(),
    ...overrides,
  };
  return { d, events };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('agent.uninstall', () => {
  it('removes the service definition and deletes the config before replying, then stops the service and exits 0', async () => {
    const { d, events } = deps();
    const r = await makeUninstall(d)({});
    expect(r).toEqual({ service: 'removed' });
    events.push('replied');
    expect(events).toEqual(['remove-definition', 'delete-config', 'replied']);
    expect(d.stopService).not.toHaveBeenCalled();
    expect(d.exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(750);
    expect(events).toEqual(['remove-definition', 'delete-config', 'replied', 'stop', 'exit(0)']);
  });

  it('still exits 0 when stopping the service fails', async () => {
    const { d } = deps({ stopService: vi.fn(async () => Promise.reject(new Error('no such job'))) });
    await makeUninstall(d)({});
    await vi.advanceTimersByTimeAsync(750);
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it('in the foreground (no service) deletes the config, replies "none" and just exits 0', async () => {
    const { d, events } = deps({ removeServiceDefinition: vi.fn(async () => false) });
    const r = await makeUninstall(d)({});
    expect(r).toEqual({ service: 'none' });
    expect(d.deleteConfig).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(750);
    expect(d.stopService).not.toHaveBeenCalled();
    expect(events).toEqual(['delete-config', 'exit(0)']);
  });

  it('fails without deleting the config or exiting when the service definition cannot be removed', async () => {
    const { d } = deps({
      removeServiceDefinition: vi.fn(async () => {
        throw new Error('systemctl disable failed (code 1): denied');
      }),
    });
    const err = await makeUninstall(d)({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcFailure);
    expect(err).toMatchObject({ code: 'failed' });
    expect(d.deleteConfig).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(d.stopService).not.toHaveBeenCalled();
    expect(d.exit).not.toHaveBeenCalled();
  });

  it('can be retried after a failure', async () => {
    let attempt = 0;
    const { d } = deps({
      removeServiceDefinition: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('busy');
        return true;
      }),
    });
    const handler = makeUninstall(d);
    await expect(handler({})).rejects.toBeInstanceOf(RpcFailure);
    await expect(handler({})).resolves.toEqual({ service: 'removed' });
  });

  it('refuses a second call while the first runs, and after it succeeded', async () => {
    let release!: (v: boolean) => void;
    const { d } = deps({ removeServiceDefinition: vi.fn(() => new Promise<boolean>((res) => (release = res))) });
    const handler = makeUninstall(d);
    const first = handler({});
    await expect(handler({})).rejects.toMatchObject({ code: 'failed', message: 'uninstall already running' });
    release(true);
    await first;
    await expect(handler({})).rejects.toMatchObject({ message: 'uninstall already running' });
    expect(d.deleteConfig).toHaveBeenCalledTimes(1);
  });
});
