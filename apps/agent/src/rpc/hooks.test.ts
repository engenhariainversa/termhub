import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GUARD_SCRIPT, HOOK_SCRIPT } from '@termhub/machine-ops';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heal, hint, install, uninstall } from './hooks.js';

let home: string;
const params = { hooks_url: 'https://app.termhub.dev/api/hooks', token: 'thb_hk_abc-123' };
const read = (rel: string) => readFile(path.join(home, rel), 'utf8');
const mode = async (rel: string) => (await stat(path.join(home, rel))).mode & 0o777;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'termhub-hooks-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('hooks.install', () => {
  it('writes the script (755), the env (600) and the Claude entries on a bare home; skips Codex and Cursor when absent', async () => {
    await expect(install(params, home)).resolves.toEqual({ home, claude: 'installed', codex: 'skipped', cursor: 'skipped', claude_dirs: ['~/.claude'] });
    expect(await read('.termhub/bin/termhub-hook')).toBe(HOOK_SCRIPT);
    expect(await mode('.termhub/bin/termhub-hook')).toBe(0o755);
    expect(await read('.termhub/bin/termhub-guard')).toBe(GUARD_SCRIPT);
    expect(await mode('.termhub/bin/termhub-guard')).toBe(0o755);
    expect(await read('.termhub/hook.env')).toBe("TERMHUB_HOOK_URL='https://app.termhub.dev/api/hooks'\nTERMHUB_HOOK_TOKEN='thb_hk_abc-123'\n");
    expect(await mode('.termhub/hook.env')).toBe(0o600);
    const settings = JSON.parse(await read('.claude/settings.json')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(`${path.join(home, '.termhub/bin/termhub-hook')} claude`);
    await expect(stat(path.join(home, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the user\'s settings, writes Codex when ~/.codex exists, and is idempotent', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/config.toml'), 'model = "o3"\n');
    await expect(install(params, home)).resolves.toMatchObject({ claude: 'installed', codex: 'installed' });
    const once = await read('.claude/settings.json');
    await install(params, home);
    expect(await read('.claude/settings.json')).toBe(once);
    const settings = JSON.parse(once) as { model: string; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop.map((e) => e.hooks[0].command)).toEqual(['say done', `${path.join(home, '.termhub/bin/termhub-hook')} claude`]);
    expect(await read('.codex/config.toml')).toBe(`notify = [${JSON.stringify(path.join(home, '.termhub/bin/termhub-hook'))}, "codex"]\nmodel = "o3"\n`);
  });

  it('also hooks the Claude config dirs of the machine\'s accounts that exist, and says which', async () => {
    await mkdir(path.join(home, '.claude_pedro'), { recursive: true });
    await writeFile(path.join(home, '.claude_pedro/settings.json'), JSON.stringify({ model: 'sonnet' }));
    const r = await install({ ...params, claude_dirs: ['~/.claude_pedro', '~/.claude-missing'] }, home);
    expect(r.claude_dirs).toEqual(['~/.claude', '~/.claude_pedro']);
    const settings = JSON.parse(await read('.claude_pedro/settings.json')) as { model: string; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.model).toBe('sonnet');
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(`${path.join(home, '.termhub/bin/termhub-hook')} claude`);
    await expect(stat(path.join(home, '.claude-missing'))).rejects.toMatchObject({ code: 'ENOENT' });

    await uninstall({ claude_dirs: ['~/.claude_pedro'] }, home);
    expect(JSON.parse(await read('.claude_pedro/settings.json'))).toEqual({ model: 'sonnet' });
  });

  it('finds the config dirs of the machine itself when none are registered, and gives them back on uninstall', async () => {
    await mkdir(path.join(home, '.claude-work'), { recursive: true });
    await writeFile(path.join(home, '.claude-work/settings.json'), '{}');
    await writeFile(path.join(home, '.zshrc'), "alias cw='CLAUDE_CONFIG_DIR=~/.claude-work claude'\n");

    const r = await install(params, home);

    expect(r.claude_dirs).toEqual(['~/.claude', '~/.claude-work']);
    const settings = JSON.parse(await read('.claude-work/settings.json')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(`${path.join(home, '.termhub/bin/termhub-hook')} claude`);

    await uninstall({}, home);
    expect(JSON.parse(await read('.claude-work/settings.json'))).toEqual({});
  });

  it('checks every settings file before writing any', async () => {
    await mkdir(path.join(home, '.claude_pedro'), { recursive: true });
    await writeFile(path.join(home, '.claude_pedro/settings.json'), '[1]');
    await expect(install({ ...params, claude_dirs: ['~/.claude_pedro'] }, home)).rejects.toMatchObject({ code: 'failed', path: '.claude_pedro/settings.json' });
    await expect(stat(path.join(home, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to clobber a settings.json that is not a JSON object and writes nothing', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude/settings.json'), '{not json');
    await expect(install(params, home)).rejects.toMatchObject({ code: 'failed', path: '.claude/settings.json' });
    expect(await read('.claude/settings.json')).toBe('{not json');
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a Codex config it cannot read, naming the file, and writes nothing', async () => {
    // a directory in the file's place: EISDIR on read, and it behaves the same as root
    await mkdir(path.join(home, '.codex/config.toml'), { recursive: true });
    await expect(install(params, home)).rejects.toMatchObject({
      code: 'failed',
      path: '.codex/config.toml',
      message: expect.stringContaining('não foi possível ler ~/.codex/config.toml'),
    });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a Cursor hooks.json it cannot read, naming the file, and writes nothing', async () => {
    await mkdir(path.join(home, '.cursor/hooks.json'), { recursive: true });
    await expect(install(params, home)).rejects.toMatchObject({
      code: 'failed',
      path: '.cursor/hooks.json',
      message: expect.stringContaining('não foi possível ler ~/.cursor/hooks.json'),
    });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a Claude settings.json it cannot read, naming the file, and writes nothing', async () => {
    await mkdir(path.join(home, '.claude/settings.json'), { recursive: true });
    await expect(install(params, home)).rejects.toMatchObject({
      code: 'failed',
      path: '.claude/settings.json',
      message: expect.stringContaining('não foi possível ler ~/.claude/settings.json'),
    });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a hooks.json that is a symlink to nothing, and leaves the link as it was', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await symlink(path.join(home, 'dotfiles/cursor-hooks.json'), path.join(home, '.cursor/hooks.json'));

    await expect(install(params, home)).rejects.toMatchObject({
      code: 'failed',
      path: '.cursor/hooks.json',
      message: 'não foi possível ler ~/.cursor/hooks.json: link simbólico quebrado',
    });

    expect((await lstat(path.join(home, '.cursor/hooks.json'))).isSymbolicLink()).toBe(true);
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.getuid?.() === 0)('names a settings.json it has no permission to read, and leaves it as it was', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    const file = path.join(home, '.claude/settings.json');
    await writeFile(file, JSON.stringify({ model: 'opus' }));
    await chmod(file, 0o000);
    try {
      await expect(install(params, home)).rejects.toMatchObject({
        code: 'failed',
        path: '.claude/settings.json',
        message: 'sem permissão para ler ~/.claude/settings.json',
      });
    } finally {
      await chmod(file, 0o644);
    }
    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({ model: 'opus' });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('hooks.install — a settings.json we must not clobber', () => {
  it('refuses a `hooks` that is not an object, and heal leaves that dir alone instead of rewriting it', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    const theirs = JSON.stringify({ model: 'opus', hooks: [{ matcher: '*' }] });
    await writeFile(path.join(home, '.claude/settings.json'), theirs);

    await expect(install(params, home)).rejects.toMatchObject({ code: 'failed', path: '.claude/settings.json' });
    expect(await read('.claude/settings.json')).toBe(theirs);

    // installed from another dir, heal must not "repair" the odd file either
    await mkdir(path.join(home, '.claude-ok'), { recursive: true });
    await writeFile(path.join(home, '.claude-ok/settings.json'), '{}');
    await install({ ...params, claude_dirs: ['~/.claude-ok'] }, home).catch(() => undefined);
    await heal(home);
    expect(await read('.claude/settings.json')).toBe(theirs);
  });
});

describe('hooks.install — Cursor CLI', () => {
  it('writes ~/.cursor/hooks.json when ~/.cursor exists, keeping the user\'s own hooks, and is idempotent', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'say done' }] } }));
    await expect(install(params, home)).resolves.toMatchObject({ cursor: 'installed' });
    const once = await read('.cursor/hooks.json');
    await install(params, home);
    expect(await read('.cursor/hooks.json')).toBe(once);
    const file = JSON.parse(once) as { hooks: Record<string, { command: string }[]> };
    expect(file.hooks.stop.map((e) => e.command)).toEqual(['say done', `${path.join(home, '.termhub/bin/termhub-hook')} cursor`]);
    expect(file.hooks.beforeSubmitPrompt).toEqual([{ command: `${path.join(home, '.termhub/bin/termhub-hook')} cursor` }]);
  });

  it('creates hooks.json in an existing ~/.cursor that has none', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await expect(install(params, home)).resolves.toMatchObject({ cursor: 'installed' });
    expect(JSON.parse(await read('.cursor/hooks.json'))).toMatchObject({ version: 1 });
  });

  it('refuses to clobber a hooks.json that is not a JSON object and writes nothing', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor/hooks.json'), '{not json');
    await expect(install(params, home)).rejects.toMatchObject({ code: 'failed', path: '.cursor/hooks.json' });
    expect(await read('.cursor/hooks.json')).toBe('{not json');
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a hooks.json whose `hooks` is not an object, naming the problem, and writes nothing', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    const theirs = JSON.stringify({ version: 1, hooks: [{ command: 'say done' }] });
    await writeFile(path.join(home, '.cursor/hooks.json'), theirs);
    await expect(install(params, home)).rejects.toMatchObject({ code: 'failed', path: '.cursor/hooks.json', message: expect.stringContaining('"hooks" não é um objeto') });
    expect(await read('.cursor/hooks.json')).toBe(theirs);
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uninstall removes only our entries from hooks.json', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'say done' }] } }));
    await install(params, home);
    await uninstall({}, home);
    expect(JSON.parse(await read('.cursor/hooks.json'))).toEqual({ version: 1, hooks: { stop: [{ command: 'say done' }] } });
  });

  it('uninstall deletes a hooks.json that termhub created, and keeps ~/.cursor', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await install(params, home);
    await uninstall({}, home);
    await expect(stat(path.join(home, '.cursor/hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(home, '.cursor'))).isDirectory()).toBe(true);
  });

  it('uninstall keeps a hooks.json that still holds a key of the person', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor/hooks.json'), JSON.stringify({ version: 1, telemetry: false }));
    await install(params, home);
    await uninstall({}, home);
    expect(JSON.parse(await read('.cursor/hooks.json'))).toEqual({ version: 1, telemetry: false });
  });
});

describe('hooks.uninstall', () => {
  it('removes the files and only our entries; a missing install is not an error', async () => {
    await expect(uninstall({}, home)).resolves.toEqual({ removed: true });
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/config.toml'), 'model = "o3"\n');
    await install(params, home);
    await expect(uninstall({}, home)).resolves.toEqual({ removed: true });
    await expect(stat(path.join(home, '.termhub/bin/termhub-hook'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(home, '.termhub/hook.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    expect(await read('.codex/config.toml')).toBe('model = "o3"\n');
  });

  it('leaves an unparseable settings.json alone', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude/settings.json'), '{not json');
    await expect(uninstall({}, home)).resolves.toEqual({ removed: true });
    expect(await read('.claude/settings.json')).toBe('{not json');
  });

  it('names a file it cannot read and removes nothing', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await install(params, home);
    await rm(path.join(home, '.codex/config.toml'), { force: true });
    await mkdir(path.join(home, '.codex/config.toml'), { recursive: true });

    await expect(uninstall({}, home)).rejects.toMatchObject({
      code: 'failed',
      path: '.codex/config.toml',
      message: expect.stringContaining('não foi possível ler ~/.codex/config.toml'),
    });
    expect(await read('.termhub/bin/termhub-hook')).toBe(HOOK_SCRIPT);
  });

  it('skips the Cursor CLI when ~/.cursor is not a directory', async () => {
    await install(params, home);
    await writeFile(path.join(home, '.cursor'), 'not a directory');

    await expect(uninstall({}, home)).resolves.toEqual({ removed: true });

    await expect(stat(path.join(home, '.termhub/bin/termhub-hook'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await read('.cursor')).toBe('not a directory');
  });
});

describe('hooks.hint (TER-614)', () => {
  it('writes the opt-in file (600), removes it, and uninstall removes it too', async () => {
    await expect(hint({ enabled: true }, home)).resolves.toEqual({ enabled: true });
    expect(await read('.termhub/permission-hint')).toBe('');
    expect(await mode('.termhub/permission-hint')).toBe(0o600);
    await expect(hint({ enabled: false }, home)).resolves.toEqual({ enabled: false });
    await expect(stat(path.join(home, '.termhub/permission-hint'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(hint({ enabled: false }, home)).resolves.toEqual({ enabled: false });
    await install(params, home);
    await hint({ enabled: true }, home);
    await uninstall({}, home);
    await expect(stat(path.join(home, '.termhub/permission-hint'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('heal', () => {
  it('does nothing on a machine where termhub never installed its hooks', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude/settings.json'), '{}');

    await expect(heal(home)).resolves.toEqual([]);

    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({});
  });

  it('hooks a config dir that showed up after the install and leaves the settled ones alone', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.claude-new'), { recursive: true });
    await writeFile(path.join(home, '.claude-new/settings.json'), JSON.stringify({ model: 'opus' }));
    const before = await read('.claude/settings.json');

    await expect(heal(home)).resolves.toEqual(['~/.claude-new']);

    const settings = JSON.parse(await read('.claude-new/settings.json')) as { model: string; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Notification[0].hooks[0].command).toBe(`${path.join(home, '.termhub/bin/termhub-hook')} claude`);
    expect(await read('.claude/settings.json')).toBe(before);
  });

  it('rewrites the guard script when an older agent left a different one (TER-993)', async () => {
    await install(params, home);
    await writeFile(path.join(home, '.termhub/bin/termhub-guard'), '#!/bin/sh\n# old\n');
    await heal(home);
    expect(await read('.termhub/bin/termhub-guard')).toBe(GUARD_SCRIPT);
    expect(await mode('.termhub/bin/termhub-guard')).toBe(0o755);
  });

  it('leaves a settings file it cannot parse where it is', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.claude-broken'), { recursive: true });
    await writeFile(path.join(home, '.claude-broken/settings.json'), '{not json');

    await expect(heal(home)).resolves.toEqual([]);

    expect(await read('.claude-broken/settings.json')).toBe('{not json');
  });

  it('does not touch Cursor or Codex on a machine where termhub never installed its hooks', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/config.toml'), 'model = "o3"\n');

    await expect(heal(home)).resolves.toEqual([]);

    await expect(stat(path.join(home, '.cursor/hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await read('.codex/config.toml')).toBe('model = "o3"\n');
  });

  it('hooks the Cursor CLI installed after the hooks were', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.cursor'), { recursive: true });

    await expect(heal(home)).resolves.toEqual(['~/.cursor']);

    const file = JSON.parse(await read('.cursor/hooks.json')) as { hooks: Record<string, { command: string }[]> };
    expect(file.hooks.stop).toEqual([{ command: `${path.join(home, '.termhub/bin/termhub-hook')} cursor` }]);
  });

  it('puts our Cursor entries back when Cursor rewrote hooks.json without them, keeping its own', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await install(params, home);
    await writeFile(path.join(home, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'say done' }] } }));

    await expect(heal(home)).resolves.toEqual(['~/.cursor']);

    const file = JSON.parse(await read('.cursor/hooks.json')) as { hooks: Record<string, { command: string }[]> };
    expect(file.hooks.stop.map((e) => e.command)).toEqual(['say done', `${path.join(home, '.termhub/bin/termhub-hook')} cursor`]);
  });

  it('leaves a Cursor hooks.json that is settled, or that it cannot parse, where it is', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await install(params, home);
    const settled = await read('.cursor/hooks.json');
    await expect(heal(home)).resolves.toEqual([]);
    expect(await read('.cursor/hooks.json')).toBe(settled);

    await writeFile(path.join(home, '.cursor/hooks.json'), '{not json');
    await expect(heal(home)).resolves.toEqual([]);
    expect(await read('.cursor/hooks.json')).toBe('{not json');
  });

  it('adds our Codex notify when Codex shows up later or lost it, but never replaces a notify the person set', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/config.toml'), 'model = "o3"\n');

    await expect(heal(home)).resolves.toEqual(['~/.codex']);
    expect(await read('.codex/config.toml')).toBe(`notify = ["${path.join(home, '.termhub/bin/termhub-hook')}", "codex"]\nmodel = "o3"\n`);

    await writeFile(path.join(home, '.codex/config.toml'), 'notify = ["my-notifier"]\nmodel = "o3"\n');
    await expect(heal(home)).resolves.toEqual([]);
    expect(await read('.codex/config.toml')).toBe('notify = ["my-notifier"]\nmodel = "o3"\n');
  });

  it('repairs Cursor, Codex and a later Claude dir when an earlier settings.json cannot be written', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/config.toml'), 'model = "o3"\n');
    // writeAtomic fails with EISDIR on the temp path (works as root; chmod would not). Merge
    // succeeds; a second Claude dir after it must still repair — that is what pins writeAtomic
    // inside the per-dir try (per-step catch alone would still return cursor+codex).
    await writeFile(path.join(home, '.claude/settings.json'), '{}\n');
    await mkdir(path.join(home, '.claude/settings.json.termhub-new'), { recursive: true });
    await mkdir(path.join(home, '.claude-z'), { recursive: true });
    await writeFile(path.join(home, '.claude-z/settings.json'), '{}\n');

    await expect(heal(home)).resolves.toEqual(['~/.claude-z', '~/.cursor', '~/.codex']);

    expect(await read('.claude/settings.json')).toBe('{}\n');
    expect(JSON.parse(await read('.claude-z/settings.json')).hooks).toBeTruthy();
    expect(JSON.parse(await read('.cursor/hooks.json'))).toMatchObject({ version: 1 });
    expect(await read('.codex/config.toml')).toContain('notify = [');
  });

  it('logs a Claude write failure once, then stays quiet on the next heal', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await install(params, home);
    await writeFile(path.join(home, '.claude/settings.json'), '{}\n');
    await mkdir(path.join(home, '.claude/settings.json.termhub-new'), { recursive: true });

    await heal(home);
    expect(err.mock.calls.some((c) => String(c[0]).includes('monitor hooks heal skipped'))).toBe(true);
    const n = err.mock.calls.filter((c) => String(c[0]).includes('monitor hooks heal skipped')).length;
    await heal(home);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('monitor hooks heal skipped'))).toHaveLength(n);
    err.mockRestore();
  });

  it('repairs sibling Claude dirs when one settings.json cannot be read', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.claude-a'), { recursive: true });
    await writeFile(path.join(home, '.claude-a/settings.json'), '{}\n');
    // EISDIR on read: sorts first, so it used to abort the whole Claude step before siblings ran
    await mkdir(path.join(home, '.claude-000/settings.json'), { recursive: true });

    await expect(heal(home)).resolves.toEqual(['~/.claude-a']);
    expect(JSON.parse(await read('.claude-a/settings.json')).hooks).toBeTruthy();
  });

  it('rewrites a script left behind by an older agent, keeping it atomic and executable', async () => {
    await install(params, home);
    await writeFile(path.join(home, '.termhub/bin/termhub-hook'), '#!/bin/sh\n# an older termhub-hook\nexit 0\n', { mode: 0o755 });

    await expect(heal(home)).resolves.toEqual([]);

    expect(await read('.termhub/bin/termhub-hook')).toBe(HOOK_SCRIPT);
    expect(await mode('.termhub/bin/termhub-hook')).toBe(0o755);
    expect(await read('.termhub/bin/termhub-guard')).toBe(GUARD_SCRIPT);
    expect(await mode('.termhub/bin/termhub-guard')).toBe(0o755);
  });

  it('leaves a script that already matches where it is', async () => {
    await install(params, home);
    const script = path.join(home, '.termhub/bin/termhub-hook');
    const stamp = new Date('2020-01-01T00:00:00Z');
    await utimes(script, stamp, stamp);

    await expect(heal(home)).resolves.toEqual([]);

    expect((await stat(script)).mtimeMs).toBe(stamp.getTime());
    expect(await read('.termhub/bin/termhub-hook')).toBe(HOOK_SCRIPT);
  });

  it('leaves a settings.json that is a symlink to nothing alone, and still repairs the dir after it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await install(params, home);
    await mkdir(path.join(home, '.claude-a'), { recursive: true });
    await writeFile(path.join(home, '.claude-a/projects'), '');
    await symlink(path.join(home, 'dotfiles/claude-settings.json'), path.join(home, '.claude-a/settings.json'));
    await mkdir(path.join(home, '.claude-b'), { recursive: true });
    await writeFile(path.join(home, '.claude-b/settings.json'), '{}\n');

    await expect(heal(home)).resolves.toEqual(['~/.claude-b']);

    expect((await lstat(path.join(home, '.claude-a/settings.json'))).isSymbolicLink()).toBe(true);
    expect(err.mock.calls.some((c) => String(c[0]).includes('monitor hooks heal skipped') && String(c[0]).includes('EDANGLING'))).toBe(true);
    err.mockRestore();
  });
});

describe('Codex hooks.json', () => {
  const script = () => path.join(home, '.termhub/bin/termhub-hook');
  type CodexHooks = { hooks: Record<string, { hooks: { command: string }[] }[]> };

  it('install writes ~/.codex/hooks.json (644) next to the notify, keeping the person\'s own hooks, and is idempotent', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    await expect(install(params, home)).resolves.toMatchObject({ codex: 'installed' });
    const once = await read('.codex/hooks.json');
    expect(await mode('.codex/hooks.json')).toBe(0o644);
    const file = JSON.parse(once) as CodexHooks;
    expect(file.hooks.Stop?.flatMap((g) => g.hooks.map((h) => h.command))).toContain('say done');
    expect(once).toContain(script());
    expect(await read('.codex/config.toml')).toContain('notify = [');
    await install(params, home);
    expect(await read('.codex/hooks.json')).toBe(once);
  });

  it('install creates hooks.json in a ~/.codex that has none, and writes none without ~/.codex', async () => {
    await install(params, home);
    await expect(stat(path.join(home, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await install(params, home);
    expect((JSON.parse(await read('.codex/hooks.json')) as CodexHooks).hooks).toHaveProperty('UserPromptSubmit');
  });

  it('install refuses an unparseable hooks.json before writing anything', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/hooks.json'), '{not json');
    await expect(install(params, home)).rejects.toMatchObject({ code: 'failed', path: '.codex/hooks.json', message: '~/.codex/hooks.json não é JSON válido' });
    expect(await read('.codex/hooks.json')).toBe('{not json');
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('install refuses a hooks.json it cannot read, naming the file', async () => {
    await mkdir(path.join(home, '.codex/hooks.json'), { recursive: true });
    await expect(install(params, home)).rejects.toMatchObject({ code: 'failed', path: '.codex/hooks.json', message: expect.stringContaining('não foi possível ler ~/.codex/hooks.json') });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uninstall deletes a hooks.json that termhub created, keeping ~/.codex', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await install(params, home);
    await uninstall({}, home);
    await expect(stat(path.join(home, '.codex/hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(home, '.codex'))).isDirectory()).toBe(true);
  });

  it('uninstall keeps the person\'s own hooks and leaves an unparseable file alone', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
    await writeFile(path.join(home, '.codex/hooks.json'), JSON.stringify(theirs));
    await install(params, home);
    await uninstall({}, home);
    expect(JSON.parse(await read('.codex/hooks.json'))).toEqual(theirs);
    await writeFile(path.join(home, '.codex/hooks.json'), `{not json ${HOOK_SCRIPT}`);
    await expect(uninstall({}, home)).resolves.toEqual({ removed: true });
    expect(await read('.codex/hooks.json')).toBe(`{not json ${HOOK_SCRIPT}`);
  });

  it('heal adds hooks.json when it is missing (once for ~/.codex), and settles', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await expect(heal(home)).resolves.toEqual(['~/.codex']);
    expect(await read('.codex/hooks.json')).toContain(script());
    expect(await read('.codex/config.toml')).toContain('notify = [');
    await expect(heal(home)).resolves.toEqual([]);
  });

  it('heal repairs hooks.json alone when notify is already there, and keeps a foreign notify', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/config.toml'), 'notify = ["say"]\n');
    await expect(heal(home)).resolves.toEqual(['~/.codex']);
    expect(await read('.codex/config.toml')).toBe('notify = ["say"]\n');
    expect(await read('.codex/hooks.json')).toContain(script());
  });

  it('heal repairs notify even when hooks.json cannot be parsed, and leaves that file alone', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/hooks.json'), '{not json');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(heal(home)).resolves.toEqual(['~/.codex']);
    log.mockRestore();
    expect(await read('.codex/hooks.json')).toBe('{not json');
    expect(await read('.codex/config.toml')).toContain('notify = [');
  });

  it('heal repairs hooks.json even when config.toml cannot be read', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.codex/config.toml'), { recursive: true });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(heal(home)).resolves.toEqual(['~/.codex']);
    log.mockRestore();
    expect(await read('.codex/hooks.json')).toContain(script());
  });
});
