---
symptom: "TypeError: Cannot read properties of undefined (reading 'sheets') at WorkbookReader._parseWorksheet"
tags: [attachments, xlsx, exceljs, unzipper, flaky-test, macos]
evidence: fixed
card: TER-475
agent: claude
date: 2026-10-07
---
## Cause

Not a macOS problem and not a test problem: exceljs's streaming `WorkbookReader` loses zip entries
at random. It walks the archive through `unzipper.Parse`, whose constructor does
`self.on('finish', () => self.emit('end'))`. `'finish'` is the writable side, reached at the zip's
end record, while entries the parser already pushed can still sit in its paused readable buffer.
Small entries fit in their own stream buffers, so the parser runs to the end record without
waiting for anyone. exceljs pauses the walk to copy a worksheet to a temp file (it does that
whenever `sharedStrings.xml` comes after the sheet, which is how both Excel and exceljs write a
workbook) or while the caller reads a sheet's rows. It then sees `'end'` and stops, and what was
still buffered is gone: `xl/workbook.xml`, which gives the TypeError on `sheets` or a sheet named
"Sheet1", or whole sheets of a multi-sheet file.

The race depends on timing: about 25% of parses of a one-sheet file on a Mac and 60% of a
three-sheet file, rarer on Linux CI. In production it turned valid spreadsheets into
`ATTACHMENT_INVALID` or dropped sheets. The bug is still in unzipper 0.12.5.

Handing the reader an input stream that never ends does not help: `Parse` ends itself at the
end record.

## Fix

`apps/server/src/chat/attachments/unzipper-end.ts` removes that one `'finish'` listener from every
`Parse` (patched on the `unzipper` instance exceljs loads, once, when `parsers.ts` loads). The
readable side then ends normally: `Parse` pushes `null` at the end record, and `'end'` comes only
after the buffered entries are read. `guardZip` already requires the walk to reach an end record, and
the worker's timeout covers anything else.

## How to check

`npx vitest run src/chat/attachments` in `apps/server` on Node 22, several times in a row: no
failures. `unzipper-end.test.ts` parses a three-sheet workbook 40 times, and checks that the patch
still finds the listener, so an unzipper upgrade that moves it fails in CI.
