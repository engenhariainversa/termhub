import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { API_TOKEN_RE, assertScopesFor, hashApiToken, newApiToken, toScopes } from './api-tokens.js';

describe('newApiToken', () => {
  it('is thb_pat_ plus 43 base64url chars, and returns the sha256 hex of the token', () => {
    const { token, hash } = newApiToken();
    expect(token).toMatch(/^thb_pat_[A-Za-z0-9_-]{43}$/);
    expect(API_TOKEN_RE.test(token)).toBe(true);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newApiToken().token));
    expect(tokens.size).toBe(50);
  });
});

describe('hashApiToken', () => {
  it('is stable and differs per token', () => {
    expect(hashApiToken('thb_pat_a')).toBe(hashApiToken('thb_pat_a'));
    expect(hashApiToken('thb_pat_a')).not.toBe(hashApiToken('thb_pat_b'));
  });
});

describe('API_TOKEN_RE', () => {
  it.each(['thb_pat_short', 'thb_hk_' + 'a'.repeat(43), 'thb_pat_' + 'a'.repeat(44), 'thb_pat_' + 'a'.repeat(42) + '!'])('rejects %s', (t) => {
    expect(API_TOKEN_RE.test(t)).toBe(false);
  });
});

describe('toScopes', () => {
  it('keeps known scopes once, in catalog order, and drops unknown ones', () => {
    expect(toScopes(['terminals', 'read', 'read', 'admin', 'tasks'])).toEqual(['read', 'tasks', 'terminals']);
    expect(toScopes([])).toEqual([]);
  });

  it('accepts the memory scope, last in catalog order', () => {
    expect(toScopes(['memory', 'read'])).toEqual(['read', 'memory']);
  });
});

describe('assertScopesFor (TER-1176)', () => {
  it('lets a personal token carry runs', () => {
    expect(() => assertScopesFor({ gated: false, tabId: null }, ['read', 'runs'])).not.toThrow();
    expect(toScopes(['runs', 'read'])).toEqual(['read', 'runs']);
  });

  it.each([
    ['gated (concierge)', { gated: true }],
    ['tab', { tabId: 'tab1' }],
  ])('refuses runs on a %s token with 422', (_n, kind) => {
    expect(() => assertScopesFor(kind, ['read', 'runs'])).toThrow(expect.objectContaining({ statusCode: 422, code: 'VALIDATION' }));
    expect(() => assertScopesFor(kind, ['read', 'memory'])).not.toThrow();
  });
});
