---
symptom: "Automatic run escalated permission_needed about a minute after starting, on `git -C <worktree> log --oneline -1` (\"This command requires approval\")"
tags: [automation, permissions, claude-code, git]
evidence: fixed
card: TER-991
agent: claude
date: 2026-10-07
---
## Cause

Claude Code matches a Bash allow rule against the command's text. `Bash(git log:*)` covers `git log …` but
not `git -C /…/worktrees/<project>/TER-903 log …` or `git --no-pager log …`: the global options come before
the subcommand, so the prefix differs. Agents often add `-C <worktree>` even though the tab's cwd already is
the worktree. A project rule like `Bash(git -C:*)` would not help: it is refused on purpose
(`unsafeAllowedTool`), since `git -C x push` reaches any push.

Adding the forms naively also has a size trap: an exited agent is brought back with a resume line typed
whole into the tab, under the 4000-character input cap, and on 2026-10-07 that line already used 3712 of
the 3850 characters the test allows. Every form rule carries the worktree path (about 70 characters), so
none of them fits there.

## Fix

`gitRuleForms` (`apps/server/src/control/automation-tools.ts`) turns every git rule of the tab's allow list
into `git --no-pager <sub>` and `git -C <worktree> <sub>` (the path as is, with a trailing `/` and as `.`,
with `--no-pager` on either side), only for the run's own worktree. The options that run a program or
write a file get the same forms in `AUTOMATION_FORM_DENIED_TOOLS`. The forms go on the lines that pass
through a launch file (start, account swap: `AgentPermission.worktree`); `resumeCommandFor` leaves them out
until TER-988 moves it to a launch file too. The run prompt (`SHELL_LINE`) says the cwd already is the
worktree, so `git -C` and `cd` are not needed, and not to use `sed -i` (seen on TER-976: Claude Code always
asks for it).

## How to check

`list_automation_events` for the project: a new run reaches `pr_opened` without an early `escalated`
`permission_needed`. In the tab, `ps` the claude process and look for `'Bash(git -C <worktree> log:*)'`
in its `--allowedTools`.
