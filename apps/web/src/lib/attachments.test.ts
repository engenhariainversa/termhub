import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, MAX_ATTACHMENTS_PER_MESSAGE, attachmentStatusText, checkFile, formatBytes, kindFromNameAndMime, patchMessageAttachment } from './attachments';
import type { ChatAttachment, ChatMessage } from './types';

const att = (over: Partial<ChatAttachment> = {}): ChatAttachment => ({
  id: 'a1', name: 'x.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 10, status: 'ready', error_code: null, meta: null, created_at: '2026-09-26T00:00:00.000Z', ...over,
});

describe('kindFromNameAndMime', () => {
  it('guesses the kind from the mime first, then the extension', () => {
    expect(kindFromNameAndMime('foto.png', 'image/png')).toBe('image');
    expect(kindFromNameAndMime('foto', 'image/webp')).toBe('image');
    expect(kindFromNameAndMime('doc.pdf', '')).toBe('pdf');
    expect(kindFromNameAndMime('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
    expect(kindFromNameAndMime('a.xlsx', '')).toBe('xlsx');
    expect(kindFromNameAndMime('clip.m4a', 'audio/mp4')).toBe('audio');
    expect(kindFromNameAndMime('clip.webm', 'video/webm')).toBe('video');
    expect(kindFromNameAndMime('notas.md', 'text/markdown')).toBe('text');
    expect(kindFromNameAndMime('script.py', '')).toBe('text');
  });

  it('knows nothing about svg, html or binaries', () => {
    expect(kindFromNameAndMime('logo.svg', 'image/svg+xml')).toBeNull();
    expect(kindFromNameAndMime('page.html', 'text/html')).toBeNull();
    expect(kindFromNameAndMime('setup.exe', 'application/octet-stream')).toBeNull();
  });
});

describe('checkFile', () => {
  it('refuses legacy office files with the sentence that says what to send instead', () => {
    expect(checkFile('velho.doc', 'application/msword', 10)).toEqual({ refused: 'Envie como .docx/.xlsx' });
    expect(checkFile('velho.xls', '', 10)).toEqual({ refused: 'Envie como .docx/.xlsx' });
  });

  it('refuses an unknown type and a file over its kind limit', () => {
    expect(checkFile('setup.exe', '', 10)).toEqual({ refused: 'Tipo de arquivo não suportado' });
    expect(checkFile('foto.png', 'image/png', ATTACHMENT_LIMITS.image + 1)).toEqual({ refused: 'Arquivo acima de 10 MB' });
    expect(checkFile('notas.txt', 'text/plain', ATTACHMENT_LIMITS.text + 1)).toEqual({ refused: 'Arquivo acima de 1 MB' });
  });

  it('accepts a file at exactly its limit', () => {
    expect(checkFile('filme.mp4', 'video/mp4', ATTACHMENT_LIMITS.video)).toEqual({ kind: 'video' });
  });
});

describe('limits', () => {
  it('copies the contract table', () => {
    expect(ATTACHMENT_LIMITS).toEqual({ image: 10_485_760, pdf: 20_971_520, docx: 20_971_520, xlsx: 20_971_520, audio: 67_108_864, video: 67_108_864, text: 1_048_576 });
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(5);
  });
});

describe('formatBytes', () => {
  it('reads like a size a person would say', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1234)).toBe('1,2 KB');
    expect(formatBytes(1_048_576)).toBe('1 MB');
    expect(formatBytes(10_485_760)).toBe('10 MB');
    expect(formatBytes(67_108_864)).toBe('64 MB');
  });
});

describe('attachmentStatusText', () => {
  it('says what is happening to the file, in the words of the spec', () => {
    expect(attachmentStatusText(att({ status: 'pending' }))).toBe('processando…');
    expect(attachmentStatusText(att({ status: 'pending', kind: 'audio' }))).toBe('transcrevendo…');
    expect(attachmentStatusText(att({ status: 'pending', kind: 'video' }))).toBe('transcrevendo…');
    expect(attachmentStatusText(att({ status: 'failed', error_code: 'ATTACHMENT_INVALID' }))).toBe('falhou: arquivo inválido');
    expect(attachmentStatusText(att({ status: 'failed', error_code: 'TRANSCRIPTION_UNAVAILABLE' }))).toBe('falhou: transcrição indisponível');
    expect(attachmentStatusText(att({ status: 'failed', error_code: 'TRANSCRIPTION_FAILED' }))).toBe('falhou: transcrição falhou');
    expect(attachmentStatusText(att({ status: 'failed', error_code: null }))).toBe('falhou: erro');
    expect(attachmentStatusText(att({ status: 'ready' }))).toBeNull();
  });
});

describe('patchMessageAttachment', () => {
  const msg = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({ conversation_id: 'c1', role: 'user', text: '', error_code: null, created_at: '2026-09-26T00:00:00.000Z', ...over });

  it('replaces the attachment inside the message that carries it, keeping every other row', () => {
    const other = msg({ id: 'm0', text: 'oi' });
    const list = [other, msg({ id: 'm1', attachments: [att({ id: 'a1', status: 'pending' }), att({ id: 'a2', status: 'pending' })] })];
    const next = patchMessageAttachment(list, att({ id: 'a2', status: 'ready', meta: { pages: 3 } }));
    expect(next).not.toBe(list);
    expect(next[0]).toBe(other);
    expect(next[1].attachments).toEqual([att({ id: 'a1', status: 'pending' }), att({ id: 'a2', status: 'ready', meta: { pages: 3 } })]);
  });

  it('returns the same list when the id is unknown or nothing changed', () => {
    const list = [msg({ id: 'm1', attachments: [att({ id: 'a1', status: 'ready' })] })];
    expect(patchMessageAttachment(list, att({ id: 'zz', status: 'ready' }))).toBe(list);
    expect(patchMessageAttachment(list, att({ id: 'a1', status: 'ready' }))).toBe(list);
  });
});
