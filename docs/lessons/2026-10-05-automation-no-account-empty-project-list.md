---
symptom: "Automatic queue stuck on \"Sem conta com folga\" (no_account): automation on, machine allowed and online, two Claude accounts shown in the project Setup, no run ever starts"
tags: [automation, dispatcher, placement, ai-accounts, setup]
evidence: fixed
card: TER-985
agent: claude
date: 2026-10-05
---
## Cause

The dispatcher's `placeRun` only uses Claude accounts listed in the project's `ai.accounts`
(Setup → "Contas de IA e modelo"). In the termhub project that list was `[]`: the Setup card shows every
account of the linked machines, but the ones not in the list appear as unchecked options, which reads as
"the two accounts are there". With no candidate, every eligible card waited as `no_account`, and the reason
did not say that the list was empty, nor which machines and accounts had been looked at.

Ruled out on the way, read-only in the production database: hulk was `type agent`, agent 0.18.0, `claude`
in its capabilities, `automation_allowed` on, linked to the project; no row in `ai_account_exhaustions`.

## Fix

Configuration: check the accounts in "Contas de IA e modelo" and save. Code: `placeRun` now returns a
`detail` with each machine and account it left out and why (`not_listed`, `exhausted`, `busy` with the
peak, `taken`, `machine_no_room`; machines `offline`, `no_worktree`, `no_claude`, `not_allowed`,
`not_agent`, `no_room`), and the queue appends it to `reason_text`
(`automation/waiting-text.ts`). The runbook lists the account list as a prerequisite.

## How to check

`list_automation_queue` on the project: a waiting card reads, for example, "Sem conta com folga: nenhuma
conta escolhida em Setup → Contas de IA e modelo; máquina jarvis: não aceita trabalho automático; conta
Claude (hulk): fora das contas do projeto no Setup". In the database:
`select data->'ai' from project_setups where project_id = '<id>'` (read-only).
