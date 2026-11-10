import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cliDialogOf } from './cli-dialogs.js';

const dialog = (name: string) => readFileSync(new URL(`./fixtures/cli-dialogs/${name}.txt`, import.meta.url), 'utf8');
const claude = (name: string) => readFileSync(new URL(`./fixtures/claude-screens/${name}.txt`, import.meta.url), 'utf8');
const trust = (name: string) => readFileSync(new URL(`./fixtures/trust-screens/${name}.txt`, import.meta.url), 'utf8');

describe('cliDialogOf — a modal dialog holds the CLI’s input (TER-1166)', () => {
  it('Claude Code’s "Teach auto mode" dialog, by its title', () => {
    expect(cliDialogOf(dialog('claude-teach-auto-mode-2.1.322'))).toEqual({ cli: 'claude', id: 'claude_auto_mode_setup', title: 'Teach auto mode about your environment?' });
  });

  it('a Claude Code dialog with no rule of its own still counts: a footer hint and no input box (the /hooks menu)', () => {
    expect(cliDialogOf(dialog('claude-hooks-2.1.322'))).toEqual({ cli: 'claude', id: 'claude_unknown', title: null });
  });

  it('Codex’s "Hooks need review", update and daemon settings screens', () => {
    expect(cliDialogOf(dialog('codex-hooks-review-0.159.3'))).toEqual({ cli: 'codex', id: 'codex_hooks_review', title: 'Hooks need review' });
    expect(cliDialogOf(dialog('codex-update-0.159.3'))).toEqual({ cli: 'codex', id: 'codex_update', title: 'Update available' });
    expect(cliDialogOf(dialog('codex-daemon-settings-0.159.3'))).toEqual({ cli: 'codex', id: 'codex_daemon_settings', title: 'Background server has incompatible feature settings' });
  });

  it('a CLI at its input box shows no dialog, even with a dialog title in the transcript above', () => {
    expect(cliDialogOf(dialog('codex-composer-0.159.3'))).toBeNull();
    expect(cliDialogOf(claude('idle-2.1.285'))).toBeNull();
    expect(cliDialogOf(claude('working-2.1.285'))).toBeNull();
    expect(cliDialogOf(claude('background-agent-2.1.285'))).toBeNull();
    const quoted = `● O agente parou em "Teach auto mode about your environment?" e "Hooks need review".\n\n✻ Worked for 2s\n\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  ⏵⏵ auto mode on (shift+tab to cycle)`;
    expect(cliDialogOf(quoted)).toBeNull();
  });

  it('leaves the folder trust dialog and the permission and question dialogs to their own rules', () => {
    expect(cliDialogOf(claude('trust-2.1.289'))).toBeNull();
    expect(cliDialogOf(claude('trust-2.1.322'))).toBeNull();
    expect(cliDialogOf(trust('codex-0.159.3'))).toBeNull();
    expect(cliDialogOf(claude('question-2.1.285'))).toBeNull();
    const permission = ` Bash command\n\n   rm -rf dist\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n\n Esc to cancel · Tab to amend`;
    expect(cliDialogOf(permission)).toBeNull();
    const codexApproval = `  Would you like to run the following command?\n\n  $ rm -rf dist\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel`;
    expect(cliDialogOf(codexApproval)).toBeNull();
  });

  it('a plain shell or an empty pane is no dialog', () => {
    expect(cliDialogOf('')).toBeNull();
    expect(cliDialogOf('user@host:~/project$ ls\nREADME.md  src\nuser@host:~/project$ ')).toBeNull();
  });
});
