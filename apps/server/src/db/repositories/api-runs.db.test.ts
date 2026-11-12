import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ApiRunsRepository } from './api-runs.js';

const HOUR = 60 * 60 * 1000;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ApiRunsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ApiRunsRepository;
  let userId: string;
  let otherId: string;
  let projectId: string;
  let otherProjectId: string;
  let machineId: string;
  let accountId: string;
  let tokenId: string;
  let otherTokenId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ApiRunsRepository(db);
    [userId, otherId, projectId, otherProjectId, machineId, accountId, tokenId, otherTokenId] = Array.from({ length: 8 }, () => newId());
    await db.user.createMany({ data: [{ id: userId, email: `${userId}@test.local`, name: 'me' }, { id: otherId, email: `${otherId}@test.local`, name: 'other' }] });
    const key = () => `R${newId(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
    await db.project.createMany({ data: [{ id: projectId, key: key(), name: 'p', ownerId: userId }, { id: otherProjectId, key: key(), name: 'o', ownerId: otherId }] });
    await db.machine.create({ data: { id: machineId, name: 'jarvis', type: 'agent', ownerId: userId } });
    await db.aiAccount.create({ data: { id: accountId, provider: 'claude', label: 'pessoal', machineId } });
    await db.apiToken.createMany({
      data: [
        { id: tokenId, userId, name: 'ci', tokenHash: `h-${tokenId}`, scopes: ['runs'] },
        { id: otherTokenId, userId, name: 'ci2', tokenHash: `h-${otherTokenId}`, scopes: ['runs'] },
      ],
    });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } }); // cascades projects' runs, tokens
    await db.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
    await db.machine.deleteMany({ where: { id: machineId } });
    await db.$disconnect();
  });

  const make = (over: { user?: string; project?: string; token?: string | null; key?: string } = {}) =>
    repo.create({ user_id: over.user ?? userId, token_id: over.token === undefined ? tokenId : over.token, project_id: over.project ?? projectId, capabilities: ['read'], timeout_ms: 600_000, idempotency_key: over.key ?? null });

  it('creates a queued run and reads it back only for its owner', async () => {
    const run = await make();
    expect(run).toMatchObject({ user_id: userId, token_id: tokenId, project_id: projectId, status: 'queued', capabilities: ['read'], timeout_ms: 600_000, machine_name: null, account_label: null, workspace: null, usage: null });
    expect(await repo.findForUser(userId, run.id)).toMatchObject({ id: run.id });
    expect(await repo.findForUser(otherId, run.id)).toBeUndefined();
  });

  it('patches status, routing and result; names the machine and the account by label', async () => {
    const run = await make();
    const started = new Date();
    const patched = await repo.setStatus(run.id, { status: 'running', machine_id: machineId, account_id: accountId, provider: 'claude', model: 'sonnet', workspace: { kind: 'project', path: '/w', branch: null }, started_at: started });
    expect(patched).toMatchObject({ status: 'running', machine_name: 'jarvis', account_label: 'pessoal', provider: 'claude', workspace: { kind: 'project', path: '/w', branch: null }, started_at: started.toISOString() });
    const done = await repo.setStatus(run.id, { status: 'succeeded', result: 'oi', usage: { input_tokens: 3, output_tokens: 1 }, ended_at: new Date() });
    expect(done).toMatchObject({ status: 'succeeded', result: 'oi', usage: { input_tokens: 3, output_tokens: 1 }, machine_name: 'jarvis' });
    expect(await repo.setStatus('missing', { status: 'failed' })).toBeUndefined();
  });

  it('lists only the owner\'s runs, newest first, by project and status', async () => {
    const a = await make();
    await db.apiRun.update({ where: { id: a.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const b = await make();
    await repo.setStatus(b.id, { status: 'running' });
    const foreign = await make({ user: otherId, project: otherProjectId, token: null });
    const mine = await repo.listForUser(userId, { projectId, limit: 100 });
    expect(mine.map((r) => r.id).indexOf(b.id)).toBeLessThan(mine.map((r) => r.id).indexOf(a.id));
    expect(mine.map((r) => r.id)).not.toContain(foreign.id);
    expect((await repo.listForUser(userId, { status: 'running', limit: 100 })).map((r) => r.id)).toContain(b.id);
    expect((await repo.listForUser(userId, { status: 'running', limit: 100 })).map((r) => r.id)).not.toContain(a.id);
    expect(await repo.listForUser(userId, { limit: 1 })).toHaveLength(1);
  });

  it('numbers events from 1 in order, also across two concurrent writers, and replays after a seq', async () => {
    const run = await make();
    const first = await repo.appendEvents(run.id, [{ type: 'started', payload: { provider: 'claude' } }, { type: 'text', payload: { text: 'a' } }]);
    expect(first.map((e) => e.seq)).toEqual([1, 2]);
    await Promise.all([repo.appendEvents(run.id, [{ type: 'text_delta', payload: { text: 'b' } }]), repo.appendEvents(run.id, [{ type: 'text_delta', payload: { text: 'c' } }])]);
    const all = await repo.eventsAfter(run.id, 0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await repo.eventsAfter(run.id, 2)).map((e) => e.seq)).toEqual([3, 4]);
    expect(all[0]).toMatchObject({ type: 'started', payload: { provider: 'claude' } });
    expect(await repo.appendEvents('missing', [{ type: 'text', payload: {} }])).toEqual([]);
    expect(await repo.appendEvents(run.id, [])).toEqual([]);
  });

  it('counts running runs per token and per person, and the ones a token created in the last hour', async () => {
    const before = { token: await repo.countRunning({ tokenId: otherTokenId }), user: await repo.countRunning({ userId }) };
    const q = await make({ token: otherTokenId });
    const r = await make({ token: otherTokenId });
    await repo.setStatus(r.id, { status: 'running' });
    const done = await make({ token: otherTokenId });
    await repo.setStatus(done.id, { status: 'succeeded' });
    expect(await repo.countRunning({ tokenId: otherTokenId })).toBe(before.token + 2);
    expect(await repo.countRunning({ userId })).toBe(before.user + 2);

    await db.apiRun.update({ where: { id: q.id }, data: { createdAt: new Date(Date.now() - 2 * HOUR) } });
    const since = new Date(Date.now() - HOUR);
    const recent = await db.apiRun.count({ where: { tokenId: otherTokenId, createdAt: { gte: since } } });
    expect(await repo.countCreatedSince(otherTokenId, since)).toBe(recent);
    const oldest = await repo.oldestCreatedSince(otherTokenId, since);
    expect(oldest).not.toBeNull();
    expect(oldest!.getTime()).toBeGreaterThanOrEqual(since.getTime());
    expect(await repo.oldestCreatedSince(otherTokenId, new Date(Date.now() + HOUR))).toBeNull();
  });

  it('finds a run by idempotency key for its owner only, and the key is unique per person', async () => {
    const key = `k-${newId()}`;
    const run = await make({ key });
    expect((await repo.findByIdempotency(userId, key))?.id).toBe(run.id);
    expect(await repo.findByIdempotency(otherId, key)).toBeUndefined();
    await expect(make({ key })).rejects.toThrow();
    // Another person may use the same key.
    await expect(make({ user: otherId, project: otherProjectId, token: null, key })).resolves.toMatchObject({ user_id: otherId });
  });

  it('drops old events and keeps the run; a deleted token or machine leaves the run with nulls', async () => {
    const run = await make({ token: otherTokenId });
    await repo.setStatus(run.id, { machine_id: machineId });
    await repo.appendEvents(run.id, [{ type: 'text', payload: { text: 'old' } }, { type: 'text', payload: { text: 'new' } }]);
    await db.apiRunEvent.update({ where: { runId_seq: { runId: run.id, seq: 1 } }, data: { at: new Date(Date.now() - 8 * 24 * HOUR) } });
    expect(await repo.deleteEventsBefore(new Date(Date.now() - 7 * 24 * HOUR))).toBeGreaterThanOrEqual(1);
    expect((await repo.eventsAfter(run.id, 0)).map((e) => e.seq)).toEqual([2]);

    await db.apiToken.delete({ where: { id: otherTokenId } });
    expect(await repo.findForUser(userId, run.id)).toMatchObject({ token_id: null, machine_id: machineId });
  });
});
