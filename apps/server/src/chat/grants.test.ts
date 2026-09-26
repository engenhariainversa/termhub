import { expect, it, vi } from 'vitest';
import { HttpError } from '../lib/errors.js';
import { decodeGrantCursor, encodeGrantCursor, listGrants } from './grants.js';

it('round-trips a cursor', () => {
  const c = { created_at: '2026-09-25T10:00:00.000Z', id: 'abc123' };
  expect(decodeGrantCursor(encodeGrantCursor(c))).toEqual(c);
});

it('refuses a cursor that is not one of ours with a 400', () => {
  const bad = ['nope', Buffer.from('no-separator').toString('base64url'), Buffer.from('yesterday|g1').toString('base64url'), Buffer.from('2026-09-25T10:00:00.000Z|').toString('base64url'), Buffer.from('2026-09-25|g1').toString('base64url')];
  for (const s of bad) {
    expect(() => decodeGrantCursor(s)).toThrow(HttpError);
    try {
      decodeGrantCursor(s);
    } catch (e) {
      expect((e as HttpError).code).toBe('INVALID_CURSOR');
    }
  }
});

it('listGrants passes the decoded cursor and encodes the next one', async () => {
  const listForUser = vi.fn(async () => ({ grants: [], next: { created_at: '2026-09-25T10:00:00.000Z', id: 'g9' } }));
  const repos = { chatGrants: { listForUser }, tabs: { findByIdsForOwner: vi.fn(async () => []) }, projects: { findByIdsForOwner: vi.fn(async () => []) } } as never;
  const cursor = encodeGrantCursor({ created_at: '2026-09-24T10:00:00.000Z', id: 'g1' });
  const now = new Date('2026-09-25T12:00:00.000Z');
  const res = await listGrants(repos, 'u1', { state: 'ended', cursor, limit: 20 }, now);
  expect(listForUser).toHaveBeenCalledWith('u1', { state: 'ended', cursor: { created_at: '2026-09-24T10:00:00.000Z', id: 'g1' }, limit: 20 }, now);
  expect(decodeGrantCursor(res.next_cursor!)).toEqual({ created_at: '2026-09-25T10:00:00.000Z', id: 'g9' });
});

it('listGrants with { state: "active", limit: 50 } always asks the repository for GRANT_LIST_MAX, since active is not paged and the query default must never silently truncate it', async () => {
  const listForUser = vi.fn(async () => ({ grants: [], next: null }));
  const repos = { chatGrants: { listForUser }, tabs: { findByIdsForOwner: vi.fn(async () => []) }, projects: { findByIdsForOwner: vi.fn(async () => []) } } as never;
  const now = new Date('2026-09-25T12:00:00.000Z');
  await listGrants(repos, 'u1', { state: 'active', limit: 50 }, now);
  expect(listForUser).toHaveBeenCalledWith('u1', { state: 'active', cursor: null, limit: 100 }, now);
});
