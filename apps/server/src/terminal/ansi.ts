/**
 * Terminal captures with attributes (`tmux capture-pane -e`), read as text (spec 2026-09-25 tab
 * suggestions §4). Pure: no I/O, nothing logged. Only one attribute matters — dim (SGR 2), which
 * Claude Code uses for its suggested next prompt — and every other escape is dropped.
 */

/** Marks a dim run in `renderStyled`'s output. Nothing a shell prints uses these two. */
export const DIM_OPEN = '⟦';
export const DIM_CLOSE = '⟧';
/** Claude Code's input prompt (followed by a no-break space in 2.1.282). */
export const PROMPT_MARK = '❯';

interface Cell {
  ch: string;
  dim: boolean;
}

/**
 * CSI (ESC [ params intermediates final); an unterminated CSI — cut by the end of the capture or by the
 * next ESC — consumed whole; OSC (ESC ] … BEL or ST); or any other two-byte escape, whose second byte is
 * never another ESC, so `ESC ESC[2m` still reads as dim (spec 2026-09-26 §5.2).
 */
const ESCAPE = /\x1b\[([0-9;:?<=>]*)[ -\/]*([@-~])|\x1b\[[0-?]*[ -\/]*|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]\x1b]?/g;

/** What a cell can hold: a tab, or anything from space up — minus DEL and the C1 controls (0x9b is an 8-bit CSI). */
const printable = (ch: string) => ch === '\t' || (ch >= ' ' && ch !== '\x7f' && !(ch >= '\x80' && ch <= '\x9f'));

/** Dim after one SGR sequence: 2 sets it, 0 and 22 clear it (22 also clears bold); colours are skipped whole. */
function applySgr(params: string, dim: boolean): boolean {
  const list = params === '' ? ['0'] : params.split(';');
  for (let i = 0; i < list.length; i++) {
    const p = list[i] as string;
    if (p.includes(':')) continue; // 38:5:244 and friends: one self-contained colour
    const n = p === '' ? 0 : Number(p);
    if (n === 0 || n === 22) dim = false;
    else if (n === 2) dim = true;
    else if (n === 38 || n === 48 || n === 58) {
      // 38;5;N (256 colours) or 38;2;R;G;B (true colour): N, R, G, B are not attributes
      if (list[i + 1] === '5') i += 2;
      else if (list[i + 1] === '2') i += 4;
    }
  }
  return dim;
}

/** The capture as lines of cells: escapes dropped, dim tracked across the whole text (tmux carries it over lines). */
function parse(ansi: string): Cell[][] {
  const lines: Cell[][] = [[]];
  let dim = false;
  const text = (s: string) => {
    for (const ch of s) {
      if (ch === '\n') lines.push([]);
      else if (printable(ch)) (lines[lines.length - 1] as Cell[]).push({ ch, dim });
    }
  };
  let last = 0;
  for (const m of ansi.matchAll(ESCAPE)) {
    const at = m.index ?? 0;
    text(ansi.slice(last, at));
    last = at + m[0].length;
    const params = m[1] ?? '';
    if (m[2] === 'm' && !/[?<=>]/.test(params)) dim = applySgr(params, dim);
  }
  text(ansi.slice(last));
  return lines;
}

const isBlank = (ch: string) => /\s/.test(ch);

function renderLine(cells: Cell[]): string {
  let out = '';
  let i = 0;
  while (i < cells.length) {
    const cell = cells[i] as Cell;
    if (!cell.dim) {
      out += cell.ch;
      i++;
      continue;
    }
    let j = i;
    while (j < cells.length && (cells[j] as Cell).dim) j++;
    const run = cells
      .slice(i, j)
      .map((c) => c.ch)
      .join('');
    const body = run.trim();
    if (body === '') out += run;
    else {
      const lead = run.slice(0, run.length - run.trimStart().length);
      const tail = run.slice(run.trimEnd().length);
      out += `${lead}${DIM_OPEN}${body}${DIM_CLOSE}${tail}`;
    }
    i = j;
  }
  return out;
}

/** The capture as plain text with each dim run marked `⟦…⟧` (per line; blanks stay outside the brackets). */
export function renderStyled(ansi: string): string {
  return parse(ansi).map(renderLine).join('\n');
}

/**
 * A new session's empty prompt shows `Try "…"` dimmed, exactly like a suggestion: Claude Code's placeholder,
 * never a suggestion (spec 2026-09-26 §5.6). Curly quotes too. `renderStyled` still marks it `⟦…⟧`.
 */
export const PLACEHOLDER = /^Try ["“].*["”]$/;

/**
 * Claude Code's suggested next prompt, when the input box shows one: the last line whose first
 * non-blank character is `❯`, when everything after it is dim (blanks allowed). Anything non-dim —
 * text the person typed, a dialog's "❯ 1. Yes" — means there is no suggestion to offer, and so does
 * the new-session placeholder (`PLACEHOLDER`).
 */
export function promptSuggestion(ansi: string): string | null {
  const lines = parse(ansi);
  for (let k = lines.length - 1; k >= 0; k--) {
    const cells = lines[k] as Cell[];
    const start = cells.findIndex((c) => !isBlank(c.ch));
    if (start < 0 || (cells[start] as Cell).ch !== PROMPT_MARK) continue;
    const rest = cells.slice(start + 1);
    if (rest.some((c) => !c.dim && !isBlank(c.ch))) return null;
    const text = rest
      .map((c) => c.ch)
      .join('')
      .trim();
    return text === '' || PLACEHOLDER.test(text) ? null : text;
  }
  return null;
}
