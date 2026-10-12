import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { purgeRetention } from './purge.js';

const DAY = 24 * 60 * 60 * 1000;

describe('purgeRetention', () => {
  it('purges tab events after 90 days and the waitlist after 12 months, and returns the sum', async () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const repos = {
      tabs: { purgeEventsBefore: vi.fn(async () => 3) },
      waitlist: { purgeBefore: vi.fn(async () => 2) },
    };

    const total = await purgeRetention(repos as unknown as Repositories, now);

    expect(total).toBe(5);
    expect(repos.tabs.purgeEventsBefore).toHaveBeenCalledWith(new Date(now.getTime() - 90 * DAY));
    expect(repos.waitlist.purgeBefore).toHaveBeenCalledWith(new Date(now.getTime() - 365 * DAY));
  });
});
