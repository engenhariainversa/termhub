/**
 * Runs the real scroll script with `/bin/sh` against a real tmux, on a PRIVATE server
 * (`tmux -L th-test-scroll-<pid> -f /dev/null`): the default socket may hold live termhub tabs,
 * so nothing here ever talks to it. Skipped when tmux is not installed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SCROLL_MAX_LINES, buildScrollScript } from './scroll-script.js';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const SOCKET = `th-test-scroll-${process.pid}`;
const TMUX = `tmux -L ${SOCKET} -f /dev/null`;
const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined } as NodeJS.ProcessEnv;

function tmux(...args: string[]): string {
  return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', env, timeout: 10_000 });
}

function scroll(session: string, lines: number): { code: number | null; stderr: string } {
  const r = spawnSync('/bin/sh', ['-c', buildScrollScript(session, lines, TMUX)], { encoding: 'utf8', env, timeout: 10_000 });
  return { code: r.status, stderr: r.stderr };
}

const fmt = (session: string, f: string) => tmux('display-message', '-p', '-t', `=${session}:`, f).trim();
const screen = (session: string) => tmux('capture-pane', '-p', '-t', `=${session}:`);

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Up/Down as a raw-mode `cat -v` shows them: what the pane's program would have read. */
const ARROWS = /\^\[\[A|\^\[OA|\^\[\[B|\^\[OB/;
/** Enough time for keys that were sent to show up on the pane. */
const settle = () => new Promise((r) => setTimeout(r, 300));

let dir: string;
let socketPath = '';
let n = 0;
let session: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'scroll-script-'));
  // A process whose name is `codex` (what `ps -o comm=` shows for the real Codex binary) and one that is
  // not: both echo every byte they read the way `cat -v` shows an escape, so any arrow that reaches them is
  // on the pane. Perl, not a symlink to `cat`: uutils coreutils (the default `cat` of recent Ubuntu, 26.04 on the CI runner) is one
  // multicall binary that picks the program by its own file name and exits on "codex" or "pager"
  // (docs/lessons/2026-11-10-fake-cat-symlink-under-multicall-coreutils.md).
  const perl = execFileSync('/bin/sh', ['-c', 'command -v perl'], { encoding: 'utf8' }).trim();
  symlinkSync(perl, join(dir, 'codex'));
  symlinkSync(perl, join(dir, 'pager'));
  writeFileSync(join(dir, 'echo.pl'), '$| = 1; while (sysread STDIN, my $c, 1) { $c =~ s/\\e/^[/; print $c }\n');
});

afterAll(() => {
  if (hasTmux) spawnSync('tmux', ['-L', SOCKET, 'kill-server'], { env });
  // a server that exited on its own (no session left) may leave its socket file behind
  if (socketPath.includes(SOCKET)) rmSync(socketPath, { force: true });
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  if (hasTmux) spawnSync('tmux', ['-L', SOCKET, 'kill-session', '-t', `=${session}`], { env });
});

/** A detached session running `cmd` under sh; names use every character a session name may have. */
async function start(cmd: string, ready: (s: string) => boolean): Promise<string> {
  session = `-th_scroll-${++n}`;
  tmux('new-session', '-d', '-s', session, '-x', '80', '-y', '24', `sh -c ${JSON.stringify(cmd)}`);
  socketPath ||= tmux('display-message', '-p', '#{socket_path}').trim();
  await until(() => ready(session), 'the pane to be ready');
  return session;
}

/** Normal screen: 200 lines of history, then a raw-mode `cat -v` that shows any key it reads. */
const normalScreen = () => start(`seq 1 200; stty raw -echo; echo READY; exec cat -v`, (s) => screen(s).includes('READY'));
/** Alternate screen with `bin` (an echo like `cat -v`) in the foreground. */
const altScreen = (bin: string) =>
  start(`printf '\\033[?1049h'; stty raw -echo; echo READY; exec ${join(dir, bin)} ${join(dir, 'echo.pl')}`, (s) => screen(s).includes('READY') && fmt(s, '#{alternate_on}') === '1');

describe('buildScrollScript', () => {
  it('refuses a session name that is not ours and a line count out of range', () => {
    for (const bad of ['a b', "a';id;'", 'a:b', '', 'x'.repeat(129)]) expect(() => buildScrollScript(bad, 1)).toThrow();
    for (const bad of [1.5, NaN, SCROLL_MAX_LINES + 1, -SCROLL_MAX_LINES - 1]) expect(() => buildScrollScript('s', bad)).toThrow();
    expect(() => buildScrollScript('s', SCROLL_MAX_LINES)).not.toThrow();
    expect(() => buildScrollScript('s', -SCROLL_MAX_LINES)).not.toThrow();
  });

  it('quotes the target and defaults to plain tmux', () => {
    const script = buildScrollScript('th-a', -3);
    expect(script).toContain(`'=th-a:'`);
    expect(script).toMatch(/^tm\(\) \{ tmux "\$@"; \}/);
  });
});

describe.skipIf(!hasTmux)('scroll script against a real tmux', () => {
  it('normal screen: wheel up enters copy-mode and scrolls; the program never reads an arrow', async () => {
    const s = await normalScreen();
    expect(scroll(s, -5).code).toBe(0);
    expect(fmt(s, '#{pane_in_mode} #{scroll_position}')).toBe('1 5');
    expect(scroll(s, -3).code).toBe(0);
    expect(fmt(s, '#{scroll_position}')).toBe('8');
    // back to the bottom: copy-mode -e leaves by itself
    expect(scroll(s, 8).code).toBe(0);
    expect(fmt(s, '#{pane_in_mode}')).toBe('0');
    await settle();
    expect(screen(s)).not.toMatch(ARROWS);
  });

  it('normal screen: wheel down at the bottom does nothing', async () => {
    const s = await normalScreen();
    expect(scroll(s, 4).code).toBe(0);
    expect(fmt(s, '#{pane_in_mode}')).toBe('0');
    await settle();
    expect(screen(s)).not.toMatch(ARROWS);
  });

  it('normal screen with no history: stays out of copy-mode', async () => {
    const s = await start(`stty raw -echo; echo READY; exec cat -v`, (x) => screen(x).includes('READY'));
    expect(fmt(s, '#{history_size}')).toBe('0');
    expect(scroll(s, -5).code).toBe(0);
    expect(fmt(s, '#{pane_in_mode}')).toBe('0');
  });

  it('0 leaves copy-mode, and is a no-op outside it', async () => {
    const s = await normalScreen();
    expect(scroll(s, 0).code).toBe(0);
    expect(fmt(s, '#{pane_in_mode}')).toBe('0');
    scroll(s, -10);
    expect(fmt(s, '#{pane_in_mode}')).toBe('1');
    expect(scroll(s, 0).code).toBe(0);
    expect(fmt(s, '#{pane_in_mode}')).toBe('0');
  });

  it('alternate screen: any other program gets Up/Down, as before', async () => {
    const s = await altScreen('pager');
    expect(scroll(s, -2).code).toBe(0);
    await until(() => /(\^\[\[A|\^\[OA){2}/.test(screen(s)), 'two Up keys');
    expect(scroll(s, 1).code).toBe(0);
    await until(() => /\^\[\[B|\^\[OB/.test(screen(s)), 'one Down key');
    expect(fmt(s, '#{pane_in_mode}')).toBe('0');
  });

  it('alternate screen with Codex in front: nothing, never its prompt history', async () => {
    const s = await altScreen('codex');
    expect(scroll(s, -3).code).toBe(0);
    expect(scroll(s, 3).code).toBe(0);
    await settle();
    expect(screen(s)).not.toMatch(ARROWS);
    expect(fmt(s, '#{pane_in_mode}')).toBe('0');
  });

  it('fails for a session that does not exist', () => {
    session = 'th-scroll-missing';
    expect(scroll(session, -1).code).not.toBe(0);
  });
});
