import { describe, expect, it, vi } from 'vitest';
import type { AttachmentRow, ChatAttachmentsRepo } from '../../db/repositories/chat-attachments.js';
import type { AttachmentStore, StoredFile } from './store.js';
import { ORPHAN_MIN_AGE_MS, UNSENT_MAX_AGE_MS, sweepAttachments } from './sweep.js';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: 'at1', user_id: 'u1', conversation_id: 'c1', message_id: null, name: 'a.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 3, sha256: 'h',
  status: 'ready', error_code: null, extracted_text: null, meta: null, created_at: ago(2 * UNSENT_MAX_AGE_MS).toISOString(), ...over,
});

function build(opts: { existing: string[]; stale: AttachmentRow[]; files: StoredFile[] }) {
  const repo = {
    existingIds: vi.fn(async (ids: string[]) => new Set(ids.filter((id) => opts.existing.includes(id)))),
    listStaleUnsent: vi.fn(async () => opts.stale),
    deleteUnsent: vi.fn(async () => true),
  } as unknown as ChatAttachmentsRepo;
  const store = {
    listAll: async function* () {
      yield* opts.files;
    },
    remove: vi.fn(async () => undefined),
  } as unknown as AttachmentStore;
  const log = { warn: vi.fn(), info: vi.fn() };
  return { repo, store, log };
}

describe('sweepAttachments', () => {
  it('removes unsent rows older than 24 h with their files', async () => {
    const { repo, store, log } = build({ existing: ['old', 'fresh'], stale: [row({ id: 'old' })], files: [] });
    expect(await sweepAttachments({ repo, store, log }, NOW)).toEqual({ stale: 1, orphans: 0 });
    expect(repo.listStaleUnsent).toHaveBeenCalledWith(ago(UNSENT_MAX_AGE_MS));
    expect(store.remove).toHaveBeenCalledWith('u1', 'old');
    expect(repo.deleteUnsent).toHaveBeenCalledWith('old', 'u1');
  });

  it('claims the row first: one bound by a send meanwhile keeps its file and is not counted', async () => {
    const { repo, store, log } = build({ existing: [], stale: [row({ id: 'taken' }), row({ id: 'old' })], files: [] });
    vi.mocked(repo.deleteUnsent).mockImplementation(async (id: string) => id !== 'taken');
    expect(await sweepAttachments({ repo, store, log }, NOW)).toEqual({ stale: 1, orphans: 0 });
    expect(vi.mocked(store.remove).mock.calls).toEqual([['u1', 'old']]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('removes a file with no row only once it is older than an hour, and a stale temp file', async () => {
    const files: StoredFile[] = [
      { userId: 'u1', id: 'kept', modifiedAt: ago(5 * ORPHAN_MIN_AGE_MS), temp: false },
      { userId: 'u1', id: 'orphan', modifiedAt: ago(2 * ORPHAN_MIN_AGE_MS), temp: false },
      { userId: 'u1', id: 'young', modifiedAt: ago(ORPHAN_MIN_AGE_MS / 2), temp: false },
      { userId: 'u2', id: 'half', modifiedAt: ago(2 * ORPHAN_MIN_AGE_MS), temp: true },
      { userId: 'u2', id: 'writing', modifiedAt: ago(1000), temp: true },
    ];
    const { repo, store, log } = build({ existing: ['kept'], stale: [], files });
    expect(await sweepAttachments({ repo, store, log }, NOW)).toEqual({ stale: 0, orphans: 2 });
    expect(vi.mocked(store.remove).mock.calls).toEqual([['u2', 'half'], ['u1', 'orphan']]);
    expect(repo.existingIds).toHaveBeenCalledWith(['kept', 'orphan']); // one batch for every old, non-temp file; the young one is never asked about
  });

  it('one failing removal is logged by id and does not stop the rest', async () => {
    const { repo, store, log } = build({ existing: [], stale: [row({ id: 'a' }), row({ id: 'b' })], files: [] });
    vi.mocked(store.remove).mockRejectedValueOnce(new Error('EACCES /data/chat-files/u1/a'));
    expect(await sweepAttachments({ repo, store, log }, NOW)).toEqual({ stale: 1, orphans: 0 });
    expect(log.warn).toHaveBeenCalledWith({ attachmentId: 'a', err: 'Error' }, 'attachment sweep: could not remove');
    expect(repo.deleteUnsent).toHaveBeenCalledWith('b', 'u1');
  });
});
