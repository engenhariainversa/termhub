/** Runs the real prep line with `/bin/sh` in a git worktree, with a fake `ai-memory` on PATH. */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiMemoryRunPrepLine, buildAiMemoryRunPrepScript } from './ai-memory-run-script.js';

const run = promisify(execFile);
let dir: string;
let bin: string;
let checkout: string;
let worktree: string;
const URL = 'http://127.0.0.1:49374';

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' } })).stdout;
}

/** A fake installer that records how it was called and writes the project settings like ai-memory does. */
function fakeAiMemory(): void {
  const path = join(bin, 'ai-memory');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `printf '%s|%s|%s\\n' "$*" "$CLAUDE_CONFIG_DIR" "$AI_MEMORY_SERVER_URL" >> ${JSON.stringify(join(dir, 'calls'))}`,
      'mkdir -p .claude && echo \'{"hooks":{}}\' > .claude/settings.local.json',
      // what an installer that ignored --scope would do: it must land in the throwaway dir
      'mkdir -p "$CLAUDE_CONFIG_DIR" && echo x > "$CLAUDE_CONFIG_DIR/settings.json"',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
}

async function prep(path = `${bin}:/usr/bin:/bin`, from = checkout): Promise<void> {
  const line = aiMemoryRunPrepLine(from, URL);
  await run('/bin/sh', ['-c', `${line}true`], { cwd: worktree, encoding: 'utf8', timeout: 20_000, env: { PATH: path, HOME: dir, TMPDIR: dir, GIT_CONFIG_NOSYSTEM: '1' } });
}

const calls = () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []);
const status = async () => (await git(worktree, 'status', '--porcelain')).trim();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aim-run-'));
  bin = join(dir, 'bin');
  mkdirSync(bin);
  checkout = join(dir, 'myrepo');
  mkdirSync(checkout);
  await git(checkout, 'init', '-q', '-b', 'main');
  writeFileSync(join(checkout, 'README.md'), 'x\n');
  await git(checkout, 'add', 'README.md');
  await git(checkout, 'commit', '-q', '-m', 'init');
  worktree = join(dir, 'TER-1');
  await git(checkout, 'worktree', 'add', '-q', '-b', 'TER-1', worktree);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('buildAiMemoryRunPrepScript', () => {
  it('is one line, so it can be typed', () => {
    expect(buildAiMemoryRunPrepScript()).not.toContain('\n');
  });

  it('quotes the checkout and the URL on the typed line', () => {
    expect(aiMemoryRunPrepLine("/tmp/a b'; rm -rf /", URL)).toContain(`'/tmp/a b'\\''; rm -rf /' '${URL}' >/dev/null 2>&1 ; `);
  });
});

describe('the prep in a worktree', () => {
  it('does nothing without the ai-memory binary', async () => {
    writeFileSync(join(checkout, '.ai-memory.toml'), 'workspace = "w"\n');
    await prep('/usr/bin:/bin');
    expect(existsSync(join(worktree, '.ai-memory.toml'))).toBe(false);
    expect(await status()).toBe('');
  });

  it('does nothing when no checkout has a marker: termhub never creates one', async () => {
    fakeAiMemory();
    await prep();
    expect(calls()).toEqual([]);
    expect(existsSync(join(worktree, '.ai-memory.toml'))).toBe(false);
  });

  it("copies the checkout's marker with its project name and installs project hooks", async () => {
    fakeAiMemory();
    writeFileSync(join(checkout, '.ai-memory.toml'), 'workspace = "w"\n\n[briefing]\ninject_on_session_start = true\n');
    await prep();
    expect(readFileSync(join(worktree, '.ai-memory.toml'), 'utf8')).toBe('project = "myrepo"\nworkspace = "w"\n\n[briefing]\ninject_on_session_start = true\n');
    const [call] = calls();
    const [args, configDir, url] = call.split('|');
    expect(args).toBe('install-hooks --agent claude-code --scope project --no-capture-prompts --apply');
    expect(url).toBe(URL);
    // the throwaway config dir is gone, so nothing outside the worktree was written
    expect(configDir.startsWith(dir)).toBe(true);
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(join(worktree, '.claude/settings.local.json'))).toBe(true);
    // neither file shows up for the run to commit
    expect(await status()).toBe('');
  });

  it('keeps a marker that already names its project', async () => {
    fakeAiMemory();
    const marker = 'workspace = "w"\nproject = "other"\n';
    writeFileSync(join(checkout, '.ai-memory.toml'), marker);
    await prep();
    expect(readFileSync(join(worktree, '.ai-memory.toml'), 'utf8')).toBe(marker);
  });

  it('expands ~ in the checkout path on the machine', async () => {
    fakeAiMemory();
    writeFileSync(join(checkout, '.ai-memory.toml'), 'workspace = "w"\n');
    await prep(undefined, '~/myrepo');
    expect(readFileSync(join(worktree, '.ai-memory.toml'), 'utf8')).toBe('project = "myrepo"\nworkspace = "w"\n');
  });

  it('leaves a tracked marker alone and still installs the hooks', async () => {
    fakeAiMemory();
    writeFileSync(join(worktree, '.ai-memory.toml'), 'workspace = "w"\n');
    await git(worktree, 'add', '.ai-memory.toml');
    await git(worktree, 'commit', '-q', '-m', 'marker');
    await prep();
    expect(readFileSync(join(worktree, '.ai-memory.toml'), 'utf8')).toBe('workspace = "w"\n');
    expect(calls()).toHaveLength(1);
    expect(await status()).toBe('');
  });

  it('never touches a tracked .claude/settings.local.json', async () => {
    fakeAiMemory();
    writeFileSync(join(checkout, '.ai-memory.toml'), 'workspace = "w"\n');
    mkdirSync(join(worktree, '.claude'));
    writeFileSync(join(worktree, '.claude/settings.local.json'), '{}\n');
    await git(worktree, 'add', '.claude/settings.local.json');
    await git(worktree, 'commit', '-q', '-m', 'settings');
    await prep();
    expect(calls()).toEqual([]);
    expect(readFileSync(join(worktree, '.claude/settings.local.json'), 'utf8')).toBe('{}\n');
  });
});
