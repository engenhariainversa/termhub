import { CAPABILITY_WORKTREE, WORKTREE_MIN_AGENT_VERSION } from '@termhub/agent-protocol';
import { versionAtLeast } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import { accountsOn } from '../ai/project-accounts.js';
import { peakUtilization, SWAP_MAX_UTILIZATION } from '../control/account-swap.js';
import { getAccountUsage } from '../ai/index.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Project, ProjectMachine } from '../db/repositories/types.js';
import type { ProjectSetupData } from '../setup/schema.js';
import type { IneligibleReason } from './eligibility.js';

/** Why an eligible card found no place this tick (spec §8 step 3). Not an error and not an event. */
export type WaitingReason = 'no_machine' | 'no_account' | 'machine_offline';

export interface PlacementDeps {
  repos: Repositories;
  now(): Date;
  /** The account's peak utilization in percent (`getAccountUsage` → `peakUtilization`); null = unknown. */
  usage: (accountId: string) => Promise<number | null>;
}

export type Placement = { machine: Machine; account: AiAccount; link: ProjectMachine } | { waiting: WaitingReason };

/** An agent machine of the project's owner that answers the worktree RPC right now (D10). */
const capableNow = (m: Machine) => (agents.capabilities(m.id) ?? []).includes(CAPABILITY_WORKTREE);
/** An agent recent enough for worktrees that is not connected: the card waits for it, not for an update. */
const capableButOffline = (m: Machine) => !agents.isOnline(m.id) && m.agent_version !== null && versionAtLeast(m.agent_version, WORKTREE_MIN_AGENT_VERSION);

/**
 * Where an automatic run starts (spec §8 step 3, D10, D14): an online agent machine linked to the project
 * with the worktree capability and Claude installed, under the first Claude account of the project's list
 * (in its order) that is on that machine, is not marked exhausted and has room (peak utilization below
 * `SWAP_MAX_UTILIZATION`; unknown usage counts as room, as for `start_agent`). Unlike `start_agent`, it
 * never falls back to a full account: the card waits instead.
 */
export async function placeRun(deps: PlacementDeps, project: Project, setup: ProjectSetupData): Promise<Placement> {
  const { repos } = deps;
  if (!project.owner_id) return { waiting: 'no_machine' };
  const links = await repos.projectMachines.listByProject(project.id);
  const linked: Array<{ machine: Machine; link: ProjectMachine }> = [];
  for (const link of links) {
    const machine = await repos.machines.findById(link.machine_id);
    // ssh and local machines are never chosen (D10); a machine out of the owner's scope neither
    if (machine && machine.type === 'agent' && machine.owner_id === project.owner_id) linked.push({ machine, link });
  }
  const ready = linked.filter(({ machine }) => capableNow(machine) && machine.capabilities.includes('claude'));
  if (ready.length === 0) return { waiting: linked.some(({ machine }) => capableButOffline(machine)) ? 'machine_offline' : 'no_machine' };

  const [listed, exhausted] = await Promise.all([repos.aiAccounts.list(project.owner_id), repos.aiAccountExhaustions.activeIds(deps.now())]);
  const { ai } = setup;
  const candidates = ready
    .flatMap(({ machine }) => accountsOn(ai, listed, machine.id, 'claude'))
    .filter((a) => !exhausted.has(a.id))
    .sort((x, y) => ai.accounts.indexOf(x.id) - ai.accounts.indexOf(y.id));
  for (const account of candidates) {
    const peak = await deps.usage(account.id);
    if (peak !== null && peak >= SWAP_MAX_UTILIZATION) continue;
    const place = ready.find(({ machine }) => machine.id === account.machine_id)!;
    return { machine: place.machine, account, link: place.link };
  }
  return { waiting: 'no_account' };
}

/** What the queue shows for a waiting card. */
export const WAITING_AS_REASON: Record<WaitingReason, IneligibleReason> = {
  no_machine: 'no_capable_machine',
  no_account: 'no_account',
  machine_offline: 'machine_offline',
};

/**
 * A waiting reason is shown while it is this fresh: a few ticks. Past that the dispatcher of this process
 * is not looking at the card any more (stopped, or the card was placed elsewhere), and the queue falls
 * back to the card's own eligibility.
 */
export const WAITING_TTL_MS = 60_000;

/**
 * The cards that found no place, per process (spec §8: "card keeps a waiting reason shown on the board").
 * Kept in memory on purpose: the claim row is deleted so nothing is written per tick; a restart clears it
 * and the next tick fills it again.
 */
const waiting = new Map<string, { reason: WaitingReason; at: number }>();

export function noteWaiting(taskId: string, reason: WaitingReason, now: Date): void {
  waiting.set(taskId, { reason, at: now.getTime() });
}

export function clearWaiting(taskId: string): void {
  waiting.delete(taskId);
}

export function waitingReasonOf(taskId: string, now: Date = new Date()): WaitingReason | null {
  const w = waiting.get(taskId);
  if (!w) return null;
  if (now.getTime() - w.at > WAITING_TTL_MS) {
    waiting.delete(taskId);
    return null;
  }
  return w.reason;
}

/** Tests only. */
export function resetWaiting(): void {
  waiting.clear();
}

/** `DispatcherDeps.usage` from the real usage readers: the account's peak utilization, null when unknown. */
export function accountPeak(repos: Repositories): (accountId: string) => Promise<number | null> {
  return async (accountId) => {
    try {
      const account = await repos.aiAccounts.findById(accountId);
      if (!account) return null;
      const machine = await repos.machines.findById(account.machine_id);
      return peakUtilization(await getAccountUsage(account, machine));
    } catch {
      return null;
    }
  };
}
