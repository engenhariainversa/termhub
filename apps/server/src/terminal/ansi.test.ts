import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptSuggestion, renderStyled } from './ansi.js';

const fx = (name: string) => readFileSync(join(import.meta.dirname, '../chat/fixtures/tab-suggestions', name), 'utf8');
const suggestion = { ansi: fx('screen-suggestion.ansi'), txt: fx('screen-suggestion.txt') };
const typed = { ansi: fx('screen-typed.ansi'), txt: fx('screen-typed.txt') };
/** tmux trims trailing blanks only in a plain capture: compare line by line without them. */
const lines = (s: string) => s.split('\n').map((l) => l.trimEnd());
const NBSP = ' ';

describe('renderStyled', () => {
  it('drops every escape of a real screen and marks its one dim run — the suggestion', () => {
    const out = renderStyled(suggestion.ansi);
    expect(out).not.toContain('\x1b');
    expect(out.match(/⟦/g)).toHaveLength(1);
    expect(lines(out)).toEqual(lines(suggestion.txt.replace(`❯${NBSP}commit it`, `❯${NBSP}⟦commit it⟧`)));
  });

  it('typed text has no dim attribute: the screen reads exactly as the plain capture', () => {
    expect(lines(renderStyled(typed.ansi))).toEqual(lines(typed.txt));
  });

  it.each([
    ['SGR 2 closed by 22', 'a \x1b[2mhint\x1b[22m b', 'a ⟦hint⟧ b'],
    ['SGR 2 closed by 0', '\x1b[2mhint\x1b[0m', '⟦hint⟧'],
    ['SGR 2 closed by an empty SGR', '\x1b[2mhint\x1b[m!', '⟦hint⟧!'],
    ['dim combined with a colour', '\x1b[2;38;5;244mhint\x1b[0m', '⟦hint⟧'],
    ['a 256-colour index 2 is a colour, not dim', '\x1b[38;5;2mgreen\x1b[0m', 'green'],
    ['a true-colour 2 is a colour, not dim', '\x1b[38;2;2;2;2mrgb\x1b[39m', 'rgb'],
    ['blanks stay outside the brackets', '❯ \x1b[2m  run it  \x1b[0m|', '❯   ⟦run it⟧  |'],
    ['a dim run of blanks is left as it is', 'a\x1b[2m   \x1b[0mb', 'a   b'],
    ['a run is closed at the end of each line', '\x1b[2mone\ntwo\x1b[0m', '⟦one⟧\n⟦two⟧'],
    ['other escapes (cursor, OSC title, private modes) are dropped', '\x1b[2K\x1b]0;title\x07ok\x1b[?25h', 'ok'],
    ['plain text is unchanged, trailing newline included', '$ ls\nREADME.md\n', '$ ls\nREADME.md\n'],
  ])('%s', (_label, input, expected) => {
    expect(renderStyled(input)).toBe(expected);
  });
});

describe('promptSuggestion', () => {
  it('reads the suggestion off the real screen', () => {
    expect(promptSuggestion(suggestion.ansi)).toBe('commit it');
  });

  it('is null for text the person typed', () => {
    expect(promptSuggestion(typed.ansi)).toBeNull();
  });

  it('is null when something typed sits before the rest of the suggestion', () => {
    expect(promptSuggestion(`\x1b[39m❯${NBSP}com\x1b[2mmit it\x1b[0m`)).toBeNull();
  });

  it('is null with no prompt on screen, or an empty prompt', () => {
    expect(promptSuggestion('$ ls\nREADME.md\n')).toBeNull();
    expect(promptSuggestion(`❯${NBSP}\n`)).toBeNull();
    expect(promptSuggestion('')).toBeNull();
  });

  it('reads only the last prompt line, after optional spaces, with any SGR that sets dim', () => {
    expect(promptSuggestion('❯ \x1b[2mold\x1b[0m\n❯ roda a migration\n')).toBeNull();
    expect(promptSuggestion('❯ typed before\n  ❯ \x1b[2;38;5;244mrun the tests\x1b[22m  \n')).toBe('run the tests');
  });

  it("a dialog's selection marker is not a suggestion", () => {
    expect(promptSuggestion(' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n')).toBeNull();
  });
});
