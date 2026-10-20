/**
 * Whether a tab is showing a Claude Code dialog right now, read from a plain capture of its screen. Kept
 * apart from `tab-question-answer.ts` (which re-exports all of it) so the chat gate can use the same
 * rule without importing the answer flow, which reaches back into the gate through `service.ts`.
 */
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { hintMarkers } from './permission-hint.js';
import type { ChoicePayload, PermissionPayload } from './tab-question-payload.js';

/** How much of the pane the excerpt shown with a question reads. */
export const SCREEN_EXCERPT_LINES = 20;
/** The footer both Claude Code dialogs end with ("… · Esc to cancel", "Esc to cancel · Tab to amend"). */
export const DIALOG_FOOTER = 'Esc to cancel';
/** How far above the footer the question's marker may sit: the dialog block, not the scrollback. */
export const PROMPT_MARKER_LINES = 25;

/** A box-drawing rule: Claude Code draws its input box between two of them. ASCII dashes are not a rule —
 * they are as likely a command preview's output (`printf '%s\n' '----------'`) as a real input box. */
const RULE = /^\s*[─━]{10,}\s*$/;

/**
 * The first line of Claude Code's permission dialog for the tools whose title is known from a real
 * capture (fixtures/permission-dialogs, and spec 2026-09-30 tab questions per subagent §3), lower-cased.
 * A subagent's dialog adds " · from the <type> agent" after it.
 */
const DIALOG_TITLES: readonly (readonly [title: string, tool: string])[] = [
  ['bash command', 'Bash'],
  ['edit file', 'Edit'],
  ['fetch', 'WebFetch'],
];

/**
 * The tool whose dialog the capture shows, when its title is one the server knows: the line under the
 * lowest box rule. Null for a dialog with another title, and for a capture with no rule. Only that one
 * rule is read: above it is the transcript, where a rule and a line that looks like a title may be
 * anybody's text. Used to refuse a card whose dialog is not the one on screen; never to accept one.
 */
export function dialogTool(screen: string): string | null {
  const lines = screen.split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!RULE.test(lines[i]!)) continue;
    const under = (lines[i + 1] ?? '').trim().toLowerCase();
    return DIALOG_TITLES.find(([title]) => under === title || under.startsWith(`${title} `))?.[1] ?? null;
  }
  return null;
}

/**
 * The tool of the permission dialog on screen, identified positively for an automatic answer (agentic
 * board spec §9.2, review I1): the line under the lowest box rule is exactly one of the known titles — no
 * subagent suffix, no unknown title — and that title's tool is the card's `tool_name`. Unlike `promptVisible`
 * (which fails open on a title it does not know, for a person who sees the excerpt), anything else is
 * false: an MCP tool, Write, a subagent's dialog, a Codex row, another dialog swapped in.
 */
export function permissionToolOnScreen(screen: string, row: Pick<TabQuestion, 'kind' | 'payload'>): boolean {
  if (row.kind !== 'permission') return false;
  const payload = row.payload as PermissionPayload;
  if (payload.agent === 'codex' || !promptVisible(screen, row)) return false;
  const lines = screen.split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!RULE.test(lines[i]!)) continue;
    const under = (lines[i + 1] ?? '').trim().toLowerCase();
    return DIALOG_TITLES.some(([title, tool]) => under === title && tool === payload.tool_name);
  }
  return false;
}

/**
 * Letters and digits only: whitespace (Claude Code wraps a long question over indented rows) and
 * every mark the terminal may render differently from the tool's input (markdown backticks and
 * asterisks, curled quotes, dashes) are dropped on both sides of the comparison.
 */
const squash = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');
/** The last `lines` non-blank rows of a capture, as one string. */
export function lastNonBlankLines(text: string, n = SCREEN_EXCERPT_LINES): string {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .join('\n');
}

/** Codex's approval menu ends on this line; its question dialog ends on "… enter to submit answer/all …". */
const CODEX_APPROVAL_FOOTER = 'press enter to confirm or esc to cancel';
const CODEX_QUESTION_FOOTER = 'enter to submit';

/**
 * `promptVisible` for a Codex row (Codex 0.159.2): the same two-part rule with Codex's footers. The last
 * non-blank line is the menu's own footer (a tab back at its composer never passes), and the block holds
 * the dialog's marker: "Would you like to" / "Do you want to" for an approval, the first question's text
 * for a question.
 */
function codexPromptVisible(block: string, row: Pick<TabQuestion, 'kind' | 'payload'>): boolean {
  const last = block.slice(block.lastIndexOf('\n') + 1).toLowerCase();
  const shown = squashLower(block);
  if (row.kind === 'choice') {
    if (!last.includes(CODEX_QUESTION_FOOTER)) return false;
    const marker = squash((row.payload as ChoicePayload).questions[0]?.question ?? '').slice(0, 80);
    return marker !== '' && squash(block).includes(marker);
  }
  if (!last.includes(CODEX_APPROVAL_FOOTER)) return false;
  return shown.includes(squashLower('would you like to')) || shown.includes(squashLower('do you want to'));
}

/** Whether the last non-blank line of a capture is a dialog's footer: the tab is showing a dialog now. */
export function dialogFooterVisible(screen: string): boolean {
  const block = lastNonBlankLines(screen, 1);
  return block.includes(DIALOG_FOOTER);
}

/**
 * Whether the tab shows some dialog of the row's own agent now, recognised or not: Codex's two footers
 * for a Codex row (`payload.agent === 'codex'`), Claude Code's `DIALOG_FOOTER` otherwise. A Codex card
 * on a Claude screen (or the reverse) is stale, not "not seen".
 */
export function rowDialogFooterVisible(screen: string, row: Pick<TabQuestion, 'payload'>): boolean {
  if ((row.payload as { agent?: string }).agent !== 'codex') return dialogFooterVisible(screen);
  const last = lastNonBlankLines(screen, 1).toLowerCase();
  return last.includes(CODEX_APPROVAL_FOOTER) || last.includes(CODEX_QUESTION_FOOTER);
}

/**
 * The live check (spec §5.3): the question must be the dialog the tab is showing *now*. Two things,
 * both required. The last non-blank line is a dialog's footer (`DIALOG_FOOTER`), so a tab back at
 * its normal prompt never passes, whatever its scrollback says. And the marker sits within the last
 * `PROMPT_MARKER_LINES` non-blank lines, that is inside the dialog block: "Do you want" for a permission
 * (Claude Code asks "Do you want to proceed?" or "Do you want to make this edit…?"; the tool's name
 * alone is not enough, it stays in the scrollback). For a choice, the first question's text — or, when
 * the card is taller than the pane and the question's start is above the top of the screen (TER-542),
 * every option label of that question, within the whole capture. Both sides are reduced to letters and
 * digits (`squash`) before comparing. A permission is also refused when the known title under the lowest
 * box rule belongs to another tool (spec 2026-09-30 tab questions per subagent §5). That check fails open
 * on purpose: an unknown or renamed title makes it a no-op, not a refusal of every card. A permission with
 * a hint (TER-614) must also show that hint in its dialog (`hintVisible`). A Codex row
 * (`payload.agent === 'codex'`) takes Codex's own rule instead (`codexPromptVisible`).
 */
export function promptVisible(screen: string, row: Pick<TabQuestion, 'kind' | 'payload'>): boolean {
  if ((row.payload as { agent?: string }).agent === 'codex') return codexPromptVisible(lastNonBlankLines(screen, PROMPT_MARKER_LINES), row);
  if (!dialogShown(screen, row)) return false;
  if (row.kind !== 'permission') return true;
  const payload = row.payload as PermissionPayload;
  const tool = dialogTool(screen);
  return (tool === null || tool === payload.tool_name) && hintVisible(screen, payload);
}

/**
 * Whether a permission's hint (TER-614) is in the dialog on screen: the capture from its lowest box rule
 * down (the dialog's title, then the command or the file), holding each of `hintMarkers` in order, both
 * sides NFC and reduced to letters and digits (`squash`), so a wrapped line, an accent written decomposed
 * or a redacted value does not matter. This is what tells two "Bash command" dialogs apart. A card with no
 * hint, and a capture with no rule (a dialog taller than the screen, its top scrolled off), pass: the check
 * refuses a dialog it can read, never one it cannot.
 */
export function hintVisible(screen: string, payload: Pick<PermissionPayload, 'tool_name' | 'hint'>): boolean {
  if (!payload.hint) return true;
  const lines = screen.split('\n').filter((l) => l.trim() !== '');
  let rule = -1;
  for (let i = lines.length - 1; i >= 0 && rule < 0; i--) if (RULE.test(lines[i]!)) rule = i;
  if (rule < 0) return true;
  const shown = squash(lines.slice(rule + 1).join('\n').normalize('NFC'));
  let from = 0;
  for (const marker of hintMarkers(payload.tool_name, payload.hint)) {
    const wanted = squash(marker.normalize('NFC'));
    if (!wanted) continue;
    const at = shown.indexOf(wanted, from);
    if (at < 0) return false;
    from = at + wanted.length;
  }
  return true;
}

/** The shared footer/marker check, independent of the permission card's tool. */
function dialogShown(screen: string, row: Pick<TabQuestion, 'kind' | 'payload'>): boolean {
  if (!dialogFooterVisible(screen)) return false;
  const shown = squash(lastNonBlankLines(screen, PROMPT_MARKER_LINES));
  if (row.kind === 'choice') {
    const first = (row.payload as ChoicePayload).questions[0];
    const marker = squash(first?.question ?? '').slice(0, 80);
    // A question with no letters or digits leaves no marker, and '' is in every screen.
    if (marker !== '' && shown.includes(marker)) return true;
    const labels = (first?.options ?? []).map((o) => squash(o.label));
    if (labels.length < 2 || labels.some((l) => l === '')) return false;
    const whole = squash(screen);
    return labels.every((l) => whole.includes(l));
  }
  return shown.includes(squash('Do you want'));
}

/**
 * Questions and titles of the approval dialogs of Claude Code 2.1.283 and Codex 0.157.1, read from the
 * shipped binaries (spec 2026-09-28 TER-374 §2-3). The generic three cover almost every approval
 * question; the rest are titles not phrased as "do you / would you". Over-matching only turns a
 * keystroke into a confirmation card, never the other way round.
 */
export const PERMISSION_MARKERS: readonly string[] = [
  'do you want to', 'do you wish to', 'would you like to',
  'enter plan mode', 'exit plan mode', 'ready to code', 'allow reads outside', 'approve the command', 'approve this command',
  'run this command', 'use this skill', 'allow claude to', 'trust this directory', 'a project you created or one you trust',
  'needs your approval', 'approve network access',
];
const squashLower = (s: string) => squash(s).toLowerCase();
const MARKERS = PERMISSION_MARKERS.map(squashLower);
/** The selected option of a numbered menu: Claude Code draws `❯ 1. Yes`, Codex `› 1. Yes, proceed (y)`
 * (`>` is Claude Code's ASCII fallback). Group 1 is the cursor character (to tell a real menu's cursor
 * apart from a quoted list's `>`), group 2 the number (to find its sibling options). */
const SELECTED_OPTION = /^\s*([❯›>])\s*(\d+)\./;
/** An option that is not selected: a number and a dot, no cursor. */
const PLAIN_OPTION = /^\s*(\d+)\./;

/**
 * Option labels that exist only in an approval menu, never in a routine one (spec 2026-09-28 TER-374
 * §3 "Approval options", fix round 1). Codex draws its question *above* the command, so a long
 * multi-line command (a heredoc, say) can push the question out of the last `PROMPT_MARKER_LINES`
 * non-blank lines while the menu itself — cursor and options — is still inside that window. Matched
 * from the selected-option line to the end of the block (the menu, not the command above it), the same
 * way as `PERMISSION_MARKERS`.
 */
export const APPROVAL_OPTIONS: readonly string[] = [
  'and tell codex what to do differently', 'and tell claude what to do differently', 'yes, proceed', "don't ask again",
  'grant these permissions', 'just this once', 'continue without running it',
];
const OPTIONS = APPROVAL_OPTIONS.map(squashLower);

/**
 * The index in `lines` of the selected option of a real menu, or -1 (spec 2026-09-28 TER-380, fix
 * round 2; TER-397 narrowed both rejections below). A menu has a plain sibling option (the cursor's
 * number ± 1), searched across the whole window — `lines` is already just the last
 * `PROMPT_MARKER_LINES` non-blank rows, so that window is the only bound in either direction (a wrapped
 * label or a multi-line description can push a sibling many rows away in a narrow pane, round 2); a
 * cursor sitting inside Claude Code's input box (drawn between two box-drawing rules, `─`/`━`, one
 * above the cursor and one further below it) is typed text (`❯ 1. …` typed by the user or the
 * concierge), not a dialog — a rule made of ASCII dashes is not enough, since a Codex command preview's
 * last line can print `----------` right above a real menu (TER-397). A second cursor immediately
 * adjacent to it (index ± 1) that repeats the *same* cursor character with a number also the cursor's ±
 * 1 is a quoted list (`> 1.` / `> 2.`, every row prefixed with the same mark) — that alone is rejected;
 * a Codex preview line like `> 2. Add the scope column` right above a real `› 1. …` menu uses a
 * different cursor character, so it no longer drops the menu (TER-397). An echoed `› 1. …` message
 * sitting further above a real Codex dialog is not rejected either, since a sent message is never
 * adjacent to the dialog's own options (round 1).
 */
function menuCursor(lines: string[]): number {
  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (SELECTED_OPTION.test(lines[i]!)) { cursor = i; break; }
  if (cursor < 0) return -1;
  if (cursor > 0 && RULE.test(lines[cursor - 1]!) && lines.slice(cursor + 1).some((l) => RULE.test(l))) return -1;
  const [, mark, num] = SELECTED_OPTION.exec(lines[cursor]!)!;
  const n = Number(num);
  for (const i of [cursor - 1, cursor + 1]) {
    if (i < 0 || i >= lines.length) continue;
    const m = SELECTED_OPTION.exec(lines[i]!);
    if (m && m[1] === mark && Math.abs(Number(m[2]) - n) === 1) return -1;
  }
  let sibling = false;
  for (let i = 0; i < lines.length; i++) {
    if (i === cursor) continue;
    const m = PLAIN_OPTION.exec(lines[i]!);
    if (m && Math.abs(Number(m[1]) - n) === 1) sibling = true;
  }
  return sibling ? cursor : -1;
}

/**
 * Whether the screen shows an agent's permission dialog right now. Used by the gate before a terminal
 * grant presses a key (TER-325), so it leans towards "yes": the shared rule for a permission row
 * (footer + "Do you want"), or — for dialogs worded otherwise or without that footer — a marker phrase
 * above the menu's selected option, or an approval option at or below it, both inside the last
 * `PROMPT_MARKER_LINES` non-blank lines. The cursor keeps the model's own prose ("Would you like to
 * proceed?") from counting, and the approval-options half keeps a long command from pushing the
 * question itself out of the window (TER-374 fix round 1); a menu with no marker or approval option
 * (Claude Code's exit menu, `/resume`) is not a permission and stays free (TER-374). `menuCursor` rejects
 * a typed input box, a Codex composer line and a quoted list before either half runs, while still finding
 * a real menu next to an echoed message above it or an option wrapped over any number of rows in the
 * window (TER-380).
 */
export function permissionDialogVisible(screen: string): boolean {
  if (dialogShown(screen, { kind: 'permission', payload: { tool_name: '' } })) return true;
  const lines = lastNonBlankLines(screen, PROMPT_MARKER_LINES).split('\n');
  const cursor = menuCursor(lines);
  if (cursor < 0) return false;
  const above = squashLower(lines.slice(0, cursor).join('\n'));
  if (MARKERS.some((m) => above.includes(m))) return true;
  const menu = squashLower(lines.slice(cursor).join('\n'));
  return OPTIONS.some((o) => menu.includes(o));
}
