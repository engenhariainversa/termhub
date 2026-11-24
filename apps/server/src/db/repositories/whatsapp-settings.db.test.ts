import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { WhatsappSettingsRepository } from './whatsapp-settings.js';

vi.mock('../../config.js', () => ({ config: { encryptionKey: Buffer.alloc(32, 7).toString('base64') } }));

const input = { server_url: 'https://wpp.example.com', instance: 'termhub', number: '5562999998888', enabled: true, notify_needs_you: true, notify_done: false };

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('WhatsappSettingsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: WhatsappSettingsRepository;
  let userId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new WhatsappSettingsRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'me' } });
    return async () => {
      await db.user.deleteMany({ where: { id: userId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('needs a key on the first save, stores it encrypted and keeps it on a save without one', async () => {
    await expect(repo.save(userId, input)).rejects.toThrow('WHATSAPP_KEY_REQUIRED');
    const saved = await repo.save(userId, { ...input, api_key: 'secret-key' });
    expect(saved).toMatchObject({ ...input, user_id: userId, last_error: null });
    expect(JSON.stringify(saved)).not.toContain('secret-key');
    const raw = await db.whatsappSettings.findUnique({ where: { userId } });
    expect(raw!.apiKey).not.toContain('secret-key');
    await repo.save(userId, { ...input, instance: 'other' });
    expect(await repo.apiKey(userId)).toBe('secret-key');
    expect((await repo.get(userId))!.instance).toBe('other');
  });

  it('records deliveries and goes away with the account', async () => {
    await repo.save(userId, { ...input, api_key: 'k' });
    await repo.noteDelivery(userId, 'AUTH');
    expect((await repo.get(userId))!.last_error).toBe('AUTH');
    await repo.noteDelivery(userId, null);
    const after = (await repo.get(userId))!;
    expect(after.last_error).toBeNull();
    expect(after.last_sent_at).not.toBeNull();
    await db.user.delete({ where: { id: userId } });
    expect(await db.whatsappSettings.count({ where: { userId } })).toBe(0);
  });
});
