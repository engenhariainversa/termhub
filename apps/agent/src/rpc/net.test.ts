import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
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

  describe('behind an explicit proxy', () => {
    let proxy: http.Server | undefined;
    const connects: string[] = [];
    const sockets = new Set<net.Socket>();

    /** A minimal CONNECT proxy; with `refuse` it answers 403 to every tunnel. */
    function startProxy(refuse = false): Promise<string> {
      return new Promise((resolve) => {
        proxy = http.createServer();
        proxy.on('connect', (req: http.IncomingMessage, client: net.Socket) => {
          connects.push(req.url ?? '');
          if (refuse) {
            client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
          }
          const [host, port] = (req.url ?? '').split(':');
          const upstream = net.connect(Number(port), host, () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.pipe(client);
            client.pipe(upstream);
          });
          sockets.add(client).add(upstream);
          upstream.on('error', () => client.destroy());
          client.on('error', () => upstream.destroy());
        });
        proxy.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(proxy!.address() as AddressInfo).port}`));
      });
    }

    afterEach(async () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      connects.length = 0;
      await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
      proxy = undefined;
    });

    it('sends the POST through the CONNECT tunnel', async () => {
      let seen: { method?: string; body?: string } = {};
      const base = await listen((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          seen = { method: req.method, body };
          res.writeHead(401).end('{"error":"unauthorized"}');
        });
      });
      const url = `${base.replace('127.0.0.1', 'localhost')}/mcp`;
      const fetchImpl = (() => Promise.reject(new Error('went direct'))) as unknown as typeof fetch;
      expect(await checkUrl(url, 2_000, fetchImpl, { http_proxy: await startProxy() })).toEqual({ url, status: 401, error: null });
      expect(seen).toEqual({ method: 'POST', body: '{}' });
      expect(connects).toEqual([`localhost:${new URL(base).port}`]);
    });

    it('goes direct for a host in NO_PROXY', async () => {
      const base = await listen((_req, res) => res.writeHead(401).end());
      const r = await checkUrl(`${base}/mcp`, 2_000, fetch, { http_proxy: await startProxy(), no_proxy: '127.0.0.1' });
      expect(r.status).toBe(401);
      expect(connects).toEqual([]);
    });

    it('reports a proxy that refuses the tunnel', async () => {
      const base = await listen((_req, res) => res.writeHead(401).end());
      const r = await checkUrl(`${base}/mcp`, 2_000, fetch, { http_proxy: await startProxy(true) });
      expect(r.status).toBeNull();
      expect(r.error).toContain('refused CONNECT');
    });
  });
});

describe('net.check', () => {
  it('answers one result per url, in order', async () => {
    const base = await listen((req, res) => res.writeHead(req.url === '/mcp' ? 401 : 404).end());
    const r = await check({ urls: [`${base}/mcp`, `${base}/other`] });
    expect(r.results.map((x) => x.status)).toEqual([401, 404]);
  });
});
