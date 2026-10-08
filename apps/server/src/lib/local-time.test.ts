import { describe, expect, it } from 'vitest';
import { nextLocalTime, zoneOrUtc } from './local-time.js';

describe('nextLocalTime', () => {
  it('"durante a noite" said at 22:00 in São Paulo → 08:00 of the next day', () => {
    expect(nextLocalTime('08:00', 'America/Sao_Paulo', new Date('2026-10-07T01:00:00.000Z')).toISOString()).toBe('2026-10-07T11:00:00.000Z');
  });

  it('later the same day when that time is still ahead ("por hoje" → 23:59)', () => {
    expect(nextLocalTime('23:59', 'America/Sao_Paulo', new Date('2026-10-07T13:00:00.000Z')).toISOString()).toBe('2026-10-08T02:59:00.000Z');
  });

  it('the exact current minute is not ahead: it rolls to tomorrow', () => {
    expect(nextLocalTime('10:00', 'UTC', new Date('2026-10-07T10:00:00.000Z')).toISOString()).toBe('2026-10-08T10:00:00.000Z');
  });

  it('follows a DST change between now and then (New York, spring forward)', () => {
    // 2026-03-08 02:00 EST → 03:00 EDT. Said at 22:00 EST on Mar 7, 08:00 next morning is EDT (UTC-4).
    expect(nextLocalTime('08:00', 'America/New_York', new Date('2026-03-08T03:00:00.000Z')).toISOString()).toBe('2026-03-08T12:00:00.000Z');
  });

  it('refuses a malformed time', () => {
    expect(() => nextLocalTime('25:00', 'UTC', new Date())).toThrow();
  });
});

describe('zoneOrUtc', () => {
  it('keeps a known zone, falls back to UTC for null or an unknown one', () => {
    expect(zoneOrUtc('America/Sao_Paulo')).toBe('America/Sao_Paulo');
    expect(zoneOrUtc(null)).toBe('UTC');
    expect(zoneOrUtc('Nowhere/Land')).toBe('UTC');
  });
});
