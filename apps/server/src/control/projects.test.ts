import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/errors.js';
import { ProjectRuleError } from '../db/repositories/projects.js';

const { browseMachine, ensureDirectory } = vi.hoisted(() => ({ browseMachine: vi.fn(), ensureDirectory: vi.fn() }));
vi.mock('../terminal/machine-fs.js', () => ({ browseMachine, ensureDirectory }));
vi.mock('../terminal/machine-exec.js', () => ({ killTmuxSession: vi.fn() }));
vi.mock('../terminal/tab-mcp.js', () => ({ removeTabMcp: vi.fn() }));
vi.mock('../monitor/tab-events.js', () => ({ publishTabsRemoved: vi.fn() }));

const { createProject, createProjectRecord } = await import('./projects.js');

const machine = { id: 'm1', name: 'homem de ferro', type: 'agent', os: 'linux', capabilities: ['tmux'], owner_id: 'u1' };
const groups = [
  { id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: [] },
  { id: 'g1', name: 'Clientes', kind: 'custom', position: 1, project_ids: ['p0', 'hidden'] },
];

const rule = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `Pergunta ${id}`, text: `Decisão: resposta ${id}\nMotivo: m\nFontes: `, project_id: 'p0', scope: 'project', ...over });

function ctxWith(over: { create?: ReturnType<typeof vi.fn>; machine?: ReturnType<typeof vi.fn>; project?: ReturnType<typeof vi.fn>; rules?: ReturnType<typeof rule>[] } = {}) {
  const repos = {
    memoryItems: {
      currentNotes: vi.fn(async () => over.rules ?? []),
      upsertMany: vi.fn(async (items: unknown[]) => items),
    },
    projects: {
      create: over.create ?? vi.fn(async (input: { owner_id: string; key: string; name: string }) => ({ id: 'p9', is_public: false, status: 'active', ...input })),
      list: vi.fn(async () => [{ id: 'p0' }, { id: 'p9' }]),
    },
    projectMachines: { link: vi.fn(async (input: { project_id: string; machine_id: string; cwd: string }) => ({ id: 'l1', position: 0, created_at: '', ...input })) },
    projectGroups: { read: vi.fn(async () => groups), setMemberships: vi.fn(async () => []) },
  };
  return {
    repos,
    scope: { user: { id: 'u1' }, ownerId: 'u1', createAs: 'u1' },
    scoped: {
      machine: over.machine ?? vi.fn(async () => machine),
      project: over.project ?? vi.fn(async (id: string) => ({ project: { id, name: 'Opa Pingou', owner_id: 'u1' } })),
    },
  } as never as Parameters<typeof createProject>[0] & { repos: typeof repos; scoped: { machine: ReturnType<typeof vi.fn>; project: ReturnType<typeof vi.fn> } };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureDirectory.mockReset();
  browseMachine.mockReset();
});

describe('createProjectRecord', () => {
  it('creates the project and, given one, links the machine — the service the Projetos screen uses too', async () => {
    const ctx = ctxWith();
    const r = await createProjectRecord(ctx.repos as never, 'u1', { name: 'Piki', key: 'PIKI' }, { machine: machine as never, cwd: '/srv/piki' });
    expect(ctx.repos.projects.create).toHaveBeenCalledWith({ owner_id: 'u1', key: 'PIKI', name: 'Piki', description: undefined, status: undefined });
    expect(ctx.repos.projectMachines.link).toHaveBeenCalledWith({ project_id: 'p9', machine_id: 'm1', cwd: '/srv/piki' });
    expect(r.link).toMatchObject({ machine_id: 'm1', cwd: '/srv/piki' });
  });

  it('without a machine creates the project only', async () => {
    const ctx = ctxWith();
    const r = await createProjectRecord(ctx.repos as never, 'u1', { name: 'Piki', key: 'PIKI' });
    expect(ctx.repos.projectMachines.link).not.toHaveBeenCalled();
    expect(r.link).toBeNull();
  });
});

describe('"Herdar regras de" (TER-1169)', () => {
  it('copies the source project\'s own current rules into the new project, citing each one', async () => {
    const ctx = ctxWith({ rules: [rule('n2'), rule('n1'), rule('everywhere', { scope: 'user' }), rule('nul', { project_id: null, scope: 'user' })] });
    const r = await createProject(ctx, { name: 'Piki Digital', key: 'PIKI', inherit_rules_from: 'p0' });
    expect(ctx.scoped.project).toHaveBeenCalledWith('p0');
    expect(ctx.repos.memoryItems.currentNotes).toHaveBeenCalledWith('u1', 'p0', expect.any(Number));
    const items = ctx.repos.memoryItems.upsertMany.mock.calls[0]![0] as { owner_id: string; project_id: string; kind: string; scope: string; title: string; text: string; written_by: string }[];
    // only the rules scoped to the source; the account-wide ones already hold everywhere. Oldest first.
    expect(items.map((i) => i.title)).toEqual(['Pergunta n1', 'Pergunta n2']);
    expect(items[0]).toMatchObject({ owner_id: 'u1', project_id: 'p9', kind: 'note', scope: 'project', written_by: 'person' });
    expect(items[0]!.text).toBe('Decisão: resposta n1\nMotivo: Herdada do projeto Opa Pingou ao criar este projeto.\nFontes: note:n1');
    expect(r.inherited_rules).toEqual({ from: { id: 'p0', name: 'Opa Pingou' }, count: 2 });
  });

  it('a project outside the person\'s scope is refused before anything is created', async () => {
    const ctx = ctxWith({ project: vi.fn(async () => Promise.reject(new HttpError(404, 'Projeto não encontrado'))) });
    await expect(createProject(ctx, { name: 'Piki', key: 'PIKI', inherit_rules_from: 'px' })).rejects.toBeInstanceOf(HttpError);
    expect(ctx.repos.projects.create).not.toHaveBeenCalled();
    expect(ctx.repos.memoryItems.currentNotes).not.toHaveBeenCalled();
  });

  it('never copies across owners, and a source with no rules of its own copies nothing', async () => {
    const ctx = ctxWith({ rules: [rule('n1')] });
    const r = await createProjectRecord(ctx.repos as never, 'u1', { name: 'Piki', key: 'PIKI' }, undefined, { id: 'p0', name: 'Outro', owner_id: 'u2' } as never);
    expect(r.inherited_rules).toBe(0);
    expect(ctx.repos.memoryItems.currentNotes).not.toHaveBeenCalled();
    const empty = ctxWith({ rules: [rule('u', { scope: 'user' })] });
    const r2 = await createProject(empty, { name: 'Piki', key: 'PIKI', inherit_rules_from: 'p0' });
    expect(empty.repos.memoryItems.upsertMany).not.toHaveBeenCalled();
    expect(r2.inherited_rules).toEqual({ from: { id: 'p0', name: 'Opa Pingou' }, count: 0 });
  });

  it('without inherit_rules_from nothing is read and the answer has no inherited_rules', async () => {
    const ctx = ctxWith();
    const r = await createProject(ctx, { name: 'Piki', key: 'PIKI' });
    expect(ctx.repos.memoryItems.currentNotes).not.toHaveBeenCalled();
    expect(r).not.toHaveProperty('inherited_rules');
  });
});

describe('createProject (create_project)', () => {
  it('creates with the given key, owned by the caller, and answers id, key and url', async () => {
    const ctx = ctxWith();
    const r = await createProject(ctx, { name: 'Piki Digital', key: 'PIKI' });
    expect(ctx.repos.projects.create).toHaveBeenCalledWith(expect.objectContaining({ owner_id: 'u1', key: 'PIKI', name: 'Piki Digital' }));
    expect(r.project).toMatchObject({ id: 'p9', key: 'PIKI', name: 'Piki Digital' });
    expect(r.project.url).toMatch(/\/projects\/p9$/);
    expect(r.project.board_url).toMatch(/\/projects\/p9\/tasks$/);
    expect(r).toMatchObject({ key_suggested: false, group: null, machine: null });
  });

  it('without a key uses the suggestion from the name, the one the screen pre-fills', async () => {
    const ctx = ctxWith();
    const r = await createProject(ctx, { name: 'Piki Digital App' });
    expect(ctx.repos.projects.create).toHaveBeenCalledWith(expect.objectContaining({ key: 'PDA' }));
    expect(r.key_suggested).toBe(true);
  });

  it('turns a duplicate key into KEY_TAKEN, and says to pass another key when it was the suggestion', async () => {
    const taken = vi.fn(async () => {
      throw new ProjectRuleError('KEY_TAKEN', 'A chave PIKI já está em uso');
    });
    await expect(createProject(ctxWith({ create: taken }), { name: 'Piki', key: 'PIKI' })).rejects.toMatchObject({ name: 'ControlError', code: 'KEY_TAKEN' });
    await expect(createProject(ctxWith({ create: taken }), { name: 'Piki' })).rejects.toMatchObject({ code: 'KEY_TAKEN', message: expect.stringMatching(/repita com outra chave em key/) });
  });

  it('refuses a group that is not one of the person\'s, before creating anything', async () => {
    const ctx = ctxWith();
    await expect(createProject(ctx, { name: 'Piki', key: 'PIKI', group: 'Inexistente' })).rejects.toMatchObject({ code: 'GROUP_NOT_FOUND' });
    // Favoritos is not a group a project is put in here
    await expect(createProject(ctx, { name: 'Piki', key: 'PIKI', group: 'fav' })).rejects.toMatchObject({ code: 'GROUP_NOT_FOUND' });
    expect(ctx.repos.projects.create).not.toHaveBeenCalled();
  });

  it('puts the project at the end of a group named by name (accents and case ignored) or id, keeping the members', async () => {
    const ctx = ctxWith();
    const r = await createProject(ctx, { name: 'Piki', key: 'PIKI', group: 'clientes' });
    expect(r.group).toEqual({ id: 'g1', name: 'Clientes' });
    const [userId, changes, visible] = ctx.repos.projectGroups.setMemberships.mock.calls[0] as unknown as [string, { id: string; project_ids: string[] }[], (id: string) => boolean];
    expect(userId).toBe('u1');
    expect(changes).toEqual([{ id: 'g1', project_ids: ['p0', 'p9'] }]);
    // a member the caller cannot see is not in the list: setMemberships keeps it
    expect(visible('hidden')).toBe(false);

    expect((await createProject(ctxWith(), { name: 'Piki', key: 'PIKI', group: 'g1' })).group).toEqual({ id: 'g1', name: 'Clientes' });
  });

  it('links the first machine with the resolved folder, like link_project_machine', async () => {
    ensureDirectory.mockResolvedValue({ path: '/home/u/piki', created: true });
    browseMachine.mockResolvedValue({ entries: [] });
    const ctx = ctxWith();
    const r = await createProject(ctx, { name: 'Piki', key: 'PIKI', machine_id: 'm1', cwd: '~/piki', create_dir: true });
    expect(ctx.scoped.machine).toHaveBeenCalledWith('m1');
    expect(ensureDirectory).toHaveBeenCalledWith(machine, '~/piki', true);
    expect(ctx.repos.projectMachines.link).toHaveBeenCalledWith({ project_id: 'p9', machine_id: 'm1', cwd: '/home/u/piki' });
    expect(r.machine).toMatchObject({ project_id: 'p9', machine_id: 'm1', machine_name: 'homem de ferro', cwd: '/home/u/piki', created_dir: true, git_repo: false });
  });

  it('a missing folder answers DIR_NOT_FOUND with what to do, and no project is created', async () => {
    ensureDirectory.mockRejectedValue(new HttpError(400, 'A pasta não existe na máquina', 'DIR_NOT_FOUND'));
    const ctx = ctxWith();
    await expect(createProject(ctx, { name: 'Piki', key: 'PIKI', machine_id: 'm1', cwd: '~/nope' })).rejects.toMatchObject({ code: 'DIR_NOT_FOUND', message: expect.stringMatching(/create_dir: true/) });
    expect(ctx.repos.projects.create).not.toHaveBeenCalled();
  });

  it('a machine outside the caller\'s scope fails before anything is created', async () => {
    const ctx = ctxWith({ machine: vi.fn(async () => Promise.reject(new HttpError(404, 'Máquina não encontrada', 'NOT_FOUND'))) });
    await expect(createProject(ctx, { name: 'Piki', key: 'PIKI', machine_id: 'm2', cwd: '/srv' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ctx.repos.projects.create).not.toHaveBeenCalled();
  });

  it('machine_id and cwd go together', async () => {
    const ctx = ctxWith();
    await expect(createProject(ctx, { name: 'Piki', key: 'PIKI', machine_id: 'm1' })).rejects.toMatchObject({ code: 'MACHINE_AND_CWD' });
    await expect(createProject(ctx, { name: 'Piki', key: 'PIKI', cwd: '/srv' })).rejects.toMatchObject({ code: 'MACHINE_AND_CWD' });
    expect(ctx.repos.projects.create).not.toHaveBeenCalled();
  });
});
