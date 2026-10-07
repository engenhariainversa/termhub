import { describe, expect, it } from 'vitest';
import { acceptableIds, legalStatus, type LegalVersion } from './legal-status.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const day = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * day).toISOString();

function v(id: string, document: 'terms' | 'privacy', days: number, requires_acceptance = true): LegalVersion {
  return { id, document, version: id, effective_at: at(days), url: `https://termhub.dev/${document}/${id}`, requires_acceptance, summary: null };
}

const ids = (list: LegalVersion[]) => list.map((x) => x.id);

describe('legalStatus', () => {
  it('nothing registered, nothing asked', () => {
    expect(legalStatus([], [], NOW)).toEqual({ pending: [], upcoming: [] });
  });

  it('the version in force of each document is pending until accepted', () => {
    const versions = [v('t1', 'terms', -10), v('p1', 'privacy', -10)];
    expect(ids(legalStatus(versions, [], NOW).pending)).toEqual(['t1', 'p1']);
    expect(ids(legalStatus(versions, ['t1'], NOW).pending)).toEqual(['p1']);
    expect(legalStatus(versions, ['t1', 'p1'], NOW)).toEqual({ pending: [], upcoming: [] });
  });

  it('only the latest relevant version in force is pending', () => {
    const versions = [v('t1', 'terms', -60), v('t2', 'terms', -5)];
    expect(ids(legalStatus(versions, [], NOW).pending)).toEqual(['t2']);
    expect(ids(legalStatus(versions, ['t1'], NOW).pending)).toEqual(['t2']);
  });

  it('a minor version asks nothing and does not hide the relevant one before it', () => {
    const versions = [v('t1', 'terms', -60), v('t1.1', 'terms', -5, false)];
    expect(ids(legalStatus(versions, [], NOW).pending)).toEqual(['t1']);
    expect(legalStatus(versions, ['t1'], NOW).pending).toEqual([]);
    expect(legalStatus([v('t1.1', 'terms', -5, false)], [], NOW)).toEqual({ pending: [], upcoming: [] });
  });

  it('accepting a newer version also satisfies an older one', () => {
    const versions = [v('t1', 'terms', -60), v('t2', 'terms', 20)];
    // t2 accepted early from the banner: t1 is no longer asked, and t2 is no longer upcoming
    expect(legalStatus(versions, ['t2'], NOW)).toEqual({ pending: [], upcoming: [] });
  });

  it('upcoming is the earliest future relevant version not accepted', () => {
    const versions = [v('t1', 'terms', -60), v('t3', 'terms', 60), v('t2', 'terms', 20), v('t2.1', 'terms', 10, false)];
    const s = legalStatus(versions, ['t1'], NOW);
    expect(s.pending).toEqual([]);
    expect(ids(s.upcoming)).toEqual(['t2']);
    expect(ids(legalStatus(versions, ['t1', 't2'], NOW).upcoming)).toEqual(['t3']);
  });

  it('a pending and an upcoming version of the same document both show', () => {
    const s = legalStatus([v('t1', 'terms', -1), v('t2', 'terms', 30)], [], NOW);
    expect(ids(s.pending)).toEqual(['t1']);
    expect(ids(s.upcoming)).toEqual(['t2']);
    expect([...acceptableIds(s)].sort()).toEqual(['t1', 't2']);
  });

  it('a version that takes effect exactly now is in force', () => {
    expect(ids(legalStatus([v('t1', 'terms', 0)], [], NOW).pending)).toEqual(['t1']);
  });

  it('acceptances of one document never cover the other', () => {
    const versions = [v('t1', 'terms', -10), v('p1', 'privacy', -20)];
    expect(ids(legalStatus(versions, ['t1'], NOW).pending)).toEqual(['p1']);
  });
});
