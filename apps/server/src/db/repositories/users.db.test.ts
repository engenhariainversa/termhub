import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { SYSTEM_ROLE_IDS } from './roles.js';
import { UsersRepository } from './users.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('UsersRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: UsersRepository;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new UsersRepository(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('reserves a nickname once', async () => {
    const a = await repo.create({ email: `${newId()}@x.dev`, name: 'A', role_id: SYSTEM_ROLE_IDS.authenticated });
    const b = await repo.create({ email: `${newId()}@x.dev`, name: 'B', role_id: SYSTEM_ROLE_IDS.authenticated });
    try {
      expect(await repo.setNickname(a.id, 'pedro')).toBe('ok');
      expect(await repo.setNickname(b.id, 'pedro')).toBe('taken');
      expect((await repo.findByNickname('pedro'))?.id).toBe(a.id);
      expect(await repo.findByNickname('nobody')).toBeUndefined();
    } finally {
      await db.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    }
  });

  // The write itself decides (setNickname attempts the update and catches the unique-index violation)
  // rather than checking first, so re-claiming your own nickname must not collide with yourself.
  it('lets the current holder reclaim their own nickname', async () => {
    const a = await repo.create({ email: `${newId()}@x.dev`, name: 'A', role_id: SYSTEM_ROLE_IDS.authenticated });
    try {
      expect(await repo.setNickname(a.id, 'pedro')).toBe('ok');
      expect(await repo.setNickname(a.id, 'pedro')).toBe('ok');
      expect((await repo.findByNickname('pedro'))?.id).toBe(a.id);
    } finally {
      await db.user.deleteMany({ where: { id: a.id } });
    }
  });

  // The lock lives in the write itself (a conditional update), not only in the route's check of the
  // session's user: two concurrent claims from the same account cannot both land.
  it('never changes a nickname once set', async () => {
    const a = await repo.create({ email: `${newId()}@x.dev`, name: 'A', role_id: SYSTEM_ROLE_IDS.authenticated });
    try {
      expect(await repo.setNickname(a.id, 'alice')).toBe('ok');
      expect(await repo.setNickname(a.id, 'alice2')).toBe('locked');
      expect((await repo.findByNickname('alice'))?.id).toBe(a.id);
      expect(await repo.findByNickname('alice2')).toBeUndefined();
    } finally {
      await db.user.deleteMany({ where: { id: a.id } });
    }
  });

  // The partner link is written once (TypeToAccess cannot edit or delete a link, so a second one
  // would be a wasted link, not a correction); the custom one comes and goes over it.
  it('keeps the first partner short link and lets a custom one come and go over it', async () => {
    const a = await repo.create({ email: `${newId()}@x.dev`, name: 'A', role_id: SYSTEM_ROLE_IDS.authenticated });
    try {
      expect(a.city_short_url_partner).toBeNull();
      expect(a.city_short_url_custom).toBeNull();
      expect(await repo.setCityShortUrlPartner(a.id, 'https://77a.it/pedro')).toBe(true);
      expect(await repo.setCityShortUrlPartner(a.id, 'https://77a.it/x9k2')).toBe(false);
      const custom = await repo.setCityShortUrlCustom(a.id, 'https://77a.it/meu-link');
      expect(custom.city_short_url_custom).toBe('https://77a.it/meu-link');
      expect(custom.city_short_url_partner).toBe('https://77a.it/pedro');
      const cleared = await repo.setCityShortUrlCustom(a.id, null);
      expect(cleared.city_short_url_custom).toBeNull();
      expect((await repo.findById(a.id))?.city_short_url_partner).toBe('https://77a.it/pedro');
    } finally {
      await db.user.deleteMany({ where: { id: a.id } });
    }
  });

  it('a deactivated account never answers on its own, even with the switch on (TER-720)', async () => {
    const a = await repo.create({ email: `${newId()}@x.dev`, name: 'A', role_id: SYSTEM_ROLE_IDS.authenticated });
    try {
      await repo.setChatAutodecide(a.id, true);
      expect(await repo.chatAutodecide(a.id)).toBe(true);
      await db.user.update({ where: { id: a.id }, data: { deletionRequestedAt: new Date(), deletionScheduledAt: new Date(Date.now() + 1000) } });
      expect(await repo.chatAutodecide(a.id)).toBe(false);
    } finally {
      await db.user.deleteMany({ where: { id: a.id } });
    }
  });
});
