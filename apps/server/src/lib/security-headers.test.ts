import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TRUST_PROXY, contentSecurityPolicy, hstsFor, parseTrustProxy, registerSecurityHeaders } from './security-headers.js';

describe('parseTrustProxy', () => {
  it('defaults to loopback and the private networks', () => {
    expect(parseTrustProxy(undefined)).toEqual(['loopback', 'uniquelocal']);
    expect(parseTrustProxy('  ')).toEqual(DEFAULT_TRUST_PROXY.split(','));
  });

  it('takes true and false', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(() => parseTrustProxy('2')).toThrow(/TRUST_PROXY inválido/);
  });

  it('takes IPs, CIDRs and presets', () => {
    expect(parseTrustProxy('127.0.0.1, 172.18.0.0/16,::1,fd00::/8,linklocal')).toEqual(['127.0.0.1', '172.18.0.0/16', '::1', 'fd00::/8', 'linklocal']);
  });

  it('refuses what it does not understand', () => {
    expect(() => parseTrustProxy('localhost')).toThrow(/TRUST_PROXY inválido: "localhost"/);
    expect(() => parseTrustProxy('10.0.0.0/33')).toThrow(/10\.0\.0\.0\/33/);
    expect(() => parseTrustProxy('10.0.0.0/8/1')).toThrow();
  });
});

describe('request.ip behind TRUST_PROXY', () => {
  async function ipSeen(trustProxy: ReturnType<typeof parseTrustProxy>, remoteAddress: string, xff: string) {
    const app = Fastify({ trustProxy });
    app.get('/ip', async (request) => ({ ip: request.ip }));
    const res = await app.inject({ method: 'GET', url: '/ip', remoteAddress, headers: { 'x-forwarded-for': xff } });
    await app.close();
    return res.json().ip as string;
  }

  it('ignores X-Forwarded-For from a peer outside the list', async () => {
    expect(await ipSeen(parseTrustProxy(undefined), '203.0.113.9', '1.2.3.4')).toBe('203.0.113.9');
  });

  it('takes the client through cloudflared and nginx on the compose network', async () => {
    expect(await ipSeen(parseTrustProxy(undefined), '172.18.0.5', '198.51.100.7, 172.18.0.3')).toBe('198.51.100.7');
  });

  it('never picks an entry forged to the left of the real client', async () => {
    expect(await ipSeen(parseTrustProxy(undefined), '172.18.0.5', '1.2.3.4, 198.51.100.7, 172.18.0.3')).toBe('198.51.100.7');
  });
});

describe('hstsFor', () => {
  it('only on https', () => {
    expect(hstsFor('https://app.example.org')).toBe('max-age=31536000');
    expect(hstsFor('http://localhost:3000')).toBeNull();
  });
});

describe('contentSecurityPolicy', () => {
  it('locks scripts to the origin and names the websocket host', () => {
    const csp = contentSecurityPolicy('app.example.org');
    expect(csp).toContain("script-src 'self' https://www.googletagmanager.com;");
    expect(csp).toContain("connect-src 'self' ws://app.example.org wss://app.example.org ");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-eval');
  });

  it('drops the websocket entries for a host it would not echo', () => {
    const csp = contentSecurityPolicy('evil.org; script-src *');
    expect(csp).not.toContain('evil');
    expect(csp).toContain("connect-src 'self' blob:");
  });
});

describe('registerSecurityHeaders', () => {
  async function build(publicUrl: string) {
    const app = Fastify();
    registerSecurityHeaders(app, { publicUrl });
    app.get('/page', async (_req, reply) => reply.type('text/html; charset=utf-8').send('<!doctype html>'));
    app.get('/api/x', async () => ({ ok: true }));
    return app;
  }

  it('sends the CSP on HTML and HSTS on https', async () => {
    const app = await build('https://app.example.org');
    const html = await app.inject({ method: 'GET', url: '/page', headers: { host: 'app.example.org' } });
    expect(html.headers['content-security-policy']).toContain('wss://app.example.org');
    expect(html.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(html.headers['x-frame-options']).toBe('DENY');
    const json = await app.inject({ method: 'GET', url: '/api/x' });
    expect(json.headers['content-security-policy']).toBeUndefined();
    expect(json.headers['x-content-type-options']).toBe('nosniff');
    expect(json.headers['strict-transport-security']).toBe('max-age=31536000');
    await app.close();
  });

  it('sends no HSTS on plain http', async () => {
    const app = await build('http://localhost:3000');
    const res = await app.inject({ method: 'GET', url: '/page' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeDefined();
    await app.close();
  });
});
