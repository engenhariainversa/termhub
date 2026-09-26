import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, MAX_ATTACHMENTS_PER_MESSAGE, TEXT_EXTENSIONS, attachmentStatusText, chatAttachment, formatBytes, hasTextExtension, kindFromNameAndMime } from './attachments.js';

describe('limits table', () => {
  it('is the spec table (§5.2), in bytes', () => {
    expect(ATTACHMENT_LIMITS).toEqual({ image: 10_485_760, pdf: 20_971_520, docx: 20_971_520, xlsx: 20_971_520, audio: 67_108_864, video: 67_108_864, text: 1_048_576 });
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(5);
    expect(TEXT_EXTENSIONS).toEqual(['.txt', '.md', '.csv', '.json', '.log', '.yaml', '.yml', '.ts', '.js', '.py']);
  });
});

describe('kindFromNameAndMime', () => {
  it.each([
    ['foto.jpg', 'image/jpeg', 'image'],
    ['foto.PNG', 'image/png', 'image'],
    ['logo.svg', 'image/svg+xml', null],
    ['relatorio.pdf', 'application/pdf', 'pdf'],
    ['relatorio.pdf', 'application/octet-stream', 'pdf'],
    ['ata.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['vendas.xlsx', 'application/octet-stream', 'xlsx'],
    ['antigo.doc', 'application/msword', null],
    ['nota.m4a', 'audio/x-m4a', 'audio'],
    ['clipe.mov', 'video/quicktime', 'video'],
    ['notas.md', 'text/markdown', 'text'],
    ['dados.csv', '', 'text'],
    ['binario.exe', 'application/octet-stream', null],
  ])('%s (%s) → %s', (name, mime, kind) => {
    expect(kindFromNameAndMime(name, mime)).toBe(kind);
  });

  it('ignores MIME parameters and case', () => {
    expect(kindFromNameAndMime('a.bin', 'IMAGE/JPEG; charset=binary')).toBe('image');
    expect(hasTextExtension('NOTAS.TXT')).toBe(true);
    expect(hasTextExtension('notas.txt.exe')).toBe(false);
  });
});

it('chatAttachment parses the wire shape and refuses an unknown kind or status', () => {
  const a = { id: 'at1', name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 1234, status: 'ready', error_code: null, meta: { pages: 12 }, created_at: '2026-09-26T12:00:00.000Z' };
  expect(chatAttachment.safeParse(a).success).toBe(true);
  expect(chatAttachment.safeParse({ ...a, meta: null, status: 'failed', error_code: 'ATTACHMENT_INVALID' }).success).toBe(true);
  expect(chatAttachment.safeParse({ ...a, kind: 'exe' }).success).toBe(false);
  expect(chatAttachment.safeParse({ ...a, status: 'done' }).success).toBe(false);
});

describe('pt-BR copy', () => {
  it('formats sizes with a decimal comma', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1234)).toBe('1,2 KB');
    expect(formatBytes(10_485_760)).toBe('10 MB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
  });

  it('says what the server is doing with a file, or why it gave up', () => {
    expect(attachmentStatusText({ kind: 'pdf', status: 'pending', error_code: null })).toBe('processando…');
    expect(attachmentStatusText({ kind: 'audio', status: 'pending', error_code: null })).toBe('transcrevendo…');
    expect(attachmentStatusText({ kind: 'video', status: 'pending', error_code: null })).toBe('transcrevendo…');
    expect(attachmentStatusText({ kind: 'pdf', status: 'failed', error_code: 'ATTACHMENT_INVALID' })).toBe('falhou: arquivo inválido');
    expect(attachmentStatusText({ kind: 'audio', status: 'failed', error_code: 'TRANSCRIPTION_FAILED' })).toBe('falhou: transcrição falhou');
    expect(attachmentStatusText({ kind: 'pdf', status: 'failed', error_code: null })).toBe('falhou: erro');
    expect(attachmentStatusText({ kind: 'pdf', status: 'ready', error_code: null })).toBeNull();
  });
});
