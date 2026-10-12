---
symptom: "PR escalated as \"CI still red after the fixer attempts\", but the branch head already has the fix and no check ran on it"
tags: [ci, github-actions, merge-conflict, automation]
evidence: fixed
card: TER-1014
pr: https://github.com/engenhariainversa/termhub/pull/419
agent: claude
date: 2026-10-08
---
## Cause

GitHub does not start `pull_request` workflows for a PR with merge conflicts: there is no merge ref to
build. On #419 the fixer pushed the real fix (`supersede.db.test.ts` updated to the TER-1014
`nearest(..., { place })` signature) after main had moved and the PR had become conflicting, so the
last check on the PR stayed the red one from the previous commit. The PR looked red after the fix.

## Fix

Merge `origin/main` into the branch (no rebase, no force-push), resolve the conflicts and push: CI then
runs on the merge commit. Here the merge also pushed the concierge prompt over its 8000-character cap
(main and the branch had each added a line), which `concierge-prompt.test.ts` caught. Three lines were
said more briefly, without dropping a rule.

## How to check

`gh run list --branch <branch> --limit 3 --json headSha,conclusion` against
`git rev-parse origin/<branch>`: when the newest run's `headSha` is not the branch head and
`gh pr view <n> --json mergeable` says `CONFLICTING`, the red check is stale. Resolve the conflict
first, then read `gh run view --log-failed`.
