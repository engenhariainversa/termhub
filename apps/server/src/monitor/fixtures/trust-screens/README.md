# Folder trust dialogs of the agent CLIs

Read by `monitor/trust-dialogs.ts` (TER-1122). Paths are neutral, never a real machine's.

- `codex-0.159.3.txt`: captured from Codex CLI 0.159.3 in tmux (`codex --no-alt-screen` in a fresh git repo).
- `cursor.txt`: rebuilt from a public capture of the Cursor CLI's dialog (the CLI is not open source and
  was not installed where this was written). Replace it with a real capture when one is at hand.
- `gemini.txt`: rebuilt from Gemini CLI's sources (`FolderTrustDialog.tsx`, `BaseSelectionList.tsx`: the
  first option selected, `●` as the mark, numbered options). Replace it with a real capture too.

Claude Code's dialog lives in `../claude-screens/trust-2.1.289.txt`.
