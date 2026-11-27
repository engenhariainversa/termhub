import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, AiProvider, Machine } from '../db/repositories/types.js';

/**
 * Which AI accounts something still runs on (TER-1212), so a login warning is not raised for an account
 * the person left behind. An account is in use when:
 * - a project's Setup lists it ("AI accounts and model": the project's chat, start_agent and automatic work);
 * - it is the account the account-wide chat names, or, when it names none, the machine's own Claude login
 *   (no config dir) on the chat's host (the machine it names, or the person's only agent machine);
 * - its CLI is one the Setup cannot list (Gemini, Antigravity): nothing tells whether it is used, so it counts.
 */

/** The CLIs a project's Setup lists accounts of; any other is always counted in use. */
const SETUP_PROVIDERS: readonly AiProvider[] = ['claude', 'chatgpt'];

export type AccountUseRepos = Pick<Repositories, 'projectSetup' | 'chat'>;

export async function accountsInUse(repos: AccountUseRepos, accounts: readonly AiAccount[], machines: readonly Machine[]): Promise<Set<string>> {
  const machineById = new Map(machines.map((m) => [m.id, m]));
  const owners = [...new Set(accounts.map((a) => machineById.get(a.machine_id)?.owner_id).filter((o): o is string => !!o))];
  const [listed, hosts] = await Promise.all([repos.projectSetup.listedAccountIds(), repos.chat.generalHosts(owners)]);
  const used = new Set<string>();
  for (const a of accounts) if (listed.has(a.id) || !SETUP_PROVIDERS.includes(a.provider)) used.add(a.id);
  for (const host of hosts) {
    if (host.ai_account_id && accounts.some((a) => a.id === host.ai_account_id)) {
      used.add(host.ai_account_id);
      continue;
    }
    const agentMachines = machines.filter((m) => m.owner_id === host.user_id && m.type === 'agent');
    const machineId = host.machine_id ?? (agentMachines.length === 1 ? agentMachines[0].id : null);
    const own = machineId ? accounts.find((a) => a.machine_id === machineId && a.provider === 'claude' && !a.config_dir) : undefined;
    if (own) used.add(own.id);
  }
  return used;
}
