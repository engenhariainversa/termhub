import { CAPABILITY_WORKTREE } from '@termhub/agent-protocol';
import { versionAtLeast } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import { GUARD_MIN_AGENT_VERSION, guardSupported } from '../terminal/tab-mcp.js';
import { usableIn } from '../ai/exclusive.js';
import { accountsOn } from '../ai/project-accounts.js';
import { peakUtilization } from '../control/account-swap.js';
import { getAccountUsage } from '../ai/index.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Project, ProjectMachine } from '../db/repositories/types.js';
import type { ProjectSetupData } from '../setup/schema.js';
import type { IneligibleReason } from './eligibility.js';

/** Why an eligible card found no place this tick (spec §8 step 3). Not an error and not an event. */
export type WaitingReason = 'no_machine' | 'no_account' | 'machine_offline' | 'no_room' | 'automation_not_allowed';

/** Spike §2: automatic starts keep more headroom than a person's `start_agent` (`SWAP_MAX_UTILIZATION`). */
export const AUTOMATIC_MAX_UTILIZATION = 80;

export interface PlacementDeps {
  repos: Repositories;
  now(): Date;
  /** The account's peak utilization in percent (`getAccountUsage` → `peakUtilization`); null = unknown. */
  usage: (accountId: string) => Promise<number | null>;
  /**
   * R6: whether the machine has room for one more run (memory, disk under `worktrees_dir`, load; a failed
   * reading = no room). Without it no room check is made (tests); the app wires the real one.
   */
  room?: (machine: Machine, link: ProjectMachine, setup: ProjectSetupData) => Promise<boolean>;
}

/** R6: what this tick already started. At most one start per machine and per account per tick. */
export interface TickStarts {
  machines: Set<string>;
  accounts: Set<string>;
}

/** Why a linked machine was left out (TER-985: the waiting reason names each one). */
export type MachineVerdict = 'not_agent' | 'offline' | 'no_worktree' | 'no_guard' | 'no_claude' | 'not_allowed' | 'no_room';
/**
 * Why a Claude account of a usable machine was left out: not in the project's list ("Contas de IA e
 * modelo"), marked exhausted, at or above `AUTOMATIC_MAX_UTILIZATION`, already given a start this tick,
 * or on a machine without room.
 */
export type AccountVerdict = 'not_listed' | 'exclusive' | 'exhausted' | 'busy' | 'taken' | 'machine_no_room';

/** What a placement that found nothing looked at: every machine and account it left out, and why. Ids and names only. */
export interface PlaceDetail {
  /** how many accounts the project's list has (0 = none chosen in the Setup) */
  listed: number;
  machines: Array<{ id: string; name: string; why: MachineVerdict }>;
  accounts: Array<{ id: string; label: string; machine: string; why: AccountVerdict; peak?: number }>;
}

export type Placement =
  | { machine: Machine; account: AiAccount; link: ProjectMachine }
  // `later`: every place is taken by a start of this tick; nothing to show, the next tick asks again
  | { waiting: WaitingReason | 'later'; detail?: PlaceDetail };

/** An agent machine of the project's owner that answers the worktree RPC right now (D10). */
const worktreeNow = (m: Machine) => (agents.capabilities(m.id) ?? []).includes(CAPABILITY_WORKTREE);
/** …and has the hard-lock guard script (agent 0.19.0, TER-993): a run never starts without it (TER-1005). */
const capableNow = (m: Machine) => worktreeNow(m) && guardSupported(m);
/** An agent recent enough for automatic work that is not connected: the card waits for it, not for an update. */
const capableButOffline = (m: Machine) => !agents.isOnline(m.id) && m.agent_version !== null && versionAtLeast(m.agent_version, GUARD_MIN_AGENT_VERSION);

function machineVerdict(m: Machine): MachineVerdict | null {
  if (m.type !== 'agent') return 'not_agent';
  if (!agents.isOnline(m.id)) return 'offline';
  if (!worktreeNow(m)) return 'no_worktree';
  if (!guardSupported(m)) return 'no_guard';
  if (!m.capabilities.includes('claude')) return 'no_claude';
  if (!m.automation_allowed) return 'not_allowed';
  return null;
}

/**
 * Where an automatic run starts (spec §8 step 3, D10, D14, spike R6): an online agent machine linked to the
 * project that accepts automatic work (`automation_allowed`), with the worktree capability and Claude
 * installed, under the first Claude account of the project's list (in its order) that is on that machine, is
 * not marked exhausted and has room (peak utilization below `AUTOMATIC_MAX_UTILIZATION`; unknown usage
 * counts as room, as for `start_agent`), on a machine with room (`deps.room`). Unlike `start_agent`, it never
 * falls back to a full account: the card waits instead, with `detail` naming each machine and account left
 * out and why (TER-985). The cheap checks come first, so a machine is only read (`hw.probe`) when an account
 * would otherwise be chosen on it.
 */
export async function placeRun(deps: PlacementDeps, project: Project, setup: ProjectSetupData, tick?: TickStarts): Promise<Placement> {
  const { repos } = deps;
  const { ai } = setup;
  if (!project.owner_id) return { waiting: 'no_machine' };
  const links = await repos.projectMachines.listByProject(project.id);
  const linked: Array<{ machine: Machine; link: ProjectMachine }> = [];
  for (const link of links) {
    const machine = await repos.machines.findById(link.machine_id);
    // a machine out of the owner's scope is never chosen nor named
    if (machine && machine.owner_id === project.owner_id) linked.push({ machine, link });
  }
  const detail: PlaceDetail = { listed: ai.accounts.length, machines: [], accounts: [] };
  const ready: typeof linked = [];
  for (const place of linked) {
    const why = machineVerdict(place.machine);
    if (why) detail.machines.push({ id: place.machine.id, name: place.machine.name, why });
    else ready.push(place);
  }
  // ssh and local machines are never chosen (D10)
  const capable = linked.filter(({ machine }) => machine.type === 'agent' && capableNow(machine) && machine.capabilities.includes('claude'));
  if (capable.length === 0) return { waiting: linked.some(({ machine }) => machine.type === 'agent' && capableButOffline(machine)) ? 'machine_offline' : 'no_machine', detail };
  if (ready.length === 0) return { waiting: 'automation_not_allowed', detail };

  const [listed, exhausted] = await Promise.all([repos.aiAccounts.list(project.owner_id), repos.aiAccountExhaustions.activeIds(deps.now())]);
  const nameOf = new Map(ready.map(({ machine }) => [machine.id, machine.name]));
  const candidates = ready.flatMap(({ machine }) => accountsOn(project.id, ai, listed, machine.id, 'claude')).sort((x, y) => ai.accounts.indexOf(x.id) - ai.accounts.indexOf(y.id));
  const left = (account: AiAccount, why: AccountVerdict, peak?: number) =>
    detail.accounts.push({ id: account.id, label: account.label, machine: nameOf.get(account.machine_id) ?? account.machine_id, why, ...(peak === undefined ? {} : { peak }) });
  const inList = new Set(candidates.map((a) => a.id));
  // TER-990: an account exclusive to another project is never a candidate, listed in the Setup or not
  for (const a of listed) if (a.provider === 'claude' && nameOf.has(a.machine_id) && !inList.has(a.id)) left(a, usableIn(a, project.id) ? 'not_listed' : 'exclusive');
  let taken = false;
  let crowded = false;
  const roomOf = new Map<string, Promise<boolean>>();
  for (const account of candidates) {
    if (exhausted.has(account.id)) {
      left(account, 'exhausted');
      continue;
    }
    if (tick && (tick.accounts.has(account.id) || tick.machines.has(account.machine_id))) {
      taken = true;
      left(account, 'taken');
      continue;
    }
    const peak = await deps.usage(account.id);
    if (peak !== null && peak >= AUTOMATIC_MAX_UTILIZATION) {
      left(account, 'busy', Math.round(peak));
      continue;
    }
    const place = ready.find(({ machine }) => machine.id === account.machine_id)!;
    if (deps.room) {
      if (!roomOf.has(place.machine.id)) roomOf.set(place.machine.id, deps.room(place.machine, place.link, setup));
      if (!(await roomOf.get(place.machine.id))) {
        crowded = true;
        if (!detail.machines.some((m) => m.id === place.machine.id)) detail.machines.push({ id: place.machine.id, name: place.machine.name, why: 'no_room' });
        left(account, 'machine_no_room');
        continue;
      }
    }
    return { machine: place.machine, account, link: place.link };
  }
  return crowded ? { waiting: 'no_room', detail } : taken ? { waiting: 'later' } : { waiting: 'no_account', detail };
}

/** What the queue shows for a waiting card. */
export const WAITING_AS_REASON: Record<WaitingReason, IneligibleReason> = {
  no_machine: 'no_capable_machine',
  no_account: 'no_account',
  machine_offline: 'machine_offline',
  no_room: 'no_room',
  automation_not_allowed: 'automation_not_allowed',
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
const waiting = new Map<string, { reason: WaitingReason; detail: PlaceDetail | null; at: number }>();

export function noteWaiting(taskId: string, reason: WaitingReason, now: Date, detail: PlaceDetail | null = null): void {
  waiting.set(taskId, { reason, detail, at: now.getTime() });
}

export function clearWaiting(taskId: string): void {
  waiting.delete(taskId);
}

export function waitingReasonOf(taskId: string, now: Date = new Date()): WaitingReason | null {
  return waitingOf(taskId, now)?.reason ?? null;
}

/** The waiting reason and what the placement left out, while fresh. */
export function waitingOf(taskId: string, now: Date = new Date()): { reason: WaitingReason; detail: PlaceDetail | null } | null {
  const w = waiting.get(taskId);
  if (!w) return null;
  if (now.getTime() - w.at > WAITING_TTL_MS) {
    waiting.delete(taskId);
    return null;
  }
  return { reason: w.reason, detail: w.detail };
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
