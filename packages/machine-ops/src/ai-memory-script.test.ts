import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_MEMORY_RULE_PATH_RE, buildAiMemoryRulesScript, parseAiMemorySync } from './ai-memory-script.js';
import { shellQuote } from './shell.js';

const P1 = '_rules/termhub-usar-pnpm-abc123.md';
const P2 = '_rules/termhub-sem-deploy-sexta-def456.md';

let root: string;
let bin: string;
let repo: string;
let calls: string;

/** A fake `ai-memory` that records each call (argv, stdin, server url) and fails on a `fail` path. */
const FAKE = `#!/bin/sh
{
  printf 'ARGS'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'
  printf 'URL %s\\n' "$AI_MEMORY_SERVER_URL"
  if [ "$1" = write-page ]; then printf 'STDIN['; cat; printf ']\\n'; fi
} >> "$CALLS"
echo "INFO noise" >&2
case "$*" in *-fail-*) exit 1;; esac
echo "✓ done"
`;

function run(script: string, withBin = true): string {
  const PATH = withBin ? `${bin}:/usr/bin:/bin` : '/usr/bin:/bin';
  return execFileSync('/bin/sh', ['-c', script], { env: { PATH, HOME: root, CALLS: calls, TMPDIR: root }, encoding: 'utf8' });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aim-'));
  bin = join(root, 'bin');
  repo = join(root, 'repo');
  calls = join(root, 'calls.log');
  mkdirSync(bin);
  mkdirSync(repo);
  writeFileSync(join(bin, 'ai-memory'), FAKE);
  chmodSync(join(bin, 'ai-memory'), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const input = (over: Partial<Parameters<typeof buildAiMemoryRulesScript>[0]> = {}) => ({
  cwd: repo,
  server_url: 'http://127.0.0.1:49374',
  writes: [{ path: P1, title: 'Usar pnpm', body: 'Sempre pnpm.\n\nRegra vigente do termhub (note:abc123).' }],
  deletes: [P2],
  ...over,
});

describe('buildAiMemoryRulesScript', () => {
  it('skips a missing cwd, a missing binary and a missing marker, in that order', () => {
    expect(run(buildAiMemoryRulesScript(input({ cwd: join(root, 'nope') })))).toBe('skip no_cwd\n');
    // The script puts Homebrew's and /usr/local's bin on the PATH itself: only assert where neither has one.
    if (!existsSync('/opt/homebrew/bin/ai-memory') && !existsSync('/usr/local/bin/ai-memory')) {
      expect(run(buildAiMemoryRulesScript(input()), false)).toBe('skip no_binary\n');
    }
    expect(run(buildAiMemoryRulesScript(input()))).toBe('skip no_marker\n');
    expect(existsSync(join(repo, '.ai-memory.toml'))).toBe(false);
    expect(existsSync(calls)).toBe(false);
  });

  it('writes and deletes through the CLI with the server url, reporting each outcome', () => {
    writeFileSync(join(repo, '.ai-memory.toml'), '[project]\nname = "x"\n');
    const out = run(buildAiMemoryRulesScript(input()));
    expect(out).toBe(`ok briefing\nok write ${P1}\nok delete ${P2}\n`);
    const log = readFileSync(calls, 'utf8');
    expect(log).toContain(`ARGS [write-page] [--path=${P1}] [--kind=rule] [--pinned] [--title=Usar pnpm] [-t] [termhub] [--body] [-]`);
    expect(log).toContain('STDIN[Sempre pnpm.\n\nRegra vigente do termhub (note:abc123).]');
    expect(log).toContain(`ARGS [delete-page] [--path=${P2}]`);
    expect(log).toContain('URL http://127.0.0.1:49374');
  });

  it('reports a failed write and goes on', () => {
    writeFileSync(join(repo, '.ai-memory.toml'), '');
    const bad = '_rules/termhub-x-fail-1.md';
    const out = run(buildAiMemoryRulesScript(input({ writes: [{ path: bad, title: 't', body: 'b' }, { path: P1, title: 't', body: 'b' }], deletes: [] })));
    expect(out).toBe(`ok briefing\nfail write ${bad}\nok write ${P1}\n`);
  });

  it('does not touch the marker when there are only deletes', () => {
    writeFileSync(join(repo, '.ai-memory.toml'), '[project]\n');
    expect(run(buildAiMemoryRulesScript(input({ writes: [] })))).toBe(`ok delete ${P2}\n`);
    expect(readFileSync(join(repo, '.ai-memory.toml'), 'utf8')).toBe('[project]\n');
  });

  it('passes quotes, $(), backticks and newlines through as plain text', () => {
    writeFileSync(join(repo, '.ai-memory.toml'), '');
    const title = `It's "$(touch pwned)" \`id\``;
    const body = `a'b\n$(touch pwned2)\n; rm -rf /`;
    run(buildAiMemoryRulesScript(input({ writes: [{ path: P1, title, body }], deletes: [] })));
    const log = readFileSync(calls, 'utf8');
    expect(log).toContain(`[--title=${title}]`);
    expect(log).toContain(`STDIN[${body}]`);
    expect(existsSync(join(repo, 'pwned'))).toBe(false);
    expect(existsSync(join(repo, 'pwned2'))).toBe(false);
  });

  it('quotes every value in the script text', () => {
    const s = buildAiMemoryRulesScript(input({ server_url: "http://x/'y" }));
    expect(s).toContain(shellQuote("http://x/'y"));
    expect(s).toContain(shellQuote(repo));
  });

  it('refuses a path that is not one of termhub’s rule pages', () => {
    expect(() => buildAiMemoryRulesScript(input({ deletes: ['notes/x.md'] }))).toThrow();
    expect(() => buildAiMemoryRulesScript(input({ writes: [{ path: '_rules/termhub-a-b/../x.md', title: 't', body: 'b' }] }))).toThrow();
    expect(() => buildAiMemoryRulesScript(input({ deletes: ["_rules/termhub-a-'b.md"] }))).toThrow();
  });
});

describe('briefing flag', () => {
  const marker = () => join(repo, '.ai-memory.toml');
  const ensure = () => run(buildAiMemoryRulesScript(input({ deletes: [] })));

  it('appends the section when the marker has none', () => {
    writeFileSync(marker(), '[project]\nname = "x"\n');
    ensure();
    expect(readFileSync(marker(), 'utf8')).toBe('[project]\nname = "x"\n\n[briefing]\ninject_on_session_start = true\n');
  });

  it('flips the key when it is false', () => {
    writeFileSync(marker(), '[briefing]\ninject_on_session_start = false\nmax_tokens = 900\n\n[capture]\nx = 1\n');
    ensure();
    expect(readFileSync(marker(), 'utf8')).toBe('[briefing]\ninject_on_session_start = true\nmax_tokens = 900\n\n[capture]\nx = 1\n');
  });

  it('adds the key to a section that lacks it', () => {
    writeFileSync(marker(), '[briefing]\nmax_tokens = 900\n[capture]\nx = 1\n');
    ensure();
    expect(readFileSync(marker(), 'utf8')).toBe('[briefing]\nmax_tokens = 900\ninject_on_session_start = true\n[capture]\nx = 1\n');
  });

  it('adds the key to a section at the end of the file', () => {
    writeFileSync(marker(), '[capture]\nx = 1\n[briefing]\n');
    ensure();
    expect(readFileSync(marker(), 'utf8')).toBe('[capture]\nx = 1\n[briefing]\ninject_on_session_start = true\n');
  });

  it('is idempotent', () => {
    writeFileSync(marker(), '[project]\n');
    ensure();
    const once = readFileSync(marker(), 'utf8');
    ensure();
    expect(readFileSync(marker(), 'utf8')).toBe(once);
  });

  it('leaves an unrelated key with a similar name alone', () => {
    writeFileSync(marker(), '[other]\ninject_on_session_start = false\n');
    ensure();
    expect(readFileSync(marker(), 'utf8')).toBe('[other]\ninject_on_session_start = false\n\n[briefing]\ninject_on_session_start = true\n');
  });
});

describe('parseAiMemorySync', () => {
  it('reads every tagged line', () => {
    expect(parseAiMemorySync(`ok briefing\nok write ${P1}\nfail write ${P2}\nok delete ${P2}\nnoise\n`)).toEqual({
      skip: null,
      briefing: 'ok',
      written: [P1],
      deleted: [P2],
      failed: 1,
    });
  });

  it('reads a skip', () => {
    expect(parseAiMemorySync('skip no_marker\n').skip).toBe('no_marker');
  });

  it('ignores a path that is not a rule page', () => {
    expect(parseAiMemorySync('ok write notes/x.md\n').written).toEqual([]);
  });

  it('path regex matches what the server builds', () => {
    expect(AI_MEMORY_RULE_PATH_RE.test(P1)).toBe(true);
  });
});
