import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { MemoryItemsRepository, type LessonMeta, type NewMemoryItem } from './memory-items.js';

const DIM = 384;
/** A unit vector with a 1 at index `i`: cosine similarity to itself is exactly 1, and to another such
 *  vector (a different `i`) exactly 0 — so `nearest`'s ordering and `similarity` are exact, not fuzzy. */
const vec = (i: number): number[] => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
/** A normalised blend of `vec(i)` and `vec(j)`, weight `w` on `i`: still a unit vector, so its cosine
 *  similarity to `vec(i)` is exactly `w / sqrt(w^2 + (1-w)^2)` — closer to 1 than an unrelated vector. */
const mix = (i: number, j: number, w: number): number[] => {
  const raw = Array.from({ length: DIM }, (_, k) => (k === i ? w : k === j ? 1 - w : 0));
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  return raw.map((x) => x / norm);
};

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('MemoryItemsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: MemoryItemsRepository;
  let userId: string;
  let otherUserId: string;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new MemoryItemsRepository(db);
    userId = newId();
    otherUserId = newId();
    projectId = newId();
    otherProjectId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    await db.project.create({ data: { id: projectId, key: `M${projectId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'proj', ownerId: userId } });
    await db.project.create({ data: { id: otherProjectId, key: `N${otherProjectId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'proj2', ownerId: otherUserId } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades their memory_items
    await db.$disconnect();
  });

  const item = (over: Partial<NewMemoryItem> = {}): NewMemoryItem => ({
    owner_id: userId,
    project_id: projectId,
    kind: 'note',
    source_id: newId(),
    chunk_index: 0,
    title: 'Título',
    text: 'Texto',
    trust: 'derived',
    source_at: new Date('2026-09-26T00:00:00.000Z'),
    ...over,
  });

  it('upsertMany inserts (needs embedding); same content keeps the embedding; changed content clears it', async () => {
    const sourceId = newId();
    const [row] = await repo.upsertMany([item({ source_id: sourceId, title: 'Config', text: 'Usar git worktree isolado' })]);
    expect(row).toMatchObject({
      owner_id: userId,
      project_id: projectId,
      project_name: 'proj',
      kind: 'note',
      source_id: sourceId,
      chunk_index: 0,
      title: 'Config',
      text: 'Usar git worktree isolado',
      trust: 'derived',
      source_hash: null,
      embed_model: null,
    });
    expect(row!.id).toBeTruthy();
    expect(row!.content_hash).toBeTruthy();
    const id = row!.id;

    await repo.setEmbedding(id, vec(1), 'm');
    expect((await repo.listToEmbed(1000)).map((r) => r.id)).not.toContain(id);

    // Same title+text again: the embedding is kept (not returned — needs_embedding is false).
    expect(await repo.upsertMany([item({ source_id: sourceId, title: 'Config', text: 'Usar git worktree isolado' })])).toEqual([]);
    expect((await repo.listToEmbed(1000)).map((r) => r.id)).not.toContain(id);

    // Changed text: content_hash changes, the embedding is cleared, source_at updates.
    const newAt = new Date('2026-09-27T00:00:00.000Z');
    const [updated] = await repo.upsertMany([item({ source_id: sourceId, title: 'Config', text: 'Usar outra coisa', source_at: newAt })]);
    expect(updated).toMatchObject({ id, title: 'Config', text: 'Usar outra coisa', source_at: newAt.toISOString() });
    expect((await repo.listToEmbed(1000)).map((r) => r.id)).toContain(id);
  });

  it('upsertMany (fix round 1): owner_id follows the caller on conflict, not just title/text/project_id', async () => {
    const sourceId = newId();
    const [row] = await repo.upsertMany([item({ owner_id: userId, source_id: sourceId, title: 'Card', text: 'Body' })]);
    expect(row!.owner_id).toBe(userId);

    // The project this item came from changed owner: re-indexing it with the new owner_id must update
    // the existing row in place — otherwise it would keep showing up in the old owner's search (and
    // never the new owner's) until some other, unrelated write happened to touch it.
    const [moved] = await repo.upsertMany([item({ owner_id: otherUserId, source_id: sourceId, title: 'Card', text: 'Body' })]);
    expect(moved!.id).toBe(row!.id); // same row, not a new one
    expect(moved!.owner_id).toBe(otherUserId);

    const stored = await db.memoryItem.findUniqueOrThrow({ where: { id: row!.id } });
    expect(stored.ownerId).toBe(otherUserId);
  });

  it('deleteChunksFrom removes chunks from an index on, keeping the earlier ones; deleteBySource removes every chunk', async () => {
    const sourceId = 'pm1:docs/a.md';
    await repo.upsertMany([0, 1, 2, 3].map((i) => item({ kind: 'doc', source_id: sourceId, chunk_index: i, title: `a.md #${i}`, text: `chunk ${i}` })));
    const removed = await repo.deleteChunksFrom('doc', sourceId, 2);
    expect(removed).toBe(2);
    const remaining = await db.memoryItem.findMany({ where: { sourceId, kind: 'doc' }, orderBy: { chunkIndex: 'asc' } });
    expect(remaining.map((r) => r.chunkIndex)).toEqual([0, 1]);

    const otherSourceId = 'pm1:docs/b.md';
    await repo.upsertMany([item({ kind: 'doc', source_id: otherSourceId, chunk_index: 0, title: 'b.md', text: 'b' })]);
    const deleted = await repo.deleteBySource('doc', [sourceId, otherSourceId]);
    expect(deleted).toBe(3); // 2 remaining of a.md + 1 of b.md
    expect(await db.memoryItem.count({ where: { sourceId: { in: [sourceId, otherSourceId] } } })).toBe(0);
  });

  it('replaceSourceChunks trims the tail and upserts in one transaction: a failing write leaves the old chunks intact', async () => {
    const sourceId = `${newId()}:docs/superpowers/specs/r.md`;
    const doc = (i: number, over: Partial<NewMemoryItem> = {}) => item({ kind: 'doc', source_id: sourceId, chunk_index: i, title: `r.md #${i}`, text: `v1 ${i}`, source_hash: 'a'.repeat(64), ...over });
    await repo.upsertMany([0, 1, 2].map((i) => doc(i)));
    const indexes = async () => (await db.memoryItem.findMany({ where: { kind: 'doc', sourceId }, orderBy: { chunkIndex: 'asc' }, select: { chunkIndex: true, text: true } })).map((r) => [r.chunkIndex, r.text]);

    // A write that fails mid-way (project_id violates the FK) rolls back the tail delete too.
    await expect(repo.replaceSourceChunks('doc', sourceId, [doc(0, { text: 'v2 0', project_id: 'no-such-project' })])).rejects.toBeTruthy();
    expect(await indexes()).toEqual([[0, 'v1 0'], [1, 'v1 1'], [2, 'v1 2']]);

    const inserted = await repo.replaceSourceChunks('doc', sourceId, [doc(0, { text: 'v2 0' })]);
    expect(inserted.map((r) => r.chunk_index)).toEqual([0]);
    expect(await indexes()).toEqual([[0, 'v2 0']]);

    // No chunks at all: every chunk of the source goes.
    await repo.replaceSourceChunks('doc', sourceId, []);
    expect(await indexes()).toEqual([]);
  });

  /** Runs `fn` against a repository bound to a transaction that is always rolled back, so a global
   *  delete never touches rows other test files are writing at the same time. */
  const inRolledBackTx = async (fn: (r: MemoryItemsRepository) => Promise<void>) => {
    const rollback = new Error('rollback');
    await expect(
      db.$transaction(async (tx) => {
        await fn(new MemoryItemsRepository(tx as unknown as PrismaClient));
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  };

  it('deleteDocsNotInLinks keeps doc rows of live links, deletes those of gone links, never other kinds', async () => {
    const live = newId();
    const gone = newId();
    const noteSource = newId();
    await repo.upsertMany([
      item({ kind: 'doc', source_id: `${live}:docs/superpowers/specs/a.md`, title: 'a', text: 'a' }),
      item({ kind: 'doc', source_id: `${gone}:docs/superpowers/specs/b.md`, title: 'b', text: 'b' }),
      item({ kind: 'note', source_id: noteSource, title: 'n', text: 'n' }),
    ]);
    await inRolledBackTx(async (r) => {
      const keep = (await db.memoryItem.findMany({ where: { kind: 'doc' }, select: { sourceId: true } })).map((x) => x.sourceId.split(':')[0]!).filter((id) => id !== gone);
      expect(await r.deleteDocsNotInLinks([...new Set([live, ...keep])])).toBeGreaterThanOrEqual(1);
      const txDb = (r as unknown as { db: PrismaClient }).db;
      const left = (src: string) => txDb.memoryItem.count({ where: { kind: 'doc', sourceId: { startsWith: `${src}:` } } });
      expect(await left(live)).toBeGreaterThan(0);
      expect(await left(gone)).toBe(0);
    });
    await inRolledBackTx(async (r) => {
      const txDb = (r as unknown as { db: PrismaClient }).db;
      await r.deleteDocsNotInLinks([]);
      expect(await txDb.memoryItem.count({ where: { kind: 'doc' } })).toBe(0);
      expect(await txDb.memoryItem.count({ where: { kind: 'note', sourceId: noteSource } })).toBe(1);
    });
  });

  it('deleteDocsNotInLinks (review fix round 1): also deletes file-origin lesson rows of gone links, never a note-origin lesson', async () => {
    const fileMeta = (path: string): LessonMeta => ({ evidence: 'fixed', card: null, pr: null, tags: [], agent: null, tab_id: null, origin: 'file', path });
    const noteMeta: LessonMeta = { evidence: 'fixed', card: null, pr: null, tags: [], agent: null, tab_id: null, origin: 'note', path: null };
    const live = newId();
    const gone = newId();
    const noteLessonSource = `note:${projectId}:${newId()}`;
    await repo.upsertMany([
      item({ kind: 'lesson', source_id: `${live}:docs/lessons/a.md`, title: 'a', text: 'a', meta: fileMeta('docs/lessons/a.md') }),
      item({ kind: 'lesson', source_id: `${gone}:docs/lessons/b.md`, title: 'b', text: 'b', meta: fileMeta('docs/lessons/b.md') }),
      item({ kind: 'lesson', source_id: noteLessonSource, title: 'n', text: 'n', meta: noteMeta }),
    ]);
    await inRolledBackTx(async (r) => {
      const txDb = (r as unknown as { db: PrismaClient }).db;
      const removed = await r.deleteDocsNotInLinks([live]);
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await txDb.memoryItem.count({ where: { kind: 'lesson', sourceId: `${live}:docs/lessons/a.md` } })).toBe(1);
      expect(await txDb.memoryItem.count({ where: { kind: 'lesson', sourceId: `${gone}:docs/lessons/b.md` } })).toBe(0);
      // A note-origin lesson's source_id never starts with a real link id (it starts with the literal
      // "note"), so it would already survive `split_part` alone — but the `meta->>'origin'` guard makes
      // that explicit rather than incidental, and this asserts it directly.
      expect(await txDb.memoryItem.count({ where: { kind: 'lesson', sourceId: noteLessonSource } })).toBe(1);
    });
    await inRolledBackTx(async (r) => {
      const txDb = (r as unknown as { db: PrismaClient }).db;
      await r.deleteDocsNotInLinks([]);
      // Even with an empty link list (every doc/file-lesson row goes), the note-origin lesson survives.
      expect(await txDb.memoryItem.count({ where: { kind: 'lesson', sourceId: `${live}:docs/lessons/a.md` } })).toBe(0);
      expect(await txDb.memoryItem.count({ where: { kind: 'lesson', sourceId: noteLessonSource } })).toBe(1);
    });
  });

  it('listSourceHashes: source_id → source_hash of chunk 0, only under the given prefix, only rows with a hash', async () => {
    await repo.upsertMany([
      item({ kind: 'doc', source_id: 'pm1:docs/a.md', chunk_index: 0, title: 'a', text: 'a', source_hash: 'hash-a' }),
      item({ kind: 'doc', source_id: 'pm1:docs/a.md', chunk_index: 1, title: 'a2', text: 'a2', source_hash: 'hash-a-chunk1' }),
      item({ kind: 'doc', source_id: 'pm1:docs/b.md', chunk_index: 0, title: 'b', text: 'b', source_hash: null }),
      item({ kind: 'doc', source_id: 'pm2:docs/c.md', chunk_index: 0, title: 'c', text: 'c', source_hash: 'hash-c' }),
    ]);
    const hashes = await repo.listSourceHashes('doc', 'pm1:');
    expect(hashes).toEqual(new Map([['pm1:docs/a.md', 'hash-a']]));
    expect(hashes.has('pm1:docs/b.md')).toBe(false); // chunk 0 has no hash
    expect(hashes.has('pm2:docs/c.md')).toBe(false); // different prefix
  });

  it('listSourceAt: source_id → source_at, for this owner and kind only', async () => {
    const sourceId = newId();
    const at = new Date('2026-09-20T00:00:00.000Z');
    await repo.upsertMany([item({ kind: 'task', source_id: sourceId, chunk_index: 0, title: 'Card', text: 'Card body', source_at: at })]);
    const map = await repo.listSourceAt('task', userId);
    expect(map.get(sourceId)).toBe(at.toISOString());
  });

  it('nearest: best match first, scoped to the owner, only embedded rows; projectId and kinds filter', async () => {
    const a = (await repo.upsertMany([item({ title: 'A', text: 'a', kind: 'note' })]))[0]!;
    await repo.setEmbedding(a.id, vec(1), 'm');

    const b = (await repo.upsertMany([item({ title: 'B', text: 'b', kind: 'note' })]))[0]!;
    await repo.setEmbedding(b.id, mix(1, 2, 0.7), 'm');

    const unembedded = (await repo.upsertMany([item({ title: 'U', text: 'u', kind: 'note' })]))[0]!;

    const otherOwnerRow = (await repo.upsertMany([item({ owner_id: otherUserId, project_id: otherProjectId, title: 'O', text: 'o', kind: 'note' })]))[0]!;
    await repo.setEmbedding(otherOwnerRow.id, vec(1), 'm');

    const inOtherProject = (await repo.upsertMany([item({ project_id: null, title: 'P', text: 'p', kind: 'note' })]))[0]!;
    await repo.setEmbedding(inOtherProject.id, mix(1, 3, 0.3), 'm');

    const docKind = (await repo.upsertMany([item({ project_id: projectId, kind: 'doc', source_id: newId(), title: 'D', text: 'd' })]))[0]!;
    await repo.setEmbedding(docKind.id, mix(1, 4, 0.2), 'm');

    const neighbours = await repo.nearest({ ownerId: userId }, vec(1), 10);
    const ids = neighbours.map((n) => n.id);
    expect(ids[0]).toBe(a.id);
    expect(neighbours[0]!.similarity).toBeCloseTo(1, 5);
    expect(neighbours[0]!.rank).toBe(1);
    expect(ids[1]).toBe(b.id);
    expect(neighbours[1]!.rank).toBe(2);
    expect(ids).not.toContain(unembedded.id);
    expect(ids).not.toContain(otherOwnerRow.id);

    const byProject = await repo.nearest({ ownerId: userId, projectId }, vec(1), 10);
    expect(byProject.map((n) => n.id)).not.toContain(inOtherProject.id);

    const byKind = await repo.nearest({ ownerId: userId, kinds: ['doc'] }, vec(1), 10);
    expect(byKind.map((n) => n.id)).toEqual([docKind.id]);
  });

  it('textSearch: matches case-insensitively, never another owner\'s row, similarity null, punctuation-only query returns []', async () => {
    await repo.upsertMany([item({ title: 'Config', text: 'Usar git worktree isolado' })]);
    await repo.upsertMany([item({ owner_id: otherUserId, project_id: otherProjectId, title: 'Config', text: 'Usar git worktree isolado' })]);

    const hits = await repo.textSearch({ ownerId: userId }, 'worktree isolado', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toBe('Config');
    expect(hits[0]!.similarity).toBeNull();
    expect(hits[0]!.rank).toBe(1);
    expect(hits.every((h) => h.owner_id === userId)).toBe(true);

    const upper = await repo.textSearch({ ownerId: userId }, 'WORKTREE', 5);
    expect(upper.map((h) => h.id)).toEqual(hits.map((h) => h.id).slice(0, upper.length));
    expect(upper.length).toBeGreaterThan(0);

    expect(await repo.textSearch({ ownerId: userId }, '!!!', 5)).toEqual([]);
  });

  it('countNotesSince / listNotes / deleteNote', async () => {
    const before = await repo.countNotesSince(userId, new Date(0));
    const [note] = await repo.upsertMany([item({ kind: 'note', source_id: newId(), title: 'Nota', text: 'Decisão do concierge' })]);
    expect(await repo.countNotesSince(userId, new Date(0))).toBe(before + 1);
    expect(await repo.countNotesSince(userId, new Date(Date.now() + 3600_000))).toBe(0); // nothing since the future

    const [taskItem] = await repo.upsertMany([item({ kind: 'task', source_id: newId(), title: 'Card', text: 'Card body' })]);

    const page = await repo.listNotes(userId, { limit: 1000 });
    expect(page.items.map((n) => n.id)).toContain(note!.id);
    expect(page.items.every((n) => n.kind === 'note')).toBe(true);
    // newest first
    const idxNote = page.items.findIndex((n) => n.id === note!.id);
    expect(idxNote).toBeGreaterThanOrEqual(0);

    const page1 = await repo.listNotes(userId, { limit: 1 });
    expect(page1.items.length).toBe(1);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await repo.listNotes(userId, { limit: 1, cursor: page1.next_cursor! });
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);

    expect(await repo.deleteNote(taskItem!.id, userId)).toBe(false); // not a note
    expect(await repo.deleteNote(note!.id, otherUserId)).toBe(false); // not the owner
    expect(await repo.deleteNote(note!.id, userId)).toBe(true);
    expect(await repo.deleteNote(note!.id, userId)).toBe(false); // already gone
  });

  it('findManyForOwner: only this owner\'s rows among the requested ids', async () => {
    const [mine] = await repo.upsertMany([item({ title: 'Mine', text: 'mine' })]);
    const [theirs] = await repo.upsertMany([item({ owner_id: otherUserId, project_id: otherProjectId, title: 'Theirs', text: 'theirs' })]);
    const found = await repo.findManyForOwner([mine!.id, theirs!.id, newId()], userId);
    expect(found.map((r) => r.id)).toEqual([mine!.id]);
  });

  const lessonMeta = (over: Partial<LessonMeta> = {}): LessonMeta => ({
    evidence: 'fixed',
    card: 'TER-205',
    pr: 'https://github.com/example/repo/pull/1',
    tags: ['prisma'],
    agent: 'claude',
    tab_id: null,
    origin: 'file',
    path: 'docs/lessons/2026-09-27-example.md',
    ...over,
  });

  it('upsertMany of a lesson with meta stores and returns it; verified starts false', async () => {
    const sourceId = newId();
    const meta = lessonMeta();
    const [row] = await repo.upsertMany([item({ kind: 'lesson', source_id: sourceId, title: 'P3009 migration', text: 'Sintoma...', meta })]);
    expect(row!.meta).toEqual(meta);
    expect(row!.verified).toBe(false);
    expect(row!.verified_at).toBeNull();

    const [found] = await repo.findManyForOwner([row!.id], userId);
    expect(found!.meta).toEqual(meta);
    expect(found!.verified).toBe(false);
  });

  it('setVerified/clearVerified: verified true on match; hash change drops it; scoped to owner and kind lesson', async () => {
    const sourceId = newId();
    const [lesson] = await repo.upsertMany([item({ kind: 'lesson', source_id: sourceId, title: 'Symptom', text: 'v1', meta: lessonMeta() })]);
    const id = lesson!.id;

    expect(await repo.setVerified(id, userId, otherUserId)).toBe(true);
    const [verified] = await repo.findManyForOwner([id], userId);
    expect(verified!.verified).toBe(true);
    expect(verified!.verified_at).not.toBeNull();

    // Re-upsert with the same text: content_hash unchanged, stays verified.
    await repo.upsertMany([item({ kind: 'lesson', source_id: sourceId, title: 'Symptom', text: 'v1', meta: lessonMeta() })]);
    const [stillVerified] = await repo.findManyForOwner([id], userId);
    expect(stillVerified!.verified).toBe(true);

    // Re-upsert with changed text: content_hash differs, verified drops but verified_at stays set.
    await repo.upsertMany([item({ kind: 'lesson', source_id: sourceId, title: 'Symptom', text: 'v2', meta: lessonMeta() })]);
    const [changed] = await repo.findManyForOwner([id], userId);
    expect(changed!.verified).toBe(false);
    expect(changed!.verified_at).not.toBeNull();

    expect(await repo.clearVerified(id, userId)).toBe(true);
    const [cleared] = await repo.findManyForOwner([id], userId);
    expect(cleared!.verified).toBe(false);
    expect(cleared!.verified_at).toBeNull();
  });

  it('setVerified: false for another owner\'s item, and false for a non-lesson item; nothing changes', async () => {
    const [lesson] = await repo.upsertMany([item({ owner_id: otherUserId, project_id: otherProjectId, kind: 'lesson', title: 'Other', text: 'v1', meta: lessonMeta() })]);
    expect(await repo.setVerified(lesson!.id, userId, userId)).toBe(false);
    const [stillUnverified] = await repo.findManyForOwner([lesson!.id], otherUserId);
    expect(stillUnverified!.verified).toBe(false);

    const [doc] = await repo.upsertMany([item({ kind: 'doc', source_id: newId(), title: 'Doc', text: 'body' })]);
    expect(await repo.setVerified(doc!.id, userId, userId)).toBe(false);
  });

  it('hideSource hides every chunk of the source from nearest/textSearch/listLessons; stays hidden on same content, returns on new content', async () => {
    const sourceId = newId();
    const [chunk0, chunk1] = await repo.upsertMany([0, 1].map((i) => item({ kind: 'lesson', source_id: sourceId, chunk_index: i, title: 'Hide me', text: `chunk ${i} hideme-marker`, meta: lessonMeta() })));
    const chunk0Id = chunk0!.id;
    await repo.setEmbedding(chunk0Id, vec(5), 'm');
    await repo.setEmbedding(chunk1!.id, vec(5), 'm');

    expect(await repo.hideSource(chunk0Id, userId)).toBe(true);

    expect((await repo.nearest({ ownerId: userId }, vec(5), 10)).map((r) => r.id)).not.toContain(chunk0Id);
    expect((await repo.nearest({ ownerId: userId }, vec(5), 10)).map((r) => r.id)).not.toContain(chunk1!.id);
    expect((await repo.textSearch({ ownerId: userId }, 'hideme-marker', 10)).map((r) => r.id)).toEqual([]);
    expect((await repo.listLessons(userId, { limit: 1000 })).items.map((r) => r.id)).not.toContain(chunk0Id);

    // hideSource of an id that doesn't belong to this owner: false, nothing hidden.
    expect(await repo.hideSource(chunk0Id, otherUserId)).toBe(false);

    // Re-upsert with the same content: content_hash unchanged, stays hidden.
    await repo.upsertMany([item({ kind: 'lesson', source_id: sourceId, chunk_index: 0, title: 'Hide me', text: 'chunk 0 hideme-marker', meta: lessonMeta() })]);
    expect((await repo.listLessons(userId, { limit: 1000 })).items.map((r) => r.id)).not.toContain(chunk0Id);

    // Re-upsert with new content: content_hash changes, comes back.
    await repo.upsertMany([item({ kind: 'lesson', source_id: sourceId, chunk_index: 0, title: 'Hide me', text: 'brand new content', meta: lessonMeta() })]);
    expect((await repo.listLessons(userId, { limit: 1000 })).items.map((r) => r.id)).toContain(chunk0Id);
  });

  it('countNoteLessonsSince: only this owner\'s note-origin lessons, chunk 0, created since the given time', async () => {
    const before = await repo.countNoteLessonsSince(userId, new Date(0));
    await repo.upsertMany([item({ kind: 'lesson', source_id: newId(), title: 'Note lesson', text: 'body', meta: lessonMeta({ origin: 'note' }) })]);
    await repo.upsertMany([item({ kind: 'lesson', source_id: newId(), title: 'File lesson', text: 'body', meta: lessonMeta({ origin: 'file' }) })]);
    await repo.upsertMany([item({ owner_id: otherUserId, project_id: otherProjectId, kind: 'lesson', source_id: newId(), title: 'Other note lesson', text: 'body', meta: lessonMeta({ origin: 'note' }) })]);
    expect(await repo.countNoteLessonsSince(userId, new Date(0))).toBe(before + 1);
    expect(await repo.countNoteLessonsSince(userId, new Date(Date.now() + 3600_000))).toBe(0);
  });

  it('listLessons: chunk 0 only, not hidden, filters by q and project, newest source_at first, pages with cursor', async () => {
    const projA = projectId;
    const early = new Date('2026-09-01T00:00:00.000Z');
    const late = new Date('2026-09-27T00:00:00.000Z');
    const marker = `P3009-${newId()}`; // unique per run: other tests in this file also create P3009 lessons
    const [l1] = await repo.upsertMany([item({ kind: 'lesson', project_id: projA, source_id: newId(), title: `Migration ${marker} fails`, text: 'body', source_at: early, meta: lessonMeta() })]);
    const [l2] = await repo.upsertMany([item({ kind: 'lesson', project_id: projA, source_id: newId(), title: 'Unrelated symptom', text: 'body', source_at: late, meta: lessonMeta() })]);
    const [otherProjLesson] = await repo.upsertMany([item({ kind: 'lesson', project_id: null, source_id: newId(), title: 'Migration in no project', text: 'body', source_at: late, meta: lessonMeta() })]);
    // second chunk of l2's source: must not show up as its own row
    await repo.upsertMany([item({ kind: 'lesson', project_id: projA, source_id: (await db.memoryItem.findUniqueOrThrow({ where: { id: l2!.id } })).sourceId, chunk_index: 1, title: 'Unrelated symptom', text: 'more body', source_at: late, meta: lessonMeta() })]);

    const page = await repo.listLessons(userId, { limit: 1000 });
    const ids = page.items.map((r) => r.id);
    expect(ids).toContain(l1!.id);
    expect(ids).toContain(l2!.id);
    expect(ids.filter((id) => id === l2!.id)).toHaveLength(1); // chunk 0 only
    // newest source_at first
    expect(ids.indexOf(l2!.id)).toBeLessThan(ids.indexOf(l1!.id));

    const byProject = await repo.listLessons(userId, { projectId: projA, limit: 1000 });
    expect(byProject.items.map((r) => r.id)).not.toContain(otherProjLesson!.id);

    const byQ = await repo.listLessons(userId, { q: marker, limit: 1000 });
    expect(byQ.items.map((r) => r.id)).toEqual([l1!.id]);

    const paged1 = await repo.listLessons(userId, { limit: 1 });
    expect(paged1.items.length).toBe(1);
    expect(paged1.next_cursor).not.toBeNull();
    const paged2 = await repo.listLessons(userId, { limit: 1, cursor: paged1.next_cursor! });
    expect(paged2.items[0]!.id).not.toBe(paged1.items[0]!.id);
  });

  it('a multi-chunk file lesson: verify and hide key on the whole source (source_hash), not on one chunk', async () => {
    const sourceId = `L-${newId()}:docs/lessons/multi.md`;
    const marker = `multichunk${newId().replace(/[^a-z0-9]/g, '')}`;
    const file = (fix: string, sourceHash: string) =>
      ['Causa', 'Correção', 'Como conferir'].map((h, i) =>
        item({ kind: 'lesson', source_id: sourceId, chunk_index: i, title: 'Multi', text: `${h} ${i === 1 ? fix : 'same'} ${marker}`, source_hash: sourceHash, meta: lessonMeta() }),
      );
    const rows = await repo.replaceSourceChunks('lesson', sourceId, file('fix v1', 'a'.repeat(64)));
    const ids = rows.map((r) => r.id);
    for (const id of ids) await repo.setEmbedding(id, vec(7), 'm');

    expect(await repo.setVerified(ids[0]!, userId, userId)).toBe(true);
    // A hit on chunk 1 (not the one the person clicked) is just as verified.
    const hit1 = (await repo.textSearch({ ownerId: userId, kinds: ['lesson'] }, marker, 10)).find((h) => h.chunk_index === 1);
    expect(hit1!.verified).toBe(true);
    expect((await repo.nearest({ ownerId: userId, kinds: ['lesson'] }, vec(7), 10)).filter((h) => h.source_id === sourceId).every((h) => h.verified)).toBe(true);

    // Only the Fix section (chunk 1) changes: chunk 0's own text is identical, but the file's hash is new.
    await repo.replaceSourceChunks('lesson', sourceId, file('fix v2', 'b'.repeat(64)));
    expect((await repo.findManyForOwner(ids, userId)).map((r) => r.verified)).toEqual([false, false, false]);
    const listed = (await repo.listLessons(userId, { q: marker, limit: 10 })).items;
    expect(listed.map((r) => [r.id, r.verified])).toEqual([[ids[0], false]]);

    // Verify again, then clear from a non-zero chunk: every chunk drops it.
    expect(await repo.setVerified(ids[2]!, userId, userId)).toBe(true);
    expect((await repo.findManyForOwner(ids, userId)).every((r) => r.verified)).toBe(true);
    expect(await repo.clearVerified(ids[1]!, userId)).toBe(true);
    expect((await repo.findManyForOwner(ids, userId)).some((r) => r.verified)).toBe(false);

    // Hide: every chunk is gone from nearest/textSearch/listLessons, even after an identical re-index.
    for (const id of ids) await repo.setEmbedding(id, vec(7), 'm');
    expect(await repo.hideSource(ids[0]!, userId)).toBe(true);
    const visible = async () => ({
      near: (await repo.nearest({ ownerId: userId, kinds: ['lesson'] }, vec(7), 50)).filter((h) => h.source_id === sourceId).length,
      text: (await repo.textSearch({ ownerId: userId, kinds: ['lesson'] }, marker, 50)).length,
      list: (await repo.listLessons(userId, { q: marker, limit: 10 })).items.length,
    });
    expect(await visible()).toEqual({ near: 0, text: 0, list: 0 });
    await repo.replaceSourceChunks('lesson', sourceId, file('fix v2', 'b'.repeat(64)));
    expect(await visible()).toEqual({ near: 0, text: 0, list: 0 });

    // A changed file (only chunk 1's text, new source_hash) comes back — every chunk of it.
    await repo.replaceSourceChunks('lesson', sourceId, file('fix v3', 'c'.repeat(64)));
    for (const id of ids) await repo.setEmbedding(id, vec(7), 'm');
    expect(await visible()).toEqual({ near: 3, text: 3, list: 1 });
  });

  it('a non-lesson kind keeps hiding on content_hash (TER-95 unchanged)', async () => {
    const sourceId = newId();
    const marker = `dochide${newId().replace(/[^a-z0-9]/g, '')}`;
    const [doc] = await repo.upsertMany([item({ kind: 'doc', source_id: sourceId, text: `v1 ${marker}`, source_hash: 'd'.repeat(64) })]);
    expect(await repo.hideSource(doc!.id, userId)).toBe(true);
    expect(await repo.textSearch({ ownerId: userId }, marker, 10)).toEqual([]);
    // Same source_hash, different chunk text: a doc comes back on its content hash.
    await repo.upsertMany([item({ kind: 'doc', source_id: sourceId, text: `v2 ${marker}`, source_hash: 'd'.repeat(64) })]);
    expect((await repo.textSearch({ ownerId: userId }, marker, 10)).map((r) => r.id)).toEqual([doc!.id]);
  });

  it('currentNotes (TER-1011): this project and account-wide notes, newest first; never wrong, superseded, expired or conversation-only ones', async () => {
    // The status columns come from sibling cards (TER-1013/1014/1015); here they are added inside a
    // transaction that is rolled back, so the schema is left as the migrations made it (CI checks drift).
    const ROLLBACK = new Error('rollback');
    await db
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "wrong_at" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "superseded_at" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "scope" TEXT`,
          );
          const r = new MemoryItemsRepository(tx as unknown as PrismaClient);
          const owner = newId();
          const project = newId();
          const elsewhere = newId();
          await tx.user.create({ data: { id: owner, email: `${owner}@test.local`, name: 'rules' } });
          await tx.project.create({ data: { id: project, key: `R${project.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'rules', ownerId: owner } });
          await tx.project.create({ data: { id: elsewhere, key: `S${elsewhere.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'other', ownerId: owner } });
          const note = (title: string, at: string, projectId: string | null = project) =>
            r.upsertMany([item({ owner_id: owner, project_id: projectId, source_id: newId(), title, text: `Decisão: ${title}\nMotivo: m\nFontes: `, source_at: new Date(at) })]).then(([row]) => row!);
          const old = await note('acceptEdits + lista', '2026-10-01T00:00:00.000Z');
          const auto = await note('modo auto', '2026-10-02T00:00:00.000Z');
          const account = await note('PRs em inglês', '2026-10-03T00:00:00.000Z', null);
          const wrong = await note('errada', '2026-10-04T00:00:00.000Z');
          const expired = await note('durante a noite', '2026-10-05T00:00:00.000Z');
          const later = await note('até o fim do ano', '2026-10-05T00:00:00.000Z');
          const chat = await note('só nesta conversa', '2026-10-06T00:00:00.000Z');
          await note('outro projeto', '2026-10-06T00:00:00.000Z', elsewhere);
          await tx.$executeRawUnsafe(`UPDATE "memory_items" SET "superseded_at" = now() WHERE id = $1`, old.id);
          await tx.$executeRawUnsafe(`UPDATE "memory_items" SET "wrong_at" = now() WHERE id = $1`, wrong.id);
          await tx.$executeRawUnsafe(`UPDATE "memory_items" SET "expires_at" = now() - interval '1 hour' WHERE id = $1`, expired.id);
          await tx.$executeRawUnsafe(`UPDATE "memory_items" SET "expires_at" = now() + interval '30 days' WHERE id = $1`, later.id);
          await tx.$executeRawUnsafe(`UPDATE "memory_items" SET "scope" = 'conversation' WHERE id = $1`, chat.id);

          const ids = (await r.currentNotes(owner, project, 20)).map((n) => n.id);
          expect(new Set(ids)).toEqual(new Set([auto.id, account.id, later.id]));
          expect(ids).not.toContain(old.id);
          expect((await r.currentNotes(owner, project, 1)).length).toBe(1);
          expect((await r.currentNotes(otherUserId, project, 20)).length).toBe(0);
          throw ROLLBACK;
        },
        { timeout: 20_000 },
      )
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
  });
});
