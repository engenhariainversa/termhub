import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatRepository } from './chat.js';
import { ChatAttachmentsRepository, type CreateAttachmentInput } from './chat-attachments.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatAttachmentsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatAttachmentsRepository;
  let chat: ChatRepository;
  let userId: string;
  let otherUserId: string;
  let conversationId: string;
  let otherConversationId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatAttachmentsRepository(db);
    chat = new ChatRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    conversationId = (await chat.getOrCreateForUser(userId)).id;
    otherConversationId = (await chat.getOrCreateForUser(otherUserId)).id;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades conversations, messages and attachments
    await db.$disconnect();
  });

  const input = (over: Partial<CreateAttachmentInput> = {}): CreateAttachmentInput => ({
    id: newId(), user_id: userId, conversation_id: conversationId, name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 100, sha256: 'h', meta: null, ...over,
  });

  it('creates a pending row and finds it for its owner only', async () => {
    const a = await repo.create(input({ bytes: 7 }));
    expect(a.status).toBe('pending');
    expect(a.message_id).toBeNull();
    expect((await repo.findForUser(a.id, userId))?.id).toBe(a.id);
    expect(await repo.findForUser(a.id, otherUserId)).toBeNull();
    expect((await repo.findById(a.id))?.bytes).toBe(7);
  });

  it('attach binds only the eligible ids and the message read carries them', async () => {
    const ok = await repo.create(input());
    const elsewhere = await repo.create(input({ conversation_id: otherConversationId, user_id: otherUserId }));
    const invalid = await repo.create(input());
    await repo.setFailed(invalid.id, 'ATTACHMENT_INVALID');
    const noTranscript = await repo.create(input({ kind: 'audio', mime: 'audio/ogg' }));
    await repo.setFailed(noTranscript.id, 'TRANSCRIPTION_UNAVAILABLE');
    const message = await chat.addMessage({ conversation_id: conversationId, role: 'user', text: '' });

    expect(await repo.attach([ok.id, elsewhere.id, invalid.id, noTranscript.id], message.id, userId, conversationId)).toBe(2);
    expect((await repo.listForMessages([message.id])).map((r) => r.id).sort()).toEqual([ok.id, noTranscript.id].sort());
    // Already sent: a second message cannot take it.
    expect(await repo.attach([ok.id], message.id, userId, conversationId)).toBe(0);

    const messages = await chat.listMessages(conversationId);
    const mine = messages.find((m) => m.id === message.id)!;
    expect(mine.attachments?.map((a) => a.id).sort()).toEqual([ok.id, noTranscript.id].sort());
    expect(mine.attachments?.[0]).not.toHaveProperty('extracted_text');
    expect(messages.filter((m) => m.id !== message.id).every((m) => m.attachments === undefined)).toBe(true);
  });

  it('setExtracted stores the text and meta, setFailed the code; both answer null for a row that is gone', async () => {
    const a = await repo.create(input());
    const ready = await repo.setExtracted(a.id, 'texto', { pages: 3, truncated: false });
    expect(ready).toMatchObject({ status: 'ready', extracted_text: 'texto', meta: { pages: 3, truncated: false }, error_code: null });
    const failed = await repo.setFailed(a.id, 'TRANSCRIPTION_FAILED');
    expect(failed).toMatchObject({ status: 'failed', error_code: 'TRANSCRIPTION_FAILED' });
    expect(await repo.setExtracted('nope00000000', null, null)).toBeNull();
    expect(await repo.setFailed('nope00000000', 'ATTACHMENT_INVALID')).toBeNull();
  });

  it('deleteUnsent removes an unsent row of the owner and refuses a sent one or a stranger', async () => {
    const unsent = await repo.create(input());
    const sent = await repo.create(input());
    const message = await chat.addMessage({ conversation_id: conversationId, role: 'user', text: 'x' });
    await repo.attach([sent.id], message.id, userId, conversationId);
    expect(await repo.deleteUnsent(unsent.id, otherUserId)).toBe(false);
    expect(await repo.deleteUnsent(unsent.id, userId)).toBe(true);
    expect(await repo.findById(unsent.id)).toBeNull();
    expect(await repo.deleteUnsent(sent.id, userId)).toBe(false);
  });

  it('usageBytes sums the user rows only', async () => {
    const before = await repo.usageBytes(userId);
    await repo.create(input({ bytes: 1000 }));
    await repo.create(input({ bytes: 500, user_id: otherUserId, conversation_id: otherConversationId }));
    expect(await repo.usageBytes(userId)).toBe(before + 1000);
  });

  it('usageBytes stays a correct JS number past 2^31 (the quota is 2 147 483 648)', async () => {
    const heavy = newId();
    await db.user.create({ data: { id: heavy, email: `${heavy}@test.local`, name: 'heavy' } });
    const heavyConversation = (await chat.getOrCreateForUser(heavy)).id;
    await repo.create(input({ bytes: 1_500_000_000, user_id: heavy, conversation_id: heavyConversation }));
    await repo.create(input({ bytes: 1_500_000_000, user_id: heavy, conversation_id: heavyConversation }));
    const total = await repo.usageBytes(heavy);
    expect(typeof total).toBe('number');
    expect(total).toBe(3_000_000_000);
    await db.user.delete({ where: { id: heavy } });
  });

  it('lists pending rows, stale unsent rows by age, and which ids still exist', async () => {
    const fresh = await repo.create(input());
    const old = await repo.create(input());
    await db.chatAttachment.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
    const pending = await repo.listPending();
    expect(pending.map((r) => r.id)).toEqual(expect.arrayContaining([fresh.id, old.id]));
    const stale = await repo.listStaleUnsent(new Date(Date.now() - 24 * 60 * 60 * 1000));
    expect(stale.map((r) => r.id)).toContain(old.id);
    expect(stale.map((r) => r.id)).not.toContain(fresh.id);
    expect(await repo.existingIds([fresh.id, 'nope00000000'])).toEqual(new Set([fresh.id]));
  });

  it('a deleted message takes its attachments with it', async () => {
    const a = await repo.create(input());
    const message = await chat.addMessage({ conversation_id: conversationId, role: 'user', text: 'x' });
    await repo.attach([a.id], message.id, userId, conversationId);
    await chat.deleteMessage(message.id);
    expect(await repo.findById(a.id)).toBeNull();
  });
});
