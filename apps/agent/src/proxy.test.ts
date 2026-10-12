import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { connectOnce } from './client.js';
import { bypassesProxy, hasCredentials, proxyConnection, proxyEnvFrom, proxyFor, redactProxy } from './proxy.js';

describe('bypassesProxy', () => {
  it.each([
    ['app.termhub.dev', 443, '*', true],
    ['app.termhub.dev', 443, 'termhub.dev', true],
    ['app.termhub.dev', 443, '.termhub.dev', true],
    ['app.termhub.dev', 443, '*.termhub.dev', true],
    ['termhub.dev', 443, '.termhub.dev', true],
    ['nottermhub.dev', 443, 'termhub.dev', false],
    ['app.termhub.dev', 443, 'localhost, 10.0.0.1 , termhub.dev:443', true],
    ['app.termhub.dev', 443, 'termhub.dev:8443', false],
    ['::1', 80, '::1', true],
    ['[::1]', 80, '[::1]:80', true],
    ['app.termhub.dev', 443, '', false],
    ['app.termhub.dev', 443, undefined, false],
  ])('%s:%d with NO_PROXY=%j → %s', (host, port, noProxy, expected) => {
    expect(bypassesProxy(host, port, noProxy)).toBe(expected);
  });
});

describe('proxyFor', () => {
  const wss = new URL('wss://app.termhub.dev/agent/ws');

  it('takes HTTPS_PROXY for wss:// and HTTP_PROXY for ws://, lower case first', () => {
    expect(proxyFor(wss, { HTTPS_PROXY: 'http://upper:3128', https_proxy: 'http://lower:3128' })?.host).toBe('lower:3128');
    expect(proxyFor(wss, { HTTPS_PROXY: 'http://upper:3128' })?.host).toBe('upper:3128');
    expect(proxyFor(wss, { HTTP_PROXY: 'http://plain:3128' })).toBeUndefined();
    expect(proxyFor(new URL('ws://10.0.0.5:3000/agent/ws'), { HTTP_PROXY: 'http://plain:3128' })?.host).toBe('plain:3128');
  });

  it('assumes http:// for a proxy without a scheme and skips hosts in NO_PROXY', () => {
    expect(proxyFor(wss, { HTTPS_PROXY: 'proxy.corp:8080' })?.href).toBe('http://proxy.corp:8080/');
    expect(proxyFor(wss, { HTTPS_PROXY: 'proxy.corp:8080', NO_PROXY: 'termhub.dev' })).toBeUndefined();
    expect(proxyFor(wss, { HTTPS_PROXY: '  ' })).toBeUndefined();
  });

  it('refuses a proxy it cannot speak to instead of going direct', () => {
    expect(() => proxyFor(wss, { HTTPS_PROXY: 'socks5://proxy.corp:1080' })).toThrow(/unsupported proxy protocol socks5:/);
  });
});

describe('proxy env helpers', () => {
  it('collects the variables under their upper-case names', () => {
    expect(proxyEnvFrom({ https_proxy: 'http://p:3128', NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/corp.pem', PATH: '/bin' })).toEqual({
      HTTPS_PROXY: 'http://p:3128',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/corp.pem',
    });
  });

  it('spots a proxy password and hides it', () => {
    expect(hasCredentials({ HTTPS_PROXY: 'http://me:pw@p:3128' })).toBe(true);
    expect(hasCredentials({ HTTPS_PROXY: 'me:pw@p:3128' })).toBe(true);
    expect(hasCredentials({ HTTPS_PROXY: 'http://p:3128', NO_PROXY: 'a,b' })).toBe(false);
    expect(redactProxy(new URL('http://me:pw@p:3128'))).toBe('http://me:***@p:3128');
  });
});

interface Proxy {
  port: number;
  connects: string[];
  auth: (string | undefined)[];
  close(): Promise<void>;
}

/** A minimal CONNECT proxy; with `requireAuth` it answers 407 unless the Basic credentials match. */
function startProxy(requireAuth?: string): Promise<Proxy> {
  return new Promise((resolve) => {
    const connects: string[] = [];
    const auth: (string | undefined)[] = [];
    const sockets = new Set<net.Socket>();
    const server = http.createServer();
    server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
      connects.push(req.url ?? '');
      auth.push(req.headers['proxy-authorization']);
      if (requireAuth && req.headers['proxy-authorization'] !== `Basic ${Buffer.from(requireAuth).toString('base64')}`) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      const [host, port] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(client).add(upstream);
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        connects,
        auth,
        close: () =>
          new Promise((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

/** A WebSocket server that answers the agent's probe hello by closing 1000 'probe-ok'. */
function startWsServer(server: http.Server | https.Server): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => ws.once('message', () => ws.close(1000, 'probe-ok')));
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}

const hello = { agent_version: '0.1.0', os: 'linux' as const, arch: 'x64', hostname: 'h', tmux: false, tools: [] };

describe('connecting through a proxy', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('tunnels the agent WebSocket through CONNECT, with Basic credentials', async () => {
    const proxy = await startProxy('me:p@ss');
    const server = await startWsServer(http.createServer());
    cleanups.push(proxy.close, server.close);

    const { closed } = await connectOnce({
      url: `http://localhost:${server.port}`,
      token: 't',
      hello,
      onServerMessage: () => {},
      onStream: () => {},
      log: () => {},
      env: { http_proxy: `http://me:p%40ss@127.0.0.1:${proxy.port}` },
    });
    expect(await closed).toEqual({ code: 1000, reason: 'probe-ok' });
    expect(proxy.connects).toEqual([`localhost:${server.port}`]);
  });

  it('goes direct for a host in NO_PROXY', async () => {
    const proxy = await startProxy();
    const server = await startWsServer(http.createServer());
    cleanups.push(proxy.close, server.close);

    const { closed } = await connectOnce({
      url: `http://localhost:${server.port}`,
      token: 't',
      hello,
      onServerMessage: () => {},
      onStream: () => {},
      log: () => {},
      env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: 'localhost' },
    });
    expect(await closed).toEqual({ code: 1000, reason: 'probe-ok' });
    expect(proxy.connects).toEqual([]);
  });

  it('rejects the connect attempt when the proxy refuses CONNECT', async () => {
    const proxy = await startProxy('me:right');
    const server = await startWsServer(http.createServer());
    cleanups.push(proxy.close, server.close);

    await expect(
      connectOnce({
        url: `http://localhost:${server.port}`,
        token: 't',
        hello,
        onServerMessage: () => {},
        onStream: () => {},
        log: () => {},
        env: { HTTP_PROXY: `http://me:wrong@127.0.0.1:${proxy.port}` },
      }),
    ).rejects.toThrow(/refused CONNECT .*407/);
  });

  it('rejects when the proxy is unreachable', async () => {
    const unused = net.createServer();
    await new Promise<void>((res) => unused.listen(0, '127.0.0.1', () => res()));
    const port = (unused.address() as AddressInfo).port;
    await new Promise<void>((res) => unused.close(() => res()));

    await expect(
      connectOnce({
        url: 'http://localhost:1',
        token: 't',
        hello,
        onServerMessage: () => {},
        onStream: () => {},
        log: () => {},
        env: { HTTP_PROXY: `http://127.0.0.1:${port}` },
      }),
    ).rejects.toThrow(/proxy 127\.0\.0\.1:\d+: .*ECONNREFUSED/);
  });

  // TLS over the tunnel, verified against the target's name with a CA of our own (what
  // NODE_EXTRA_CA_CERTS adds for real). Needs openssl to mint the throwaway certificate.
  const hasOpenssl = (() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasOpenssl)('runs TLS to the server inside the tunnel', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-proxy-tls-'));
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });

    const proxy = await startProxy();
    const server = await startWsServer(https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }));
    cleanups.push(proxy.close, server.close);

    const ws = new WebSocket(`wss://localhost:${server.port}/`, {
      ca: fs.readFileSync(cert),
      handshakeTimeout: 5_000,
      createConnection: proxyConnection(new URL(`http://127.0.0.1:${proxy.port}`), true) as never,
    });
    const closed = new Promise<{ code: number; reason: string }>((res, rej) => {
      ws.on('error', rej);
      ws.on('close', (code, reason) => res({ code, reason: reason.toString() }));
    });
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res());
      ws.on('error', rej);
    });
    ws.send('hi');
    expect(await closed).toEqual({ code: 1000, reason: 'probe-ok' });
    expect(proxy.connects).toEqual([`localhost:${server.port}`]);
  });
});
