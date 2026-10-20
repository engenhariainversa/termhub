import { describe, expect, it } from 'vitest';
import { AUTHORITY_WEIGHTS, authorityFactor, isInactive, rankByAuthority, type AuthorityHit } from './authority.js';

const hit = (over: Partial<AuthorityHit> & { key: string }): AuthorityHit => ({
  score: 0.03,
  kind: 'doc',
  trust: 'derived',
  projectId: null,
  inactive: false,
  ...over,
});

const order = (hits: AuthorityHit[], projectId?: string): string[] => rankByAuthority(hits, projectId).map((h) => h.key);

describe('authorityFactor', () => {
  it('is neutral for a plain doc, message or project note', () => {
    for (const kind of ['doc', 'message', 'project_note'] as const) expect(authorityFactor(hit({ key: 'x', kind }), undefined)).toBe(1);
  });

  it('raises a person decision but not a derived one', () => {
    expect(authorityFactor(hit({ key: 'x', kind: 'decision', trust: 'person' }), undefined)).toBe(AUTHORITY_WEIGHTS.personDecision);
    expect(authorityFactor(hit({ key: 'x', kind: 'decision', trust: 'derived' }), undefined)).toBe(1);
  });

  it('raises a current note, a verified lesson and the query project', () => {
    expect(authorityFactor(hit({ key: 'x', kind: 'note' }), undefined)).toBe(AUTHORITY_WEIGHTS.currentNote);
    expect(authorityFactor(hit({ key: 'x', kind: 'lesson', verified: true }), undefined)).toBe(AUTHORITY_WEIGHTS.verifiedLesson);
    expect(authorityFactor(hit({ key: 'x', kind: 'lesson', verified: false }), undefined)).toBe(1);
    expect(authorityFactor(hit({ key: 'x', projectId: 'p1' }), 'p1')).toBe(AUTHORITY_WEIGHTS.sameProject);
    expect(authorityFactor(hit({ key: 'x', projectId: 'p2' }), 'p1')).toBe(1);
    expect(authorityFactor(hit({ key: 'x', projectId: null }), undefined)).toBe(1);
  });

  it('lowers actions and tasks, and an inactive note loses its current-note raise', () => {
    expect(authorityFactor(hit({ key: 'x', kind: 'action' }), undefined)).toBeLessThan(1);
    expect(authorityFactor(hit({ key: 'x', kind: 'task' }), undefined)).toBeLessThan(1);
    expect(authorityFactor(hit({ key: 'x', kind: 'note', inactive: true }), undefined)).toBe(AUTHORITY_WEIGHTS.inactive);
  });
});

describe('rankByAuthority', () => {
  it('keeps the fused order when no rule applies, ties included', () => {
    expect(order([hit({ key: 'a', score: 0.03 }), hit({ key: 'b', score: 0.03 }), hit({ key: 'c', score: 0.02 })])).toEqual(['a', 'b', 'c']);
  });

  it('a person decision overtakes a slightly better-fused doc', () => {
    expect(order([hit({ key: 'doc', score: 0.032 }), hit({ key: 'dec', kind: 'decision', trust: 'person', score: 0.025 })])).toEqual(['dec', 'doc']);
  });

  it('a current note overtakes a slightly better-fused doc', () => {
    expect(order([hit({ key: 'doc', score: 0.03 }), hit({ key: 'note', kind: 'note', score: 0.025 })])).toEqual(['note', 'doc']);
  });

  it('a verified lesson overtakes an unverified one', () => {
    expect(order([hit({ key: 'raw', kind: 'lesson', score: 0.03 }), hit({ key: 'ok', kind: 'lesson', verified: true, score: 0.025 })])).toEqual(['ok', 'raw']);
  });

  it('a hit of the query project overtakes one of another project', () => {
    const hits = [hit({ key: 'other', projectId: 'p2', score: 0.03 }), hit({ key: 'mine', projectId: 'p1', score: 0.025 })];
    expect(order(hits, 'p1')).toEqual(['mine', 'other']);
    expect(order(hits)).toEqual(['other', 'mine']);
  });

  it('a task or an action falls below a slightly worse-fused doc', () => {
    expect(order([hit({ key: 'task', kind: 'task', score: 0.03 }), hit({ key: 'doc', score: 0.025 })])).toEqual(['doc', 'task']);
    expect(order([hit({ key: 'action', kind: 'action', score: 0.03 }), hit({ key: 'doc', score: 0.025 })])).toEqual(['doc', 'action']);
  });

  it('an inactive hit never comes first while a current one exists, however good its fused score', () => {
    const ranked = rankByAuthority(
      [hit({ key: 'old', kind: 'decision', trust: 'person', projectId: 'p1', score: 0.0328, inactive: true }), hit({ key: 'weak', kind: 'task', score: 0.001 })],
      'p1',
    );
    expect(ranked.map((h) => h.key)).toEqual(['weak', 'old']);
    expect(ranked[1]!.authority).toBeLessThanOrEqual(ranked[0]!.authority * AUTHORITY_WEIGHTS.inactiveCap);
  });

  it('inactive hits alone keep their own order', () => {
    expect(order([hit({ key: 'a', score: 0.03, inactive: true }), hit({ key: 'b', score: 0.02, inactive: true })])).toEqual(['a', 'b']);
  });

  it('a current note of the query project beats a person decision of another project', () => {
    const hits = [hit({ key: 'dec', kind: 'decision', trust: 'person', projectId: 'p2' }), hit({ key: 'note', kind: 'note', projectId: 'p1' })];
    expect(order(hits, 'p1')).toEqual(['note', 'dec']);
  });

  it('a person decision of the query project beats a current note of the same project', () => {
    const hits = [hit({ key: 'note', kind: 'note', projectId: 'p1' }), hit({ key: 'dec', kind: 'decision', trust: 'person', projectId: 'p1' })];
    expect(order(hits, 'p1')).toEqual(['dec', 'note']);
  });

  it('a verified lesson of the query project beats a person decision of another project', () => {
    const hits = [hit({ key: 'dec', kind: 'decision', trust: 'person', projectId: 'p2' }), hit({ key: 'lesson', kind: 'lesson', verified: true, projectId: 'p1' })];
    expect(order(hits, 'p1')).toEqual(['lesson', 'dec']);
  });

  it('a task of the query project still falls below a current note of another project', () => {
    const hits = [hit({ key: 'task', kind: 'task', projectId: 'p1' }), hit({ key: 'note', kind: 'note', projectId: 'p2' })];
    expect(order(hits, 'p1')).toEqual(['note', 'task']);
  });

  it('three contradicting notes: the current one comes first, even fused last', () => {
    const hits = [
      hit({ key: 'note:1', kind: 'note', projectId: 'p1', score: 0.0328, inactive: true }),
      hit({ key: 'note:2', kind: 'note', projectId: 'p1', score: 0.032, inactive: true }),
      hit({ key: 'note:3', kind: 'note', projectId: 'p1', score: 0.0161 }),
    ];
    expect(order(hits, 'p1')[0]).toBe('note:3');
  });
});

describe('isInactive', () => {
  const now = new Date('2026-10-07T12:00:00.000Z');
  it('is false for a row without supersession or expiry columns', () => {
    expect(isInactive({ id: 'x' }, now)).toBe(false);
    expect(isInactive({ superseded_at: null, expires_at: null }, now)).toBe(false);
  });
  it('is true once superseded', () => {
    expect(isInactive({ superseded_at: '2026-10-03T10:00:00.000Z' }, now)).toBe(true);
  });
  it('is true from expires_at on, false before it', () => {
    expect(isInactive({ expires_at: '2026-10-07T12:00:00.000Z' }, now)).toBe(true);
    expect(isInactive({ expires_at: new Date('2026-10-07T11:00:00.000Z') }, now)).toBe(true);
    expect(isInactive({ expires_at: '2026-10-08T00:00:00.000Z' }, now)).toBe(false);
  });
  it('is true for any Memória screen mark (TER-1013), false for current', () => {
    for (const status of ['outdated', 'wrong', 'superseded']) expect(isInactive({ status, expires_at: null }, now)).toBe(true);
    expect(isInactive({ status: 'current', expires_at: null }, now)).toBe(false);
  });
});
