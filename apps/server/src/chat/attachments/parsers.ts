import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText as pdfExtractText } from 'unpdf';
import { inflatedBytes, readZipDirectory, zipExpandedBytes } from './zip.js';
import { ExtractError } from './errors.js';
import { fixUnzipperEarlyEnd } from './unzipper-end.js';

// Before any workbook is read: without it the streaming reader loses entries at random (TER-475).
fixUnzipperEarlyEnd();

/**
 * What the concierge will be able to read of a file (spec 2026-09-26 §5.4). Every parser treats
 * its input as hostile: a ZIP is measured before it is opened, a throw or a hang is an invalid
 * attachment, and the output is capped. Nothing here logs: the caller logs metadata.
 */
export const TEXT_CAP = 200_000;
export const ZIP_EXPANDED_MAX_BYTES = 200 * 1024 * 1024;
export const XLSX_MAX_ROWS = 500;
export const XLSX_MAX_COLS = 50;

export interface Extracted {
  text: string | null;
  meta: Record<string, unknown>;
}

/** mammoth's typings stopped declaring convertToMarkdown; the runtime (1.12.x) still has it. */
const convertToMarkdown = (mammoth as unknown as { convertToMarkdown: typeof mammoth.convertToHtml }).convertToMarkdown;
/** Images inside a document are dropped: an empty `src`, and the leftover `![]()` is stripped. */
const NO_IMAGES = mammoth.images.imgElement(async () => ({ src: '' }));
/** The streaming reader's typings stop short of the sheet name it does set from `xl/workbook.xml`. */
type NamedSheet = { name?: unknown };

export const capText = (text: string): { text: string; truncated: boolean } => (text.length > TEXT_CAP ? { text: text.slice(0, TEXT_CAP), truncated: true } : { text, truncated: false });

/**
 * The directory's claim is checked first (free), then the local headers are walked the way exceljs's
 * streaming reader walks them — they must be exactly the directory's entries — and every entry is
 * really inflated and counted against the same budget (`inflatedBytes`). Otherwise a docx/xlsx whose
 * directory under-declares a highly compressible entry, or leaves an entry out of the directory
 * altogether, would be inflated whole by JSZip (mammoth) or unzipper (exceljs) — ~1000× the upload,
 * on a host shared with production.
 */
async function guardZip(file: Buffer, budget: number): Promise<void> {
  const entries = readZipDirectory(file);
  if (!entries) throw new ExtractError('ATTACHMENT_INVALID', 'not a zip');
  if (zipExpandedBytes(entries) > budget) throw new ExtractError('ATTACHMENT_INVALID', 'zip too large when expanded');
  const measured = await inflatedBytes(file, budget);
  if (!measured.ok) throw new ExtractError('ATTACHMENT_INVALID', `zip refused: ${measured.reason}`);
}

async function fromPdf(file: Buffer): Promise<Extracted> {
  const r = await pdfExtractText(new Uint8Array(file), { mergePages: false });
  const joined = r.text.map((page, i) => (i === 0 ? page.trim() : `--- página ${i + 1} ---\n\n${page.trim()}`)).join('\n\n');
  const c = capText(joined);
  return { text: c.text, meta: { pages: r.totalPages, truncated: c.truncated } };
}

async function fromDocx(file: Buffer, zipBudget: number): Promise<Extracted> {
  await guardZip(file, zipBudget);
  const r = await convertToMarkdown({ buffer: file }, { convertImage: NO_IMAGES, externalFileAccess: false });
  const c = capText(r.value.replace(/!\[[^\]]*\]\(\)/g, '').trim());
  return { text: c.text, meta: { truncated: c.truncated } };
}

/** A cell as text: a formula gives its cached result, never the formula; rich text and links give their text. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const o = value as { result?: unknown; richText?: { text: string }[]; text?: unknown; error?: unknown };
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join('');
    if ('text' in o) return typeof o.text === 'string' ? o.text : cellText(o.text as ExcelJS.CellValue);
    if ('error' in o) return String(o.error);
    return '';
  }
  return String(value);
}
const escapeCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

async function fromXlsx(file: Buffer, zipBudget: number): Promise<Extracted> {
  await guardZip(file, zipBudget);
  // The streaming reader: sheets arrive one at a time and rows one at a time, so what is held is at
  // most the shared strings plus one sheet's first 500 rows — `Workbook#xlsx.load` held the whole
  // workbook (gigabytes for a 20 MB file) and blocked the event loop for seconds while at it. Rows
  // past the cap are drained, not kept: breaking out of the row loop would leave the rest of the
  // entry buffered in exceljs's stream iterator instead.
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([file]), { worksheets: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'cache', entries: 'ignore' });
  const sheets: { name: string; rows: number; cols: number }[] = [];
  const parts: string[] = [];
  for await (const ws of reader) {
    const grid: string[][] = [];
    let cols = 0;
    for await (const row of ws) {
      const n = row.number;
      if (n > XLSX_MAX_ROWS) continue;
      const width = Math.min(row.cellCount, XLSX_MAX_COLS);
      cols = Math.max(cols, width);
      const cells: string[] = [];
      for (let c = 1; c <= width; c++) cells.push(escapeCell(cellText(row.getCell(c).value)));
      // A row the sheet skipped keeps its (empty) line, the way the full load rendered it.
      while (grid.length < n - 1) grid.push([]);
      grid[n - 1] = cells;
    }
    const nameOf = (ws as unknown as NamedSheet).name;
    const name = typeof nameOf === 'string' ? nameOf : 'Planilha';
    sheets.push({ name, rows: grid.length, cols });
    const lines = [`## ${name}`];
    grid.forEach((cells, i) => {
      const padded = cells.concat(Array.from({ length: cols - cells.length }, () => ''));
      lines.push(`| ${padded.join(' | ')} |`);
      if (i === 0) lines.push(`| ${padded.map(() => '---').join(' | ')} |`);
    });
    parts.push(lines.join('\n'));
  }
  const c = capText(parts.join('\n\n'));
  return { text: c.text, meta: { sheets, truncated: c.truncated } };
}

/**
 * The three document parsers behind one call (spec 2026-09-26 attachment-extraction-worker §4.1).
 * Plain code that knows nothing about threads: `extract-worker.ts` runs it in a Worker, and the
 * in-thread tests call it directly.
 */
export type DocumentKind = 'pdf' | 'docx' | 'xlsx';

export function parseDocument(kind: DocumentKind, file: Buffer, zipBudget: number): Promise<Extracted> {
  switch (kind) {
    case 'pdf':
      return fromPdf(file);
    case 'docx':
      return fromDocx(file, zipBudget);
    case 'xlsx':
      return fromXlsx(file, zipBudget);
  }
}
