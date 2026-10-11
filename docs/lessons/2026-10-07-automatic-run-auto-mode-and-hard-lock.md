# Automatic runs: Claude Code auto mode + a PreToolUse hard lock

**Date:** 2026-10-07
**Status:** verified

## What happened

In the first round of automatic board work (TER-852), every run asked the maintainer for 3 to 6 Bash
permissions, all approved by hand. The allow-list approach (`acceptEdits` + a list, TER-989/TER-991)
could not keep up: an autonomous run touches too many distinct commands. The maintainer's decision
(2026-10-07): release everything a run needs, block only what is dangerous.

## The fix (TER-993)

1. **Auto mode.** Automatic runs start with `--permission-mode auto` (`AUTOMATION_PERMISSION_MODE` in
   `apps/server/src/control/agents.ts`), so Claude Code's own classifier answers what no rule covers.
   The mode name was confirmed on Claude Code 2.1.292 (`claude --help`), and tested in an isolated
   tmux session: the mode starts with no consent dialog, and `--disallowedTools` keeps blocking in auto
   mode. A run started in `acceptEdits` takes `auto` on its next restart/resume (`runPermission`).
2. **Hard lock.** A PreToolUse hook (`GUARD_SCRIPT` in `@termhub/machine-ops`, installed by the agent
   0.19.0 at `~/.termhub/bin/termhub-guard`) denies the dangerous actions whatever the mode. It is
   scoped to automatic tabs by `--settings <per-tab guard.json>` on the launch line; manual and
   `start_agent` tabs (no worktree) never get it.

## Why a hook, not just `--disallowedTools`

Auto mode's one real gap is `git push`: the deny list can only block force/delete/mirror (an allow rule
cannot carve the run's own branch out of a blanket `git push` deny, since Claude Code reads deny before
allow). So in auto mode the classifier could, in principle, approve `git push origin main`. A PreToolUse
hook can express "allow only the run's own branch, deny every other push" — which glob rules cannot.

## Gotchas

- **Worktrees live under `~/.termhub/worktrees`.** A blanket `.termhub` deny in the guard wrongly blocked
  the worktree's own files. Narrow the credential rule to the real sensitive entries
  (`~/.termhub/config.json`, `hook.env`, `tabs/`), never the whole dir.
- **Absolute-path pre-checks over-fire.** A `case "$SQ" in *' /'[!t]*` meant to catch "a path outside
  /tmp" also matched the legitimate absolute worktree path. Judge absolute paths per token against the
  run's worktree ($2), not with a blanket pattern.
- Test the guard by running the real script under `sh` with crafted stdin/argv (as `hook-script.test.ts`
  does), one case per blocked item.
