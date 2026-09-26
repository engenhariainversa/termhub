import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { ProjectRuleError } from '../db/repositories/projects.js';
import type { Machine, Project, ProjectMachine, Tab } from '../db/repositories/types.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { PROJECT_KEY_RE } from '../lib/project-key.js';
import { nextTerminalName } from '../lib/tab-names.js';
import { scoped } from '../auth/scope.js';
import { requireSimCapable } from '../agent/errors.js';
import { killTmuxSession, listTmuxSessions } from '../terminal/machine-exec.js';
import type { SimulatorSessionManager } from '../simulator/session-manager.js';
import { publicBus } from '../public/bus.js';
import { publishTabOpened, publishTabsRemoved } from '../monitor/tab-events.js';
import { announceLinked, PROJECT_CWD, removeProjectMachineLink, resolveLinkCwd } from '../control/project-links.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const linkParams = z.object({ id: z.string().min(1).max(64), machineId: z.string().min(1).max(64) });

const keySchema = z.string().trim().regex(PROJECT_KEY_RE, 'Chave inválida: 2 a 10 letras maiúsculas ou dígitos, começando com letra');
const statusSchema = z.enum(['active', 'paused', 'archived']);

const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    key: keySchema,
    status: statusSchema.optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    /** optional first machine link (both or neither) */
    machine_id: z.string().min(1).max(64).optional(),
    cwd: PROJECT_CWD.optional(),
    /** creates the folder on the machine (mkdir -p) when it does not exist */
    create_dir: z.boolean().optional(),
  })
  .strict()
  .refine((b) => (b.machine_id === undefined) === (b.cwd === undefined), { message: 'machine_id e cwd vêm juntos' });

/** `key` and `cwd` are not patchable: the key never changes, the cwd lives on the machine link. */
const patchBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    status: statusSchema.optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    /** published: readable by anyone with the /city/@nickname link (owner only, see PATCH) */
    is_public: z.boolean().optional(),
  })
  .strict();

const linkBody = z.object({ machine_id: z.string().min(1).max(64), cwd: PROJECT_CWD, create_dir: z.boolean().optional() }).strict();
const linkPatchBody = z.object({ cwd: PROJECT_CWD, create_dir: z.boolean().optional() }).strict();

const tabBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  kind: z.enum(['terminal', 'simulator']).optional(),
  simulator_udid: z.string().regex(/^[A-Fa-f0-9-]{8,64}$/).optional(),
  /** required when the project is linked to more than one machine */
  machine_id: z.string().min(1).max(64).optional(),
});

/** Repository rule errors become 409 (conflicts) or 400 with their pt-BR message, keeping the rule's own code. */
async function rule<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ProjectRuleError) throw new HttpError(e.code === 'KEY_TAKEN' || e.code === 'MACHINE_ALREADY_LINKED' ? 409 : 400, e.message, e.code);
    throw e;
  }
}

const linkView = (l: ProjectMachine) => ({ machine_id: l.machine_id, cwd: l.cwd, position: l.position });

export async function projectRoutes(app: FastifyInstance, repos: Repositories, deps: { simulators: SimulatorSessionManager }) {
  /** Projects with their links attached, one query for the links. */
  async function withLinks(projects: Project[]): Promise<Array<Project & { machines: ReturnType<typeof linkView>[] }>> {
    const links = await repos.projectMachines.listByProjects(projects.map((p) => p.id));
    return projects.map((p) => ({ ...p, machines: links.filter((l) => l.project_id === p.id).map(linkView) }));
  }

  app.get('/', async (request) => {
    const q = z.object({ status: statusSchema.optional(), machine_id: z.string().min(1).max(64).optional() }).parse(request.query);
    const [projects, openCounts] = await Promise.all([
      repos.projects.list({ status: q.status, machine_id: q.machine_id, owner: request.scope.ownerId }),
      repos.tasks.openCountByProject(),
    ]);
    return { projects: (await withLinks(projects)).map((p) => ({ ...p, open_tasks: openCounts[p.id] ?? 0 })) };
  });

  app.get('/key-available', async (request) => {
    const { key } = z.object({ key: z.string().trim().min(1).max(20) }).parse(request.query);
    if (!PROJECT_KEY_RE.test(key)) return { available: false, reason: 'invalid' as const };
    return (await repos.projects.isKeyAvailable(key)) ? { available: true } : { available: false, reason: 'taken' as const };
  });

  app.post('/', async (request, reply) => {
    const { create_dir, machine_id, cwd, ...body } = createBody.parse(request.body);
    let machine: Machine | undefined;
    let resolvedCwd: string | undefined;
    if (machine_id && cwd) {
      machine = await scoped(repos, request).machine(machine_id).catch(() => {
        throw badRequest('Máquina inexistente');
      });
      resolvedCwd = (await resolveLinkCwd(machine, cwd, create_dir)).path;
    }
    const project = await rule(() => repos.projects.create({ owner_id: request.scope.createAs, key: body.key, name: body.name, description: body.description, status: body.status }));
    const machines =
      machine && resolvedCwd ? [linkView(await rule(() => repos.projectMachines.link({ project_id: project.id, machine_id: machine!.id, cwd: resolvedCwd! })))] : [];
    return reply.code(201).send({ project: { ...project, machines } });
  });

  app.get('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { project } = await scoped(repos, request).project(id);
    return { project: (await withLinks([project]))[0] };
  });

  app.patch('/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { project: current } = await scoped(repos, request).project(id);
    const patch = patchBody.parse(request.body);
    if (patch.is_public === true && !current.is_public) {
      // Publishing belongs to the project's owner: an admin acting as someone else, or on an
      // orphan project, cannot put another person's work on the street.
      if (!current.owner_id) return reply.code(409).send({ error: 'Esse projeto não tem dono', code: 'PROJECT_UNOWNED' });
      if (current.owner_id !== request.user!.id) return reply.code(403).send({ error: 'Só quem é dono do projeto pode publicar', code: 'NOT_OWNER' });
      if (!request.user!.nickname) return reply.code(409).send({ error: 'Escolha seu apelido antes de publicar', code: 'NICKNAME_REQUIRED' });
    }
    const project = await repos.projects.update(id, patch);
    // The public bus fans this out to any `/ws/public/:nickname` socket watching this project's
    // building: a publish opens them up, an unpublish drops the connection at once (see public/ws.ts).
    // Archiving takes the building out of the snapshot's filter too (`status !== 'archived'`), so it
    // counts as "no longer publicly visible" here as well — the two surfaces must not disagree.
    if (patch.is_public !== undefined && patch.is_public !== current.is_public) {
      publicBus.publish({ project_id: id, is_public: patch.is_public });
    }
    if (patch.status === 'archived' && current.status !== 'archived') {
      publicBus.publish({ project_id: id, is_public: false });
    }
    // Unarchiving brings a published project's building back into the snapshot's filter: the memoised
    // cities must be dropped at once, as they are for a publish.
    if (patch.status !== undefined && patch.status !== 'archived' && current.status === 'archived') {
      publicBus.publish({ project_id: id, is_public: patch.is_public ?? current.is_public });
    }
    return { project: project ? (await withLinks([project]))[0] : undefined };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { machines } = await scoped(repos, request).projectMachines(id);
    // Best effort: kill the tmux sessions on every linked machine before deleting (a machine may be offline).
    // Only the scope's own machines: a tab on a link outside the scope (cross-owner link) is neither
    // touched nor asked to close a session it has no business reaching.
    const machineIds = new Set(machines.map(({ machine }) => machine.id));
    // every tab goes with the project (the database cascades them), so every one is announced gone
    const allTabs = await repos.tabs.listByProject(id);
    const tabs = allTabs.filter((t) => machineIds.has(t.machine_id));
    await Promise.allSettled(
      tabs
        .filter((t) => t.tmux_session)
        .map((t) => {
          const m = machines.find((x) => x.machine.id === t.machine_id)?.machine;
          return m ? killTmuxSession(m, t.tmux_session!) : Promise.resolve(false);
        }),
    );
    await repos.projects.delete(id);
    await publishTabsRemoved(repos, allTabs, machines.map(({ machine }) => machine));
    // A deleted project can never be publicly visible again either — tell the public bus regardless
    // of whether this project was ever published; a socket that never had it just no-ops.
    publicBus.publish({ project_id: id, is_public: false });
    return { ok: true };
  });

  // --- Machine links ---
  app.get('/:id/machines', async (request) => {
    const { id } = idParam.parse(request.params);
    const { machines } = await scoped(repos, request).projectMachines(id);
    return { machines: machines.map(({ machine, link }) => ({ ...linkView(link), machine: { id: machine.id, name: machine.name, type: machine.type } })) };
  });

  app.post('/:id/machines', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { project } = await scoped(repos, request).project(id);
    const { machine_id, cwd, create_dir } = linkBody.parse(request.body);
    const machine = await scoped(repos, request).machine(machine_id).catch(() => {
      throw badRequest('Máquina inexistente');
    });
    const resolved = (await resolveLinkCwd(machine, cwd, create_dir)).path;
    const link = await rule(() => repos.projectMachines.link({ project_id: id, machine_id: machine.id, cwd: resolved }));
    // a published project on a new machine may bring its robots there onto the street: the next public read must see them
    announceLinked(project);
    return reply.code(201).send({ link: linkView(link) });
  });

  app.patch('/:id/machines/:machineId', async (request) => {
    const { id, machineId } = linkParams.parse(request.params);
    const { machine } = await scoped(repos, request).projectMachine(id, machineId);
    const { cwd, create_dir } = linkPatchBody.parse(request.body);
    const link = await repos.projectMachines.updateCwd(id, machineId, (await resolveLinkCwd(machine, cwd, create_dir)).path);
    return { link: link ? linkView(link) : undefined };
  });

  /** Closes the project's tabs on that machine (best-effort tmux kill), then removes the link. */
  app.delete('/:id/machines/:machineId', async (request) => {
    const { id, machineId } = linkParams.parse(request.params);
    const { machine } = await scoped(repos, request).projectMachine(id, machineId);
    const tabs = await repos.tabs.listByProjectMachine(id, machineId);
    const closed_tabs = await removeProjectMachineLink(repos, id, machine, tabs);
    return { ok: true, closed_tabs };
  });

  // --- Tabs ---
  app.get('/:id/tabs', async (request) => {
    const { id } = idParam.parse(request.params);
    const { machines } = await scoped(repos, request).projectMachines(id);
    // Only the scope's own machines: a tab on a link outside the scope (cross-owner link) is neither
    // listed nor probed.
    const machineIds = new Set(machines.map(({ machine }) => machine.id));
    const tabs = (await repos.tabs.listByProject(id)).filter((t) => machineIds.has(t.machine_id));
    // one probe per machine that has terminal tabs; a silent machine marks only its own tabs dead
    const alive = new Map<string, Set<string>>();
    let reachable = true;
    await Promise.all(
      machines
        .filter(({ machine }) => tabs.some((t) => t.kind === 'terminal' && t.machine_id === machine.id))
        .map(async ({ machine }) => {
          try {
            alive.set(machine.id, await listTmuxSessions(machine));
          } catch {
            reachable = false;
          }
        }),
    );
    const isAlive = (t: Tab) =>
      t.kind === 'simulator' ? !!t.simulator_udid && deps.simulators.isReady(t.machine_id, t.simulator_udid) : !!t.tmux_session && (alive.get(t.machine_id)?.has(t.tmux_session) ?? false);
    return { reachable, tabs: tabs.map((t) => ({ ...t, alive: isAlive(t) })) };
  });

  app.post('/:id/tabs', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = tabBody.parse(request.body ?? {});
    const { machine } = await scoped(repos, request).projectMachineFor(id, body.machine_id);
    const kind = body.kind ?? 'terminal';
    if (kind === 'simulator') requireSimCapable(machine);
    const existing = await repos.tabs.listByProject(id);
    const count = existing.filter((t) => t.kind === kind).length + 1;
    const name = body.name ?? (kind === 'simulator' ? `Simulador ${count}` : nextTerminalName(existing.map((t) => t.name)));
    if (kind === 'simulator' && !machine.capabilities.includes('wda')) throw badRequest('Prepare o WDA nesta máquina antes de abrir um simulador');
    const tab = await repos.tabs.create(id, machine.id, name, { kind, simulator_udid: body.simulator_udid ?? null });
    publishTabOpened(tab, machine);
    return reply.code(201).send({ tab: { ...tab, alive: false } });
  });
}
