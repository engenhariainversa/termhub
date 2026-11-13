import { describe, expect, it } from 'vitest';
import { buildBinaryPlist, samplePlist, XML_PLIST } from '../../../test/plist.js';
import { PlistError, binaryPlistToXml, isBinaryPlist, isXmlPlist } from './plist.js';

const CAP = 200_000;

describe('binaryPlistToXml (TER-1167)', () => {
  it('turns a binary plist into the XML Apple writes, strings escaped and UTF-16 decoded', () => {
    const { text, truncated } = binaryPlistToXml(samplePlist(), CAP);
    expect(truncated).toBe(false);
    expect(text).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '\t<key>Nome</key>',
        '\t<string>termhub &lt;&amp;&gt;</string>',
        '\t<key>Ativo</key>',
        '\t<true/>',
        '\t<key>Versão</key>',
        '\t<integer>3</integer>',
        '\t<key>Itens</key>',
        '\t<array>',
        '\t\t<string>a</string>',
        '\t\t<string>ç</string>',
        '\t</array>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    );
  });

  it('writes reals, dates, data, negative integers and UIDs', () => {
    const file = buildBinaryPlist([
      { t: 'array', refs: [1, 2, 3, 4, 5, 6] },
      { t: 'real', v: 1.5 },
      { t: 'date', v: 0 },
      { t: 'data', v: Buffer.from('oi') },
      { t: 'int', v: -7 },
      { t: 'uid', v: 4 },
      { t: 'bool', v: false },
    ]);
    const { text } = binaryPlistToXml(file, CAP);
    expect(text).toContain('\t<real>1.5</real>\n');
    expect(text).toContain('\t<date>2001-01-01T00:00:00Z</date>\n');
    expect(text).toContain('\t<data>b2k=</data>\n');
    expect(text).toContain('\t<integer>-7</integer>\n');
    expect(text).toContain('<key>CF$UID</key>\n\t\t<integer>4</integer>');
    expect(text).toContain('\t<false/>\n');
  });

  it('refuses a cycle instead of recursing for ever', () => {
    const file = buildBinaryPlist([{ t: 'array', refs: [1] }, { t: 'array', refs: [0] }]);
    expect(() => binaryPlistToXml(file, CAP)).toThrow(PlistError);
  });

  it('stops at the budget when shared references would expand a small file (no blow-up)', () => {
    // Each level points twice at the next: 20 levels are 2^20 leaves from a few hundred bytes.
    const objects = Array.from({ length: 20 }, (_, i) => ({ t: 'array' as const, refs: [i + 1, i + 1] }));
    const file = buildBinaryPlist([...objects, { t: 'ascii', v: 'x' }]);
    const { text, truncated } = binaryPlistToXml(file, 10_000);
    expect(truncated).toBe(true);
    expect(text.length).toBe(10_000);
  });

  it.each([
    ['a reference past the object table', buildBinaryPlist([{ t: 'array', refs: [9] }])],
    ['a dict key that is not a string', buildBinaryPlist([{ t: 'dict', keys: [1], values: [1] }, { t: 'int', v: 1 }])],
    ['an offset table outside the file', buildBinaryPlist([{ t: 'bool', v: true }], 0, { tableAt: 60_000 })],
    ['an object count larger than the file', buildBinaryPlist([{ t: 'bool', v: true }], 0, { count: 1_000_000 })],
    ['a root past the object count', buildBinaryPlist([{ t: 'bool', v: true }], 5)],
    ['only the header', Buffer.from('bplist00', 'latin1')],
    ['the header and garbage', Buffer.concat([Buffer.from('bplist00', 'latin1'), Buffer.alloc(64, 0xff)])],
  ])('refuses %s', (_n, file) => {
    expect(() => binaryPlistToXml(file, CAP)).toThrow(PlistError);
  });

  it('recognises each kind by its content', () => {
    expect(isBinaryPlist(samplePlist())).toBe(true);
    expect(isBinaryPlist(Buffer.from(XML_PLIST))).toBe(false);
    expect(isXmlPlist(XML_PLIST)).toBe(true);
    expect(isXmlPlist('﻿<plist version="1.0"><dict/></plist>')).toBe(true);
    expect(isXmlPlist('<?xml version="1.0"?>\n<html><body/></html>')).toBe(false);
    expect(isXmlPlist('Label = dev.termhub.agent')).toBe(false);
  });
});
