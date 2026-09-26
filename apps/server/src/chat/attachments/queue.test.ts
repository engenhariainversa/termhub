import { describe, expect, it, vi } from 'vitest';
import type { AttachmentRow, ChatAttachmentsRepo } from '../../db/repositories/chat-attachments.js';
import { ExtractError, type extract } from './extract.js';
import { createExtractionQueue, requeuePending } from './queue.js';

const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: 'at1', user_id: 'u1', conversation_id: 'c1', message_id: null, name: 'a.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 3, sha256: 'h',
  status: 'pending', error_code: null, extracted_text: null, meta: null, created_at: '2026-09-26T12:00:00.000Z', ...over,
});

function build(rows: AttachmentRow[], extractImpl: typeof extract) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const repo = {
    findById: vi.fn(async (id: string) => store.get(id) ?? null),
    setExtracted: vi.fn(async (id: string, text: string | null, meta: Record<string, unknown> | null) => {
      const r = store.get(id);
      if (!r) return null;
      Object.assign(r, { status: 'ready', extracted_text: text, meta, error_code: null });
      return { ...r };
    }),
    setFailed: vi.fn(async (id: string, code: string) => {
      const r = store.get(id);
      if (!r) return null;
      Object.assign(r, { status: 'failed', error_code: code });
      return { ...r };
    }),
    listPending: vi.fn(async () => [...store.values()].filter((r) => r.status === 'pending')),
  } as unknown as ChatAttachmentsRepo;
  const files = { read: vi.fn(async (_u: string, id: string) => (id === 'gone' ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) : Buffer.from('abc'))) };
  const onDone = vi.fn();
  const log = { warn: vi.fn(), info: vi.fn() };
  const queue = createExtractionQueue({ repo, store: files, extract: extractImpl, whisper: { whisperUrl: 'http://w', language: 'pt' }, onDone, log });
  return { queue, repo, files, onDone, log, store };
}

describe('extraction queue', () => {
  it('runs one job at a time, in order, and publishes the updated row', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const extractImpl = vi.fn(async (kind: string, _f: Buffer, _m: string) => {
      order.push(`start:${kind}`);
      if (kind === 'pdf') await first;
      order.push(`end:${kind}`);
      return { text: `texto ${kind}`, meta: { truncated: false } };
    }) as unknown as typeof extract;
    const { queue, onDone } = build([row({ id: 'a', kind: 'pdf' }), row({ id: 'b', kind: 'text' })], extractImpl);
    queue.enqueue('a');
    queue.enqueue('b');
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['start:pdf']);
    release();
    await queue.idle();
    expect(order).toEqual(['start:pdf', 'end:pdf', 'start:text', 'end:text']);
    expect(onDone.mock.calls.map((c) => [c[0].id, c[0].status, c[0].extracted_text])).toEqual([['a', 'ready', 'texto pdf'], ['b', 'ready', 'texto text']]);
    expect(extractImpl).toHaveBeenCalledWith('pdf', Buffer.from('abc'), 'application/pdf', { whisperUrl: 'http://w', language: 'pt' });
  });

  it('an ExtractError becomes the row failure code; anything else is ATTACHMENT_INVALID and logged by name only', async () => {
    const extractImpl = vi.fn(async (kind: string) => {
      if (kind === 'audio') throw new ExtractError('TRANSCRIPTION_UNAVAILABLE');
      throw new Error('pg: connection refused at 10.0.0.1 while parsing SEGREDO');
    }) as unknown as typeof extract;
    const { queue, onDone, log, repo } = build([row({ id: 'a', kind: 'audio' }), row({ id: 'b', kind: 'pdf' })], extractImpl);
    queue.enqueue('a');
    queue.enqueue('b');
    await queue.idle();
    expect(repo.setFailed).toHaveBeenCalledWith('a', 'TRANSCRIPTION_UNAVAILABLE');
    expect(repo.setFailed).toHaveBeenCalledWith('b', 'ATTACHMENT_INVALID');
    expect(onDone.mock.calls.map((c) => [c[0].id, c[0].status, c[0].error_code])).toEqual([['a', 'failed', 'TRANSCRIPTION_UNAVAILABLE'], ['b', 'failed', 'ATTACHMENT_INVALID']]);
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/SEGREDO|10\.0\.0\.1/);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('a file that is gone fails the row as ATTACHMENT_INVALID; a row that is gone or already done is skipped', async () => {
    const extractImpl = vi.fn(async () => ({ text: 'x', meta: {} })) as unknown as typeof extract;
    const { queue, onDone, repo } = build([row({ id: 'gone' }), row({ id: 'done', status: 'ready' })], extractImpl);
    queue.enqueue('gone');
    queue.enqueue('done');
    queue.enqueue('missing');
    await queue.idle();
    expect(repo.setFailed).toHaveBeenCalledWith('gone', 'ATTACHMENT_INVALID');
    expect(extractImpl).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a job whose row was deleted mid-extraction publishes nothing', async () => {
    const { queue, onDone, store } = build([row({ id: 'a' })], (async () => {
      store.delete('a');
      return { text: 'x', meta: {} };
    }) as unknown as typeof extract);
    queue.enqueue('a');
    await queue.idle();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('requeuePending re-enqueues every pending row on boot and dedupes an id already queued', async () => {
    const extractImpl = vi.fn(async () => ({ text: 'x', meta: {} })) as unknown as typeof extract;
    const { queue, repo } = build([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', status: 'ready' })], extractImpl);
    queue.enqueue('a');
    expect(await requeuePending(queue, repo)).toBe(2);
    await queue.idle();
    expect(extractImpl).toHaveBeenCalledTimes(2);
  });
});
