import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../prisma.js';
import { ChatAttachmentsRepository, isAttachable, mapAttachment, toPublicAttachment, type AttachmentRow } from './chat-attachments.js';

const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: 'at1', user_id: 'u1', conversation_id: 'c1', message_id: null, name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 10,
  sha256: 'abc', status: 'pending', error_code: null, extracted_text: null, meta: null, created_at: '2026-09-26T12:00:00.000Z', ...over,
});

describe('isAttachable', () => {
  it('is this conversation, unsent, and not an invalid file', () => {
    expect(isAttachable(row(), 'c1')).toBe(true);
    expect(isAttachable(row({ status: 'pending' }), 'c1')).toBe(true);
    expect(isAttachable(row({ status: 'failed', error_code: 'TRANSCRIPTION_UNAVAILABLE' }), 'c1')).toBe(true);
    expect(isAttachable(row({ conversation_id: 'c2' }), 'c1')).toBe(false);
    expect(isAttachable(row({ message_id: 'm1' }), 'c1')).toBe(false);
    expect(isAttachable(row({ status: 'failed', error_code: 'ATTACHMENT_INVALID' }), 'c1')).toBe(false);
  });
});

it('toPublicAttachment drops the owner, the hash and the text', () => {
  const pub = toPublicAttachment(row({ extracted_text: 'SEGREDO', meta: { pages: 2 } }));
  expect(pub).toEqual({ id: 'at1', name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 10, status: 'pending', error_code: null, meta: { pages: 2 }, created_at: '2026-09-26T12:00:00.000Z' });
  expect(JSON.stringify(pub)).not.toMatch(/SEGREDO|abc|u1|c1/);
});

it('toPublicAttachment strips the queue\'s attempt counter from meta', () => {
  expect(toPublicAttachment(row({ status: 'failed', error_code: 'ATTACHMENT_INVALID', meta: { attempts: 2 } })).meta).toEqual({});
  expect(toPublicAttachment(row({ meta: { width: 3, attempts: 1 } })).meta).toEqual({ width: 3 });
  expect(toPublicAttachment(row({ meta: null })).meta).toBeNull();
  expect(toPublicAttachment(row({ meta: { pages: 2 } })).meta).toEqual({ pages: 2 });
});

it('mapAttachment turns the Prisma row into snake_case with an ISO date', () => {
  const mapped = mapAttachment({
    id: 'at1', userId: 'u1', conversationId: 'c1', messageId: 'm1', name: 'a.txt', mime: 'text/plain; charset=utf-8', kind: 'text', bytes: 3, sha256: 'h',
    status: 'ready', errorCode: null, extractedText: 'abc', meta: { truncated: false }, createdAt: new Date('2026-09-26T12:00:00.000Z'),
  });
  expect(mapped).toMatchObject({ user_id: 'u1', conversation_id: 'c1', message_id: 'm1', extracted_text: 'abc', meta: { truncated: false }, created_at: '2026-09-26T12:00:00.000Z' });
});

it('attach binds only this user, this conversation, unsent, not-invalid rows, in one conditional update', async () => {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const repo = new ChatAttachmentsRepository({ chatAttachment: { updateMany } } as unknown as PrismaClient);
  expect(await repo.attach(['a1', 'a2'], 'm1', 'u1', 'c1')).toBe(1);
  expect(updateMany).toHaveBeenCalledWith({
    where: { id: { in: ['a1', 'a2'] }, userId: 'u1', conversationId: 'c1', messageId: null, OR: [{ status: { not: 'failed' } }, { errorCode: null }, { errorCode: { not: 'ATTACHMENT_INVALID' } }] },
    data: { messageId: 'm1' },
  });
});

it('detach unbinds every attachment of one message, answering how many', async () => {
  const updateMany = vi.fn(async () => ({ count: 2 }));
  const repo = new ChatAttachmentsRepository({ chatAttachment: { updateMany } } as unknown as PrismaClient);
  expect(await repo.detach('m1')).toBe(2);
  expect(updateMany).toHaveBeenCalledWith({ where: { messageId: 'm1' }, data: { messageId: null } });
});

it('markAttempt bumps meta.attempts in one conditional update and answers the count, or null for a row that is gone or done', async () => {
  const queryRaw = vi.fn(async () => [{ attempts: 2 }]);
  const repo = new ChatAttachmentsRepository({ $queryRaw: queryRaw } as unknown as PrismaClient);
  expect(await repo.markAttempt('a1')).toBe(2);
  const [strings, ...values] = queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
  const sql = strings.join('?');
  expect(sql).toMatch(/UPDATE "?chat_attachments"?/);
  expect(sql).toMatch(/status = 'pending'/);
  expect(sql).toMatch(/attempts/);
  expect(values).toEqual(['a1']);
  queryRaw.mockResolvedValueOnce([]);
  expect(await repo.markAttempt('gone')).toBeNull();
});

it('listPending takes an age: only rows created before it', async () => {
  const findMany = vi.fn(async () => []);
  const repo = new ChatAttachmentsRepository({ chatAttachment: { findMany } } as unknown as PrismaClient);
  const olderThan = new Date('2026-09-26T12:00:00.000Z');
  await repo.listPending(olderThan);
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'pending', createdAt: { lt: olderThan } } }));
  await repo.listPending();
  expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { status: 'pending' } }));
});
