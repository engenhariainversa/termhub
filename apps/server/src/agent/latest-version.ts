import { httpJson } from '../ai/credentials.js';
import type { Repositories } from '../db/repositories/index.js';
import { HttpError } from '../lib/errors.js';
import { AgentClosedError, AgentRpcError } from './connection.js';
import { toHttpError, versionAtLeast } from './errors.js';
import { agents } from './registry.js';
import { msg } from '../i18n/index.js';

/**
 * Which @termhub/agent is the newest on npm, so the UI can offer an update and the auto-update
 * scheduler (below, Task 5) knows what to install. One process-wide cache, refreshed hourly;
 * null until the registry answered once (the UI then shows nothing).
 */
export const AGENT_PACKAGE = '@termhub/agent';
const REGISTRY_URL = `https://registry.npmjs.org/${AGENT_PACKAGE}/latest`;
export const REFRESH_MS = 60 * 60 * 1000;
const FIRST_FETCH_DELAY_MS = 2_000;
/** First agent that knows the agent.update RPC. */
export const MIN_SELF_UPDATE_VERSION = '0.2.1';
const SEMVER = /^\d+\.\d+\.\d+$/;

type FetchJson = typeof httpJson;
export interface VersionLog {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
}

let cached: string | null = null;

export function latestAgentVersion(): string | null {
  return cached;
}

/** Tests only. */
export function setLatestAgentVersion(v: string | null): void {
  cached = v;
}

/** True when both are plain x.y.z and `current` is older than `latest`. */
export function isOutdated(current: string | null | undefined, latest: string | null): boolean {
  if (!current || !latest || !SEMVER.test(current) || !SEMVER.test(latest)) return false;
  return !versionAtLeast(current, latest);
}

export async function fetchLatestAgentVersion(fetchJson: FetchJson = httpJson): Promise<string | null> {
  try {
    const r = await fetchJson(REGISTRY_URL, { headers: { accept: 'application/json' }, timeoutMs: 10_000 });
    if (r.status !== 200 || !r.body || typeof r.body !== 'object') return null;
    const v = (r.body as { version?: unknown }).version;
    return typeof v === 'string' && SEMVER.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Fetches shortly after boot and then every REFRESH_MS; `onRefresh` runs after each successful fetch. Returns a stop function. */
export function startAgentVersionPoller(log: VersionLog, onRefresh?: () => Promise<void>, fetchJson: FetchJson = httpJson): () => void {
  const tick = async () => {
    const v = await fetchLatestAgentVersion(fetchJson);
    if (!v) {
      log.warn({ package: AGENT_PACKAGE }, 'npm registry: could not read the latest agent version');
      return;
    }
    if (v !== cached) log.info({ version: v }, 'latest agent version on npm');
    cached = v;
    try {
      await onRefresh?.();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'agent version refresh hook failed');
    }
  };
  const timer = setInterval(() => void tick(), REFRESH_MS);
  timer.unref();
  const first = setTimeout(() => void tick(), FIRST_FETCH_DELAY_MS);
  first.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}

export const UPDATE_TIMEOUT_MS = 180_000;
export interface AgentUpdateOutcome {
  installed_version: string | null;
  restart: 'service' | 'manual';
  /** the agent is leaving to come back on the new version: poll the status until agent_version changes */
  restarting: boolean;
}

/** Runs agent.update on a connected agent. The connection closing mid-call means the agent already left to restart. */
export async function runAgentUpdate(machineId: string, version: string, log: VersionLog): Promise<AgentUpdateOutcome> {
  try {
    const r = await agents.rpc(machineId, 'agent.update', { version }, UPDATE_TIMEOUT_MS);
    log.info({ machineId, version: r.installed_version, restart: r.restart }, 'agent updated');
    return { ...r, restarting: r.restart === 'service' };
  } catch (err) {
    if (err instanceof AgentClosedError) {
      log.info({ machineId, version }, 'agent connection closed during update (restarting)');
      return { installed_version: null, restart: 'service', restarting: true };
    }
    if (err instanceof AgentRpcError) {
      switch (err.rpcError.code) {
        case 'failed':
          throw new HttpError(502, msg('Falha ao atualizar o agente: {{reason}}. Se persistir, rode na máquina: npm i -g @termhub/agent@latest', { reason: err.rpcError.message }), 'AGENT_UPDATE_FAILED');
        case 'timeout':
          throw new HttpError(504, 'A instalação do agente demorou demais; verifique na máquina', 'AGENT_UPDATE_TIMEOUT');
        case 'notfound':
          throw new HttpError(502, 'npm não encontrado na máquina; rode: npm i -g @termhub/agent@latest', 'AGENT_UPDATE_NPM_MISSING');
      }
    }
    throw toHttpError(err);
  }
}

export const AUTO_UPDATE_MS = 10 * 60 * 1000;
/** machine id → version already attempted, so a failing install is tried once per release. */
const attempted = new Map<string, string>();

/** Tests only. */
export function resetAutoUpdateAttempts(): void {
  attempted.clear();
}

/**
 * Installs the latest agent on opted-in machines that are online, outdated, new enough to know
 * the RPC and idle. Idle means both no terminal attached *and* no tool mid-task on the machine:
 * the update restarts the agent, which drops its socket for a few seconds, and a tool working (or
 * waiting for its person) inside a detached tmux session opens no channel to notice.
 */
export async function autoUpdateTick(repos: Pick<Repositories, 'machines' | 'tabs'>, log: VersionLog): Promise<void> {
  const latest = cached;
  if (!latest) return;
  const machines = await repos.machines.listAutoUpdate();
  for (const m of machines) {
    const info = agents.info(m.id);
    if (!info || !isOutdated(info.agent_version, latest)) continue;
    if (!versionAtLeast(info.agent_version, MIN_SELF_UPDATE_VERSION)) continue;
    // Any open channel: a terminal, or a chat answering on this machine (see `openChannels`).
    if (agents.openChannels(m.id) > 0) continue;
    if ((await repos.tabs.countBusyByMachine(m.id)) > 0) continue;
    if (attempted.get(m.id) === latest) continue;
    attempted.set(m.id, latest);
    try {
      const r = await runAgentUpdate(m.id, latest, log);
      log.info({ machineId: m.id, from: info.agent_version, to: latest, restart: r.restart }, 'agent auto-update');
    } catch (err) {
      log.warn({ machineId: m.id, to: latest, err: (err as Error).message }, 'agent auto-update failed');
    }
  }
}

/** Boot-time wiring: the npm poller (each refresh runs a tick) plus a tick every AUTO_UPDATE_MS. */
export function startAgentUpdateScheduler(repos: Pick<Repositories, 'machines' | 'tabs'>, log: VersionLog): () => void {
  const tick = () => autoUpdateTick(repos, log).catch((err) => log.warn({ err: (err as Error).message }, 'agent auto-update tick failed'));
  const stopPoll = startAgentVersionPoller(log, tick);
  const timer = setInterval(() => void tick(), AUTO_UPDATE_MS);
  timer.unref();
  return () => {
    stopPoll();
    clearInterval(timer);
  };
}
