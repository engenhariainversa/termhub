import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { ProgressEpicRow } from '../progress/aggregate.js';
import { applyErrorHandler } from '../lib/errors.js';

const perms = vi.hoisted(() => ({ terminals: true }));
vi.mock('../auth/permissions.js', async (orig) => ({
  ...(await orig<typeof import('../auth/permissions.js')>()),
  canAccess: vi.fn(async (_r: unknown, _u: unknown, resource: string, action: string) => (resource === 'terminals' && action === 'read' ? perms.terminals : true)),
}));
vi.mock('../ci/status.js', () => ({ ciErrorOf: (id: string) => (id === 'p1' ? 'GitHub: repositório não encontrado' : null) }));

import { progressRoutes } from './progress.js';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const rows: ProgressEpicRow[] = [
  {
    id: 'e1', ref: 'TER-1', title: 'Épico', project: { id: 'p1', key: 'TER', name: 'termhub' },
    cards: [{
      id: 'c1', ref: 'TER-2', title: 'Card', type: 'story', status: 'doing', position: 0, column_name: 'Fazendo',
      started_at: null, done_at: null, active_seconds: 0, subtasks: [], pull_requests: [],
      tab: { id: 't1', name: 'agent', machine_name: 'jarvis', state: 'waiting_input', state_at: NOW, activity: null, activity_verb: null, rate_limited_at: null, automatic: true },
    }],
  },
  { id: 'e2', ref: 'TER-3', title: 'Parado', project: { id: 'p1', key: 'TER', name: 'termhub' }, cards: [{ id: 'c2', ref: 'TER-4', title: 'x', type: 'task', status: 'todo', position: 0, column_name: 'A fazer', started_at: null, done_at: null, active_seconds: 0, subtasks: [], pull_requests: [], tab: null }] },
];
const feedRows = [
  { event: { id: 'v1', project_id: 'p1', task_id: 'c1', run_id: 'r1', kind: 'escalated' as const, payload: { reason: 'trust_prompt' }, created_at: NOW.toISOString() }, ref: 'TER-2', epic: 'Épico', machine: 'jarvis', account: null, tab_id: 't1', branch: null },
];
const projects = [{ id: 'p1', owner_id: 'u1' }, { id: 'p2', owner_id: 'u2' }];

function build(ownerId: string | null = 'u1', uses = true) {
  const list = vi.fn(async () => rows);
  const feed = vi.fn(async () => feedRows);
  const usesAutomation = vi.fn(async () => uses);
  const repos = { progress: { list, feed, usesAutomation }, projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)) } } as unknown as Repositories;
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId, createAs: 'u1' };
    request.user = { id: 'u1', role_id: 'r1' } as never;
  });
  app.register((a) => progressRoutes(a, repos, { now: () => NOW }), { prefix: '/progress' });
  return { app, list, feed, usesAutomation };
}

beforeEach(() => {
  perms.terminals = true;
});

describe('GET /progress', () => {
  it('runs no automation query for someone who never ran automatic work', async () => {
    const { app, list, feed } = build('u1', false);
    const body = (await app.inject({ method: 'GET', url: '/progress' })).json();
    expect(feed).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ automatic: false }));
    expect(body.feed).toEqual([]);
  });

  it('carries the last 50 automatic events and flags the automatic tab', async () => {
    const { app, feed } = build();
    const body = (await app.inject({ method: 'GET', url: '/progress' })).json();
    expect(feed).toHaveBeenCalledWith({ owner: 'u1', projectId: null, limit: 50 });
    expect(body.feed).toHaveLength(1);
    expect(body.feed[0]).toMatchObject({ kind: 'escalated', ref: 'TER-2', tab_id: 't1', run_id: 'r1' });
    expect(body.feed[0].reason_text).toContain('confiança');
    expect(body.epics[0].cards[0].agents[0].automatic).toBe(true);
  });

  it('returns the active epics of the caller with agents', async () => {
    const { app, list } = build();
    const r = await app.inject({ method: 'GET', url: '/progress' });
    expect(r.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith({ owner: 'u1', projectId: null, automatic: true });
    const body = r.json();
    expect(body.generated_at).toBe(NOW.toISOString());
    expect(body.epics.map((e: { ref: string }) => e.ref)).toEqual(['TER-1']);
    expect(body.epics[0].agents).toEqual({ working: 0, needs_you: 1, idle: 0 });
    expect(body.epics[0].cards[0].agents[0]).toMatchObject({ tab_id: 't1', needs_you: true });
    expect(body.epics[0].ci_error).toBe('GitHub: repositório não encontrado');
  });

  it('scope=all keeps epics without a card in doing', async () => {
    const { app } = build();
    const r = await app.inject({ method: 'GET', url: '/progress?scope=all' });
    expect(r.json().epics.map((e: { ref: string }) => e.ref)).toEqual(['TER-1', 'TER-3']);
  });

  it('hides every agent without terminals:read', async () => {
    perms.terminals = false;
    const { app } = build();
    const body = (await app.inject({ method: 'GET', url: '/progress' })).json();
    expect(body.epics[0].agents).toBeNull();
    expect(body.epics[0].cards[0].agents).toBeNull();
    expect(JSON.stringify(body)).not.toContain('jarvis');
  });

  it('filters by a project of the scope', async () => {
    const { app, list } = build();
    expect((await app.inject({ method: 'GET', url: '/progress?project_id=p1' })).statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith({ owner: 'u1', projectId: 'p1', automatic: true });
  });

  it('answers 404 for a project of another owner, without reading progress', async () => {
    const { app, list } = build();
    expect((await app.inject({ method: 'GET', url: '/progress?project_id=p2' })).statusCode).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects an unknown scope with 400', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'GET', url: '/progress?scope=everything' })).statusCode).toBe(400);
  });
});
