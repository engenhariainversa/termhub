---
symptom: "The Claude account \"Claude\" hit its usage limit and resets at 11:10. No other Claude account on this machine has usage left right now. — on every message of a project chat, even after reordering the project's AI accounts"
tags: [chat, account-swap, usage-limit, project-setup, claude]
evidence: fixed
card: TER-1144
agent: claude
date: 2026-10-28
---
## Cause

A project chat ran on the machine of the person's **account-wide** chat (`chat_conversations.machine_id`
of the account-wide row, here jarvis), whatever the project's Setup said. `resolveHost` only filtered the
project's account list down to *that* machine, so accounts listed on hulk or capitão américa were never
candidates, and moving an account to the top of the Setup changed nothing unless it lived on that machine.
On a usage limit, `LimitFallback` / `pickFallback` also looked only at the same machine, so the chat
answered "No other Claude account on this machine" while the project listed accounts with room elsewhere.
Every account was labelled "Claude", so the notice also looked like it blamed the wrong one.

The server log showed it: `chat: usage limit, no account to fall back to { machine_id: <jarvis>, account:
<the jarvis "Claude">, fallback: 'none_free' }` for every message, on old and new conversations alike.

## Fix

- `resolveHost` (project chats): the account is the first of the project's Claude accounts, in Setup
  order, across every linked machine whose agent is online, skipping accounts that just met their limit
  (`markLimited`, in-process, until `resets_at`). The machine is that account's machine. The account-wide
  host only decides when the project lists none that can run.
- `LimitFallback`: with no account left on the run's machine, a project chat moves to the project's next
  account on another online machine (`pickProjectElsewhere`), on a fresh session, switching the runner.
  The project's list counts as the opt-in, so `claude_auto_swap` does not block a project chat.
- A project chat on its own account no longer pins the account-wide host machine.
- Notices name the account with its machine (`Claude · jarvis`).

## How to check

`npx vitest run src/chat/host.test.ts src/chat/service.test.ts` in `apps/server` (tests named TER-1144).
In production, the log shows `chat: usage limit, answering on another account` with a `to_machine`
different from `machine_id`, and the project chat answers.
