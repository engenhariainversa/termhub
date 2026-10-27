---
symptom: "New project: the agent tab looks like it is working/thinking, but Claude Code is stopped on \"Quick safety check: Is this a project you created or one you trust?\" and nobody is told"
tags: [monitor, claude-code, trust, start_agent, concierge]
evidence: fixed
card: TER-1117
agent: claude
date: 2026-10-24
---
## Cause

Claude Code asks whether a folder is trusted the first time it opens it (a project just linked, a new
machine, an account that never ran there), and the dialog comes before any hook. termhub only answered it
in the worktrees of automatic work (TER-1025). Anywhere else the tab either reported nothing (no
indicator at all) or kept `working` from the input that started it, so it looked busy. The screen
sweeps (TER-1046) only read an unreported tab after 2 minutes, and a `working` one after 3, and even
then `trust_prompt` woke nobody: no push for that state, and the concierge only learnt of it through a
watch it had to remember to create.

## Fix

- `apps/server/src/monitor/folder-trust.ts`: right after `start_agent` or "Iniciar sessão" types a Claude
  line, the tab's screen is read at 2, 5, 10, 20 and 40 s. The dialog in the project's own folder (tab
  `cwd` null) is answered with Enter on "Yes" (project setup `agent.trust_project_folder`, on by default)
  and logged in the feed as `trust_auto_accepted`; anywhere else the tab becomes `trust_prompt` at once.
  The sweeps use the same function, and read unreported tabs after 30 s (rechecked every 2 min).
- `trust_prompt` pushes "A aba X está esperando você confiar na pasta Y" (`mobile/push.ts`) and wakes the
  project's chat through a server-made watch (`chat/trust-wake.ts`).
- `start_agent` called from the chat watches its tab until the first stop on its own (`watch_id`).

## How to check

`npm test -w @termhub/server -- start-agent.e2e` (real tmux): the fake `claude` prints the real dialog
screen, waits for Enter, and must print `fake-claude answering=[…]` with no one touching the tab. In the
app, link a new folder, start an agent there: the feed shows "Aba …: pasta do projeto confiada sozinha".
