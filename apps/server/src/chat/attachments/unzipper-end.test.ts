import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseDocument, ZIP_EXPANDED_MAX_BYTES } from './parsers.js';
import { fixUnzipperEarlyEnd } from './unzipper-end.js';

// TER-475: unzipper's `Parse` said `'end'` while entries it had pushed were still buffered, and the
// streaming reader lost them — `xl/workbook.xml` (a TypeError on `sheets`) or whole sheets — in about
// one parse in four on macOS. A small workbook written by exceljs puts every worksheet before
// `sharedStrings.xml` and `xl/workbook.xml`: the layout that loses them.
describe('unzipper early end (TER-475)', () => {
  it('the patch finds the listener in the unzipper exceljs loads (an upgrade that moves it fails here)', () => {
    expect(fixUnzipperEarlyEnd()).toBe(true);
  });

  it('small workbooks read whole, every time: every sheet, by its name, with its rows', async () => {
    const wb = new ExcelJS.Workbook();
    for (const name of ['Fluxo', 'Custos', 'Resumo']) {
      const ws = wb.addWorksheet(name);
      ws.addRow(['Item', 'Qtd']);
      ws.addRow([`Café ${name}`, 2]);
    }
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    for (let i = 0; i < 40; i++) {
      const r = await parseDocument('xlsx', file, ZIP_EXPANDED_MAX_BYTES);
      expect(r.meta.sheets).toEqual([
        { name: 'Fluxo', rows: 2, cols: 2 },
        { name: 'Custos', rows: 2, cols: 2 },
        { name: 'Resumo', rows: 2, cols: 2 },
      ]);
    }
  }, 60_000);
});
