import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { DevicesRepository } from './devices.js';
import { PushTicketsRepository } from './push-tickets.js';

const MIN = 60_000;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('PushTicketsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: PushTicketsRepository;
  let devices: DevicesRepository;
  let userId: string;
  let deviceId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new PushTicketsRepository(db);
    devices = new DevicesRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    deviceId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'me' } });
    await db.device.create({
      data: { id: deviceId, userId, name: 'p', platform: 'ios', model: 'iPhone', osVersion: '18', appVersion: '0.6.0', publicKey: 'k', keyThumbprint: newId(), pinSecretEnc: 'x', pushToken: 'ExponentPushToken[a]' },
    });
    return async () => {
      await db.user.deleteMany({ where: { id: userId } }); // cascades the device and its tickets
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const at = (minutesAgo: number, now: Date) => new Date(now.getTime() - minutesAgo * MIN);

  it('claims due tickets once, takes a stale claim again, and leaves fresh ones', async () => {
    const now = new Date();
    await repo.recordMany([
      { ticket_id: 'old', device_id: deviceId, push_token: 'ExponentPushToken[a]', kind: 'reply' },
      { ticket_id: 'fresh', device_id: deviceId, push_token: 'ExponentPushToken[a]', kind: 'reply' },
    ]);
    await db.pushTicket.updateMany({ where: { deviceId, ticketId: 'old' }, data: { createdAt: at(20, now) } });

    const first = await repo.claimDue(at(15, now), at(30, now), now, 10);
    expect(first.map((t) => t.ticket_id)).toEqual(['old']);
    expect(first[0]).toMatchObject({ device_id: deviceId, push_token: 'ExponentPushToken[a]', kind: 'reply' });
    // Claimed just now: a second sweeper (the other color) gets nothing.
    expect(await repo.claimDue(at(15, now), at(30, now), now, 10)).toEqual([]);
    // Half an hour later the receipt was still missing: the claim is stale and taken again.
    const later = new Date(now.getTime() + 31 * MIN);
    expect((await repo.claimDue(at(15, later), at(30, later), later, 10)).map((t) => t.ticket_id).sort()).toEqual(['fresh', 'old']);

    await repo.deleteMany(first.map((t) => t.id));
    expect(await db.pushTicket.count({ where: { deviceId } })).toBe(1);
    expect(await repo.deleteSentBefore(new Date(now.getTime() + MIN))).toBe(1);
  });

  it('clearPushTokenIf clears only the token the push went to', async () => {
    expect(await devices.clearPushTokenIf(deviceId, 'ExponentPushToken[old]')).toBe(false);
    expect((await devices.findById(deviceId))?.push_token).toBe('ExponentPushToken[a]');
    expect(await devices.clearPushTokenIf(deviceId, 'ExponentPushToken[a]')).toBe(true);
    expect((await devices.findById(deviceId))?.push_token).toBeNull();
  });
});
