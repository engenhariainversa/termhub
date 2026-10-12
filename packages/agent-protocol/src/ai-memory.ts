import { z } from 'zod';

/** Where `ai-memory serve --transport http` listens unless the person says otherwise (spike TER-1008). */
export const AI_MEMORY_DEFAULT_URL = 'http://127.0.0.1:49374';

const ipv4 = (host: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
};

/**
 * Loopback (`localhost`, 127.0.0.0/8, `::1`) or a private network (10/8, 172.16/12, 192.168/16,
 * fc00::/7). Any other name is refused, even one that resolves to a private address today: the
 * check has to hold without a DNS lookup. `host` is a WHATWG `URL.hostname`, so alternative IPv4
 * spellings (`127.1`, `2130706433`) already arrive as dotted quads and IPv6 comes in brackets.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  const v4 = ipv4(h);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (h.startsWith('[') && h.endsWith(']')) {
    const v6 = h.slice(1, -1);
    return v6 === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(v6);
  }
  return false;
}

/**
 * The ai-memory server URL as stored and sent to the agent: an http(s) origin on loopback or a private
 * network, nothing else (no credentials, path, query or fragment). Returns the normalized origin, or
 * null when the URL is refused — the server keeps ai-memory's data on the machine, so it never lets a
 * machine point the probe at a public address.
 */
export function normalizeAiMemoryUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
  if (!isPrivateHost(url.hostname)) return null;
  return url.origin;
}

export const aiMemoryUrl = z
  .string()
  .max(200)
  .refine((u) => normalizeAiMemoryUrl(u) !== null, 'ai-memory URL must be loopback or a private network')
  .transform((u) => normalizeAiMemoryUrl(u) as string);
