import type { FastifyInstance, FastifyRequest } from 'fastify';
import net from 'node:net';

/**
 * Who may set X-Forwarded-For / -Proto / -Host (TER-579). Before, the server trusted every peer, so
 * anyone who could reach the port directly picked their own `request.ip`, and that address feeds the
 * login lockout, the waitlist limit and the device sign-in records.
 *
 * Default: loopback plus the private ranges (10/8, 172.16/12, 192.168/16, fc00::/7), where a local
 * proxy and the compose networks (cloudflared → nginx → app) live. `proxy-addr`, which Fastify uses,
 * walks X-Forwarded-For from the right and stops at the first untrusted hop, so a forged entry sent
 * through Cloudflare stays to the left of the real client address and is never picked.
 */
export const DEFAULT_TRUST_PROXY = 'loopback,uniquelocal';

const PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** A single IP or an IP/prefix CIDR, IPv4 or IPv6. */
function isAddressOrCidr(entry: string): boolean {
  const [addr, prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  const family = net.isIP(addr);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * `TRUST_PROXY`, as Fastify's `trustProxy` takes it: `true` (every hop, the old behaviour), `false`
 * (none: `request.ip` is the socket peer), or a comma list of IPs, CIDRs and the presets `loopback`,
 * `linklocal`, `uniquelocal`. Throws on an entry it does not understand, so a typo stops the boot
 * instead of quietly trusting nothing.
 */
export function parseTrustProxy(raw: string | undefined): boolean | string[] {
  const value = (raw ?? '').trim() || DEFAULT_TRUST_PROXY;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = entries.filter((e) => !PRESETS.has(e) && !isAddressOrCidr(e));
  if (bad.length > 0) throw new Error(`TRUST_PROXY inválido: ${bad.map((b) => `"${b}"`).join(', ')}`);
  return entries;
}

/** One year, without includeSubDomains: the app's host must not decide for its sibling hosts. */
export const HSTS_VALUE = 'max-age=31536000';

/** HSTS only when the public address is https: on a plain-http install the header would be a lie. */
export function hstsFor(publicUrl: string): string | null {
  return publicUrl.startsWith('https://') ? HSTS_VALUE : null;
}

/**
 * Google Analytics through the Firebase SDK (apps/web/src/lib/analytics.ts): gtag.js and the hosts it
 * reports to. Only used when the web bundle was built with the VITE_FIREBASE_* variables; without
 * them the page never contacts these hosts.
 */
const ANALYTICS_SCRIPT = 'https://www.googletagmanager.com';
const ANALYTICS_CONNECT = [
  'https://*.google-analytics.com',
  'https://*.analytics.google.com',
  'https://*.googletagmanager.com',
  'https://firebase.googleapis.com',
  'https://firebaseinstallations.googleapis.com',
];

/** A Host header we are willing to echo into the policy; anything else just drops the ws entries. */
const SAFE_HOST = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i;

/**
 * The app's and the city's Content-Security-Policy. `script-src 'self'`: both bundles are plain
 * modules, never inline (the office's Pixi runs without eval thanks to `pixi.js/unsafe-eval`).
 * `img-src https:` covers user avatars (Google) and pictures in notes' markdown. `style-src` keeps
 * 'unsafe-inline' because xterm and the office inject style elements at run time. The WebSocket
 * entries name the request's own host: 'self' already covers ws(s) of the same host in current
 * browsers, the explicit entry is for older Safari.
 */
export function contentSecurityPolicy(host: string | undefined): string {
  const ws = host && SAFE_HOST.test(host) ? [`ws://${host}`, `wss://${host}`] : [];
  return [
    "default-src 'self'",
    `script-src 'self' ${ANALYTICS_SCRIPT}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' blob: data:",
    `connect-src 'self' ${[...ws, 'blob:', 'data:', ...ANALYTICS_CONNECT].join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function isHtml(contentType: unknown): boolean {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('text/html');
}

/** Every response: nosniff, no framing, same-origin referrer, HSTS on https; HTML also gets the CSP. */
export function registerSecurityHeaders(fastify: FastifyInstance, opts: { publicUrl: string }): void {
  const hsts = hstsFor(opts.publicUrl);
  fastify.addHook('onSend', async (request: FastifyRequest, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    if (hsts) reply.header('strict-transport-security', hsts);
    if (isHtml(reply.getHeader('content-type'))) reply.header('content-security-policy', contentSecurityPolicy(request.host));
  });
}
