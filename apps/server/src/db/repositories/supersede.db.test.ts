import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatDecisionsRepository, type NewDecision } from './chat-decisions.js';
import { MemoryItemsRepository, type NewMemoryItem } from './memory-items.js';

const DIM = 384;
/** A unit vector with a 1 at index `i` (cosine 1 to itself, 0 to any other `vec(j)`). */
const vec = (i: number): number[] => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
/** A unit blend of `vec(i)` and `vec(j)`, weight `w` on `i`. */
const mix = (i: number, j: number, w: number): number[] => {
  const raw = Array.from({ length: DIM }, (_, k) => (k === i ? w : k === j ? 1 - w : 0));
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  return raw.map((x) => x / norm);
};

/** TER-1015: replacing notes and card decisions, the conflict lookups and what a replaced row leaves. */
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('supersede (Postgres)', () => {
  let db: PrismaClient;
  let items: MemoryItemsRepository;
  let decisions: ChatDecisionsRepository;
  let userId: string;
  let otherUserId: string;
  let projectId: string;
  let project2Id: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    items = new MemoryItemsRepository(db);
    decisions = new ChatDecisionsRepository(db);
    userId = newId();
    otherUserId = newId();
    projectId = newId();
    project2Id = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    const key = (p: string, id: string) => `${p}${id.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
    await db.project.create({ data: { id: projectId, key: key('S', projectId), name: 'proj', ownerId: userId } });
    await db.project.create({ data: { id: project2Id, key: key('T', project2Id), name: 'proj2', ownerId: userId } });
  });

  afterAll(async () => {
    await db.chatDecision.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await db.project.deleteMany({ where: { id: { in: [projectId, project2Id] } } });
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await db.$disconnect();
  });

  const note = (over: Partial<NewMemoryItem> = {}): NewMemoryItem => {
    const id = newId();
    return { id, owner_id: userId, project_id: projectId, kind: 'note', source_id: id, chunk_index: 0, title: 'Pode mesclar sozinho?', text: 'Decisão: Sim', trust: 'derived', source_at: new Date(), ...over };
  };
  const newDecision = (over: Partial<NewDecision> = {}): NewDecision => ({
    user_id: userId,
    project_id: projectId,
    conversation_id: null,
    tab_question_id: null,
    question_index: 0,
    header: 'Merge',
    question: 'Pode mesclar sozinho?',
    options: [{ label: 'Sim', description: '' }, { label: 'Não', description: '' }],
    multi_select: false,
    answer: { labels: ['Sim'] },
    ...over,
  });
  const opts = { embedModel: 'm', minSimilarity: 0.8, k: 5 };

  it('old rows read as current: superseded_at and supersedes are null without any backfill', async () => {
    const [row] = await items.upsertMany([note()]);
    expect(row).toMatchObject({ supersedes: null, superseded_at: null });
    const [d] = await decisions.insertMany([newDecision()]);
    expect(d!.superseded_at).toBeNull();
  });

  it('insertNoteSuperseding marks the old note and writes the new one with its ref, in one go; the old one leaves search and the conflict check', async () => {
    const marker = `marcador${newId()}`;
    const [old] = await items.upsertMany([note({ text: `Decisão: Sim ${marker}` })]);
    await items.setEmbedding(old!.id, vec(10), 'm');
    expect((await items.similarNotes(userId, projectId, mix(10, 11, 0.9), opts)).map((n) => n.id)).toContain(old!.id);

    const replacement = await items.insertNoteSuperseding(note({ text: `Decisão: Não ${marker}` }), { kind: 'note', id: old!.id });
    expect(replacement).toMatchObject({ supersedes: `note:${old!.id}`, superseded_at: null });
    await items.setEmbedding(replacement!.id, vec(10), 'm');

    const [stored] = await items.findManyForOwner([old!.id], userId);
    expect(stored!.superseded_at).not.toBeNull();
    // out of the default search and of the conflict check; back with includeSuperseded
    expect((await items.similarNotes(userId, projectId, vec(10), opts)).map((n) => n.id)).toEqual([replacement!.id]);
    expect((await items.textSearch({ ownerId: userId }, marker, 10)).map((r) => r.id)).toEqual([replacement!.id]);
    expect((await items.nearest({ ownerId: userId }, vec(10), 10)).map((r) => r.id)).not.toContain(old!.id);
    expect((await items.textSearch({ ownerId: userId, includeSuperseded: true }, marker, 10)).map((r) => r.id).sort()).toEqual([old!.id, replacement!.id].sort());

    // a second replacement of the same note finds nothing to replace, and writes nothing
    const again = note({ text: `Decisão: Talvez ${marker}` });
    expect(await items.insertNoteSuperseding(again, { kind: 'note', id: old!.id })).toBeNull();
    expect(await items.findManyForOwner([again.id!], userId)).toEqual([]);
  });

  it('insertNoteSuperseding never touches another owner\'s note', async () => {
    const [foreign] = await items.upsertMany([note({ owner_id: otherUserId, project_id: null })]);
    const mine = note();
    expect(await items.insertNoteSuperseding(mine, { kind: 'note', id: foreign!.id })).toBeNull();
    expect((await items.findManyForOwner([foreign!.id], otherUserId))[0]!.superseded_at).toBeNull();
    expect(await items.findManyForOwner([mine.id!], userId)).toEqual([]);
  });

  it('similarNotes keeps to the same scope (project, or account-wide), the threshold and the model', async () => {
    const [here] = await items.upsertMany([note()]);
    const [other] = await items.upsertMany([note({ project_id: project2Id })]);
    const [wide] = await items.upsertMany([note({ project_id: null })]);
    const [far] = await items.upsertMany([note()]);
    const [otherModel] = await items.upsertMany([note()]);
    for (const r of [here, other, wide]) await items.setEmbedding(r!.id, vec(20), 'm');
    await items.setEmbedding(far!.id, mix(20, 21, 0.5), 'm'); // cosine ≈ 0.71
    await items.setEmbedding(otherModel!.id, vec(20), 'other');
    expect((await items.similarNotes(userId, projectId, vec(20), opts)).map((n) => n.id)).toEqual([here!.id]);
    expect((await items.similarNotes(userId, null, vec(20), opts)).map((n) => n.id)).toEqual([wide!.id]);
    expect(await items.similarNotes(otherUserId, projectId, vec(20), opts)).toEqual([]);
  });

  it('a card decision replaced by a note never backs a suggestion or an automatic answer again, and leaves the default search', async () => {
    const marker = `marcador${newId()}`;
    const [d] = await decisions.insertMany([newDecision({ question: `Pode mesclar sozinho ${marker}?` })]);
    await decisions.setEmbedding(d!.id, vec(30), 'm#q1');
    expect((await decisions.similarInScope(userId, projectId, vec(30), { ...opts, embedModel: 'm#q1' })).map((x) => x.id)).toEqual([d!.id]);

    const n = await items.insertNoteSuperseding(note(), { kind: 'decision', id: d!.id });
    expect(n!.supersedes).toBe(`decision:${d!.id}`);

    const [after] = await decisions.findManyForUser([d!.id], userId);
    expect(after!.superseded_at).not.toBeNull(); // still readable, for "Memória do chat" and citations
    expect(await decisions.similarInScope(userId, projectId, vec(30), { ...opts, embedModel: 'm#q1' })).toEqual([]);
    expect(await decisions.nearest(userId, vec(30), { multiSelect: false, k: 10, embedModel: 'm#q1' })).toEqual([]);
    expect((await decisions.similarityTo([d!.id], userId, vec(30), 'm#q1')).size).toBe(0);
    expect(await decisions.textSearch(userId, marker, 10)).toEqual([]);
    expect((await decisions.nearestAny(userId, vec(30), 10)).map((x) => x.id)).not.toContain(d!.id);
    expect((await decisions.textSearch(userId, marker, 10, undefined, true)).map((x) => x.id)).toEqual([d!.id]);
    expect((await decisions.nearestAny(userId, vec(30), 10, undefined, true)).map((x) => x.id)).toContain(d!.id);

    // already replaced: a second note cannot replace it again
    expect(await items.insertNoteSuperseding(note(), { kind: 'decision', id: d!.id })).toBeNull();
  });
});
