# Tab state `finished`: the agent reported, it asks nothing (TER-972)

## Problem
Every Claude Code turn that ends without background work is recorded as `waiting_input`. A tab that
finished its work and closed with a plain report (TER-912: merge and deploy done, card in Feito) shows as
"esperando você", lights up "Precisa de você", and the concierge reads it as blocked on the person.

## Decision
- **New `TabState` value `finished`** (additive enum migration, as TER-644 did for `waiting_background`).
- **Classification** (`apps/server/src/monitor/turn-end.ts`, pure): a Claude main-thread `Stop` with no
  running background tasks becomes `finished` only when its whole last message reads as a report:
  - not blank;
  - no question mark in prose (code, inline code and URLs are ignored);
  - no request, offer, pending item or blocker in it ("Se quiser…", "Quer que…", "Posso…", "você
    precisa", "Pendências", "Para testar", "não consegui", "let me know", "should I", …).
  Anything else stays `waiting_input`: **in doubt, the tab keeps waiting for the person**.
- **Not covered:** Codex and Cursor (their turn-end pairing in `decideWait` is left as is) and the
  "card moved to Feito during the turn" signal (it needs the board inside the hook path; the text rule
  alone covers the acceptance criteria).

## Behaviour of a `finished` tab
| Where | Behaviour |
|---|---|
| needs you / push / "Precisa de você" | never counts, never alerts |
| `wait_for_state` | a stop: it returns (like `waiting_input`) |
| idle_prompt reminder a minute later | dropped (`reminder_after_finished`), the tab stays `finished` |
| subagent tool calls | dropped like during a wait (the tab is where its main thread is) |
| chat gate | typing into it is allowed as for `waiting_input`; `close_tab` by default allowance is allowed (a stopped tab) |
| suggestion cards | open as for `waiting_input` (the agent is at its prompt) |
| progress | counts as idle in the epic, `finished: true` on the agent |
| web / office / app | "concluído", green/neutral, never the orange of "esperando você" |

## Compatibility with older apps
`@termhub/mobile-api` keeps its `state` enum. The server sends `finished` as `state: 'idle'` with a new
`finished: true` field (default `false`) in `agentOnCard` and `tabSummary`. An app that predates it shows
"parado", never "esperando você".

## Impact on other users
Default for everyone, no setting: a Claude tab that ends with a plain report shows "concluído" instead of
"esperando você", is not in "Precisa de você" and does not alert. A tab whose last message asks, offers or
reports something pending stays "esperando você" as before. Older mobile apps show such tabs as "parado".
