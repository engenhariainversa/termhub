import { describe, expect, it } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { checkRunLimits, RUN_LIMITS } from './limits.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');

function fakeRepos(opts: { tokenRunning?: number; userRunning?: number; createdLastHour?: number; oldest?: Date | null }) {
  const apiRuns = {
    countRunning: async (by: { userId: string } | { tokenId: string }) => ('tokenId' in by ? (opts.tokenRunning ?? 0) : (opts.userRunning ?? 0)),
    countCreatedSince: async (_tokenId: string, since: Date) => {
      expect(since.getTime()).toBe(NOW.getTime() - 60 * 60 * 1000);
      return opts.createdLastHour ?? 0;
    },
    oldestCreatedSince: async () => opts.oldest ?? null,
  };
  return { apiRuns } as unknown as Pick<Repositories, 'apiRuns'>;
}

const who = { userId: 'u1', tokenId: 't1' };

describe('checkRunLimits', () => {
  it('lets a run through under every limit', async () => {
    expect(await checkRunLimits(fakeRepos({ tokenRunning: 1, userRunning: 3, createdLastHour: 29 }), who, NOW)).toEqual({ ok: true });
  });

  it('refuses a third run for the token while two are running', async () => {
    const r = await checkRunLimits(fakeRepos({ tokenRunning: RUN_LIMITS.runningPerToken, userRunning: 2 }), who, NOW);
    expect(r).toEqual({ ok: false, reason: 'token_running', retryAfterS: 30 });
  });

  it('refuses a token of the same person once 4 runs are running user-wide', async () => {
    const r = await checkRunLimits(fakeRepos({ tokenRunning: 0, userRunning: RUN_LIMITS.runningPerUser }), who, NOW);
    expect(r).toMatchObject({ ok: false, reason: 'user_running' });
  });

  it('refuses the 31st run of the hour, retrying when the oldest leaves the window', async () => {
    const oldest = new Date(NOW.getTime() - 50 * 60 * 1000); // 50 min ago: frees in 10 min
    const r = await checkRunLimits(fakeRepos({ createdLastHour: RUN_LIMITS.createdPerTokenPerHour, oldest }), who, NOW);
    expect(r).toEqual({ ok: false, reason: 'token_hourly', retryAfterS: 600 });
  });

  it('never answers a zero or negative Retry-After', async () => {
    const r = await checkRunLimits(fakeRepos({ createdLastHour: 30, oldest: new Date(NOW.getTime() - 60 * 60 * 1000) }), who, NOW);
    expect(r.ok === false && r.retryAfterS).toBe(1);
  });
});
