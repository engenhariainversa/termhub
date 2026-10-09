import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { MachinesRepository } from './machines.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see tasks.db.test.ts for the local Docker recipe).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('MachinesRepository.findByIdsForOwner (Postgres)', () => {
  let db: PrismaClient;
  let repo: MachinesRepository;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new MachinesRepository(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('finds machines by id in one query, filtered to one owner — another owner\'s machine does not resolve, neither does an orphan\'s', async () => {
    const ownerId = newId();
    const otherOwnerId = newId();
    const ownedMachineId = newId();
    const otherMachineId = newId();
    const orphanMachineId = newId();
    await db.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' },
      { id: otherOwnerId, email: `${otherOwnerId}@test.local`, name: 'other' },
    ] });
    try {
      await db.machine.createMany({ data: [
        { id: ownedMachineId, name: 'mine', type: 'agent', ownerId },
        { id: otherMachineId, name: 'theirs', type: 'agent', ownerId: otherOwnerId },
        { id: orphanMachineId, name: 'orphan', type: 'agent' }, // ownerId null — never resolves for a concrete owner either
      ] });

      const found = await repo.findByIdsForOwner([ownedMachineId, otherMachineId, orphanMachineId, 'nope'], ownerId);
      expect(found.map((m) => m.id)).toEqual([ownedMachineId]);
      expect(await repo.findByIdsForOwner([], ownerId)).toEqual([]);
    } finally {
      await db.machine.deleteMany({ where: { id: { in: [ownedMachineId, otherMachineId, orphanMachineId] } } });
      await db.user.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } });
    }
  });

  it('stores the subtitle on create, and sets, keeps and clears it on update', async () => {
    const ownerId = newId();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' } });
    try {
      const created = await repo.create({ name: 'mac', type: 'agent', owner_id: ownerId, subtitle: 'MacBook do escritório' });
      expect(created.subtitle).toBe('MacBook do escritório');
      expect((await repo.findById(created.id))?.subtitle).toBe('MacBook do escritório');
      // an update that does not mention it keeps it
      expect((await repo.update(created.id, { name: 'mac 2' }))?.subtitle).toBe('MacBook do escritório');
      expect((await repo.update(created.id, { subtitle: 'servidor da sala' }))?.subtitle).toBe('servidor da sala');
      expect((await repo.update(created.id, { subtitle: null }))?.subtitle).toBeNull();
      const raw = await db.$queryRaw<{ subtitle: string | null }[]>`SELECT subtitle FROM machines WHERE id = ${created.id}`;
      expect(raw).toEqual([{ subtitle: null }]);
      // no subtitle given: null
      const plain = await repo.create({ name: 'plain', type: 'agent', owner_id: ownerId });
      expect(plain.subtitle).toBeNull();
    } finally {
      await db.machine.deleteMany({ where: { ownerId } });
      await db.user.deleteMany({ where: { id: ownerId } });
    }
  });

  it('claude_auto_swap is on by default (TER-587), turned off on update, and kept on a later update that does not mention it', async () => {
    const ownerId = newId();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' } });
    try {
      const created = await repo.create({ name: 'mac', type: 'agent', owner_id: ownerId });
      expect(created.claude_auto_swap).toBe(true);
      const off = await repo.update(created.id, { claude_auto_swap: false });
      expect(off?.claude_auto_swap).toBe(false);
      expect((await repo.findById(created.id))?.claude_auto_swap).toBe(false);
      const renamed = await repo.update(created.id, { name: 'x' });
      expect(renamed?.claude_auto_swap).toBe(false);
    } finally {
      await db.machine.deleteMany({ where: { ownerId } });
      await db.user.deleteMany({ where: { id: ownerId } });
    }
  });

  it('ai_usage_query is on by default (TER-735), turned off on update, and kept on a later update that does not mention it', async () => {
    const ownerId = newId();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' } });
    try {
      const created = await repo.create({ name: 'mac', type: 'agent', owner_id: ownerId });
      expect(created.ai_usage_query).toBe(true);
      const off = await repo.update(created.id, { ai_usage_query: false });
      expect(off?.ai_usage_query).toBe(false);
      expect((await repo.findById(created.id))?.ai_usage_query).toBe(false);
      const renamed = await repo.update(created.id, { name: 'x' });
      expect(renamed?.ai_usage_query).toBe(false);
      const on = await repo.update(created.id, { ai_usage_query: true });
      expect(on?.ai_usage_query).toBe(true);
    } finally {
      await db.machine.deleteMany({ where: { ownerId } });
      await db.user.deleteMany({ where: { id: ownerId } });
    }
  });
});

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('MachinesRepository agent pairing (Postgres, TER-1017)', () => {
  let db: PrismaClient;
  let repo: MachinesRepository;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new MachinesRepository(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('a pairing token opens the machine once, before it expires, and revokes the legacy bearer', async () => {
    const id = newId();
    const pairing = `pair-${id}`;
    await db.machine.create({ data: { id, name: 'mac', type: 'agent', agentTokenHash: `legacy-${id}` } });
    try {
      expect((await repo.findById(id))?.agent_credential).toBe('bearer');
      await repo.startAgentPairing(id, pairing, new Date(Date.now() + 60_000));
      // "pair again" revokes the bearer at once
      expect(await repo.findByAgentTokenHash(`legacy-${id}`)).toBeUndefined();
      expect((await repo.findById(id))?.agent_credential).toBeNull();
      expect((await repo.findByPairingHash(pairing))?.id).toBe(id);

      expect(await repo.completeAgentPairing(id, pairing, 'KEY')).toBe(true);
      // burnt: the same token neither finds nor pairs the machine again
      expect(await repo.completeAgentPairing(id, pairing, 'OTHER')).toBe(false);
      expect(await repo.findByPairingHash(pairing)).toBeUndefined();
      expect(await repo.findDeviceKey(id)).toMatchObject({ publicKey: 'KEY', machine: { id, agent_credential: 'key' } });

      // pairing again revokes the key
      await repo.startAgentPairing(id, `${pairing}-2`, new Date(Date.now() + 60_000));
      expect(await repo.findDeviceKey(id)).toBeUndefined();
    } finally {
      await db.machine.deleteMany({ where: { id } });
    }
  });

  it('an expired pairing token neither finds nor pairs the machine', async () => {
    const id = newId();
    const pairing = `pair-${id}`;
    await db.machine.create({ data: { id, name: 'mac', type: 'agent' } });
    try {
      await repo.startAgentPairing(id, pairing, new Date(Date.now() - 1_000));
      expect(await repo.findByPairingHash(pairing)).toBeUndefined();
      expect(await repo.completeAgentPairing(id, pairing, 'KEY')).toBe(false);
      expect(await repo.findDeviceKey(id)).toBeUndefined();
    } finally {
      await db.machine.deleteMany({ where: { id } });
    }
  });
});
