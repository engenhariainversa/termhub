import { ATTACHMENT_LIMITS } from '@termhub/mobile-api';
import type { TChatAttachment } from '@/services/api/contract';
import { attachmentStatusText, checkPick, draftsReducer, formatBytes, isUploading, planAdd, uploadedAttachments, type PickedFile } from './attachments';

const att = (over: Partial<TChatAttachment> & { id: string }): TChatAttachment => ({
  name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 10, status: 'pending', error_code: null, meta: null, created_at: '2026-09-26T00:00:00.000Z', ...over,
});
const pdf = (name = 'relatorio.pdf', bytes: number | null = 10): PickedFile => ({ uri: `file:///tmp/${name}`, name, mime: 'application/pdf', bytes });

let n = 0;
const nextKey = () => `k${++n}`;

beforeEach(() => {
  n = 0;
});

describe('checkPick', () => {
  it('refuses legacy office, unknown types and files over the limit; accepts an unknown size', () => {
    expect(checkPick({ uri: 'u', name: 'a.doc', mime: 'application/msword', bytes: 1 })).toEqual({ refused: 'Envie como .docx/.xlsx' });
    expect(checkPick({ uri: 'u', name: 'a.exe', mime: 'application/octet-stream', bytes: 1 })).toEqual({ refused: 'Tipo de arquivo não suportado' });
    expect(checkPick({ uri: 'u', name: 'a.png', mime: 'image/png', bytes: ATTACHMENT_LIMITS.image + 1 })).toEqual({ refused: 'Arquivo acima de 10 MB' });
    expect(checkPick({ uri: 'u', name: 'a.png', mime: 'image/png', bytes: null })).toEqual({ kind: 'image' });
  });
});

describe('planAdd', () => {
  it('turns picks into drafts, refusing in place and capping at five with a notice', () => {
    const existing = planAdd([], [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'), pdf('d.pdf')], nextKey).drafts;
    const { drafts, notice } = planAdd(existing, [pdf('e.pdf'), pdf('f.pdf'), { uri: 'u', name: 'x.exe', mime: '', bytes: 1 }], nextKey);
    expect(drafts.map((d) => d.file.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf']);
    expect(notice).toBe('No máximo 5 anexos por mensagem');
    expect(drafts[4]).toMatchObject({ key: 'k5', phase: 'uploading', progress: 0, refused: false, kind: 'pdf' });

    const refused = planAdd([], [{ uri: 'u', name: 'x.exe', mime: '', bytes: 1 }], nextKey);
    expect(refused.notice).toBeNull();
    expect(refused.drafts[0]).toMatchObject({ phase: 'failed', refused: true, error: 'Tipo de arquivo não suportado', kind: null });
  });
});

describe('draftsReducer', () => {
  const base = planAdd([], [pdf('a.pdf'), pdf('b.pdf')], nextKey).drafts;

  it('tracks progress, landing, failure, retry and removal by key', () => {
    let s = draftsReducer(base, { type: 'progress', key: 'k1', fraction: 0.4 });
    expect(s[0]!.progress).toBe(0.4);
    s = draftsReducer(s, { type: 'uploaded', key: 'k1', attachment: att({ id: 'att1' }) });
    expect(s[0]).toMatchObject({ phase: 'uploaded', progress: 1, attachment: { id: 'att1' } });
    s = draftsReducer(s, { type: 'failed', key: 'k2', error: 'Sem conexão' });
    expect(s[1]).toMatchObject({ phase: 'failed', error: 'Sem conexão', refused: false });
    expect(isUploading(s)).toBe(false);
    expect(uploadedAttachments(s)).toEqual([att({ id: 'att1' })]);
    s = draftsReducer(s, { type: 'retry', key: 'k2' });
    expect(s[1]).toMatchObject({ phase: 'uploading', progress: 0, error: null });
    expect(isUploading(s)).toBe(true);
    s = draftsReducer(s, { type: 'remove', key: 'k1' });
    expect(s.map((d) => d.key)).toEqual(['k2']);
    expect(draftsReducer(s, { type: 'clear' })).toEqual([]);
  });

  it('returns the same array for an unknown key', () => {
    expect(draftsReducer(base, { type: 'progress', key: 'nope', fraction: 1 })).toBe(base);
  });
});

describe('copy', () => {
  it('formats sizes and status lines like the web', () => {
    expect(formatBytes(1234)).toBe('1,2 KB');
    expect(formatBytes(10_485_760)).toBe('10 MB');
    expect(attachmentStatusText(att({ id: 'a', kind: 'audio' }))).toBe('transcrevendo…');
    expect(attachmentStatusText(att({ id: 'a' }))).toBe('processando…');
    expect(attachmentStatusText(att({ id: 'a', status: 'failed', error_code: 'ATTACHMENT_INVALID' }))).toBe('falhou: arquivo inválido');
    expect(attachmentStatusText(att({ id: 'a', status: 'ready' }))).toBeNull();
  });
});
