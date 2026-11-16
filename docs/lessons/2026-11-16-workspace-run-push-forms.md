---
symptom: "push so para a branch da run: use exatamente git push -u origin <branch> como ultimo comando"
tags: [automation, guard, multi-repo, git, push]
evidence: fixed
card: TER-1065
agent: claude
date: 2026-11-16
---
## Cause

A multi-repo (workspace) run's tab opens at the workspace root, with one repository per `<key>/` folder.
The guard (v3, `packages/machine-ops/src/guard-script.ts`) only takes the run's push in two shapes there:
`git -C <absolute workspace>/<key> push -u origin <branch>`, or a plain `git push -u origin <branch>` with no
`cd` in the same command. Two forms an agent naturally writes are denied with the message above:

- `cd <key> && git push -u origin <branch>`: a relative `cd` in the push's command (`cdpush`); only an
  absolute `cd <workspace>/<key> && …` passes.
- `git -C <key> push -u origin <branch>`: the `-C` form must name the absolute path; the relative one only
  works for read commands (`git -C <key> status`), which the allow list covers.

## Fix

Push with the exact form the prompt gives (`pushLineMulti` in `apps/server/src/automation/prompts.ts`):
`git -C <workspace>/<key> push -u origin <branch>`. Or send `cd <key>` alone in one Bash call and
`git push -u origin <branch>` in the next one: Claude Code keeps the cwd between calls, and neither command
mixes a `cd` with the push.

## How to check

`npx vitest run --root packages/machine-ops src/guard-script.test.ts -t "workspace run"` covers every form
above against the real script.
