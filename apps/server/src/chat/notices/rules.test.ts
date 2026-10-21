import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTICE_SETTINGS, NOTICE_LIMITS, noticeSettingsOf, planNotices, quietUntil, type NoticeSettings } from './rules.js';

const now = new Date('2026-10-21T15:00:00.000Z'); // 12:00 in São Paulo
const SP = 'America/Sao_Paulo';
const n = (id: string, level: 'needs_you' | 'done') => ({ id, level });
const settings = (over: Partial<NoticeSettings> = {}): NoticeSettings => ({ ...DEFAULT_NOTICE_SETTINGS, ...over });
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

describe('noticeSettingsOf', () => {
  it('fills what is missing or malformed with the defaults', () => {
    expect(noticeSettingsOf(null)).toEqual(DEFAULT_NOTICE_SETTINGS);
    expect(noticeSettingsOf({ done: false, quiet_start: '22:00', quiet_end: 'x', group_minutes: 500 })).toEqual({ ...DEFAULT_NOTICE_SETTINGS, done: false, group_minutes: 60 });
    expect(noticeSettingsOf({ quiet_start: '22:00', quiet_end: '07:00' })).toMatchObject({ quiet_start: '22:00', quiet_end: '07:00' });
  });
});

describe('quietUntil', () => {
  it('reads the window on the person\'s clock, across midnight', () => {
    const s = { quiet_start: '22:00', quiet_end: '07:00' };
    expect(quietUntil(s, SP, now)).toBeNull();
    // 23:30 in São Paulo = 02:30Z next day → ends at 07:00 local = 10:00Z
    expect(quietUntil(s, SP, new Date('2026-10-22T02:30:00.000Z'))?.toISOString()).toBe('2026-10-22T10:00:00.000Z');
    // 06:59 local still inside
    expect(quietUntil(s, SP, new Date('2026-10-22T09:59:00.000Z'))?.toISOString()).toBe('2026-10-22T10:00:00.000Z');
    expect(quietUntil(s, SP, new Date('2026-10-22T10:00:00.000Z'))).toBeNull();
  });

  it('a window within one day, and none when unset or empty', () => {
    expect(quietUntil({ quiet_start: '11:00', quiet_end: '13:00' }, SP, now)?.toISOString()).toBe('2026-10-21T16:00:00.000Z');
    expect(quietUntil({ quiet_start: '11:00', quiet_end: '13:00' }, 'UTC', now)).toBeNull();
    expect(quietUntil({ quiet_start: null, quiet_end: null }, SP, now)).toBeNull();
    expect(quietUntil({ quiet_start: '11:00', quiet_end: '11:00' }, SP, now)).toBeNull();
  });
});

describe('planNotices', () => {
  it('level → push or not: a level turned off is dropped, the rest leave', () => {
    const plan = planNotices([n('a', 'done'), n('b', 'needs_you')], settings({ done: false }), SP, [], now);
    expect(plan).toEqual({ kind: 'send', notices: [n('b', 'needs_you')], drop: [n('a', 'done')] });
    expect(planNotices([n('a', 'done')], settings({ done: false }), SP, [], now)).toEqual({ kind: 'none', drop: [n('a', 'done')] });
    expect(planNotices([n('a', 'needs_you')], settings({ needs_you: false }), SP, [], now).kind).toBe('none');
  });

  it('quiet hours hold every level until they end', () => {
    const plan = planNotices([n('a', 'needs_you')], settings({ quiet_start: '11:00', quiet_end: '13:00' }), SP, [], now);
    expect(plan).toEqual({ kind: 'wait', until: new Date('2026-10-21T16:00:00.000Z'), reason: 'quiet', drop: [] });
  });

  it('groups: after a push, what comes within the window waits for its end and leaves as one', () => {
    const plan = planNotices([n('a', 'done'), n('b', 'done')], settings({ group_minutes: 5 }), SP, [ago(2)], now);
    expect(plan).toEqual({ kind: 'wait', until: new Date(ago(2).getTime() + 5 * 60_000), reason: 'grouped', drop: [] });
    const later = new Date(ago(2).getTime() + 5 * 60_000);
    expect(planNotices([n('a', 'done'), n('b', 'done')], settings({ group_minutes: 5 }), SP, [ago(2)], later)).toMatchObject({ kind: 'send', notices: [n('a', 'done'), n('b', 'done')] });
  });

  it('needs_you does not wait for the grouping window; group_minutes 0 turns it off', () => {
    expect(planNotices([n('a', 'done'), n('b', 'needs_you')], settings(), SP, [ago(1)], now).kind).toBe('send');
    expect(planNotices([n('a', 'done')], settings({ group_minutes: 0 }), SP, [ago(1)], now).kind).toBe('send');
  });

  it('caps the pushes per conversation per hour, every level included', () => {
    const sent = Array.from({ length: NOTICE_LIMITS.perHour }, (_, i) => ago(50 - i * 5));
    const plan = planNotices([n('a', 'needs_you')], settings(), SP, sent, now);
    expect(plan).toEqual({ kind: 'wait', until: new Date(ago(50).getTime() + 3600_000), reason: 'capped', drop: [] });
    // pushes older than an hour do not count
    expect(planNotices([n('a', 'needs_you')], settings(), SP, sent.map((d) => new Date(d.getTime() - 3600_000)), now).kind).toBe('send');
  });
});
