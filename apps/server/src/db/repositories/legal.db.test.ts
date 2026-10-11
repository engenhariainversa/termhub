import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { SYSTEM_ROLE_IDS } from './roles.js';
import { LegalRepository } from './legal.js';

const DAY = 24 * 60 * 60 * 1000;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
// The database is shared with the other suites: every row here carries a unique version string and is
// removed afterwards, and the assertions only look at this test's own rows.
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('LegalRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: LegalRepository;
  const versionIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new LegalRepository(db);
  });

  afterEach(async () => {
    await db.legalAcceptance.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { versionId: { in: versionIds } }] } });
    await db.legalDocumentVersion.deleteMany({ where: { id: { in: versionIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    versionIds.length = 0;
    userIds.length = 0;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function user() {
    const id = newId();
    await db.user.create({ data: { id, email: `legal-${id}@x.dev`, name: 'legal', roleId: SYSTEM_ROLE_IDS.authenticated } });
    userIds.push(id);
    return id;
  }

  async function version(days: number, opts: { document?: 'terms' | 'privacy'; requires_acceptance?: boolean } = {}) {
    const created = await repo.createVersion({
      document: opts.document ?? 'terms',
      version: `test-${newId()}`,
      effective_at: new Date(Date.now() + days * DAY),
      url: 'https://termhub.dev/termos/',
      requires_acceptance: opts.requires_acceptance ?? true,
      summary: null,
    });
    if (!created) throw new Error('version not created');
    versionIds.push(created.id);
    return created;
  }

  it('creates a version and refuses the same number twice for a document', async () => {
    const v = await version(-1);
    expect(await repo.findVersion(v.id)).toEqual(v);
    expect((await repo.listVersions()).map((x) => x.id)).toContain(v.id);
    const again = await repo.createVersion({ document: 'terms', version: v.version, effective_at: new Date(), url: v.url, requires_acceptance: false, summary: null });
    expect(again).toBeUndefined();
  });

  it('records acceptances with their origin, one row per version', async () => {
    const userId = await user();
    const a = await version(-2);
    const b = await version(-2, { document: 'privacy' });
    await repo.recordAcceptances(userId, [a.id, b.id, a.id], { ip: '10.0.0.1', user_agent: 'Firefox', channel: 'web' });
    const rows = await db.legalAcceptance.findMany({ where: { userId } });
    expect(rows.map((r) => r.versionId).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((r) => r.ip === '10.0.0.1' && r.userAgent === 'Firefox' && r.channel === 'web')).toBe(true);
    // what this person accepted is no longer asked of them
    const status = await repo.statusFor(userId);
    expect([...status.pending, ...status.upcoming].map((x) => x.id)).not.toContain(a.id);
    expect([...status.pending, ...status.upcoming].map((x) => x.id)).not.toContain(b.id);
  });

  it('an accepted version cannot be deleted, and acceptances go with their user', async () => {
    const userId = await user();
    const v = await version(-1);
    await repo.recordAcceptances(userId, [v.id], { ip: null, user_agent: null, channel: 'mobile' });
    await expect(db.legalDocumentVersion.delete({ where: { id: v.id } })).rejects.toThrow();
    await db.user.delete({ where: { id: userId } });
    expect(await db.legalAcceptance.count({ where: { versionId: v.id } })).toBe(0);
  });

  it('claims a due notice once, even when two colours claim at the same time', async () => {
    await version(-400);
    const due = await version(10);
    const later = await version(45);
    const minor = await version(5, { requires_acceptance: false });
    const [a, b] = await Promise.all([repo.claimDueNotices(), repo.claimDueNotices()]);
    const mine = [...a, ...b].map((x) => x.id).filter((id) => versionIds.includes(id));
    expect(mine).toEqual([due.id]);
    expect((await db.legalDocumentVersion.findUnique({ where: { id: due.id } }))?.noticeSentAt).not.toBeNull();
    for (const id of [later.id, minor.id]) expect((await db.legalDocumentVersion.findUnique({ where: { id } }))?.noticeSentAt).toBeNull();
    expect((await repo.claimDueNotices()).map((x) => x.id)).not.toContain(due.id);
  });
});
