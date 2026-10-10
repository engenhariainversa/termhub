import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { Mail } from '../email/mailer.js';
import { hashToken } from '../auth/tokens.js';
import { invalidatePermissionCache } from '../auth/permissions.js';
import { AccountDeletionService, DELETION_GRACE_MS, DELETION_LINK_MAX_PER_HOUR, deletionStatus, isPendingDeletion } from './deletion.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const log = { info: () => {}, warn: () => {} } as unknown as FastifyBaseLogger;

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'u1', email: 'ana@gmail.com', name: 'Ana', avatar_url: null, nickname: null, city_short_url_partner: null, city_short_url_custom: null,
    password_hash: null, google_id: null, role: 'member', role_id: 'r-auth', invited_at: null, last_login_at: null, review_enabled_until: null,
    review_enabled_by: null, deletion_requested_at: null, deletion_scheduled_at: null, created_at: '', ...overrides,
  };
}

/** In-memory stand-ins for the repositories the service touches, plus every side effect recorded. */
function setup(opts: { users?: User[]; admin?: boolean; admins?: number; linksSent?: number } = {}) {
  invalidatePermissionCache();
  const users = new Map((opts.users ?? [user()]).map((u) => [u.id, u]));
  const sent: Mail[] = [];
  const links: { email: string; tokenHash: string; expiresAt: Date; used: boolean }[] = [];
  const purged: string[] = [];
  const sessionsDeleted: string[] = [];
  const repos = {
    users: {
      findByEmail: async (email: string) => [...users.values()].find((u) => u.email === email),
      countAdmins: async () => opts.admins ?? 1,
    },
    roles: {
      findById: async (id: string) => ({ id, name: 'X', label: 'X', is_admin: !!opts.admin, is_system: true, description: null, created_at: '' }),
      permissionsOf: async () => [],
    },
    sessions: { deleteAllForUser: async (id: string) => void sessionsDeleted.push(id) },
    accountDeletion: {
      markRequested: async (id: string, requestedAt: Date, scheduledAt: Date) => {
        const u = users.get(id);
        if (!u) return undefined;
        if (!u.deletion_scheduled_at) users.set(id, { ...u, deletion_requested_at: requestedAt.toISOString(), deletion_scheduled_at: scheduledAt.toISOString() });
        return users.get(id);
      },
      cancel: async (id: string) => {
        const u = users.get(id);
        if (!u?.deletion_scheduled_at) return false;
        users.set(id, { ...u, deletion_requested_at: null, deletion_scheduled_at: null });
        return true;
      },
      listDue: async (now: Date) => [...users.values()].filter((u) => u.deletion_scheduled_at && new Date(u.deletion_scheduled_at) <= now).map((u) => u.id),
      purge: async (id: string, o: { dueBy?: Date }) => {
        const u = users.get(id);
        if (!u) return undefined;
        if (o.dueBy && (!u.deletion_scheduled_at || new Date(u.deletion_scheduled_at) > o.dueBy)) return undefined;
        users.delete(id);
        purged.push(id);
        return { user: u, machine_ids: ['m1', 'm2'], attachment_ids: ['a1', 'a2'] };
      },
      purgeExpiredLinks: async () => 0,
      countLinksSince: async () => opts.linksSent ?? 0,
      createLink: async (email: string, tokenHash: string, expiresAt: Date) => void links.push({ email, tokenHash, expiresAt, used: false }),
      consumeLink: async (tokenHash: string, now: Date) => {
        const l = links.find((x) => x.tokenHash === tokenHash && !x.used && x.expiresAt > now);
        if (!l) return undefined;
        l.used = true;
        return l.email;
      },
    },
  } as unknown as Repositories;
  const removed: string[] = [];
  const disconnected: string[] = [];
  const gone: { userId: string; machineIds: string[] }[] = [];
  const accessRemoved: string[] = [];
  let now = NOW;
  const service = new AccountDeletionService({
    repos,
    mailer: { send: async (m) => void sent.push(m) },
    access: { remove: async (email) => void accessRemoved.push(email) },
    removeAttachment: async (userId, id) => void removed.push(`${userId}/${id}`),
    disconnectMachine: (id) => void disconnected.push(id),
    ownerGone: (userId, machineIds) => void gone.push({ userId, machineIds }),
    appUrl: 'https://app.termhub.dev',
    pageUrl: 'https://termhub.dev/excluir-conta/',
    log,
    now: () => now,
  });
  return { service, users, sent, links, purged, sessionsDeleted, removed, disconnected, gone, accessRemoved, setNow: (d: Date) => (now = d) };
}

describe('AccountDeletionService.request', () => {
  it('deactivates the account for 30 days, ends every session and e-mails the final date', async () => {
    const t = setup();
    const updated = await t.service.request(user(), 'web');
    expect(updated.deletion_requested_at).toBe(NOW.toISOString());
    expect(updated.deletion_scheduled_at).toBe(new Date(NOW.getTime() + DELETION_GRACE_MS).toISOString());
    expect(updated.deletion_scheduled_at).toBe('2026-10-31T12:00:00.000Z');
    expect(isPendingDeletion(updated)).toBe(true);
    expect(t.sessionsDeleted).toEqual(['u1']);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.to).toBe('ana@gmail.com');
    expect(t.sent[0]!.text).toContain('31 de outubro de 2026');
    expect(t.sent[0]!.text).toContain('Cancelar exclusão');
  });

  it('asking again keeps the first date and sends no second e-mail', async () => {
    const t = setup();
    const first = await t.service.request(user(), 'web');
    t.setNow(new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000));
    const again = await t.service.request(first, 'mobile');
    expect(again.deletion_scheduled_at).toBe(first.deletion_scheduled_at);
    expect(t.sent).toHaveLength(1);
  });

  it('refuses the last administrator, before touching anything', async () => {
    const t = setup({ admin: true, admins: 1 });
    await expect(t.service.request(user(), 'web')).rejects.toMatchObject({ statusCode: 409, code: 'LAST_ADMIN' });
    expect(t.users.get('u1')!.deletion_scheduled_at).toBeNull();
    expect(t.sessionsDeleted).toEqual([]);
  });

  it('lets an administrator go when another one remains', async () => {
    const t = setup({ admin: true, admins: 2 });
    const updated = await t.service.request(user(), 'web');
    expect(updated.deletion_scheduled_at).not.toBeNull();
  });
});

describe('AccountDeletionService.cancel', () => {
  it('lifts a pending deletion and confirms it by e-mail', async () => {
    const t = setup();
    const pending = await t.service.request(user(), 'web');
    expect(await t.service.cancel(pending)).toBe(true);
    expect(t.users.get('u1')!.deletion_scheduled_at).toBeNull();
    expect(t.sent.map((m) => m.subject)).toEqual(['Recebemos o pedido de exclusão da sua conta', 'A exclusão da sua conta foi cancelada']);
  });

  it('is a no-op, without e-mail, when nothing was pending', async () => {
    const t = setup();
    expect(await t.service.cancel(user())).toBe(false);
    expect(t.sent).toEqual([]);
  });
});

describe('AccountDeletionService.purge and the job', () => {
  it('cleans up outside the database: files, agents, public city, Access, then a final e-mail', async () => {
    const t = setup();
    expect(await t.service.purge('u1', { actor: 'admin:x' })).toBe(true);
    expect(t.purged).toEqual(['u1']);
    expect(t.removed).toEqual(['u1/a1', 'u1/a2']);
    expect(t.disconnected).toEqual(['m1', 'm2']);
    expect(t.gone).toEqual([{ userId: 'u1', machineIds: ['m1', 'm2'] }]);
    expect(t.accessRemoved).toEqual(['ana@gmail.com']);
    expect(t.sent.map((m) => m.subject)).toEqual(['Sua conta do termhub foi excluída']);
    expect(t.sent[0]!.text).not.toContain('cópias de segurança');
  });

  it('the final e-mail tells when the copies in backups go, when the instance keeps backups (TER-745)', async () => {
    const t = setup();
    const svc = new AccountDeletionService({
      ...(t.service as unknown as { deps: ConstructorParameters<typeof AccountDeletionService>[0] }).deps,
      backupRetentionDays: 30,
    });
    await svc.purge('u1', { actor: 'job' });
    expect(t.sent[0]!.text).toContain('apagadas em até 30 dias');
  });

  it('notify: false sends no e-mail (an admin deletion)', async () => {
    const t = setup();
    await t.service.purge('u1', { actor: 'admin:x', notify: false });
    expect(t.sent).toEqual([]);
  });

  it('a failing file removal or Access call never undoes the deletion', async () => {
    const t = setup();
    const svc = new AccountDeletionService({
      ...(t.service as unknown as { deps: ConstructorParameters<typeof AccountDeletionService>[0] }).deps,
      removeAttachment: async () => Promise.reject(new Error('EIO')),
      access: { remove: async () => Promise.reject(new Error('cloudflare down')) },
    });
    expect(await svc.purge('u1', { actor: 'job' })).toBe(true);
    expect(t.purged).toEqual(['u1']);
  });

  it('the job deletes only accounts whose 30 days are over', async () => {
    const t = setup({ users: [user({ id: 'due', email: 'a@x.dev' }), user({ id: 'early', email: 'b@x.dev' }), user({ id: 'active', email: 'c@x.dev' })] });
    await t.service.request(t.users.get('due')!, 'web');
    t.setNow(new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000));
    await t.service.request(t.users.get('early')!, 'web');
    // 29 days after the first request: nothing is due yet.
    t.setNow(new Date(NOW.getTime() + DELETION_GRACE_MS - 60_000));
    expect(await t.service.runDue()).toBe(0);
    // Past 30 days: the first account goes; the second (10 days later) and the active one stay.
    t.setNow(new Date(NOW.getTime() + DELETION_GRACE_MS + 60_000));
    expect(await t.service.runDue()).toBe(1);
    expect(t.purged).toEqual(['due']);
    expect([...t.users.keys()].sort()).toEqual(['active', 'early']);
  });

  it('an account cancelled before its date is never deleted by the job', async () => {
    const t = setup();
    const pending = await t.service.request(user(), 'web');
    await t.service.cancel(pending);
    t.setNow(new Date(NOW.getTime() + DELETION_GRACE_MS + 60_000));
    expect(await t.service.runDue()).toBe(0);
    expect(t.users.has('u1')).toBe(true);
  });
});

describe('AccountDeletionService public page links', () => {
  it('e-mails a single-use link to an existing account, and spending it requests the deletion', async () => {
    const t = setup();
    await t.service.sendLink('  ANA@gmail.com ');
    expect(t.links).toHaveLength(1);
    const mail = t.sent[0]!;
    expect(mail.to).toBe('ana@gmail.com');
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    expect(mail.text).toContain('https://termhub.dev/excluir-conta/?token=');
    expect(t.links[0]!.tokenHash).toBe(hashToken(token));
    const confirmed = await t.service.confirmLink(token);
    expect(confirmed?.deletion_scheduled_at).toBe('2026-10-31T12:00:00.000Z');
    // Used once: the second click does nothing.
    expect(await t.service.confirmLink(token)).toBeUndefined();
  });

  it('an expired link is refused', async () => {
    const t = setup();
    await t.service.sendLink('ana@gmail.com');
    const token = /token=([A-Za-z0-9_-]+)/.exec(t.sent[0]!.text)![1]!;
    t.setNow(new Date(NOW.getTime() + 31 * 60 * 1000));
    expect(await t.service.confirmLink(token)).toBeUndefined();
    expect(t.users.get('u1')!.deletion_scheduled_at).toBeNull();
  });

  it('sends nothing for an unknown address, a pending account or past the hourly cap', async () => {
    const unknown = setup();
    await unknown.service.sendLink('nobody@gmail.com');
    expect(unknown.sent).toEqual([]);

    const pending = setup({ users: [user({ deletion_scheduled_at: '2026-10-20T00:00:00.000Z' })] });
    await pending.service.sendLink('ana@gmail.com');
    expect(pending.sent).toEqual([]);

    const capped = setup({ linksSent: DELETION_LINK_MAX_PER_HOUR });
    await capped.service.sendLink('ana@gmail.com');
    expect(capped.sent).toEqual([]);
    expect(capped.links).toEqual([]);
  });
});

describe('deletionStatus', () => {
  it('says pending only while a date is set', () => {
    expect(deletionStatus(user())).toEqual({ pending: false, requested_at: null, scheduled_at: null });
    expect(deletionStatus(user({ deletion_requested_at: 'a', deletion_scheduled_at: 'b' }))).toEqual({ pending: true, requested_at: 'a', scheduled_at: 'b' });
  });
});
