import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { parseAppHeader } from '@termhub/mobile-api';
import type { Device } from '../db/repositories/devices.js';
import { requestLocale } from '../i18n/index.js';

/**
 * Where a chat message comes from (TER-1088): the client, the device, the network and the person's time
 * zone and language, built by the server from the request so the concierge does not have to ask "where
 * are you?" or "are you near the machine?". The network part compares the request's public IP with the
 * public IP each of the person's machines' agents connected from: the same IPv4 (one NAT) or the same
 * IPv6 /64 means the same network. The IP itself never goes into the message text; it stays in memory
 * (`rememberOrigin`) for `get_client_context`, and is gone at a restart.
 */
export interface ClientSignals {
  client: 'web' | 'ios' | 'android';
  app_version: string | null;
  device: 'phone' | 'tablet' | 'computer' | null;
  os: string | null;
  ip: string | null;
  time_zone: string | null;
  locale: string;
}

export interface ClientOrigin extends ClientSignals {
  /** Names of the person's machines whose agent connects from the same public network; empty when none
   *  (or when it cannot be told: no public IP on either side). */
  same_network_as: string[];
  /** ISO time the message came in. */
  at: string;
}

/** The time zone header both clients send (`X-Termhub-Time-Zone`), kept only when it is a real IANA name;
 *  null without one (the service falls back to the zone saved on the account). */
export function timeZoneOf(request: FastifyRequest): string | null {
  const raw = request.headers['x-termhub-time-zone'];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value && value.length <= 64 && validTimeZone(value)) return value;
  return null;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Device and system from a browser's User-Agent. iPadOS in desktop mode says "Macintosh", and reads as one. */
export function deviceFromUserAgent(ua: string | undefined): Pick<ClientSignals, 'device' | 'os'> {
  if (!ua) return { device: null, os: null };
  if (/iPad/.test(ua)) return { device: 'tablet', os: 'iPadOS' };
  if (/iPhone|iPod/.test(ua)) return { device: 'phone', os: 'iOS' };
  if (/Android/.test(ua)) return { device: /Mobile/.test(ua) ? 'phone' : 'tablet', os: 'Android' };
  if (/CrOS/.test(ua)) return { device: 'computer', os: 'ChromeOS' };
  if (/Windows/.test(ua)) return { device: 'computer', os: 'Windows' };
  if (/Macintosh|Mac OS X/.test(ua)) return { device: 'computer', os: 'macOS' };
  if (/Linux|X11/.test(ua)) return { device: 'computer', os: 'Linux' };
  return { device: null, os: null };
}

/** The web's message: version from `X-Termhub-Client` (`web/<version>`), device from the User-Agent. */
export function webSignals(request: FastifyRequest): ClientSignals {
  const client = request.headers['x-termhub-client'];
  const version = typeof client === 'string' ? /^web\/(\d+\.\d+\.\d+)$/.exec(client.trim())?.[1] ?? null : null;
  return { client: 'web', app_version: version, ...deviceFromUserAgent(request.headers['user-agent']), ip: request.ip || null, time_zone: timeZoneOf(request), locale: requestLocale(request) };
}

/** The phone's message: platform and version from `X-Termhub-App` (else the device row), model and system from the device. */
export function mobileSignals(request: FastifyRequest, device: Pick<Device, 'platform' | 'model' | 'os_version' | 'app_version'>): ClientSignals {
  const raw = request.headers['x-termhub-app'];
  const app = parseAppHeader(typeof raw === 'string' ? raw : undefined);
  const platform = app?.platform ?? (device.platform === 'android' ? 'android' : 'ios');
  const system = platform === 'android' ? 'Android' : /iPad/i.test(device.model) ? 'iPadOS' : 'iOS';
  return {
    client: platform,
    app_version: app?.version ?? (device.app_version.split('+')[0] || null),
    device: /iPad|tablet|\bTab\b/i.test(device.model) ? 'tablet' : 'phone',
    os: device.os_version ? `${system} ${device.os_version}` : system,
    ip: request.ip || null,
    time_zone: timeZoneOf(request),
    locale: requestLocale(request),
  };
}

/** `::ffff:1.2.3.4` → `1.2.3.4`, a zone id dropped, lower case; null for anything that is not an IP. */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let v = ip.trim().toLowerCase().replace(/%.*$/, '');
  if (v.startsWith('::ffff:') && isIP(v.slice(7)) === 4) v = v.slice(7);
  return isIP(v) ? v : null;
}

/** The eight hextets of an IPv6 address, `::` expanded. */
function hextets(ip: string): number[] {
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, undefined];
  const part = (s: string | undefined) => (s ? s.split(':') : []);
  const toNums = (xs: string[]) => xs.flatMap((x) => (x.includes('.') ? v4ToHextets(x) : [parseInt(x, 16)]));
  const h = toNums(part(head));
  const t = toNums(part(tail));
  return tail === undefined ? h : [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
}

function v4ToHextets(v4: string): number[] {
  const [a, b, c, d] = v4.split('.').map(Number);
  return [(a! << 8) | b!, (c! << 8) | d!];
}

/**
 * Whether an address is routable on the internet: a private, loopback, link-local, CGNAT or unique-local
 * address says nothing about which network it is in (two homes both have 192.168.0.10), so it never
 * counts as "the same network".
 */
export function isPublicIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  const first = hextets(ip)[0]!;
  // Only global unicast (2000::/3) is public; ::1, fe80::/10, fc00::/7 and multicast are not.
  return (first & 0xe000) === 0x2000;
}

/** The same public network: the same IPv4 (behind one NAT), or IPv6 addresses in the same /64. */
export function sameNetwork(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeIp(a);
  const y = normalizeIp(b);
  if (!x || !y || !isPublicIp(x) || !isPublicIp(y)) return false;
  const fx = isIP(x);
  if (fx !== isIP(y)) return false;
  if (fx === 4) return x === y;
  const hx = hextets(x);
  const hy = hextets(y);
  return hx.slice(0, 4).every((h, i) => h === hy[i]);
}

/** The names of `machines` whose agent's public IP is on the client's network, in the order given. */
export function sameNetworkAs(clientIp: string | null, machines: { name: string; ip: string | null }[]): string[] {
  return machines.filter((m) => sameNetwork(clientIp, m.ip)).map((m) => m.name);
}

const CLIENT_LABEL: Record<ClientSignals['client'], string> = { web: 'web', ios: 'iOS app', android: 'Android app' };

/** The line the concierge reads before the person's message. English, like every text the model reads; no IP. */
export function originLine(o: ClientOrigin): string {
  const parts = [
    `${CLIENT_LABEL[o.client]}${o.app_version ? ` ${o.app_version}` : ''}`,
    [o.device, o.os].filter(Boolean).join(', ') || 'unknown device',
    o.same_network_as.length > 0 ? `same network as: ${o.same_network_as.join(', ')}` : 'not on the same network as any of their machines (or it cannot be told)',
    ...(o.time_zone ? [`time zone ${o.time_zone}`] : []),
    `language ${o.locale}`,
  ];
  return `[termhub origin] Where the person sent the message below from, as the server saw it: ${parts.join(' · ')}. Use this before asking where they are or whether they are near a machine; get_client_context has the details.`;
}

/** The last origin of each conversation, in memory only (the IP is never stored), for `get_client_context`. */
const lastOrigin = new Map<string, ClientOrigin>();
const MAX_REMEMBERED = 5000;

export function rememberOrigin(conversationId: string, origin: ClientOrigin): void {
  lastOrigin.delete(conversationId);
  lastOrigin.set(conversationId, origin);
  if (lastOrigin.size > MAX_REMEMBERED) lastOrigin.delete(lastOrigin.keys().next().value!);
}

export function recalledOrigin(conversationId: string): ClientOrigin | null {
  return lastOrigin.get(conversationId) ?? null;
}

export function forgetOrigin(conversationId: string): void {
  lastOrigin.delete(conversationId);
}
