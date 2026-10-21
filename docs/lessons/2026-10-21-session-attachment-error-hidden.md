---
symptom: "Mobile session attachments always show 'Could not send the file' instead of the upload failure reason"
tags: [mobile, tab-chat, attachments, upload, errors]
evidence: fixed
agent: chatgpt
date: 2026-10-21
---
## Cause

The session screen caught every error from `uploadFile` and replaced it with `TAB_FILE_FAILED`.
This discarded the `ApiError` status, code and localized message, hiding both image and audio
upload refusals. Successful upload tests used the mock transport and did not exercise native uploads.

## Fix

Rethrow `ApiError` unchanged and keep the generic message only for unclassified failures.
Cover image and audio errors followed by a successful retry in `session-screen.test.tsx`.
Test `FetchTransport.upload` separately, including raw bytes, signed headers, progress,
HTTP refusals and cancellation. It uses the legacy native upload API in the foreground,
avoiding the newer File upload SharedObject and background scheduling of short-lived DPoP proofs.

The reported device failure was not reproduced locally: no corresponding upload reached the
server in the inspected interval. Native compatibility is a hypothesis, not a confirmed root cause;
successful image and audio uploads must still be checked on the affected phone after updating.

## How to check

Run the mobile `transport.test.ts` and `session-screen.test.tsx` suites. A server refusal appears
verbatim on both attachment kinds, retry succeeds, and no message is sent before upload succeeds.
