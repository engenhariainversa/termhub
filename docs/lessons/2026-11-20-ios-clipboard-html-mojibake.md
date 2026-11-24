---
symptom: "iOS app: text copied as HTML pastes as mojibake in Teams/WhatsApp — \"👋\" → \"ðŸ‘‹\", \"✅\" → \"âœ…\", \"ç\" → \"Ã§\""
tags: [mobile, ios, clipboard, encoding, expo-clipboard]
evidence: fixed
card: TER-1193, TER-1200
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

## Which copy paths are affected (TER-1200)

Only the HTML path. The long-press "Copiar" of a chat row (`services/clipboard.ts`) and the code block's
copy write plain text (`UIPasteboard.general.string`), and the finger selection of a `selectable` Text
writes RTFD and plain text straight from the attributed string in memory (React Native's
`RCTParagraphComponentView copy:`): none of them re-reads bytes. A report of "the copy is still broken"
came back because this fix sat in a draft PR (#607) that was never merged, so no OTA carried it: when a
fix is reported as not working, check first that it reached `main` (`git grep <symbol> origin/main`).

## How to check

`draft-card.test.tsx` reads the HTML as Windows-1252, resolves the references and expects the draft
as shown (👋 → “ ” 🙏 and accents); it also asserts the HTML is ASCII-only, declares UTF-8 and carries `&#x1f44b;` for 👋. On a
phone: copy a "Mensagem pronta" draft with accents and emoji and paste it into Teams, WhatsApp and Notes.
