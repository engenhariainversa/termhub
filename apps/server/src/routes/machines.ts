import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CLOSE } from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import { HttpError, badRequest, conflict, forbidden } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { isAdmin } from '../auth/permissions.js';
import { machineStatus } from '../terminal/machine-exec.js';
import { listSimulators } from '../simulator/machine.js';
import { startWdaSetup, wdaSetupState } from '../simulator/setup.js';
import { browseMachine, makeDirectory } from '../terminal/machine-fs.js';
import { collectHardware } from '../system/hardware.js';
import { newAgentToken } from '../agent/token.js';
import { agents } from '../agent/registry.js';
import { isOutdated, latestAgentVersion, MIN_SELF_UPDATE_VERSION, runAgentUpdate } from '../agent/latest-version.js';
import { agentRpc, requireAgentVersion, requireSimCapable } from '../agent/errors.js';
import { config } from '../config.js';
import { installHooks, uninstallHooks } from '../monitor/install.js';
import { newHookToken } from '../monitor/token.js';
import type { Machine } from '../db/repositories/types.js';
import { publicBus } from '../public/bus.js';
import { publishTabOpened, publishTabRemoved, publishTabsRemoved } from '../monitor/tab-events.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const fsQuery = z.object({ path: z.string().max(4096).optional() });
const mkdirBody = z.object({ parent: z.string().min(1).max(4096), name: z.string().trim().min(1).max(255) });

/** Optional line under the name: trimmed, at most 80 chars, and an empty one is no subtitle at all. */
const subtitleField = z
  .string()
  .trim()
  .max(80)
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));

/**
 * Shape of a stored machine, used to validate PATCHes. `local` and `ssh` are legacy transports:
 * existing rows keep working and can be edited, but new machines are agent-only (see POST).
 * "local" in particular means the termhub server's own host, never the user's computer.
 */
const machineBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    subtitle: subtitleField,
    type: z.enum(['local', 'ssh', 'agent']),
    host: z.string().trim().min(1).max(253).optional().nullable(),
    ssh_user: z.string().trim().min(1).max(64).optional().nullable(),
    ssh_port: z.coerce.number().int().min(1).max(65535).optional(),
    is_local: z.boolean().optional(),
    agent_auto_update: z.boolean().optional(),
    claude_auto_swap: z.boolean().optional(),
  })
  .superRefine((m, ctx) => {
    if (m.type === 'ssh' && !m.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'host é obrigatório para SSH' });
    if (m.type === 'agent' && m.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'máquina com agente não tem host' });
    if (m.agent_auto_update && m.type !== 'agent') {
      ctx.addIssue({ code: 'custom', path: ['agent_auto_update'], message: 'só máquinas com agente atualizam sozinhas' });
    }
  });

/** Config dirs of the Claude accounts registered on the machine (CLAUDE_CONFIG_DIR): the hooks go there too. */
async function claudeAccountDirs(repos: Repositories, machineId: string): Promise<string[]> {
  return (await repos.aiAccounts.list())
    .filter((a) => a.machine_id === machineId && a.provider === 'claude' && a.config_dir)
    .map((a) => a.config_dir as string);
}

const ownerPatch = z.object({ owner_id: z.string().min(1).max(64).nullable().optional() });

const createBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    subtitle: subtitleField,
    type: z.enum(['local', 'ssh', 'agent']),
    /** the user's own computer; see Machine.is_local */
    is_local: z.boolean().optional(),
  })
  .strict(); // no host/ssh_* on an agent machine

/** Newer agent on npm than the one connected? Offline agents never count: there is nothing to update. */
function updateAvailable(m: Machine): boolean {
  if (m.type !== 'agent') return false;
  const info = agents.info(m.id);
  return !!info && isOutdated(info.agent_version, latestAgentVersion());
}

export async function machineRoutes(app: FastifyInstance, repos: Repositories) {
  /**
   * Machines in the caller's scope (own, or the "view as" target / all for admins), each with the
   * health the monitor depends on: are the hooks installed, and how many of its tabs ever reported
   * a state. Without that, a machine whose hooks were never installed looks exactly like an idle one.
   */
  app.get('/', async (request) => {
    const machines = await repos.machines.list(request.scope.ownerId);
    const [hooks, counts] = await Promise.all([
      repos.machineHooks.installedAtByMachine(machines.map((m) => m.id)),
      repos.tabs.countsByMachine(request.scope.ownerId),
    ]);
    return {
      machines: machines.map((m) => ({
        ...m,
        update_available: updateAvailable(m),
        hooks_installed_at: hooks[m.id] ?? null,
        tabs: counts[m.id]?.tabs ?? 0,
        tabs_reporting: counts[m.id]?.reporting ?? 0,
      })),
      latest_agent_version: latestAgentVersion(),
    };
  });

  /** New machines are agent-only: mints the enrollment token, shown to the caller this once. */
  app.post('/', async (request, reply) => {
    const body = createBody.parse(request.body);
    if (body.type !== 'agent') throw badRequest('Novas máquinas usam o agente; SSH e local não podem mais ser adicionados');
    const { token, hash } = newAgentToken();
    const machine = await repos.machines.create({ ...body, subtitle: body.subtitle ?? null, host: null, ssh_user: null, owner_id: request.scope.createAs });
    await repos.machines.rotateAgentToken(machine.id, hash);
    return reply.code(201).send({ machine, agent_token: token });
  });

  /** Rotates an agent machine's enrollment token and kicks the current connection (if any). */
  app.post('/:id/agent-token', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    if (machine.type !== 'agent') throw badRequest('Máquina não usa agente');
    const { token, hash } = newAgentToken();
    await repos.machines.rotateAgentToken(id, hash);
    agents.disconnect(id, CLOSE.UNAUTHORIZED, 'rotated');
    return { agent_token: token };
  });

  app.get('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    return { machine: await scoped(repos, request).machine(id) };
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const current = await scoped(repos, request).machine(id);
    const patchType = (request.body as { type?: string } | undefined)?.type;
    if (patchType !== undefined && patchType !== current.type && (patchType === 'agent' || current.type === 'agent')) {
      throw badRequest('tipo de transporte não pode ser alterado');
    }
    const merged = machineBody.parse({ ...current, ...(request.body as object) });
    // owner transfer is an admin-only field (any admin scope, including "all")
    const { owner_id } = ownerPatch.parse(request.body ?? {});
    if (owner_id !== undefined) {
      if (!(await isAdmin(repos, request.user))) throw forbidden('Só administradores transferem máquinas');
      if (owner_id && !(await repos.users.findById(owner_id))) throw badRequest('Usuário inexistente');
    }
    const machine = await repos.machines.update(id, { ...merged, ...(owner_id !== undefined ? { owner_id } : {}) });
    // A city only ever shows the robots on machines its person owns (public/read.ts), so a
    // transferred machine's robots leave the old owner's city by that rule alone — the projects stay
    // published (they belong to their owners, not to the machine). Any public page showing them
    // hangs up and re-reads.
    if (owner_id !== undefined && owner_id !== current.owner_id) {
      publicBus.publishRobotsGone({ machine_id: id });
      request.log.info({ machineId: id }, 'machine transferred: its robots left its old owner\'s public city');
      // its tabs leave the old owner's open tabs (sidebar) and join the new owner's
      for (const tab of await repos.tabs.listByMachine(id)) {
        publishTabRemoved(tab, current);
        publishTabOpened(tab, machine ?? { id, owner_id: owner_id ?? null });
      }
    }
    return { machine };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    // The DB cascade removes this machine's project links and its own tabs; the projects survive.
    const tabs = await repos.tabs.listByMachine(id);
    await repos.machines.delete(id);
    await publishTabsRemoved(repos, tabs, [machine]);
    // its robots leave every public city at once (the projects, and their publish switch, stay)
    publicBus.publishRobotsGone({ machine_id: id });
    agents.disconnect(id, CLOSE.UNAUTHORIZED, 'deleted');
    return { ok: true };
  });

  app.get('/:id/status', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    const status = await machineStatus(machine);
    const checked_at = new Date().toISOString();
    if (machine.type === 'agent') {
      const info = agents.info(id);
      return {
        id,
        ...status,
        agent_version: info?.agent_version ?? machine.agent_version,
        last_seen_at: machine.agent_last_seen_at,
        checked_at,
        latest_agent_version: latestAgentVersion(),
        update_available: updateAvailable(machine),
      };
    }
    if (status.online) await repos.machines.setDetected(id, status.os, status.capabilities);
    return { id, ...status, checked_at };
  });

  const requireMac = (m: { os: string | null; capabilities: string[] }) => {
    if (m.os !== 'macos' || !m.capabilities.includes('xcodebuild')) throw badRequest('Esta máquina não é um Mac com Xcode');
  };

  app.get('/:id/simulators', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    requireSimCapable(machine);
    requireMac(machine);
    return { simulators: await listSimulators(machine) };
  });

  app.get('/:id/simulator/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    requireSimCapable(machine);
    const state = await wdaSetupState(machine);
    if (state.state === 'ok' && !machine.capabilities.includes('wda')) {
      if (machine.type === 'agent') {
        // The agent reported its tools at hello time, before WDA existed: ask again and store the answer.
        const det = await agentRpc(machine, 'tools.detect', {});
        await repos.machines.setDetected(id, det.os, det.tools);
      } else {
        const status = await machineStatus(machine);
        if (status.online) await repos.machines.setDetected(id, status.os, status.capabilities);
      }
    }
    return state;
  });

  app.post('/:id/simulator/setup', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    requireSimCapable(machine);
    requireMac(machine);
    await startWdaSetup(machine);
    return reply.code(202).send({ ok: true });
  });

  /** Monitor hooks on the machine: installed or not, and where they post. */
  app.get('/:id/hooks', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    const hook = await repos.machineHooks.findByMachine(machine.id);
    return { installed_at: hook?.installed_at ?? null, hooks_url: config.hooksUrl };
  });

  /**
   * Installs (or reinstalls with a fresh token) the monitor hooks on the machine: the script under
   * ~/.termhub/bin, the entries in ~/.claude/settings.json (and in the config dir of each Claude
   * account of the machine that exists there) and, when Codex is there, config.toml.
   * Only the token's hash is kept here; the plain token lives in ~/.termhub/hook.env on the machine.
   */
  app.post('/:id/hooks', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    const { token, hash } = newHookToken();
    let report;
    try {
      report = await installHooks(machine, token, config.hooksUrl, await claudeAccountDirs(repos, machine.id));
    } catch (err) {
      // Agent failures (offline, outdated, what the machine reported) already carry their own status.
      if (err instanceof HttpError) throw err;
      throw conflict(err instanceof Error ? err.message : 'Instalação falhou');
    }
    const hook = await repos.machineHooks.upsert(machine.id, hash);
    request.log.info({ machineId: machine.id, claude: report.claude, claudeDirs: report.claude_dirs.length, codex: report.codex, cursor: report.cursor }, 'monitor: hooks installed');
    return { installed_at: hook.installed_at, hooks_url: report.hooks_url, claude: report.claude, codex: report.codex, cursor: report.cursor, claude_dirs: report.claude_dirs };
  });

  /** Removes the hooks from the machine and revokes its token. */
  app.delete('/:id/hooks', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    try {
      await uninstallHooks(machine, await claudeAccountDirs(repos, machine.id));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw conflict(err instanceof Error ? err.message : 'Remoção falhou');
    }
    await repos.machineHooks.delete(machine.id);
    request.log.info({ machineId: machine.id }, 'monitor: hooks removed');
    return { ok: true };
  });

  /** Installs the latest @termhub/agent on the machine through the agent itself; the agent restarts when it runs as a service. */
  app.post('/:id/agent/update', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    if (machine.type !== 'agent') throw badRequest('Só máquinas com agente são atualizadas por aqui');
    const latest = latestAgentVersion();
    if (!latest) throw new HttpError(503, 'Versão mais nova do agente ainda desconhecida (npm)', 'AGENT_LATEST_UNKNOWN');
    const info = agents.info(machine.id);
    if (!info) throw new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
    if (!isOutdated(info.agent_version, latest)) throw conflict(`O agente já está na versão ${info.agent_version}`);
    requireAgentVersion(machine, MIN_SELF_UPDATE_VERSION);
    return runAgentUpdate(machine.id, latest, request.log);
  });

  /** Navegador de diretórios: subpastas de ?path (padrão $HOME) + discos/mounts da máquina. */
  app.get('/:id/fs', async (request) => {
    const { id } = idParam.parse(request.params);
    const { path } = fsQuery.parse(request.query);
    const machine = await scoped(repos, request).machine(id);
    return await browseMachine(machine, path);
  });

  /** Cria uma subpasta em `parent` na máquina e devolve o caminho absoluto. */
  app.post('/:id/fs/mkdir', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { parent, name } = mkdirBody.parse(request.body);
    const machine = await scoped(repos, request).machine(id);
    const path = await makeDirectory(machine, parent, name);
    return reply.code(201).send({ path });
  });

  /**
   * Hardware snapshot (CPU, memory, disks, temps, GPU, top processes) for the Home "Hardware" tab.
   * Guarded as hardware:read (route config below).
   */
  app.get('/:id/hardware', { config: { resource: 'hardware', action: 'read' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    return { hardware: await collectHardware(machine) };
  });
}
