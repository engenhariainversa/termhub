import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { readHooksStatus } from '../monitor/install.js';
import { claudeAccountDirs, installMachineHooksOn } from '../monitor/machine-hooks.js';
import { versionAtLeast } from './errors.js';
import { agents } from './registry.js';

/**
 * What follows an agent update (TER-1056): wait for the agent to come back on the new version, then
 * refresh the monitor hooks when termhub installed them there and the forwarding script (or our entries)
 * changed since, and say whether the machine still dials with the legacy bearer token (TER-1017), so the
 * person can be offered a new pairing. Runs after the update button, the concierge's update_machine_agent
 * and the auto-update alike; one follow per machine at a time.
 */

export const RECONNECT_WAIT_MS = 120_000;
const POLL_MS = 1_000;

export type HooksRefresh =
  /** our hooks were outdated and were installed again */
  | 'reinstalled'
  /** our hooks are there and current */
  | 'current'
  /** termhub never installed hooks on this machine: nothing to refresh (installing them is the person's call) */
  | 'not_installed'
  /** the hooks could not be read or written; the machine screen's button tries again */
  | 'failed'
  /** the agent did not come back on the new version in time */
  | 'skipped';

export interface AfterUpdate {
  /** the agent reconnected on the target version (or newer) */
  back: boolean;
  agent_version: string | null;
  hooks: HooksRefresh;
  /** the machine still dials with the legacy bearer token: a new pairing gives it a device key */
  repair_suggested: boolean;
}

export interface FollowLog {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
}

export interface FollowDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** The connected agent's version once it is `target` or newer, or null when that does not happen in time. */
export async function waitForAgentVersion(machineId: string, target: string, deps: FollowDeps = {}): Promise<string | null> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.timeoutMs ?? RECONNECT_WAIT_MS);
  for (;;) {
    const v = agents.info(machineId)?.agent_version;
    if (v && versionAtLeast(v, target)) return v;
    if (now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

/** Installs the hooks again when termhub put them there and the machine's copy is no longer what this server installs. */
export async function refreshHooksAfterUpdate(repos: Repositories, machine: Machine, log: FollowLog): Promise<HooksRefresh> {
  try {
    if (!(await repos.machineHooks.findByMachine(machine.id))) return 'not_installed';
    const s = await readHooksStatus(machine, await claudeAccountDirs(repos, machine.id));
    const outdated = s.script.outdated || [s.claude, s.codex, s.cursor].some((tool) => tool.present && tool.state === 'outdated');
    if (!outdated) return 'current';
    await installMachineHooksOn(repos, machine);
    log.info({ machineId: machine.id }, 'monitor: hooks reinstalled after agent update');
    return 'reinstalled';
  } catch (err) {
    log.warn({ machineId: machine.id, err: (err as Error).message }, 'monitor: hooks refresh after agent update failed');
    return 'failed';
  }
}

const following = new Map<string, Promise<AfterUpdate>>();

/** Tests only. */
export function resetFollows(): void {
  following.clear();
}

/** Waits for the agent on `target`, then refreshes the hooks. A second call for the same machine joins the first. */
export function followAgentUpdate(repos: Repositories, machine: Machine, target: string, log: FollowLog, deps: FollowDeps = {}): Promise<AfterUpdate> {
  const running = following.get(machine.id);
  if (running) return running;
  const run = (async (): Promise<AfterUpdate> => {
    const repair_suggested = machine.agent_credential === 'bearer';
    const version = await waitForAgentVersion(machine.id, target, deps);
    if (!version) {
      log.warn({ machineId: machine.id, to: target }, 'agent did not come back on the new version in time');
      return { back: false, agent_version: agents.info(machine.id)?.agent_version ?? null, hooks: 'skipped', repair_suggested };
    }
    return { back: true, agent_version: version, hooks: await refreshHooksAfterUpdate(repos, machine, log), repair_suggested };
  })().finally(() => following.delete(machine.id));
  following.set(machine.id, run);
  return run;
}
