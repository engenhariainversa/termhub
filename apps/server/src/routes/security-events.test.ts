import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { SecurityEvent, SecurityEventFilter, SecurityEventInput } from '../db/repositories/security-events.js';
import { applyErrorHandler } from '../lib/errors.js';
import { csvCell, securityEventRoutes, toCsv } from './security-events.js';

const row = (over: Partial<SecurityEvent> & { id: string }): SecurityEvent => ({
  actor_id: 'u1',
  actor_email: 'admin@x.dev',
  view_as_id: null,
  action: 'auth.login',
  target_type: null,
  target_id: null,
  target_label: null,
  ip: '10.0.0.1',
  meta: {},
  created_at: '2026-10-07T12:00:00.000Z',
  ...over,
});

function buildApp(events: SecurityEvent[]) {
  const recorded: SecurityEventInput[] = [];
  const list = vi.fn(async (_filter: SecurityEventFilter, limit: number) => events.slice(0, limit));
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'u1', email: 'admin@x.dev' } as never;
    request.scope = { user: request.user, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' } as never;
  });
  const repos = { securityEvents: { list, record: vi.fn(async (e: SecurityEventInput) => void recorded.push(e)) } } as unknown as Repositories;
  app.register((a) => securityEventRoutes(a, repos, { retentionDays: 365 }), { prefix: '/security-events' });
  return { app, list, recorded };
}

describe('GET /security-events', () => {
  it('passes the filters on, answers the page, the catalog and the retention', async () => {
    const { app, list } = buildApp([row({ id: 'a1' })]);
    const r = await app.inject({ url: '/security-events?action=auth&q=pessoa&from=2026-10-01&to=2026-10-08&actor_id=u2' });
    expect(r.statusCode).toBe(200);
    const [filter, limit] = list.mock.calls[0]!;
    expect(filter).toMatchObject({ action: 'auth', q: 'pessoa', actor_id: 'u2' });
    expect(filter.from?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(limit).toBe(51);
    expect(r.json()).toMatchObject({ events: [{ id: 'a1' }], next: null, retention_days: 365 });
    expect(r.json().actions).toContain('terminal.view_as_open');
  });

  it('hands out a keyset cursor when there is more, and reads it back', async () => {
    const { app, list } = buildApp([row({ id: 'a3' }), row({ id: 'a2' }), row({ id: 'a1' })]);
    const r = await app.inject({ url: '/security-events?limit=2' });
    expect(r.json().events.map((e: SecurityEvent) => e.id)).toEqual(['a3', 'a2']);
    expect(r.json().next).toBe('2026-10-07T12:00:00.000Z_a2');
    await app.inject({ url: `/security-events?before=${encodeURIComponent(r.json().next)}` });
    expect(list.mock.calls[1]![0].before).toEqual({ created_at: new Date('2026-10-07T12:00:00.000Z'), id: 'a2' });
  });

  it('refuses an unknown action and a malformed cursor', async () => {
    const { app } = buildApp([]);
    expect((await app.inject({ url: '/security-events?action=nope' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/security-events?before=garbage' })).statusCode).toBe(400);
  });
});

describe('GET /security-events/export', () => {
  it('exports CSV as a download and puts the export itself on the trail', async () => {
    const { app, recorded } = buildApp([row({ id: 'a1', action: 'user.invite', target_label: 'pessoa@x.dev', meta: { role: 'BETA' } })]);
    const r = await app.inject({ url: '/security-events/export?format=csv&action=user' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="termhub-security-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = r.body.trim().split('\r\n');
    expect(lines[0]).toBe('created_at,action,actor_id,actor_email,view_as_id,target_type,target_id,target_label,ip,meta');
    expect(lines[1]).toBe('2026-10-07T12:00:00.000Z,user.invite,u1,admin@x.dev,,,,pessoa@x.dev,10.0.0.1,"{""role"":""BETA""}"');
    expect(recorded).toEqual([expect.objectContaining({ action: 'audit.export', actor_id: 'u1', meta: expect.objectContaining({ format: 'csv', rows: 1 }) })]);
  });

  it('exports JSON', async () => {
    const { app } = buildApp([row({ id: 'a1' })]);
    const r = await app.inject({ url: '/security-events/export?format=json' });
    expect(r.headers['content-type']).toContain('application/json');
    expect(JSON.parse(r.body)).toMatchObject({ events: [{ id: 'a1', action: 'auth.login' }], truncated: false });
  });
});

describe('csv cells', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell(null)).toBe('');
  });

  it('defuses a cell a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('writes a header even with no rows', () => {
    expect(toCsv([])).toBe('created_at,action,actor_id,actor_email,view_as_id,target_type,target_id,target_label,ip,meta\r\n');
  });
});
