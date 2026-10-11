---
symptom: "Approving a group of pending chat actions on the phone answers HTTP 429; the irreversible ones (close_tab) then reach the concierge as \"Recusou\", and the same call keeps answering \"O usuário recusou esta ação no chat\" after the person asks for it again"
tags: [chat, mobile, rate-limit, nginx, pin, gate, denial]
evidence: fixed
card: TER-530
agent: claude
date: 2026-10-01
---
## Cause

Three separate things lined up.

1. **The 429 came from the proxy, not the app.** Approving irreversible cards on the phone needs a PIN
   proof per action, and `requestPinProofs` asked `POST /api/m/v1/session/challenge` once per action,
   in a row. In `deploy/nginx/termhub.dev.conf.tmpl` that path shares the enrolment budget
   (`termhub_mobile_enrol`: 2 r/s, burst 5), because it is the anonymous entry point. A batch with 9
   `close_tab` + 1 more irreversible card got 429 from the sixth challenge on. The server's own
   limiters were never involved, which is why grepping the server for 429 finds nothing relevant.
2. **The refusals were real decisions, sent by the group card.** "Aprovar selecionadas" approves what is
   ticked and *denies what is not*. The ticks lived in the card's `useState`, and the card remounts
   whenever its list key moves (`g:<first pending id>`: a new pending card, a card brought back to the
   end of the thread). After the failed attempt the ticks fell back to the defaults (writes ticked,
   irreversible unticked), so the next tap approved the 3 `send_input` and denied the other 10.
3. **A denial kept refusing for 15 minutes regardless of what the person said next**
   (`DENIAL_HOLDS_MS` in `chat/gate-runtime.ts`). Telling "the model retrying" apart from "the person
   asking again" was not possible from the messages table: a decision's re-injection and a wake are
   stored as `role: 'user'` messages too.

## Fix

1. New authenticated route `POST /api/m/v1/chat/actions/challenges` (`decisionChallengesBody` in
   `@termhub/mobile-api`): every challenge of a batch in one call, under the ordinary mobile budget.
   The app uses it for batches and falls back to the old one-by-one calls on a 404.
2. The group card's ticks (web `ChatActionGroup`, app `ActionGroupCard`) are kept by action id outside
   the component, so a remount never resets them.
3. `chat_conversations.last_typed_at`, set only by `ChatService.start` (what the person typed). A
   denial decided before it no longer refuses on its own: the same call gets a fresh card.

## How to check

- `npx jest src/features/session/viewmodel/createSessionStore.test.ts` (apps/mobile): the 13-approval
  batch test fakes `session/challenge` answering 429 from the sixth call and still passes.
- `npx vitest run src/mcp/gate.e2e.test.ts` (apps/server, needs `DATABASE_URL`): "asks again, with a
  fresh card, when the person wrote after the denial".
- When a batch fails on the phone, look at the proxy log for `limiting requests` on `/api/m/v1/session/`
  before looking at the app.
