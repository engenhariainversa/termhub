// Test-only builders (outside src: tsc never compiles this; vitest imports it). A ZIP with stored
// (method 0) or deflated (method 8) entries, CRC-32 and a central directory — enough for mammoth,
// exceljs and our own reader.
import { deflateRawSync } from 'node:zlib';

const TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c;
}
const crc32 = (buf: Buffer): number => {
  let c = -1;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

export interface BuildZipOptions {
  /** Lie about an entry's uncompressed size, consistently, in the local header, the data descriptor and the central directory (a zip bomb's signature). */
  claimUncompressed?: Record<string, number>;
  /** Deflate the entries (method 8), the way every real .docx/.xlsx is written. */
  deflate?: boolean;
  /** Bit 3: the local header carries zero sizes and a 16-byte data descriptor follows the data (streaming writers: archiver, Java's ZipOutputStream). */
  dataDescriptor?: boolean;
  /** Names written as local entries but left out of the central directory. */
  unlisted?: string[];
  /** Zero bytes between the last local entry and the central directory. */
  gapBeforeDirectory?: number;
}

export function buildZip(entries: [string, string | Buffer][], opts: BuildZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const stored = opts.deflate ? deflateRawSync(data) : data;
    const method = opts.deflate ? 8 : 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const claimed = opts.claimUncompressed?.[name] ?? data.length;
    const flags = opts.dataDescriptor ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!opts.dataDescriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(stored.length, 18);
      local.writeUInt32LE(claimed, 22);
    }
    local.writeUInt16LE(nameBuf.length, 26);
    const descriptor = Buffer.alloc(opts.dataDescriptor ? 16 : 0);
    if (opts.dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(stored.length, 8);
      descriptor.writeUInt32LE(claimed, 12);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(claimed, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, stored, descriptor);
    if (!opts.unlisted?.includes(name)) centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + stored.length + descriptor.length;
  }
  const gap = Buffer.alloc(opts.gapBeforeDirectory ?? 0);
  const cd = Buffer.concat(centrals);
  const listed = entries.length - (opts.unlisted?.length ?? 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(listed, 8);
  end.writeUInt16LE(listed, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset + gap.length, 16);
  return Buffer.concat([...locals, gap, cd, end]);
}

/**
 * The same ZIP with one more local entry at offset 0 that its central directory does not list: what a
 * sequential reader (unzipper, behind exceljs's WorkbookReader) meets first, and what a directory-based
 * one (JSZip) never sees. Every listed offset moves by the entry's length.
 */
export function withUnlistedEntry(zip: Buffer, name: string, content: string | Buffer): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const stored = deflateRawSync(data);
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(stored.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const shift = local.length + nameBuf.length + stored.length;
  const out = Buffer.concat([local, nameBuf, stored, zip]);
  const end = out.length - 22;
  const count = out.readUInt16LE(end + 10);
  const cdOffset = out.readUInt32LE(end + 16) + shift;
  out.writeUInt32LE(cdOffset, end + 16);
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    out.writeUInt32LE(out.readUInt32LE(p + 42) + shift, p + 42);
    p += 46 + out.readUInt16LE(p + 28) + out.readUInt16LE(p + 30) + out.readUInt16LE(p + 32);
  }
  return out;
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

/** The smallest .docx mammoth reads: one paragraph per string. */
export function minimalDocx(paragraphs: string[], opts: BuildZipOptions = {}): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  return buildZip(
    [
      ['[Content_Types].xml', CONTENT_TYPES],
      ['_rels/.rels', RELS],
      ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`],
    ],
    opts,
  );
}

/** A one-page PDF with one line of Helvetica text (ASCII only), with a correct xref. */
export function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
