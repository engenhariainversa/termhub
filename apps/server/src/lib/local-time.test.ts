import { describe, expect, it } from 'vitest';
import { formatLocal, localDateTime, nextLocalTime, zoneOrUtc } from './local-time.js';

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

describe('localDateTime and formatLocal (TER-1100)', () => {
  it('reads a wall time on the clock of a zone, DST included', () => {
    expect(localDateTime('2026-10-22T10:00', 'America/Sao_Paulo')?.toISOString()).toBe('2026-10-22T13:00:00.000Z');
    expect(localDateTime('2026-07-01 09:30', 'Europe/Lisbon')?.toISOString()).toBe('2026-07-01T08:30:00.000Z');
    expect(localDateTime('2026-01-01T09:30', 'Europe/Lisbon')?.toISOString()).toBe('2026-01-01T09:30:00.000Z');
  });

  it('refuses what is not a real date or not that shape', () => {
    expect(localDateTime('2026-02-30T10:00', 'UTC')).toBeNull();
    expect(localDateTime('amanhã 10:00', 'UTC')).toBeNull();
    expect(localDateTime('2026-10-22T24:00', 'UTC')).toBeNull();
  });

  it('tells an instant back on the clock of a zone', () => {
    expect(formatLocal(new Date('2026-10-21T21:00:00.000Z'), 'America/Sao_Paulo')).toBe('2026-10-21 18:00');
    expect(formatLocal(new Date('2026-10-21T21:00:00.000Z'), 'Asia/Tokyo')).toBe('2026-10-22 06:00');
  });
});
