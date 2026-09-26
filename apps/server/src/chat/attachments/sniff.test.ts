import { describe, expect, it } from 'vitest';
import { buildZip, minimalDocx, minimalPdf } from '../../../test/zip.js';
import { sniff } from './sniff.js';

const bytes = (...parts: (number[] | string | Buffer)[]) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], Buffer.alloc(16));
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF\0', Buffer.alloc(16));
const GIF = bytes('GIF89a', Buffer.alloc(8));
const WEBP = bytes('RIFF', [0x24, 0, 0, 0], 'WEBP', 'VP8 ', Buffer.alloc(16));
const OLE = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], Buffer.alloc(16));
const ftyp = (brand: string) => bytes([0, 0, 0, 0x18], 'ftyp', brand, Buffer.alloc(16));
const ebml = (codec: string) => bytes([0x1a, 0x45, 0xdf, 0xa3], Buffer.alloc(40), 'webm', Buffer.alloc(40), codec, Buffer.alloc(40));

describe('sniff: images, PDF and office files by magic bytes', () => {
  it.each([
    ['PNG', PNG, 'foto.png', { kind: 'image', mime: 'image/png' }],
    ['JPEG', JPEG, 'foto.jpg', { kind: 'image', mime: 'image/jpeg' }],
    ['GIF', GIF, 'anim.gif', { kind: 'image', mime: 'image/gif' }],
    ['WebP', WEBP, 'foto.webp', { kind: 'image', mime: 'image/webp' }],
    ['PDF', minimalPdf('oi'), 'relatorio.pdf', { kind: 'pdf', mime: 'application/pdf' }],
    ['docx', minimalDocx(['oi']), 'ata.docx', { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
    ['xlsx', buildZip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<workbook/>']]), 'vendas.xlsx', { kind: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
  ])('%s', (_n, data, name, expected) => {
    expect(sniff(data, name)).toEqual(expected);
  });

  it('never trusts the name: the bytes decide, and a lie is refused', () => {
    expect(sniff(PNG, 'foto.exe')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'foto.png')).toBeNull();
    expect(sniff(Buffer.from('<!doctype html><script>alert(1)</script>'), 'foto.png')).toBeNull();
    expect(sniff(buildZip([['a.txt', 'x']]), 'relatorio.pdf')).toBeNull();
    expect(sniff(buildZip([['a.txt', 'x']]), 'arquivo.zip')).toBeNull();
    expect(sniff(Buffer.from('%PDF-1.7\n'), 'relatorio.docx')).toEqual({ kind: 'pdf', mime: 'application/pdf' });
  });

  it('refuses the legacy .doc/.xls container as legacy_office', () => {
    expect(sniff(OLE, 'antigo.doc')).toEqual({ refused: 'legacy_office' });
    expect(sniff(OLE, 'planilha.xls')).toEqual({ refused: 'legacy_office' });
  });
});

describe('sniff: audio and video', () => {
  it.each([
    ['OGG', bytes('OggS', Buffer.alloc(12)), 'nota.ogg', { kind: 'audio', mime: 'audio/ogg' }],
    ['WAV', bytes('RIFF', [0, 0, 0, 0], 'WAVE', Buffer.alloc(8)), 'nota.wav', { kind: 'audio', mime: 'audio/wav' }],
    ['MP3 with ID3', bytes('ID3', Buffer.alloc(12)), 'nota.mp3', { kind: 'audio', mime: 'audio/mpeg' }],
    ['MP3 frame sync', bytes([0xff, 0xfb, 0x90, 0x00], Buffer.alloc(12)), 'nota.mp3', { kind: 'audio', mime: 'audio/mpeg' }],
    ['M4A', ftyp('M4A '), 'nota.m4a', { kind: 'audio', mime: 'audio/mp4' }],
    ['MP4', ftyp('isom'), 'clipe.mp4', { kind: 'video', mime: 'video/mp4' }],
    ['MOV', ftyp('qt  '), 'clipe.mov', { kind: 'video', mime: 'video/quicktime' }],
    ['WebM audio', ebml('A_OPUS'), 'nota.webm', { kind: 'audio', mime: 'audio/webm' }],
    ['WebM video', ebml('V_VP9'), 'clipe.webm', { kind: 'video', mime: 'video/webm' }],
  ])('%s', (_n, data, name, expected) => {
    expect(sniff(data, name)).toEqual(expected);
  });
});

describe('sniff: text', () => {
  it('is valid UTF-8 with no NUL, named like a text file', () => {
    expect(sniff(Buffer.from('olá\n'), 'notas.txt')).toEqual({ kind: 'text', mime: 'text/plain; charset=utf-8' });
    expect(sniff(Buffer.from('{"a":1}'), 'dados.JSON')).toEqual({ kind: 'text', mime: 'text/plain; charset=utf-8' });
    expect(sniff(Buffer.from('hi'), 'x.py')).toEqual({ kind: 'text', mime: 'text/plain; charset=utf-8' });
    expect(sniff(Buffer.from('olá'), 'notas.exe')).toBeNull();
    expect(sniff(Buffer.from('olá'), 'notas')).toBeNull();
    expect(sniff(Buffer.from([0x68, 0x00, 0x69]), 'notas.txt')).toBeNull();
    expect(sniff(Buffer.from([0xc3, 0x28]), 'notas.txt')).toBeNull();
    expect(sniff(Buffer.alloc(0), 'notas.txt')).toBeNull();
  });
});

describe('sniff: hostile input', () => {
  it('never throws: truncations and byte flips of every fixture answer a kind, a refusal or null', () => {
    let seed = 11;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const fixtures = [PNG, JPEG, GIF, WEBP, OLE, ftyp('isom'), ebml('V_VP9'), minimalPdf('oi'), minimalDocx(['oi']), Buffer.from('olá\n')];
    const names = ['a.png', 'a.txt', 'a.docx', 'a.zip', 'a'];
    for (const fx of fixtures) {
      for (let cut = 0; cut <= fx.length; cut++) expect(() => sniff(fx.subarray(0, cut), 'a.txt')).not.toThrow();
      for (let i = 0; i < 300; i++) {
        const mutated = Buffer.from(fx);
        for (let k = 0; k < 1 + rnd(4); k++) mutated[rnd(mutated.length)] = rnd(256);
        expect(() => sniff(mutated, names[rnd(names.length)])).not.toThrow();
      }
    }
    for (let i = 0; i < 1000; i++) {
      const random = Buffer.alloc(rnd(48));
      for (let k = 0; k < random.length; k++) random[k] = rnd(256);
      expect(() => sniff(random, names[rnd(names.length)])).not.toThrow();
    }
  });
});
