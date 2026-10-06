---
symptom: "Automatic run escalated permission_needed seconds after starting, on `grep`/`rg` (\"This command requires approval\" or \"Multiple directory changes in one command require approval\")"
tags: [automation, permissions, claude-code]
evidence: observed
card: TER-989
agent: claude
date: 2026-10-06
---
## Cause

Two things together. An automatic tab starts Claude Code with `acceptEdits` and a closed `--allowedTools`
list that had git, npm and `gh pr` rules but no read command (`grep`, `rg`, `find`, `cat`…), so the agent's
very first search asked for permission. And the machine's hook forwards only the tool name of a
`PermissionRequest`, never the command, so the server cannot judge a Bash request and escalates every one
(`answerPermissionAutomatically`). A command with two or more `cd` asks regardless of any allow rule: that is
a Claude Code check, not a missing rule; so are a `( … )` group ("A group in parentheses in this command
can't be checked before it runs") and a command too long for its parser, such as a big heredoc script
("Parser aborted (timeout, resource limit, or over-length)").

## Fix

`AUTOMATION_READ_TOOLS` (`apps/server/src/control/automation-tools.ts`) is now part of every automatic
tab's allow list through `automationAllowList`, on top of the project's list, so Claude Code runs reads
without asking and no card opens. The options of those commands that run a program or write a file
(`find -exec/-delete`, `rg --pre`, `git grep -O`, `git show --ext-diff/--output`, `sort -o`) went into the
fixed deny list. The run prompt (`SHELL_LINE`) tells the agent to run one simple command at a time: no several `cd`, no
`( … )` groups, no long heredoc scripts (Edit/Write change files).

## How to check

`list_automation_events` for the project: a new run reaches `pr_opened` without a `run_escalated`
`permission_needed` in its first minutes. In the tab, `ps` the claude process and check that
`'Bash(rg:*)'` is in its `--allowedTools`.
