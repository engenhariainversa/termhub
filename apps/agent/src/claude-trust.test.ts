import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeConfigFiles, trustFolder, trustIn, trustWorktree } from './claude-trust.js';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'th-trust-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as { projects?: Record<string, Record<string, unknown>>; numStartups?: number };

describe('trusting a termhub worktree in Claude Code (TER-1025)', () => {
  it('finds the default account and every other config dir, only where Claude already wrote its file', async () => {
    writeFileSync(path.join(home, '.claude.json'), '{}');
    mkdirSync(path.join(home, '.claude'));
    mkdirSync(path.join(home, '.claude_work'));
    writeFileSync(path.join(home, '.claude_work', 'settings.json'), '{}');
    writeFileSync(path.join(home, '.claude_work', '.claude.json'), '{}');
    mkdirSync(path.join(home, '.claude_empty'));
    writeFileSync(path.join(home, '.claude_empty', 'settings.json'), '{}');
    expect(await claudeConfigFiles(home)).toEqual([path.join(home, '.claude.json'), path.join(home, '.claude_work', '.claude.json')]);
  });

  it('adds a trusted entry with Claude\'s defaults, keeps the rest of the file and its mode, and is idempotent', async () => {
    const file = path.join(home, '.claude.json');
    writeFileSync(file, JSON.stringify({ numStartups: 4, projects: { '/other': { hasTrustDialogAccepted: false, allowedTools: ['x'] } } }), { mode: 0o600 });
    expect(await trustIn(file, ['/w/p1/TER-1'])).toBe(true);
    const cfg = read(file);
    expect(cfg.numStartups).toBe(4);
    expect(cfg.projects!['/other']).toEqual({ hasTrustDialogAccepted: false, allowedTools: ['x'] });
    expect(cfg.projects!['/w/p1/TER-1']).toMatchObject({ hasTrustDialogAccepted: true, allowedTools: [], mcpServers: {} });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await trustIn(file, ['/w/p1/TER-1'])).toBe(false);
  });

  it('turns an existing untrusted entry trusted without touching its other fields', async () => {
    const file = path.join(home, '.claude.json');
    writeFileSync(file, JSON.stringify({ projects: { '/w/a': { hasTrustDialogAccepted: false, lastSessionId: 's' } } }));
    await trustIn(file, ['/w/a']);
    expect(read(file).projects!['/w/a']).toEqual({ hasTrustDialogAccepted: true, lastSessionId: 's' });
  });

  it('never rewrites a file that is not a JSON object', async () => {
    const file = path.join(home, '.claude.json');
    writeFileSync(file, '{ broken');
    expect(await trustIn(file, ['/w/a'])).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('trusts the worktree under its path and its real path, in every account', async () => {
    writeFileSync(path.join(home, '.claude.json'), '{}');
    mkdirSync(path.join(home, '.claude_work'));
    writeFileSync(path.join(home, '.claude_work', 'settings.json'), '{}');
    writeFileSync(path.join(home, '.claude_work', '.claude.json'), '{}');
    const real = path.join(home, 'real', 'TER-1');
    mkdirSync(real, { recursive: true });
    symlinkSync(path.join(home, 'real'), path.join(home, 'link'));
    const shown = path.join(home, 'link', 'TER-1');
    expect(await trustWorktree(shown, home)).toBe(2);
    for (const f of [path.join(home, '.claude.json'), path.join(home, '.claude_work', '.claude.json')]) {
      expect(Object.keys(read(f).projects!).sort()).toEqual([shown, real].sort());
    }
  });
});

describe("trusting a project's own folder before Claude opens it (TER-1148)", () => {
  it('marks the folder in every account here, plus an account dir the server names outside the home', async () => {
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'th-trust-acct-')));
    try {
      writeFileSync(path.join(home, '.claude.json'), '{}');
      mkdirSync(path.join(home, '.claude_work'));
      writeFileSync(path.join(home, '.claude_work', 'settings.json'), '{}');
      writeFileSync(path.join(home, '.claude_work', '.claude.json'), '{}');
      writeFileSync(path.join(outside, '.claude.json'), '{}');
      mkdirSync(path.join(home, 'projects', 'app'), { recursive: true });
      const dir = path.join(home, 'projects', 'app');
      expect(await trustFolder('~/projects/app', home, [outside])).toBe(3);
      for (const f of [path.join(home, '.claude.json'), path.join(home, '.claude_work', '.claude.json'), path.join(outside, '.claude.json')]) {
        expect(read(f).projects![dir]).toMatchObject({ hasTrustDialogAccepted: true });
      }
      // a second call changes nothing
      expect(await trustFolder(dir, home, [outside])).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a path that is not a folder here is refused, and no file is touched', async () => {
    writeFileSync(path.join(home, '.claude.json'), '{}');
    expect(await trustFolder(path.join(home, 'missing'), home)).toBeNull();
    expect(read(path.join(home, '.claude.json')).projects).toBeUndefined();
  });
});
