import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { DataExportsRepository } from './data-exports.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see tasks.db.test.ts / README).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('DataExportsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: DataExportsRepository;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new DataExportsRepository(db);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  /** One account with a bit of everything; every text carries `tag` so a leak is easy to spot. */
  async function seedAccount(tag: string) {
    const userId = newId();
    await db.user.create({ data: { id: userId, email: `${tag}-${userId}@example.com`, name: `nome-${tag}`, passwordHash: `senha-${tag}` } });
    const machineId = newId();
    await db.machine.create({ data: { id: machineId, name: `maquina-${tag}`, type: 'agent', ownerId: userId, agentTokenHash: `agenthash-${tag}-${machineId}` } });
    const projectId = newId();
    await db.project.create({ data: { id: projectId, key: 'X' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: `projeto-${tag}`, ownerId: userId } });
    await db.projectMachine.create({ data: { id: newId(), projectId, machineId, cwd: `/home/${tag}` } });
    const tabId = newId();
    await db.tab.create({ data: { id: tabId, projectId, machineId, name: `aba-${tag}` } });
    await db.tabLastAnswer.create({ data: { tabId, text: `resposta-${tag}`, tool: 'claude', at: new Date() } });
    await db.task.create({ data: { id: newId(), projectId, title: `card-${tag}`, status: 'backlog' } });
    await db.note.create({ data: { id: newId(), projectId, content: `nota-${tag}` } });
    const integrationId = newId();
    await db.integration.create({ data: { id: integrationId, provider: 'github', name: `integracao-${tag}`, secret: `segredo-${tag}`, ownerId: userId } });
    await db.ticket.create({
      data: { id: newId(), projectId, integrationId, provider: 'github', syncKey: `github:${tag}#${projectId}`, key: `${tag}#1`, title: `ticket-${tag}`, url: 'https://x', state: 'open', status: 'todo' },
    });
    const conversationId = newId();
    await db.chatConversation.create({ data: { id: conversationId, userId, projectId } });
    await db.chatMessage.create({ data: { id: newId(), conversationId, role: 'user', text: `mensagem-${tag}` } });
    await db.chatAction.create({ data: { id: newId(), conversationId, tool: 'list_tabs', args: { note: `acao-${tag}` }, class: 'read', status: 'executed' } });
    await db.tabQuestion.create({ data: { id: newId(), tabId, projectId, conversationId, kind: 'choice', payload: { q: `pergunta-${tag}` }, status: 'open' } });
    await db.chatAttachment.create({ data: { id: newId(), userId, conversationId, name: `anexo-${tag}.txt`, mime: 'text/plain', kind: 'text', bytes: 3, sha256: 'x' } });
    await db.chatDecision.create({ data: { id: newId(), userId, projectId, questionIndex: 0, header: 'h', question: `decisao-${tag}`, options: [], multiSelect: false, answer: {} } });
    await db.memoryItem.create({ data: { id: newId(), ownerId: userId, projectId, kind: 'note', sourceId: newId(), title: 't', text: `memoria-${tag}`, trust: 'person', contentHash: 'h', sourceAt: new Date() } });
    await db.aiAccount.create({ data: { id: newId(), provider: 'claude', label: `conta-ia-${tag}`, machineId } });
    await db.apiToken.create({ data: { id: newId(), userId, name: `token-${tag}`, tokenHash: `tokenhash-${tag}-${userId}`, scopes: ['read'] } });
    await db.device.create({
      data: {
        id: newId(), userId, name: `aparelho-${tag}`, platform: 'ios', model: 'm', osVersion: '1', appVersion: '1', publicKey: 'pk',
        keyThumbprint: `thumb-${tag}-${userId}`, pinSecretEnc: `pin-${tag}`, pushToken: `push-${tag}`,
      },
    });
    await db.userNotification.create({ data: { id: newId(), userId, kind: 'test', title: `notificacao-${tag}`, body: 'b' } });
    return { userId, machineId, projectId, integrationId, conversationId };
  }

  let ana: Awaited<ReturnType<typeof seedAccount>>;
  let bia: Awaited<ReturnType<typeof seedAccount>>;
  beforeEach(async () => {
    ana = await seedAccount('ana');
    bia = await seedAccount('bia');
    return async () => {
      for (const a of [ana, bia]) {
        await db.ticket.deleteMany({ where: { integrationId: a.integrationId } });
        await db.project.deleteMany({ where: { ownerId: a.userId } });
        await db.machine.deleteMany({ where: { ownerId: a.userId } });
        await db.integration.deleteMany({ where: { ownerId: a.userId } });
        await db.user.delete({ where: { id: a.userId } });
      }
    };
  });

  it("collects all of the account's data, nothing of another account's and no secret", async () => {
    // Bia (an admin viewing as Ana, say) has her own chat about Ana's project: it is Bia's, not Ana's.
    const crossId = newId();
    await db.chatConversation.create({ data: { id: crossId, userId: bia.userId, projectId: ana.projectId } });
    await db.chatMessage.create({ data: { id: newId(), conversationId: crossId, role: 'user', text: 'mensagem-bia-no-projeto-da-ana' } });

    const bundle = (await repo.collect(ana.userId))!;
    const text = JSON.stringify(bundle);
    for (const expected of ['nome-ana', 'maquina-ana', 'projeto-ana', '/home/ana', 'aba-ana', 'resposta-ana', 'card-ana', 'nota-ana', 'integracao-ana', 'ticket-ana', 'mensagem-ana', 'acao-ana', 'pergunta-ana', 'anexo-ana', 'decisao-ana', 'memoria-ana', 'conta-ia-ana', 'token-ana', 'aparelho-ana', 'notificacao-ana']) {
      expect(text, expected).toContain(expected);
    }
    // Ids never hold '-': every seeded text of Bia's is '…-bia' or 'bia-…'.
    expect(text).not.toContain('-bia');
    expect(text).not.toContain('bia-');
    expect(text).not.toContain(bia.userId);
    for (const secret of ['senha-ana', 'agenthash-ana', 'segredo-ana', 'tokenhash-ana', 'pin-ana', 'push-ana']) expect(text, secret).not.toContain(secret);
    expect(bundle.account.email).toMatch(/^ana-/);
    expect(bundle.conversations.map((c) => c.id)).toEqual([ana.conversationId]);
    expect(bundle.cards[0]).toHaveProperty('project_id', ana.projectId);
  });

  it('counts the daily limit without failed requests, and claims a request once', async () => {
    const since = new Date(Date.now() - 60_000);
    const first = await repo.create(ana.userId);
    expect((await repo.latestCountedSince(ana.userId, since))?.id).toBe(first.id);
    expect(await repo.latestCountedSince(bia.userId, since)).toBeUndefined();

    const now = new Date();
    const stale = new Date(now.getTime() - 30 * 60_000);
    const [a, b] = await Promise.all([repo.claim(first.id, now, stale, 3), repo.claim(first.id, now, stale, 3)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await repo.markFailed(first.id, 'BUILD_FAILED', now);
    expect(await repo.latestCountedSince(ana.userId, since)).toBeUndefined();

    const second = await repo.create(ana.userId);
    await repo.claim(second.id, now, stale, 3);
    expect(await repo.markReady(second.id, 123, now, new Date(now.getTime() - 1))).toBe(true);
    expect((await repo.findById(second.id))?.bytes).toBe(123);
    expect(await repo.liveFileIds([first.id, second.id])).toEqual(new Set([second.id]));
    expect(await repo.expireDue(now)).toContain(second.id);
    expect((await repo.findById(second.id))?.status).toBe('expired');
  });
});
