import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiProvider } from './ai-credentials.js';
import { parseUsageScriptOutput, usageRequestScript } from './ai-usage-script.js';

describe('parseUsageScriptOutput', () => {
  const out = (meta: string, response: string) => `termhub-usage-meta\n${meta}\ntermhub-usage-response\n${response}`;

  it('recognises the sentinels', () => {
    expect(parseUsageScriptOutput('termhub-usage-no-credential\n')).toEqual({ kind: 'no_credential' });
    expect(parseUsageScriptOutput('termhub-usage-no-curl\n')).toEqual({ kind: 'no_curl' });
    expect(parseUsageScriptOutput('')).toEqual({ kind: 'invalid' });
    expect(parseUsageScriptOutput('garbage')).toEqual({ kind: 'invalid' });
  });

  it('reads the meta block, the headers, the JSON body and the status', () => {
    const r = parseUsageScriptOutput(out('1760000000000\nmax', 'HTTP/2 200\r\ncontent-type: application/json\r\n\r\n{"five_hour":{"utilization":3}}\ntermhub-usage-status=200\n'));
    expect(r).toEqual({
      kind: 'reply',
      meta: { expires_at: 1760000000000, plan: 'max' },
      reply: { status: 200, body: { five_hour: { utilization: 3 } }, text: '{"five_hour":{"utilization":3}}', retryAfterMs: null },
    });
  });

  it('empty meta lines become null', () => {
    const r = parseUsageScriptOutput(out('\n', 'HTTP/1.1 200 OK\n\n{}\ntermhub-usage-status=200\n'));
    expect(r).toMatchObject({ kind: 'reply', meta: { expires_at: null, plan: null }, reply: { status: 200, body: {} } });
  });

  it('takes the last header block (100 Continue) and reads Retry-After case-insensitively', () => {
    const r = parseUsageScriptOutput(out('\n', 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 429 Too Many Requests\r\nRETRY-AFTER: 30\r\n\r\n{"error":"slow down"}\ntermhub-usage-status=429\n'));
    expect(r).toMatchObject({ kind: 'reply', reply: { status: 429, body: { error: 'slow down' }, retryAfterMs: 30_000 } });
  });

  it('a curl failure (status 000) is status 0 with no body', () => {
    const r = parseUsageScriptOutput(out('\n', '\ntermhub-usage-status=000\n'));
    expect(r).toMatchObject({ kind: 'reply', reply: { status: 0, body: null, text: '' } });
  });

  it('a non-JSON body keeps its text', () => {
    const r = parseUsageScriptOutput(out('\n', 'HTTP/1.1 502 Bad Gateway\n\n<html>bad</html>\ntermhub-usage-status=502\n'));
    expect(r).toMatchObject({ kind: 'reply', reply: { status: 502, body: null, text: '<html>bad</html>' } });
  });

  it('is invalid without the status line', () => {
    expect(parseUsageScriptOutput(out('\n', 'HTTP/1.1 200 OK\n\n{}'))).toEqual({ kind: 'invalid' });
  });
});

describe('usageRequestScript', () => {
  it('throws on an invalid config dir', () => {
    expect(() => usageRequestScript('claude', 'a\nb', { url: 'https://x.test' })).toThrow('Invalid config dir');
  });

  it('shell-quotes the url, headers and body, and never puts a token placeholder on the command line', () => {
    const s = usageRequestScript('gemini', null, { url: "https://x.test/a'b", method: 'POST', headers: { 'x-h': "v'1" }, body: '{"a":"\'"}' });
    expect(s).toContain(`'https://x.test/a'\\''b'`);
    expect(s).toContain(`-H 'x-h: v'\\''1'`);
    expect(s).toContain('-X POST --data-binary');
    expect(s).toContain('-H @-');
    expect(s).not.toMatch(/curl[^\n]*\$T/);
  });
});

describe.skipIf(!existsSync('/bin/sh'))('usageRequestScript (real /bin/sh)', () => {
  let root: string;
  let bin: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'termhub-ai-usage-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    // fake `uname` so the claude script never reaches the macOS keychain
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Linux\n');
    chmodSync(join(bin, 'uname'), 0o755);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A fake curl that records its argv and stdin and answers a canned response. */
  const installCurl = (status = 200, responseBody = '{"five_hour":{"utilization":5}}') => {
    writeFileSync(
      join(bin, 'curl'),
      [
        '#!/bin/sh',
        `for a in "$@"; do printf '%s\\n' "$a"; done > "${root}/argv"`,
        `cat > "${root}/stdin"`,
        `printf 'HTTP/1.1 ${status} X\\r\\ncontent-type: application/json\\r\\n\\r\\n%s' '${responseBody}'`,
        `printf '\\ntermhub-usage-status=${status}\\n'`,
        // curl fails: the script still exits 0
        'exit 7',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'curl'), 0o755);
  };

  const run = (provider: AiProvider, configDir: string | null, url = 'https://usage.test/x', extraPath = '') => {
    const script = usageRequestScript(provider, configDir, { url, headers: { accept: 'application/json' } });
    return execFileSync('/bin/sh', ['-c', script], {
      env: { PATH: `${bin}${extraPath}`, HOME: root },
      encoding: 'utf8',
    });
  };

  // PATH for sh's own tools (awk, sed, cat) without picking up a real curl
  const SYSTEM_TOOLS = ':/usr/bin:/bin';

  it('claude: the freshest candidate wins, its token reaches curl only on stdin, plan and expiry come back', () => {
    installCurl();
    const dir = join(root, '.claude');
    mkdirSync(dir);
    // pretty-printed, with an MCP OAuth entry that must not be picked
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({ mcpOAuth: { 'srv|1': { accessToken: 'mcp-token', expiresAt: 9999999999999 } }, claudeAiOauth: { accessToken: 'file-token', expiresAt: 1700000000000, scopes: ['a'], subscriptionType: 'max' } }, null, 2),
    );
    const stdout = run('claude', null, 'https://usage.test/x', SYSTEM_TOOLS);
    expect(readFileSync(join(root, 'stdin'), 'utf8')).toBe('authorization: Bearer file-token\n');
    const argv = readFileSync(join(root, 'argv'), 'utf8');
    expect(argv).not.toContain('file-token');
    expect(argv).toContain('accept: application/json');
    expect(argv).toContain('https://usage.test/x');
    expect(stdout).not.toContain('file-token');
    expect(parseUsageScriptOutput(stdout)).toEqual({
      kind: 'reply',
      meta: { expires_at: 1700000000000, plan: 'max' },
      reply: { status: 200, body: { five_hour: { utilization: 5 } }, text: '{"five_hour":{"utilization":5}}', retryAfterMs: null },
    });
  });

  it('claude: picks the candidate with the largest expiresAt across separators (first wins on ties, undated = 0)', async () => {
    installCurl();
    const { CREDENTIAL_SEPARATOR } = await import('./ai-credentials.js');
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    // the on-disk file is the only candidate the script prints on non-Darwin, so feed several through it
    const doc = (t: string, e?: number) => JSON.stringify({ claudeAiOauth: { accessToken: t, ...(e !== undefined ? { expiresAt: e } : {}) } });
    writeFileSync(join(dir, '.credentials.json'), [doc('undated'), doc('old', 100), doc('fresh', 500), doc('tie', 500), 'garbage'].join(`\n${CREDENTIAL_SEPARATOR}\n`));
    const stdout = run('claude', dir, 'https://usage.test/x', SYSTEM_TOOLS);
    expect(readFileSync(join(root, 'stdin'), 'utf8')).toBe('authorization: Bearer fresh\n');
    expect(parseUsageScriptOutput(stdout)).toMatchObject({ kind: 'reply', meta: { expires_at: 500, plan: null } });
  });

  it('chatgpt: sends the account id through stdin as well', () => {
    installCurl();
    const dir = join(root, '.codex');
    mkdirSync(dir);
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'id', access_token: 'chat-token', refresh_token: 'r', account_id: 'acc-9' } }, null, 2));
    const stdout = run('chatgpt', null, 'https://usage.test/x', SYSTEM_TOOLS);
    expect(readFileSync(join(root, 'stdin'), 'utf8')).toBe('authorization: Bearer chat-token\nchatgpt-account-id: acc-9\n');
    expect(readFileSync(join(root, 'argv'), 'utf8')).not.toContain('chat-token');
    expect(stdout).not.toContain('chat-token');
    expect(parseUsageScriptOutput(stdout)).toMatchObject({ kind: 'reply', meta: { expires_at: null, plan: null } });
  });

  it('gemini and antigravity: read the access token (and gemini expiry_date)', () => {
    installCurl();
    const dir = join(root, '.gemini');
    mkdirSync(join(dir, 'antigravity-cli'), { recursive: true });
    writeFileSync(join(dir, 'oauth_creds.json'), JSON.stringify({ access_token: 'gem-token', refresh_token: 'r', expiry_date: 1800000000000 }));
    writeFileSync(join(dir, 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ token: { access_token: 'agy-token', expiry: '2026-01-01T00:00:00Z' } }));
    const g = run('gemini', null, 'https://usage.test/x', SYSTEM_TOOLS);
    expect(readFileSync(join(root, 'stdin'), 'utf8')).toBe('authorization: Bearer gem-token\n');
    expect(parseUsageScriptOutput(g)).toMatchObject({ kind: 'reply', meta: { expires_at: 1800000000000 } });
    const a = run('antigravity', null, 'https://usage.test/x', SYSTEM_TOOLS);
    expect(readFileSync(join(root, 'stdin'), 'utf8')).toBe('authorization: Bearer agy-token\n');
    expect(parseUsageScriptOutput(a)).toMatchObject({ kind: 'reply', meta: { expires_at: null } });
  });

  it('prints the no-credential sentinel when there is no token', () => {
    installCurl();
    const stdout = run('claude', null, 'https://usage.test/x', SYSTEM_TOOLS);
    expect(stdout).toBe('termhub-usage-no-credential\n');
    expect(existsSync(join(root, 'argv'))).toBe(false);
  });

  it('prints the no-curl sentinel when curl is missing ', () => {
    // a PATH holding only the tools the script needs, so a real /usr/bin/curl is not found
    for (const tool of ['awk', 'sed', 'cat']) {
      const found = ['/usr/bin', '/bin'].map((d) => join(d, tool)).find((p) => existsSync(p));
      if (!found) return;
      writeFileSync(join(bin, tool), `#!/bin/sh\nexec ${found} "$@"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const dir = join(root, '.gemini');
    mkdirSync(dir);
    writeFileSync(join(dir, 'oauth_creds.json'), JSON.stringify({ access_token: 'gem-token' }));
    expect(run('gemini', null)).toBe('termhub-usage-no-curl\n');
  });
});
