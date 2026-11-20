---
symptom: "iOS app: text copied as HTML pastes as mojibake in Teams/WhatsApp — \"👋\" → \"ðŸ‘‹\", \"✅\" → \"âœ…\", \"ç\" → \"Ã§\""
tags: [mobile, ios, clipboard, encoding, expo-clipboard]
evidence: fixed
card: TER-1193
agent: claude
date: 2026-11-20
---
## Cause

`Clipboard.setStringAsync(html, { inputFormat: StringFormat.HTML })` in expo-clipboard 57 (iOS,
`UIPasteboard+html.swift` / `NSAttributedString+utilities.swift`) builds an `NSAttributedString` from
`Data(htmlString.utf8)` with only `.documentType: .html`, no `.characterEncoding`. WebKit's HTML importer,
with no `<meta charset>` in the fragment, decodes the bytes as Windows-1252. The broken attributed
string then feeds every type it writes (public.rtf, public.html and public.utf8-plain-text), so even
apps that paste plain text (WhatsApp) get the mojibake. Android (`ClipData.newHtmlText`) keeps the Java
string and is not affected.

## Fix

Never hand non-ASCII HTML to expo-clipboard: `pasteboardHtml()` in
`apps/mobile/src/features/chat/view/draft-card.tsx` prefixes `<meta charset="utf-8">` and writes every
code point above 0x7F as `&#x…;` (by code point, not UTF-16 unit, so emoji stay one reference). JS only,
ships over the air.

## How to check

`draft-card.test.tsx` asserts the HTML is ASCII-only, declares UTF-8 and carries `&#x1f44b;` for 👋. On a
phone: copy a "Mensagem pronta" draft with accents and emoji and paste it into Teams, WhatsApp and Notes.
