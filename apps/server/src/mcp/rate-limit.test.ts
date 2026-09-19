import { describe, expect, it } from 'vitest';
import { TokenRateLimiter } from './rate-limit.js';

describe('TokenRateLimiter', () => {
  it('allows the limit per window per token, then says when to retry', () => {
    const rl = new TokenRateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect([rl.take('a', t0), rl.take('a', t0 + 1), rl.take('a', t0 + 2)].every((r) => r.ok)).toBe(true);
    expect(rl.take('a', t0 + 10_000)).toEqual({ ok: false, retryInSeconds: 50 });
    expect(rl.take('b', t0 + 10_000).ok).toBe(true);
    expect(rl.take('a', t0 + 60_000).ok).toBe(true);
  });
});
