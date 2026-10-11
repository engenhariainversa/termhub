/**
 * The options of the permission dialog a tab shows (TER-995), read off a plain capture of its screen so
 * the chat card can offer every one of them — "Yes, and don't ask again…", "Yes, and switch to auto
 * mode" — and not only "Permitir" / "Negar". Claude Code and Codex both draw a numbered menu with a cursor
 * on the selected row (`❯ 1. Yes`, `› 1. Yes, proceed (y)`), right above the dialog's footer.
 */
import { DIALOG_FOOTER, lastNonBlankLines, PROMPT_MARKER_LINES } from './permission-dialog.js';

export interface PermissionOption {
  /** The number the dialog shows (1-based). */
  number: number;
  /** The option's whole text as drawn, its wrapped rows joined: what an answer names and the server checks again. */
  label: string;
  /** `label` shortened for a button: no key hint ("(esc)", "(y)"), no " · explanation", at most `SUMMARY_MAX` characters. */
  summary: string;
  /** False for the option that rejects ("No", "No, and tell Claude what to do differently"). */
  allow: boolean;
  /** The option that stops the same question from coming back ("don't ask again", "always allow", "auto mode"). */
  highlight: boolean;
}

export interface PermissionMenu {
  options: PermissionOption[];
  /** The number of the option under the cursor. */
  cursor: number;
}

export const SUMMARY_MAX = 80;
/** The most options a menu may have: one digit each. */
const MAX_OPTIONS = 9;
/** An option row: an optional cursor, its number, a dot and its text. */
const OPTION = /^\s*(?:([❯›>])\s*)?(\d+)\.\s+(.*\S)\s*$/;
/** The key hint Claude Code and Codex append to an option: "(esc)", "(shift+tab)", "(y)", "(p)". */
const KEY_HINT = /\s*\((?:esc|shift\+tab|[a-z])\)$/i;
const FOOTERS = [DIALOG_FOOTER.toLowerCase(), 'press enter to confirm or esc to cancel', 'enter to submit'];
const REJECT = /^no\b/i;
const HIGHLIGHT = /don['’]?t ask again|always allow|allow all|auto mode/i;

/** The button text for an option: the label without its key hint or the explanation after " · ". */
export function summariseOption(label: string): string {
  const text = label.split(' · ')[0]!.replace(KEY_HINT, '').trim() || label;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : text;
}

/**
 * The numbered menu at the bottom of the dialog, or null when there is none to trust: options must run
 * 1, 2, 3… with no gap, number at least two, and exactly one of them must carry the cursor. A row that is
 * not an option continues the option above it (a label wrapped in a narrow pane, or the description
 * Claude Code draws under some options). Only the last `PROMPT_MARKER_LINES` non-blank lines are read,
 * and the footer line under the menu is dropped. Callers check first that the card's dialog is the one
 * on screen (`promptVisible`): this only reads its options.
 */
export function parsePermissionMenu(screen: string): PermissionMenu | null {
  const lines = lastNonBlankLines(screen, PROMPT_MARKER_LINES).split('\n');
  const last = (lines.at(-1) ?? '').toLowerCase();
  if (FOOTERS.some((f) => last.includes(f))) lines.pop();
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = OPTION.exec(lines[i]!);
    if (m && Number(m[2]) === 1) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const rows: { number: number; text: string; cursor: boolean }[] = [];
  for (const line of lines.slice(start)) {
    const m = OPTION.exec(line);
    if (m && Number(m[2]) === rows.length + 1) rows.push({ number: rows.length + 1, text: m[3]!, cursor: m[1] !== undefined });
    else if (m) return null;
    else rows.at(-1)!.text += ` ${line.trim()}`;
  }
  const cursors = rows.filter((r) => r.cursor);
  if (rows.length < 2 || rows.length > MAX_OPTIONS || cursors.length !== 1) return null;
  return {
    cursor: cursors[0]!.number,
    options: rows.map((r) => {
      const label = r.text.replace(/\s+/g, ' ').trim();
      return { number: r.number, label, summary: summariseOption(label), allow: !REJECT.test(label), highlight: HIGHLIGHT.test(label) };
    }),
  };
}

/** Letters and digits only, lower-cased: an option compared across two reads of the same dialog. */
const squash = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/** The option `number` of the menu on screen, if its text is still `label`: else the dialog changed. */
export function findPermissionOption(menu: PermissionMenu | null, choice: { number: number; label: string }): PermissionOption | null {
  const option = menu?.options.find((o) => o.number === choice.number);
  return option && squash(option.label) === squash(choice.label) ? option : null;
}
