import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TAB_FILE_MAX_BYTES } from '@termhub/mobile-api';
import { describe, expect, it } from 'vitest';
import { UPLOAD_BODY_LIMIT } from '../chat/attachments/upload.js';
import { TRANSCRIPTION_MAX_BYTES } from '../terminal/transcription.js';

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
