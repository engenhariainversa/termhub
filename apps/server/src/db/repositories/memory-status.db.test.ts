import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatDecisionsRepository, type NewDecision } from './chat-decisions.js';
import { MemoryItemsRepository, type NewMemoryItem } from './memory-items.js';
import { MemoryStatusRepository } from './memory-status.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('MemoryStatusRepository (Postgres, TER-1013)', () => {
  let db: PrismaClient;
  let status: MemoryStatusRepository;
  let decisions: ChatDecisionsRepository;
  let items: MemoryItemsRepository;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    status = new MemoryStatusRepository(db);
    decisions = new ChatDecisionsRepository(db);
    items = new MemoryItemsRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades decisions and memory items
    await db.$disconnect();
  });

  /** A word no other test writes, so the full-text searches below only see this test's rows. */
  const word = () => `palavra${newId().replace(/[^a-z]/g, '')}`;

  const newDecision = async (question: string, owner = userId) => {
    const row: NewDecision = {
      user_id: owner,
      project_id: null,
      conversation_id: null,
      tab_question_id: null,
      question_index: 0,
      header: 'Fonte',
      question,
      options: [{ label: 'Azul', description: '' }, { label: 'Verde', description: '' }],
      multi_select: false,
      answer: { labels: ['Azul'] },
    };
    const [d] = await decisions.insertMany([row]);
    return d!;
  };

  const newNote = async (text: string, owner = userId) => {
    const it: NewMemoryItem = {
      owner_id: owner,
      project_id: null,
      kind: 'note',
      source_id: newId(),
      chunk_index: 0,
      title: text,
      text,
      trust: 'derived',
      source_at: new Date('2026-10-01T00:00:00.000Z'),
    };
    const [n] = await items.upsertMany([it]);
    return n!;
  };

  const decisionStatus = async (id: string) => (await decisions.findManyForUser([id], userId))[0]!;
  const noteStatus = async (id: string) => (await items.findManyForOwner([id], userId))[0]!;

  it('desatualizada: out of the default search, back in with includeInactive, and undone by current', async () => {
    const w = word();
    const d = await newDecision(`Usar ${w}?`);
    expect((await decisions.textSearch(userId, w, 10)).map((r) => r.id)).toEqual([d.id]);

    expect(await status.setStatus(userId, { kind: 'decision', id: d.id }, 'outdated')).toBe('ok');
    const marked = await decisionStatus(d.id);
    expect(marked.status).toBe('outdated');
    expect(marked.expires_at).not.toBeNull();
    expect(await decisions.textSearch(userId, w, 10)).toEqual([]);
    expect((await decisions.textSearch(userId, w, 10, undefined, { includeInactive: true })).map((r) => r.id)).toEqual([d.id]);

    expect(await status.setStatus(userId, { kind: 'decision', id: d.id }, 'current')).toBe('ok');
    const undone = await decisionStatus(d.id);
    expect(undone.status).toBe('current');
    expect(undone.expires_at).toBeNull();
    expect((await decisions.textSearch(userId, w, 10)).map((r) => r.id)).toEqual([d.id]);
  });

  it('errada on a note: out of the default search; a later mark replaces it instead of piling up', async () => {
    const w = word();
    const n = await newNote(`Anotação ${w}`);
    expect(await status.setStatus(userId, { kind: 'note', id: n.id }, 'wrong')).toBe('ok');
    expect((await noteStatus(n.id)).status).toBe('wrong');
    expect(await items.textSearch({ ownerId: userId, kinds: ['note'] }, w, 10)).toEqual([]);
    expect((await items.textSearch({ ownerId: userId, kinds: ['note'], includeInactive: true }, w, 10)).map((r) => r.id)).toEqual([n.id]);

    expect(await status.setStatus(userId, { kind: 'note', id: n.id }, 'outdated')).toBe('ok');
    expect((await noteStatus(n.id)).status).toBe('outdated');
    const row = await db.memoryItem.findUnique({ where: { id: n.id } });
    expect(row!.wrongAt).toBeNull();
  });

  it('a re-index of a marked note keeps its mark', async () => {
    const n = await newNote(`Anotação ${word()}`);
    await status.setStatus(userId, { kind: 'note', id: n.id }, 'wrong');
    await items.upsertMany([{ owner_id: userId, project_id: null, kind: 'note', source_id: n.source_id, chunk_index: 0, title: 'Outro', text: 'Outro', trust: 'derived', source_at: new Date() }]);
    expect((await noteStatus(n.id)).status).toBe('wrong');
  });

  it('substituída por: links the replacement across tables, lists it, and undo clears both sides', async () => {
    const old = await newDecision(`Usar ${word()}?`);
    const replacement = await newNote(`Anotação ${word()}`);
    expect(await status.setStatus(userId, { kind: 'decision', id: old.id }, 'superseded', { kind: 'note', id: replacement.id })).toBe('ok');
    expect((await decisionStatus(old.id)).status).toBe('superseded');
    expect((await noteStatus(replacement.id)).supersedes).toBe(`decision:${old.id}`);
    expect((await noteStatus(replacement.id)).status).toBe('current');
    const by = await status.supersedersOf(userId, [`decision:${old.id}`]);
    expect(by.get(`decision:${old.id}`)).toEqual({ ref: `note:${replacement.id}`, title: replacement.title });

    expect(await status.setStatus(userId, { kind: 'decision', id: old.id }, 'current')).toBe('ok');
    expect((await decisionStatus(old.id)).status).toBe('current');
    expect((await noteStatus(replacement.id)).supersedes).toBeNull();
  });

  it('refuses itself, a replacement already taken, a two-item loop and someone else\'s rows', async () => {
    const a = await newDecision(`Usar ${word()}?`);
    const b = await newDecision(`Usar ${word()}?`);
    const c = await newDecision(`Usar ${word()}?`);
    const strangers = await newDecision(`Usar ${word()}?`, otherUserId);
    const A = { kind: 'decision' as const, id: a.id };
    const B = { kind: 'decision' as const, id: b.id };
    const C = { kind: 'decision' as const, id: c.id };

    expect(await status.setStatus(userId, A, 'superseded', A)).toBe('self');
    expect(await status.setStatus(userId, A, 'superseded')).toBe('replacement_not_found');
    expect(await status.setStatus(userId, A, 'superseded', { kind: 'decision', id: strangers.id })).toBe('replacement_not_found');
    expect(await status.setStatus(userId, { kind: 'decision', id: strangers.id }, 'wrong')).toBe('not_found');
    expect(await status.setStatus(otherUserId, A, 'wrong')).toBe('not_found');

    expect(await status.setStatus(userId, A, 'superseded', B)).toBe('ok'); // B replaces A
    expect(await status.setStatus(userId, C, 'superseded', B)).toBe('replacement_taken');
    expect(await status.setStatus(userId, B, 'superseded', A)).toBe('cycle');
    expect((await decisionStatus(c.id)).status).toBe('current');
    expect((await decisionStatus(b.id)).status).toBe('current');
  });
});
