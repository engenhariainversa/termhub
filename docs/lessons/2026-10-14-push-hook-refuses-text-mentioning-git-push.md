---
symptom: "PreToolUse:Bash hook error: termhub: push so para a branch da run"
tags: [automation, hooks, bash, tests]
evidence: fixed
card: TER-1081
agent: claude
date: 2026-10-14
---
## Cause

In an automatic run, termhub's PreToolUse hook refuses any Bash command that mentions a `git push` it does
not recognise as the run's own push. It reads the command text, so a command that only *contains* the words
— a heredoc or `printf` appending test cases such as `'git push origin main'` to a file — is refused as if
it were pushing. Nothing ran.

## Fix

Write file content that mentions `git push` with the Edit/Write tools instead of a shell command (append by
editing the file's last lines). Keep Bash for commands that really run; the only push allowed is the one the
run's prompt names (`git push -u origin <run branch>`).

## How to check

The Edit/Write call succeeds and the test file contains the cases; the next Bash command (the test run) is
not refused.
