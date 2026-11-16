import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ApiTokensRepository } from './api-tokens.js';

const DAY = 24 * 60 * 60 * 1000;

// TER-1191: the paged, filtered list of Settings → Tokens de API, "Revogar inativos" and the retention purge.
// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ApiTokensRepository list, idle and purge (Postgres)', () => {
  let db: PrismaClient;
  let repo: ApiTokensRepository;
  let userId: string;
  let otherId: string;
  let projectId: string;
  let machineId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ApiTokensRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    otherId = newId();
    projectId = newId();
    machineId = newId();
    await db.user.createMany({
      data: [
        { id: userId, email: `${userId}@test.local`, name: 'me' },
        { id: otherId, email: `${otherId}@test.local`, name: 'other' },
      ],
    });
    await db.machine.create({ data: { id: machineId, name: 'jarvis', type: 'agent', ownerId: userId } });
    await db.project.create({ data: { id: projectId, key: `K${newId(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'termhub', ownerId: userId } });
    return async () => {
      await db.project.deleteMany({ where: { id: projectId } }); // cascades tabs
      await db.machine.deleteMany({ where: { id: machineId } });
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } }); // cascades tokens and events
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  type Over = { name?: string; origin?: 'person' | 'concierge' | 'tab' | 'automation'; created?: Date; used?: Date | null; revoked?: Date | null; expires?: Date | null; scopes?: ('read' | 'tasks' | 'memory')[] };
  /** A row written straight to the table, so each test sets its own dates. */
  async function row(owner: string, o: Over = {}) {
    const origin = o.origin ?? 'person';
    const t = await repo.create(
      owner,
      {
        name: o.name ?? origin,
        scopes: o.scopes ?? ['read'],
        expiresAt: o.expires ?? null,
        gated: origin === 'concierge',
        tabId: origin === 'tab' || origin === 'automation' ? `tab${newId(8)}` : null,
        origin,
        projectId: origin === 'person' ? null : projectId,
        machineId: origin === 'person' ? null : machineId,
      },
      newId(32),
    );
    await db.apiToken.update({ where: { id: t.id }, data: { createdAt: o.created ?? new Date(), lastUsedAt: o.used ?? null, revokedAt: o.revoked ?? null } });
    return t.id;
  }

  const ids = async (filter: Parameters<ApiTokensRepository['list']>[1], limit = 50) => (await repo.list(userId, filter, limit)).map((t) => t.id);

  it('pages newest first with a keyset cursor, never another user\'s rows', async () => {
    const now = Date.now();
    const a = await row(userId, { created: new Date(now - 3000) });
    const b = await row(userId, { created: new Date(now - 2000) });
    const c = await row(userId, { created: new Date(now - 1000) });
    await row(otherId);

    const first = await repo.list(userId, {}, 2);
    expect(first.map((t) => t.id)).toEqual([c, b]);
    const last = first[first.length - 1]!;
    expect(await ids({ before: { created_at: new Date(last.created_at), id: last.id } })).toEqual([a]);
  });

  it('keeps the order stable for rows created in the same millisecond', async () => {
    const at = new Date();
    const made = [await row(userId, { created: at }), await row(userId, { created: at }), await row(userId, { created: at })];
    const sorted = [...made].sort().reverse();
    const page1 = await repo.list(userId, {}, 2);
    const cut = page1[1]!;
    const page2 = await ids({ before: { created_at: new Date(cut.created_at), id: cut.id } });
    expect([...page1.map((t) => t.id), ...page2]).toEqual(sorted);
  });

  it('filters by origin, status, scope, project, machine, name and both periods', async () => {
    const now = Date.now();
    const mine = await row(userId, { name: 'Meu notebook', scopes: ['read', 'tasks'], used: new Date(now - 2 * DAY) });
    const chat = await row(userId, { origin: 'concierge', revoked: new Date(now - DAY), created: new Date(now - 10 * DAY) });
    const tab = await row(userId, { origin: 'tab', name: 'aba «shell» (automático)', expires: new Date(now - 1000) });
    const auto = await row(userId, { origin: 'automation', scopes: ['read', 'memory'] });

    expect(await ids({ origins: ['person'] })).toEqual([mine]);
    expect((await ids({ origins: ['concierge', 'tab', 'automation'] })).sort()).toEqual([chat, tab, auto].sort());
    expect(await ids({ status: 'revoked' })).toEqual([chat]);
    expect(await ids({ status: 'expired' })).toEqual([tab]);
    expect((await ids({ status: 'active' })).sort()).toEqual([mine, auto].sort());
    expect(await ids({ scope: 'tasks' })).toEqual([mine]);
    expect((await ids({ project_id: projectId })).sort()).toEqual([chat, tab, auto].sort());
    expect((await ids({ machine_id: machineId, origins: ['automation'] }))).toEqual([auto]);
    expect(await ids({ q: 'NOTEBOOK' })).toEqual([mine]);
    expect(await ids({ q: '«shell»' })).toEqual([tab]);
    expect(await ids({ created_to: new Date(now - 5 * DAY) })).toEqual([chat]);
    expect(await ids({ used_from: new Date(now - 3 * DAY), used_to: new Date(now - DAY) })).toEqual([mine]);
  });

  it('names the project and machine of the owner\'s own rows, and only the ids of anyone else\'s', async () => {
    await row(userId, { origin: 'tab' });
    const [t] = await repo.list(userId, {}, 1);
    expect(t).toMatchObject({ origin: 'tab', project_id: projectId, project_name: 'termhub', machine_id: machineId, machine_name: 'jarvis' });

    await db.machine.update({ where: { id: machineId }, data: { ownerId: otherId } });
    const [moved] = await repo.list(userId, {}, 1);
    expect(moved).toMatchObject({ machine_id: machineId, machine_name: null });
    expect(await repo.facets(userId)).toEqual({ projects: [{ id: projectId, name: 'termhub' }], machines: [{ id: machineId, name: null }] });
  });

  it('classifies a row the previous release minted without an origin the old way', async () => {
    const legacyChat = await row(userId, { origin: 'concierge' });
    const legacyTab = await row(userId, { origin: 'tab' });
    const legacyMine = await row(userId, { name: 'concierge do Pedro' });
    const legacyNamed = await repo.create(userId, { name: 'concierge (automático)', scopes: ['read'], expiresAt: null }, newId(32));
    await db.apiToken.updateMany({ where: { userId }, data: { origin: null } });

    expect(await ids({ origins: ['person'] })).toEqual([legacyMine]);
    expect((await ids({ origins: ['concierge'] })).sort()).toEqual([legacyChat, legacyNamed.id].sort());
    expect(await ids({ origins: ['tab'] })).toEqual([legacyTab]);
    const byId = new Map((await repo.list(userId, {}, 10)).map((t) => [t.id, t.origin]));
    expect(byId.get(legacyChat)).toBe('concierge');
    expect(byId.get(legacyNamed.id)).toBe('concierge');
    expect(byId.get(legacyTab)).toBe('tab');
    expect(byId.get(legacyMine)).toBe('person');
  });

  it('"Revogar inativos" takes live system tokens idle for 7 days, never a person\'s own nor a recent one', async () => {
    const now = Date.now();
    const idleTab = await row(userId, { origin: 'tab', created: new Date(now - 20 * DAY), used: new Date(now - 8 * DAY) });
    const neverUsed = await row(userId, { origin: 'automation', created: new Date(now - 9 * DAY) });
    const busyTab = await row(userId, { origin: 'tab', created: new Date(now - 20 * DAY), used: new Date(now - DAY) });
    const fresh = await row(userId, { origin: 'concierge' });
    const oldMine = await row(userId, { created: new Date(now - 100 * DAY) });
    const foreign = await row(otherId, { origin: 'tab', created: new Date(now - 20 * DAY) });

    expect(await repo.systemSummary(userId)).toEqual({ active: 4, idle: 2 });
    expect(await repo.revokeIdleSystem(userId)).toBe(2);
    const revoked = new Set(await ids({ status: 'revoked' }));
    expect(revoked).toEqual(new Set([idleTab, neverUsed]));
    for (const id of [busyTab, fresh, oldMine]) expect(revoked.has(id)).toBe(false);
    expect((await db.apiToken.findUnique({ where: { id: foreign } }))?.revokedAt).toBeNull();
    expect(await repo.systemSummary(userId)).toEqual({ active: 2, idle: 0 });
  });

  it('purges system tokens 30 days after they died and a person\'s revoked ones after 90, keeping a tab\'s opener', async () => {
    const now = Date.now();
    const ago = (d: number) => new Date(now - d * DAY);
    const goneChat = await row(userId, { origin: 'concierge', revoked: ago(31) });
    const goneTab = await row(userId, { origin: 'tab', expires: ago(31) });
    const recentChat = await row(userId, { origin: 'concierge', revoked: ago(29) });
    const liveAuto = await row(userId, { origin: 'automation', created: ago(200) });
    const mineRevoked60 = await row(userId, { revoked: ago(60) });
    const mineRevoked91 = await row(userId, { revoked: ago(91) });
    const mineExpired = await row(userId, { expires: ago(400) });
    const opener = await row(userId, { origin: 'concierge', revoked: ago(45) });
    await db.tab.create({ data: { id: newId(), projectId, machineId, name: 'aberta pelo chat', createdByTokenId: opener } });

    // the purge is instance-wide: other suites running at once may add rows of their own to the count
    expect(await repo.purgeStale(new Date(now))).toBeGreaterThanOrEqual(3);
    const left = new Set((await db.apiToken.findMany({ where: { userId }, select: { id: true } })).map((t) => t.id));
    expect(left).toEqual(new Set([recentChat, liveAuto, mineRevoked60, mineExpired, opener]));
    for (const id of [goneChat, goneTab, mineRevoked91]) expect(left.has(id)).toBe(false);
  });

  it('revokeLiveConcierge takes that conversation\'s live concierge tokens, and the legacy ones only for the account-wide chat', async () => {
    const x = await db.chatConversation.create({ data: { id: newId(), userId } });
    const y = await db.chatConversation.create({ data: { id: newId(), userId, projectId } });
    const mk = (conv: string | null, o: { gated?: boolean; name?: string } = {}) =>
      repo.create(userId, { name: o.name ?? 'concierge (automático)', scopes: ['read'], expiresAt: null, gated: o.gated ?? true, chatConversationId: conv }, newId(32)).then((t) => t.id);
    const x1 = await mk(x.id);
    const yTok = await mk(y.id);
    const legacy = await mk(null, { gated: false });
    const mine = await mk(null, { gated: false, name: 'meu' });
    await db.apiToken.update({ where: { id: legacy }, data: { origin: null } });

    expect(await repo.revokeLiveConcierge(userId, y.id)).toBe(1);
    expect(await repo.revokeLiveConcierge(userId, x.id, { accountWide: true })).toBe(2);
    const live = new Set(await ids({ status: 'active' }));
    expect(live).toEqual(new Set([mine]));
    for (const id of [x1, yTok, legacy]) expect(live.has(id)).toBe(false);
  });

  it('gatedIdsAmong answers only the owner\'s gated tokens', async () => {
    const chat = await row(userId, { origin: 'concierge' });
    const mine = await row(userId);
    const foreign = await row(otherId, { origin: 'concierge' });
    expect(await repo.gatedIdsAmong(userId, [chat, mine, foreign, 'nope'])).toEqual(new Set([chat]));
    expect(await repo.gatedIdsAmong(userId, [])).toEqual(new Set());
  });
});
