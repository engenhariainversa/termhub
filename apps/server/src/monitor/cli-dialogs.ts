import { lastNonBlankLines, permissionDialogVisible } from '../chat/permission-dialog.js';
import { trustDialogOf } from './trust-dialogs.js';

/*
 * TER-1166: the modal dialogs of the agent CLIs. While one is open the CLI's input box is gone: text typed
 * into the tab never becomes a prompt (Claude Code drops the letters and Enter acts on the dialog; in Codex the
 * letters even move the selection, so Enter may pick an option), no hook fires, and the tab keeps the state
 * it had. The screen is the only witness. Folder trust dialogs (trust-dialogs.ts), permission dialogs and
 * Claude Code's questions have rules and cards of their own and are left out here.
 *
 * Checked against Claude Code 2.1.322 (its `Dialog` titles; /hooks captured in tmux) and Codex 0.159.3 (the
 * three launch screens captured in tmux): fixtures/cli-dialogs/README.md. The screen is read and dropped,
 * never logged.
 */

export type DialogCli = 'claude' | 'codex';

export interface CliDialog {
  cli: DialogCli;
  /** A stable id for the dialog (`claude_unknown` for a Claude Code dialog no rule names). */
  id: string;
  /** The dialog's title as the CLI shows it, in English; null for an unnamed one. */
  title: string | null;
}

interface Named {
  cli: DialogCli;
  id: string;
  title: string;
}

/**
 * Dialogs a CLI opens on its own, at launch or between turns, by title. A title alone never counts: the
 * footer must be a dialog's and the input box gone (`footerOf`), so a transcript that quotes one is not read
 * as the dialog.
 */
const NAMED: readonly Named[] = [
  { cli: 'claude', id: 'claude_auto_mode_setup', title: 'Teach auto mode about your environment?' },
  { cli: 'claude', id: 'claude_release_notes', title: 'Release notes' },
  { cli: 'claude', id: 'claude_auto_updates', title: 'Enable Auto-Updates' },
  { cli: 'claude', id: 'claude_stable_channel', title: 'Switch to Stable Channel' },
  { cli: 'claude', id: 'claude_ide_auto_connect', title: 'Do you wish to enable auto-connect to IDE?' },
  { cli: 'claude', id: 'claude_ide_auto_connect_off', title: 'Do you wish to disable auto-connect to IDE?' },
  { cli: 'claude', id: 'claude_chrome_extension', title: 'Claude in Chrome extension detected' },
  { cli: 'claude', id: 'claude_fullscreen_feedback', title: 'Fullscreen feedback' },
  { cli: 'claude', id: 'claude_model_training', title: 'Help improve our AI models' },
  { cli: 'claude', id: 'claude_terms_update', title: 'Updates to Consumer Terms and Policies' },
  { cli: 'claude', id: 'claude_data_privacy', title: 'Data privacy' },
  { cli: 'claude', id: 'claude_api_key', title: 'Detected a custom API key in your environment' },
  { cli: 'claude', id: 'claude_api_spend', title: "You've spent $5 on the Anthropic API this session." },
  { cli: 'claude', id: 'claude_bypass_warning', title: 'WARNING: Claude Code running in Bypass Permissions mode' },
  { cli: 'claude', id: 'claude_other_account', title: 'This session belongs to another account' },
  { cli: 'claude', id: 'claude_resume', title: 'Resume this conversation?' },
  { cli: 'claude', id: 'claude_login', title: 'Log in to Claude' },
  { cli: 'codex', id: 'codex_hooks_review', title: 'Hooks need review' },
  { cli: 'codex', id: 'codex_update', title: 'Update available' },
  { cli: 'codex', id: 'codex_daemon_settings', title: 'Background server has incompatible feature settings' },
  { cli: 'codex', id: 'codex_model_upgrade', title: 'Codex just got an upgrade' },
  { cli: 'codex', id: 'codex_rate_limits', title: 'Approaching rate limits' },
];

/** How many non-blank rows, from the bottom, are read: every dialog above fits in less. */
const LINES = 30;
/** Claude Code's input box: a rule, then the prompt glyph at column 0 (`>` is the ASCII fallback). */
const RULE = /^\s*[─━]{10,}\s*$/;
const INPUT = /^[❯>](?: |$)/;
/** The hint a Claude Code dialog ends with ("Enter to confirm · Esc to cancel", "Esc to close", "Esc to go back"). */
const CLAUDE_FOOTER = /^\s*(?:Enter to \w+(?: \S+)? · )?Esc to (?:cancel|close|go back|exit|dismiss)\b/;
/** The hint a Codex selection screen ends with ("enter confirm · esc skip", "enter continue · esc quit"). */
const CODEX_FOOTER = /^\s*enter (?:confirm|continue|select)\b.*·\s*esc \w+/i;
/** A Codex numbered option with the selection mark (its daemon screen has no footer, only the options). */
const CODEX_SELECTED = /^›\s*\d\.\s/;
/** Codex's composer: the prompt mark with the placeholder or a draft, and the footer under it. */
const CODEX_COMPOSER = /^›\s(?!\s*\d\.\s)/;
/** Claude Code's question dialog (AskUserQuestion) has its own card and its own answer path. */
const QUESTION_MARKS = /^\s*(?:\d+\.\s*)?(?:Type something\.|Chat about this)\s*$/;

/** Whether the rows show Claude Code's input box (a rule, then the prompt glyph). */
function claudeInputBox(lines: string[]): boolean {
  for (let i = 1; i < lines.length; i++) if (INPUT.test(lines[i]!) && RULE.test(lines[i - 1]!)) return true;
  return false;
}

/** Which CLI's dialog footer the screen ends on, if any, with the CLI's input box gone. */
function footerOf(lines: string[]): DialogCli | null {
  const last = lines[lines.length - 1] ?? '';
  if (CLAUDE_FOOTER.test(last) && !claudeInputBox(lines)) return 'claude';
  if (lines.some((l) => CODEX_COMPOSER.test(l))) return null;
  // Codex's daemon settings screen ends on its options, with no footer
  if (CODEX_FOOTER.test(last) || lines.slice(-4).some((l) => CODEX_SELECTED.test(l))) return 'codex';
  return null;
}

/**
 * The modal dialog the screen shows, or null. A named dialog is told by its title; any other Claude Code
 * dialog (its footer hint, no input box) comes back as `claude_unknown`. Codex screens count only when named:
 * its approvals and questions end on footers of their own. Never throws.
 */
export function cliDialogOf(screen: string): CliDialog | null {
  if (typeof screen !== 'string' || !screen.trim()) return null;
  if (trustDialogOf(screen)) return null;
  const lines = lastNonBlankLines(screen, LINES).split('\n').map((l) => l.trimEnd());
  const cli = footerOf(lines);
  if (!cli) return null;
  if (cli === 'claude' && (permissionDialogVisible(screen) || lines.some((l) => QUESTION_MARKS.test(l)))) return null;
  // the lowest title wins: an earlier dialog may still be on screen above the one open now
  let best: { named: Named; row: number } | null = null;
  for (const named of NAMED) {
    if (named.cli !== cli) continue;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.trim().startsWith(named.title)) continue;
      if (!best || i > best.row) best = { named, row: i };
      break;
    }
  }
  if (best) return { cli, id: best.named.id, title: best.named.title };
  return cli === 'claude' ? { cli, id: 'claude_unknown', title: null } : null;
}

/** How each CLI is named in the tab's state text. */
export const DIALOG_CLI_LABEL: Record<DialogCli, string> = { claude: 'Claude Code', codex: 'Codex' };

/** The tab's state text for a dialog (pt-BR, as the other monitor texts): which dialog, and that typing is lost. */
export function cliDialogText(dialog: CliDialog): string {
  const cli = DIALOG_CLI_LABEL[dialog.cli];
  return dialog.title ? `Diálogo do ${cli} aberto: "${dialog.title}". O texto digitado na aba se perde até ele fechar` : `Um diálogo do ${cli} está aberto. O texto digitado na aba se perde até ele fechar`;
}
