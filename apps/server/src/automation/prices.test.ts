import { describe, expect, it } from 'vitest';
import { costOf, familyOf } from './prices.js';

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe('familyOf', () => {
  it('reads the family from current, dated and provider-prefixed ids', () => {
    expect(familyOf('claude-opus-5-5')).toBe('opus');
    expect(familyOf('claude-sonnet-4-5-20250929')).toBe('sonnet');
    expect(familyOf('claude-3-5-haiku-20241022')).toBe('haiku');
    expect(familyOf('us.anthropic.claude-haiku-4-5')).toBe('haiku');
    expect(familyOf('Claude-Opus-4-8[1m]')).toBe('opus');
  });

  it('knows nothing else', () => {
    expect(familyOf('<synthetic>')).toBeNull();
    expect(familyOf('gpt-5-codex')).toBeNull();
    expect(familyOf('claude-fable-5-1')).toBeNull();
    expect(familyOf('opus')).toBeNull();
  });
});

describe('costOf', () => {
  it('prices each kind of token at its own rate', () => {
    expect(costOf('claude-opus-5-5', { ...zero, input: 1_000_000 })).toBeCloseTo(4);
    expect(costOf('claude-opus-5-5', { ...zero, output: 1_000_000 })).toBeCloseTo(20);
    expect(costOf('claude-sonnet-5-5', { input: 1000, output: 2000, cacheRead: 10_000, cacheWrite: 4000 })).toBeCloseTo((1000 * 2 + 2000 * 10 + 10_000 * 0.2 + 4000 * 2.5) / 1e6);
    expect(costOf('claude-haiku-4-5', { ...zero, cacheWrite: 1_000_000 })).toBeCloseTo(1.25);
  });

  it('is null for an unknown model, even with no tokens', () => {
    expect(costOf('claude-fable-5-1', { ...zero, input: 10 })).toBeNull();
    expect(costOf('<synthetic>', zero)).toBeNull();
  });
});
