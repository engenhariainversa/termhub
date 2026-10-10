---
symptom: "Chat audio attachment shows \"falhou: transcrição indisponível\" right after upload; the concierge gets no transcript"
tags: [whisper, deploy, env, secrets, transcription, attachments]
evidence: observed
card: TER-1035
agent: claude
date: 2026-10-07
---
## Cause

TER-585 (#418) made the whisper service require a shared bearer secret (`WHISPER_SECRET`): an empty
secret makes the service refuse every `/transcribe`, and the server turns transcription off
(`config.transcription` is null) when `WHISPER_URL` is set without `WHISPER_SECRET`. The compose
default is empty (`${WHISPER_SECRET:-}`), and production's `.env` only lives on jarvis, where nobody
added the new variable. The same deploy recreated the whisper container and started the new app
colour, so voice transcription went off in production: every audio attachment failed at once with
`TRANSCRIPTION_UNAVAILABLE` ("whisper is not configured", not retried), and the terminal mic
disappeared. The only trace in the server log is the boot warning
`AVISO: WHISPER_URL sem WHISPER_SECRET: a transcrição de voz fica desligada…`.

General form: a release that makes an env variable mandatory, with "empty = feature off" as the
default, silently turns the feature off wherever the operator did not edit the `.env`.

## Fix

- `deploy/ensure-secrets.sh "$ENV_FILE" WHISPER_SECRET` runs in `deploy.yml` before whisper and the
  app are recreated: it generates a random value when the variable is missing or empty, keeps an
  existing one, and never prints it. Both containers read the same `.env`, so they agree.
- When a PR makes a secret mandatory, add its name to that step in the same PR.
- The attachment now stores why (`meta.reason`: `not_configured`, `refused`, `unreachable`, `error`),
  the bubble says it, and "tentar de novo" (`POST /chat/attachments/:id/retry`) re-queues it once
  the server is fixed. Whisper out of reach is retried by the queue (a deploy recreating it).

## How to check

- Deploy log: the step "Shared secrets" prints `WHISPER_SECRET already set` (or `… generated`).
- Server log on boot: `voice transcription enabled`, and no `WHISPER_URL sem WHISPER_SECRET` warning.
- Send an audio in the chat: the attachment goes `transcrevendo…` then ready, and `read_attachment`
  returns the transcript.
