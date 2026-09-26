import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { buildZip, minimalDocx, minimalPdf, withUnlistedEntry } from '../../../test/zip.js';
import { ExtractError, TEXT_CAP, XLSX_MAX_COLS, XLSX_MAX_ROWS, extract, imageDimensions, withTimeout } from './extract.js';

const noWhisper = { whisperUrl: null, language: null };
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof ExtractError ? err.code : `other:${String(err)}`;
  }
};

describe('imageDimensions reads the header, never the pixels', () => {
  const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  it('PNG (IHDR)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(640), ...be32(480), 8, 6, 0, 0, 0]);
    expect(imageDimensions(png, 'image/png')).toEqual({ width: 640, height: 480 });
  });
  it('GIF (little-endian logical screen)', () => {
    expect(imageDimensions(Buffer.from([...Buffer.from('GIF89a'), 10, 0, 20, 0, 0, 0, 0]), 'image/gif')).toEqual({ width: 10, height: 20 });
  });
  it('JPEG (walks the segments to SOF0)', () => {
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 8, 0x00, 0x64, 0x00, 0xc8, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    expect(imageDimensions(Buffer.from([0xff, 0xd8, ...app0, ...sof0]), 'image/jpeg')).toEqual({ width: 200, height: 100 });
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toBeNull();
  });
  it('WebP VP8, VP8L and VP8X', () => {
    // Header, chunk tag, chunk size, then the payload padded to the 30 bytes the reader needs.
    const riff = (chunk: string, payload: number[]) => Buffer.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), ...Buffer.from(chunk), 0, 0, 0, 0, ...payload, ...new Array(Math.max(0, 12 - payload.length)).fill(0)]);
    // VP8: 3-byte frame tag, start code 9d 01 2a, then 14-bit width and height (little-endian)
    expect(imageDimensions(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]), 'image/webp')).toEqual({ width: 640, height: 480 });
    // VP8L: signature 0x2f, then width-1 (14 bits) and height-1 (14 bits) packed little-endian: 639 | 479 << 14
    const bits = 639 | (479 << 14);
    expect(imageDimensions(riff('VP8L', [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]), 'image/webp')).toEqual({ width: 640, height: 480 });
    // VP8X: flags, 3 reserved, then 24-bit width-1 and height-1
    expect(imageDimensions(riff('VP8X', [0, 0, 0, 0, 0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]), 'image/webp')).toEqual({ width: 640, height: 480 });
  });
  it('is null for an unknown mime or a truncated header', () => {
    expect(imageDimensions(Buffer.from('GIF89a'), 'image/gif')).toBeNull();
    expect(imageDimensions(Buffer.alloc(40), 'image/bmp')).toBeNull();
  });
});

describe('extract: image and text', () => {
  it('an image yields no text, only its size', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
    expect(await extract('image', png, 'image/png', noWhisper)).toEqual({ text: null, meta: { width: 2, height: 3 } });
  });
  it('text is decoded as UTF-8 and capped at 200 000 characters, saying so', async () => {
    expect(await extract('text', Buffer.from('olá\n'), 'text/plain; charset=utf-8', noWhisper)).toEqual({ text: 'olá\n', meta: { truncated: false } });
    const big = await extract('text', Buffer.from('a'.repeat(TEXT_CAP + 5)), 'text/plain; charset=utf-8', noWhisper);
    expect(big.text).toHaveLength(TEXT_CAP);
    expect(big.meta).toEqual({ truncated: true });
  });
});

describe('extract: pdf, docx, xlsx', () => {
  it('pdf: the page text and the page count', async () => {
    const r = await extract('pdf', minimalPdf('Relatorio anual'), 'application/pdf', noWhisper);
    expect(r.text).toContain('Relatorio anual');
    expect(r.meta).toEqual({ pages: 1, truncated: false });
  });
  it('pdf: garbage after the magic is an invalid attachment, not a crash', async () => {
    expect(await code(extract('pdf', Buffer.from('%PDF-1.4 garbage'), 'application/pdf', noWhisper))).toBe('ATTACHMENT_INVALID');
  });
  it('docx: markdown with the paragraphs', async () => {
    const r = await extract('docx', minimalDocx(['Olá mundo', 'Segundo parágrafo']), 'application/x', noWhisper);
    expect(r.text).toBe('Olá mundo\n\nSegundo parágrafo');
    expect(r.meta).toEqual({ truncated: false });
  });
  it('docx: a deflated document (the way Word writes one) extracts like a stored one', async () => {
    const r = await extract('docx', minimalDocx(['Olá mundo', 'Segundo parágrafo'], { deflate: true }), 'application/x', noWhisper);
    expect(r.text).toBe('Olá mundo\n\nSegundo parágrafo');
  });
  it('docx and xlsx: the guard measures the bytes an entry really inflates to, never what the directory claims', async () => {
    // A paragraph of 4 MB deflates to a few KB, and mammoth would extract it (capped) if the guard let it through.
    const big = 'a'.repeat(4 * 1024 * 1024);
    const budget = 1024 * 1024;
    const withBudget = { ...noWhisper, zipExpandedMaxBytes: budget };
    expect(await code(extract('docx', minimalDocx([big], { deflate: true }), 'application/x', withBudget))).toBe('ATTACHMENT_INVALID');
    // The directory says 100 bytes; the entry inflates to 4 MB. A generous budget does not save it: the claim is a lie.
    const lying = minimalDocx([big], { deflate: true, claimUncompressed: { 'word/document.xml': 100 } });
    expect(await code(extract('docx', lying, 'application/x', noWhisper))).toBe('ATTACHMENT_INVALID');
    // Under the budget and truthful: extracted, capped by TEXT_CAP.
    const fine = await extract('docx', minimalDocx([big], { deflate: true }), 'application/x', { ...noWhisper, zipExpandedMaxBytes: 8 * 1024 * 1024 });
    expect(fine.text).toHaveLength(TEXT_CAP);
    // xlsx goes through the same guard.
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('S').addRow(['x'.repeat(2 * 1024 * 1024)]);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    expect(await code(extract('xlsx', xlsx, 'application/x', withBudget))).toBe('ATTACHMENT_INVALID');
    expect((await extract('xlsx', xlsx, 'application/x', { ...noWhisper, zipExpandedMaxBytes: 8 * 1024 * 1024 })).meta).toMatchObject({ sheets: [{ name: 'S', rows: 1, cols: 1 }] });
  });
  it('xlsx: a local entry the directory does not list is refused before the streaming reader (which walks local headers) sees it', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('S').addRow(['x']);
    const genuine = Buffer.from(await wb.xlsx.writeBuffer());
    // 1 MB of shared strings deflates to a few KB, listed nowhere in the directory, so the directory-based guard counts nothing.
    const strings = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${'<si><t>aaaaaaaaaaaaaaaa</t></si>'.repeat(40_000)}</sst>`;
    const hidden = withUnlistedEntry(genuine, 'xl/sharedStrings.xml', strings);
    expect(hidden.length).toBeLessThan(genuine.length + 16 * 1024);
    const parse = vi.spyOn(ExcelJS.stream.xlsx.WorkbookReader.prototype, 'parse');
    try {
      expect(await code(extract('xlsx', hidden, 'application/x', { ...noWhisper, zipExpandedMaxBytes: 256 * 1024 }))).toBe('ATTACHMENT_INVALID');
      expect(parse).not.toHaveBeenCalled();
      // The same file without the extra entry is fine under that budget.
      expect((await extract('xlsx', genuine, 'application/x', { ...noWhisper, zipExpandedMaxBytes: 256 * 1024 })).meta).toMatchObject({ sheets: [{ name: 'S', rows: 1, cols: 1 }] });
    } finally {
      parse.mockRestore();
    }
  });
  it('docx and xlsx: an unlisted entry or bytes the directory does not account for are an invalid attachment', async () => {
    const docx = minimalDocx(['Olá'], { deflate: true });
    expect(await code(extract('docx', withUnlistedEntry(docx, 'word/extra.xml', 'x'.repeat(100)), 'application/x', noWhisper))).toBe('ATTACHMENT_INVALID');
    expect(await code(extract('docx', minimalDocx(['Olá'], { deflate: true, gapBeforeDirectory: 16 }), 'application/x', noWhisper))).toBe('ATTACHMENT_INVALID');
    expect(await code(extract('docx', Buffer.concat([docx, Buffer.from('trailing')]), 'application/x', noWhisper))).toBe('ATTACHMENT_INVALID');
    const xlsx = buildZip([['xl/workbook.xml', '<workbook/>'], ['xl/other.xml', 'x']], { deflate: true, unlisted: ['xl/other.xml'] });
    expect(await code(extract('xlsx', xlsx, 'application/x', noWhisper))).toBe('ATTACHMENT_INVALID');
  });
  it('docx and xlsx: entries written with data descriptors (streaming writers) still extract', async () => {
    const r = await extract('docx', minimalDocx(['Olá mundo'], { deflate: true, dataDescriptor: true }), 'application/x', noWhisper);
    expect(r.text).toBe('Olá mundo');
    // exceljs's own streaming writer goes through archiver, which writes every deflated entry with a data descriptor.
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(c));
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink });
    const ws = writer.addWorksheet('Fluxo');
    ws.addRow(['Item', 'Qtd']).commit();
    ws.addRow(['Café', 2]).commit();
    await writer.commit();
    const streamed = Buffer.concat(chunks);
    expect(streamed.readUInt16LE(6) & 8).toBe(8);
    const x = await extract('xlsx', streamed, 'application/x', noWhisper);
    expect(x.text).toBe('## Fluxo\n| Item | Qtd |\n| --- | --- |\n| Café | 2 |');
  });
  it('docx and xlsx: a ZIP that claims more than 200 MB expanded is refused before any parser runs', async () => {
    const bomb = minimalDocx(['x'], { claimUncompressed: { 'word/document.xml': 300 * 1024 * 1024 } });
    expect(await code(extract('docx', bomb, 'application/x', noWhisper))).toBe('ATTACHMENT_INVALID');
    const xlsxBomb = buildZip([['xl/workbook.xml', '<workbook/>']], { claimUncompressed: { 'xl/workbook.xml': 300 * 1024 * 1024 } });
    expect(await code(extract('xlsx', xlsxBomb, 'application/x', noWhisper))).toBe('ATTACHMENT_INVALID');
    expect(await code(extract('docx', Buffer.from('not a zip'), 'application/x', noWhisper))).toBe('ATTACHMENT_INVALID');
  });
  it('xlsx: one markdown table per sheet, cached results instead of formulas', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Vendas');
    ws.addRow(['Item', 'Qtd']);
    ws.addRow(['Café | leite', 3]);
    ws.addRow(['Total', { formula: 'B2*2', result: 6 }]);
    const r = await extract('xlsx', Buffer.from(await wb.xlsx.writeBuffer()), 'application/x', noWhisper);
    expect(r.text).toBe('## Vendas\n| Item | Qtd |\n| --- | --- |\n| Café \\| leite | 3 |\n| Total | 6 |');
    expect(r.text).not.toContain('B2*2');
    expect(r.meta).toEqual({ sheets: [{ name: 'Vendas', rows: 3, cols: 2 }], truncated: false });
  });
  it('xlsx: read through the streaming WorkbookReader, one row at a time, never a whole-workbook load', async () => {
    const streamed = vi.spyOn(ExcelJS.stream.xlsx.WorkbookReader.prototype, 'parse');
    // `Workbook#xlsx` is a getter that caches per instance: spy on the XLSX class behind it, not on the prototype's getter.
    const loaded = vi.spyOn(Object.getPrototypeOf(new ExcelJS.Workbook().xlsx) as ExcelJS.Xlsx, 'load');
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Gaps');
      ws.getRow(1).values = ['a', 'b'];
      ws.getRow(3).values = ['c']; // row 2 stays empty: the table keeps its place, as the full load did
      const r = await extract('xlsx', Buffer.from(await wb.xlsx.writeBuffer()), 'application/x', noWhisper);
      expect(streamed).toHaveBeenCalledTimes(1);
      expect(loaded).not.toHaveBeenCalled();
      expect(r.text).toBe('## Gaps\n| a | b |\n| --- | --- |\n|  |  |\n| c |  |');
      expect(r.meta).toEqual({ sheets: [{ name: 'Gaps', rows: 3, cols: 2 }], truncated: false });
    } finally {
      streamed.mockRestore();
      loaded.mockRestore();
    }
  });
  it('xlsx: each sheet is capped at 500 rows and 50 columns', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Big');
    // Short cells: 500 x 50 of `${r}.${c}` would already pass TEXT_CAP, and this test is about the row/column cap.
    for (let r = 0; r < XLSX_MAX_ROWS + 20; r++) ws.addRow(Array.from({ length: XLSX_MAX_COLS + 5 }, (_, c) => `${r % 10}.${c}`));
    const r = await extract('xlsx', Buffer.from(await wb.xlsx.writeBuffer()), 'application/x', noWhisper);
    expect(r.meta).toEqual({ sheets: [{ name: 'Big', rows: XLSX_MAX_ROWS, cols: XLSX_MAX_COLS }], truncated: false });
    const lines = r.text!.split('\n');
    expect(lines).toHaveLength(1 + XLSX_MAX_ROWS + 1); // heading, rows, separator
    expect(lines[1].split(' | ')).toHaveLength(XLSX_MAX_COLS);
    expect(r.text).not.toContain(`0.${XLSX_MAX_COLS}`);
  });
});

describe('extract: audio and video go to whisper', () => {
  const ok = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  it('posts the bytes with their MIME and keeps the transcript and duration', async () => {
    const fetch = ok({ text: ' olá ', language: 'pt', duration: 12.3 });
    const r = await extract('audio', Buffer.from('clip'), 'audio/ogg', { whisperUrl: 'http://whisper:8000', language: 'pt', fetch: fetch as unknown as typeof globalThis.fetch });
    expect(r).toEqual({ text: 'olá', meta: { duration_s: 12.3, language: 'pt', truncated: false } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://whisper:8000/transcribe?language=pt');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('audio/ogg');
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe('clip');
  });
  it('video is sent the same way (whisper decodes the audio track)', async () => {
    const fetch = ok({ text: 'fala', duration: 1 });
    await extract('video', Buffer.from('mp4'), 'video/mp4', { whisperUrl: 'http://whisper:8000', language: null, fetch: fetch as unknown as typeof globalThis.fetch });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('http://whisper:8000/transcribe');
  });
  it('no whisper → TRANSCRIPTION_UNAVAILABLE; unreachable or 5xx → UNAVAILABLE; 422 or a bad answer → TRANSCRIPTION_FAILED', async () => {
    const w = (fetch: unknown) => ({ whisperUrl: 'http://whisper:8000', language: 'pt', fetch: fetch as typeof globalThis.fetch });
    expect(await code(extract('audio', Buffer.from('x'), 'audio/ogg', noWhisper))).toBe('TRANSCRIPTION_UNAVAILABLE');
    expect(await code(extract('audio', Buffer.from('x'), 'audio/ogg', w(vi.fn(async () => { throw new Error('ECONNREFUSED'); }))))).toBe('TRANSCRIPTION_UNAVAILABLE');
    expect(await code(extract('audio', Buffer.from('x'), 'audio/ogg', w(ok({ error: 'loading' }, 503))))).toBe('TRANSCRIPTION_UNAVAILABLE');
    // 503 is whisper loading its model: the same code, but the queue may try again later.
    await expect(extract('audio', Buffer.from('x'), 'audio/ogg', w(ok({ error: 'loading' }, 503)))).rejects.toMatchObject({ code: 'TRANSCRIPTION_UNAVAILABLE', retryable: true });
    await expect(extract('audio', Buffer.from('x'), 'audio/ogg', w(ok({ error: 'down' }, 500)))).rejects.toMatchObject({ code: 'TRANSCRIPTION_UNAVAILABLE', retryable: false });
    await expect(extract('audio', Buffer.from('x'), 'audio/ogg', noWhisper)).rejects.toMatchObject({ retryable: false });
    expect(await code(extract('audio', Buffer.from('x'), 'audio/ogg', w(ok({ error: 'bad audio' }, 422))))).toBe('TRANSCRIPTION_FAILED');
    expect(await code(extract('audio', Buffer.from('x'), 'audio/ogg', w(ok({ nope: 1 }))))).toBe('TRANSCRIPTION_FAILED');
  });
});

it('withTimeout turns a parser that never answers into an invalid attachment', async () => {
  expect(await code(withTimeout(new Promise(() => undefined), 5))).toBe('ATTACHMENT_INVALID');
  expect(await withTimeout(Promise.resolve(1), 5)).toBe(1);
});
