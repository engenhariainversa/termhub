import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatCommandRulesRepository } from './chat-command-rules.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatCommandRulesRepository (Postgres, TER-1081)', () => {
  let db: PrismaClient;
  let repo: ChatCommandRulesRepository;
  let userId: string;
  let otherUserId: string;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatCommandRulesRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    projectId = newId();
    otherProjectId = newId();
    await db.project.create({ data: { id: projectId, key: `CR${projectId.slice(0, 6).toUpperCase()}`, name: 'p1', ownerId: userId } });
    await db.project.create({ data: { id: otherProjectId, key: `CR${otherProjectId.slice(0, 6).toUpperCase()}`, name: 'p2', ownerId: userId } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades the rules
    await db.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
    await db.$disconnect();
  });

  it('creates a rule, and the same one again returns it instead of a duplicate', async () => {
    const a = await repo.create({ user_id: userId, project_id: projectId, words: ['git', 'push'], match: 'prefix' });
    expect(a.created).toBe(true);
    expect(a.rule).toMatchObject({ project_id: projectId, words: ['git', 'push'], match: 'prefix', machine_ids: [], expires_at: null, revoked_at: null });
    const b = await repo.create({ user_id: userId, project_id: projectId, words: ['git', 'push'], match: 'prefix' });
    expect(b).toEqual({ rule: a.rule, created: false });
  });

  it('lists the project\'s and the global rules in force, never another project\'s or user\'s', async () => {
    const global = (await repo.create({ user_id: userId, project_id: null, words: ['npm', 'test'], match: 'exact' })).rule;
    const other = (await repo.create({ user_id: userId, project_id: otherProjectId, words: ['make'], match: 'prefix' })).rule;
    await repo.create({ user_id: otherUserId, project_id: null, words: ['ls'], match: 'exact' });
    const ids = (await repo.listActiveFor(userId, projectId)).map((r) => r.id);
    expect(ids).toContain(global.id);
    expect(ids).not.toContain(other.id);
    expect((await repo.listActiveFor(otherUserId, projectId)).every((r) => r.user_id === otherUserId)).toBe(true);
  });

  it('an expired rule is out of force and in the history', async () => {
    const now = new Date();
    const r = (await repo.create({ user_id: userId, project_id: projectId, words: ['df', '-h'], match: 'exact', expires_at: new Date(now.getTime() + 1000) }, now)).rule;
    const later = new Date(now.getTime() + 2000);
    expect((await repo.listActiveFor(userId, projectId, later)).map((x) => x.id)).not.toContain(r.id);
    expect((await repo.listForUser(userId, 'ended', later)).map((x) => x.id)).toContain(r.id);
  });

  it('revokes only the owner\'s rule, once', async () => {
    const r = (await repo.create({ user_id: userId, project_id: projectId, words: ['gh', 'pr', 'checks'], match: 'prefix', source_action_id: 'act9' })).rule;
    expect((await repo.findActiveBySourceAction(userId, 'act9'))?.id).toBe(r.id);
    expect(await repo.revoke(r.id, otherUserId)).toBeUndefined();
    expect((await repo.revoke(r.id, userId))?.revoked_by).toBe(userId);
    expect(await repo.revoke(r.id, userId)).toBeUndefined();
    expect(await repo.findActiveBySourceAction(userId, 'act9')).toBeUndefined();
    expect((await repo.listForUser(userId, 'active')).map((x) => x.id)).not.toContain(r.id);
  });

  it('a deleted project takes its rules with it', async () => {
    const p = newId();
    await db.project.create({ data: { id: p, key: `CR${p.slice(0, 6).toUpperCase()}`, name: 'gone', ownerId: userId } });
    const r = (await repo.create({ user_id: userId, project_id: p, words: ['ls'], match: 'exact' })).rule;
    await db.project.delete({ where: { id: p } });
    expect(await repo.findByIdForUser(r.id, userId)).toBeUndefined();
  });
});
