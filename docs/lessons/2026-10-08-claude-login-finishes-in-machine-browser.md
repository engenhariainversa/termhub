---
symptom: "Refazer login modal shows, in red: \"Opening browser to sign in… Paste code here if prompted > Login successful.\" and the login-required warning stays"
tags: [ai-login, claude-cli, agent, macos, tmux]
evidence: fixed
card: TER-1054
agent: claude
date: 2026-10-08
---
## Cause

`claude auth login` does not only wait for a pasted code. On a machine with a desktop (macOS here) it
opens the machine's own browser — `BROWSER=true` in the hidden tmux session does not stop it there — and
when the person signs in on that browser the CLI takes the OAuth callback itself, prints
`Login successful.` and exits 0, without ever asking for a code. The agent's `ai.login.start` only knew
"URL found" or "the CLI exited", and read every exit as a failure: it killed the session and sent the
pane text back as the error. The server never marked the account `ok`, so the warning stayed until the
next background check (up to 10 min, plus the 5 min state cache).

## Fix

Agent 0.27.0 (`apps/agent/src/rpc/ai-login.ts`):

- `start`: a pane that died is decided by the status command (`claude auth status`), not by the screen.
  Logged in → `{ url: null, logged_in: true }`; the server marks the account `ok` at once and lists the
  stuck tabs. A CLI that reported success (`#{pane_dead_status}` 0, or "Login successful") gets a few
  more status looks before it counts as a failure.
- `submit` with `code: null` for Claude is "Já entrei pelo navegador da máquina": it waits for the
  status without typing anything.
- The server re-checks the account on cancel, so closing the modal after finishing elsewhere clears
  the warning too.

The web and app show the CLI's output only as a detail ("Saída da CLI") under a plain error.

## How to check

On a Mac with the agent at 0.27.0: "Refazer login" on the Claude account, finish the sign-in in the
browser that opens on the Mac. The modal shows "Login refeito" and the red warning goes. On a fake CLI:
`npx vitest run apps/agent/src/rpc/ai-login.real.test.ts` (needs tmux).
