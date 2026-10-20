import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { tk } from '../i18n/index.js';

/**
 * Guard for a URL the user types and the server then calls (TER-578): https only, no credentials,
 * query or fragment in it, a full domain name (dotted) or a public IP literal, and every address the
 * name resolves to must be public — no loopback, link-local, private, CGNAT, multicast or reserved
 * ranges. It keeps a user with `integrations:create` from making the server reach hosts on its own
 * network (the compose services, the cloud metadata endpoint).
 *
 * The check runs again before each request, so a name that later starts resolving to an internal
 * address is refused then. `fetch` resolves the name once more on its own, so a DNS answer that flips
 * between the check and the connection is not covered here.
 */

// Two lists, one per family: a BlockList matches an IPv4 address against its IPv6 rules too (as
// `::ffff:a.b.c.d`), so a single list with `::ffff:0:0/96` in it would refuse every IPv4 address.
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) BLOCKED_V4.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 (embeds an IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const) BLOCKED_V6.addSubnet(prefix, bits, 'ipv6');

/** True when `ip` (a literal address) is not reachable on the public internet. */
export function isInternalAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true;
  return family === 4 ? BLOCKED_V4.check(ip, 'ipv4') : BLOCKED_V6.check(ip, 'ipv6');
}

/** Suffixes that only exist inside a network, even though they are dotted. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

export type PublicUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const INTERNAL = tk('O endereço aponta para a rede interna (loopback, link-local ou faixa privada)');

/** Synchronous part of the check: the shape of the URL, without touching DNS. */
export function checkUrlShape(raw: string): PublicUrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: tk('Endereço inválido (ex.: https://empresa.atlassian.net)') };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: tk('O endereço precisa usar https') };
  if (url.username || url.password || url.search || url.hash) return { ok: false, reason: tk('O endereço não pode ter usuário, senha, query ou fragmento') };
  const host = hostOf(url);
  if (net.isIP(host)) return isInternalAddress(host) ? { ok: false, reason: INTERNAL } : { ok: true, url };
  if (!host.includes('.') || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: tk('O endereço precisa ter um domínio completo (ex.: empresa.atlassian.net)') };
  }
  return { ok: true, url };
}

/** Full check: the shape, then every address the name resolves to. */
export async function checkPublicUrl(raw: string): Promise<PublicUrlCheck> {
  const shape = checkUrlShape(raw);
  if (!shape.ok) return shape;
  const host = hostOf(shape.url);
  if (net.isIP(host)) return shape;
  let addresses: string[];
  try {
    addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    return { ok: false, reason: tk('Não consegui resolver o domínio do endereço') };
  }
  if (addresses.length === 0) return { ok: false, reason: tk('Não consegui resolver o domínio do endereço') };
  if (addresses.some(isInternalAddress)) return { ok: false, reason: INTERNAL };
  return shape;
}

/** The hostname without IPv6 brackets or a trailing root dot, lowercased. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}
