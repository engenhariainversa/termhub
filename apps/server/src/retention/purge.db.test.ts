import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { newId } from '../lib/ids.js';
import { purgeRetention } from './purge.js';

const DAY = 24 * 60 * 60 * 1000;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('purgeRetention (Postgres)', () => {
  let db: PrismaClient;
  let repos: Repositories;
  const machineId = newId();
  const projectId = newId();
  const tabId = newId();
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repos = createRepositories(db);
    await db.machine.create({ data: { id: machineId, name: 'test', type: 'agent' } });
    await db.project.create({ data: { id: projectId, key: 'K' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p' } });
    await db.tab.create({ data: { id: tabId, projectId, machineId, name: 't', tmuxSession: `th-${tabId}` } });
    await db.tabLastAnswer.create({ data: { tabId, text: 'resposta antiga', tool: 'claude', at: ago(200) } });
  });

  afterAll(async () => {
    await db.project.delete({ where: { id: projectId } }); // cascades the tab
    await db.machine.delete({ where: { id: machineId } });
    await db.waitlistEntry.deleteMany({ where: { email: { endsWith: `@${projectId.toLowerCase()}.test` } } });
    await db.$disconnect();
  });

  it('drops tab events older than 90 days and keeps newer ones and the last answer', async () => {
    const event = (id: string, at: Date) => ({ id, tabId, kind: 'idle' as const, tool: 'claude', text: 'pronto', createdAt: at });
    const old = newId();
    const recent = newId();
    await db.tabEvent.createMany({ data: [event(old, ago(91)), event(recent, ago(89))] });

    await purgeRetention(repos, now);

    const left = await db.tabEvent.findMany({ where: { tabId }, select: { id: true } });
    expect(left.map((e) => e.id)).toEqual([recent]);
    expect(await db.tabLastAnswer.findUnique({ where: { tabId } })).not.toBeNull();
    expect(await db.tab.findUnique({ where: { id: tabId } })).not.toBeNull();
  });

  it('drops waitlist entries 12 months after signing up, or 12 months after the last invite', async () => {
    const entry = (name: string, createdAt: Date, invitedAt: Date | null) => ({
      id: newId(),
      firstName: name,
      lastName: 'Teste',
      email: `${name}@${projectId.toLowerCase()}.test`,
      phoneCountry: '55',
      phoneArea: '62',
      phoneNumber: '999999999',
      phone: '+5562999999999',
      createdAt,
      invitedAt,
    });
    const rows = [
      entry('antigo', ago(366), null),
      entry('recente', ago(364), null),
      entry('convidado-ha-tempo', ago(800), ago(366)),
      entry('convidado-recente', ago(800), ago(30)),
    ];
    await db.waitlistEntry.createMany({ data: rows });

    await purgeRetention(repos, now);

    const left = await db.waitlistEntry.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { firstName: true } });
    expect(left.map((r) => r.firstName).sort()).toEqual(['convidado-recente', 'recente']);
  });
});
