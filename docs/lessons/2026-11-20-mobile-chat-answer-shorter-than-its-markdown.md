---
symptom: "mobile chat (iOS): messages drawn over each other — a long markdown answer (headings and lists) runs under the next bubbles, its box ends mid-text, a thin vertical line crosses the thread"
tags: [mobile, react-native, yoga, markdown, chat, layout]
evidence: fixed
card: TER-1194
agent: claude
date: 2026-11-20
---
## Cause

Not a list or scroll bug, and not a regression of TER-1192: nothing that draws a message row had
changed since TER-1159. The answer's bubble in
`apps/mobile/src/features/chat/view/message-bubble.tsx` was sized to its content
(`self-start max-w-[92%]`), and `react-native-markdown-display` lays out every list item as a row
whose content is `flex: 1` (flex-basis 0).

Inside a container that shrinks to its content, Yoga with RN's default errata (`YGErrataAll`, the
"Compatibility" layout conformance in `YogaLayoutableShadowNode::resolveErrata`) takes the bubble's
width from the children that have a width of their own — the headings — while the `flex: 1` lists
are measured at another width. The result is a bubble narrower than it should be **and** shorter than
its text: the rest of the answer, a ```draft card's border included (the "vertical line"), is drawn
over the rows below. An answer that is only headings and lists (a ready-to-send draft, typically)
hits it; one with a long plain paragraph widens the bubble to the max and looks fine.

Reproduced with `yoga-layout@3.2.1` (bubble 361 pt wide parent, headings, lists, draft box), counting
nodes whose children reach past their own bottom:

| bubble | errata All (RN default) | errata None |
|---|---|---|
| `alignSelf: flex-start` + `maxWidth: 92%` (before) | narrow, **overflows** | narrow |
| `alignSelf: flex-start` + `width: 92%` (fix) | full width, no overflow | no overflow |

(Swapping the list content's `flex: 1` for `flexBasis: auto` fixed errata All but overflowed with
None: a fixed width is the fix that does not depend on Yoga's errata.)

## Fix

The answer's bubble has a fixed width, `w-[92%]`: every line is measured at the width it is drawn at.
A short answer now takes the same width as a long one. The person's bubble stays sized to its
content: it is plain `Text`, which Yoga measures consistently.

## How to check

`npm test -w @termhub/mobile -- src/features/chat/view/message-bubble` — "MessageBubble layout
(TER-1194)" asserts the fixed width, streaming included. Jest does not run Yoga, so on a device: an
answer made only of headings and bullet lists (or a ```draft of that shape) must fill the bubble's
width and end inside it. Any other Markdown rendered in a box that shrinks to its content can hit the
same thing: give that box a width.
