import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { ProjectRuleError } from '../db/repositories/projects.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { browseMachine, ensureDirectory } from '../terminal/machine-fs.js';
import { killTmuxSession } from '../terminal/machine-exec.js';
import { publicBus } from '../public/bus.js';
import { publishTabsRemoved } from '../monitor/tab-events.js';
import { ControlError, type ControlContext } from './context.js';

/** Windows paths (C:\...) do not go through sh: they are stored/inspected unchecked. */
const isPosixPath = (p: string) => p.startsWith('/') || p.startsWith('~');

export const PROJECT_CWD = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((p) => p.startsWith('/') || /^[A-Za-z]:\\/.test(p) || p.startsWith('~'), { message: 'cwd deve ser um caminho absoluto' });

/** Checks the folder on the machine (creates it when asked) and returns the resolved absolute path. */
export async function resolveLinkCwd(machine: Machine, cwd: string, createDir: boolean | undefined): Promise<{ path: string; created: boolean }> {
  if (!isPosixPath(cwd)) return { path: cwd, created: false };
  return ensureDirectory(machine, cwd, createDir ?? false);
}

/** `resolveLinkCwd`, but a missing directory answers with a message that says what to do next. */
async function checkedDir(machine: Machine, cwd: string, createDir: boolean | undefined): Promise<{ path: string; created: boolean }> {
  try {
    return await resolveLinkCwd(machine, cwd, createDir);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'DIR_NOT_FOUND') {
      throw new ControlError(
        'DIR_NOT_FOUND',
        `A pasta ${cwd} não existe na máquina ${machine.name}. Repita com create_dir: true para criá-la vazia; para ter o repositório, depois de vincular abra uma aba nesse projeto e máquina e rode git clone <url> . dentro dela.`,
      );
    }
    throw e;
  }
}

/** Best effort: whether the (already resolved) folder holds a `.git` directory. Windows paths and any failure answer `null`. */
async function gitRepo(machine: Machine, path: string): Promise<boolean | null> {
  if (!isPosixPath(path)) return null;
  try {
    const { entries } = await browseMachine(machine, path);
    return entries.some((e) => e.name === '.git');
  } catch {
    return null;
  }
}

export interface LinkResult {
  project_id: string;
  machine_id: string;
  machine_name: string;
  cwd: string;
  created_dir: boolean;
  git_repo: boolean | null;
  note?: string;
}

async function toLinkResult(project: Project, machine: Machine, path: string, created: boolean): Promise<LinkResult> {
  const git_repo = await gitRepo(machine, path);
  return {
    project_id: project.id,
    machine_id: machine.id,
    machine_name: machine.name,
    cwd: path,
    created_dir: created,
    git_repo,
    ...(git_repo === false ? { note: 'A pasta não é um repositório git (não tem .git).' } : {}),
  };
}

/** Tells the public bus a published project may have new robots to show, on link. */
export function announceLinked(project: Project): void {
  if (project.is_public) publicBus.publish({ project_id: project.id, is_public: true });
}

/** Closes the project's tabs on that machine (best-effort tmux kill), then removes the link. Returns how many tabs were closed. */
export async function removeProjectMachineLink(repos: Repositories, projectId: string, machine: Machine, tabs: Tab[]): Promise<number> {
  await Promise.allSettled(tabs.filter((t) => t.tmux_session).map((t) => killTmuxSession(machine, t.tmux_session!)));
  for (const t of tabs) await repos.tabs.delete(t.id);
  await publishTabsRemoved(repos, tabs, [machine]);
  await repos.projectMachines.unlink(projectId, machine.id);
  // that project's robots on this machine leave the street at once (the building stays)
  publicBus.publishRobotsGone({ machine_id: machine.id, project_id: projectId });
  return tabs.length;
}

/** Links a project to a machine with a working directory, checking/creating the folder on it first. */
export async function linkProjectMachine(ctx: ControlContext, input: { project_id: string; machine_id: string; cwd: string; create_dir?: boolean }): Promise<LinkResult> {
  const { project } = await ctx.scoped.project(input.project_id);
  const machine = await ctx.scoped.machine(input.machine_id);
  if (await ctx.repos.projectMachines.find(project.id, machine.id)) {
    throw new ControlError('MACHINE_ALREADY_LINKED', `O projeto ${project.name} já está vinculado à máquina ${machine.name}; para trocar a pasta use set_project_machine_cwd`);
  }
  const dir = await checkedDir(machine, input.cwd, input.create_dir);
  try {
    await ctx.repos.projectMachines.link({ project_id: project.id, machine_id: machine.id, cwd: dir.path });
  } catch (e) {
    if (e instanceof ProjectRuleError) throw new ControlError(e.code, e.message);
    throw e;
  }
  announceLinked(project);
  return toLinkResult(project, machine, dir.path, dir.created);
}

/** Changes an existing link's working directory, checking/creating the folder the same way link does. */
export async function setProjectMachineCwd(ctx: ControlContext, input: { project_id: string; machine_id: string; cwd: string; create_dir?: boolean }): Promise<LinkResult> {
  const { project, machine } = await ctx.scoped.projectMachine(input.project_id, input.machine_id);
  const dir = await checkedDir(machine, input.cwd, input.create_dir);
  await ctx.repos.projectMachines.updateCwd(project.id, machine.id, dir.path);
  return toLinkResult(project, machine, dir.path, dir.created);
}

/** Unlinks a machine from a project. Refuses when it would close open tabs unless `confirm: true`. */
export async function unlinkProjectMachine(ctx: ControlContext, input: { project_id: string; machine_id: string; confirm?: boolean }): Promise<{ unlinked: true; project_id: string; machine_id: string; closed_tabs: number }> {
  const { project, machine } = await ctx.scoped.projectMachine(input.project_id, input.machine_id);
  const tabs = await ctx.repos.tabs.listByProjectMachine(project.id, machine.id);
  if (tabs.length > 0 && input.confirm !== true) {
    throw new ControlError(
      'CONFIRM_REQUIRED',
      `Desvincular a máquina ${machine.name} do projeto ${project.name} fecha ${tabs.length} aba(s) abertas nela (${tabs.map((t) => t.name).join(', ')}); repita com confirm: true para confirmar`,
    );
  }
  const closed_tabs = await removeProjectMachineLink(ctx.repos, project.id, machine, tabs);
  return { unlinked: true, project_id: project.id, machine_id: machine.id, closed_tabs };
}
