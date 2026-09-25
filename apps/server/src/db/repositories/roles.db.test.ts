import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { RolesRepository } from './roles.js';

/** The grants the migrations leave on the system roles — what a fresh install and production both get. */
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('system role grants after migrations (Postgres)', () => {
  let db: PrismaClient;
  let roles: RolesRepository;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    roles = new RolesRepository(db);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const hasGrant = async (roleName: string, resource: string, action: string) => {
    const role = await roles.findByName(roleName);
    if (!role) throw new Error(`role ${roleName} missing`);
    return (await roles.permissionsOf(role.id)).some((g) => g.resource === resource && g.action === action);
  };

  it('BETA, the role that has the chat, may use the terminal write tools the concierge calls', async () => {
    expect(await hasGrant('BETA', 'chat', 'create')).toBe(true);
    expect(await hasGrant('BETA', 'terminals', 'write')).toBe(true);
  });

  it('the roles without the chat keep no terminal write grant', async () => {
    expect(await hasGrant('AUTHENTICATED', 'terminals', 'write')).toBe(false);
    expect(await hasGrant('MANAGER', 'terminals', 'write')).toBe(false);
  });
});
