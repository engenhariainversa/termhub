import { beforeEach, describe, expect, it, vi } from 'vitest';

const readMachineSecret = vi.fn();
vi.mock('../integrations/machine-secret.js', () => ({ readMachineSecret: (...a: unknown[]) => readMachineSecret(...a) }));
const testConnection = vi.fn();
vi.mock('../integrations/index.js', () => ({ getProvider: () => ({ testConnection: (...a: unknown[]) => testConnection(...a) }) }));
let encryption = true;
vi.mock('../lib/crypto.js', () => ({ encryptionAvailable: () => encryption }));

import type { Repositories } from '../db/repositories/index.js';
import type { Integration } from '../db/repositories/integrations.js';
import type { Machine, Project } from '../db/repositories/types.js';
import { Scoped } from '../auth/scope.js';
import { HttpError } from '../lib/errors.js';
import { effectiveRepos } from '../setup/repos.js';
import { setupSchema, type ProjectSetupData } from '../setup/schema.js';
import { ControlError, type ControlContext } from './context.js';
import { createIntegration, getProjectSetup, listIntegrations, setProjectRepo } from './integrations.js';

const TOKEN = 'gho_S3cretTokenValue123';

const project = (id: string, owner: string | null): Project => ({ id, owner_id: owner, key: id.toUpperCase(), next_task_number: 1, name: id, status: 'active', description: null, last_terminal_at: null, created_at: '' });
const machine = (id: string, owner: string): Machine => ({ id, name: `máquina ${id}`, type: 'agent', owner_id: owner }) as Machine;
const integration = (over: Partial<Integration> & { id: string }): Integration => ({
  provider: 'github', name: `GitHub ${over.id}`, config: { login: 'ana' }, owner_id: 'u1', created_at: '2026-09-28T00:00:00.000Z', updated_at: '', ...over,
});

let integrations: Integration[];
let setups: Map<string, ProjectSetupData>;
let created: { secret: string; owner_id: string | null; config: Record<string, unknown> }[];

function ctxFor(user = 'u1'): ControlContext {
  const projects = [project('p1', 'u1'), project('px', 'u2')];
  const machines = [machine('m1', 'u1'), machine('mx', 'u2')];
  const repos = {
    projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)) },
    machines: { findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)) },
    integrations: {
      list: vi.fn(async (owner: string | null) => integrations.filter((i) => owner === null || i.owner_id === owner)),
      findById: vi.fn(async (id: string) => integrations.find((i) => i.id === id)),
      getSecret: vi.fn(async () => TOKEN),
      create: vi.fn(async (input: { provider: 'github'; name: string; config: Record<string, unknown>; secret: string; owner_id: string | null }) => {
        created.push({ secret: input.secret, owner_id: input.owner_id, config: input.config });
        const i = integration({ id: `new${created.length}`, provider: input.provider, name: input.name, config: input.config, owner_id: input.owner_id });
        integrations.push(i);
        return i;
      }),
    },
    projectSetup: {
      get: vi.fn(async (pid: string) => ({ project_id: pid, version: 2, data: setups.get(pid) ?? setupSchema.parse({}), updated_at: null })),
      save: vi.fn(async (pid: string, data: ProjectSetupData) => {
        setups.set(pid, data);
        return { project_id: pid, version: 2, data, updated_at: '2026-09-28T01:00:00.000Z' };
      }),
    },
    projectRepositories: { effective: vi.fn(async (_pid: string, data: ProjectSetupData) => effectiveRepos(data, [])) },
  } as unknown as Repositories;
  const scope = { user: { id: user } as never, viewAs: { kind: 'self' as const }, ownerId: user, createAs: user };
  return { repos, scope, scoped: new Scoped(repos, scope), can: async () => true };
}

/** Rejects with a ControlError/HttpError of `code`, whose message never carries the token. */
async function rejectsWith(p: Promise<unknown>, code: string): Promise<string> {
  const err = (await p.then(() => null, (e: unknown) => e)) as Error | null;
  expect(err).toBeInstanceOf(Error);
  expect(err instanceof ControlError || err instanceof HttpError).toBe(true);
  expect((err as ControlError).code).toBe(code);
  expect(err!.message).not.toContain(TOKEN);
  return err!.message;
}

beforeEach(() => {
  vi.clearAllMocks();
  encryption = true;
  created = [];
  integrations = [
    integration({ id: 'g1', config: { login: 'ana', stray: 'x' } }),
    integration({ id: 'j1', provider: 'jira', name: 'Jira', config: { baseUrl: 'https://acme.atlassian.net', email: 'ana@acme.dev' } }),
    integration({ id: 'gx', owner_id: 'u2' }),
  ];
  setups = new Map();
  readMachineSecret.mockResolvedValue(TOKEN);
  testConnection.mockResolvedValue({ ok: true, account: 'ana', options: { repos: [{ id: 'acme/api', name: 'acme/api' }] } });
});

describe('listIntegrations', () => {
  it("lists the caller's integrations with their public config only, never the secret", async () => {
    const r = await listIntegrations(ctxFor(), {});
    expect(r.integrations.map((i) => i.id)).toEqual(['g1', 'j1']);
    expect(r.integrations[0]).toEqual({ id: 'g1', provider: 'github', name: 'GitHub g1', config: { login: 'ana' }, created_at: '2026-09-28T00:00:00.000Z' });
    expect(r.integrations[1].config).toEqual({ baseUrl: 'https://acme.atlassian.net', email: 'ana@acme.dev' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('filters by provider', async () => {
    expect((await listIntegrations(ctxFor(), { provider: 'jira' })).integrations.map((i) => i.id)).toEqual(['j1']);
  });
});

describe('createIntegration', () => {
  const input = { provider: 'github' as const, name: 'GitHub pessoal', secret_from: { machine_id: 'm1', source: 'gh_auth_token' as const } };

  it("reads the machine's gh token, tests it, stores it with config.login and returns no secret", async () => {
    const r = await createIntegration(ctxFor(), input);
    expect(readMachineSecret).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'gh_auth_token');
    expect(testConnection).toHaveBeenCalledWith(TOKEN, {});
    expect(created).toEqual([{ secret: TOKEN, owner_id: 'u1', config: { login: 'ana' } }]);
    expect(r).toEqual({ id: 'new1', provider: 'github', name: 'GitHub pessoal', config: { login: 'ana' }, created_at: '2026-09-28T00:00:00.000Z', account: 'ana' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("refuses another owner's machine (404) without reading anything", async () => {
    await expect(createIntegration(ctxFor(), { ...input, secret_from: { machine_id: 'mx', source: 'gh_auth_token' } })).rejects.toMatchObject({ statusCode: 404 });
    expect(readMachineSecret).not.toHaveBeenCalled();
  });

  it('refuses a provider other than github', async () => {
    await rejectsWith(createIntegration(ctxFor(), { ...input, provider: 'jira' as never }), 'INTEGRATION_NOT_ALLOWED');
    expect(readMachineSecret).not.toHaveBeenCalled();
  });

  it('saves nothing when the GitHub test fails, and says the status, never the token or the body', async () => {
    testConnection.mockResolvedValue({ ok: false, error: `GitHub 401: {"message":"Bad credentials ${TOKEN}"}` });
    const msg = await rejectsWith(createIntegration(ctxFor(), input), 'INTEGRATION_TEST_FAILED');
    expect(msg).toContain('401');
    expect(msg).not.toContain('Bad credentials');
    expect(created).toEqual([]);
  });

  it('saves nothing when GitHub cannot be reached', async () => {
    testConnection.mockResolvedValue({ ok: false, error: `fetch failed ${TOKEN}` });
    await rejectsWith(createIntegration(ctxFor(), input), 'INTEGRATION_TEST_FAILED');
    expect(created).toEqual([]);
  });

  it('passes the machine errors through and saves nothing', async () => {
    readMachineSecret.mockRejectedValue(new HttpError(502, '`gh auth token` falhou na máquina m1: rode `gh auth login` nela', 'SECRET_UNAVAILABLE'));
    await rejectsWith(createIntegration(ctxFor(), input), 'SECRET_UNAVAILABLE');
    expect(testConnection).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('refuses before reading the token when the server cannot encrypt', async () => {
    encryption = false;
    await rejectsWith(createIntegration(ctxFor(), input), 'ENCRYPTION_UNAVAILABLE');
    expect(readMachineSecret).not.toHaveBeenCalled();
  });
});

describe('getProjectSetup', () => {
  it('returns the repository block and its integration, without the secret', async () => {
    setups.set('p1', setupSchema.parse({ repo: { integration_id: 'g1', full_name: 'acme/api', deploy_workflow: 'deploy.yml' } }));
    const r = await getProjectSetup(ctxFor(), { project_id: 'p1' });
    expect(r.repo).toMatchObject({ integration_id: 'g1', full_name: 'acme/api', deploy_workflow: 'deploy.yml', base_branch: 'main' });
    expect(r.integration).toEqual({ id: 'g1', provider: 'github', name: 'GitHub g1', config: { login: 'ana' }, created_at: '2026-09-28T00:00:00.000Z' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('answers repo null when nothing is set, and 404 for a foreign project', async () => {
    const r = await getProjectSetup(ctxFor(), { project_id: 'p1' });
    expect(r.repo).toBeNull();
    expect(r.repos).toEqual([]);
    expect(r.integration).toBeNull();
    await expect(getProjectSetup(ctxFor(), { project_id: 'px' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lists the effective repositories: the repo block as the entry of key main, and the overrides', async () => {
    setups.set('p1', setupSchema.parse({
      repo: { integration_id: 'g1', full_name: 'acme/api', deploy_workflow: 'deploy.yml' },
      automation: { autonomy: 'merge' },
      repos: [{ full_name: 'acme/web', autonomy: 'release', merge_order: 1 }],
    }));
    const r = await getProjectSetup(ctxFor(), { project_id: 'p1' });
    expect(r.repos.map((e) => [e.full_name, e.key, e.autonomy, e.deploy_workflow])).toEqual([['acme/api', 'main', 'merge', 'deploy.yml'], ['acme/web', null, 'merge', null]]);
  });
});

describe('setProjectRepo', () => {
  const base = { project_id: 'p1', integration_id: 'g1', full_name: 'acme/api' };

  it('writes the repository block and keeps every other setup block unchanged', async () => {
    const before = setupSchema.parse({
      repo: { integration_id: null, full_name: null, branch_pattern: 'feat/{ticket}', draft_pr: false },
      ticket_sources: [{ provider: 'jira', integration_id: 'j1', scope: 'PROJ', sync_minutes: 15 }],
      runner: { machine_id: 'm1', setup_command: 'npm ci' },
      agent: { command: 'codex' },
      verify: { type: 'command', target: 'npm test' },
      approvals: { merge: 'auto' },
    });
    setups.set('p1', before);
    const r = await setProjectRepo(ctxFor(), { ...base, deploy_workflow: 'deploy.yml', base_branch: 'develop' });
    const saved = setups.get('p1')!;
    expect(saved.repo).toEqual({ integration_id: 'g1', full_name: 'acme/api', base_branch: 'develop', branch_pattern: 'feat/{ticket}', require_ticket: false, draft_pr: false, deploy_workflow: 'deploy.yml' });
    for (const k of ['ticket_sources', 'runner', 'agent', 'verify', 'approvals'] as const) expect(saved[k]).toEqual(before[k]);
    expect(setupSchema.safeParse(saved).success).toBe(true);
    expect(r.repo).toEqual(saved.repo);
    expect(r.integration).toMatchObject({ id: 'g1', provider: 'github' });
  });

  it('keeps deploy_workflow and base_branch when left out, and clears deploy_workflow with null', async () => {
    setups.set('p1', setupSchema.parse({ repo: { integration_id: 'g1', full_name: 'acme/old', base_branch: 'trunk', deploy_workflow: 'ship.yml' } }));
    await setProjectRepo(ctxFor(), base);
    expect(setups.get('p1')!.repo).toMatchObject({ full_name: 'acme/api', base_branch: 'trunk', deploy_workflow: 'ship.yml' });
    await setProjectRepo(ctxFor(), { ...base, deploy_workflow: null });
    expect(setups.get('p1')!.repo!.deploy_workflow).toBeNull();
  });

  it('refuses an integration that is not GitHub, or of another owner, and saves nothing', async () => {
    await rejectsWith(setProjectRepo(ctxFor(), { ...base, integration_id: 'j1' }), 'INTEGRATION_NOT_ALLOWED');
    await expect(setProjectRepo(ctxFor(), { ...base, integration_id: 'gx' })).rejects.toMatchObject({ statusCode: 404 });
    expect(setups.size).toBe(0);
  });

  it("refuses when the integration's owner is not the project's owner (admin scope)", async () => {
    const ctx = ctxFor();
    const all = { ...ctx.scope, ownerId: null };
    const admin: ControlContext = { ...ctx, scope: all, scoped: new Scoped(ctx.repos, all) };
    await rejectsWith(setProjectRepo(admin, { project_id: 'px', integration_id: 'g1', full_name: 'acme/api' }), 'INTEGRATION_NOT_ALLOWED');
    expect(setups.size).toBe(0);
  });

  it('refuses a repository that is not owner/repo', async () => {
    for (const full_name of ['acme', 'acme/api/x', 'https://github.com/acme/api', '../..', 'acme/..', 'acme api/x']) {
      await rejectsWith(setProjectRepo(ctxFor(), { ...base, full_name }), 'INVALID_REPO');
    }
    expect(setups.size).toBe(0);
  });

  it('404s a foreign project', async () => {
    await expect(setProjectRepo(ctxFor(), { ...base, project_id: 'px' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
