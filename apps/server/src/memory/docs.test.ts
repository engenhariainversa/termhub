import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryItem, NewMemoryItem } from '../db/repositories/memory-items.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';

const { agentRpc, requireAgentVersion, runOnMachine } = vi.hoisted(() => ({
  agentRpc: vi.fn(),
  requireAgentVersion: vi.fn(),
  runOnMachine: vi.fn(),
}));
vi.mock('../agent/errors.js', () => ({ agentRpc, requireAgentVersion }));
vi.mock('../terminal/machine-exec.js', async (orig) => ({ ...(await orig<typeof import('../terminal/machine-exec.js')>()), runOnMachine }));

const { DOCS_LESSONS_MIN_AGENT_VERSION, DOCS_MIN_AGENT_VERSION, indexDocsForLink, machineDocsExec } = await import('./docs.js');

const log = () => ({ info: vi.fn(), warn: vi.fn() });
const sha = (c: string) => c.repeat(64);
const machine = (type: Machine['type']): Machine => ({ id: `m-${type}`, type, host: type === 'ssh' ? 'h' : null, ssh_user: null, ssh_port: 22 }) as Machine;
const link = (type: Machine['type'] = 'agent') => ({ id: 'L1', project_id: 'p1', owner_id: 'u1', cwd: '/srv/repo', machine: machine(type) });

const scanOut = (files: { path: string; sha: string | null; size?: number }[]) =>
  files.map((f) => (f.sha ? `F\t${f.sha}\t${f.size ?? 10}\t${f.path}` : `S\t${f.size ?? 300000}\t${f.path}`)).join('\n') + '\n';
const readOut = (files: Record<string, string>) =>
  Object.entries(files)
    .map(([p, text]) => `B\t${Buffer.byteLength(text)}\t${p}\n${Buffer.from(text).toString('base64')}\nE`)
    .join('\n') + '\n';

const spec = (n: string) => `docs/superpowers/specs/${n}.md`;
const plan = (n: string) => `docs/superpowers/plans/${n}.md`;

const toRow = (it: NewMemoryItem): MemoryItem => ({ ...it, id: `mem-${it.source_id}-${it.chunk_index}`, project_name: null, content_hash: 'h', source_hash: it.source_hash ?? null, embed_model: null, source_at: it.source_at.toISOString(), created_at: '', updated_at: '' }) as MemoryItem;

function fakeRepos(known: Record<string, string> = {}) {
  const memoryItems = {
    // `known` here is always doc-shaped fixtures (pre-dating lessons): a lesson lookup gets an empty
    // map, never the same rows back under the other kind.
    listSourceHashes: vi.fn(async (kind: string) => new Map(kind === 'lesson' ? [] : Object.entries(known))),
    replaceSourceChunks: vi.fn(async (_kind: string, _sourceId: string, items: NewMemoryItem[]) => items.map(toRow)),
    upsertMany: vi.fn(async (items: NewMemoryItem[]) => items.map(toRow)),
    deleteChunksFrom: vi.fn(async () => 0),
    deleteBySource: vi.fn(async () => 0),
    setEmbedding: vi.fn(async () => {}),
  };
  return { memoryItems };
}

/** A `DocsExec` over an in-memory checkout: `files` path → text; `read` honours the paths asked for. */
function fakeExec(files: Record<string, { sha: string; text: string }>, extra: { path: string; sha: null }[] = []) {
  return {
    scan: vi.fn(async () => scanOut([...Object.entries(files).map(([path, f]) => ({ path, sha: f.sha })), ...extra])),
    read: vi.fn(async (_m: Machine, _cwd: string, paths: string[]) => readOut(Object.fromEntries(paths.filter((p) => files[p]).map((p) => [p, files[p]!.text])))),
  };
}

const deps = (exec: unknown, l = log()) => ({ embedder: null, log: l, exec: exec as never });
const threeSections = '# A\n\nalpha\n\n# B\n\nbravo\n\n# C\n\ncharlie\n';

describe('indexDocsForLink', () => {
  it('first run: reads both listed files in one call and upserts derived doc chunks with the file sha', async () => {
    const repos = fakeRepos();
    const exec = fakeExec({ [spec('a')]: { sha: sha('a'), text: '# Título\n\ncorpo' }, [plan('b')]: { sha: sha('b'), text: 'sem título' } });
    const r = await indexDocsForLink(repos as never, link(), deps(exec));

    expect(repos.memoryItems.listSourceHashes).toHaveBeenCalledWith('doc', 'L1:');
    expect(exec.read).toHaveBeenCalledTimes(1);
    expect(exec.read.mock.calls[0]![2]).toEqual([spec('a'), plan('b')]);
    const items = repos.memoryItems.replaceSourceChunks.mock.calls.flatMap((c) => c[2]);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'doc', trust: 'derived', project_id: 'p1', owner_id: 'u1', source_id: `L1:${spec('a')}`, chunk_index: 0, title: `${spec('a')} › Título`, text: 'corpo', source_hash: sha('a') }),
      expect.objectContaining({ kind: 'doc', trust: 'derived', source_id: `L1:${plan('b')}`, chunk_index: 0, title: plan('b'), text: 'sem título', source_hash: sha('b') }),
    ]);
    expect(repos.memoryItems.deleteBySource).not.toHaveBeenCalled();
    expect(r).toEqual({ read: 2, removed: 0 });
  });

  it('second run with the same shas reads nothing and writes nothing', async () => {
    const repos = fakeRepos({ [`L1:${spec('a')}`]: sha('a') });
    const exec = fakeExec({ [spec('a')]: { sha: sha('a'), text: 'x' } });
    const r = await indexDocsForLink(repos as never, link(), deps(exec));
    expect(exec.read).not.toHaveBeenCalled();
    expect(repos.memoryItems.replaceSourceChunks).not.toHaveBeenCalled();
    expect(r).toEqual({ read: 0, removed: 0 });
  });

  it('a changed file is the only one read; a shorter re-chunk trims the chunks past the new count', async () => {
    const repos = fakeRepos({ [`L1:${spec('a')}`]: sha('a'), [`L1:${spec('b')}`]: sha('1') });
    const exec = fakeExec({ [spec('a')]: { sha: sha('a'), text: threeSections }, [spec('b')]: { sha: sha('2'), text: '# Só um\n\ntexto' } });
    const r = await indexDocsForLink(repos as never, link(), deps(exec));
    expect(exec.read.mock.calls.map((c) => c[2])).toEqual([[spec('b')]]);
    expect(repos.memoryItems.replaceSourceChunks.mock.calls.flatMap((c) => c[2]).map((i) => [i.source_id, i.chunk_index])).toEqual([[`L1:${spec('b')}`, 0]]);
    // Tail trim and upsert are one repository call (one transaction): never a separate delete that a
    // crash could split from the write.
    expect(repos.memoryItems.replaceSourceChunks).toHaveBeenCalledWith('doc', `L1:${spec('b')}`, [expect.objectContaining({ chunk_index: 0 })]);
    expect(repos.memoryItems.deleteChunksFrom).not.toHaveBeenCalled();
    expect(repos.memoryItems.upsertMany).not.toHaveBeenCalled();
    expect(r).toEqual({ read: 1, removed: 0 });
  });

  it('a file with three sections becomes chunks 0..2 and trims from 3', async () => {
    const repos = fakeRepos();
    const exec = fakeExec({ [spec('a')]: { sha: sha('a'), text: threeSections } });
    await indexDocsForLink(repos as never, link(), deps(exec));
    expect(repos.memoryItems.replaceSourceChunks.mock.calls.flatMap((c) => c[2]).map((i) => i.chunk_index)).toEqual([0, 1, 2]);
    expect(repos.memoryItems.replaceSourceChunks).toHaveBeenCalledTimes(1);
  });

  it('a successful scan with zero entries while the link has stored docs deletes nothing (DOCS_EMPTY)', async () => {
    const repos = fakeRepos({ [`L1:${spec('a')}`]: sha('a') });
    const l = log();
    const exec = { scan: vi.fn(async () => ''), read: vi.fn(async () => '') };
    const r = await indexDocsForLink(repos as never, link(), deps(exec, l));
    expect(r).toEqual({ read: 0, removed: 0 });
    expect(repos.memoryItems.deleteBySource).not.toHaveBeenCalled();
    expect(repos.memoryItems.replaceSourceChunks).not.toHaveBeenCalled();
    expect(l.info).toHaveBeenCalledWith({ linkId: 'L1', code: 'DOCS_EMPTY' }, expect.any(String));
  });

  it('an empty scan with nothing stored is simply nothing to do', async () => {
    const repos = fakeRepos();
    const l = log();
    const r = await indexDocsForLink(repos as never, link(), deps({ scan: vi.fn(async () => ''), read: vi.fn() }, l));
    expect(r).toEqual({ read: 0, removed: 0 });
    expect(l.info).not.toHaveBeenCalled();
  });

  it('a file no longer listed, or now over the size limit, has its items deleted', async () => {
    const repos = fakeRepos({ [`L1:${spec('gone')}`]: sha('a'), [`L1:${spec('big')}`]: sha('b'), [`L1:${spec('kept')}`]: sha('c') });
    const exec = fakeExec({ [spec('kept')]: { sha: sha('c'), text: 'x' } }, [{ path: spec('big'), sha: null }]);
    const r = await indexDocsForLink(repos as never, link(), deps(exec));
    expect(exec.read).not.toHaveBeenCalled();
    expect(repos.memoryItems.deleteBySource).toHaveBeenCalledTimes(1);
    expect(new Set(repos.memoryItems.deleteBySource.mock.calls[0]![1] as string[])).toEqual(new Set([`L1:${spec('gone')}`, `L1:${spec('big')}`]));
    expect(repos.memoryItems.deleteBySource.mock.calls[0]![0]).toBe('doc');
    expect(r).toEqual({ read: 0, removed: 2 });
  });

  it('more than 20 changed files are read in batches of at most 20', async () => {
    const files = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [spec(`f${String(i).padStart(2, '0')}`), { sha: sha('a'), text: `texto ${i}` }]));
    const repos = fakeRepos();
    const exec = fakeExec(files);
    const r = await indexDocsForLink(repos as never, link(), deps(exec));
    expect(exec.read.mock.calls.map((c) => (c[2] as string[]).length)).toEqual([20, 20, 5]);
    expect(r.read).toBe(45);
  });

  it('a read that stops early (the byte budget) re-requests the unread tail; a skipped file is dropped', async () => {
    const files = { [spec('a')]: { sha: sha('a'), text: 'A' }, [spec('b')]: { sha: sha('b'), text: 'B' }, [spec('c')]: { sha: sha('c'), text: 'C' }, [spec('d')]: { sha: sha('d'), text: 'D' } };
    const repos = fakeRepos();
    const exec = {
      scan: vi.fn(async () => scanOut(Object.entries(files).map(([path, f]) => ({ path, sha: f.sha })))),
      // First call: `a` vanished (skipped), `b` read, then the budget stops before `c`.
      read: vi.fn(async (_m: Machine, _c: string, paths: string[]) =>
        paths[0] === spec('a') ? readOut({ [spec('b')]: 'B' }) : readOut(Object.fromEntries(paths.map((p) => [p, files[p]!.text])))),
    };
    const r = await indexDocsForLink(repos as never, link(), deps(exec));
    expect(exec.read.mock.calls.map((c) => c[2])).toEqual([[spec('a'), spec('b'), spec('c'), spec('d')], [spec('c'), spec('d')]]);
    expect(repos.memoryItems.replaceSourceChunks.mock.calls.flatMap((c) => c[2]).map((i) => i.source_id).sort()).toEqual([`L1:${spec('b')}`, `L1:${spec('c')}`, `L1:${spec('d')}`]);
    expect(r).toEqual({ read: 3, removed: 0 });
  });

  it('a read call that returns nothing new ends the loop', async () => {
    const repos = fakeRepos();
    const exec = { scan: vi.fn(async () => scanOut([{ path: spec('a'), sha: sha('a') }])), read: vi.fn(async () => '') };
    const r = await indexDocsForLink(repos as never, link(), deps(exec));
    expect(exec.read).toHaveBeenCalledTimes(1);
    expect(repos.memoryItems.replaceSourceChunks).not.toHaveBeenCalled();
    expect(r).toEqual({ read: 0, removed: 0 });
  });

  describe('skips silently and deletes nothing', () => {
    const known = { [`L1:${spec('a')}`]: sha('a') };
    const cases: [string, () => { scan: () => Promise<string>; read: () => Promise<string> }, string][] = [
      ['offline agent', () => ({ scan: async () => Promise.reject(new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE')), read: async () => '' }), 'AGENT_OFFLINE'],
      ['agent older than 0.8.0', () => ({ scan: async () => Promise.reject(new HttpError(409, 'Atualize', 'AGENT_OUTDATED')), read: async () => '' }), 'AGENT_OUTDATED'],
      ['ssh unreachable', () => ({ scan: async () => Promise.reject(new HttpError(502, 'x', 'MACHINE_UNREACHABLE')), read: async () => '' }), 'MACHINE_UNREACHABLE'],
      ['scan ERR:notfound', () => ({ scan: async () => 'ERR:notfound\n', read: async () => '' }), 'DOCS_NOTFOUND'],
      ['scan ERR:nohash', () => ({ scan: async () => 'ERR:nohash\n', read: async () => '' }), 'DOCS_NOHASH'],
      ['read fails midway', () => ({ scan: async () => scanOut([{ path: spec('b'), sha: sha('b') }]), read: async () => Promise.reject(new HttpError(504, 'x', 'AGENT_TIMEOUT')) }), 'AGENT_TIMEOUT'],
    ];
    for (const [name, make, code] of cases) {
      it(name, async () => {
        const repos = fakeRepos(known);
        const l = log();
        const r = await indexDocsForLink(repos as never, link(), deps(make(), l));
        expect(r).toEqual({ read: 0, removed: 0 });
        expect(repos.memoryItems.deleteBySource).not.toHaveBeenCalled();
        expect(repos.memoryItems.deleteChunksFrom).not.toHaveBeenCalled();
        expect(repos.memoryItems.upsertMany).not.toHaveBeenCalled();
        expect(repos.memoryItems.replaceSourceChunks).not.toHaveBeenCalled();
        expect(l.info).toHaveBeenCalledWith({ linkId: 'L1', code }, expect.any(String));
      });
    }
  });

  it('fires an immediate embed when an embedder is given', async () => {
    const repos = fakeRepos();
    const e = { embed: vi.fn(async (texts: string[]) => ({ model: 'm', vectors: texts.map(() => [1]) })) };
    const exec = fakeExec({ [spec('a')]: { sha: sha('a'), text: 'x' } });
    await indexDocsForLink(repos as never, link(), { embedder: e, log: log(), exec: exec as never });
    await new Promise((r) => setTimeout(r, 0));
    expect(e.embed).toHaveBeenCalledTimes(1);
    expect(repos.memoryItems.setEmbedding).toHaveBeenCalledTimes(1);
  });

  it('never logs file paths or text', async () => {
    const repos = fakeRepos();
    const l = log();
    const exec = fakeExec({ [spec('segredo')]: { sha: sha('a'), text: 'conteúdo secreto' } });
    await indexDocsForLink(repos as never, link(), deps(exec, l));
    const logged = JSON.stringify([...l.info.mock.calls, ...l.warn.mock.calls]);
    expect(logged).not.toContain('segredo');
    expect(logged).not.toContain('secreto');
  });

  describe('docs/lessons/*.md (spec 2026-09-27 failure lessons)', () => {
    const lessonPath = (n: string) => `docs/lessons/${n}.md`;

    /** Distinguishes `known`/`knownLessons` by the `kind` the caller passes — unlike the top-level
     *  `fakeRepos`, whose stub ignores it (fine there, since no test above mixes doc and lesson
     *  source ids under the same link). */
    function fakeReposByKind(knownDocs: Record<string, string> = {}, knownLessons: Record<string, string> = {}) {
      const listSourceHashes = vi.fn(async (kind: string) => new Map(Object.entries(kind === 'lesson' ? knownLessons : knownDocs)));
      return {
        memoryItems: {
          listSourceHashes,
          replaceSourceChunks: vi.fn(async (_kind: string, _sourceId: string, items: NewMemoryItem[]) => items.map(toRow)),
          upsertMany: vi.fn(async (items: NewMemoryItem[]) => items.map(toRow)),
          deleteChunksFrom: vi.fn(async () => 0),
          deleteBySource: vi.fn(async () => 0),
          setEmbedding: vi.fn(async () => {}),
        },
      };
    }

    const lessonMd = (symptom: string) => `---\nsymptom: "${symptom}"\nevidence: fixed\n---\n\ncorpo`;

    it('scans specs/plans and lessons together, but reads lessons in a separate call, indexed as kind lesson', async () => {
      const repos = fakeReposByKind();
      const exec = {
        scan: vi.fn(async () => scanOut([{ path: spec('s'), sha: sha('a') }, { path: lessonPath('a'), sha: sha('b') }])),
        read: vi.fn(async (_m: Machine, _c: string, paths: string[]) => readOut(Object.fromEntries(paths.map((p) => [p, 'corpo do spec'])))),
        readLessons: vi.fn(async (_m: Machine, _c: string, paths: string[]) => readOut(Object.fromEntries(paths.map((p) => [p, lessonMd('P1: falha')])))),
      };
      const r = await indexDocsForLink(repos as never, link(), deps(exec));

      expect(exec.read).toHaveBeenCalledTimes(1);
      expect(exec.read.mock.calls[0]![2]).toEqual([spec('s')]);
      expect(exec.readLessons).toHaveBeenCalledTimes(1);
      expect(exec.readLessons.mock.calls[0]![2]).toEqual([lessonPath('a')]);

      const docCall = repos.memoryItems.replaceSourceChunks.mock.calls.find((c) => c[0] === 'doc')!;
      expect(docCall[1]).toBe(`L1:${spec('s')}`);

      const lessonCall = repos.memoryItems.replaceSourceChunks.mock.calls.find((c) => c[0] === 'lesson')!;
      expect(lessonCall[1]).toBe(`L1:${lessonPath('a')}`);
      const lessonItems = lessonCall[2] as NewMemoryItem[];
      expect(lessonItems).toEqual([
        expect.objectContaining({
          kind: 'lesson',
          trust: 'derived',
          title: 'P1: falha',
          text: 'corpo',
          source_hash: sha('b'),
          meta: expect.objectContaining({ origin: 'file', path: lessonPath('a'), evidence: 'fixed' }),
        }),
      ]);
      expect(r).toEqual({ read: 2, removed: 0 });
    });

    it('docs/lessons/README.md is never requested even if a scan somehow reports it', async () => {
      const repos = fakeReposByKind();
      const readme = 'docs/lessons/README.md';
      const exec = {
        scan: vi.fn(async () => scanOut([{ path: readme, sha: sha('r') }])),
        read: vi.fn(async () => ''),
        readLessons: vi.fn(async () => ''),
      };
      await indexDocsForLink(repos as never, link(), deps(exec));
      // `isLessonPath` refuses README.md, so it is treated as neither a doc nor a lesson path.
      expect(exec.read).not.toHaveBeenCalled();
      expect(exec.readLessons).not.toHaveBeenCalled();
    });

    it('a lessons read failure (e.g. an agent too old for 0.9.1) never blocks specs/plans, and deletes no lesson', async () => {
      const repos = fakeReposByKind({}, { [`L1:${lessonPath('old')}`]: sha('e') });
      const exec = {
        scan: vi.fn(async () => scanOut([{ path: spec('s'), sha: sha('a') }, { path: lessonPath('old'), sha: sha('f') }])),
        read: vi.fn(async (_m: Machine, _c: string, paths: string[]) => readOut(Object.fromEntries(paths.map((p) => [p, 'corpo do spec'])))),
        readLessons: vi.fn(async () => Promise.reject(new HttpError(409, 'Atualize', 'AGENT_OUTDATED'))),
      };
      const l = log();
      const r = await indexDocsForLink(repos as never, link(), deps(exec, l));

      expect(repos.memoryItems.replaceSourceChunks).toHaveBeenCalledWith('doc', `L1:${spec('s')}`, expect.anything());
      expect(repos.memoryItems.replaceSourceChunks).not.toHaveBeenCalledWith('lesson', expect.anything(), expect.anything());
      expect(repos.memoryItems.deleteBySource).not.toHaveBeenCalled();
      expect(l.info).toHaveBeenCalledWith({ linkId: 'L1', code: 'AGENT_OUTDATED' }, expect.any(String));
      expect(r).toEqual({ read: 1, removed: 0 });
    });

    it('a specs/plans read failure never blocks lessons', async () => {
      const repos = fakeReposByKind();
      const exec = {
        scan: vi.fn(async () => scanOut([{ path: spec('s'), sha: sha('a') }, { path: lessonPath('a'), sha: sha('b') }])),
        read: vi.fn(async () => Promise.reject(new HttpError(504, 'x', 'AGENT_TIMEOUT'))),
        readLessons: vi.fn(async (_m: Machine, _c: string, paths: string[]) => readOut(Object.fromEntries(paths.map((p) => [p, lessonMd('P1')])))),
      };
      const r = await indexDocsForLink(repos as never, link(), deps(exec));
      expect(repos.memoryItems.replaceSourceChunks).toHaveBeenCalledWith('lesson', `L1:${lessonPath('a')}`, expect.anything());
      expect(repos.memoryItems.replaceSourceChunks).not.toHaveBeenCalledWith('doc', expect.anything(), expect.anything());
      expect(r).toEqual({ read: 1, removed: 0 });
    });

    it('a lesson file no longer listed has its lesson items deleted, never a doc', async () => {
      const repos = fakeReposByKind({ [`L1:${spec('kept')}`]: sha('c') }, { [`L1:${lessonPath('gone')}`]: sha('g') });
      const exec = fakeExec({ [spec('kept')]: { sha: sha('c'), text: 'x' } });
      const r = await indexDocsForLink(repos as never, link(), deps(exec));
      expect(repos.memoryItems.deleteBySource).toHaveBeenCalledWith('lesson', [`L1:${lessonPath('gone')}`]);
      expect(r).toEqual({ read: 0, removed: 1 });
    });

    it('the link’s ai-memory lessons (TER-1021) are never treated as gone docs/lessons files', async () => {
      const repos = fakeReposByKind({ [`L1:${spec('kept')}`]: sha('c') }, { 'L1:ai-memory/p/_rules/a.md': sha('a') });
      const exec = fakeExec({ [spec('kept')]: { sha: sha('c'), text: 'x' } });
      const r = await indexDocsForLink(repos as never, link(), deps(exec));
      expect(repos.memoryItems.deleteBySource).not.toHaveBeenCalled();
      expect(r).toEqual({ read: 0, removed: 0 });
    });

    it('an agent below DOCS_LESSONS_MIN_AGENT_VERSION: its scan cannot list lessons, so none is deleted (downgrade guard)', async () => {
      requireAgentVersion.mockImplementation((_m: Machine, minVersion: string) => {
        if (minVersion === DOCS_LESSONS_MIN_AGENT_VERSION) throw new HttpError(409, 'Atualize', 'AGENT_OUTDATED');
      });
      try {
        const repos = fakeReposByKind({ [`L1:${spec('kept')}`]: sha('c'), [`L1:${spec('gone')}`]: sha('d') }, { [`L1:${lessonPath('indexed')}`]: sha('g') });
        const exec = fakeExec({ [spec('kept')]: { sha: sha('c'), text: 'x' } });
        const r = await indexDocsForLink(repos as never, link('agent'), deps(exec));
        expect(repos.memoryItems.deleteBySource).toHaveBeenCalledWith('doc', [`L1:${spec('gone')}`]);
        expect(repos.memoryItems.deleteBySource).not.toHaveBeenCalledWith('lesson', expect.anything());
        expect(r).toEqual({ read: 0, removed: 1 });
      } finally {
        requireAgentVersion.mockReset();
      }
    });

    it('an ssh machine has no agent version: a lesson no longer listed is still deleted', async () => {
      requireAgentVersion.mockImplementation(() => {
        throw new HttpError(409, 'Atualize', 'AGENT_OUTDATED');
      });
      try {
        const repos = fakeReposByKind({ [`L1:${spec('kept')}`]: sha('c') }, { [`L1:${lessonPath('gone')}`]: sha('g') });
        const exec = fakeExec({ [spec('kept')]: { sha: sha('c'), text: 'x' } });
        await indexDocsForLink(repos as never, link('ssh'), deps(exec));
        expect(repos.memoryItems.deleteBySource).toHaveBeenCalledWith('lesson', [`L1:${lessonPath('gone')}`]);
      } finally {
        requireAgentVersion.mockReset();
      }
    });
  });
});

describe('machineDocsExec', () => {
  beforeEach(() => {
    agentRpc.mockReset();
    requireAgentVersion.mockReset();
    runOnMachine.mockReset();
  });

  it('an agent machine goes through the version check and the docs.scan / docs.read RPCs', async () => {
    agentRpc.mockResolvedValueOnce({ stdout: 'scan' }).mockResolvedValueOnce({ stdout: 'read' });
    const m = machine('agent');
    expect(await machineDocsExec.scan(m, '/srv/repo')).toBe('scan');
    expect(await machineDocsExec.read(m, '/srv/repo', [spec('a')])).toBe('read');
    expect(requireAgentVersion).toHaveBeenCalledWith(m, DOCS_MIN_AGENT_VERSION);
    expect(DOCS_MIN_AGENT_VERSION).toBe('0.8.0');
    expect(agentRpc).toHaveBeenNthCalledWith(1, m, 'docs.scan', { cwd: '/srv/repo' });
    expect(agentRpc).toHaveBeenNthCalledWith(2, m, 'docs.read', { cwd: '/srv/repo', paths: [spec('a')] });
    expect(runOnMachine).not.toHaveBeenCalled();
  });

  it('an outdated agent is refused before any RPC is sent', async () => {
    requireAgentVersion.mockImplementation(() => {
      throw new HttpError(409, 'Atualize', 'AGENT_OUTDATED');
    });
    await expect(machineDocsExec.scan(machine('agent'), '/srv/repo')).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(agentRpc).not.toHaveBeenCalled();
  });

  it('readLessons goes through docs.read too, but version-gated at DOCS_LESSONS_MIN_AGENT_VERSION, not DOCS_MIN_AGENT_VERSION', async () => {
    agentRpc.mockResolvedValueOnce({ stdout: 'lessons' });
    const m = machine('agent');
    expect(await machineDocsExec.readLessons(m, '/srv/repo', ['docs/lessons/a.md'])).toBe('lessons');
    expect(requireAgentVersion).toHaveBeenCalledWith(m, DOCS_LESSONS_MIN_AGENT_VERSION);
    expect(DOCS_LESSONS_MIN_AGENT_VERSION).toBe('0.9.1');
    expect(agentRpc).toHaveBeenCalledWith(m, 'docs.read', { cwd: '/srv/repo', paths: ['docs/lessons/a.md'] });
  });

  it('an agent too old for lessons but old enough for specs/plans is refused only on readLessons', async () => {
    requireAgentVersion.mockImplementation((_m: Machine, minVersion: string) => {
      if (minVersion === DOCS_LESSONS_MIN_AGENT_VERSION) throw new HttpError(409, 'Atualize', 'AGENT_OUTDATED');
    });
    agentRpc.mockResolvedValueOnce({ stdout: 'read' });
    const m = machine('agent');
    await expect(machineDocsExec.readLessons(m, '/srv/repo', ['docs/lessons/a.md'])).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(await machineDocsExec.read(m, '/srv/repo', [spec('a')])).toBe('read');
    expect(agentRpc).toHaveBeenCalledTimes(1);
  });

  for (const type of ['ssh', 'local'] as const) {
    it(`a ${type} machine runs the shell-quoted script through runOnMachine`, async () => {
      runOnMachine.mockResolvedValue({ code: 0, stdout: 'out', stderr: '', timedOut: false });
      const m = machine(type);
      expect(await machineDocsExec.scan(m, "/srv/it's")).toBe('out');
      expect(await machineDocsExec.read(m, '/srv/repo', [spec('a'), plan('b')])).toBe('out');
      expect(agentRpc).not.toHaveBeenCalled();
      const [m1, local1, script1] = runOnMachine.mock.calls[0]!;
      expect(m1).toBe(m);
      expect(local1).toEqual({ file: '/bin/sh', args: ['-c', script1] });
      expect(script1).toContain(`P='/srv/it'\\''s'`);
      const script2 = runOnMachine.mock.calls[1]![2] as string;
      expect(script2).toContain(`for f in '${spec('a')}' '${plan('b')}'; do`);

      runOnMachine.mockClear();
      runOnMachine.mockResolvedValue({ code: 0, stdout: 'out', stderr: '', timedOut: false });
      expect(await machineDocsExec.readLessons(m, '/srv/repo', ['docs/lessons/a.md'])).toBe('out');
      const script3 = runOnMachine.mock.calls[0]![2] as string;
      expect(script3).toContain(`for f in 'docs/lessons/a.md'; do`);
      expect(agentRpc).not.toHaveBeenCalled();
    });
  }

  it('a failed or timed-out ssh run throws a coded error', async () => {
    runOnMachine.mockResolvedValueOnce({ code: 255, stdout: '', stderr: '', timedOut: false }).mockResolvedValueOnce({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(machineDocsExec.scan(machine('ssh'), '/x')).rejects.toMatchObject({ code: 'MACHINE_UNREACHABLE' });
    await expect(machineDocsExec.scan(machine('ssh'), '/x')).rejects.toMatchObject({ code: 'MACHINE_TIMEOUT' });
  });
});
