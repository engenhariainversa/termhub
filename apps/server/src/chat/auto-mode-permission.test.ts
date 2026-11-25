import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { autoModeBashCommand, autoModeVerdict, hardLockReason, simpleCommands } from './auto-mode-permission.js';
import type { BlockShape } from './open-permissions.js';
import { permissionToolOnScreen, promptVisible } from './permission-dialog.js';

const fx = (name: string) => readFileSync(new URL(`./fixtures/permission-dialogs/${name}`, import.meta.url), 'utf8');
/** Captured on Claude Code 2.1.331 (TER-1210) from the real case's command shape, at 200 and 80 columns, and the same dialog in manual mode. */
const wide = fx('claude-auto-mode-unchecked.txt');
const narrow = fx('claude-auto-mode-unchecked-narrow.txt');
const manual = fx('claude-manual-unchecked.txt');
const card = { kind: 'permission' as const, payload: { tool_name: 'Bash' } };

/** An auto mode dialog drawn around `rows` (each one row of the command's box). */
const dialog = (rows: string[], opts: { title?: string; countdown?: boolean } = {}) =>
  [
    '─'.repeat(80),
    ` ${opts.title ?? 'Bash command'}`,
    ' Do something',
    '╌'.repeat(80),
    ...rows.map((r) => ` │ ${r}`),
    '╌'.repeat(80),
    ' This shell -c script runs rm and could not be checked',
    ...(opts.countdown === false ? [] : [' ⚠ Claude Code will automatically block this request in 1:56, to avoid holding up an unattended session']),
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n');

describe('autoModeBashCommand (TER-1210)', () => {
  it('reads the command of the real capture', () => {
    const readings = autoModeBashCommand(wide)!;
    expect(readings).not.toBeNull();
    expect(readings.some((r) => r.includes("sh -c 'cp /s/probe.mts src/zz-probe.mts") && r.endsWith("rm -f src/zz-probe.mts'"))).toBe(true);
  });
  it('reads it at 80 columns, where rows are cut inside words and at spaces', () => {
    const readings = autoModeBashCommand(narrow)!;
    expect(readings).toHaveLength(2);
    expect(readings[0]).toContain('623e9096-bda5-4a62-bc94-586cff759abf'); // cut inside a word: the glued reading
    expect(readings[1]).toContain('docker run --rm --name th-ter1210-probe'); // cut at a space: the spaced reading
  });
  it('ignores the same dialog in manual mode (no countdown)', () => expect(autoModeBashCommand(manual)).toBeNull());
  it('ignores a dialog with no countdown, another title or a subagent', () => {
    expect(autoModeBashCommand(dialog(['ls'], { countdown: false }))).toBeNull();
    expect(autoModeBashCommand(dialog(['ls'], { title: 'Edit file' }))).toBeNull();
    expect(autoModeBashCommand(dialog(['ls'], { title: 'Bash command · from the general-purpose agent' }))).toBeNull();
  });
  it('ignores a box that does not hold the whole command', () => {
    expect(autoModeBashCommand(dialog(['echo a', '… +12 lines']))).toBeNull();
    expect(autoModeBashCommand(dialog(['echo a', '(3 more lines)']))).toBeNull();
  });
  it('ignores a box row that does not start with the bar', () => expect(autoModeBashCommand(dialog(['ls']).replace(' │ ls', ' ls'))).toBeNull());
  it('the answer path recognises the captures as the Bash dialog', () => {
    for (const s of [wide, narrow]) {
      expect(promptVisible(s, card)).toBe(true);
      expect(permissionToolOnScreen(s, card)).toBe(true);
    }
  });
});

describe('simpleCommands', () => {
  it('splits lists, pipes and substitutions, and reads shell scripts', () => {
    expect(simpleCommands(`a && b | c; d $(e f) "g $(h)" \`i\` && sh -c 'rm -f x; j'`)).toEqual(
      expect.arrayContaining([['a'], ['b'], ['c'], ['e', 'f'], ['h'], ['i'], ['rm', '-f', 'x'], ['j']]),
    );
  });
  it('is unreadable on an open quote, a here-document or a script it cannot read', () => {
    expect(simpleCommands(`echo 'x`)).toBeNull();
    expect(simpleCommands(`cat <<EOF\nrm -rf /\nEOF`)).toBeNull();
    expect(simpleCommands(`sh -c "echo 'x"`)).toBeNull();
  });
});

describe('hardLockReason (the maintainer\'s "only the hard lock", 2026-11-24)', () => {
  it('approves the real case: a docker run whose sh -c script removes one file', () => {
    expect(autoModeVerdict(wide)).toBeNull();
    expect(autoModeVerdict(narrow)).toBeNull();
  });
  it.each([
    'git status && npm test 2>&1 | tail -20',
    'rm -f build/tmp.json',
    'git push -u origin TER-1210-auto-mode-permission',
    'docker run --rm -v "$PWD:/w" node:22 sh -c "npm ci && npm test"',
    'for f in *.tmp; do rm "$f"; done',
    'kill 12345',
  ])('approves %s', (c) => expect(hardLockReason(c)).toBeNull());
  it.each([
    ['rm -rf node_modules', 'recursive_rm'],
    ['cd /tmp && rm -fr x', 'recursive_rm'],
    ["sh -c 'cd x; rm -r y'", 'recursive_rm'],
    ['bash -lc "xargs rm -Rf < list"', 'recursive_rm'],
    ["ssh hulk 'rm -rf ~/x'", 'recursive_rm'],
    ['echo $(rm -rf x)', 'recursive_rm'],
    ['git push --force origin main', 'push'],
    ['git push origin +main', 'push'],
    ['git push origin :old', 'push'],
    ['git -C /w push -f', 'push'],
    ['git -c core.sshCommand=x fetch', 'git_config'],
    ['git reset --hard HEAD~1', 'git_destructive'],
    ['git clean -fdx', 'git_destructive'],
    ['gh pr merge 12 --squash', 'merge'],
    ['npm publish', 'publish'],
    ['npm run release:ota', 'publish'],
    ['npx eas build', 'publish'],
    ['docker rm -f termhub-app-blue', 'container'],
    ['docker compose down', 'container'],
    ['sudo systemctl restart x', 'privilege'],
    ['dd if=/dev/zero of=/dev/sda', 'disk'],
    ['cat .env | grep KEY', 'secret'],
    ['cat ~/.termhub/hook.env', 'secret'],
    ["echo 'x", 'unreadable'],
  ])('refuses %s (%s)', (c, reason) => expect(hardLockReason(c)).toBe(reason));
  it('refuses when either reading of a wrapped row hides a recursive rm', () => {
    // cut inside the word: only the glued reading shows `rm -rf`
    expect(autoModeVerdict(dialog(['echo a; r', 'm -rf build']))).toBe('recursive_rm');
    // cut at the space: only the spaced reading shows it
    expect(autoModeVerdict(dialog(['echo a; rm', '-rf build']))).toBe('recursive_rm');
  });
  it("honours the person's blocks", () => {
    const blocks = (b: Partial<BlockShape>): BlockShape[] => [{ kind: 'run_command', project_id: null, words: [], effect: 'ask', ...b }];
    expect(hardLockReason('ls', blocks({}))).toBe('blocked');
    expect(hardLockReason('ls', blocks({ kind: 'terminal' }), 'p1')).toBe('blocked');
    expect(hardLockReason('ls', blocks({ project_id: 'p2' }), 'p1')).toBeNull();
    expect(hardLockReason('cd x && git push origin b', blocks({ words: ['git', 'push'] }), 'p1')).toBe('blocked');
    expect(hardLockReason('git status', blocks({ words: ['git', 'push'], effect: 'never' }), 'p1')).toBeNull();
    expect(hardLockReason('/usr/bin/git push origin b', blocks({ words: ['git', 'push'] }), 'p1')).toBe('blocked');
  });
});
