import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AI_MEMORY_DEFAULT_URL, CLOSE, normalizeAiMemoryUrl, PAIRING_TTL_MS } from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import { HttpError, badRequest, conflict, forbidden, localizedOf } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { isAdmin } from '../auth/permissions.js';
import { killTmuxSession, machineStatus } from '../terminal/machine-exec.js';
import { listSimulators } from '../simulator/machine.js';
import { startWdaSetup, wdaSetupState } from '../simulator/setup.js';
import { browseMachine, makeDirectory } from '../terminal/machine-fs.js';
import { collectHardware } from '../system/hardware.js';
import { newAgentToken } from '../agent/token.js';
import { agents } from '../agent/registry.js';
import { AGENT_UNINSTALL_MIN_VERSION, isOutdated, latestAgentRelease, latestAgentVersion, MIN_SELF_UPDATE_VERSION, runAgentUpdate } from '../agent/latest-version.js';
import { AgentClosedError } from '../agent/connection.js';
import { agentRpc, requireAgentVersion, requireNetCheckCapable, requireSimCapable, toHttpError } from '../agent/errors.js';
import { config } from '../config.js';
import { uninstallHooks } from '../monitor/install.js';
import { claudeAccountDirs, installMachineHooksOn } from '../monitor/machine-hooks.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import { publicBus } from '../public/bus.js';
import { publishTabOpened, publishTabRemoved, publishTabsRemoved } from '../monitor/tab-events.js';
import { msg, tk } from '../i18n/index.js';
import { recordMachineSwitch } from '../automation/setup-tools.js';
import { audit } from '../auth/audit.js';
import { aiMemoryState } from '../memory/ai-memory.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
/** `?uninstall=1`: also remove the agent from the machine before deleting it (spec 2026-10-07 §3). */
const deleteQuery = z.object({ uninstall: z.enum(['1', 'true', '0', 'false']).optional() });
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
    ai_usage_query: z.boolean().optional(),
    automation_allowed: z.boolean().optional(),
    ai_memory_enabled: z.boolean().optional(),
    ai_memory_url: z.string().trim().max(200).nullable().optional(),
  })
  .superRefine((m, ctx) => {
    if (m.type === 'ssh' && !m.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'host é obrigatório para SSH' });
    if (m.type === 'agent' && m.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'máquina com agente não tem host' });
    if (m.agent_auto_update && m.type !== 'agent') {
      ctx.addIssue({ code: 'custom', path: ['agent_auto_update'], message: 'só máquinas com agente atualizam sozinhas' });
    }
  });

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

  /**
   * New machines are agent-only: mints the pairing token, shown to the caller this once. It is single use
   * and expires after `PAIRING_TTL_MS`; `connect` trades it for a device key (TER-1017).
   */
  app.post('/', async (request, reply) => {
    const body = createBody.parse(request.body);
    if (body.type !== 'agent') throw badRequest('Novas máquinas usam o agente; SSH e local não podem mais ser adicionados');
    const { token, hash } = newAgentToken();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    const machine = await repos.machines.create({ ...body, subtitle: body.subtitle ?? null, host: null, ssh_user: null, owner_id: request.scope.createAs });
    await repos.machines.startAgentPairing(machine.id, hash, expiresAt);
    await audit(repos, request, 'machine.create', { target: { type: 'machine', id: machine.id, label: machine.name }, meta: { owner_id: machine.owner_id } });
    return reply.code(201).send({ machine, agent_token: token, agent_token_expires_at: expiresAt.toISOString() });
  });

  /**
   * "Pair again": mints a new pairing token, revokes the device key (or the legacy bearer token) and
   * kicks the current connection (if any). The path keeps its old name so older web builds still work.
   */
  app.post('/:id/agent-token', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    if (machine.type !== 'agent') throw badRequest('Máquina não usa agente');
    const { token, hash } = newAgentToken();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await repos.machines.startAgentPairing(id, hash, expiresAt);
    agents.disconnect(id, CLOSE.UNAUTHORIZED, 'rotated');
    await audit(repos, request, 'machine.agent_token_rotate', { target: { type: 'machine', id, label: machine.name } });
    return { agent_token: token, agent_token_expires_at: expiresAt.toISOString() };
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
    // ai-memory keeps everything on the machine: its URL is a loopback/private origin or nothing (TER-1018)
    if (merged.ai_memory_url) {
      const url = normalizeAiMemoryUrl(merged.ai_memory_url);
      if (!url) throw badRequest('O endereço do ai-memory precisa ser local (127.0.0.1, localhost) ou de rede privada');
      merged.ai_memory_url = url === AI_MEMORY_DEFAULT_URL ? null : url;
    } else merged.ai_memory_url = null;
    // owner transfer is an admin-only field (any admin scope, including "all")
    const { owner_id } = ownerPatch.parse(request.body ?? {});
    if (owner_id !== undefined) {
      if (!(await isAdmin(repos, request.user))) throw forbidden('Só administradores transferem máquinas');
      if (owner_id && !(await repos.users.findById(owner_id))) throw badRequest('Usuário inexistente');
    }
    const machine = await repos.machines.update(id, { ...merged, ...(owner_id !== undefined ? { owner_id } : {}) });
    if (machine && machine.automation_allowed !== current.automation_allowed) await recordMachineSwitch(repos, id, machine.automation_allowed, 'web');
    // A city only ever shows the robots on machines its person owns (public/read.ts), so a
    // transferred machine's robots leave the old owner's city by that rule alone — the projects stay
    // published (they belong to their owners, not to the machine). Any public page showing them
    // hangs up and re-reads.
    if (owner_id !== undefined && owner_id !== current.owner_id) {
      await audit(repos, request, 'machine.transfer', { target: { type: 'machine', id, label: current.name }, meta: { from: current.owner_id, to: owner_id } });
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

  /**
   * Deletes the machine. With `?uninstall=1` (an online agent on 0.22.0+) it first removes what the agent
   * left on the machine: the monitor hooks, the tmux sessions of its tabs (best effort) and, through
   * `agent.uninstall`, the service definition and the agent's config (its token). A failure removing the
   * hooks or the agent aborts before anything is deleted here, so the person can retry or skip the uninstall.
   */
  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { uninstall } = deleteQuery.parse(request.query);
    const machine = await scoped(repos, request).machine(id);
    // The DB cascade removes this machine's project links and its own tabs; the projects survive.
    const tabs = await repos.tabs.listByMachine(id);
    if (uninstall === '1' || uninstall === 'true') await uninstallFromMachine(machine, tabs, request.log);
    // the cascade bypasses TabsRepository.delete: the tabs' tokens are revoked here, before it
    await repos.apiTokens.revokeForTabs(tabs.map((t) => t.id));
    await repos.machines.delete(id);
    await publishTabsRemoved(repos, tabs, [machine]);
    // its robots leave every public city at once (the projects, and their publish switch, stay)
    publicBus.publishRobotsGone({ machine_id: id });
    agents.disconnect(id, CLOSE.UNAUTHORIZED, 'deleted');
    await audit(repos, request, 'machine.delete', { target: { type: 'machine', id, label: machine.name }, meta: { owner_id: machine.owner_id, tabs: tabs.length } });
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
   * From the machine, a POST without a token to the monitor hooks address and the tabs' MCP (TER-586): the
   * agent reaching /agent/ws says nothing about these, which may sit on another host (termhub.dev). termhub
   * answers 401 there, so only 401 counts as reachable; a firewall answers something else, or nothing.
   */
  app.get('/:id/network-check', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    requireNetCheckCapable(machine);
    const targets: { name: 'hooks' | 'mcp'; url: string }[] = [{ name: 'hooks', url: config.hooksUrl }];
    if (config.mcpUrl) targets.push({ name: 'mcp', url: config.mcpUrl });
    const { results } = await agentRpc(machine, 'net.check', { urls: targets.map((t) => t.url) });
    const checks = targets.map((t, i) => {
      const r = results[i];
      const status = r?.status ?? null;
      return { name: t.name, url: t.url, host: new URL(t.url).host, ok: status === 401, status, error: r?.error ?? null };
    });
    request.log.info({ machineId: machine.id, checks: checks.map((c) => ({ name: c.name, ok: c.ok, status: c.status })) }, 'machine network check');
    return { checks };
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
    let done;
    try {
      done = await installMachineHooksOn(repos, machine);
    } catch (err) {
      // Agent failures (offline, outdated, what the machine reported) already carry their own status.
      if (err instanceof HttpError) throw err;
      throw conflict(err instanceof Error ? localizedOf(err) : tk('Instalação falhou'));
    }
    const { report, installed_at } = done;
    request.log.info({ machineId: machine.id, claude: report.claude, claudeDirs: report.claude_dirs.length, codex: report.codex, cursor: report.cursor }, 'monitor: hooks installed');
    return { installed_at, hooks_url: report.hooks_url, claude: report.claude, codex: report.codex, cursor: report.cursor, claude_dirs: report.claude_dirs };
  });

  /** Removes the hooks from the machine and revokes its token. */
  app.delete('/:id/hooks', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    try {
      await uninstallHooks(machine, await claudeAccountDirs(repos, machine.id));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw conflict(err instanceof Error ? localizedOf(err) : tk('Remoção falhou'));
    }
    await repos.machineHooks.delete(machine.id);
    request.log.info({ machineId: machine.id }, 'monitor: hooks removed');
    return { ok: true };
  });

  /**
   * ai-memory on the machine (TER-1018): off → `{ enabled: false }` without touching the machine;
   * on → whether the binary is there, its version and whether its local server answers.
   */
  app.get('/:id/ai-memory', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    return aiMemoryState(machine);
  });

  /** Installs the latest @termhub/agent on the machine through the agent itself; the agent restarts when it runs as a service. */
  app.post('/:id/agent/update', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    if (machine.type !== 'agent') throw badRequest('Só máquinas com agente são atualizadas por aqui');
    // only a release whose provenance the server verified (agent/release-verify.ts)
    const latest = latestAgentRelease();
    if (!latest) throw new HttpError(503, 'Versão mais nova do agente ainda desconhecida (npm)', 'AGENT_LATEST_UNKNOWN');
    const info = agents.info(machine.id);
    if (!info) throw new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
    if (!isOutdated(info.agent_version, latest.version)) throw conflict(msg('O agente já está na versão {{version}}', { version: info.agent_version }));
    requireAgentVersion(machine, MIN_SELF_UPDATE_VERSION);
    return runAgentUpdate(machine.id, latest, request.log);
  });

  /** The `?uninstall=1` part of DELETE /:id; throws (nothing deleted yet) when the hooks or the agent could not be removed. */
  async function uninstallFromMachine(machine: Machine, tabs: Tab[], log: FastifyBaseLogger): Promise<void> {
    if (machine.type !== 'agent') throw badRequest('Só máquinas com agente são desinstaladas por aqui');
    if (!agents.info(machine.id)) throw new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
    requireAgentVersion(machine, AGENT_UNINSTALL_MIN_VERSION);
    try {
      await uninstallHooks(machine, await claudeAccountDirs(repos, machine.id));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw conflict(err instanceof Error ? localizedOf(err) : tk('Remoção falhou'));
    }
    await repos.machineHooks.delete(machine.id);
    const sessions = tabs.filter((t) => t.tmux_session);
    const killed = await Promise.allSettled(sessions.map((t) => killTmuxSession(machine, t.tmux_session!)));
    const sessionsKilled = killed.filter((r) => r.status === 'fulfilled' && r.value).length;
    let service: 'removed' | 'none' | 'unknown';
    try {
      // agents.rpc rather than agentRpc: AgentClosedError must stay recognisable (agentRpc maps it to 503)
      service = (await agents.rpc(machine.id, 'agent.uninstall', {})).service;
    } catch (err) {
      // The agent stops right after answering; a socket that closes first still means it went away.
      if (!(err instanceof AgentClosedError)) throw toHttpError(err);
      service = 'unknown';
      log.info({ machineId: machine.id }, 'agent connection closed during uninstall (agent left)');
    }
    log.info({ machineId: machine.id, service, sessions: sessions.length, sessionsKilled }, 'agent uninstalled from the machine');
  }

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
