// Test-only builder (outside src: tsc never compiles this; vitest imports it). A binary property list
// (`bplist00`) from a flat object table, the way CoreFoundation writes one: each object is a marker
// byte plus payload, references are 1-byte indexes into the table, then the offset table and trailer.

export type PlistObject =
  | { t: 'bool'; v: boolean }
  | { t: 'int'; v: number }
  | { t: 'real'; v: number }
  | { t: 'date'; v: number }
  | { t: 'data'; v: Buffer }
  | { t: 'ascii'; v: string }
  | { t: 'utf16'; v: string }
  | { t: 'uid'; v: number }
  | { t: 'array'; refs: number[] }
  | { t: 'dict'; keys: number[]; values: number[] };

const withLength = (type: number, n: number): Buffer => (n < 15 ? Buffer.from([(type << 4) | n]) : Buffer.from([(type << 4) | 0xf, 0x11, n >> 8, n & 0xff]));

function encode(o: PlistObject): Buffer {
  switch (o.t) {
    case 'bool':
      return Buffer.from([o.v ? 0x09 : 0x08]);
    case 'int': {
      const b = Buffer.alloc(9);
      b[0] = 0x13;
      b.writeBigInt64BE(BigInt(o.v), 1);
      return b;
    }
    case 'real': {
      const b = Buffer.alloc(9);
      b[0] = 0x23;
      b.writeDoubleBE(o.v, 1);
      return b;
    }
    case 'date': {
      const b = Buffer.alloc(9);
      b[0] = 0x33;
      b.writeDoubleBE(o.v, 1);
      return b;
    }
    case 'data':
      return Buffer.concat([withLength(0x4, o.v.length), o.v]);
    case 'ascii':
      return Buffer.concat([withLength(0x5, o.v.length), Buffer.from(o.v, 'latin1')]);
    case 'utf16': {
      const le = Buffer.from(o.v, 'utf16le');
      le.swap16();
      return Buffer.concat([withLength(0x6, le.length / 2), le]);
    }
    case 'uid':
      return Buffer.from([0x80, o.v]);
    case 'array':
      return Buffer.concat([withLength(0xa, o.refs.length), Buffer.from(o.refs)]);
    case 'dict':
      return Buffer.concat([withLength(0xd, o.keys.length), Buffer.from(o.keys), Buffer.from(o.values)]);
  }
}

/** The file: objects in order, 2-byte offsets, 1-byte refs, `top` the root. `count` overrides the trailer's object count. */
export function buildBinaryPlist(objects: PlistObject[], top = 0, over: { count?: number; tableAt?: number } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from('bplist00', 'latin1')];
  const offsets: number[] = [];
  let at = 8;
  for (const o of objects) {
    const b = encode(o);
    offsets.push(at);
    parts.push(b);
    at += b.length;
  }
  const tableAt = at;
  const table = Buffer.alloc(objects.length * 2);
  offsets.forEach((o, i) => table.writeUInt16BE(o, i * 2));
  const trailer = Buffer.alloc(32);
  trailer[6] = 2;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(BigInt(over.count ?? objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(top), 16);
  trailer.writeBigUInt64BE(BigInt(over.tableAt ?? tableAt), 24);
  return Buffer.concat([...parts, table, trailer]);
}

/** `{ Nome: "termhub", Ativo: true, Versão: 3, Itens: ["a", "ç"] }` as a binary plist. */
export function samplePlist(): Buffer {
  return buildBinaryPlist([
    { t: 'dict', keys: [1, 2, 3, 4], values: [5, 6, 7, 8] },
    { t: 'ascii', v: 'Nome' },
    { t: 'ascii', v: 'Ativo' },
    { t: 'utf16', v: 'Versão' },
    { t: 'ascii', v: 'Itens' },
    { t: 'ascii', v: 'termhub <&>' },
    { t: 'bool', v: true },
    { t: 'int', v: 3 },
    { t: 'array', refs: [9, 10] },
    { t: 'ascii', v: 'a' },
    { t: 'utf16', v: 'ç' },
  ]);
}

export const XML_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>dev.termhub.agent</string>
</dict>
</plist>
`;
