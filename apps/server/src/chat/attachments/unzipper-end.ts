import { createRequire } from 'node:module';

/**
 * exceljs's streaming `WorkbookReader` walks the archive through `unzipper.Parse`, whose constructor
 * emits `'end'` on its own `'finish'` (unzipper 0.10.14, still so in 0.12.5). `'finish'` is the
 * writable side: it comes when the parser reaches the end record, which can be before the reader
 * has taken the entries it already pushed. Small entries fit in their streams' buffers, so the
 * parser runs ahead while exceljs is busy elsewhere (copying a worksheet to a temp file because
 * `sharedStrings.xml` comes after it, or reading a sheet's rows); exceljs then sees `'end'` with the
 * rest still buffered, and loses it. A workbook lost `xl/workbook.xml` (a TypeError on `sheets`, or
 * the sheet named "Sheet1") or whole sheets, depending on timing: about one parse in four on macOS,
 * rarer on Linux (TER-475).
 *
 * Dropping that listener leaves the readable side to end the ordinary way: `Parse` pushes `null`
 * at the end record, and `'end'` follows once the buffered entries were read. A parse that never
 * reaches an end record would no longer end by itself, which `guardZip` rules out (the walk must
 * be the directory, up to the end record) and the worker's timeout backs up.
 */
type ParseStream = NodeJS.EventEmitter;
type UnzipperModule = { Parse: (opts?: unknown) => ParseStream };

/** The listener, by its body. */
const EARLY_END = /emit\(\s*['"]end['"]\s*\)/;
/** Where `Parse` adds it. */
const SOURCE = /on\(\s*['"]finish['"]\s*,\s*function\s*\(\)\s*\{\s*self\.emit\(\s*['"]end['"]\s*\)/;
let installed = false;

/** Patches the `unzipper` instance exceljs loads, once. True when every `Parse` gets the fix: false
 *  means unzipper changed shape and the patch stood down (the tests then fail, by design). */
export function fixUnzipperEarlyEnd(): boolean {
  if (installed) return true;
  const fromExceljs = createRequire(createRequire(import.meta.url).resolve('exceljs'));
  const unzipper = fromExceljs('unzipper') as UnzipperModule;
  const parse = unzipper.Parse;
  // The constructor's own source: building a probe would start it pulling.
  if (!SOURCE.test(String(parse))) return false;
  unzipper.Parse = function patchedParse(this: unknown, opts?: unknown) {
    const stream = parse.call(this, opts);
    for (const listener of stream.listeners('finish')) {
      if (EARLY_END.test(String(listener))) stream.removeListener('finish', listener as (...args: unknown[]) => void);
    }
    return stream;
  };
  installed = true;
  return true;
}
