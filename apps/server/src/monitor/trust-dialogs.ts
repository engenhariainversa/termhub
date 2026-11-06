import { lastNonBlankLines } from '../chat/permission-dialog.js';

/*
 * The folder trust dialog of each agent CLI termhub runs (TER-1046, TER-1117, TER-1122). Each one asks the first
 * time it opens a folder, before any hook fires, so the screen is the only witness. One rule per CLI: the
 * question, and its "trust" option with the selection mark on it (Enter then answers "trust"). A dialog
 * whose trust option is not the selected one, or one that also changes how the CLI asks for permissions
 * (Codex's older "allow Codex to work in this folder without asking for approval"), is recognised but never
 * answered by the server: the person decides. The screen is compared and dropped, never logged.
 *
 * Checked against:
 * - Claude Code 2.1.289 (fixtures/claude-screens/trust-2.1.289.txt): "❯ 1. Yes, I trust this folder";
 * - Codex 0.159.3 (fixtures/trust-screens/codex-0.159.3.txt): "Trust this folder?" / "› 1. Trust and continue",
 *   and the earlier "Do you trust the contents of this directory?" / "› 1. Yes, continue";
 * - Cursor CLI (fixtures/trust-screens/cursor.txt, from a public capture: the CLI is not open source):
 *   "Workspace Trust Required" / "▶ [a] Trust this workspace";
 * - Gemini CLI (fixtures/trust-screens/gemini.txt, from its FolderTrustDialog and RadioButtonSelect sources):
 *   "Do you trust the files in this folder?" / "● 1. Trust folder (<dir>)".
 */

export type TrustCli = 'claude' | 'codex' | 'cursor' | 'gemini';

export interface TrustDialog {
  cli: TrustCli;
  /** The trust option is selected and answering it changes nothing else: Enter is the answer. */
  acceptable: boolean;
  /** The selection mark is on the trust option (TER-1148: false when it starts on "No, exit"). */
  selected: boolean;
  /** Answering also changes the CLI's permissions: never answered by the server. */
  changesPermissions: boolean;
}

interface Rule {
  cli: TrustCli;
  question: RegExp;
  /** The trust option, whatever is selected: tells the dialog from a transcript that merely quotes the question. */
  option: RegExp;
  /** The trust option with the selection mark on it. */
  selected: RegExp;
  /** Answering also changes the CLI's permissions: never answered by the server. */
  changesPermissions?: boolean;
}

/** The selection marks the CLIs draw in front of an option. */
const MARK = '[❯›>▶●→]';

const RULES: readonly Rule[] = [
  {
    cli: 'claude',
    question: /one you trust|trust this folder|trust the files in this folder/i,
    option: /^\s*(?:❯\s*)?1\.\s*Yes, I trust this folder/,
    selected: /❯\s*1\.\s*Yes, I trust this folder/,
  },
  {
    cli: 'codex',
    question: /allow Codex to work in this folder/i,
    option: /^\s*(?:›\s*)?1\.\s*Yes, allow Codex to work in this folder/,
    selected: /›\s*1\.\s*Yes, allow Codex to work in this folder/,
    changesPermissions: true,
  },
  {
    cli: 'codex',
    question: /Trust this folder\?|Do you trust the contents of this directory\?/i,
    option: /^\s*(?:›\s*)?1\.\s*(?:Trust and continue|Yes, continue)\b/,
    selected: /›\s*1\.\s*(?:Trust and continue|Yes, continue)\b/,
  },
  {
    cli: 'cursor',
    question: /Workspace Trust Required/i,
    option: new RegExp(`^[\\s│]*(?:${MARK}\\s*)?\\[a\\]\\s*Trust this workspace`),
    selected: new RegExp(`${MARK}\\s*\\[a\\]\\s*Trust this workspace`),
  },
  {
    cli: 'gemini',
    question: /Do you trust the files in this folder\?/i,
    option: /^[\s│]*(?:●\s*)?1\.\s*Trust folder\b/,
    selected: /●\s*1\.\s*Trust folder\b/,
  },
];

/** How many non-blank rows, from the bottom, are read: every dialog fits in less. */
const LINES = 30;

/** The last row at or above `from` that matches `re`; -1 when none does. */
function lastIndex(lines: string[], re: RegExp, from: number): number {
  for (let i = from; i >= 0; i--) if (re.test(lines[i]!)) return i;
  return -1;
}

/**
 * The trust dialog the screen shows, of whichever CLI; null when it shows none. A pane may still hold an
 * earlier CLI's dialog above (Claude Code exited, Codex started in the same tab): only the dialog lowest on
 * the screen counts, and its selection is read from its own rows, from its question down.
 */
export function trustDialogOf(screen: string): TrustDialog | null {
  const lines = lastNonBlankLines(screen, LINES).split('\n');
  let found: { rule: Rule; start: number; option: number } | null = null;
  for (const rule of RULES) {
    const option = lastIndex(lines, rule.option, lines.length - 1);
    if (option < 0 || (found && option <= found.option)) continue;
    const start = lastIndex(lines, rule.question, option);
    if (start >= 0) found = { rule, start, option };
  }
  if (!found) return null;
  const selected = lines.slice(found.start).some((l) => found.rule.selected.test(l));
  const changesPermissions = !!found.rule.changesPermissions;
  return { cli: found.rule.cli, acceptable: selected && !changesPermissions, selected, changesPermissions };
}

/** How each CLI is named in the tab's state text. */
export const TRUST_CLI_LABEL: Record<TrustCli, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI' };
