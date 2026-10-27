---
symptom: "Codex tab shows \"has not reported its session\" and an empty conversation while Codex answers on screen; another tab (even of another project) gets its state and messages"
tags: [codex, hooks, monitor, tab-chat, tmux]
evidence: fixed
card: TER-1118
agent: claude
date: 2026-10-27
---
## Cause

Codex 0.16x (seen with 0.164.0 on macOS) has a shared local app-server daemon
(`codex app-server --listen unix:// --managed-daemon`, under `~/.codex/packages/app-server-daemon`).
A `codex` typed in a shell attaches to it when it is running (`daemon_selection_reason` `existing_daemon`),
and then the **daemon** runs the hooks and `notify`, not the TUI in the tab. The hook script inherits the
daemon's environment: `TMUX_PANE` is the pane the daemon was first started from, days earlier, and
`tmux display-message -t "$TMUX_PANE"` named that tab's session. So every event of the new tab was posted
for the old one (here a tab of another project, "June", which showed "Tudo certo!" from the termhub tab),
and the tab that ran Codex never got `state_tool`, `agent_session_id` or a transcript path.

Codex started by termhub (`start_agent`, "Iniciar sessão") was not affected: its `-c mcp_servers…` options
and initial prompt are `incompatible_option` for the daemon, so it runs in process and its hooks have the
tab's own `TMUX_PANE`. That is why one Codex tab on the same machine worked and the other did not.

What gave it away: `ps -E` on the TUI showed the right `TMUX_PANE`, but `~/.codex/logs_2.sqlite` logged
`thread/start` over `unix_socket` and `hook/started` from the daemon, `lsof` showed the daemon (not the
TUI) holding the rollout file, and `ps -E` on the daemon showed another pane's `TMUX_PANE`.

## Fix

The hook script (`HOOK_SCRIPT`, agent 0.36.0) no longer takes `$TMUX_PANE` at its word for Codex: the
event is the pane's only when the pane's shell is one of the script's ancestors (one `ps -A` read in awk).
Under the daemon it uses the pane already bound to the event's Codex session (`session_id`, or notify's
`thread-id`), or else the only `termhub-*` pane whose foreground Codex runs in the event's `cwd` and is
not held by another live Codex session. The binding is a file per tmux session under `TMPDIR`
(`termhub-codex-<session>`: `<codex session> <codex pid> <tmux session>`), also written by in-process
events. When it cannot tell (two free panes in the same folder, no folder), it drops the event rather
than post it under the wrong tab. A Codex running in a terminal outside tmux is dropped as before.

`codex --no-daemon` keeps a Codex out of the daemon, if it ever needs to be ruled out by hand.

## How to check

With the agent on 0.36.0 (it rewrites the script on reconnect), type `codex` in a termhub tab while
`ps -ax | grep 'codex app-server'` shows the daemon, and send a prompt: the tab goes working/finished and
its conversation shows the prompt and the answer; no other tab changes state.
