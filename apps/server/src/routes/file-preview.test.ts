import Fastify from 'fastify';
import { filePreviewOk, filePreviewResponse } from '@termhub/mobile-api';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { applyErrorHandler, HttpError } from '../lib/errors.js';
import { githubUrl, pathOn, relativeToProject } from '../file-preview/core.js';
import { filePreviewRoutes } from './file-preview.js';

const user = { id: 'u1', email: 'ana@example.com', name: 'Ana' };
const project = { id: 'p1', key: 'TH', name: 'termhub', owner_id: 'u1' } as Project;
const foreignProject = { id: 'p2', key: 'XX', name: 'other', owner_id: 'u2' } as Project;
const m1 = { id: 'm1', name: 'jarvis', type: 'agent', owner_id: 'u1' } as Machine;
const m2 = { id: 'm2', name: 'hulk', type: 'agent', owner_id: 'u1' } as Machine;
const sshBox = { id: 'm3', name: 'old', type: 'ssh', owner_id: 'u1' } as Machine;
const foreignMachine = { id: 'm9', name: 'theirs', type: 'agent', owner_id: 'u2' } as Machine;
const machines = [m1, m2, sshBox, foreignMachine];
const tabs = [
  { id: 't1', project_id: 'p1', machine_id: 'm2' },
  { id: 't9', project_id: 'p2', machine_id: 'm9' },
] as Tab[];

const SECRET = 'segredo-do-arquivo';
const b64 = (s: string) => Buffer.from(s).toString('base64');
const ok = (p: string, body = `# ${SECRET}`): RpcResult<'file.read'> => ({ status: 'ok', path: p, size: Buffer.byteLength(body), mtime_ms: 1_759_000_000_000, content_b64: b64(body) });

interface Opts {
  links?: Array<{ machine_id: string; cwd: string }>;
  online?: string[];
  caps?: Record<string, string[]>;
  files?: Record<string, Record<string, RpcResult<'file.read'>>>;
  repo?: { full_name: string | null; base_branch: string } | null;
  grants?: string[];
  rpcError?: Record<string, Error>;
}

function build(o: Opts = {}) {
  const links = o.links ?? [
    { machine_id: 'm1', cwd: '/home/u/termhub' },
    { machine_id: 'm2', cwd: '~/termhub' },
  ];
  const online = new Set(o.online ?? ['m1', 'm2', 'm9']);
  const caps = o.caps ?? { m1: ['file_read'], m2: ['file_read'], m9: ['file_read'] };
  const grants = new Set(o.grants ?? ['terminals:read']);
  const rpc = vi.fn(async (machine: Machine, params: RpcParams<'file.read'>): Promise<RpcResult<'file.read'>> => {
    if (o.rpcError?.[machine.id]) throw o.rpcError[machine.id];
    return o.files?.[machine.id]?.[params.path] ?? { status: 'missing' };
  });
  const repos = {
    tabs: { findById: vi.fn(async (id: string) => tabs.find((t) => t.id === id)) },
    projects: { findById: vi.fn(async (id: string) => [project, foreignProject].find((p) => p.id === id)) },
    machines: {
      findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)),
      list: vi.fn(async (owner: string | null) => machines.filter((m) => owner === null || m.owner_id === owner)),
    },
    projectMachines: {
      find: vi.fn(async (p: string, m: string) => {
        if (p === 'p2' && m === 'm9') return { id: 'pm9', project_id: p, machine_id: m, cwd: '/x' };
        const l = p === 'p1' ? links.find((x) => x.machine_id === m) : undefined;
        return l ? { id: `pm-${m}`, project_id: p, ...l } : undefined;
      }),
      listByProject: vi.fn(async (p: string) => (p === 'p1' ? links.map((l) => ({ id: `pm-${l.machine_id}`, project_id: p, ...l })) : [])),
    },
    projectSetup: { get: vi.fn(async () => ({ data: { repo: o.repo === undefined ? { full_name: 'engenhariainversa/termhub', base_branch: 'main' } : o.repo } })) },
  };
  const logged: string[] = [];
  const app = Fastify({ logger: { level: 'debug', stream: { write: (line: string) => logged.push(line) } } });
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    if (!grants.has('terminals:read')) throw new HttpError(403, 'Sem permissão: terminals:read', 'FORBIDDEN');
  });
  app.register(
    (a) =>
      filePreviewRoutes(a, repos as never, {
        rpc,
        agent: { isOnline: (id: string) => online.has(id), capabilities: (id: string) => caps[id] ?? null },
      }),
    { prefix: '/file-preview' },
  );
  const get = (q: Record<string, string>) => app.inject({ method: 'GET', url: `/file-preview?${new URLSearchParams(q)}` });
  return { app, get, rpc, repos, logged };
}

afterEach(() => vi.clearAllMocks());

describe('GET /file-preview', () => {
  it('reads a relative path under the project folder of the first machine that has it', async () => {
    const { get, rpc } = build({ files: { m2: { '~/termhub/docs/a.md': ok('/home/u/termhub/docs/a.md') } } });
    const res = await get({ path: 'docs/a.md', project_id: 'p1' });
    expect(res.statusCode).toBe(200);
    const body = filePreviewOk.parse(res.json());
    expect(body).toMatchObject({ machine: { id: 'm2', name: 'hulk' }, project_id: 'p1', rel_path: 'docs/a.md', name: 'a.md', content: `# ${SECRET}` });
    expect(body.github_url).toBe('https://github.com/engenhariainversa/termhub/blob/main/docs/a.md');
    // m1 was asked first, with its own folder as the allowed root
    expect(rpc.mock.calls.map(([m, p]) => [m.id, p])).toEqual([
      ['m1', { path: '/home/u/termhub/docs/a.md', roots: ['/home/u/termhub'] }],
      ['m2', { path: '~/termhub/docs/a.md', roots: ['~/termhub'] }],
    ]);
  });

  it("uses the tab's machine and folder", async () => {
    const { get, rpc } = build({ files: { m2: { '~/r.md': ok('/home/u/r.md') } } });
    const body = filePreviewOk.parse((await get({ path: '~/r.md', tab_id: 't1' })).json());
    expect(body).toMatchObject({ machine: { id: 'm2' }, rel_path: null, github_url: null });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toEqual({ path: '~/r.md', roots: ['~/termhub'] });
  });

  it("answers 404 for another owner's tab, project or machine, without asking any agent", async () => {
    const { get, rpc } = build();
    expect((await get({ path: '/x/a.md', tab_id: 't9' })).statusCode).toBe(404);
    expect((await get({ path: '/x/a.md', project_id: 'p2' })).statusCode).toBe(404);
    expect((await get({ path: '/x/a.md', machine_id: 'm9' })).statusCode).toBe(404);
    expect((await get({ path: '/x/a.md', project_id: 'p1', machine_id: 'm9' })).statusCode).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('outside a project, asks only the scope’s agent machines, with no project folder', async () => {
    const { get, rpc } = build({ files: { m2: { '/tmp/r.md': ok('/tmp/r.md') } } });
    const body = filePreviewOk.parse((await get({ path: '/tmp/r.md' })).json());
    expect(body.machine.id).toBe('m2');
    expect(rpc.mock.calls.map(([m, p]) => [m.id, p.roots])).toEqual([
      ['m1', []],
      ['m2', []],
    ]);
  });

  it('refuses a relative path with no project', async () => {
    const { get } = build();
    const res = await get({ path: 'docs/a.md' });
    expect(res.statusCode).toBe(400);
  });

  it('says why a file was refused rather than that another machine lacks it', async () => {
    const { get } = build({ files: { m2: { '/home/u/big.md': { status: 'too_large', size: 9_000_000 } } } });
    const body = filePreviewResponse.parse((await get({ path: '/home/u/big.md', project_id: 'p1' })).json());
    expect(body).toEqual({ status: 'too_large', machine: { id: 'm2', name: 'hulk' }, size: 9_000_000 });
  });

  it('answers missing when no machine has the file', async () => {
    const { get } = build();
    expect((await get({ path: '/home/u/nope.md', project_id: 'p1' })).json()).toEqual({ status: 'missing', machine: { id: 'm1', name: 'jarvis' } });
  });

  it('answers 409 "Atualize o agente" when an old agent may hold the file', async () => {
    const { get, rpc } = build({ caps: { m1: ['transcript'], m2: ['file_read'] } });
    const res = await get({ path: '/home/u/a.md', project_id: 'p1' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'AGENT_OUTDATED', error: expect.stringContaining('Atualize o agente') });
    // the old agent never gets the RPC it would drop
    expect(rpc.mock.calls.map(([m]) => m.id)).toEqual(['m2']);
  });

  it('a body from a newer agent wins over an old one', async () => {
    const { get } = build({ caps: { m1: ['transcript'], m2: ['file_read'] }, files: { m2: { '/home/u/a.md': ok('/home/u/a.md') } } });
    expect((await get({ path: '/home/u/a.md', project_id: 'p1' })).statusCode).toBe(200);
  });

  it('answers 503 when every agent is offline, and 400 on a machine without the agent', async () => {
    expect((await build({ online: [] }).get({ path: '/a.md', project_id: 'p1' })).statusCode).toBe(503);
    const { get } = build({ links: [{ machine_id: 'm3', cwd: '/w' }] });
    expect((await get({ path: '/w/a.md', project_id: 'p1' })).json()).toMatchObject({ code: 'UNSUPPORTED_MACHINE' });
  });

  it('skips a machine whose agent drops mid-call and keeps looking', async () => {
    const { get } = build({ rpcError: { m1: new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE') }, files: { m2: { '/home/u/a.md': ok('/home/u/a.md') } } });
    expect((await get({ path: '/home/u/a.md', project_id: 'p1' })).statusCode).toBe(200);
  });

  it('validates the query', async () => {
    const { get } = build();
    expect((await get({ path: '' })).statusCode).toBe(400);
    expect((await get({ path: 'a\n.md', project_id: 'p1' })).statusCode).toBe(400);
  });

  it('needs terminals:read', async () => {
    expect((await build({ grants: [] }).get({ path: '/a.md', project_id: 'p1' })).statusCode).toBe(403);
  });

  it('logs the machine, status and size, never the body', async () => {
    const { get, logged } = build({ files: { m1: { '/home/u/termhub/a.md': ok('/home/u/termhub/a.md') } } });
    await get({ path: 'a.md', project_id: 'p1' });
    const all = logged.join('\n');
    expect(all).toContain('"machine_id":"m1"');
    expect(all).not.toContain(SECRET);
  });

  it('leaves the GitHub link out without a repository', async () => {
    const { get } = build({ repo: null, files: { m1: { '/home/u/termhub/a.md': ok('/home/u/termhub/a.md') } } });
    expect(filePreviewOk.parse((await get({ path: 'a.md', project_id: 'p1' })).json()).github_url).toBeNull();
  });
});

describe('path helpers', () => {
  it('joins a relative path under the folder and keeps absolute and ~ paths', () => {
    expect(pathOn('docs/a.md', '/w')).toBe('/w/docs/a.md');
    expect(pathOn('./a.md', '~/w')).toBe('~/w/a.md');
    expect(pathOn('/tmp/a.md', '/w')).toBe('/tmp/a.md');
    expect(pathOn('a.md', null)).toBeNull();
  });
  it('is relative to the project only when inside it', () => {
    expect(relativeToProject('docs/a.md', '/w')).toBe('docs/a.md');
    expect(relativeToProject('/w/docs/a.md', '/w/')).toBe('docs/a.md');
    expect(relativeToProject('~/w/a.md', '~/w')).toBe('a.md');
    expect(relativeToProject('../x/a.md', '/w')).toBeNull();
    expect(relativeToProject('/wx/a.md', '/w')).toBeNull();
    expect(relativeToProject('/w/a.md', null)).toBeNull();
  });
  it('encodes each segment of the GitHub link', () => {
    expect(githubUrl('o/r', 'feat/x', 'docs/a b.md')).toBe('https://github.com/o/r/blob/feat/x/docs/a%20b.md');
    expect(githubUrl(null, 'main', 'a.md')).toBeNull();
    expect(githubUrl('o/r', 'main', null)).toBeNull();
  });
});
