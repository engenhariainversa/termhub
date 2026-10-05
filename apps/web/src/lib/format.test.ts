import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { formatDate, formatNumber, formatTime, relativeTime } from './format';

afterEach(() => {
  void i18n.changeLanguage('pt-BR');
});

const now = Date.parse('2026-10-04T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

describe('format helpers follow the language on screen', () => {
  it('writes dates the pt-BR way, then the English way', () => {
    const d = new Date(2026, 9, 4, 14, 5);
    expect(formatDate(d)).toBe('04/10/2026');
    expect(formatTime(d)).toBe('14:05');
    void i18n.changeLanguage('en');
    expect(formatDate(d)).toBe('10/4/2026');
    expect(formatDate(d, { day: 'numeric', month: 'long', year: 'numeric' })).toBe('October 4, 2026');
  });

  it('writes numbers with the language separators', () => {
    expect(formatNumber(25.3)).toBe('25,3');
    void i18n.changeLanguage('en');
    expect(formatNumber(25.3)).toBe('25.3');
  });

  it('says how long ago in English', () => {
    void i18n.changeLanguage('en');
    expect(relativeTime(ago(10_000), now)).toBe('now');
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5 min ago');
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe('3 h ago');
    expect(relativeTime(ago(2 * 86_400_000), now)).toBe('2 d ago');
  });
});
