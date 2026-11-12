# Modal dialogs of the agent CLIs

Read by `monitor/cli-dialogs.ts` (TER-1166): a dialog that takes over the CLI's input, so text typed into
the tab is lost (or picks one of the dialog's options). Paths and hook commands are neutral, never a real
machine's.

- `claude-hooks-2.1.322.txt`: captured from Claude Code 2.1.322 in tmux (`/hooks`): a dialog with no rule of
  its own, read by the generic rule (footer hint, no input box).
- `claude-teach-auto-mode-2.1.322.txt`: rebuilt from Claude Code 2.1.322's source (the `Dialog` with title
  "Teach auto mode about your environment?", options Yes / Not now / Don't show again, Esc = Not now) in the
  layout of the real trust dialog of the same release (`../claude-screens/trust-2.1.322.txt`). Replace it
  with a real capture when one is at hand.
- `codex-hooks-review-0.159.3.txt`, `codex-update-0.159.3.txt`, `codex-daemon-settings-0.159.3.txt`,
  `codex-composer-0.159.3.txt`: captured from Codex CLI 0.159.3 in tmux, in the order it showed them on
  launch (the composer is the screen after the last one was skipped).
- `codex-hooks-review-0.164.0.txt`: Codex CLI 0.164.0's "Hooks need review", in tmux, launched with a first
  message (`codex --no-alt-screen 'first message'`), which it holds until the screen is answered (TER-1162).
  `codex-hooks-review-answered-0.164.0.txt`: the same pane after "Trust all and continue": the screen stays in
  the history above the composer, and must not read as the dialog.
