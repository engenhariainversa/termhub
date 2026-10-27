import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { trustDialogOf } from './trust-dialogs.js';

const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');
const CLAUDE = fixture('claude-screens/trust-2.1.289.txt');
const CODEX = fixture('trust-screens/codex-0.159.3.txt');
const CURSOR = fixture('trust-screens/cursor.txt');
const GEMINI = fixture('trust-screens/gemini.txt');

// Codex releases before the "Folder access" screen (0.4x–0.5x)
const CODEX_CONTENTS = [
  '> You are in /home/dev/projects/api',
  '',
  '  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.',
  '',
  '› 1. Yes, continue',
  '  2. No, quit',
  '',
  '  Press enter to continue',
].join('\n');
// older Codex: trusting the folder also turned its approvals off
const CODEX_APPROVAL = [
  '> You are running Codex in /home/dev/projects/api',
  '',
  '  Since this folder is version controlled, you may wish to allow Codex to work in this folder without asking for approval.',
  '',
  '› 1. Yes, allow Codex to work in this folder without asking for approval',
  '  2. No, ask me to approve edits and commands',
  '',
  '  Press enter to continue',
].join('\n');

describe('trustDialogOf — every CLI\'s folder trust dialog (TER-1122)', () => {
  it('reads each CLI\'s dialog with its trust option selected as one Enter answers', () => {
    expect(trustDialogOf(CLAUDE)).toEqual({ cli: 'claude', acceptable: true });
    expect(trustDialogOf(CODEX)).toEqual({ cli: 'codex', acceptable: true });
    expect(trustDialogOf(CODEX_CONTENTS)).toEqual({ cli: 'codex', acceptable: true });
    expect(trustDialogOf(CURSOR)).toEqual({ cli: 'cursor', acceptable: true });
    expect(trustDialogOf(GEMINI)).toEqual({ cli: 'gemini', acceptable: true });
  });

  it('a dialog with another option selected is seen but left for the person', () => {
    const moved = [
      CLAUDE.replace('❯ 1. Yes, I trust this folder', '  1. Yes, I trust this folder').replace('   2. No, exit', ' ❯ 2. No, exit'),
      CODEX.replace('› 1. Trust and continue', '  1. Trust and continue').replace('  2. Quit', '› 2. Quit'),
      CURSOR.replace('▶ [a] Trust this workspace', '  [a] Trust this workspace').replace('  [q] Quit', '▶ [q] Quit'),
      GEMINI.replace('● 1. Trust folder', '  1. Trust folder').replace('  3. Don\'t trust', '● 3. Don\'t trust'),
    ];
    expect(moved.map((s) => trustDialogOf(s))).toEqual([
      { cli: 'claude', acceptable: false },
      { cli: 'codex', acceptable: false },
      { cli: 'cursor', acceptable: false },
      { cli: 'gemini', acceptable: false },
    ]);
  });

  it("Codex's older dialog that also turns approvals off is never answered", () => {
    expect(trustDialogOf(CODEX_APPROVAL)).toEqual({ cli: 'codex', acceptable: false });
  });

  it('a pane that still shows an earlier CLI\'s dialog above reads only the newest one', () => {
    // Claude Code answered and exited, then Codex opened in the same tab with "Quit" selected: never Enter
    const codexQuit = CODEX.replace('› 1. Trust and continue', '  1. Trust and continue').replace('  2. Quit', '› 2. Quit');
    expect(trustDialogOf(`${CLAUDE}\nfake-claude trusted\n$ codex\n${codexQuit}`)).toEqual({ cli: 'codex', acceptable: false });
    expect(trustDialogOf(`${CLAUDE}\n$ codex\n${CODEX}`)).toEqual({ cli: 'codex', acceptable: true });
  });

  it('a transcript that only quotes a question, or any other screen, is no dialog', () => {
    expect(trustDialogOf('● O Codex perguntou "Trust this folder?" e o Gemini "Do you trust the files in this folder?".\n\n❯ ')).toBeNull();
    expect(trustDialogOf('Workspace Trust Required é o diálogo do Cursor\n> ')).toBeNull();
    expect(trustDialogOf('$ ls\nREADME.md\n$ ')).toBeNull();
    expect(trustDialogOf('')).toBeNull();
  });
});
