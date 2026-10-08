import { buildAiMemoryPagesScript, shellQuote } from '@termhub/machine-ops';
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

const { AI_MEMORY_MIN_AGENT_VERSION, importAiMemoryForProject, indexAiMemoryForLink, machineAiMemoryExec, parseAiMemoryPage, removeAiMemoryLessonsForLink } = await import('./ai-memory.js');

const log = () => ({ info: vi.fn(), warn: vi.fn() });
const sha = (c: string) => c.repeat(64);
const machine = (type: Machine['type']): Machine => ({ id: `m-${type}`, name: 'hulk', type, host: type === 'ssh' ? 'h' : null, ssh_user: null, ssh_port: 22 }) as Machine;
const link = (type: Machine['type'] = 'agent') => ({ id: 'L1', project_id: 'p1', owner_id: 'u1', cwd: '/srv/repo', machine: machine(type) });

const pagesOut = (pages: Record<string, { sha: string; text: string }>) =>
  Object.entries(pages)
    .map(([p, f]) => `F\t${f.sha}\t${Buffer.byteLength(f.text)}\t${p}\n${Buffer.from(f.text).toString('base64')}\nE`)
    .join('\n') + '\n';

const toRow = (it: NewMemoryItem): MemoryItem => ({ ...it, id: `mem-${it.source_id}-${it.chunk_index}`, project_name: null, content_hash: 'h', source_hash: it.source_hash ?? null, embed_model: null, source_at: it.source_at.toISOString(), created_at: '', updated_at: '' }) as MemoryItem;

function fakeRepos(known: Record<string, string> = {}) {
  return {
    memoryItems: {
      listSourceHashes: vi.fn(async () => new Map(Object.entries(known))),
      replaceSourceChunks: vi.fn(async (_kind: string, _sourceId: string, items: NewMemoryItem[]) => items.map(toRow)),
      deleteBySource: vi.fn(async (_kind: string, ids: string[]) => ids.length),
      setEmbedding: vi.fn(async () => {}),
    },
  };
}

const execOf = (stdout: string) => ({ pages: vi.fn(async () => stdout) });
const deps = (exec: unknown, l = log()) => ({ embedder: null, log: l, exec: exec as never });

beforeEach(() => {
  agentRpc.mockReset();
  requireAgentVersion.mockReset();
  runOnMachine.mockReset();
});

describe('parseAiMemoryPage', () => {
  it('takes the kind from the front matter or the directory, and the title from title, heading or name', () => {
    expect(parseAiMemoryPage('termhub/_rules/no-redis.md', '---\nkind: rule\ntitle: Sem Redis\npinned: true\n---\nNada de Redis no fanout.\n')).toMatchObject({ kind: 'rule', title: 'Sem Redis' });
    expect(parseAiMemoryPage('termhub/gotchas/drain.md', '# Drenar antes\n\nO SIGTERM drena os agentes primeiro.\n')).toMatchObject({ kind: 'gotcha', title: 'Drenar antes' });
    expect(parseAiMemoryPage('w/termhub/decisions/ws-fanout.md', 'Sem título.\n')).toMatchObject({ kind: 'decision', title: 'ws-fanout' });
  });

  it('refuses captured or consolidated pages, other kinds, empty bodies and secrets', () => {
    expect(parseAiMemoryPage('p/_rules/a.md', '---\nsession_id: s1\n---\ntool output\n')).toBeNull();
    expect(parseAiMemoryPage('p/decisions/a.md', '---\nsources:\n  session_id: s1\n---\nsummary\n')).toBeNull();
    expect(parseAiMemoryPage('p/gotchas/a.md', '---\nconsolidated: true\n---\nmerged\n')).toBeNull();
    expect(parseAiMemoryPage('p/gotchas/a.md', '---\nkind: fact\n---\nfact\n')).toBeNull();
    expect(parseAiMemoryPage('p/gotchas/a.md', '---\nkind: gotcha\n---\n   \n')).toBeNull();
    expect(parseAiMemoryPage('p/gotchas/a.md', 'token ghp_' + 'a'.repeat(36) + '\n')).toBeNull();
    expect(parseAiMemoryPage('p/sessions/a.md', 'x\n')).toBeNull();
  });
});

describe('indexAiMemoryForLink', () => {
  it('imports new pages as unverified derived lessons with their origin', async () => {
    const repos = fakeRepos();
    const exec = execOf(pagesOut({ 'termhub/_rules/no-redis.md': { sha: sha('a'), text: '---\nkind: rule\n---\n# Sem Redis\n\nNada de Redis.\n' } }));
    const r = await indexAiMemoryForLink(repos as never, link(), deps(exec));
    expect(exec.pages).toHaveBeenCalledWith(link().machine, '/srv/repo');
    expect(repos.memoryItems.listSourceHashes).toHaveBeenCalledWith('lesson', 'L1:ai-memory/');
    const [kind, sourceId, items] = repos.memoryItems.replaceSourceChunks.mock.calls[0]!;
    expect(kind).toBe('lesson');
    expect(sourceId).toBe('L1:ai-memory/termhub/_rules/no-redis.md');
    expect(items[0]).toMatchObject({
      kind: 'lesson',
      trust: 'derived',
      owner_id: 'u1',
      project_id: 'p1',
      title: 'Sem Redis',
      source_hash: sha('a'),
      meta: { origin: 'ai-memory', path: 'termhub/_rules/no-redis.md', machine_id: 'm-agent', machine_name: 'hulk', ai_memory_kind: 'rule', evidence: 'observed', tags: ['rule'] },
    });
    expect(items[0]).not.toHaveProperty('verified_at');
    expect(r).toEqual({ read: 1, removed: 0 });
  });

  it('leaves unchanged pages alone and deletes pages gone or now refused', async () => {
    const repos = fakeRepos({
      'L1:ai-memory/p/_rules/same.md': sha('a'),
      'L1:ai-memory/p/gotchas/gone.md': sha('b'),
      'L1:ai-memory/p/decisions/now-session.md': sha('c'),
    });
    const exec = execOf(pagesOut({ 'p/_rules/same.md': { sha: sha('a'), text: 'regra\n' }, 'p/decisions/now-session.md': { sha: sha('d'), text: '---\nsession_id: x\n---\nout\n' } }));
    const r = await indexAiMemoryForLink(repos as never, link(), deps(exec));
    expect(repos.memoryItems.replaceSourceChunks).not.toHaveBeenCalled();
    expect(repos.memoryItems.deleteBySource).toHaveBeenCalledWith('lesson', ['L1:ai-memory/p/gotchas/gone.md', 'L1:ai-memory/p/decisions/now-session.md']);
    expect(r).toEqual({ read: 0, removed: 2 });
  });

  it('never stores a page outside the deliberate families, whatever the machine prints', async () => {
    const repos = fakeRepos();
    const exec = execOf(pagesOut({ 'p/sessions/s1.md': { sha: sha('a'), text: 'npm test output\n' }, 'p/notes/n.md': { sha: sha('b'), text: 'n\n' } }));
    await indexAiMemoryForLink(repos as never, link(), deps(exec));
    expect(repos.memoryItems.replaceSourceChunks).not.toHaveBeenCalled();
  });

  it('writes and deletes nothing when the machine fails or has no ai-memory wiki', async () => {
    for (const exec of [{ pages: vi.fn(async () => Promise.reject(new HttpError(503, 'off', 'AGENT_OFFLINE'))) }, execOf('ERR:nowiki\n')]) {
      const repos = fakeRepos({ 'L1:ai-memory/p/_rules/a.md': sha('a') });
      const l = log();
      expect(await indexAiMemoryForLink(repos as never, link(), deps(exec, l))).toEqual({ read: 0, removed: 0 });
      expect(repos.memoryItems.deleteBySource).not.toHaveBeenCalled();
      expect(repos.memoryItems.replaceSourceChunks).not.toHaveBeenCalled();
      expect(l.info.mock.calls[0]![0]).toEqual({ linkId: 'L1', code: expect.stringMatching(/^(AGENT_OFFLINE|AIMEM_NOWIKI)$/) });
    }
  });
});

describe('removeAiMemoryLessonsForLink', () => {
  it('deletes the link’s ai-memory lessons only', async () => {
    const repos = fakeRepos({ 'L1:ai-memory/p/_rules/a.md': sha('a') });
    expect(await removeAiMemoryLessonsForLink(repos as never, 'L1')).toBe(1);
    expect(repos.memoryItems.listSourceHashes).toHaveBeenCalledWith('lesson', 'L1:ai-memory/');
    expect(repos.memoryItems.deleteBySource).toHaveBeenCalledWith('lesson', ['L1:ai-memory/p/_rules/a.md']);
  });
});

describe('importAiMemoryForProject', () => {
  it('imports every link of that project only, and never throws', async () => {
    const repos = {
      ...fakeRepos(),
      projectMachines: { listAllWithOwner: vi.fn(async () => [link(), { ...link(), id: 'L2', project_id: 'other' }]) },
    };
    const exec = execOf(pagesOut({ 'p/gotchas/a.md': { sha: sha('a'), text: 'a\n' } }));
    await importAiMemoryForProject(repos as never, 'p1', deps(exec));
    expect(exec.pages).toHaveBeenCalledTimes(1);
    const failing = { ...fakeRepos(), projectMachines: { listAllWithOwner: vi.fn(async () => Promise.reject(new Error('db'))) } };
    const l = log();
    await expect(importAiMemoryForProject(failing as never, 'p1', deps(exec, l))).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalled();
  });
});

describe('machineAiMemoryExec', () => {
  it('asks an agent through the version-gated RPC', async () => {
    agentRpc.mockResolvedValue({ stdout: 'out' });
    await expect(machineAiMemoryExec.pages(machine('agent'), '/srv/repo')).resolves.toBe('out');
    expect(requireAgentVersion).toHaveBeenCalledWith(machine('agent'), AI_MEMORY_MIN_AGENT_VERSION);
    expect(agentRpc).toHaveBeenCalledWith(machine('agent'), 'aimemory.pages', { cwd: '/srv/repo' });
  });

  it('runs the same script, cwd quoted, on an ssh machine', async () => {
    runOnMachine.mockResolvedValue({ code: 0, stdout: 'out', stderr: '', timedOut: false });
    await expect(machineAiMemoryExec.pages(machine('ssh'), "/srv/it's")).resolves.toBe('out');
    const script = buildAiMemoryPagesScript(shellQuote("/srv/it's"));
    expect(runOnMachine).toHaveBeenCalledWith(machine('ssh'), { file: '/bin/sh', args: ['-c', script] }, script, 20_000);
    runOnMachine.mockResolvedValue({ code: 255, stdout: '', stderr: '', timedOut: false });
    await expect(machineAiMemoryExec.pages(machine('ssh'), '/srv')).rejects.toMatchObject({ code: 'MACHINE_UNREACHABLE' });
  });
});
