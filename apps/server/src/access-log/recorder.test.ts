import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AccessLogInput } from '../db/repositories/index.js';
import { createAccessLogRecorder, registerAccessLog, upgradeClientIp } from './recorder.js';
import type { IncomingMessage } from 'node:http';

const entry = (route: string): AccessLogInput => ({ at: new Date(), ip: '1.2.3.4', user_id: null, kind: 'http', method: 'GET', route, status: 200 });
const log = () => ({ warn: vi.fn() });

describe('createAccessLogRecorder', () => {
  it('writes what is buffered on flush, in one batch', async () => {
    const insertMany = vi.fn(async () => {});
    const rec = createAccessLogRecorder({ repo: { insertMany }, log: log(), flushMs: 60_000 });
    rec.record(entry('/a'));
    rec.record(entry('/b'));
    await rec.flush();
    expect(insertMany).toHaveBeenCalledTimes(1);
    expect((insertMany.mock.calls[0] as unknown as [AccessLogInput[]])[0].map((r) => r.route)).toEqual(['/a', '/b']);
    await rec.flush();
    expect(insertMany).toHaveBeenCalledTimes(1);
    await rec.close();
  });

  it('keeps the rows of a failed write for the next flush', async () => {
    const insertMany = vi.fn().mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'P1001' })).mockResolvedValue(undefined);
    const l = log();
    const rec = createAccessLogRecorder({ repo: { insertMany }, log: l, flushMs: 60_000 });
    rec.record(entry('/a'));
    await rec.flush();
    expect(l.warn).toHaveBeenCalledWith({ pending: 1, code: 'P1001' }, expect.any(String));
    await rec.flush();
    expect(insertMany).toHaveBeenLastCalledWith([expect.objectContaining({ route: '/a' })]);
    await rec.close();
  });

  it('drops the oldest past the ceiling and says how many', async () => {
    const insertMany = vi.fn(async () => {});
    const l = log();
    const rec = createAccessLogRecorder({ repo: { insertMany }, log: l, flushMs: 60_000, maxBuffer: 2 });
    for (const r of ['/a', '/b', '/c']) rec.record(entry(r));
    await rec.flush();
    expect((insertMany.mock.calls[0] as unknown as [AccessLogInput[]])[0].map((r) => r.route)).toEqual(['/b', '/c']);
    expect(l.warn).toHaveBeenCalledWith({ dropped: 1 }, expect.any(String));
    await rec.close();
  });

  it('close writes what is left', async () => {
    const insertMany = vi.fn(async () => {});
    const rec = createAccessLogRecorder({ repo: { insertMany }, log: log(), flushMs: 60_000 });
    rec.record(entry('/a'));
    await rec.close();
    expect(insertMany).toHaveBeenCalledTimes(1);
  });
});

describe('registerAccessLog', () => {
  async function app() {
    const rows: AccessLogInput[] = [];
    const fastify = Fastify({ trustProxy: true });
    registerAccessLog(fastify, { record: (e) => rows.push(e), flush: async () => {}, close: async () => {} });
    fastify.addHook('preHandler', async (request) => {
      (request as unknown as { user: unknown }).user = request.headers['x-user'] ? { id: request.headers['x-user'] } : null;
    });
    fastify.post('/api/auth/verify/:code', async () => ({ ok: true }));
    fastify.get('/api/ready', async () => ({ ok: true }));
    fastify.get('/*', async () => 'static');
    await fastify.ready();
    return { fastify, rows };
  }

  it('records the route pattern, the forwarded IP, the user and the status; never the query, the params or the body', async () => {
    const { fastify, rows } = await app();
    await fastify.inject({
      method: 'POST',
      url: '/api/auth/verify/123456?token=secret',
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'x-user': 'u1' },
      payload: { code: '654321' },
    });
    expect(rows).toEqual([{ at: expect.any(Date), ip: '203.0.113.9', user_id: 'u1', kind: 'http', method: 'POST', route: '/api/auth/verify/:code', status: 200 }]);
    expect(JSON.stringify(rows)).not.toMatch(/123456|654321|secret/);
    await fastify.close();
  });

  it('skips the healthcheck probes, static files and unknown routes', async () => {
    const { fastify, rows } = await app();
    await fastify.inject({ method: 'GET', url: '/api/ready' });
    await fastify.inject({ method: 'GET', url: '/assets/index.js' });
    await fastify.inject({ method: 'DELETE', url: '/nope' });
    expect(rows).toEqual([]);
    await fastify.close();
  });
});

describe('upgradeClientIp', () => {
  const req = (headers: Record<string, string>, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

  it('reads the leftmost X-Forwarded-For entry, like request.ip with trustProxy', () => {
    expect(upgradeClientIp(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
  });

  it('falls back to the socket peer', () => {
    expect(upgradeClientIp(req({}, '10.1.1.1'))).toBe('10.1.1.1');
  });
});
