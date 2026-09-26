import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/errors.js';
import { ProjectRuleError } from '../db/repositories/projects.js';

const { browseMachine, ensureDirectory, killTmuxSession, publishTabsRemoved, publicBus } = vi.hoisted(() => ({
  browseMachine: vi.fn(),
  ensureDirectory: vi.fn(),
  killTmuxSession: vi.fn(),
  publishTabsRemoved: vi.fn(async () => undefined),
  publicBus: { publish: vi.fn(), publishRobotsGone: vi.fn() },
}));
vi.mock('../terminal/machine-fs.js', () => ({ browseMachine, ensureDirectory }));
vi.mock('../terminal/machine-exec.js', () => ({ killTmuxSession }));
vi.mock('../public/bus.js', () => ({ publicBus }));
vi.mock('../monitor/tab-events.js', () => ({ publishTabsRemoved }));

const { PROJECT_CWD, announceLinked, linkProjectMachine, removeProjectMachineLink, setProjectMachineCwd, unlinkProjectMachine } = await import('./project-links.js');

const machine = { id: 'm1', name: 'jarvis', type: 'agent', os: 'linux', capabilities: ['tmux'], owner_id: 'u1' };
const link = { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/home/u/app', position: 0, created_at: '' };
const project = (over: Record<string, unknown> = {}) => ({ id: 'p1', name: 'app', status: 'active', owner_id: 'u1', key: 'APP', next_task_number: 1, is_public: false, ...over });
const tab = (over: Record<string, unknown> = {}) => ({ id: 't1', project_id: 'p1', machine_id: 'm1', name: 'Terminal 1', kind: 'terminal', tmux_session: 'termhub-p1-t1', ...over });

function ctxWith(over: { project?: ReturnType<typeof project>; projectMachines?: Record<string, unknown>; tabs?: Record<string, unknown> } = {}) {
  const proj = over.project ?? project();
  const projectMachines = {
    find: vi.fn(async () => undefined),
    link: vi.fn(async (input: { project_id: string; machine_id: string; cwd: string }) => ({ id: 'l1', ...input, position: 0, created_at: '' })),
    updateCwd: vi.fn(async (projectId: string, machineId: string, cwd: string) => ({ id: 'l1', project_id: projectId, machine_id: machineId, cwd, position: 0, created_at: '' })),
    unlink: vi.fn(async () => true),
    ...over.projectMachines,
  };
  const tabs = {
    listByProjectMachine: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    ...over.tabs,
  };
  return {
    repos: { projectMachines, tabs },
    scoped: {
      project: vi.fn(async () => ({ project: proj })),
      machine: vi.fn(async () => machine),
      projectMachine: vi.fn(async () => ({ project: proj, machine, link })),
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureDirectory.mockReset();
  browseMachine.mockReset();
});

describe('PROJECT_CWD', () => {
  it('refuses a relative path', () => {
    expect(PROJECT_CWD.safeParse('termhub').success).toBe(false);
    expect(PROJECT_CWD.safeParse('./x').success).toBe(false);
  });

  it('accepts posix absolute, home and windows paths', () => {
    for (const p of ['/a', '~', '~/a', 'C:\\a']) expect(PROJECT_CWD.safeParse(p).success).toBe(true);
  });
});

describe('linkProjectMachine', () => {
  it('stores the resolved absolute path and reports git_repo true when .git is present', async () => {
    ensureDirectory.mockResolvedValue({ path: '/home/u/app', created: false });
    browseMachine.mockResolvedValue({ entries: [{ name: '.git', path: '/home/u/app/.git' }] });
    const ctx = ctxWith();
    const r = await linkProjectMachine(ctx, { project_id: 'p1', machine_id: 'm1', cwd: '~/app' });
    expect(ensureDirectory).toHaveBeenCalledWith(machine, '~/app', false);
    expect(ctx.repos.projectMachines.link).toHaveBeenCalledWith({ project_id: 'p1', machine_id: 'm1', cwd: '/home/u/app' });
    expect(r).toMatchObject({ project_id: 'p1', machine_id: 'm1', machine_name: 'jarvis', cwd: '/home/u/app', created_dir: false, git_repo: true });
    expect(r.note).toBeUndefined();
  });

  it('announces the link on the public bus only for a public project', async () => {
    ensureDirectory.mockResolvedValue({ path: '/home/u/app', created: false });
    browseMachine.mockResolvedValue({ entries: [] });
    await linkProjectMachine(ctxWith(), { project_id: 'p1', machine_id: 'm1', cwd: '~/app' });
    expect(publicBus.publish).not.toHaveBeenCalled();

    await linkProjectMachine(ctxWith({ project: project({ is_public: true }) }), { project_id: 'p1', machine_id: 'm1', cwd: '~/app' });
    expect(publicBus.publish).toHaveBeenCalledWith({ project_id: 'p1', is_public: true });
  });

  it('passes create_dir through and reports created_dir true', async () => {
    ensureDirectory.mockResolvedValue({ path: '/home/u/newapp', created: true });
    browseMachine.mockResolvedValue({ entries: [] });
    const ctx = ctxWith();
    const r = await linkProjectMachine(ctx, { project_id: 'p1', machine_id: 'm1', cwd: '~/newapp', create_dir: true });
    expect(ensureDirectory).toHaveBeenCalledWith(machine, '~/newapp', true);
    expect(r.created_dir).toBe(true);
  });

  it('turns a missing directory into an actionable DIR_NOT_FOUND', async () => {
    ensureDirectory.mockRejectedValue(new HttpError(400, 'A pasta não existe na máquina', 'DIR_NOT_FOUND'));
    const ctx = ctxWith();
    await expect(linkProjectMachine(ctx, { project_id: 'p1', machine_id: 'm1', cwd: '~/nope' })).rejects.toMatchObject({
      code: 'DIR_NOT_FOUND',
      message: expect.stringMatching(/create_dir: true/),
    });
    await expect(linkProjectMachine(ctx, { project_id: 'p1', machine_id: 'm1', cwd: '~/nope' })).rejects.toMatchObject({
      message: expect.stringMatching(/git clone/),
    });
  });

  it('refuses an already-linked machine before touching the directory', async () => {
    const ctx = ctxWith({ projectMachines: { find: vi.fn(async () => link) } });
    await expect(linkProjectMachine(ctx, { project_id: 'p1', machine_id: 'm1', cwd: '~/app' })).rejects.toMatchObject({ code: 'MACHINE_ALREADY_LINKED' });
    expect(ensureDirectory).not.toHaveBeenCalled();
    expect(ctx.repos.projectMachines.link).not.toHaveBeenCalled();
  });

  it('reports git_repo false with a note when the folder has no .git — softened for the worktree/submodule case, where .git is a file browseMachine would not list', async () => {
    ensureDirectory.mockResolvedValue({ path: '/home/u/app', created: false });
    browseMachine.mockResolvedValue({ entries: [{ name: 'src', path: '/home/u/app/src' }] });
    const r = await linkProjectMachine(ctxWith(), { project_id: 'p1', machine_id: 'm1', cwd: '~/app' });
    expect(r.git_repo).toBe(false);
    expect(r.note).toBe('Não encontrei uma pasta .git aqui (num worktree ou submódulo o .git é um arquivo, e isso não aparece nesta checagem).');
  });

  it('reports git_repo null when the directory listing fails', async () => {
    ensureDirectory.mockResolvedValue({ path: '/home/u/app', created: false });
    browseMachine.mockRejectedValue(new Error('offline'));
    const r = await linkProjectMachine(ctxWith(), { project_id: 'p1', machine_id: 'm1', cwd: '~/app' });
    expect(r.git_repo).toBeNull();
    expect(r.note).toBeUndefined();
  });

  it('turns a repository rule error into a ControlError with the same code', async () => {
    ensureDirectory.mockResolvedValue({ path: '/home/u/app', created: false });
    browseMachine.mockResolvedValue({ entries: [] });
    const ctx = ctxWith({
      projectMachines: {
        link: vi.fn(async () => {
          throw new ProjectRuleError('MACHINE_ALREADY_LINKED', 'Esta máquina já está vinculada ao projeto');
        }),
      },
    });
    await expect(linkProjectMachine(ctx, { project_id: 'p1', machine_id: 'm1', cwd: '~/app' })).rejects.toMatchObject({ code: 'MACHINE_ALREADY_LINKED' });
  });
});

describe('setProjectMachineCwd', () => {
  it('resolves the new cwd and updates the link', async () => {
    ensureDirectory.mockResolvedValue({ path: '/home/u/app2', created: false });
    browseMachine.mockResolvedValue({ entries: [] });
    const ctx = ctxWith();
    const r = await setProjectMachineCwd(ctx, { project_id: 'p1', machine_id: 'm1', cwd: '~/app2' });
    expect(ensureDirectory).toHaveBeenCalledWith(machine, '~/app2', false);
    expect(ctx.repos.projectMachines.updateCwd).toHaveBeenCalledWith('p1', 'm1', '/home/u/app2');
    expect(r.cwd).toBe('/home/u/app2');
  });

  it('throws the same 404 scoped.projectMachine would when the link is gone by the time it writes (unlinked concurrently)', async () => {
    ensureDirectory.mockResolvedValue({ path: '/home/u/app2', created: false });
    browseMachine.mockResolvedValue({ entries: [] });
    const ctx = ctxWith({ projectMachines: { updateCwd: vi.fn(async () => undefined) } });
    await expect(setProjectMachineCwd(ctx, { project_id: 'p1', machine_id: 'm1', cwd: '~/app2' })).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Máquina não vinculada ao projeto',
    });
  });
});

describe('unlinkProjectMachine', () => {
  it('refuses without confirm when the project has open tabs on that machine', async () => {
    const ctx = ctxWith({ tabs: { listByProjectMachine: vi.fn(async () => [tab(), tab({ id: 't2', name: 'Terminal 2' })]) } });
    await expect(unlinkProjectMachine(ctx, { project_id: 'p1', machine_id: 'm1' })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(killTmuxSession).not.toHaveBeenCalled();
    expect(ctx.repos.tabs.delete).not.toHaveBeenCalled();
    expect(ctx.repos.projectMachines.unlink).not.toHaveBeenCalled();
  });

  it('kills sessions, deletes the tabs and unlinks when confirmed', async () => {
    killTmuxSession.mockResolvedValue(true);
    const ctx = ctxWith({ tabs: { listByProjectMachine: vi.fn(async () => [tab(), tab({ id: 't2', name: 'Terminal 2' })]) } });
    const r = await unlinkProjectMachine(ctx, { project_id: 'p1', machine_id: 'm1', confirm: true });
    expect(killTmuxSession).toHaveBeenCalledTimes(2);
    expect(ctx.repos.tabs.delete).toHaveBeenCalledTimes(2);
    expect(ctx.repos.projectMachines.unlink).toHaveBeenCalledWith('p1', 'm1');
    expect(publishTabsRemoved).toHaveBeenCalled();
    expect(publicBus.publishRobotsGone).toHaveBeenCalledWith({ machine_id: 'm1', project_id: 'p1' });
    expect(r).toEqual({ unlinked: true, project_id: 'p1', machine_id: 'm1', closed_tabs: 2 });
  });

  it('unlinks directly when there are no open tabs', async () => {
    const ctx = ctxWith();
    const r = await unlinkProjectMachine(ctx, { project_id: 'p1', machine_id: 'm1' });
    expect(r.closed_tabs).toBe(0);
    expect(ctx.repos.projectMachines.unlink).toHaveBeenCalledWith('p1', 'm1');
  });
});

describe('announceLinked', () => {
  it('publishes only when the project is public', () => {
    announceLinked(project());
    expect(publicBus.publish).not.toHaveBeenCalled();
    announceLinked(project({ is_public: true }));
    expect(publicBus.publish).toHaveBeenCalledWith({ project_id: 'p1', is_public: true });
  });
});

describe('removeProjectMachineLink', () => {
  it('kills the tabs sessions (best effort), removes them, unlinks and returns the count', async () => {
    killTmuxSession.mockRejectedValue(new Error('offline'));
    const repos = {
      tabs: { delete: vi.fn(async () => true) },
      projectMachines: { unlink: vi.fn(async () => true) },
    } as never;
    const tabs = [tab(), tab({ id: 't2' })];
    const n = await removeProjectMachineLink(repos, 'p1', machine, tabs as never);
    expect(n).toBe(2);
    expect((repos as { tabs: { delete: ReturnType<typeof vi.fn> } }).tabs.delete).toHaveBeenCalledTimes(2);
    expect((repos as { projectMachines: { unlink: ReturnType<typeof vi.fn> } }).projectMachines.unlink).toHaveBeenCalledWith('p1', 'm1');
    expect(publicBus.publishRobotsGone).toHaveBeenCalledWith({ machine_id: 'm1', project_id: 'p1' });
  });
});
