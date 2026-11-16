import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TAB_FILE_MAX_BYTES } from '@termhub/mobile-api';
import { describe, expect, it } from 'vitest';
import { UPLOAD_BODY_LIMIT } from '../chat/attachments/upload.js';
import { TRANSCRIPTION_MAX_BYTES } from '../terminal/transcription.js';
import { RUN_LIMITS } from '../runs/limits.js';

// The phone talks to the landing host (MOBILE_PUBLIC_URL), whose nginx caps every body under /api/m/ at
// 64k. An upload route without its own location is refused there before the app sees it (TER-1105):
// these checks pick the location nginx would pick for each upload path and read its cap.

const template = readFileSync(fileURLToPath(new URL('../../../../deploy/nginx/termhub.dev.conf.tmpl', import.meta.url)), 'utf8');
/** The termhub.dev server block: the first one, up to the app host's. */
const landing = template.slice(0, template.indexOf('server_name app.termhub.dev'));

interface Location {
  modifier: '=' | '~' | '';
  pattern: string;
  body: string;
}

const locations: Location[] = [...landing.matchAll(/^\s*location\s+(=|~)?\s*(\S+)\s*\{([\s\S]*?)^\s*\}/gm)].map((m) => ({ modifier: (m[1] ?? '') as Location['modifier'], pattern: m[2]!, body: m[3]! }));

/** nginx's choice: an exact match, else the first matching regex, else the longest prefix. */
function locationFor(path: string): Location | undefined {
  const exact = locations.find((l) => l.modifier === '=' && l.pattern === path);
  if (exact) return exact;
  const regex = locations.find((l) => l.modifier === '~' && new RegExp(l.pattern).test(path));
  if (regex) return regex;
  return locations.filter((l) => l.modifier === '' && path.startsWith(l.pattern)).sort((a, b) => b.pattern.length - a.pattern.length)[0];
}

function bodyCap(l: Location): number {
  const m = /client_max_body_size\s+(\d+)([km]?);/.exec(l.body);
  if (!m) return 1024 * 1024; // nginx's default
  return Number(m[1]) * (m[2] === 'm' ? 1024 * 1024 : m[2] === 'k' ? 1024 : 1);
}

describe('termhub.dev vhost: the phone’s upload routes', () => {
  it.each([
    ['a file for a session', '/api/m/v1/tabs/abc123/chat/files', TAB_FILE_MAX_BYTES],
    ['a chat attachment', '/api/m/v1/chat/attachments', UPLOAD_BODY_LIMIT],
    ['a dictation', '/api/m/v1/transcriptions', TRANSCRIPTION_MAX_BYTES],
  ])('%s (%s) takes as much as the server does', (_what, path, limit) => {
    const location = locationFor(path);
    expect(location?.pattern).not.toBe('/api/m/');
    expect(bodyCap(location!)).toBeGreaterThanOrEqual(limit);
    expect(location!.body).toContain('proxy_request_buffering off;');
  });

  it('the rest of the mobile API keeps its small cap', () => {
    const location = locationFor('/api/m/v1/tabs/abc123/chat/messages');
    expect(location?.pattern).toBe('/api/m/');
    expect(bodyCap(location!)).toBe(64 * 1024);
  });
});

// The personal runs API is reachable on the landing host without Cloudflare Access (TER-1190): only its
// own prefix, with a body cap a full prompt fits in and an unbuffered stream that outlives the longest run.
describe('termhub.dev vhost: the personal runs API', () => {
  it('/api/v1/ has its own location, and nothing wider reaches the app', () => {
    expect(locationFor('/api/v1/runs')?.pattern).toBe('/api/v1/');
    expect(locationFor('/api/v1/runs/abc/events')?.pattern).toBe('/api/v1/');
    expect(locationFor('/api/projects')?.pattern).toBe('/');
    expect(locations.some((l) => l.pattern === '/api/' || l.pattern === '/api')).toBe(false);
  });

  it('takes a full prompt, streams unbuffered and outlives the longest run', () => {
    const location = locationFor('/api/v1/runs')!;
    // A UTF-16 unit is at most 3 bytes of UTF-8.
    expect(bodyCap(location)).toBeGreaterThanOrEqual(RUN_LIMITS.maxPromptChars * 3);
    expect(location.body).toContain('proxy_buffering off;');
    const timeout = /proxy_read_timeout\s+(\d+)s;/.exec(location.body);
    expect(Number(timeout?.[1])).toBeGreaterThan(RUN_LIMITS.maxTimeoutS);
    expect(location.body).toMatch(/limit_req zone=termhub_runs /);
  });
});

// A single `proxy_pass http://<host>:3000` with the host spelled out makes nginx resolve that host once,
// at config load, and every `$upstream_app` proxy then reuses that IP instead of asking the Docker
// resolver: once the app container is recreated with a new IP, the whole vhost answers 502.
describe('termhub.dev vhost: upstreams go through a variable', () => {
  it('no proxy_pass names a host literally', () => {
    const proxyPasses = [...template.matchAll(/^\s*proxy_pass\s+(\S+);/gm)].map((m) => m[1]!);
    expect(proxyPasses.length).toBeGreaterThan(0);
    expect(proxyPasses.filter((target) => !/^https?:\/\/\$/.test(target))).toEqual([]);
  });
});
