import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { check, checkUrl } from './net.js';

let server: http.Server | undefined;

function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
}

afterEach(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe('checkUrl', () => {
  it('POSTs without a token and reports the status', async () => {
    let seen: { method?: string; auth?: string } = {};
    const base = await listen((req, res) => {
      seen = { method: req.method, auth: req.headers.authorization };
      res.writeHead(401).end('{"error":"unauthorized"}');
    });
    expect(await checkUrl(`${base}/api/hooks/events`)).toEqual({ url: `${base}/api/hooks/events`, status: 401, error: null });
    expect(seen).toEqual({ method: 'POST', auth: undefined });
  });

  it('does not follow a redirect (a Cloudflare Access login answers 302)', async () => {
    const base = await listen((_req, res) => res.writeHead(302, { location: 'https://example.cloudflareaccess.com/' }).end());
    expect((await checkUrl(`${base}/mcp`)).status).toBe(302);
  });

  it('reports why nothing answered', async () => {
    const base = await listen(() => undefined);
    const port = new URL(base).port;
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const r = await checkUrl(`http://127.0.0.1:${port}/mcp`);
    expect(r.status).toBeNull();
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('gives up after the timeout', async () => {
    const base = await listen(() => undefined);
    const r = await checkUrl(`${base}/mcp`, 100);
    expect(r).toEqual({ url: `${base}/mcp`, status: null, error: 'sem resposta (timeout)' });
  });
});

describe('net.check', () => {
  it('answers one result per url, in order', async () => {
    const base = await listen((req, res) => res.writeHead(req.url === '/mcp' ? 401 : 404).end());
    const r = await check({ urls: [`${base}/mcp`, `${base}/other`] });
    expect(r.results.map((x) => x.status)).toEqual([401, 404]);
  });
});
