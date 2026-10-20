import { describe, expect, it } from 'vitest';
import { holdsAt, inferScope, isExpired, scopeHolds } from './decision-scope.js';

const row = (over: Partial<Parameters<typeof holdsAt>[0]> = {}) => ({ scope: 'user' as const, project_id: 'p1', conversation_id: 'c1', expires_at: null, ...over });

describe('decision scope (TER-1014)', () => {
  it('infers project for a row with a project, user without', () => {
    expect(inferScope('p1')).toBe('project');
    expect(inferScope(null)).toBe('user');
  });

  it('a user decision holds anywhere', () => {
    expect(scopeHolds(row(), { projectId: 'p2', conversationId: 'c2' })).toBe(true);
    expect(scopeHolds(row(), {})).toBe(true);
  });

  it('a project decision holds only in its project (or a search over any project)', () => {
    const r = row({ scope: 'project' });
    expect(scopeHolds(r, { projectId: 'p1' })).toBe(true);
    expect(scopeHolds(r, { projectId: 'p2' })).toBe(false);
    expect(scopeHolds(r, { projectId: null })).toBe(false);
    expect(scopeHolds(r, {})).toBe(true);
  });

  it('a conversation decision holds only in its conversation, never without one', () => {
    const r = row({ scope: 'conversation' });
    expect(scopeHolds(r, { projectId: 'p1', conversationId: 'c1' })).toBe(true);
    expect(scopeHolds(r, { projectId: 'p1', conversationId: 'c2' })).toBe(false);
    expect(scopeHolds(r, { projectId: 'p1' })).toBe(false);
  });

  it('an expired decision never holds; one expiring later still does', () => {
    const now = new Date('2026-10-07T12:00:00.000Z');
    expect(isExpired('2026-10-07T12:00:00.000Z', now)).toBe(true);
    expect(holdsAt(row({ expires_at: '2026-10-07T11:59:59.000Z' }), {}, now)).toBe(false);
    expect(holdsAt(row({ expires_at: '2026-10-07T12:00:01.000Z' }), {}, now)).toBe(true);
    expect(holdsAt(row(), {}, now)).toBe(true);
  });
});
