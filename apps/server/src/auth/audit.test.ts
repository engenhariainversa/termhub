import { describe, expect, it, vi } from 'vitest';
import { recordSecurityEvent, securityEventCutoff, viewAsIdOf } from './audit.js';
import { opensOthersTerminal } from '../terminal/ws.js';
import type { Scope } from './scope.js';

const me = { id: 'u1' } as Scope['user'];
const other = { id: 'u2' } as Scope['user'];
const self: Scope = { user: me, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
const asOther: Scope = { user: me, viewAs: { kind: 'user', user: other }, ownerId: 'u2', createAs: 'u2' };
const asAll: Scope = { user: me, viewAs: { kind: 'all' }, ownerId: null, createAs: 'u1' };

describe('security trail helpers', () => {
  it('names the person an admin views as, "*" for everyone, null for themselves', () => {
    expect(viewAsIdOf(self)).toBeNull();
    expect(viewAsIdOf(asOther)).toBe('u2');
    expect(viewAsIdOf(asAll)).toBe('*');
    expect(viewAsIdOf(undefined)).toBeNull();
  });

  it('cuts off by whole days', () => {
    expect(securityEventCutoff(365, Date.UTC(2026, 9, 7)).toISOString()).toBe('2025-10-07T00:00:00.000Z');
  });

  it('logs a failed write and swallows it', async () => {
    const warn = vi.fn();
    const repos = { securityEvents: { record: vi.fn(async () => Promise.reject(new Error('db down'))) } };
    await expect(recordSecurityEvent(repos as never, { action: 'auth.logout' }, { warn } as never)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith({ action: 'auth.logout', err: 'db down' }, 'security trail: write failed');
  });

  it('flags a terminal opened only through view-as', () => {
    expect(opensOthersTerminal(self, { owner_id: 'u1' })).toBe(false);
    expect(opensOthersTerminal(asOther, { owner_id: 'u2' })).toBe(true);
    // "all" on an admin's own project is still their own terminal
    expect(opensOthersTerminal(asAll, { owner_id: 'u1' })).toBe(false);
    expect(opensOthersTerminal(asAll, { owner_id: 'u3' })).toBe(true);
  });
});
