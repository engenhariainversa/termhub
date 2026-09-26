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
