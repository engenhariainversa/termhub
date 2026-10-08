import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBED_BATCH, EMBED_MAX_BATCHES_PER_TICK, startMemorySweeper } from './sweeper.js';

const log = () => ({ info: vi.fn(), warn: vi.fn() });
const embedder = () => ({ embed: vi.fn(async (texts: string[]) => ({ model: 'm', vectors: texts.map(() => [1, 0]) })) });

function fakeRepos(opts: { owners?: string[]; tasks?: { id: string; project_id: string; updated_at: string }[]; toEmbed?: { id: string; title: string; text: string }[] } = {}) {
  const listOwnersWithTasks = vi.fn(async () => opts.owners ?? []);
  const listChangedForOwner = vi.fn(async () => opts.tasks ?? []);
  const findByIdsForOwner = vi.fn(async () => []);
  const listSourceAt = vi.fn(async () => new Map<string, string>());
  const upsertMany = vi.fn(async (items: { title: string; text: string }[]) => items.map((it, i) => ({ id: `m${i + 1}`, ...it })));
  const listToEmbed = vi.fn(async () => opts.toEmbed ?? []);
  const setEmbedding = vi.fn(async () => {});
  const deleteBySource = vi.fn(async () => 0);
  return {
    tasks: { listChangedForOwner, findByIdsForOwner },
    memoryItems: { listSourceAt, upsertMany, listToEmbed, setEmbedding, deleteBySource },
    listOwnersWithTasksMock: listOwnersWithTasks,
    build() {
      return { tasks: { listChangedForOwner, findByIdsForOwner, listOwnersWithTasks }, memoryItems: { listSourceAt, upsertMany, listToEmbed, setEmbedding, deleteBySource } };
    },
  };
}

describe('startMemorySweeper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('one tick indexes tasks per owner, then embeds the pending backlog', async () => {
    const owners = ['u1', 'u2'];
    const task = { id: 't1', project_id: 'p1', updated_at: '2026-09-26T09:00:00.000Z' };
    const repos = fakeRepos({ owners, tasks: [task], toEmbed: [{ id: 'm1', title: 'Mensagem', text: 'oi' }] });
    const e = embedder();
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    const stop = startMemorySweeper(built as never, log(), e, 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(1);
    // Indexed once per owner: `listSourceAt` (the per-owner comparison) is called for each.
    expect(repos.memoryItems.listSourceAt).toHaveBeenCalledTimes(owners.length);
    expect(repos.memoryItems.listSourceAt).toHaveBeenCalledWith('task', 'u1');
    expect(repos.memoryItems.listSourceAt).toHaveBeenCalledWith('task', 'u2');
    // Then one embed batch of (up to) 32, one embed() call for the whole backlog.
    expect(repos.memoryItems.listToEmbed).toHaveBeenCalledWith(32);
    expect(e.embed).toHaveBeenCalledTimes(1);
    expect(repos.memoryItems.setEmbedding).toHaveBeenCalledWith('m1', [1, 0], 'm');
    stop();
  });

  it('drains the embed backlog batch after batch while each comes back full, then stops', async () => {
    const repos = fakeRepos();
    const full = Array.from({ length: EMBED_BATCH }, (_, i) => ({ id: `m${i}`, title: 't', text: 'x' }));
    repos.memoryItems.listToEmbed.mockResolvedValueOnce(full).mockResolvedValueOnce(full).mockResolvedValueOnce([full[0]!]);
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    const l = log();
    const stop = startMemorySweeper(built as never, l, embedder(), 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(repos.memoryItems.listToEmbed).toHaveBeenCalledTimes(3);
    expect(l.info).toHaveBeenCalledWith({ embedded: 2 * EMBED_BATCH + 1 }, 'memory items embedded');
    stop();
  });

  it('a backlog that never ends is bounded: at most EMBED_MAX_BATCHES_PER_TICK batches per tick', async () => {
    const repos = fakeRepos();
    const full = Array.from({ length: EMBED_BATCH }, (_, i) => ({ id: `m${i}`, title: 't', text: 'x' }));
    repos.memoryItems.listToEmbed.mockResolvedValue(full);
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    const stop = startMemorySweeper(built as never, log(), embedder(), 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(EMBED_MAX_BATCHES_PER_TICK).toBe(20);
    expect(repos.memoryItems.listToEmbed).toHaveBeenCalledTimes(EMBED_MAX_BATCHES_PER_TICK);
    stop();
  });

  it('with embedder: null only the indexing step runs', async () => {
    const repos = fakeRepos({ owners: ['u1'] });
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    const stop = startMemorySweeper(built as never, log(), null, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(1);
    expect(repos.memoryItems.listToEmbed).not.toHaveBeenCalled();
    stop();
  });

  it('runs once immediately and again after intervalMs; the returned stop clears the timer', async () => {
    const repos = fakeRepos({ owners: ['u1'] });
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    const stop = startMemorySweeper(built as never, log(), null, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(2);
  });

  it('an overlapping tick is skipped: a slow tick blocks the next scheduled one', async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const listOwnersWithTasks = vi.fn(async () => {
      await gate;
      return [];
    });
    const repos = fakeRepos();
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks }, memoryItems: repos.memoryItems };
    const stop = startMemorySweeper(built as never, log(), null, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(listOwnersWithTasks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listOwnersWithTasks).toHaveBeenCalledTimes(1); // skipped: `running` was still true
    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listOwnersWithTasks).toHaveBeenCalledTimes(2);
    stop();
  });

  it('an indexing failure still lets the embed step run, and logs only a code', async () => {
    const listOwnersWithTasks = vi.fn(async () => {
      throw Object.assign(new Error('db down'), { code: 'P2024' });
    });
    const repos = fakeRepos({ toEmbed: [{ id: 'm1', title: 'Mensagem', text: 'oi' }] });
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks }, memoryItems: repos.memoryItems };
    const e = embedder();
    const l = log();
    const stop = startMemorySweeper(built as never, l, e, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(repos.memoryItems.listToEmbed).toHaveBeenCalledTimes(1);
    expect(l.warn).toHaveBeenCalledWith({ code: 'P2024' }, expect.any(String));
    stop();
  });

  it('a failure indexing one owner does not stop the next owner from being indexed', async () => {
    const listSourceAt = vi.fn(async (_kind: 'task', ownerId: string) => {
      if (ownerId === 'u1') throw Object.assign(new Error('db down'), { code: 'P2024' });
      return new Map<string, string>();
    });
    const repos = fakeRepos({ owners: ['u1', 'u2'] });
    const built = {
      tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
      memoryItems: { ...repos.memoryItems, listSourceAt },
    };
    const l = log();
    const stop = startMemorySweeper(built as never, l, null, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(listSourceAt).toHaveBeenCalledWith('task', 'u1');
    expect(listSourceAt).toHaveBeenCalledWith('task', 'u2');
    stop();
  });

  it('uses the default interval when none is given', async () => {
    const repos = fakeRepos();
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    const { MEMORY_SWEEP_INTERVAL_MS } = await import('./sweeper.js');
    const stop = startMemorySweeper(built as never, log(), null);
    await vi.advanceTimersByTimeAsync(0);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MEMORY_SWEEP_INTERVAL_MS - 1);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(2);
    stop();
  });

  it('the timer is unref’d, so it never keeps the process alive', async () => {
    const repos = fakeRepos();
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const stop = startMemorySweeper(built as never, log(), null, 50000);
    const timer = spy.mock.results[0]!.value as { unref?: () => void };
    expect(typeof timer.unref).toBe('function');
    stop();
    spy.mockRestore();
    vi.useFakeTimers();
  });

  it('runs the docs pass on the first tick and every third tick after, one call per link', async () => {
    const repos = fakeRepos();
    const listAllWithOwner = vi.fn(async () => [
      { id: 'L1', project_id: 'p1', owner_id: 'u1', cwd: '/a', machine: { id: 'm1', type: 'agent' } },
      { id: 'L2', project_id: 'p2', owner_id: 'u2', cwd: '/b', machine: { id: 'm2', type: 'ssh' } },
    ]);
    const built = {
      tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
      memoryItems: { ...repos.memoryItems, listSourceHashes: vi.fn(async () => new Map()), deleteDocsNotInLinks: vi.fn(async () => 0) },
      projectMachines: { listAllWithOwner },
    };
    const exec = { scan: vi.fn(async () => ''), read: vi.fn(async () => ''), readLessons: vi.fn(async () => '') };
    const stop = startMemorySweeper(built as never, log(), null, 1000, exec);
    await vi.advanceTimersByTimeAsync(0);
    expect(listAllWithOwner).toHaveBeenCalledTimes(1);
    expect(exec.scan.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(['m1', 'm2']);
    // Doc items of links that no longer exist (unlinked, machine deleted) go once per pass.
    expect(built.memoryItems.deleteDocsNotInLinks).toHaveBeenCalledTimes(1);
    expect(built.memoryItems.deleteDocsNotInLinks).toHaveBeenCalledWith(['L1', 'L2']);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listAllWithOwner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listAllWithOwner).toHaveBeenCalledTimes(2);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(4);
    stop();
  });

  it('imports ai-memory pages only for links of opted-in projects, and clears them where the option is off (TER-1021)', async () => {
    const repos = fakeRepos();
    const listSourceHashes = vi.fn(async (_k: string, prefix: string) => (prefix === 'L2:ai-memory/' ? new Map([['L2:ai-memory/p/_rules/a.md', 'h']]) : new Map()));
    const deleteBySource = vi.fn(async () => 1);
    const built = {
      tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
      memoryItems: { ...repos.memoryItems, listSourceHashes, deleteBySource, deleteDocsNotInLinks: vi.fn(async () => 0) },
      projectMachines: {
        listAllWithOwner: vi.fn(async () => [
          { id: 'L1', project_id: 'p1', owner_id: 'u1', cwd: '/a', ai_memory_lessons: true, machine: { id: 'm1', type: 'agent' } },
          { id: 'L2', project_id: 'p2', owner_id: 'u2', cwd: '/b', ai_memory_lessons: false, machine: { id: 'm2', type: 'agent' } },
        ]),
      },
    };
    const docsExec = { scan: vi.fn(async () => ''), read: vi.fn(async () => ''), readLessons: vi.fn(async () => '') };
    const aiExec = { pages: vi.fn(async () => '') };
    const stop = startMemorySweeper(built as never, log(), null, 1000, docsExec, aiExec);
    await vi.advanceTimersByTimeAsync(0);
    expect(aiExec.pages.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(['m1']);
    expect(deleteBySource).toHaveBeenCalledWith('lesson', ['L2:ai-memory/p/_rules/a.md']);
    stop();
  });

  it('deleteDocsNotInLinks count (docs + file-origin lessons, review fix round 1) flows into the "stale" figure the pass logs', async () => {
    const repos = fakeRepos();
    const built = {
      tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
      memoryItems: { ...repos.memoryItems, listSourceHashes: vi.fn(async () => new Map()), deleteDocsNotInLinks: vi.fn(async () => 3) },
      projectMachines: { listAllWithOwner: vi.fn(async () => []) },
    };
    const l = log();
    const stop = startMemorySweeper(built as never, l, null, 1000, { scan: vi.fn(), read: vi.fn(), readLessons: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    // The sweeper itself does not need to know lessons exist: it just surfaces whatever count the
    // repository's (now wider) cleanup query removed.
    expect(l.info).toHaveBeenCalledWith({ links: 0, read: 0, removed: 0, stale: 3 }, 'memory docs indexed');
    stop();
  });

  it('a failing link does not stop the next one, and logs only the link id and a code', async () => {
    const repos = fakeRepos();
    const listSourceHashes = vi.fn(async (_k: string, prefix: string) => {
      if (prefix === 'L1:') throw Object.assign(new Error('db down'), { code: 'P2024' });
      return new Map();
    });
    const built = {
      tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
      memoryItems: { ...repos.memoryItems, listSourceHashes, deleteDocsNotInLinks: vi.fn(async () => 0) },
      projectMachines: {
        listAllWithOwner: vi.fn(async () => [
          { id: 'L1', project_id: 'p1', owner_id: 'u1', cwd: '/a', machine: { id: 'm1', type: 'agent' } },
          { id: 'L2', project_id: 'p2', owner_id: 'u2', cwd: '/b', machine: { id: 'm2', type: 'agent' } },
        ]),
      },
    };
    const exec = { scan: vi.fn(async () => ''), read: vi.fn(async () => ''), readLessons: vi.fn(async () => '') };
    const l = log();
    const stop = startMemorySweeper(built as never, l, null, 1000, exec);
    await vi.advanceTimersByTimeAsync(0);
    expect(listSourceHashes).toHaveBeenCalledWith('doc', 'L2:');
    expect(l.warn).toHaveBeenCalledWith({ linkId: 'L1', code: 'P2024' }, expect.any(String));
    stop();
  });

  it('a failing link listing still lets the embed step run', async () => {
    const repos = fakeRepos({ toEmbed: [{ id: 'm1', title: 'Mensagem', text: 'oi' }] });
    const built = {
      tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
      memoryItems: { ...repos.memoryItems, deleteDocsNotInLinks: vi.fn(async () => 0) },
      projectMachines: { listAllWithOwner: vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { code: 'P1001' }))) },
    };
    const e = embedder();
    const l = log();
    const stop = startMemorySweeper(built as never, l, e, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(l.warn).toHaveBeenCalledWith({ code: 'P1001' }, expect.any(String));
    // Never the stale-link cleanup when the listing itself failed: an empty set would wipe every doc.
    expect(built.memoryItems.deleteDocsNotInLinks).not.toHaveBeenCalled();
    expect(e.embed).toHaveBeenCalledTimes(1);
    stop();
  });

  it('no links at all: the cleanup runs with an empty set (every doc item goes)', async () => {
    const repos = fakeRepos();
    const deleteDocsNotInLinks = vi.fn(async () => 0);
    const built = {
      tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
      memoryItems: { ...repos.memoryItems, deleteDocsNotInLinks },
      projectMachines: { listAllWithOwner: vi.fn(async () => []) },
    };
    const stop = startMemorySweeper(built as never, log(), null, 1000, { scan: vi.fn(), read: vi.fn(), readLessons: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(deleteDocsNotInLinks).toHaveBeenCalledWith([]);
    stop();
  });

  describe('notes pass (spec 2026-09-27 failure lessons)', () => {
    const emptyExec = () => ({ scan: vi.fn(async () => ''), read: vi.fn(async () => ''), readLessons: vi.fn(async () => '') });

    function notesBuilt(opts: {
      projects: { id: string; owner_id: string | null }[];
      latest?: Record<string, Record<string, string>>; // ownerId -> projectId -> source_at
      notes: Record<string, { id: string; content: string; updated_at: string }>; // projectId -> note
    }) {
      const repos = fakeRepos();
      const list = vi.fn(async () => opts.projects);
      const findById = vi.fn(async (id: string) => opts.projects.find((p) => p.id === id));
      const getByProject = vi.fn(async (id: string) => ({ id: opts.notes[id]?.id ?? '', project_id: id, content: opts.notes[id]?.content ?? '', updated_at: opts.notes[id]?.updated_at ?? new Date(0).toISOString() }));
      const latestSourceAt = vi.fn(async (_kind: 'project_note', ownerId: string) => new Map(Object.entries(opts.latest?.[ownerId] ?? {})));
      const upsertMany = vi.fn(async (items: { title: string; text: string }[]) => items.map((it, i) => ({ id: `m${i}`, ...it })));
      const built = {
        tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
        memoryItems: { ...repos.memoryItems, upsertMany, latestSourceAt, deleteChunksFrom: vi.fn(async () => 0), deleteBySource: vi.fn(async () => 0), listSourceHashes: vi.fn(async () => new Map()), deleteDocsNotInLinks: vi.fn(async () => 0) },
        projectMachines: { listAllWithOwner: vi.fn(async () => []) },
        projects: { list, findById },
        notes: { getByProject },
      };
      return { built, list, findById, getByProject, latestSourceAt, upsertMany };
    }

    it('a project whose note is newer than the latest indexed project_note item is re-indexed', async () => {
      const { built, latestSourceAt, getByProject, upsertMany } = notesBuilt({
        projects: [{ id: 'p1', owner_id: 'u1' }],
        latest: { u1: { p1: '2026-09-27T00:00:00.000Z' } },
        notes: { p1: { id: 'n1', content: '# A\ntexto', updated_at: '2026-09-27T01:00:00.000Z' } },
      });
      const stop = startMemorySweeper(built as never, log(), null, 1000, emptyExec());
      await vi.advanceTimersByTimeAsync(0);
      expect(latestSourceAt).toHaveBeenCalledWith('project_note', 'u1');
      expect(getByProject).toHaveBeenCalledWith('p1');
      expect(upsertMany).toHaveBeenCalled();
      stop();
    });

    it('a project whose note is not newer than its latest indexed item is left alone', async () => {
      const { built, upsertMany } = notesBuilt({
        projects: [{ id: 'p1', owner_id: 'u1' }],
        latest: { u1: { p1: '2026-09-27T05:00:00.000Z' } },
        notes: { p1: { id: 'n1', content: '# A\ntexto', updated_at: '2026-09-27T01:00:00.000Z' } },
      });
      const stop = startMemorySweeper(built as never, log(), null, 1000, emptyExec());
      await vi.advanceTimersByTimeAsync(0);
      expect(upsertMany).not.toHaveBeenCalled();
      stop();
    });

    it('a project with no note row yet is skipped, not indexed as an empty note', async () => {
      const { built, upsertMany, getByProject } = notesBuilt({ projects: [{ id: 'p1', owner_id: 'u1' }], notes: {} });
      const stop = startMemorySweeper(built as never, log(), null, 1000, emptyExec());
      await vi.advanceTimersByTimeAsync(0);
      expect(getByProject).toHaveBeenCalledWith('p1');
      expect(upsertMany).not.toHaveBeenCalled();
      stop();
    });

    it('an owner-less (orphaned) project is skipped', async () => {
      const { built, getByProject } = notesBuilt({ projects: [{ id: 'p1', owner_id: null }], notes: { p1: { id: 'n1', content: '# A\ntexto', updated_at: '2026-09-27T01:00:00.000Z' } } });
      const stop = startMemorySweeper(built as never, log(), null, 1000, emptyExec());
      await vi.advanceTimersByTimeAsync(0);
      expect(getByProject).not.toHaveBeenCalled();
      stop();
    });

    it('runs only on the docs-pass cadence, not on every tick', async () => {
      const { built, upsertMany } = notesBuilt({
        projects: [{ id: 'p1', owner_id: 'u1' }],
        notes: { p1: { id: 'n1', content: '# A\ntexto', updated_at: '2026-09-27T01:00:00.000Z' } },
      });
      const stop = startMemorySweeper(built as never, log(), null, 1000, emptyExec());
      await vi.advanceTimersByTimeAsync(0);
      expect(upsertMany).toHaveBeenCalledTimes(2); // sections + lessons, on the first (docs-turn) tick
      await vi.advanceTimersByTimeAsync(1000); // tick 2: not a docs turn
      expect(upsertMany).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000); // tick 3: not a docs turn
      expect(upsertMany).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000); // tick 4: docs turn again
      expect(upsertMany).toHaveBeenCalledTimes(4);
      stop();
    });

    it('a failing owner does not stop the next owner, and logs only a code', async () => {
      const repos = fakeRepos();
      const list = vi.fn(async () => [{ id: 'p1', owner_id: 'u1' }, { id: 'p2', owner_id: 'u2' }]);
      const latestSourceAt = vi.fn(async (_k: 'project_note', ownerId: string) => {
        if (ownerId === 'u1') throw Object.assign(new Error('db down'), { code: 'P2024' });
        return new Map();
      });
      const getByProject = vi.fn(async () => ({ id: 'n2', project_id: 'p2', content: '# B\ntexto', updated_at: '2026-09-27T01:00:00.000Z' }));
      const upsertMany = vi.fn(async (items: { title: string; text: string }[]) => items.map((it, i) => ({ id: `m${i}`, ...it })));
      const built = {
        tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
        memoryItems: { ...repos.memoryItems, upsertMany, latestSourceAt, deleteChunksFrom: vi.fn(async () => 0), deleteBySource: vi.fn(async () => 0), listSourceHashes: vi.fn(async () => new Map()), deleteDocsNotInLinks: vi.fn(async () => 0) },
        projectMachines: { listAllWithOwner: vi.fn(async () => []) },
        projects: { list, findById: vi.fn(async (id: string) => ({ id, owner_id: id === 'p1' ? 'u1' : 'u2' })) },
        notes: { getByProject },
      };
      const l = log();
      const stop = startMemorySweeper(built as never, l, null, 1000, emptyExec());
      await vi.advanceTimersByTimeAsync(0);
      expect(getByProject).toHaveBeenCalledWith('p2');
      expect(l.warn).toHaveBeenCalledWith({ code: 'P2024' }, expect.any(String));
      stop();
    });
  });
});
