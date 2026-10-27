---
symptom: "PreToolUse:Bash hook error: termhub: push so para a branch da run (after run_done, or a push that went through when it should not have)"
tags: [automation, guard, security, git, push]
evidence: fixed
card: TER-1111
agent: claude
date: 2026-10-22
---
## Cause

Two faces of the same bug in `termhub-guard` v2 (`packages/machine-ops/src/guard-script.ts`): it took the
Bash command as `CMD=${C%%'"'*}`, i.e. the JSON string cut at its first `"` — and the `\"` of a JSON escape
counts. Everything after the first quote was invisible to the rules.

- A dangerous command after a quote passed: `git commit -m "…" && git push -q`, `echo "x" && docker ps`,
  `… && gh pr merge`, a push to `main` after any quoted argument (STA-15 diagnosis, 22/10).
- A harmless command was denied with a reason that did not say why: `git push -u origin <branch> 2>&1 |
  tail -5` or a push chained after `git add && git commit` (with no quote before it) is not one of the four
  exact forms, so the agent read "push so para a branch da run" and invented a cause (wrong branch, missing
  permission) after the run had already reported `run_done`.

The allow list also offered `git -C <worktree> push …` and `git --no-pager push …` (`gitRuleForms`), forms the
guard never accepted.

## Fix

Guard v3 (agent 0.36.0, `GUARD_MIN_AGENT_VERSION`): an awk program (`GUARD_AWK`) decodes the whole `command`
string and splits it into simple commands, quotes and `$( )` included; every rule runs per command. The
run's push may be the last command of a chain, with `-q`, `2>&1` and `| tail -N`; the deny says the form it
takes. `gitRuleForms` gives no form to a push.

## How to check

`npx vitest run src/guard-script.test.ts --root packages/machine-ops`. On a machine:
`printf '%s' '{"tool_name":"Bash","tool_input":{"command":"echo \"x\" && docker ps"}}' | ~/.termhub/bin/termhub-guard b /w`
prints a `deny`; `head -2 ~/.termhub/bin/termhub-guard` says `v3`.
