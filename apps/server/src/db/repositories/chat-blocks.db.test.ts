import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatBlocksRepository } from './chat-blocks.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatBlocksRepository (Postgres, TER-1164)', () => {
  let db: PrismaClient;
  let repo: ChatBlocksRepository;
  let userId: string;
  let otherUserId: string;
  let projectId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatBlocksRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    projectId = newId();
    await db.project.create({ data: { id: projectId, key: `BL${projectId.slice(0, 6).toUpperCase()}`, name: 'p1', ownerId: userId } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades the blocks
    await db.project.deleteMany({ where: { id: projectId } });
    await db.$disconnect();
  });

  it('creates a block, and the same one again is the same block with its effect updated', async () => {
    const a = await repo.create({ user_id: userId, project_id: projectId, kind: 'run_command', words: ['git', 'push'] });
    expect(a.created).toBe(true);
    expect(a.block).toMatchObject({ project_id: projectId, kind: 'run_command', words: ['git', 'push'], effect: 'ask', revoked_at: null });
    const b = await repo.create({ user_id: userId, project_id: projectId, kind: 'run_command', words: ['git', 'push'], effect: 'never' });
    expect(b.created).toBe(false);
    expect(b.block).toMatchObject({ id: a.block.id, effect: 'never' });
    const other = await repo.create({ user_id: userId, project_id: null, kind: 'run_command', words: ['git', 'push'] });
    expect(other.created).toBe(true);
  });

  it('lists only this user\'s blocks in force, and revokes only their own', async () => {
    const mine = await repo.create({ user_id: userId, project_id: null, kind: 'board' });
    await repo.create({ user_id: otherUserId, project_id: null, kind: 'board' });
    expect((await repo.listActive(userId)).map((b) => b.id)).toContain(mine.block.id);
    expect((await repo.listActive(otherUserId)).every((b) => b.user_id === otherUserId)).toBe(true);
    expect(await repo.revoke(mine.block.id, otherUserId)).toBeUndefined();
    const lifted = await repo.revoke(mine.block.id, userId);
    expect(lifted?.revoked_at).not.toBeNull();
    expect(await repo.revoke(mine.block.id, userId)).toBeUndefined();
    expect((await repo.listActive(userId)).map((b) => b.id)).not.toContain(mine.block.id);
    expect(await repo.countActive(userId)).toBe((await repo.listActive(userId)).length);
  });

  it('skips a row whose kind the code no longer knows', async () => {
    await db.chatBlock.create({ data: { id: newId(), userId, kind: 'retired_kind' } });
    expect((await repo.listActive(userId)).some((b) => (b.kind as string) === 'retired_kind')).toBe(false);
  });
});
