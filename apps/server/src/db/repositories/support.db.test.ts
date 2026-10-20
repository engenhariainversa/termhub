import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatActionsRepository } from './chat-actions.js';
import { SupportRepository } from './support.js';

const keyOf = (id: string) => 'S' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

/** Values seeded on purpose next to what the views read: none may come back. */
const SECRETS = ['pessoa-secreta', '203.0.113.77', 'segredo-na-tela', 'prompt-secreto', 'host.interno', 'Celular da Pessoa', 'tok-hash-'];

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('support views (Postgres, TER-1092)', () => {
  let db: PrismaClient;
  let support: SupportRepository;
  let userId: string;
  let otherId: string;
  let tabId: string;
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
  const window = () => ({ from: at(12 * 60), to: new Date(now + 1000) });

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    support = new SupportRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    otherId = newId();
    tabId = newId();
    const projectId = newId();
    const machineId = newId();
    const tokenId = newId();
    await db.user.create({ data: { id: userId, email: `pessoa-secreta+${userId}@test.local`, name: `Humberto ${userId}` } });
    await db.user.create({ data: { id: otherId, email: `${otherId}@test.local`, name: `Outra ${otherId}` } });
    await db.machine.create({ data: { id: machineId, name: 'MacBook do Humberto', type: 'agent', host: 'host.interno', ownerId: userId, network: { hostname: 'host.interno' } } });
    await db.project.create({ data: { id: projectId, ownerId: userId, key: keyOf(projectId), name: 'p' } });
    await db.tab.create({ data: { id: tabId, projectId, machineId, name: 'aba', state: 'waiting_input', stateText: 'segredo-na-tela', stateTool: 'claude', createdAt: at(60) } });
    await db.tabEvent.createMany({
      data: [
        { id: newId(), tabId, kind: 'working', tool: 'claude', text: 'prompt-secreto', createdAt: at(30) },
        { id: newId(), tabId, kind: 'working', tool: 'claude', text: 'prompt-secreto', createdAt: at(20) },
        { id: newId(), tabId, kind: 'waiting_input', tool: 'claude', text: 'segredo-na-tela', createdAt: at(10) },
        // before the window: not counted
        { id: newId(), tabId, kind: 'error', tool: 'claude', createdAt: at(24 * 60) },
      ],
    });
    const log = (minutesAgo: number, route: string, status: number, uid = userId) => ({
      createdAt: at(minutesAgo), ip: '203.0.113.77', userId: uid, kind: 'http', method: 'GET', route, status, client: 'web/1.4.0', os: 'macOS', durationMs: 15,
    });
    await db.accessLog.createMany({
      data: [log(5, '/api/tabs/:id', 200), log(6, '/api/chat', 502), log(7, '/api/projects', 200), log(13 * 60, '/api/tabs', 200), log(5, '/api/tabs', 200, otherId)],
    });
    await db.apiToken.create({ data: { id: tokenId, userId, name: 't', tokenHash: `tok-hash-${tokenId}`, scopes: ['read'] } });
    await db.apiTokenEvent.createMany({
      data: [
        { id: newId(), tokenId, tool: 'read_screen', ok: false, errorCode: 'AGENT_OFFLINE', durationMs: 40, createdAt: at(8) },
        { id: newId(), tokenId, tool: 'send_input', ok: false, errorCode: 'CONFIRMATION_WAITING', durationMs: 4, createdAt: at(9) },
        { id: newId(), tokenId, tool: 'list_tabs', ok: true, durationMs: 4, createdAt: at(9) },
      ],
    });
    await db.device.create({
      data: {
        id: newId(), userId, name: 'Celular da Pessoa', platform: 'ios', model: 'iPhone15,2', osVersion: '18.0', appVersion: '0.3.2+34', publicKey: 'pk', keyThumbprint: `th-${newId()}`, pinSecretEnc: 'x', lastIp: '203.0.113.77', lastSeenAt: at(3),
      },
    });
    return async () => {
      await db.accessLog.deleteMany({ where: { userId: { in: [userId, otherId] } } });
      await db.project.deleteMany({ where: { id: projectId } });
      await db.machine.deleteMany({ where: { id: machineId } });
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const leaks = (v: unknown) => SECRETS.filter((s) => JSON.stringify(v).includes(s));

  it('finds a user by name or e-mail and answers the id and name, never the e-mail', async () => {
    const byMail = await support.searchUsers(`pessoa-secreta+${userId}`, 10);
    expect(byMail).toEqual([{ user_id: userId, name: `Humberto ${userId}`, created_at: expect.any(String), last_login_at: null }]);
    expect((await support.searchUsers(`humberto ${userId}`, 10)).map((u) => u.user_id)).toEqual([userId]);
    expect(leaks(byMail)).toEqual([]);
  });

  it('lists the requests of that user only, in the window, filtered by route prefix', async () => {
    const rows = await support.requests(userId, window(), undefined, 10);
    expect(rows.map((r) => r.route)).toEqual(['/api/tabs/:id', '/api/chat', '/api/projects']);
    expect(rows[0]).toEqual({ at: expect.any(String), kind: 'http', method: 'GET', route: '/api/tabs/:id', status: 200, duration_ms: 15, client: 'web/1.4.0' });
    expect((await support.requests(userId, window(), '/api/tabs', 10)).map((r) => r.route)).toEqual(['/api/tabs/:id']);
    expect(leaks(rows)).toEqual([]);
  });

  it('lists the tabs with the machine name and the event counts by kind, never their text', async () => {
    const tabs = await support.tabs(userId, window(), 10);
    expect(tabs).toEqual([
      { tab_id: tabId, kind: 'terminal', agent: 'claude', machine_id: expect.any(String), machine_name: 'MacBook do Humberto', state: 'waiting_input', state_at: null, created_at: expect.any(String), events: { working: 2, waiting_input: 1 } },
    ]);
    expect(leaks(tabs)).toEqual([]);
  });

  it('lists 5xx answers and failed MCP calls, leaving out the chat gate\'s answers', async () => {
    const errors = await support.errors(userId, window(), 10);
    expect(errors.map((e) => e.route ?? e.tool)).toEqual(['/api/chat', 'read_screen']);
    expect(leaks(errors)).toEqual([]);
  });

  it('sums the clients and lists the paired phones without name or address', async () => {
    expect(await support.clients(userId, window())).toEqual([{ client: 'web/1.4.0', os: 'macOS', requests: 3, last_at: expect.any(String) }]);
    const devices = await support.devices(userId);
    expect(devices).toEqual([{ platform: 'ios', model: 'iPhone15,2', os_version: '18.0', app_version: '0.3.2+34', status: 'active', last_seen_at: expect.any(String) }]);
    expect(leaks(devices)).toEqual([]);
  });
});

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('chat actions: executedWithArg (Postgres, TER-1092)', () => {
  let db: PrismaClient;
  let actions: ChatActionsRepository;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    actions = new ChatActionsRepository(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('is true only once a query about that user ran in that conversation', async () => {
    const userId = newId();
    const conversationId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'u' } });
    await db.chatConversation.create({ data: { id: conversationId, userId } });
    try {
      const tool = 'admin_user_troubleshoot';
      const row = await actions.insertPending({ conversation_id: conversationId, tool, args: { endpoint: 'requests', user_id: 'u1', reason: 'TER-1091' }, class: 'write', idempotency_key: newId() });
      expect(await actions.executedWithArg(conversationId, tool, 'user_id', 'u1')).toBe(false);
      await actions.markExecuted(row.id, true);
      expect(await actions.executedWithArg(conversationId, tool, 'user_id', 'u1')).toBe(true);
      expect(await actions.executedWithArg(conversationId, tool, 'user_id', 'u2')).toBe(false);
      expect(await actions.executedWithArg(newId(), tool, 'user_id', 'u1')).toBe(false);
    } finally {
      await db.user.deleteMany({ where: { id: userId } });
    }
  });
});
