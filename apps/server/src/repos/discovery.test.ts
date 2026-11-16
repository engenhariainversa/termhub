import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcResult } from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import type { DiscoveredCheckoutInput } from '../db/repositories/project-repositories.js';
import type { Machine, ProjectMachine, ProjectRepository, RepoStatus } from '../db/repositories/types.js';
import { effectiveRepos, repoKeyFor, uniqueRepoKey } from '../setup/repos.js';
import { normalizeSetup, sameRepo, SETUP_VERSION } from '../setup/schema.js';
import { loopProjects, resetDiscoveryState, scanLink, scanProject, SCAN_THROTTLE_MS, type DiscoveryDeps } from './discovery.js';

type ScanRepo = RpcResult<'git.repos.scan'>['repos'][number];
const gh = (dir: string, name: string, over: Partial<ScanRepo> = {}): ScanRepo => ({ dir, origin: `git@github.com:${name}.git`, default_branch: 'main', has_commits: true, description: null, ...over });

/** One clock for the fake agent and the fake database, as the server's `Date.now` is for both. */
let clock = 0;

const machine = (id: string, over: Partial<Machine> = {}) => ({ id, name: id === 'm1' ? 'one' : 'two', type: 'agent', ...over }) as Machine;

/**
 * In-memory repositories: the same rules as `ProjectRepositoriesRepository` (keys given once, a checkout per
 * machine, missing marked and never deleted), enough to drive discovery end to end without Postgres.
 */
function fakeRepos(opts: { setup?: Record<string, unknown>; links?: ProjectMachine[]; machines?: Machine[] } = {}) {
  let n = 0;
  const rows: ProjectRepository[] = [];
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  const setupData = normalizeSetup(opts.setup ?? {}, SETUP_VERSION);
  const links = opts.links ?? [{ id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '~/code/rea', position: 0, created_at: '' }];
  const machines = opts.machines ?? [machine('m1')];
  const clone = () => rows.map((r) => ({ ...r, checkouts: r.checkouts.map((c) => ({ ...c })) }));

  const repos = {
    projectSetup: {
      get: vi.fn(async () => ({ project_id: 'p1', data: setupData, version: SETUP_VERSION, updated_at: null })),
      listWithAutomation: vi.fn(async () => [{ project_id: 'p1', data: setupData }]),
    },
    projectMachines: {
      listByProject: vi.fn(async (projectId: string) => links.filter((l) => l.project_id === projectId)),
      listByMachine: vi.fn(async (machineId: string) => links.filter((l) => l.machine_id === machineId)),
    },
    machines: { findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)) },
    projects: { findById: vi.fn(async (id: string) => ({ id, owner_id: 'u1' })) },
    users: { findById: vi.fn(async () => ({ id: 'u1', locale: 'pt-BR' })) },
    chat: {
      findLatestActiveForProject: vi.fn(async () => ({ id: 'c1' })),
      getOrCreateForProject: vi.fn(async () => ({ id: 'c1' })),
      addMessage: vi.fn(async (m: { text: string }) => {
        lines.push(m.text);
        return { id: `msg${lines.length}`, ...m };
      }),
    },
    automationEvents: {
      insert: vi.fn(async (e: { kind: string; payload: Record<string, unknown> }) => {
        events.push({ kind: e.kind, payload: e.payload });
        return { id: `e${events.length}`, ...e, created_at: new Date().toISOString() };
      }),
    },
    integrations: {
      findById: vi.fn(async (id: string) => ({ id, provider: 'github', owner_id: 'u1' })),
      getSecret: vi.fn(async () => 'tok'),
    },
    projectRepositories: {
      listByProject: vi.fn(async () => clone()),
      projectsWithSeveral: vi.fn(async () => (rows.length > 1 ? ['p1'] : [])),
      setStatus: vi.fn(async (id: string, status: RepoStatus) => {
        rows.find((r) => r.id === id)!.status = status;
      }),
      upsertDiscovered: vi.fn(async (projectId: string, machineId: string, found: DiscoveredCheckoutInput[]) => {
        const sorted = [...found].sort((a, b) => (a.dir < b.dir ? -1 : 1));
        const firsts: DiscoveredCheckoutInput[] = [];
        const duplicates: DiscoveredCheckoutInput[] = [];
        for (const f of sorted) (firsts.some((x) => sameRepo(x.full_name, f.full_name)) ? duplicates : firsts).push(f);
        const created = new Set<string>();
        const now = new Date(clock).toISOString();
        for (const f of firsts) {
          let row = rows.find((r) => sameRepo(r.full_name, f.full_name));
          if (!row) {
            row = { id: `r${++n}`, project_id: projectId, full_name: f.full_name, key: uniqueRepoKey(repoKeyFor(f.dir), rows.map((r) => r.key)), description: f.description ?? null, status: f.status ?? 'ok', discovered_at: now, updated_at: now, checkouts: [] };
            rows.push(row);
            created.add(row.id);
          } else if (f.status) row.status = f.status;
          const checkout = { machine_id: machineId, dir: f.dir, default_branch: f.default_branch, has_commits: f.has_commits, seen_at: now, missing_at: null };
          const i = row.checkouts.findIndex((c) => c.machine_id === machineId);
          if (i >= 0) row.checkouts[i] = checkout;
          else row.checkouts.push(checkout);
        }
        const repositories = clone();
        return { repositories, created: repositories.filter((r) => created.has(r.id)), duplicates };
      }),
      markMissing: vi.fn(async (_projectId: string, machineId: string, present: string[]) => {
        const gone = rows.filter((r) => !present.includes(r.id) && r.checkouts.some((c) => c.machine_id === machineId && c.missing_at === null));
        for (const r of gone) for (const c of r.checkouts) if (c.machine_id === machineId) c.missing_at = new Date(clock).toISOString();
        return gone.map((r) => ({ ...r }));
      }),
    },
  };
  return { repos: repos as unknown as Repositories, rows, events, lines, links, setupData };
}

function fakeAgent(answer: { repos: ScanRepo[]; truncated?: boolean }, over: Partial<DiscoveryDeps> = {}) {
  const state = { answer };
  const deps: DiscoveryDeps & { tick: (ms: number) => void; set: (a: { repos: ScanRepo[]; truncated?: boolean }) => void } = {
    canScan: () => 'ok',
    scan: vi.fn(async () => ({ repos: state.answer.repos, truncated: state.answer.truncated ?? false })),
    repoAccess: vi.fn(async () => 'ok' as const),
    now: () => clock,
    tick: (ms) => {
      clock += ms;
    },
    set: (a) => {
      state.answer = a;
    },
    ...over,
  };
  return deps;
}

const LINK: ProjectMachine = { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '~/code/rea', position: 0, created_at: '' };
const SINGLE = { repo: { integration_id: 'i1', full_name: 'acme/app', base_branch: 'main', branch_pattern: '{ticket}-{slug}', require_ticket: false, draft_pr: true, deploy_workflow: 'deploy.yml' } };

beforeEach(() => {
  resetDiscoveryState();
  clock = Date.parse('2026-11-16T12:00:00Z');
});

describe('repository discovery', () => {
  it('a single-repo project: the folder itself is key main, and nothing is announced', async () => {
    const f = fakeRepos({ setup: SINGLE });
    const agent = fakeAgent({ repos: [gh('.', 'acme/app')] });
    const r = await scanLink(f.repos, LINK, {}, agent);
    expect(r).toMatchObject({ scanned: true, found: 1, created: ['acme/app'], missing: [] });
    expect(agent.scan).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), { dir: '~/code/rea', depth: 1 });
    expect(f.rows.map((x) => [x.key, x.full_name, x.status])).toEqual([['main', 'acme/app', 'ok']]);
    expect(f.events).toEqual([]);
    expect(f.lines).toEqual([]);
    // the repository keeps the project's policy (spec §3.1), not the `pr` of a discovered one
    expect(effectiveRepos(f.setupData, f.rows)[0]).toMatchObject({ key: 'main', deploy_workflow: 'deploy.yml' });
    // scanning again changes nothing and says nothing
    agent.tick(SCAN_THROTTLE_MS);
    await scanLink(f.repos, LINK, {}, agent);
    expect(f.rows).toHaveLength(1);
    expect(f.events).toEqual([]);
  });

  it('a project with no repository in its Setup and one checkout in its folder: key main, nothing announced either', async () => {
    const f = fakeRepos();
    await scanLink(f.repos, LINK, {}, fakeAgent({ repos: [gh('.', 'acme/site')] }));
    expect(f.rows.map((x) => x.key)).toEqual(['main']);
    expect(f.events).toEqual([]);
    expect(f.lines).toEqual([]);
  });

  it('ten repositories on a first scan: one summary event and one chat line, each at level pr', async () => {
    const f = fakeRepos({ setup: SINGLE });
    const names = Array.from({ length: 10 }, (_, i) => `reactivandoio/repo-${i}`);
    const agent = fakeAgent({ repos: names.map((n, i) => gh(`repo-${i}`, n)) });
    const r = await scanLink(f.repos, LINK, {}, agent);
    expect(r.created).toHaveLength(10);
    expect(f.rows.map((x) => x.key)).toEqual(names.map((_, i) => `repo-${i}`));
    expect(f.events).toEqual([{ kind: 'repo_discovered', payload: expect.objectContaining({ first_scan: true, count: 10, machine_id: 'm1', machine: 'one' }) }]);
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toContain('10 repositórios encontrados na pasta do projeto: reactivandoio/repo-0');
    expect(effectiveRepos(f.setupData, f.rows).filter((e) => e.discovered).every((e) => e.autonomy === 'pr' && e.deploy_workflow === null)).toBe(true);
  });

  it('a repository added later: one event and one chat line with its level', async () => {
    const f = fakeRepos({ setup: SINGLE });
    const agent = fakeAgent({ repos: [gh('.', 'acme/app')] });
    await scanLink(f.repos, LINK, {}, agent);
    agent.set({ repos: [gh('.', 'acme/app'), gh('bff', 'acme/bff')] });
    agent.tick(SCAN_THROTTLE_MS);
    await scanLink(f.repos, LINK, {}, agent);
    expect(f.events).toEqual([{ kind: 'repo_discovered', payload: expect.objectContaining({ full_name: 'acme/bff', key: 'bff', autonomy: 'pr', status: 'ok' }) }]);
    expect(f.lines).toEqual(['Novo repositório na pasta do projeto: acme/bff (nível pr).']);
  });

  it('a repository that disappears is marked missing, never deleted; a truncated answer marks nothing', async () => {
    const f = fakeRepos();
    const agent = fakeAgent({ repos: [gh('web', 'acme/web'), gh('api', 'acme/api')] });
    await scanLink(f.repos, LINK, {}, agent);
    f.events.length = 0;

    agent.set({ repos: [gh('web', 'acme/web')], truncated: true });
    await scanLink(f.repos, LINK, { force: true }, agent);
    expect(f.rows.find((x) => x.key === 'api')!.checkouts[0]!.missing_at).toBeNull();

    agent.set({ repos: [gh('web', 'acme/web')] });
    const r = await scanLink(f.repos, LINK, { force: true }, agent);
    expect(r.missing).toEqual(['acme/api']);
    expect(f.rows).toHaveLength(2);
    expect(f.rows.find((x) => x.key === 'api')!.checkouts[0]!.missing_at).not.toBeNull();
    expect(f.events).toEqual([{ kind: 'repo_missing', payload: expect.objectContaining({ full_name: 'acme/api', key: 'api', machine: 'one' }) }]);
  });

  it('a folder renamed keeps the key and moves the checkout, with no event', async () => {
    const f = fakeRepos();
    const agent = fakeAgent({ repos: [gh('hub-web', 'acme/web'), gh('api', 'acme/api')] });
    await scanLink(f.repos, LINK, {}, agent);
    f.events.length = 0;
    f.lines.length = 0;
    agent.set({ repos: [gh('frontend', 'acme/web'), gh('api', 'acme/api')] });
    const r = await scanLink(f.repos, LINK, { force: true }, agent);
    expect(r).toMatchObject({ created: [], missing: [] });
    const web = f.rows.find((x) => x.full_name === 'acme/web')!;
    expect(web.key).toBe('hub-web');
    expect(web.checkouts[0]!.dir).toBe('frontend');
    expect(f.events).toEqual([]);
    expect(f.lines).toEqual([]);
  });

  it('an origin outside GitHub is unsupported, and GitHub is never asked about it', async () => {
    const f = fakeRepos({ setup: SINGLE });
    const agent = fakeAgent({ repos: [gh('.', 'acme/app')] });
    await scanLink(f.repos, LINK, {}, agent);
    agent.set({ repos: [gh('.', 'acme/app'), gh('tools', '', { origin: 'git@gitlab.com:acme/tools.git' }), gh('scratch', '', { origin: null })] });
    vi.mocked(agent.repoAccess).mockClear();
    await scanLink(f.repos, LINK, { force: true }, agent);
    expect(f.rows.filter((x) => x.status === 'unsupported').map((x) => [x.key, x.full_name])).toEqual([['scratch', 'local/scratch'], ['tools', 'gitlab.com/acme/tools']]);
    expect(agent.repoAccess).not.toHaveBeenCalled();
    expect(f.lines).toContain('Novo repositório na pasta do projeto: gitlab.com/acme/tools (fora do GitHub, fica de fora do automático).');
  });

  it('a repository the integration cannot read is no_access, and recovers once it can', async () => {
    const f = fakeRepos({ setup: SINGLE });
    const access = vi.fn(async (_token: string, name: string) => (name === 'acme/secret' ? ('no_access' as const) : ('ok' as const)));
    const agent = fakeAgent({ repos: [gh('.', 'acme/app'), gh('secret', 'acme/secret')] }, { repoAccess: access });
    await scanLink(f.repos, LINK, {}, agent);
    expect(f.rows.find((x) => x.full_name === 'acme/secret')!.status).toBe('no_access');
    expect(access).toHaveBeenCalledWith('tok', 'acme/secret');

    access.mockClear();
    access.mockImplementation(async () => 'ok');
    await scanLink(f.repos, LINK, { force: true }, agent);
    // only the one marked no_access is asked again
    expect(access.mock.calls.map((c) => c[1])).toEqual(['acme/secret']);
    expect(f.rows.find((x) => x.full_name === 'acme/secret')!.status).toBe('ok');
  });

  it('GitHub not answering keeps the status as it is', async () => {
    const f = fakeRepos({ setup: SINGLE });
    const agent = fakeAgent({ repos: [gh('.', 'acme/app'), gh('web', 'acme/web')] }, { repoAccess: vi.fn(async () => 'unknown' as const) });
    await scanLink(f.repos, LINK, {}, agent);
    expect(f.rows.every((x) => x.status === 'ok')).toBe(true);
  });

  it('skips a machine that cannot scan, and says why', async () => {
    const f = fakeRepos();
    for (const why of ['not_agent', 'offline', 'no_repo_scan'] as const) {
      const agent = fakeAgent({ repos: [gh('.', 'acme/app')] }, { canScan: () => why });
      expect(await scanLink(f.repos, LINK, { force: true }, agent)).toMatchObject({ scanned: false, skipped: why });
      expect(agent.scan).not.toHaveBeenCalled();
    }
    expect(f.rows).toEqual([]);
  });

  it('a folder the agent refuses (/ or home) is skipped as refused', async () => {
    const f = fakeRepos();
    const agent = fakeAgent({ repos: [] }, { scan: vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { code: 'MACHINE_INVALID' }))) });
    expect(await scanLink(f.repos, LINK, {}, agent)).toMatchObject({ scanned: false, skipped: 'refused' });
    expect(f.repos.projectRepositories.upsertDiscovered).not.toHaveBeenCalled();
  });

  it('the automatic triggers scan a link once a minute; an on-demand scan always runs', async () => {
    const f = fakeRepos();
    const agent = fakeAgent({ repos: [gh('.', 'acme/app')] });
    expect((await scanLink(f.repos, LINK, {}, agent)).scanned).toBe(true);
    expect(await scanLink(f.repos, LINK, {}, agent)).toMatchObject({ scanned: false, skipped: 'throttled' });
    expect((await scanLink(f.repos, LINK, { force: true }, agent)).scanned).toBe(true);
    // the other colour's scan, read from the checkouts' seen_at, throttles this instance too
    resetDiscoveryState();
    expect(await scanLink(f.repos, LINK, {}, agent)).toMatchObject({ skipped: 'throttled' });
    agent.tick(SCAN_THROTTLE_MS);
    expect((await scanLink(f.repos, LINK, {}, agent)).scanned).toBe(true);
    expect(agent.scan).toHaveBeenCalledTimes(3);
  });

  it('two scans of the same link at once share one', async () => {
    const f = fakeRepos();
    const agent = fakeAgent({ repos: [gh('.', 'acme/app')] });
    const [a, b] = await Promise.all([scanLink(f.repos, LINK, { force: true }, agent), scanLink(f.repos, LINK, { force: true }, agent)]);
    expect(a).toBe(b);
    expect(agent.scan).toHaveBeenCalledTimes(1);
  });

  it('scans every linked machine, with the scan depth of the Setup', async () => {
    const links: ProjectMachine[] = [LINK, { ...LINK, id: 'l2', machine_id: 'm2', cwd: '/srv/rea' }];
    const f = fakeRepos({ links, machines: [machine('m1'), machine('m2')], setup: { repo_defaults: { scan_depth: 2 } } });
    const agent = fakeAgent({ repos: [gh('web', 'acme/web')] });
    const out = await scanProject(f.repos, 'p1', {}, agent);
    expect(out.map((o) => [o.machine_id, o.scanned])).toEqual([['m1', true], ['m2', true]]);
    expect(vi.mocked(agent.scan).mock.calls.map((c) => c[1])).toEqual([{ dir: '~/code/rea', depth: 2 }, { dir: '/srv/rea', depth: 2 }]);
    expect(f.rows[0]!.checkouts.map((c) => c.machine_id)).toEqual(['m1', 'm2']);
  });

  it('the loop takes projects with automation on or with several repositories', async () => {
    const f = fakeRepos({ setup: { automation: { enabled: false } } });
    expect(await loopProjects(f.repos)).toEqual([]);
    const on = fakeRepos({ setup: { automation: { enabled: true } } });
    expect(await loopProjects(on.repos)).toEqual(['p1']);
    await scanLink(f.repos, LINK, {}, fakeAgent({ repos: [gh('a', 'acme/a'), gh('b', 'acme/b')] }));
    expect(await loopProjects(f.repos)).toEqual(['p1']);
  });
});
