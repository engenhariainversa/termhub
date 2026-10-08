import { httpJson } from '../lib/http-json.js';
import type { Repositories } from '../db/repositories/index.js';
import { HttpError } from '../lib/errors.js';
import { AgentClosedError, AgentRpcError } from './connection.js';
import { toHttpError, versionAtLeast } from './errors.js';
import { agents } from './registry.js';
import { verifyAgentRelease, type ReleaseVerifyDeps, type VerifiedRelease } from './release-verify.js';
import { msg } from '../i18n/index.js';

/**
 * Which @termhub/agent is the newest *verified* release on npm, so the UI can offer an update and the
 * auto-update scheduler (below) knows what to install. One process-wide cache, refreshed hourly; null
 * until a release passed the provenance check (`release-verify.ts`; the UI then shows nothing). A newer
 * version that fails the check is logged and skipped: the previous verified release stays.
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

/** First agent that knows the agent.uninstall RPC ("uninstall from the machine" on delete). */
export const AGENT_UNINSTALL_MIN_VERSION = '0.22.0';

let cached: VerifiedRelease | null = null;
/** version → when its verification last failed, so a bad release is retried once per poll, not in a loop. */
const failedAt = new Map<string, number>();

/** The newest verified version (what the UI compares against), or null. */
export function latestAgentVersion(): string | null {
  return cached?.version ?? null;
}

/** The newest verified release, with the integrity the agent must check the tarball against. */
export function latestAgentRelease(): VerifiedRelease | null {
  return cached;
}

/** Tests only. */
export function setLatestAgentRelease(r: VerifiedRelease | null): void {
  cached = r;
  failedAt.clear();
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

export interface PollerDeps extends ReleaseVerifyDeps {
  /** How many agents are connected now; the registry is not asked while none is (spec §4). */
  connectedAgents?: () => number;
  /** Subscribes to "an agent connected"; returns the unsubscribe. A tick skipped for lack of agents runs then. */
  onAgentOnline?: (cb: () => void) => () => void;
  now?: () => number;
  /** Tests only: replaces `verifyAgentRelease`. */
  verify?: (version: string) => Promise<VerifiedRelease>;
}

function onAnyAgentOnline(cb: () => void): () => void {
  agents.on('online', cb);
  return () => agents.off('online', cb);
}

/**
 * Fetches shortly after boot and then every REFRESH_MS. While no agent is connected the tick is skipped
 * (no request at all: neither the update badge nor the auto-update has anyone to serve) and runs as soon
 * as one connects, so a boot that beats its agents back does not leave the badge empty for an hour.
 * A version not seen before is verified (`verifyAgentRelease`) before it replaces the cache; a failure is
 * logged, the previous verified release stays, and that version is tried again no sooner than the next
 * hourly poll. `onRefresh` runs after each tick that read the registry. Returns a stop function.
 */
export function startAgentVersionPoller(log: VersionLog, onRefresh?: () => Promise<void>, deps: PollerDeps = {}): () => void {
  const fetchJson = deps.fetchJson ?? httpJson;
  const connectedAgents = deps.connectedAgents ?? (() => agents.connectedCount());
  const now = deps.now ?? Date.now;
  const verify = deps.verify ?? ((v: string) => verifyAgentRelease(v, deps));
  let skipped = false;
  let running = false;
  const tick = async () => {
    if (running) return;
    if (connectedAgents() === 0) {
      skipped = true;
      return;
    }
    skipped = false;
    running = true;
    try {
      const v = await fetchLatestAgentVersion(fetchJson);
      if (!v) {
        log.warn({ package: AGENT_PACKAGE }, 'npm registry: could not read the latest agent version');
        return;
      }
      if (v !== cached?.version) {
        const lastFail = failedAt.get(v);
        // a minute of slack: the interval and the check never line up to the millisecond
        if (lastFail === undefined || now() - lastFail >= REFRESH_MS - 60_000) {
          try {
            cached = await verify(v);
            failedAt.delete(v);
            log.info({ version: v }, 'latest agent version on npm (provenance verified)');
          } catch (err) {
            failedAt.set(v, now());
            log.warn({ version: v, err: (err as Error).message }, 'agent release failed provenance verification');
          }
        }
      }
      try {
        await onRefresh?.();
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'agent version refresh hook failed');
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), REFRESH_MS);
  timer.unref();
  const first = setTimeout(() => void tick(), FIRST_FETCH_DELAY_MS);
  first.unref();
  const unsubscribe = (deps.onAgentOnline ?? onAnyAgentOnline)(() => {
    if (skipped) void tick();
  });
  return () => {
    clearInterval(timer);
    clearTimeout(first);
    unsubscribe();
  };
}

export const UPDATE_TIMEOUT_MS = 180_000;
export interface AgentUpdateOutcome {
  installed_version: string | null;
  restart: 'service' | 'manual';
  /** the agent is leaving to come back on the new version: poll the status until agent_version changes */
  restarting: boolean;
}

/**
 * Runs agent.update on a connected agent with a verified release: the version plus the integrity an agent on
 * 0.22.0+ checks the downloaded tarball against (older agents drop the field and install by version).
 * The connection closing mid-call means the agent already left to restart.
 */
export async function runAgentUpdate(machineId: string, release: VerifiedRelease, log: VersionLog): Promise<AgentUpdateOutcome> {
  const { version } = release;
  try {
    const r = await agents.rpc(machineId, 'agent.update', { version, integrity: release.integrity }, UPDATE_TIMEOUT_MS);
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
  const release = cached;
  if (!release) return;
  const latest = release.version;
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
      const r = await runAgentUpdate(m.id, release, log);
      log.info({ machineId: m.id, from: info.agent_version, to: latest, restart: r.restart }, 'agent auto-update');
    } catch (err) {
      log.warn({ machineId: m.id, to: latest, err: (err as Error).message }, 'agent auto-update failed');
    }
  }
}

/** Boot-time wiring: the npm poller (each refresh runs a tick) plus a tick every AUTO_UPDATE_MS. Only verified releases are installed. */
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
