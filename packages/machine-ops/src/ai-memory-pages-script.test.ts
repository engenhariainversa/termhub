/**
 * Runs the real script with `/bin/sh` against a temp checkout and a temp ai-memory data dir, the same
 * way the agent does. `ai-memory` itself is not installed in the test container, so the data dir is
 * found through `AI_MEMORY_DATA_DIR` (and, in one test, a fake `ai-memory status --json` on PATH).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_MEMORY_MAX_PAGES, AI_MEMORY_PAGE_MAX_BYTES, buildAiMemoryPagesScript, isAiMemoryPagePath, parseAiMemoryPages } from './ai-memory-script.js';
import { shellQuote } from './shell.js';

let root: string;
let checkout: string;
let data: string;

function write(full: string, content: string): void {
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const page = (rel: string, content: string) => write(join(data, 'wiki', rel), content);

function run(env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('/bin/sh', ['-c', buildAiMemoryPagesScript(shellQuote(checkout))], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), AI_MEMORY_DATA_DIR: data, ...env },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ai-memory-script-'));
  checkout = join(root, 'termhub');
  data = join(root, 'data');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(join(data, 'wiki'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildAiMemoryPagesScript', () => {
  it('reads only _rules, gotchas and decisions of the checkout’s project', () => {
    page('termhub/_rules/no-redis.md', '---\nkind: rule\n---\nNo Redis.\n');
    page('termhub/gotchas/drain.md', 'Drain first.\n');
    page('termhub/decisions/ws.md', 'WS fanout.\n');
    page('termhub/sessions/abc.md', 'tool output\n');
    page('termhub/notes/n.md', 'note\n');
    page('termhub/concepts/c.md', 'concept\n');
    page('other/_rules/x.md', 'another project\n');
    const { pages, err } = parseAiMemoryPages(run());
    expect(err).toBeNull();
    expect(pages.map((p) => p.path).sort()).toEqual(['termhub/_rules/no-redis.md', 'termhub/decisions/ws.md', 'termhub/gotchas/drain.md']);
    const rule = pages.find((p) => p.path === 'termhub/_rules/no-redis.md')!;
    expect(rule.text).toBe('---\nkind: rule\n---\nNo Redis.\n');
    expect(rule.sha256).toBe(createHash('sha256').update(rule.text).digest('hex'));
  });

  it('finds the project under a workspace directory', () => {
    page('default/termhub/gotchas/a.md', 'A\n');
    expect(parseAiMemoryPages(run()).pages.map((p) => p.path)).toEqual(['default/termhub/gotchas/a.md']);
  });

  it('takes the project name from the .ai-memory.toml marker', () => {
    write(join(checkout, '.ai-memory.toml'), 'workspace = "default"\nproject = "th"\n');
    page('termhub/gotchas/a.md', 'wrong project\n');
    page('th/gotchas/b.md', 'B\n');
    expect(parseAiMemoryPages(run()).pages.map((p) => p.path)).toEqual(['th/gotchas/b.md']);
  });

  it('skips the rules termhub itself publishes, symlinks and oversized pages', () => {
    page('termhub/_rules/termhub-merge.md', 'ours\n');
    page('termhub/_rules/big.md', 'x'.repeat(AI_MEMORY_PAGE_MAX_BYTES + 1));
    page('elsewhere/secret.md', 'outside\n');
    mkdirSync(join(data, 'wiki', 'termhub', 'gotchas'), { recursive: true });
    symlinkSync(join(data, 'wiki', 'elsewhere', 'secret.md'), join(data, 'wiki', 'termhub', 'gotchas', 'link.md'));
    symlinkSync(join(data, 'wiki', 'termhub', 'sessions-real'), join(data, 'wiki', 'termhub', 'decisions'));
    page('termhub/sessions-real/s.md', 'session\n');
    expect(parseAiMemoryPages(run()).pages).toEqual([]);
  });

  it('caps the number of pages', () => {
    for (let i = 0; i < AI_MEMORY_MAX_PAGES + 5; i++) page(`termhub/gotchas/p${String(i).padStart(3, '0')}.md`, `${i}\n`);
    expect(parseAiMemoryPages(run()).pages).toHaveLength(AI_MEMORY_MAX_PAGES);
  });

  it('reports a missing wiki and a missing checkout', () => {
    rmSync(join(data, 'wiki'), { recursive: true });
    expect(parseAiMemoryPages(run()).err).toBe('nowiki');
    rmSync(checkout, { recursive: true });
    expect(parseAiMemoryPages(run()).err).toBe('notfound');
  });

  it('asks ai-memory status for the data dir when the binary is on PATH', () => {
    const other = join(root, 'other-data');
    write(join(other, 'wiki', 'termhub', 'gotchas', 'z.md'), 'Z\n');
    const bin = join(root, 'bin');
    write(join(bin, 'ai-memory'), `#!/bin/sh\necho '{"version":"2.6.0","data_dir":"${other}","bind":"127.0.0.1:49374"}'\n`);
    chmodSync(join(bin, 'ai-memory'), 0o755);
    page('termhub/gotchas/a.md', 'not this one\n');
    const out = run({ PATH: `${bin}:${process.env.PATH}` });
    expect(parseAiMemoryPages(out).pages.map((p) => p.path)).toEqual(['termhub/gotchas/z.md']);
  });
});

describe('parseAiMemoryPages', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const sha = 'a'.repeat(64);

  it('drops anything outside the deliberate families, truncated or mismatched bodies', () => {
    const out = [
      `F\t${sha}\t2\ttermhub/sessions/s.md`, b64('hi'), 'E',
      `F\t${sha}\t2\ttermhub/../x/_rules/a.md`, b64('hi'), 'E',
      `F\t${sha}\t3\ttermhub/_rules/a.md`, b64('hi'), 'E',
      `F\t${sha}\t2\ttermhub/gotchas/ok.md`, b64('hi'), 'E',
      `F\t${sha}\t2\ttermhub/decisions/cut.md`, b64('hi'),
    ].join('\n');
    expect(parseAiMemoryPages(out)).toEqual({ pages: [{ path: 'termhub/gotchas/ok.md', sha256: sha, text: 'hi' }], err: null });
  });

  it('validates paths', () => {
    expect(isAiMemoryPagePath('p/_rules/a.md')).toBe(true);
    expect(isAiMemoryPagePath('w/p/decisions/a.md')).toBe(true);
    expect(isAiMemoryPagePath('w/x/p/decisions/a.md')).toBe(false);
    expect(isAiMemoryPagePath('../decisions/a.md')).toBe(false);
    expect(isAiMemoryPagePath('p/handoffs/a.md')).toBe(false);
  });
});
