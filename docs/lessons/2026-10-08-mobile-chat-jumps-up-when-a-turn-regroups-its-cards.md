---
symptom: "mobile chat (iOS): a new message makes the thread scroll a long way up, a whole answer's height"
tags: [mobile, react-native, flatlist, chat, maintainVisibleContentPosition]
evidence: fixed
card: TER-1057
agent: claude
date: 2026-10-08
---
## Cause

A regression of TER-1001 (`2026-10-07-mobile-chat-jumps-and-flashes-on-new-message.md`), once TER-1024
started moving and regrouping the newest rows of the inverted thread in
`apps/mobile/src/features/chat/view/conversation-screen.tsx`.

`maintainVisibleContentPosition` was on all the time. On iOS (Fabric, RN 0.86,
`RCTScrollViewComponentView.mm`) it anchors on a *native view*, not a key: before each mount it takes
the first subview of the content view that is on screen, and after the mount it adds that view's move to
`contentOffset` (then animates back to 0 when the old offset was within `autoscrollToTopThreshold`).
The source says it itself: `// TODO: detect and handle/ignore re-ordering`. At the end of the thread the
anchor is the newest row — exactly the rows a turn reshuffles:

- a decided card moves from below its answer to above it (TER-1024): the anchor moves by the answer's
  height, and the thread is pushed that far up;
- a second settled card folds the first into an accordion, and the list key changed (`a:<id>` →
  `t:<id>`): the anchor's cell is unmounted, its view recycled somewhere else, and the "move" is garbage.

## Fix

- The anchoring is only on while the reader is scrolled up past `NEAR_END` (`reading` state, flipped in
  `onScroll` and by `toEnd`). At the end an inverted list needs no help: offset 0 stays the end, and
  the newest rows are free to move. Scrolled up, the anchor is an older row the turn does not touch.
- A card, a pending group and a turn's accordion share their first card's key (`a:<id>`), so folding
  or a group shrinking keeps the cell mounted.

## How to check

`npm test -w @termhub/mobile -- src/features/chat/view/conversation-screen` — the TER-1057 cases assert
the prop is off at the end and on past 80 px, and that a card folding into the accordion and a new
message arriving keep every list key and call no scroll. On a device: at the end of the concierge chat,
let a turn run several gated calls and answer; the thread stays at its end, no jump up.
