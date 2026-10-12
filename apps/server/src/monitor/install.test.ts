import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import { HOOK_SCRIPT_VERSION } from '@termhub/machine-ops';
import { installHooks, readHooksStatus, uninstallHooks } from './install.js';

/** The shell path for real: a `local` machine runs the same `sh` script, against a throwaway $HOME. */
const machine = { id: 'm1', type: 'local' } as Machine;
const url = 'https://app.termhub.dev/api/hooks';

let home: string;
let realHome: string | undefined;
const read = (rel: string) => readFile(path.join(home, rel), 'utf8');
type Settings = { model?: string; hooks?: Record<string, { hooks: { command: string }[] }[]> };

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'termhub-install-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(async () => {
  process.env.HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

describe('installHooks on a local/ssh machine', () => {
  it('hooks ~/.claude and the account dirs that exist, keeping what is there', async () => {
    await mkdir(path.join(home, '.claude_pedro'), { recursive: true });
    await writeFile(path.join(home, '.claude_pedro/settings.json'), JSON.stringify({ model: 'sonnet' }, null, 2) + '\n');
    const r = await installHooks(machine, 'thb_hk_abc', url, ['~/.claude_pedro', '~/.claude-missing']);
    expect(r).toMatchObject({ home, claude: 'installed', codex: 'skipped', claude_dirs: ['~/.claude', '~/.claude_pedro'] });

    const script = `${home}/.termhub/bin/termhub-hook claude`;
    const main = JSON.parse(await read('.claude/settings.json')) as Settings;
    const extra = JSON.parse(await read('.claude_pedro/settings.json')) as Settings;
    expect(main.hooks?.Stop[0].hooks[0].command).toBe(script);
    expect(extra.model).toBe('sonnet');
    expect(extra.hooks?.Stop[0].hooks[0].command).toBe(script);
    await expect(stat(path.join(home, '.claude-missing'))).rejects.toMatchObject({ code: 'ENOENT' });

    await uninstallHooks(machine, ['~/.claude_pedro']);
    expect(JSON.parse(await read('.claude_pedro/settings.json'))).toEqual({ model: 'sonnet' });
    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({});
  });

  it('refuses a broken settings.json in an account dir before writing anything', async () => {
    await mkdir(path.join(home, '.claude_pedro'), { recursive: true });
    await writeFile(path.join(home, '.claude_pedro/settings.json'), '{not json');
    await expect(installHooks(machine, 'thb_hk_abc', url, ['~/.claude_pedro'])).rejects.toThrow('~/.claude_pedro/settings.json não é JSON válido');
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips the Cursor CLI when ~/.cursor is absent', async () => {
    const r = await installHooks(machine, 'thb_hk_abc', url);
    expect(r.cursor).toBe('skipped');
    await expect(stat(path.join(home, '.cursor'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('hooks the Cursor CLI when ~/.cursor exists, keeping its own hooks, and gives them back on uninstall', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'say done' }] } }));
    const r = await installHooks(machine, 'thb_hk_abc', url);
    expect(r.cursor).toBe('installed');
    const file = JSON.parse(await read('.cursor/hooks.json')) as { hooks: Record<string, { command: string }[]> };
    expect(file.hooks.stop.map((e) => e.command)).toEqual(['say done', `${home}/.termhub/bin/termhub-hook cursor`]);
    expect(file.hooks.afterAgentResponse).toEqual([{ command: `${home}/.termhub/bin/termhub-hook cursor` }]);

    await uninstallHooks(machine);
    expect(JSON.parse(await read('.cursor/hooks.json'))).toEqual({ version: 1, hooks: { stop: [{ command: 'say done' }] } });
  });

  it('uninstall deletes a hooks.json that termhub created, and keeps ~/.cursor', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await installHooks(machine, 'thb_hk_abc', url);
    expect(JSON.parse(await read('.cursor/hooks.json'))).toMatchObject({ version: 1 });

    await uninstallHooks(machine);

    await expect(stat(path.join(home, '.cursor/hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(home, '.cursor'))).isDirectory()).toBe(true);
  });

  it('uninstall keeps a hooks.json that still holds a key of the person', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor/hooks.json'), JSON.stringify({ version: 1, telemetry: false }));
    await installHooks(machine, 'thb_hk_abc', url);

    await uninstallHooks(machine);

    expect(JSON.parse(await read('.cursor/hooks.json'))).toEqual({ version: 1, telemetry: false });
  });

  it('refuses a broken ~/.cursor/hooks.json before writing anything', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor/hooks.json'), '{not json');
    await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('~/.cursor/hooks.json não é JSON válido');
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await read('.cursor/hooks.json')).toBe('{not json');
  });

  it('finds the machine\'s own config dirs when nothing is registered, and gives them back on uninstall', async () => {
    await mkdir(path.join(home, '.claude-work'), { recursive: true });
    await writeFile(path.join(home, '.claude-work/settings.json'), '{}\n');
    await mkdir(path.join(home, '.claude-notes'), { recursive: true });
    await writeFile(path.join(home, '.zshrc'), "alias cw='CLAUDE_CONFIG_DIR=~/.claude-work claude'\n");

    const r = await installHooks(machine, 'thb_hk_abc', url);

    expect(r.claude_dirs).toEqual(['~/.claude', '~/.claude-work']);
    const found = JSON.parse(await read('.claude-work/settings.json')) as Settings;
    expect(found.hooks?.Stop[0].hooks[0].command).toBe(`${home}/.termhub/bin/termhub-hook claude`);
    await expect(stat(path.join(home, '.claude-notes/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    await uninstallHooks(machine);
    expect(JSON.parse(await read('.claude-work/settings.json'))).toEqual({});
  });

  it('refuses a ~/.cursor/hooks.json that is there but cannot be read, instead of replacing it', async () => {
    // a directory in the file's place: there, not readable as a file, and it behaves the same as root
    await mkdir(path.join(home, '.cursor/hooks.json'), { recursive: true });

    await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('Não foi possível ler ~/.cursor/hooks.json');

    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(home, '.cursor/hooks.json'))).isDirectory()).toBe(true);
  });

  it('refuses a Codex config that is there but cannot be read', async () => {
    await mkdir(path.join(home, '.codex/config.toml'), { recursive: true });

    await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('Não foi possível ler ~/.codex/config.toml');

    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('names every file it could not read', async () => {
    await mkdir(path.join(home, '.claude/settings.json'), { recursive: true });
    await mkdir(path.join(home, '.cursor/hooks.json'), { recursive: true });

    await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('Não foi possível ler ~/.claude/settings.json, ~/.cursor/hooks.json');
  });

  it.skipIf(process.getuid?.() === 0)('refuses a settings.json it has no permission to read, and leaves it as it was', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    const file = path.join(home, '.claude/settings.json');
    await writeFile(file, JSON.stringify({ model: 'opus' }));
    await chmod(file, 0o000);

    try {
      await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('Não foi possível ler ~/.claude/settings.json');
    } finally {
      await chmod(file, 0o644); // never leave a mode 000 file behind for the cleanup
    }
    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({ model: 'opus' });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still creates hooks.json in a ~/.cursor that has none', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });

    const r = await installHooks(machine, 'thb_hk_abc', url);

    expect(r.cursor).toBe('installed');
    expect(JSON.parse(await read('.cursor/hooks.json'))).toMatchObject({ version: 1 });
  });

  it('refuses a hooks.json that is a symlink to nothing, and leaves the link as it was', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await symlink(path.join(home, 'dotfiles/cursor-hooks.json'), path.join(home, '.cursor/hooks.json'));

    await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('Não foi possível ler ~/.cursor/hooks.json');

    expect((await lstat(path.join(home, '.cursor/hooks.json'))).isSymbolicLink()).toBe(true);
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('installHooks: Codex hooks.json on a local/ssh machine', () => {
  type CodexHooks = { hooks: Record<string, { hooks: { command: string }[] }[]> };

  it('writes ~/.codex/hooks.json next to the notify, keeping the person\'s own hooks, and gives them back on uninstall', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
    await writeFile(path.join(home, '.codex/hooks.json'), JSON.stringify(theirs));
    const r = await installHooks(machine, 'thb_hk_abc', url);
    expect(r.codex).toBe('installed');
    const once = await read('.codex/hooks.json');
    const file = JSON.parse(once) as CodexHooks;
    expect(file.hooks.Stop?.flatMap((g) => g.hooks.map((h) => h.command))).toContain('say done');
    expect(file.hooks).toHaveProperty('UserPromptSubmit');
    expect(once).toContain(`${home}/.termhub/bin/termhub-hook`);
    expect(await read('.codex/config.toml')).toContain('notify = [');
    await installHooks(machine, 'thb_hk_abc', url);
    expect(await read('.codex/hooks.json')).toBe(once);
    await uninstallHooks(machine);
    expect(JSON.parse(await read('.codex/hooks.json'))).toEqual(theirs);
  });

  it('writes none without ~/.codex, and uninstall deletes a hooks.json that termhub created', async () => {
    await installHooks(machine, 'thb_hk_abc', url);
    await expect(stat(path.join(home, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await installHooks(machine, 'thb_hk_abc', url);
    expect((JSON.parse(await read('.codex/hooks.json')) as CodexHooks).hooks).toHaveProperty('Stop');
    await uninstallHooks(machine);
    await expect(stat(path.join(home, '.codex/hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(home, '.codex'))).isDirectory()).toBe(true);
  });

  it('refuses a broken ~/.codex/hooks.json before writing anything', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/hooks.json'), '{not json');
    await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('~/.codex/hooks.json não é JSON válido');
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await read('.codex/hooks.json')).toBe('{not json');
  });

  it('refuses a ~/.codex/hooks.json that is there but cannot be read', async () => {
    await mkdir(path.join(home, '.codex/hooks.json'), { recursive: true });
    await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('Não foi possível ler ~/.codex/hooks.json');
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(home, '.codex/hooks.json'))).isDirectory()).toBe(true);
  });

  it('uninstall leaves an unparseable hooks.json alone', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await installHooks(machine, 'thb_hk_abc', url);
    await writeFile(path.join(home, '.codex/hooks.json'), `{not json ${home}/.termhub/bin/termhub-hook`);
    await uninstallHooks(machine);
    expect(await read('.codex/hooks.json')).toBe(`{not json ${home}/.termhub/bin/termhub-hook`);
  });
});

describe('readHooksStatus on a local/ssh machine', () => {
  it('reads a bare home as nothing installed', async () => {
    const s = await readHooksStatus(machine);
    expect(s.script).toEqual({ installed: false, version: null, expected_version: HOOK_SCRIPT_VERSION, outdated: false });
    expect(s.claude).toEqual({ present: false, state: 'missing', dirs: [] });
    expect(s.codex.present).toBe(false);
    expect(s.cursor.present).toBe(false);
  });

  it('reads what installHooks wrote as current, with the script at this release, and never answers the token', async () => {
    await mkdir(path.join(home, '.claude_pedro'), { recursive: true });
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await installHooks(machine, 'thb_hk_abc', url, ['~/.claude_pedro']);
    const s = await readHooksStatus(machine, ['~/.claude_pedro']);
    expect(s.script).toMatchObject({ installed: true, version: HOOK_SCRIPT_VERSION, outdated: false });
    expect(s.claude).toEqual({ present: true, state: 'current', dirs: [{ dir: '~/.claude', state: 'current' }, { dir: '~/.claude_pedro', state: 'current' }] });
    expect(s.codex).toEqual({ present: true, state: 'current', notify: true, trusted: 'none' });
    expect(s.cursor).toEqual({ present: true, state: 'current' });
    expect(JSON.stringify(s)).not.toContain('thb_hk_abc');
  });

  it('reads the Codex trust the person gave and a CLI that showed up after the install', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await installHooks(machine, 'thb_hk_abc', url);
    const hooksFile = path.join(home, '.codex/hooks.json');
    const keys = ['user_prompt_submit', 'pre_tool_use', 'permission_request', 'post_tool_use', 'stop', 'interrupt'];
    const config = await read('.codex/config.toml');
    await writeFile(path.join(home, '.codex/config.toml'), `${config}\n${keys.map((k) => `[hooks.state."${hooksFile}:${k}:0:0"]\ntrusted_hash = "sha256:abc"\n`).join('\n')}`);
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    const s = await readHooksStatus(machine);
    expect(s.codex.trusted).toBe('all');
    expect(s.cursor).toEqual({ present: true, state: 'missing' });
  });
});
