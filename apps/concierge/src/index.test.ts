import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const PORT = 41917;
const SECRET = 'concierge-test-secret';

let server: { close(): void };
/** Holds the fake `claude` binaries this file puts on PATH, so a run goes through the real
 * spawn/stderr/exit-code path without a CLI login or a network call. */
let bin: string;

/** Writes an executable fake CLI and makes it the `claude` the service will spawn. */
function fakeCli(body: string) {
  const dir = mkdtempSync(join(bin, 'cli-'));
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
}

beforeAll(async () => {
  process.env.CONCIERGE_SECRET = SECRET;
  process.env.PORT = String(PORT);
  bin = mkdtempSync(join(tmpdir(), 'concierge-http-'));
  mkdirSync(join(bin, 'cfg'));
  ({ server } = await import('./index.js'));
});

afterAll(() => {
  server.close();
  rmSync(bin, { recursive: true, force: true });
});

function post(path: string, requestBody: string, headers: Record<string, string> = { 'x-concierge-secret': SECRET }) {
  return fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    body: requestBody,
    headers,
  });
}

const runBody = () =>
  JSON.stringify({
    session_id: '3f1e9b1e-0000-4000-8000-000000000001',
    resume: true,
    text: 'o que está rodando?',
    config_dir: join(bin, 'cfg'),
    model: null,
    token: 'thb_pat_' + 'A'.repeat(43),
    mcp_url: 'https://termhub.dev/mcp',
  });

it('a malformed JSON body answers 400 and the process stays up', async () => {
  const res = await post('/run', '{');
  expect(res.status).toBe(400);

  // the actual regression: an unhandled JSON.parse throw used to take the whole service down
  const health = await fetch(`http://127.0.0.1:${PORT}/health`);
  expect(health.status).toBe(200);
});

it('a body over the size cap answers 413, before it is ever parsed', async () => {
  const oversized = 'x'.repeat(70 * 1024);
  const res = await post('/run', oversized);
  expect(res.status).toBe(413);
});

// The runner's entire trust boundary: the compose network is not authentication (spec §7.2).
it('refuses a run with no secret at all', async () => {
  const res = await post('/run', runBody(), { 'content-type': 'application/json' });
  expect(res.status).toBe(401);
});

it('refuses a run with the wrong secret', async () => {
  const res = await post('/run', runBody(), { 'x-concierge-secret': `${SECRET}-nope` });
  expect(res.status).toBe(401);
});

it('secretMatches: an empty configured secret refuses even an empty header', async () => {
  const { secretMatches } = await import('./index.js');
  expect(secretMatches('', '')).toBe(false);
  expect(secretMatches(undefined, SECRET)).toBe(false);
  expect(secretMatches([SECRET], SECRET)).toBe(false);
  expect(secretMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
  expect(secretMatches(SECRET, SECRET)).toBe(true);
});

it('accepts the correct secret', async () => {
  fakeCli(`echo '{"type":"result","session_id":"'"$2"'"}'`);
  const res = await post('/run', runBody());
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('"type":"result"');
});

// The fresh-session fallback depends on this end to end: the CLI's "No conversation found" lives in
// stderr, which never leaves the container, so the failure is classified here and only the label
// travels. Without this frame the app could never clear a session it can no longer resume.
it('classifies a CLI that exits non-zero complaining about the session, without forwarding stderr', async () => {
  fakeCli(`echo 'No conversation found with session ID 3f1e9b1e-0000-4000-8000-000000000001' >&2\nexit 1`);
  const res = await post('/run', runBody());
  expect(res.status).toBe(200); // the stream had already started: the failure is the last frame
  const body = await res.text();
  expect(JSON.parse(body.trim().split('\n').at(-1)!)).toEqual({ type: 'termhub_error', code: 1, reason: 'missing_session' });
  expect(body).not.toContain('No conversation found');
});

it('reports any other non-zero exit as a generic failure', async () => {
  fakeCli(`echo 'Error: /home/u/.claude/projects/x — Invalid API key · /dev/pts/3' >&2\nexit 2`);
  const res = await post('/run', runBody());
  const body = await res.text();
  expect(JSON.parse(body.trim().split('\n').at(-1)!)).toEqual({ type: 'termhub_error', code: 2, reason: 'run_failed' });
  // stderr can carry terminal content and paths: none of it may appear on the wire (spec §7.1)
  expect(body).not.toContain('Invalid API key');
  expect(body).not.toContain('/dev/pts/3');
});
