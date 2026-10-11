import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPermissionOption, parsePermissionMenu, summariseOption } from './permission-options.js';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('parsePermissionMenu', () => {
  it('reads the four options of Claude Code’s Bash dialog with auto mode (real capture)', () => {
    const menu = parsePermissionMenu(fx('tab-questions/screen-permission.txt'));
    expect(menu).toEqual({
      cursor: 1,
      options: [
        { number: 1, label: 'Yes', summary: 'Yes', allow: true, highlight: false },
        { number: 2, label: 'Yes, and always allow access to /home/dev/project from this project', summary: 'Yes, and always allow access to /home/dev/project from this project', allow: true, highlight: true },
        { number: 3, label: 'Yes, and switch to auto mode · auto mode handles these prompts for you', summary: 'Yes, and switch to auto mode', allow: true, highlight: true },
        { number: 4, label: 'No', summary: 'No', allow: false, highlight: false },
      ],
    });
  });

  it('reads the three options of a dialog with "don’t ask again" (real capture)', () => {
    const menu = parsePermissionMenu(`${fx('permission-dialogs/claude-webfetch.txt').trimEnd()}\n Esc to cancel`);
    expect(menu?.options.map((o) => [o.number, o.summary, o.allow, o.highlight])).toEqual([
      [1, 'Yes', true, false],
      [2, "Yes, and don't ask again for example.com", true, true],
      [3, 'No, and tell Claude what to do differently', false, false],
    ]);
  });

  it('reads a subagent’s three-option dialog under its two-part footer (real capture)', () => {
    const menu = parsePermissionMenu(fx('permission-dialogs/claude-bash-subagent.txt'));
    expect(menu?.options.map((o) => o.label)).toEqual(['Yes', 'Yes, and always allow access to /tmp/th-f8 from this project', 'No']);
  });

  it('joins an option wrapped over several rows and finds the cursor on the last one', () => {
    const menu = parsePermissionMenu(fx('permission-dialogs/claude-cursor-last-option-narrow.txt'));
    expect(menu?.cursor).toBe(3);
    expect(menu?.options[1]!.label).toBe("Yes, and don't ask again for rm commands in /home/dev/project/some/very/long /path/that/keeps/wrapping/in/a narrow/pane");
    expect(menu?.options[2]).toMatchObject({ label: 'No, and tell Claude what to do differently (esc)', summary: 'No, and tell Claude what to do differently', allow: false });
  });

  it('reads Codex’s approval menu and drops its key hints from the summary', () => {
    const menu = parsePermissionMenu(fx('permission-dialogs/codex-command.txt'));
    expect(menu?.cursor).toBe(1);
    expect(menu?.options.map((o) => o.summary)).toEqual(['Yes, proceed', "Yes, and don't ask again for commands that start with `npm test`", 'No, and tell Codex what to do differently']);
    expect(menu?.options.map((o) => o.highlight)).toEqual([false, true, false]);
  });

  it('finds no menu on a screen without one, or with no cursor on it', () => {
    expect(parsePermissionMenu(fx('tab-suggestions/screen-suggestion.txt'))).toBeNull();
    expect(parsePermissionMenu(' Do you want to proceed?\n   1. Yes\n   2. No\n Esc to cancel')).toBeNull();
    expect(parsePermissionMenu(' Do you want to proceed?\n ❯ 1. Yes\n Esc to cancel')).toBeNull();
  });

  it('refuses a menu whose numbers skip', () => {
    expect(parsePermissionMenu(' ❯ 1. Yes\n   3. No\n Esc to cancel')).toBeNull();
  });
});

describe('summariseOption', () => {
  it('cuts a long label', () => {
    const s = summariseOption(`Yes, and don't ask again for ${'x'.repeat(200)}`);
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith('…')).toBe(true);
  });
});

describe('findPermissionOption', () => {
  const menu = parsePermissionMenu(fx('tab-questions/screen-permission.txt'));
  it('finds the option by number while its text is the same', () => {
    expect(findPermissionOption(menu, { number: 3, label: 'Yes, and switch to auto mode · auto mode handles these prompts for you' })?.number).toBe(3);
  });
  it('refuses when the option under that number changed, or is gone', () => {
    expect(findPermissionOption(menu, { number: 3, label: 'No' })).toBeNull();
    expect(findPermissionOption(menu, { number: 5, label: 'No' })).toBeNull();
    expect(findPermissionOption(null, { number: 1, label: 'Yes' })).toBeNull();
  });
});
