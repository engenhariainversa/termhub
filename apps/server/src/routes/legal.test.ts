import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Device } from '../db/repositories/devices.js';
import type { User } from '../db/repositories/types.js';
import type { AcceptanceMeta, CreateLegalVersionInput } from '../db/repositories/legal.js';
import { legalStatus, type LegalVersion } from '../db/repositories/legal-status.js';
import { applyErrorHandler } from '../lib/errors.js';
import { legalRoutes, legalVersionRoutes } from './legal.js';
import { mobileLegalRoutes } from './m-legal.js';

const DAY = 24 * 60 * 60 * 1000;
const fromNow = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function version(id: string, document: 'terms' | 'privacy', days: number, requires_acceptance = true): LegalVersion {
  return { id, document, version: id, effective_at: fromNow(days), url: `https://termhub.dev/${document}/`, requires_acceptance, summary: null };
}

/** An in-memory `LegalRepository`: the real status rules over plain arrays. */
function fakeLegalRepo(initial: LegalVersion[] = []) {
  const versions = [...initial];
  const acceptances: { user_id: string; version_id: string; meta: AcceptanceMeta }[] = [];
  return {
    versions,
    acceptances,
    listVersions: vi.fn(async () => [...versions]),
    latestVersion: vi.fn(async (document: string) => versions.filter((x) => x.document === document).sort((a, b) => Date.parse(b.effective_at) - Date.parse(a.effective_at))[0]),
    createVersion: vi.fn(async (input: CreateLegalVersionInput) => {
      if (versions.some((x) => x.document === input.document && x.version === input.version)) return undefined;
      const row: LegalVersion = { id: `new${versions.length + 1}`, ...input, effective_at: input.effective_at.toISOString() };
      versions.push(row);
      return row;
    }),
    recordAcceptances: vi.fn(async (userId: string, ids: readonly string[], meta: AcceptanceMeta) => {
      for (const id of ids) acceptances.push({ user_id: userId, version_id: id, meta });
    }),
    statusFor: vi.fn(async (userId: string, now: Date = new Date()) =>
      legalStatus(
        versions,
        acceptances.filter((a) => a.user_id === userId).map((a) => a.version_id),
        now,
      ),
    ),
  };
}

const me = { id: 'u1', email: 'ana@gmail.com' } as unknown as User;

async function build(versions: LegalVersion[], opts: { user?: User | null } = {}) {
  const legal = fakeLegalRepo(versions);
  const repos = { legal } as unknown as Repositories;
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('user', null);
  const user = opts.user === undefined ? me : opts.user;
  app.addHook('preHandler', async (request) => {
    request.user = user;
  });
  await app.register((a) => legalRoutes(a, repos), { prefix: '/api/legal' });
  await app.register((a) => legalVersionRoutes(a, repos), { prefix: '/api/legal/versions' });
  await app.ready();
  return { app, legal };
}

describe('legal routes (web)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /status with nothing registered asks nothing', async () => {
    const t = await build([]);
    app = t.app;
    const r = await app.inject({ url: '/api/legal/status' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ pending: [], upcoming: [] });
  });

  it('GET /status lists the pending and upcoming versions', async () => {
    const t1 = version('t1', 'terms', -5);
    const t2 = version('t2', 'terms', 40);
    const p1 = version('p1', 'privacy', -5);
    const t = await build([t1, t2, p1]);
    app = t.app;
    const r = await app.inject({ url: '/api/legal/status' });
    expect(r.json()).toEqual({ pending: [t1, p1], upcoming: [t2] });
  });

  it('needs a signed-in user', async () => {
    const t = await build([version('t1', 'terms', -5)], { user: null });
    app = t.app;
    expect((await app.inject({ url: '/api/legal/status' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/legal/accept', payload: { version_ids: ['t1'] } })).statusCode).toBe(401);
  });

  it('POST /accept records the acceptance with ip, user agent and channel, and returns the new status', async () => {
    const t = await build([version('t1', 'terms', -5), version('p1', 'privacy', -5)]);
    app = t.app;
    const r = await app.inject({ method: 'POST', url: '/api/legal/accept', headers: { 'user-agent': 'Firefox' }, payload: { version_ids: ['t1', 'p1'] } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ pending: [], upcoming: [] });
    expect(t.legal.recordAcceptances).toHaveBeenCalledWith('u1', ['t1', 'p1'], { ip: '127.0.0.1', user_agent: 'Firefox', channel: 'web' });
  });

  it('POST /accept takes the checkout channel and an upcoming version (accepting early)', async () => {
    const t = await build([version('t1', 'terms', -5), version('t2', 'terms', 40)]);
    app = t.app;
    const r = await app.inject({ method: 'POST', url: '/api/legal/accept', payload: { version_ids: ['t2'], channel: 'checkout' } });
    expect(r.statusCode).toBe(200);
    // t2 is newer: it covers t1 too
    expect(r.json()).toEqual({ pending: [], upcoming: [] });
    expect(t.legal.acceptances[0]?.meta.channel).toBe('checkout');
  });

  it('POST /accept refuses an id that is not pending or upcoming, and records nothing', async () => {
    const t = await build([version('t1', 'terms', -5), version('t1.1', 'terms', -1, false)]);
    app = t.app;
    for (const ids of [['nope'], ['t1', 't1.1']]) {
      const r = await app.inject({ method: 'POST', url: '/api/legal/accept', payload: { version_ids: ids } });
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe('LEGAL_VERSION_NOT_PENDING');
    }
    // already accepted: no longer acceptable
    await app.inject({ method: 'POST', url: '/api/legal/accept', payload: { version_ids: ['t1'] } });
    const again = await app.inject({ method: 'POST', url: '/api/legal/accept', payload: { version_ids: ['t1'] } });
    expect(again.statusCode).toBe(400);
    expect(t.legal.recordAcceptances).toHaveBeenCalledTimes(1);
  });

  it('POST /accept validates the body', async () => {
    const t = await build([version('t1', 'terms', -5)]);
    app = t.app;
    for (const payload of [{}, { version_ids: [] }, { version_ids: ['t1'], channel: 'mobile' }, { version_ids: Array.from({ length: 11 }, (_, i) => `x${i}`) }]) {
      const r = await app.inject({ method: 'POST', url: '/api/legal/accept', payload });
      expect(r.statusCode).toBe(400);
    }
    expect(t.legal.recordAcceptances).not.toHaveBeenCalled();
  });
});

describe('legal version routes (admin)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const body = (over: Record<string, unknown> = {}) => ({ document: 'terms', version: '1', effective_at: fromNow(0), url: 'https://termhub.dev/termos/', ...over });

  it('lists the versions', async () => {
    const t1 = version('t1', 'terms', -5);
    const t = await build([t1]);
    app = t.app;
    const r = await app.inject({ url: '/api/legal/versions' });
    expect(r.json()).toEqual({ versions: [t1] });
  });

  it('the first version of a document may take effect right away', async () => {
    const t = await build([]);
    app = t.app;
    const r = await app.inject({ method: 'POST', url: '/api/legal/versions', payload: body({ summary: '  ' }) });
    expect(r.statusCode).toBe(201);
    expect(r.json().version).toMatchObject({ document: 'terms', version: '1', requires_acceptance: true, summary: null });
  });

  it('a relevant replacement must take effect 30 days or more from now', async () => {
    const t = await build([version('t1', 'terms', -5)]);
    app = t.app;
    const soon = await app.inject({ method: 'POST', url: '/api/legal/versions', payload: body({ version: '2', effective_at: fromNow(29) }) });
    expect(soon.statusCode).toBe(400);
    expect(soon.json().code).toBe('LEGAL_NOTICE_TOO_SHORT');
    const ok = await app.inject({ method: 'POST', url: '/api/legal/versions', payload: body({ version: '2', effective_at: fromNow(31), summary: 'Novo prazo de retenção' }) });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().version.summary).toBe('Novo prazo de retenção');
  });

  it('a minor version may take effect right away', async () => {
    const t = await build([version('t1', 'terms', -5)]);
    app = t.app;
    const r = await app.inject({ method: 'POST', url: '/api/legal/versions', payload: body({ version: '1.1', requires_acceptance: false }) });
    expect(r.statusCode).toBe(201);
    expect(r.json().version.requires_acceptance).toBe(false);
  });

  it('a duplicate number answers 409', async () => {
    const t = await build([{ ...version('t1', 'terms', -5), version: '1' }]);
    app = t.app;
    const r = await app.inject({ method: 'POST', url: '/api/legal/versions', payload: body({ version: '1', requires_acceptance: false }) });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('LEGAL_VERSION_EXISTS');
  });

  it('validates the body', async () => {
    const t = await build([]);
    app = t.app;
    for (const over of [{ document: 'cookies' }, { version: '' }, { version: 'x'.repeat(21) }, { effective_at: 'tomorrow' }, { url: 'http://termhub.dev/termos/' }, { url: 'nope' }, { summary: 'x'.repeat(2001) }]) {
      const r = await app.inject({ method: 'POST', url: '/api/legal/versions', payload: body(over) });
      expect(r.statusCode, JSON.stringify(over)).toBe(400);
    }
    expect(t.legal.createVersion).not.toHaveBeenCalled();
  });
});

describe('legal routes (mobile)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function buildMobile(versions: LegalVersion[]) {
    const legal = fakeLegalRepo(versions);
    const a = Fastify();
    applyErrorHandler(a);
    a.decorateRequest('user', null);
    a.addHook('preHandler', async (request) => {
      request.user = me;
      request.mobile = { device: { id: 'd1', user_id: 'u1' } as unknown as Device, user: me };
    });
    await a.register((x) => mobileLegalRoutes(x, { legal } as unknown as Repositories), { prefix: '/legal' });
    await a.ready();
    return { app: a, legal };
  }

  it('GET /legal and POST /legal/accept, always on the mobile channel', async () => {
    const t1 = version('t1', 'terms', -5);
    const t = await buildMobile([t1]);
    app = t.app;
    expect((await app.inject({ url: '/legal' })).json()).toEqual({ pending: [t1], upcoming: [] });
    const r = await app.inject({ method: 'POST', url: '/legal/accept', headers: { 'user-agent': 'termhub-app' }, payload: { version_ids: ['t1'], channel: 'web' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ pending: [], upcoming: [] });
    expect(t.legal.recordAcceptances).toHaveBeenCalledWith('u1', ['t1'], { ip: '127.0.0.1', user_agent: 'termhub-app', channel: 'mobile' });
  });

  it('refuses a version that is not waiting for this person', async () => {
    const t = await buildMobile([version('t1', 'terms', -5)]);
    app = t.app;
    const r = await app.inject({ method: 'POST', url: '/legal/accept', payload: { version_ids: ['other'] } });
    expect(r.statusCode).toBe(400);
    expect(t.legal.recordAcceptances).not.toHaveBeenCalled();
  });
});
