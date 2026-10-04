import { dialogFooterVisible, lastNonBlankLines, permissionDialogVisible } from '../chat/permission-dialog.js';

/**
 * What a Claude Code tab shows, read from a plain capture of its pane (TER-615): the hooks said
 * `working` and then went quiet, and the screen is the only witness left.
 *
 * - `dialog`: a question (AskUserQuestion) or a permission dialog waits for the person;
 * - `busy`: the spinner of a turn in progress (`✢ Catapulting… (14s · ↓ 145 tokens)`);
 * - `background`: the turn ended and Claude Code waits on background work it started
 *   (`✻ Waiting for 1 background agent to finish`, TER-644) — not a wait for the person;
 * - `prompt`: Claude Code is back at its input box with no turn running;
 * - null: anything else (a shell after Claude Code exited, an empty pane) — nothing is derived.
 *
 * The input box is drawn under the spinner during a turn too, so a turn in progress is told apart by
 * the spinner alone: a glyph at column 0, one space, then words ending in an ellipsis. A finished
 * turn leaves the same glyph in the past tense and without one ("✻ Sautéed for 39s", "✻ Waiting for
 * 1 background agent to finish"). The transcript never starts a line with a spinner glyph: an
 * answer's first line starts with "●" and the rest are indented. Never logged.
 */
export type ScreenState = 'dialog' | 'busy' | 'background' | 'prompt';

/** How many non-blank rows, from the bottom, are read: the spinner, the input box and the footer. */
export const SCREEN_STATE_LINES = 30;

/** Claude Code's spinner glyphs (the hook script's list, `*` being the ASCII fallback). */
const SPINNER = /^[·✢✳✶✻✽*] [^\s(][^(]{0,60}?(?:…|\.\.\.)(?: \(.*)?$/u;
/** The line a finished turn leaves while its background work runs: "Waiting for 2 background agents to finish". */
const BACKGROUND = /^[·✢✳✶✻✽*] Waiting for \d+ background [A-Za-z ]{1,40}? to finish\b/u;
/** The rules drawn above and below the input box. */
const RULE = /^\s*[─━]{10,}\s*$/;
/** The input box's first row: the prompt glyph at column 0 (`>` is the ASCII fallback). */
const INPUT = /^[❯>](?: |$)/;

export function claudeScreenState(screen: string): ScreenState | null {
  if (dialogFooterVisible(screen) || permissionDialogVisible(screen)) return 'dialog';
  const lines = lastNonBlankLines(screen, SCREEN_STATE_LINES).split('\n').map((l) => l.trimEnd());
  if (lines.some((l) => SPINNER.test(l))) return 'busy';
  if (lines.some((l) => BACKGROUND.test(l))) return 'background';
  for (let i = 1; i < lines.length; i++) {
    if (INPUT.test(lines[i]!) && RULE.test(lines[i - 1]!)) return 'prompt';
  }
  return null;
}
