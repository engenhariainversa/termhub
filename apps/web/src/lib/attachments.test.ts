import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, MAX_ATTACHMENTS_PER_MESSAGE, attachmentStatusText, canRetryAttachment, checkFile, formatBytes, kindFromNameAndMime, patchMessageAttachment, thumbSize } from './attachments';
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

  it('an unavailable transcription says why, and only it can be tried again (TER-1035)', () => {
    const clip = (reason: string | null) => att({ kind: 'audio', status: 'failed', error_code: 'TRANSCRIPTION_UNAVAILABLE', meta: reason ? { reason } : null });
    expect(attachmentStatusText(clip('refused'))).toBe('falhou: o serviço de transcrição recusou o acesso');
    expect(attachmentStatusText(clip('unreachable'))).toBe('falhou: serviço de transcrição fora do ar');
    expect(attachmentStatusText(clip('not_configured'))).toBe('falhou: transcrição desligada neste servidor');
    expect(attachmentStatusText(clip(null))).toBe('falhou: transcrição indisponível');
    expect(canRetryAttachment(clip('refused'))).toBe(true);
    expect(canRetryAttachment(att({ kind: 'audio', status: 'failed', error_code: 'TRANSCRIPTION_FAILED' }))).toBe(false);
    expect(canRetryAttachment(att({ status: 'failed', error_code: 'ATTACHMENT_INVALID' }))).toBe(false);
    expect(canRetryAttachment(att({ kind: 'audio', status: 'ready' }))).toBe(false);
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

describe('thumbSize', () => {
  it('fits the long side to the box and keeps the proportion', () => {
    expect(thumbSize({ width: 1600, height: 1200 }, 240, 48)).toEqual({ width: 240, height: 180 });
    expect(thumbSize({ width: 1200, height: 1600 }, 240, 48)).toEqual({ width: 180, height: 240 });
  });
  it('never scales up', () => {
    expect(thumbSize({ width: 100, height: 50 }, 240, 48)).toEqual({ width: 100, height: 50 });
  });
  it('clamps an extreme proportion to the minimum side', () => {
    expect(thumbSize({ width: 4000, height: 20 }, 240, 48)).toEqual({ width: 240, height: 48 });
    expect(thumbSize({ width: 10, height: 10 }, 240, 48)).toEqual({ width: 48, height: 48 });
  });
  it.each([null, {}, { width: 0, height: 10 }, { width: -5, height: 10 }, { width: '800', height: 600 }, { width: Number.NaN, height: 600 }, { width: 800.5, height: 600 }])(
    'is null without usable dimensions: %o',
    (meta) => expect(thumbSize(meta as Record<string, unknown> | null, 240, 48)).toBeNull(),
  );
});
