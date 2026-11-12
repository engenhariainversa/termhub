import { CAPABILITY_RUN_HEADLESS } from '@termhub/agent-protocol';
import { usableIn } from '../ai/exclusive.js';
import { getAccountUsage } from '../ai/index.js';
import { expiresSoon } from '../ai/login-expiry.js';
import { loadProjectAi, type ProjectAi } from '../ai/project-accounts.js';
import { peakUtilization, SWAP_MAX_UTILIZATION } from '../control/account-swap.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine } from '../db/repositories/types.js';
import type { Provider } from './events.js';
import { providerOfModel } from './models.js';

/**
 * Where an API run goes (TER-1176, spec "Routing"): the project Setup's account order, Claude Code and
 * Codex accounts only, each on a machine of the token's owner that runs an agent with `run.headless`, is
 * online and is linked to the project with a folder. Accounts marked exhausted or at 90 % of a usage
 * window are skipped; logins about to expire go last (the automatic placement's rule, read here and never
 * changed there). Every account left out says why, so a 409 can tell the caller what to fix.
 */

export type SkipReason =
  | 'exclusive'
  | 'machine_missing'
  | 'machine_not_agent'
  | 'machine_offline'
  | 'agent_outdated'
  | 'machine_not_linked'
  /** An old link stored the folder as `~/…`: the agent spawns the CLI in it as is, so it must be absolute. */
  | 'folder_not_absolute'
  | 'exhausted'
  | 'usage_peak';

export interface Candidate {
  account: AiAccount;
  machine: Machine;
  provider: Provider;
  /** The project's folder on that machine (`project_machines.cwd`). */
  cwd: string;
}

export interface Skipped {
  /** The account's label (never its config dir). */
  account: string;
  machine: string | null;
  reason: SkipReason;
}

export interface RouteResult {
  candidates: Candidate[];
  skipped: Skipped[];
  /** The project's AI block (models per CLI), read once here for the service. */
  ai: ProjectAi;
}

export interface RouteInput {
  userId: string;
  projectId: string;
  provider?: Provider | null;
  model?: string | null;
  /** A machine id or name the caller pinned. */
  machine?: string | null;
}

export interface RoutingDeps {
  repos: Pick<Repositories, 'projectSetup' | 'aiAccounts' | 'aiAccountExhaustions' | 'machines' | 'projectMachines'>;
  agents: { isOnline(machineId: string): boolean; capabilities(machineId: string): string[] | null };
  /** The account's fullest usage window, 0..100; null when unknown (kept in place). */
  usage?: (account: AiAccount, machine: Machine, model: string | null) => Promise<number | null>;
  now?: () => Date;
}

const PROVIDER_OF: Record<string, Provider | undefined> = { claude: 'claude', chatgpt: 'codex' };

/** The usage reading the automatic placement uses, never refreshed here (the cache is enough to route). */
export async function accountPeak(account: AiAccount, machine: Machine, model: string | null): Promise<number | null> {
  try {
    return peakUtilization(await getAccountUsage(account, machine), model);
  } catch {
    return null;
  }
}

export async function routeRun(deps: RoutingDeps, input: RouteInput): Promise<RouteResult> {
  const now = deps.now?.() ?? new Date();
  const usage = deps.usage ?? accountPeak;
  const [{ ai, accounts }, links, exhausted] = await Promise.all([
    // Owner-scoped: only accounts on the person's own machines, whatever their role.
    loadProjectAi(deps.repos, input.projectId, input.userId),
    deps.repos.projectMachines.listByProject(input.projectId),
    deps.repos.aiAccountExhaustions.activeIds(now),
  ]);
  const cwdOf = new Map(links.map((l) => [l.machine_id, l.cwd]));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const wantedProvider = input.provider ?? (input.model ? providerOfModel(input.model) : null);
  const machines = new Map<string, Machine | undefined>();
  const machineOf = async (id: string) => {
    if (!machines.has(id)) machines.set(id, await deps.repos.machines.findById(id));
    return machines.get(id);
  };

  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  for (const id of ai.accounts) {
    const account = byId.get(id);
    if (!account) continue; // deleted, or not the person's own
    const provider = PROVIDER_OF[account.provider];
    if (!provider) continue;
    if (wantedProvider && provider !== wantedProvider) continue;
    const machine = await machineOf(account.machine_id);
    // Shared or team machines are never used, even when the account list let one through.
    if (machine && machine.owner_id !== input.userId) continue;
    if (input.machine && machine && machine.id !== input.machine && machine.name !== input.machine) continue;
    if (input.machine && !machine) continue;
    const skip = (reason: SkipReason) => skipped.push({ account: account.label, machine: machine?.name ?? null, reason });
    if (!usableIn(account, input.projectId)) {
      skip('exclusive');
      continue;
    }
    if (!machine) {
      skip('machine_missing');
      continue;
    }
    if (machine.type !== 'agent') {
      skip('machine_not_agent');
      continue;
    }
    if (!deps.agents.isOnline(machine.id)) {
      skip('machine_offline');
      continue;
    }
    if (!(deps.agents.capabilities(machine.id) ?? []).includes(CAPABILITY_RUN_HEADLESS)) {
      skip('agent_outdated');
      continue;
    }
    const cwd = cwdOf.get(machine.id);
    if (!cwd) {
      skip('machine_not_linked');
      continue;
    }
    if (!cwd.startsWith('/')) {
      skip('folder_not_absolute');
      continue;
    }
    if (exhausted.has(account.id)) {
      skip('exhausted');
      continue;
    }
    const peak = await usage(account, machine, input.model ?? null);
    if (peak !== null && peak >= SWAP_MAX_UTILIZATION) {
      skip('usage_peak');
      continue;
    }
    candidates.push({ account, machine, provider, cwd });
  }

  // A login about to expire goes after the ones with slack; the sort is stable, so the order holds otherwise.
  const soon = (c: Candidate) => (expiresSoon(c.account.login_expires_at, now) ? 1 : 0);
  candidates.sort((a, b) => soon(a) - soon(b));
  return { candidates, skipped, ai };
}
