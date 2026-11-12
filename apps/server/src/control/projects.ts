import type { Repositories } from '../db/repositories/index.js';
import { ProjectRuleError } from '../db/repositories/projects.js';
import { MAX_ITEMS as GROUP_MAX_PROJECTS, type ProjectGroup } from '../db/repositories/project-groups.js';
import type { Machine, Project, ProjectMachine, ProjectStatus } from '../db/repositories/types.js';
import { config } from '../config.js';
import { isValidProjectKey, suggestProjectKey } from '../lib/project-key.js';
import { msg } from '../i18n/index.js';
import { ControlError, type ControlContext } from './context.js';
import { checkedDir, toLinkResult, type LinkResult } from './project-links.js';

export interface NewProject {
  name: string;
  key: string;
  description?: string | null;
  status?: ProjectStatus;
}

/**
 * The one way a project is born (TER-1163): the Projetos screen (`POST /api/projects`) and the MCP
 * `create_project` both call it, so the key rules (format, unique) and the first machine link are the
 * same wherever it is asked. The caller has already resolved the machine within its scope and checked
 * the folder on it; a rule broken here is thrown as the repository's `ProjectRuleError`, for each caller
 * to answer in its own shape (HTTP status, ControlError).
 */
export async function createProjectRecord(
  repos: Repositories,
  ownerId: string,
  input: NewProject,
  link?: { machine: Machine; cwd: string },
): Promise<{ project: Project; link: ProjectMachine | null }> {
  const project = await repos.projects.create({ owner_id: ownerId, key: input.key, name: input.name, description: input.description, status: input.status });
  const linked = link ? await repos.projectMachines.link({ project_id: project.id, machine_id: link.machine.id, cwd: link.cwd }) : null;
  return { project, link: linked };
}

/** The project's page in the web app. */
export function projectUrl(projectId: string): string {
  return `${config.publicUrl}/projects/${projectId}`;
}

/** Accent- and case-insensitive, as `find` matches names. */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/** One of the person's own custom groups, by id or by name. Favoritos is not a group to put a project in here. */
async function resolveGroup(ctx: ControlContext, ref: string): Promise<ProjectGroup> {
  const groups = (await ctx.repos.projectGroups.read(ctx.scope.user.id)).filter((g) => g.kind === 'custom');
  const found = groups.find((g) => g.id === ref) ?? groups.find((g) => fold(g.name) === fold(ref));
  if (!found) {
    throw new ControlError(
      'GROUP_NOT_FOUND',
      msg('Não encontrei o grupo {{group}} entre os seus grupos; veja os nomes com list_project_groups ou deixe group de fora', { group: ref }),
    );
  }
  if (found.project_ids.length >= GROUP_MAX_PROJECTS) {
    throw new ControlError('GROUP_LIMIT', msg('Limite de {{max}} projetos por grupo', { max: GROUP_MAX_PROJECTS }));
  }
  return found;
}

export interface CreateProjectInput {
  name: string;
  key?: string;
  description?: string;
  group?: string;
  machine_id?: string;
  cwd?: string;
  create_dir?: boolean;
}

export interface CreateProjectResult {
  project: { id: string; key: string; name: string; url: string; board_url: string };
  key_suggested: boolean;
  group: { id: string; name: string } | null;
  machine: LinkResult | null;
}

/**
 * `create_project` (TER-1163): what the Projetos screen does, through `createProjectRecord`, plus the two
 * things the screen does in separate steps — putting the project in one of the person's groups and linking
 * the first machine. Everything that can fail on its own (the group, the machine, the folder) is checked
 * before the project exists, so a refusal never leaves half a project behind. `key` omitted is the name's
 * suggestion (the same `suggestProjectKey` the screen pre-fills), which the confirmation card shows.
 */
export async function createProject(ctx: ControlContext, input: CreateProjectInput): Promise<CreateProjectResult> {
  if ((input.machine_id === undefined) !== (input.cwd === undefined)) {
    throw new ControlError('MACHINE_AND_CWD', msg('machine_id e cwd vêm juntos: passe os dois para já ligar uma máquina, ou nenhum'));
  }
  const key = input.key ?? suggestProjectKey(input.name);
  if (!isValidProjectKey(key)) throw new ControlError('KEY_INVALID', msg('Chave inválida: 2 a 10 letras maiúsculas ou dígitos, começando com letra'));
  const group = input.group !== undefined ? await resolveGroup(ctx, input.group) : null;
  let link: { machine: Machine; cwd: string; created: boolean } | undefined;
  if (input.machine_id !== undefined && input.cwd !== undefined) {
    const machine = await ctx.scoped.machine(input.machine_id);
    const dir = await checkedDir(machine, input.cwd, input.create_dir);
    link = { machine, cwd: dir.path, created: dir.created };
  }

  let created: Awaited<ReturnType<typeof createProjectRecord>>;
  try {
    created = await createProjectRecord(ctx.repos, ctx.scope.createAs, { name: input.name, key, description: input.description }, link);
  } catch (e) {
    if (e instanceof ProjectRuleError) {
      if (e.code === 'KEY_TAKEN' && input.key === undefined) {
        throw new ControlError('KEY_TAKEN', msg('A chave sugerida {{key}} já está em uso; repita com outra chave em key', { key }));
      }
      throw new ControlError(e.code, e.localized);
    }
    throw e;
  }
  const { project } = created;

  if (group) {
    // Appended at the end of the group, the other members kept in their order (hidden ones included).
    const visible = new Set((await ctx.repos.projects.list({ owner: ctx.scope.ownerId })).map((p) => p.id));
    await ctx.repos.projectGroups.setMemberships(ctx.scope.user.id, [{ id: group.id, project_ids: [...group.project_ids.filter((id) => visible.has(id)), project.id] }], (id) => visible.has(id));
  }

  return {
    project: { id: project.id, key: project.key, name: project.name, url: projectUrl(project.id), board_url: `${projectUrl(project.id)}/tasks` },
    key_suggested: input.key === undefined,
    group: group ? { id: group.id, name: group.name } : null,
    machine: link ? await toLinkResult(project, link.machine, link.cwd, link.created) : null,
  };
}
