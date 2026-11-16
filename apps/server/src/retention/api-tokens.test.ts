import { afterEach, expect, it, vi } from 'vitest';
import { purgeStaleApiTokens, startApiTokenPurge } from './api-tokens.js';

const log = () => ({ info: vi.fn(), warn: vi.fn() });

afterEach(() => vi.useRealTimers());

it('purges through the repository and logs only the count', async () => {
  const repos = { apiTokens: { purgeStale: vi.fn(async () => 4) } };
  const l = log();
  const now = new Date('2026-11-16T00:00:00Z');
  expect(await purgeStaleApiTokens(repos as never, l as never, now)).toBe(4);
  expect(repos.apiTokens.purgeStale).toHaveBeenCalledWith(now);
  expect(l.info).toHaveBeenCalledWith({ deleted: 4 }, 'api tokens: stale tokens purged');
});

it('stays quiet when nothing was due', async () => {
  const l = log();
  await purgeStaleApiTokens({ apiTokens: { purgeStale: async () => 0 } } as never, l as never);
  expect(l.info).not.toHaveBeenCalled();
});

it('runs once shortly after boot, then once a day, and stops', async () => {
  vi.useFakeTimers();
  const purgeStale = vi.fn(async () => 0);
  const stop = startApiTokenPurge({ apiTokens: { purgeStale } } as never, log() as never);
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(purgeStale).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  expect(purgeStale).toHaveBeenCalledTimes(2);
  stop();
  await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
  expect(purgeStale).toHaveBeenCalledTimes(2);
});

it('logs a failed purge by its label and keeps running', async () => {
  vi.useFakeTimers();
  const l = log();
  const purgeStale = vi.fn(async () => {
    throw new Error('db down');
  });
  const stop = startApiTokenPurge({ apiTokens: { purgeStale } } as never, l as never);
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(l.warn).toHaveBeenCalledTimes(1);
  expect(l.warn.mock.calls[0]![1]).toBe('api tokens: purge failed');
  stop();
});
