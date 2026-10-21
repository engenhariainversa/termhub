---
symptom: "The first message typed in the app's \"Nova sessão\" does not show in the new session's conversation"
tags: [mobile, tab-chat, websocket, race]
evidence: fixed
card: TER-1107
agent: claude
date: 2026-10-21
---
## Cause

A race between two reads that do not know about each other. The session screen opens right after
"Iniciar", before the agent's hooks have reported its session, so the page comes back `no_session` with
no `live` cursor and the socket joins with none. When the session is reported, two things happen in no
fixed order: the hub (`apps/server/src/tab-chat/hub.ts`) places a socket without a cursor at the **end**
of the transcript on its next pass, and the phone, told by a `state`/`hello` frame that the tab is
readable, reads the page again (TER-1091). When the page is read before the prompt reaches the file and
the hub places its cursor after it, the prompt comes neither with the page nor over the socket.

## Fix

The phone's tab chat store (`createTabChatStore.ts`, `reread`): on turning readable it closes the
socket, reads the page again and reopens the socket from **that page's** `live` cursor, so the server
reads forward from exactly where the page ended. A socket opened by a reread only reloads the page on a
`hello` that says ready, so a session whose file is missing (ready on the hello, `no_session` on the
page) cannot reopen the socket in a loop. The web's `use-tab-chat.ts` has the same pattern and the same
race; it was left as it was.

## How to check

`npm test -w @termhub/mobile -- src/features/tab-chat` ("turning readable follows the socket again from
the re-read page's cursor"). On a phone: start a session from "Nova sessão"; the message shows as
"Enviada" at once and stays in the conversation once the agent picks it up.
