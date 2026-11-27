import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { normalizeSetup, SETUP_VERSION } from '../../setup/schema.js';
import { AiAccountsRepository } from './ai-accounts.js';
import { ChatRepository } from './chat.js';
import { ProjectSetupRepository } from './project-setup.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see tasks.db.test.ts / README).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('AI account login banner: dismissal and use (Postgres, TER-1212)', () => {
  let db: PrismaClient;
  let accounts: AiAccountsRepository;
  let setups: ProjectSetupRepository;
  let chat: ChatRepository;
  const users: string[] = [];
  const projects: string[] = [];

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    accounts = new AiAccountsRepository(db);
    setups = new ProjectSetupRepository(db);
    chat = new ChatRepository(db);
  });
  afterAll(async () => {
    await db?.project.deleteMany({ where: { id: { in: projects } } });
    await db?.machine.deleteMany({ where: { ownerId: { in: users } } });
    await db?.user.deleteMany({ where: { id: { in: users } } });
    await db?.$disconnect();
  });

  async function seed() {
    const userId = newId();
    users.push(userId);
    await db.user.create({ data: { id: userId, email: `dismiss-${userId}@example.com`, name: 'dismiss', passwordHash: 'x' } });
    const machineId = newId();
    await db.machine.create({ data: { id: machineId, name: 'jarvis', type: 'agent', ownerId: userId, agentTokenHash: `dismiss-${machineId}` } });
    const projectId = newId();
    projects.push(projectId);
    await db.project.create({ data: { id: projectId, ownerId: userId, key: 'D' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p' } });
    const account = await accounts.create({ provider: 'claude', label: 'abandonada', machine_id: machineId, config_dir: '~/.claude-old' });
    return { userId, machineId, projectId, account };
  }

  const withAccounts = (ids: string[]) => {
    const data = normalizeSetup(undefined, SETUP_VERSION);
    return { ...data, ai: { ...data.ai, accounts: ids } };
  };

  it('a dismissal is kept on the account and cleared on demand', async () => {
    const { account } = await seed();
    expect(account.login_warning_dismissed_at).toBeNull();
    const now = new Date('2026-11-27T12:00:00Z');
    await accounts.dismissLoginWarning(account.id, now);
    expect((await accounts.findById(account.id))?.login_warning_dismissed_at).toBe(now.toISOString());
    await accounts.clearLoginWarningDismissal([account.id]);
    expect((await accounts.findById(account.id))?.login_warning_dismissed_at).toBeNull();
  });

  it('adding the account back to a project\'s Setup re-arms the banner; saving it again does not', async () => {
    const { projectId, account } = await seed();
    await setups.save(projectId, withAccounts([account.id]));
    expect((await setups.listedAccountIds()).has(account.id)).toBe(true);
    await accounts.dismissLoginWarning(account.id, new Date());
    // still listed: saving the Setup again keeps the dismissal
    await setups.save(projectId, withAccounts([account.id]));
    expect((await accounts.findById(account.id))?.login_warning_dismissed_at).not.toBeNull();
    // removed, then added back: in use again, the banner returns
    await setups.save(projectId, withAccounts([]));
    expect((await setups.listedAccountIds()).has(account.id)).toBe(false);
    expect((await accounts.findById(account.id))?.login_warning_dismissed_at).not.toBeNull();
    await setups.save(projectId, withAccounts([account.id]));
    expect((await accounts.findById(account.id))?.login_warning_dismissed_at).toBeNull();
  });

  it('generalHosts reads the account-wide conversation\'s machine and account, never a project\'s', async () => {
    const { userId, machineId, projectId, account } = await seed();
    const general = await chat.getOrCreateForUser(userId);
    await chat.getOrCreateForProject(userId, projectId);
    await chat.setHost(general.id, { machine_id: machineId, ai_account_id: account.id });
    expect(await chat.generalHosts([userId])).toEqual([{ user_id: userId, machine_id: machineId, ai_account_id: account.id }]);
    expect(await chat.generalHosts([])).toEqual([]);
  });
});
