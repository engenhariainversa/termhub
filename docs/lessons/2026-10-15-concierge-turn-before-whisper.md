---
symptom: "Seu áudio novo ainda está sendo transcrito ... Mande qualquer mensagem curta (um \"ok\" basta) que eu tento de novo."
tags: [chat, concierge, attachments, whisper, transcription]
evidence: fixed
card: TER-1085
agent: claude
date: 2026-10-15
---
## Cause

A chat message starts the concierge's turn as soon as it is stored, but an audio attachment is only
transcribed afterwards, by the in-process extraction queue (`chat/attachments/queue.ts`, one job at a
time, whisper on the CPU). An audio-only message therefore reached the model as "áudio (ainda
processando)", `read_attachment` answered "tente de novo em alguns segundos", and once the turn gave up
nothing ever woke the concierge again: only the person's next message did. Short clips are no exception —
the queue serialises jobs and whisper may still be loading its model.

## Fix

`ChatService` (TER-1085):

- `holdForTranscript`: a message of audio alone with a pending transcript stores and shows the question,
  then waits (at most `TRANSCRIPT_HOLD_MS`, 2 min) before the turn starts; its answer row is written only
  then. The queue's `onDone` (app.ts) calls `chat.transcriptSettled(row)` to end the wait.
- A ready transcript goes inline in the run text (`attachmentContext`, between the data markers).
- A run told "transcrição ainda em andamento" notes the attachment (`lateTranscripts`); when it settles,
  `deliverLateTranscript` wakes the conversation with the transcript (or the failure), no "ok" needed.

## How to check

`npx vitest run src/chat/service.test.ts -t "TER-1085"` in `apps/server`. In the app: send an audio alone;
the bubble says "transcrevendo…", then "pensando…" appears and the answer is about what was said.
