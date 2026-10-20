---
symptom: "A voice note in English (or Spanish) comes back with an empty, garbled or Portuguese-translated transcript in the chat; whisper logs `lang pt` for it"
tags: [whisper, transcription, i18n, chat]
evidence: fixed
card: TER-1096
agent: claude
date: 2026-10-20
---
## Cause

Every transcription forced the language: `WHISPER_LANGUAGE` defaulted to `pt` in `apps/server/src/config.ts`
and `docker-compose.yml`, the server sent `?language=pt` on every `/transcribe`, and
`docker/whisper/server.py` also passed a Portuguese `initial_prompt`. faster-whisper told the language
does not detect anything: it decodes English speech as Portuguese, which gives an empty text, a
phonetic mess or a translation. The `language` field of the answer said `pt` because that is what it
was given, so nothing in the logs looked wrong. An empty result was then stored as a ready attachment,
so the bubble showed no transcript and no error.

## Fix

`WHISPER_LANGUAGE` defaults to `auto`. The service decodes once, runs VAD (silence answers
`no_speech` without the model), calls `model.detect_language`, and only when the detection is below
`WHISPER_DETECT_THRESHOLD` (0.6) lets the hints decide (`hints=` the client's `Accept-Language`, then
the account locale, then pt/en/es — `docker/whisper/lang.py`). An unsure pick that comes out empty is
retried in the other candidates, keeping the best `avg_logprob`. Each language uses its own style
prompt. A voice note with nothing heard fails as `TRANSCRIPTION_FAILED` / `meta.reason: no_speech`.
`task` is always `transcribe`, never `translate`.

## How to check

`docker logs termhub-whisper-1` shows `lang en, 1 pass(es)` for an English clip, and the chat bubble
reads "Ver transcrição (inglês)" with the English text. `cd docker/whisper && python -m unittest`
covers the language choice. A self-hoster who wants the old behaviour sets `WHISPER_LANGUAGE=pt`.
