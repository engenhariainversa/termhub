---
symptom: "App: anexar arquivo na conversa de uma sessão sempre dá erro (\"Não foi possível enviar o arquivo.\"), e \"tentar de novo\" falha igual"
tags: [mobile, nginx, upload, deploy, tab-chat]
evidence: observed
card: TER-1105
agent: claude
date: 2026-10-21
---
## Cause

The phone talks to the landing host (`MOBILE_PUBLIC_URL`, `termhub.dev`), not to `app.termhub.dev`.
In `deploy/nginx/termhub.dev.conf.tmpl`, everything under `location /api/m/` is capped at
`client_max_body_size 64k`; only `/api/m/v1/chat/attachments` and `/api/m/v1/transcriptions` had their
own locations with large caps. The session file route `POST /api/m/v1/tabs/:id/chat/files` (20 MB in
the server) had none, so nginx answered `413` with an HTML body to any file over 64 KB — every photo —
before the request reached the app. Nothing showed in the app's logs, and the route's tests (Fastify
`inject`, no proxy) passed. The app turned every error into the same generic text, which hid the 413.

## Fix

A `location ~ ^/api/m/v1/tabs/[^/]+/chat/files$` on the `termhub.dev` server with
`client_max_body_size 20m`, `proxy_request_buffering off` and `proxy_read_timeout 120s` (a regex
location wins over the `/api/m/` prefix). `apps/server/src/mobile/nginx-vhost.test.ts` now checks that
every phone upload path resolves to a location whose cap covers the server's limit: a new upload route
must get its own location there. The app now shows the real reason (`tabFileFailureText`).

## How to check

After the deploy, attach a photo (a few MB) in a session's conversation in the app: the chip goes to
"enviado" and the path reaches the tab. On jarvis, the rendered vhost has the new location:
`grep -n 'chat/files' /mnt/hd2tb/proxy/nginx/conf.d/termhub.dev.conf`. A refusal from the machine is
logged as `tab chat: file not saved` with its status and code.
