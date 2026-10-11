import Fastify from 'fastify';
import { fileRecentResponse } from '@termhub/mobile-api';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CitedText } from '../db/repositories/tabs.js';
import type { Machine, Project } from '../db/repositories/types.js';
import { applyErrorHandler, HttpError } from '../lib/errors.js';
import { citedPathsFor, MAX_CITED_PATHS, MAX_RECENT_ITEMS } from '../file-preview/recent.js';
import { fileRecentRoutes } from './file-recent.js';

const user = { id: 'u1', email: 'ana@example.com', name: 'Ana' };
const project = { id: 'p1', key: 'TH', name: 'termhub', owner_id: 'u1' } as Project;
const foreignProject = { id: 'p2', key: 'XX', name: 'other', owner_id: 'u2' } as Project;
const m1 = { id: 'm1', name: 'jarvis', type: 'agent', owner_id: 'u1' } as Machine;
const m2 = { id: 'm2', name: 'hulk', type: 'agent', owner_id: 'u1' } as Machine;
const sshBox = { id: 'm3', name: 'old', type: 'ssh', owner_id: 'u1' } as Machine;
const m4 = { id: 'm4', name: 'mini', type: 'agent', owner_id: 'u1' } as Machine;
const foreignMachine = { id: 'm9', name: 'theirs', type: 'agent', owner_id: 'u2' } as Machine;
const machines = [m1, m2, sshBox, m4, foreignMachine];

type Entry = RpcResult<'file.list'>['entries'][number];
const T0 = Date.UTC(2026, 9, 4, 10, 0, 0);
const entry = (p: string, asked: string, minutes: number, extra: Partial<Entry> = {}): Entry => ({ path: p, asked, size: 10, mtime_ms: T0 + minutes * 60_000, too_large: false, ...extra });

interface Opts {
  links?: Array<{ machine_id: string; cwd: string }>;
  online?: string[];
  caps?: Record<string, string[]>;
  /** what each machine's agent answers; a function sees the params */
  list?: Record<string, Entry[] | ((p: RpcParams<'file.list'>) => Entry[])>;
  texts?: CitedText[];
  rpcError?: Record<string, Error>;
  grants?: string[];
}

function build(o: Opts = {}) {
  const links = o.links ?? [
    { machine_id: 'm1', cwd: '/home/u/termhub' },
    { machine_id: 'm2', cwd: '~/termhub' },
  ];
  const online = new Set(o.online ?? ['m1', 'm2', 'm4', 'm9']);
  const caps = o.caps ?? { m1: ['file_read', 'file_list'], m2: ['file_read', 'file_list'], m4: ['file_read'], m9: ['file_list'] };
  const grants = new Set(o.grants ?? ['terminals:read']);
  const rpc = vi.fn(async (machine: Machine, params: RpcParams<'file.list'>): Promise<RpcResult<'file.list'>> => {
    if (o.rpcError?.[machine.id]) throw o.rpcError[machine.id];
    const l = o.list?.[machine.id] ?? [];
    return { entries: typeof l === 'function' ? l(params) : l };
  });
  const repos = {
    projects: { findById: vi.fn(async (id: string) => [project, foreignProject].find((p) => p.id === id)) },
    machines: { findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)) },
    projectMachines: {
      listByProject: vi.fn(async (p: string) =>
        p === 'p1' ? links.map((l) => ({ id: `pm-${l.machine_id}`, project_id: p, ...l })) : p === 'p2' ? [{ id: 'pm9', project_id: p, machine_id: 'm9', cwd: '/x' }] : [],
      ),
    },
    tabs: { citedTexts: vi.fn(async (p: string) => (p === 'p1' ? (o.texts ?? []) : [])) },
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
      fileRecentRoutes(a, repos as never, {
        rpc,
        agent: { isOnline: (id: string) => online.has(id), capabilities: (id: string) => caps[id] ?? null },
      }),
    { prefix: '/file-recent' },
  );
  const get = async (q: Record<string, string>) => app.inject({ method: 'GET', url: `/file-recent?${new URLSearchParams(q)}` });
  const list = async () => fileRecentResponse.parse((await get({ project_id: 'p1' })).json());
  return { app, get, list, rpc, repos, logged };
}

const DIRS = ['docs/superpowers/specs', 'docs/superpowers/plans', 'docs/lessons', 'docs/legal'];
const text = (machineId: string, t: string, s = 0): CitedText => ({ machineId, text: t, at: new Date(T0 - s * 1000) });

afterEach(() => vi.clearAllMocks());

describe('GET /file-recent', () => {
  it("lists each machine's docs folders, grouped, newest first", async () => {
    const R = '/home/u/termhub';
    const { list, rpc } = build({
      links: [{ machine_id: 'm1', cwd: R }],
      list: {
        m1: [
          entry(`${R}/docs/superpowers/plans/p.md`, `${R}/docs/superpowers/plans/p.md`, 5),
          entry(`${R}/docs/superpowers/specs/s.md`, `${R}/docs/superpowers/specs/s.md`, 9),
          entry(`${R}/docs/lessons/l.md`, `${R}/docs/lessons/l.md`, 3, { too_large: true, size: 9_000_000 }),
          entry(`${R}/docs/lessons/README.md`, `${R}/docs/lessons/README.md`, 99),
          entry(`${R}/docs/legal/termos.markdown`, `${R}/docs/legal/termos.markdown`, 1),
        ],
      },
    });
    const body = await list();
    expect(body.skipped).toEqual([]);
    expect(body.items.map((i) => [i.rel_path, i.group, i.cited])).toEqual([
      ['docs/superpowers/specs/s.md', 'specs', false],
      ['docs/superpowers/plans/p.md', 'plans', false],
      ['docs/lessons/l.md', 'lessons', false],
      ['docs/legal/termos.markdown', 'legal', false],
    ]);
    expect(body.items[0]).toEqual({
      machine: { id: 'm1', name: 'jarvis' },
      path: `${R}/docs/superpowers/specs/s.md`,
      rel_path: 'docs/superpowers/specs/s.md',
      name: 's.md',
      size: 10,
      mtime: new Date(T0 + 9 * 60_000).toISOString(),
      too_large: false,
      group: 'specs',
      cited: false,
    });
    expect(body.items[2]).toMatchObject({ too_large: true, size: 9_000_000 });
    expect(rpc.mock.calls[0][1]).toEqual({ cwd: R, dirs: DIRS, paths: [], roots: [R] });
  });

  it('sends the paths cited on each machine, relative ones under its folder, and marks them', async () => {
    const { list, rpc } = build({
      texts: [
        text('m2', 'Escrevi docs/superpowers/specs/x.md e ~/relatorio.md', 0),
        text('m1', 'Veja /tmp/r.md', 1),
        text('m2', 'De novo docs/superpowers/specs/x.md, e ../outro/a.md\n```\ncat docs/codigo.md\n```', 2),
        text('m9', '/home/x/segredo.md', 3),
      ],
      list: {
        m1: [entry('/tmp/r.md', '/tmp/r.md', 1)],
        m2: [
          entry('/home/u/relatorio.md', '~/relatorio.md', 4),
          // cited and also in a listed folder: the agent kept the cited path as `asked`
          entry('/home/u/termhub/docs/superpowers/specs/x.md', '~/termhub/docs/superpowers/specs/x.md', 6),
          entry('/home/u/termhub/docs/superpowers/plans/y.md', '~/termhub/docs/superpowers/plans/y.md', 2),
        ],
      },
    });
    const body = await list();
    expect(rpc.mock.calls.map(([m, p]) => [m.id, p.paths])).toEqual([
      ['m1', ['/tmp/r.md']],
      ['m2', ['~/termhub/docs/superpowers/specs/x.md', '~/relatorio.md', '~/outro/a.md']],
    ]);
    expect(rpc.mock.calls[1][1]).toMatchObject({ cwd: '~/termhub', roots: ['~/termhub'] });
    expect(body.items.map((i) => [i.machine.id, i.path, i.rel_path, i.group, i.cited])).toEqual([
      ['m2', '/home/u/termhub/docs/superpowers/specs/x.md', 'docs/superpowers/specs/x.md', 'specs', true],
      ['m2', '/home/u/relatorio.md', null, 'other', true],
      ['m2', '/home/u/termhub/docs/superpowers/plans/y.md', 'docs/superpowers/plans/y.md', 'plans', false],
      ['m1', '/tmp/r.md', null, 'other', true],
    ]);
  });

  it('groups a cited absolute path under a ~ folder by the folder the machine resolved', async () => {
    const { list } = build({
      links: [{ machine_id: 'm2', cwd: '~/termhub' }],
      texts: [text('m2', 'Pronto: /home/u/termhub/docs/lessons/novo.md')],
      list: {
        m2: [
          entry('/home/u/termhub/docs/lessons/novo.md', '/home/u/termhub/docs/lessons/novo.md', 3),
          entry('/home/u/termhub/docs/lessons/velho.md', '~/termhub/docs/lessons/velho.md', 1),
        ],
      },
    });
    expect((await list()).items.map((i) => [i.rel_path, i.group, i.cited])).toEqual([
      ['docs/lessons/novo.md', 'lessons', true],
      ['docs/lessons/velho.md', 'lessons', false],
    ]);
  });

  it('keeps a cited README of another folder, drops only the lessons README', async () => {
    const R = '/home/u/termhub';
    const { list } = build({
      links: [{ machine_id: 'm1', cwd: R }],
      texts: [text('m1', 'README.md e docs/lessons/README.md')],
      list: { m1: (p) => p.paths.map((a, i) => entry(a, a, i)) },
    });
    expect((await list()).items.map((i) => i.rel_path)).toEqual(['README.md']);
  });

  it(`caps the cited paths at ${MAX_CITED_PATHS}, newest texts first`, () => {
    const texts = Array.from({ length: 150 }, (_, i) => `docs/n${i}.md`);
    const paths = citedPathsFor(texts, '/w');
    expect(paths).toHaveLength(MAX_CITED_PATHS);
    expect(paths[0]).toBe('/w/docs/n0.md');
    // `..` out of a `~` folder is not a path a machine can be asked for
    expect(citedPathsFor(['../../x.md', '../y.md'], '~')).toEqual([]);
  });

  it(`merges machines, sorts by date and answers at most ${MAX_RECENT_ITEMS}`, async () => {
    const many = (prefix: string, offset: number) => Array.from({ length: 200 }, (_, i) => entry(`${prefix}/docs/lessons/${i}.md`, `${prefix}/docs/lessons/${i}.md`, i * 2 + offset));
    const { list } = build({ links: [{ machine_id: 'm1', cwd: '/a' }, { machine_id: 'm2', cwd: '/b' }], list: { m1: many('/a', 0), m2: many('/b', 1) } });
    const body = await list();
    expect(body.items).toHaveLength(MAX_RECENT_ITEMS);
    const times = body.items.map((i) => Date.parse(i.mtime));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(body.items[0]).toMatchObject({ machine: { id: 'm2' }, rel_path: 'docs/lessons/199.md' });
  });

  it('skips machines without the agent, offline, outdated or failing, in link order', async () => {
    const { list, rpc, repos } = build({
      links: [
        { machine_id: 'm3', cwd: '/w' },
        { machine_id: 'm2', cwd: '/w' },
        { machine_id: 'm4', cwd: '/w' },
        { machine_id: 'm1', cwd: '/w' },
      ],
      online: ['m1', 'm4'],
      rpcError: { m1: new HttpError(504, 'A máquina não respondeu', 'AGENT_TIMEOUT') },
    });
    const body = await list();
    expect(body).toEqual({
      items: [],
      skipped: [
        { machine: { id: 'm3', name: 'old' }, reason: 'unsupported' },
        { machine: { id: 'm2', name: 'hulk' }, reason: 'offline' },
        { machine: { id: 'm4', name: 'mini' }, reason: 'outdated' },
        { machine: { id: 'm1', name: 'jarvis' }, reason: 'offline' },
      ],
    });
    // the old agent never gets the RPC it would drop
    expect(rpc.mock.calls.map(([m]) => m.id)).toEqual(['m1']);
    expect(repos.tabs.citedTexts).toHaveBeenCalledTimes(1);
  });

  it('skips a machine whose agent drops mid-call and lists the others', async () => {
    const { list } = build({ rpcError: { m1: new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE') }, list: { m2: [entry('/home/u/termhub/docs/legal/a.md', '~/termhub/docs/legal/a.md', 0)] } });
    const body = await list();
    expect(body.skipped).toEqual([{ machine: { id: 'm1', name: 'jarvis' }, reason: 'offline' }]);
    expect(body.items.map((i) => [i.machine.id, i.group])).toEqual([['m2', 'legal']]);
  });

  it('does not read the texts when no machine can be asked', async () => {
    const { list, repos } = build({ online: [] });
    expect((await list()).skipped.map((s) => s.reason)).toEqual(['offline', 'offline']);
    expect(repos.tabs.citedTexts).not.toHaveBeenCalled();
  });

  it("answers 404 for another owner's project, without asking any agent", async () => {
    const { get, rpc, repos } = build();
    expect((await get({ project_id: 'p2' })).statusCode).toBe(404);
    expect((await get({ project_id: 'nope' })).statusCode).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
    expect(repos.tabs.citedTexts).not.toHaveBeenCalled();
  });

  it('validates the query', async () => {
    const { get } = build();
    expect((await get({})).statusCode).toBe(400);
    expect((await get({ project_id: 'x'.repeat(65) })).statusCode).toBe(400);
  });

  it('needs terminals:read', async () => {
    expect((await build({ grants: [] }).get({ project_id: 'p1' })).statusCode).toBe(403);
  });

  it('logs counts and machine ids, never a path or a text', async () => {
    const { get, logged } = build({
      texts: [text('m1', 'segredo em /tmp/segredo-do-arquivo.md')],
      list: { m1: [entry('/tmp/segredo-do-arquivo.md', '/tmp/segredo-do-arquivo.md', 0)] },
      rpcError: { m2: new HttpError(502, 'falhou em /home/u/termhub/segredo.md', 'MACHINE_FAILED') },
    });
    expect((await get({ project_id: 'p1' })).statusCode).toBe(200);
    const all = logged.join('\n');
    expect(all).toContain('"items":1');
    expect(all).toContain('"machine_id":"m2"');
    expect(all).not.toContain('segredo');
  });
});
