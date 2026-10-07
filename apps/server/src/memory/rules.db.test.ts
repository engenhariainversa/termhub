import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { newId } from '../lib/ids.js';
import { approveRule, refreshRules, rejectRule, removeRule } from './rules-service.js';

const log = { info: () => {}, warn: () => {} };
const unit = (i: number) => Array.from({ length: 384 }, (_, k) => (k === i ? 1 : 0));

// Needs a migrated Postgres with pgvector: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('current rules (Postgres)', () => {
  let db: PrismaClient;
  let repos: Repositories;
  let ownerId: string;
  const projectIds: string[] = [];
  const deps = () => ({ embedder: { embed: async () => ({ model: 'm', vectors: [] }) }, log, threshold: 0.9 });

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repos = createRepositories(db);
    ownerId = newId();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'o' } });
    for (let i = 0; i < 4; i++) {
      const id = newId();
      projectIds.push(id);
      await db.project.create({ data: { id, ownerId, key: 'R' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: `p${i}` } });
    }
  });

  afterAll(async () => {
    await db.memoryRule.deleteMany({ where: { ownerId } });
    await db.memoryItem.deleteMany({ where: { ownerId } });
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.user.deleteMany({ where: { id: ownerId } });
    await db?.$disconnect();
  });

  const note = async (projectId: string | null, decision: string) => {
    const id = newId();
    await repos.memoryItems.upsertMany([
      { id, owner_id: ownerId, project_id: projectId, kind: 'note', source_id: id, chunk_index: 0, title: 'Pergunta', text: `Decisão: ${decision}\nMotivo: x\nFontes: `, trust: 'derived', source_at: new Date() },
    ]);
    return id;
  };

  it('turns the same permission in 4 projects into one user proposal, keeps a rejection, and supersedes on approval', async () => {
    for (const p of projectIds) await note(p, 'Pode rodar os testes de banco do servidor sem perguntar');
    let { rules } = await refreshRules(repos, ownerId, deps());
    const proposals = rules.filter((r) => r.status === 'proposed');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'rule', project_id: null });
    expect(proposals[0]!.source_refs).toHaveLength(4);

    // refreshing again keeps the same row
    ({ rules } = await refreshRules(repos, ownerId, deps()));
    expect(rules.map((r) => r.id)).toEqual([proposals[0]!.id]);

    await rejectRule(repos, ownerId, proposals[0]!.id);
    ({ rules } = await refreshRules(repos, ownerId, deps()));
    expect(rules.filter((r) => r.status === 'proposed')).toHaveLength(0);

    // 181 days later it is proposed again
    await db.memoryRule.update({ where: { id: proposals[0]!.id }, data: { decidedAt: new Date(Date.now() - 181 * 24 * 60 * 60 * 1000) } });
    ({ rules } = await refreshRules(repos, ownerId, deps()));
    expect(rules.filter((r) => r.status === 'proposed').map((r) => r.id)).toEqual([proposals[0]!.id]);

    const approved = await approveRule(repos, ownerId, proposals[0]!.id, {}, deps());
    expect(approved.status).toBe('approved');
    const superseded = await repos.memoryRules.supersededRefs(ownerId);
    expect([...superseded].sort()).toEqual([...proposals[0]!.source_refs].sort());
    // the rule's own note does not make a new proposal with its sources
    ({ rules } = await refreshRules(repos, ownerId, deps()));
    expect(rules.filter((r) => r.status === 'proposed')).toHaveLength(0);

    await removeRule(repos, ownerId, approved.id);
    expect((await repos.memoryRules.supersededRefs(ownerId)).size).toBe(0);
  });

  it('pairs notes whose embeddings are alike, whatever their words', async () => {
    const a = await note(projectIds[0]!, 'Usar português nas mensagens da interface');
    const b = await note(projectIds[0]!, 'Textos de tela ficam em pt-BR');
    await repos.memoryItems.setEmbedding(a, unit(1), 'm');
    await repos.memoryItems.setEmbedding(b, unit(1), 'm');
    const pairs = await repos.memoryRules.similarPairs(ownerId, 0.9);
    expect(pairs).toContainEqual([`note:${a < b ? a : b}`, `note:${a < b ? b : a}`]);
    const { rules } = await refreshRules(repos, ownerId, deps());
    expect(rules.find((r) => r.status === 'proposed' && r.project_id === projectIds[0])?.source_refs.sort()).toEqual([`note:${a}`, `note:${b}`].sort());
  });
});
