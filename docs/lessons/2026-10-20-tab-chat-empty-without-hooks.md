---
symptom: "App: a tab's conversation opens with no history (\"Nenhuma mensagem ainda\") although Claude is working in the tab"
tags: [mobile, tab-chat, hooks, transcript]
evidence: fixed
card: TER-1091
agent: claude
date: 2026-10-20
---
## Cause

A tab's conversation (the app's Sessões, the web's tab chat) has no history of its own: the server reads the
Claude Code transcript of the tab's **current session** on the machine, found through `tabs.agent_session_id` /
`agent_transcript_path`, which only the termhub hooks report (`monitor/ingest.ts`, `noteClaudeSession`). So it
starts empty, and legitimately so, when:

- the machine never had the hooks installed (no `machine_hooks` row): no session is ever reported;
- the hooks are there but Claude has not reported yet (not started in the tab, or started before the hooks:
  Claude Code reads its hooks when it starts);
- the session's transcript is gone from the machine;
- the session is new (a new tab, a `/clear` or a restart of Claude): only the current session is shown.

The API answered `availability: no_session` with an empty page, and the screen showed the generic
"Nenhuma mensagem ainda", with only a small "Sem sessão do Claude nesta aba" line by the composer, so it read as
"history does not load". On top of that, when the session got reported while the screen was open, the socket
started following from the end of the file and the page was never read again: what the session already held stayed
off screen until the screen was reopened (app and web).

## Fix

`GET tabs/:id/chat` sends `empty_reason` (`no_hooks`, `not_reported`, `transcript_missing`, `new_session`); the app
shows why and offers "Instalar hooks" (`POST /api/m/v1/machines/:id/hooks`). App and web read the page again when
the tab turns `ready` while nothing was followed (`live === null`).

## How to check

Open, in the app, a tab on a machine without hooks: it says the machine has no termhub hooks, with the button.
Before debugging "no history" in a tab chat, look at the tab's `agent_session_id` and the machine's
`machine_hooks` row (metadata only, never the transcript).
