import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { hashEmail } from '../../mobile/codes.js';
import { SYSTEM_ROLE_IDS } from './roles.js';
import { AccountDeletionRepository } from './account-deletion.js';

const DAY = 24 * 60 * 60 * 1000;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('AccountDeletionRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: AccountDeletionRepository;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new AccountDeletionRepository(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  /**
   * One account with a row in every table that hangs off it, directly or through what it owns:
   * a machine, a project with its board, an integration with a ticket, the chat, memory, devices,
   * the e-mail-keyed rows. Returns the ids the assertions look for.
   */
  async function seedAccount(label: string) {
    const userId = newId();
    const email = `${label}-${userId}@x.dev`;
    await db.user.create({ data: { id: userId, email, name: label, roleId: SYSTEM_ROLE_IDS.authenticated } });
    const machineId = newId();
    await db.machine.create({ data: { id: machineId, name: `${label} mac`, type: 'agent', ownerId: userId } });
    const projectId = newId();
    await db.project.create({ data: { id: projectId, key: `K${userId.slice(0, 6).toUpperCase()}`, name: `${label} project`, ownerId: userId } });
    await db.projectMachine.create({ data: { id: newId(), projectId, machineId, cwd: '/tmp' } });
    const columnId = newId();
    await db.taskColumn.create({ data: { id: columnId, projectId, name: 'A fazer', category: 'todo', position: 0 } });
    const tabId = newId();
    await db.tab.create({ data: { id: tabId, projectId, machineId, name: 'shell' } });
    await db.tabEvent.create({ data: { id: newId(), tabId, kind: 'working', tool: 'claude' } });
    await db.tabLastAnswer.create({ data: { tabId, text: 'ok', tool: 'claude', at: new Date() } });
    const taskId = newId();
    await db.task.create({ data: { id: taskId, projectId, title: 'card', columnId, status: 'todo' } });
    await db.note.create({ data: { id: newId(), projectId } });
    await db.projectSetup.create({ data: { projectId } });
    const integrationId = newId();
    await db.integration.create({ data: { id: integrationId, provider: 'github', name: 'gh', secret: 'enc', ownerId: userId } });
    const ticketId = newId();
    await db.ticket.create({
      data: { id: ticketId, projectId, integrationId, provider: 'github', syncKey: `github:o/r#${userId}`, key: 'o/r#1', title: 't', url: 'https://x', state: 'open', status: 'todo' },
    });
    await db.aiAccount.create({ data: { id: newId(), provider: 'claude', label: 'Claude', machineId } });
    await db.upload.create({ data: { id: newId(), userId, machineId, name: `paste-${userId}`, path: '/tmp/p', mime: 'text/plain', bytes: 1 } });
    const tokenId = newId();
    await db.apiToken.create({ data: { id: tokenId, userId, name: 'mcp', tokenHash: `h-${tokenId}` } });
    await db.apiTokenEvent.create({ data: { id: newId(), tokenId, tool: 'list_tabs', ok: true, durationMs: 1 } });
    const conversationId = newId();
    await db.chatConversation.create({ data: { id: conversationId, userId } });
    const messageId = newId();
    await db.chatMessage.create({ data: { id: messageId, conversationId, role: 'user', text: 'oi' } });
    const attachmentId = newId();
    await db.chatAttachment.create({ data: { id: attachmentId, userId, conversationId, messageId, name: 'a.txt', mime: 'text/plain', kind: 'text', bytes: 1, sha256: 'x' } });
    await db.chatAction.create({ data: { id: newId(), conversationId, tool: 'send_input', args: {}, class: 'write', status: 'pending' } });
    await db.chatStandingGrant.create({ data: { id: newId(), userId, projectId, kind: 'board' } });
    await db.chatDefaultRestriction.create({ data: { userId, kind: 'close_tab' } });
    await db.chatDecision.create({
      data: { id: newId(), userId, projectId, questionIndex: 0, header: 'h', question: 'q?', options: [], multiSelect: false, answer: {} },
    });
    await db.memoryItem.create({
      data: { id: newId(), ownerId: userId, projectId, kind: 'note', sourceId: newId(), title: 't', text: 'x', trust: 'person', contentHash: newId(), sourceAt: new Date() },
    });
    const groupId = newId();
    await db.projectGroup.create({ data: { id: groupId, userId, name: 'g' } });
    await db.projectGroupItem.create({ data: { groupId, projectId } });
    const deviceId = newId();
    await db.device.create({
      data: { id: deviceId, userId, name: 'iPhone', platform: 'ios', model: '15', osVersion: '18', appVersion: '1', publicKey: '{}', keyThumbprint: `t-${deviceId}`, pinSecretEnc: 'e' },
    });
    await db.deviceToken.create({ data: { id: newId(), deviceId, tokenHash: `d-${deviceId}`, expiresAt: new Date(Date.now() + DAY) } });
    await db.deviceEvent.create({ data: { id: newId(), userId, deviceId, kind: 'enrolled', actor: 'user' } });
    // An enrolment request of the account, and a decoy one (no user_id, only the e-mail's hash).
    await db.deviceRequest.create({
      data: {
        id: newId(), userId, emailHash: hashEmail(email), publicKey: '{}', keyThumbprint: `k2-${userId}`, platform: 'ios', model: '15', osVersion: '18', deviceName: 'x',
        appVersion: '1', verificationCode: '123456', requestSecretHash: `r2-${userId}`, ip: '1.1.1.1', expiresAt: new Date(Date.now() + DAY),
      },
    });
    await db.deviceRequest.create({
      data: {
        id: newId(), emailHash: hashEmail(email), publicKey: '{}', keyThumbprint: `k-${userId}`, platform: 'ios', model: '15', osVersion: '18', deviceName: 'x',
        appVersion: '1', verificationCode: '123456', requestSecretHash: `r-${userId}`, ip: '1.1.1.1', expiresAt: new Date(Date.now() + DAY),
      },
    });
    await db.userNotification.create({ data: { id: newId(), userId, kind: 'answer', title: 't', body: 'b' } });
    await db.session.create({ data: { id: newId(), userId, tokenHash: `s-${userId}`, expiresAt: new Date(Date.now() + DAY) } });
    await db.loginCode.create({ data: { id: newId(), email, codeHash: 'c', expiresAt: new Date(Date.now() + DAY) } });
    await db.loginAttempt.create({ data: { key: `email:${email}`, failures: 1 } });
    await db.waitlistEntry.create({
      data: { id: newId(), firstName: 'A', lastName: 'B', email, phoneCountry: '55', phoneArea: '62', phoneNumber: '999999999', phone: '+5562999999999' },
    });
    await db.accountDeletionLink.create({ data: { id: newId(), email, tokenHash: `l-${userId}`, expiresAt: new Date(Date.now() + DAY) } });
    return { userId, email, machineId, projectId, tabId, taskId, ticketId, integrationId, attachmentId, tokenId };
  }

  /** Every column named user_id or owner_id in the schema: the rule is "no row points at the deleted account". */
  async function userColumns(): Promise<{ table: string; column: string }[]> {
    return db.$queryRaw<{ table: string; column: string }[]>`
      SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('user_id', 'owner_id') ORDER BY table_name`;
  }

  async function rowsPointingAt(userId: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const { table, column } of await userColumns()) {
      const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`, userId);
      if (n > 0) out[`${table}.${column}`] = n;
    }
    return out;
  }

  async function cleanup(...userIds: string[]) {
    for (const id of userIds) await repo.purge(id).catch(() => undefined);
  }

  it('deletes every row of the account and of what it owns, and nothing of anyone else', async () => {
    const a = await seedAccount('alice');
    const b = await seedAccount('bob');
    try {
      // The seed really reaches every user_id / owner_id table the schema has, so the check below means something.
      const before = await rowsPointingAt(a.userId);
      const columns = (await userColumns()).map((c) => `${c.table}.${c.column}`);
      expect(Object.keys(before).sort()).toEqual(columns.filter((c) => c !== 'chat_live_runs.user_id').sort());

      const purged = await repo.purge(a.userId);
      expect(purged?.user.email).toBe(a.email);
      expect(purged?.machine_ids).toEqual([a.machineId]);
      expect(purged?.attachment_ids).toEqual([a.attachmentId]);

      expect(await rowsPointingAt(a.userId)).toEqual({});
      expect(await db.user.count({ where: { id: a.userId } })).toBe(0);
      expect(await db.machine.count({ where: { id: a.machineId } })).toBe(0);
      expect(await db.project.count({ where: { id: a.projectId } })).toBe(0);
      expect(await db.tab.count({ where: { id: a.tabId } })).toBe(0);
      expect(await db.task.count({ where: { id: a.taskId } })).toBe(0);
      expect(await db.ticket.count({ where: { id: a.ticketId } })).toBe(0);
      expect(await db.integration.count({ where: { id: a.integrationId } })).toBe(0);
      expect(await db.apiTokenEvent.count({ where: { tokenId: a.tokenId } })).toBe(0);
      // Rows keyed by e-mail.
      expect(await db.loginCode.count({ where: { email: a.email } })).toBe(0);
      expect(await db.loginAttempt.count({ where: { key: `email:${a.email}` } })).toBe(0);
      expect(await db.waitlistEntry.count({ where: { email: a.email } })).toBe(0);
      expect(await db.accountDeletionLink.count({ where: { email: a.email } })).toBe(0);
      expect(await db.deviceRequest.count({ where: { emailHash: hashEmail(a.email) } })).toBe(0);

      // The other account is untouched.
      expect(await rowsPointingAt(b.userId)).toEqual(before);
      expect(await db.ticket.count({ where: { id: b.ticketId } })).toBe(1);
      expect(await db.waitlistEntry.count({ where: { email: b.email } })).toBe(1);
      expect(await db.deviceRequest.count({ where: { emailHash: hashEmail(b.email) } })).toBe(2);
    } finally {
      await cleanup(a.userId, b.userId);
    }
  });

  it('revokes another account\'s tab token on a tab the cascade removes', async () => {
    const a = await seedAccount('alice');
    const b = await seedAccount('bob');
    const tokenId = newId();
    await db.apiToken.create({ data: { id: tokenId, userId: b.userId, name: 'tab', tokenHash: `tab-${tokenId}`, tabId: a.tabId } });
    try {
      await repo.purge(a.userId);
      expect((await db.apiToken.findUnique({ where: { id: tokenId } }))?.revokedAt).not.toBeNull();
    } finally {
      await cleanup(a.userId, b.userId);
    }
  });

  it('keeps the first schedule when asked twice, and cancel clears it', async () => {
    const a = await seedAccount('alice');
    try {
      const t0 = new Date('2026-10-01T12:00:00.000Z');
      const first = await repo.markRequested(a.userId, t0, new Date(t0.getTime() + 30 * DAY));
      expect(first?.deletion_scheduled_at).toBe('2026-10-31T12:00:00.000Z');
      const again = await repo.markRequested(a.userId, new Date(t0.getTime() + DAY), new Date(t0.getTime() + 31 * DAY));
      expect(again?.deletion_scheduled_at).toBe('2026-10-31T12:00:00.000Z');
      expect(again?.deletion_requested_at).toBe('2026-10-01T12:00:00.000Z');
      expect(await repo.cancel(a.userId)).toBe(true);
      expect(await repo.cancel(a.userId)).toBe(false);
      const row = await db.user.findUnique({ where: { id: a.userId } });
      expect(row?.deletionScheduledAt).toBeNull();
      expect(row?.deletionRequestedAt).toBeNull();
    } finally {
      await cleanup(a.userId);
    }
  });

  it('the job only finds and deletes accounts whose window is over', async () => {
    const due = await seedAccount('due');
    const early = await seedAccount('early');
    const active = await seedAccount('active');
    const now = new Date();
    try {
      await repo.markRequested(due.userId, new Date(now.getTime() - 31 * DAY), new Date(now.getTime() - DAY));
      await repo.markRequested(early.userId, new Date(now.getTime() - DAY), new Date(now.getTime() + 29 * DAY));
      const listed = await repo.listDue(now, 10_000);
      expect(listed).toContain(due.userId);
      expect(listed).not.toContain(early.userId);
      expect(listed).not.toContain(active.userId);
      // dueBy: an account not due (or cancelled meanwhile) is left alone.
      expect(await repo.purge(early.userId, { dueBy: now })).toBeUndefined();
      expect(await repo.purge(active.userId, { dueBy: now })).toBeUndefined();
      expect(await repo.purge(due.userId, { dueBy: now })).toBeDefined();
      expect(await db.user.count({ where: { id: { in: [due.userId, early.userId, active.userId] } } })).toBe(2);
      // Twice (the other app color): nothing left to do.
      expect(await repo.purge(due.userId, { dueBy: now })).toBeUndefined();
    } finally {
      await cleanup(due.userId, early.userId, active.userId);
    }
  });

  it('a deletion link is spent once and only while valid', async () => {
    const email = `link-${newId()}@x.dev`;
    const now = new Date();
    try {
      await repo.createLink(email, `h1-${email}`, new Date(now.getTime() + 60_000));
      await repo.createLink(email, `h2-${email}`, new Date(now.getTime() - 1));
      expect(await repo.countLinksSince(email, new Date(now.getTime() - 60_000))).toBe(2);
      expect(await repo.consumeLink(`h1-${email}`, now)).toBe(email);
      expect(await repo.consumeLink(`h1-${email}`, now)).toBeUndefined();
      expect(await repo.consumeLink(`h2-${email}`, now)).toBeUndefined();
      expect(await repo.consumeLink('nope', now)).toBeUndefined();
      expect(await repo.purgeExpiredLinks(now)).toBeGreaterThanOrEqual(1);
      expect(await db.accountDeletionLink.count({ where: { tokenHash: `h2-${email}` } })).toBe(0);
    } finally {
      await db.accountDeletionLink.deleteMany({ where: { email } });
    }
  });
});
