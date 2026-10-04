import { spawn } from 'node:child_process';
import type { PublicBuilding, PublicCity } from './city.js';

/**
 * The link preview card: what WhatsApp, Slack and X show before anyone clicks. It is drawn in the
 * same visual language as `apps/landing/og/og-image.svg` (same size, same palette, same product
 * mark), but for the city the link points at — whose city, how many projects it shows, and how many
 * agents are working right now — instead of one fixed image for every link.
 */

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Every name in the card was written by someone else (an owner's name, a project's): never trust it as markup. */
function xml(s: string): string {
  // ASCII control characters (tab/newline/CR included — these are single-line labels) are not
  // valid XML text content; rsvg-convert simply fails to parse them, silently breaking that one
  // city's card while every other city keeps working. Strip before escaping the XML metacharacters.
  return s.replace(/[\x00-\x1F\x7F]/g, '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The building a link points at, resolved from the public (obfuscated) id in the query. Exported so
 * a caller (the route's cache) can key on what this actually resolved to rather than on the raw
 * query string — an id that matches nothing (a stale one, or a machine id from the links of the
 * city by machine) must collapse onto the same entry as no id at all, not mint one cache entry per
 * garbage value.
 */
export function resolveFocus(city: PublicCity, focus: { building?: string }): { building?: PublicBuilding } {
  return { building: focus.building ? city.buildings.find((b) => b.id === focus.building) : undefined };
}

export function buildCardSvg(city: PublicCity, focus: { building?: string }): string {
  const { building } = resolveFocus(city, focus);

  // What "is happening right now" scopes to the depth the link points at: a building card counts
  // only that project's agents, the city card counts everyone's.
  const robots = building ? building.robots : city.buildings.flatMap((b) => b.robots);
  const agents = plural(robots.filter((r) => r.state === 'working' || r.state === 'waiting_background').length, 'agente trabalhando', 'agentes trabalhando');
  const live = building ? `${xml(building.name)} — ${agents}` : `${plural(city.buildings.length, 'projeto', 'projetos')} · ${agents}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs>
    <linearGradient id="cta" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#5b63d3"/>
      <stop offset="1" stop-color="#7c87f7"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.1" r="0.7">
      <stop offset="0" stop-color="#5b63d3" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#0f101a" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#0f101a"/>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow)"/>
  <!-- mark: the same terminal-window icon as public/logo.svg's, self-contained so rasterising needs no second file -->
  <g transform="translate(90 56)">
    <rect x="1" y="1" width="64" height="64" rx="14" fill="#151621" stroke="#1f2433" stroke-width="2"/>
    <circle cx="14" cy="14" r="2.6" fill="#646e87"/>
    <circle cx="23" cy="14" r="2.6" fill="#939db8"/>
    <circle cx="32" cy="14" r="2.6" fill="#c9d3ee"/>
    <polyline points="15,30 28,41 15,52" fill="none" stroke="url(#cta)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="35" y="47" width="17" height="6" rx="2" fill="url(#cta)"/>
  </g>
  <text x="170" y="98" font-family="Inter, sans-serif" font-size="34" font-weight="700" fill="#e6e8ee">termhub</text>
  <text x="1110" y="98" text-anchor="end" font-family="Inter, sans-serif" font-size="24" fill="#646e87">termhub.dev</text>
  <text x="90" y="260" font-family="Inter, sans-serif" font-size="60" font-weight="700" fill="#c9d3ee">Cidade de ${xml(city.owner_name)}</text>
  <text x="90" y="400" font-family="Inter, sans-serif" font-size="34" font-weight="600" fill="#c9d3ee">${live}</text>
  <rect x="90" y="530" width="404" height="46" rx="10" fill="#151621" stroke="#1f2433" stroke-width="2"/>
  <circle cx="118" cy="553" r="5" fill="#98a4f7"/>
  <text x="134" y="562" font-family="Inter, sans-serif" font-size="22" fill="#c9d3ee">self-hosted · open source · MIT</text>
</svg>
`;
}

/**
 * Rasterises with the same tool `apps/landing/og/build.sh` uses at build time (librsvg's
 * `rsvg-convert`), but at runtime, as a subprocess of the server: no Node rasteriser tied to the
 * Node ABI. `TERMHUB_RSVG_BIN` lets a test (or an unusual deploy) point at a different binary; a
 * missing binary, a failed spawn, a non-zero exit, a process that never exits, or one that floods
 * stdout all resolve `null` rather than throw or hang — a developer machine without librsvg, or a
 * misbehaving one, must never turn a card request into a 500 or a request that never ends. This is
 * the one fully anonymous, process-spawning path in the product, so it owns its own limits rather
 * than trusting the rasteriser to behave.
 */
export function renderCard(svg: string): Promise<Buffer | null> {
  // Read per call, not at module load: a test stubs these env vars around one specific call, and a
  // module-level constant would have already frozen the default before the stub ever took effect.
  const timeoutMs = Number(process.env.TERMHUB_RSVG_TIMEOUT_MS ?? 5_000);
  // A card is a few tens of KB at most (1200x630, a handful of text runs); this is a generous cap
  // against a rasteriser gone wrong, not a realistic size.
  const maxBytes = Number(process.env.TERMHUB_RSVG_MAX_BYTES ?? 8 * 1024 * 1024);
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(process.env.TERMHUB_RSVG_BIN ?? 'rsvg-convert', ['-w', String(CARD_WIDTH), '-h', String(CARD_HEIGHT)], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Neither limit trusts the process to die on its own: both explicitly kill it before giving up,
    // so a hung or flooding rsvg-convert doesn't linger as an orphan after the request moves on.
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    proc.on('error', () => finish(null));
    proc.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        proc.kill('SIGKILL');
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    proc.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks) : null));
    // A missing binary makes stdin die too (EPIPE) right after the 'error' event above fires;
    // without a listener here that second, unrelated error would crash the process.
    proc.stdin.on('error', () => {});
    proc.stdin.end(svg);
  });
}
