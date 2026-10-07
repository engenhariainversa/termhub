---
symptom: "mobile chat: a new message scrolls the thread and flashes; the reader scrolled up loses their place"
tags: [mobile, react-native, flatlist, chat]
evidence: fixed
card: TER-1001
agent: claude
date: 2026-10-07
---
## Cause

Three things together, in `apps/mobile/src/features/chat/view/conversation-screen.tsx`:

- The thread is an **inverted** `FlatList`: the newest row is index 0, which is the *start* of the
  scroll content. A row coming in (or a row there growing: an answer streaming, a card changing state)
  adds height before everything on screen, so a reader scrolled up is pushed by that height. Without
  `maintainVisibleContentPosition` nothing compensates.
- A sent row is inserted as `local:<random>` and renamed to the server's id on the `202`. The list key
  was `m:${id}`, so the rename remounted the row: a flash.
- `MessageRow` wrapped the bubble in `SwipeToReply` only when the row was replyable, so the same rename
  also changed the tree shape inside the cell and remounted the bubble.

## Fix

- `maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}` on the
  list: offset 0 is the end in an inverted list, so the threshold is the "follow the end" margin.
- The renamed row keeps its first key in `row_key` (client-only field on `ChatMessage`); `mergeMessage`
  carries it over when the server's version replaces the row; `entryKey` prefers it.
- `SwipeToReply` takes `enabled`, and every message row is wrapped, so the tree does not change.

## How to check

`npm test -w @termhub/mobile -- src/features/chat` — the suite "the reading position holds when rows
arrive (TER-1001)" asserts no scroll call while scrolled up, the very same text element before and
after rows arrive or a send is accepted, and the `maintainVisibleContentPosition` prop. On a device:
scroll up, have the chat answer, and the visible line must not move.
