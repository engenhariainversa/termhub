import { describe, expect, it, vi } from 'vitest';
import type { NewMemoryItem } from '../db/repositories/memory-items.js';
import { appendLessonBlock, renderLessonBlock } from '../lessons/note.js';
import { indexProjectNote } from './note.js';
import { ITEM_TEXT_MAX } from './text.js';

const log = () => ({ info: vi.fn(), warn: vi.fn() });

const project = { id: 'p1', owner_id: 'u1', key: 'P1', name: 'Projeto' };

function fakeRepos(opts: { content?: string; updatedAt?: string; project?: typeof project | null; known?: Record<string, string> } = {}) {
  const upsertMany = vi.fn(async (items: NewMemoryItem[]) => items.map((it, i) => ({ ...it, id: `m${i}` })));
  const deleteChunksFrom = vi.fn(async () => 0);
  const deleteBySource = vi.fn(async () => 0);
  const listSourceHashes = vi.fn(async () => new Map(Object.entries(opts.known ?? {})));
  const setEmbedding = vi.fn(async () => {});
  const findById = vi.fn(async () => (opts.project === null ? undefined : opts.project ?? project));
  const getByProject = vi.fn(async () => ({ id: 'n1', project_id: 'p1', content: opts.content ?? '', updated_at: opts.updatedAt ?? '2026-09-27T03:00:00.000Z' }));
  return {
    projects: { findById },
    notes: { getByProject },
    memoryItems: { upsertMany, deleteChunksFrom, deleteBySource, listSourceHashes, setEmbedding },
  };
}

const block = (id: string, tab: string | null, over: Partial<Parameters<typeof renderLessonBlock>[3]> = {}) =>
  renderLessonBlock(id, new Date('2026-09-27T04:00:00.000Z'), tab, { symptom: 'P3009 falha', cause: 'causa', fix: 'correção', evidence: 'fixed', ...over });

describe('indexProjectNote', () => {
  it('a note with text and two blocks upserts project_note sections and two derived lesson items', async () => {
    const content = ['# Contexto', 'texto do contexto', '', block('l1', 'tab1'), block('l2', null, { card: 'TER-57', pr: 'https://github.com/x/y/pull/1' })].join('\n');
    const repos = fakeRepos({ content });
    const l = log();
    const r = await indexProjectNote(repos as never, 'p1', { embedder: null, log: l });

    expect(r).toEqual({ sections: 1, lessons: 2 });
    expect(repos.memoryItems.upsertMany).toHaveBeenCalledTimes(2);
    const sectionItems = repos.memoryItems.upsertMany.mock.calls[0]![0] as NewMemoryItem[];
    expect(sectionItems).toHaveLength(1);
    expect(sectionItems[0]).toMatchObject({ kind: 'project_note', trust: 'person', source_id: 'note:p1', chunk_index: 0, owner_id: 'u1', project_id: 'p1' });

    const lessonItems = repos.memoryItems.upsertMany.mock.calls[1]![0] as NewMemoryItem[];
    expect(lessonItems).toHaveLength(2);
    expect(lessonItems.map((it) => it.source_id).sort()).toEqual(['note:p1:l1', 'note:p1:l2']);
    for (const it of lessonItems) {
      expect(it).toMatchObject({ kind: 'lesson', trust: 'derived', chunk_index: 0, title: 'P3009 falha' });
      expect(it.meta).toMatchObject({ origin: 'note', path: null, tags: [], agent: null });
      // The whole block's sha256: what "Verificar"/"Esquecer" pin for a lesson (markHash).
      expect(it.source_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(lessonItems[0]!.source_hash).not.toBe(lessonItems[1]!.source_hash);
    const l1 = lessonItems.find((it) => it.source_id === 'note:p1:l1')!;
    expect(l1.meta).toMatchObject({ tab_id: 'tab1', evidence: 'fixed', card: null, pr: null });
    const l2 = lessonItems.find((it) => it.source_id === 'note:p1:l2')!;
    expect(l2.meta).toMatchObject({ tab_id: null, evidence: 'fixed', card: 'TER-57', pr: 'https://github.com/x/y/pull/1' });

    expect(repos.memoryItems.deleteChunksFrom).toHaveBeenCalledWith('project_note', 'note:p1', 1);
    expect(repos.memoryItems.deleteBySource).not.toHaveBeenCalled();
  });

  it('leaves out a section that is only a heading, like `## Lições` once its blocks are taken out (TER-1006)', async () => {
    const content = appendLessonBlock(['# Contexto', 'texto do contexto', '', '### Ideias', ''].join('\n'), block('l1', 'tab1'));
    const repos = fakeRepos({ content });
    const r = await indexProjectNote(repos as never, 'p1', { embedder: null, log: log() });

    expect(r).toEqual({ sections: 1, lessons: 1 });
    const sectionItems = repos.memoryItems.upsertMany.mock.calls[0]![0] as NewMemoryItem[];
    expect(sectionItems.map((it) => [it.chunk_index, it.title])).toEqual([[0, 'Notas do projeto › Contexto']]);
    // The trim drops the heading-only chunks an earlier index stored past the kept ones.
    expect(repos.memoryItems.deleteChunksFrom).toHaveBeenCalledWith('project_note', 'note:p1', 1);
  });

  it('maps the pt-BR evidence word back to the column enum', async () => {
    const content = [block('l1', null, { evidence: 'observed' }), block('l2', null, { evidence: 'confirmed' })].join('\n');
    const repos = fakeRepos({ content });
    await indexProjectNote(repos as never, 'p1', { embedder: null, log: log() });
    const lessonItems = repos.memoryItems.upsertMany.mock.calls[1]![0] as NewMemoryItem[];
    expect(lessonItems.find((it) => it.source_id === 'note:p1:l1')!.meta).toMatchObject({ evidence: 'observed' });
    expect(lessonItems.find((it) => it.source_id === 'note:p1:l2')!.meta).toMatchObject({ evidence: 'confirmed' });
  });

  it('a PR with no card is read as pr, never mistaken for card (review fix round 1)', async () => {
    const content = block('l1', null, { card: undefined, pr: 'https://github.com/x/y/pull/9' });
    const repos = fakeRepos({ content });
    await indexProjectNote(repos as never, 'p1', { embedder: null, log: log() });
    const lessonItems = repos.memoryItems.upsertMany.mock.calls[1]![0] as NewMemoryItem[];
    expect(lessonItems[0]!.meta).toMatchObject({ card: null, pr: 'https://github.com/x/y/pull/9' });
  });

  it('a card with no PR is read as card, never mistaken for pr', async () => {
    const content = block('l1', null, { card: 'TER-99', pr: undefined });
    const repos = fakeRepos({ content });
    await indexProjectNote(repos as never, 'p1', { embedder: null, log: log() });
    const lessonItems = repos.memoryItems.upsertMany.mock.calls[1]![0] as NewMemoryItem[];
    expect(lessonItems[0]!.meta).toMatchObject({ card: 'TER-99', pr: null });
  });

  it('a hand-edited note note can push card/pr past the length cap; both are truncated to 300 chars', async () => {
    const longCard = 'C'.repeat(400);
    const longPr = `https://example.com/${'p'.repeat(400)}`;
    const content = block('l1', null, { card: longCard, pr: longPr });
    const repos = fakeRepos({ content });
    await indexProjectNote(repos as never, 'p1', { embedder: null, log: log() });
    const lessonItems = repos.memoryItems.upsertMany.mock.calls[1]![0] as NewMemoryItem[];
    const meta = lessonItems[0]!.meta!;
    expect(meta.card).toHaveLength(300);
    expect(meta.pr).toHaveLength(300);
    expect(longCard.startsWith(meta.card!)).toBe(true);
    expect(longPr.startsWith(meta.pr!)).toBe(true);
  });

  it('a section longer than ITEM_TEXT_MAX splits into consecutive chunks, never truncated', async () => {
    const long = 'a'.repeat(ITEM_TEXT_MAX + 500);
    const content = `# Grande\n${long}`;
    const repos = fakeRepos({ content });
    const r = await indexProjectNote(repos as never, 'p1', { embedder: null, log: log() });
    expect(r.sections).toBe(2);
    const sectionItems = repos.memoryItems.upsertMany.mock.calls[0]![0] as NewMemoryItem[];
    expect(sectionItems.map((it) => it.chunk_index)).toEqual([0, 1]);
    expect(sectionItems.every((it) => it.text.length <= ITEM_TEXT_MAX)).toBe(true);
    expect(sectionItems.map((it) => it.text).join('')).toBe(content);
    expect(repos.memoryItems.deleteChunksFrom).toHaveBeenCalledWith('project_note', 'note:p1', 2);
  });

  it('a running chunk_index across several sections', async () => {
    const content = ['# A', 'texto a', '', '# B', 'texto b', '', '# C', 'texto c'].join('\n');
    const repos = fakeRepos({ content });
    const r = await indexProjectNote(repos as never, 'p1', { embedder: null, log: log() });
    expect(r.sections).toBe(3);
    const sectionItems = repos.memoryItems.upsertMany.mock.calls[0]![0] as NewMemoryItem[];
    expect(sectionItems.map((it) => it.chunk_index)).toEqual([0, 1, 2]);
    expect(repos.memoryItems.deleteChunksFrom).toHaveBeenCalledWith('project_note', 'note:p1', 3);
  });

  it('a block removed since the last run is deleted by source', async () => {
    const content = block('l1', null);
    const repos = fakeRepos({ content, known: { 'note:p1:l1': 'h1', 'note:p1:l2': 'h2' } });
    const r = await indexProjectNote(repos as never, 'p1', { embedder: null, log: log() });
    expect(r.lessons).toBe(1);
    expect(repos.memoryItems.listSourceHashes).toHaveBeenCalledWith('lesson', 'note:p1:');
    expect(repos.memoryItems.deleteBySource).toHaveBeenCalledWith('lesson', ['note:p1:l2']);
  });

  it('no note yet (an empty project) indexes nothing but does not fail', async () => {
    const repos = fakeRepos({ content: '' });
    const r = await indexProjectNote(repos as never, 'p1', { embedder: null, log: log() });
    expect(r).toEqual({ sections: 0, lessons: 0 });
    expect(repos.memoryItems.upsertMany).toHaveBeenCalledWith([]);
    expect(repos.memoryItems.deleteChunksFrom).toHaveBeenCalledWith('project_note', 'note:p1', 0);
  });

  it('a project that no longer exists resolves with zero counts and writes nothing', async () => {
    const repos = fakeRepos({ project: null });
    const r = await indexProjectNote(repos as never, 'gone', { embedder: null, log: log() });
    expect(r).toEqual({ sections: 0, lessons: 0 });
    expect(repos.memoryItems.upsertMany).not.toHaveBeenCalled();
    expect(repos.notes.getByProject).not.toHaveBeenCalled();
  });

  it('a failing repository resolves and logs only { projectId, code }', async () => {
    const repos = fakeRepos({ content: '# A\ntexto' });
    repos.memoryItems.upsertMany.mockRejectedValueOnce(Object.assign(new Error('db down'), { code: 'P2024' }));
    const l = log();
    const r = await indexProjectNote(repos as never, 'p1', { embedder: null, log: l });
    expect(r).toEqual({ sections: 0, lessons: 0 });
    expect(l.warn).toHaveBeenCalledWith({ projectId: 'p1', code: 'P2024' }, expect.any(String));
  });

  it('fires an immediate embed when an embedder is given', async () => {
    const repos = fakeRepos({ content: '# A\ntexto' });
    const e = { embed: vi.fn(async (texts: string[]) => ({ model: 'm', vectors: texts.map(() => [1]) })) };
    await indexProjectNote(repos as never, 'p1', { embedder: e as never, log: log() });
    await new Promise((r) => setTimeout(r, 0));
    expect(e.embed).toHaveBeenCalledTimes(1);
    expect(repos.memoryItems.setEmbedding).toHaveBeenCalledTimes(1);
  });

  it('never logs note content or lesson text', async () => {
    const content = block('l1', null, { symptom: 'segredo do sintoma' });
    const repos = fakeRepos({ content });
    repos.memoryItems.upsertMany.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'P2024' }));
    const l = log();
    await indexProjectNote(repos as never, 'p1', { embedder: null, log: l });
    const logged = JSON.stringify([...l.info.mock.calls, ...l.warn.mock.calls]);
    expect(logged).not.toContain('segredo');
  });
});
