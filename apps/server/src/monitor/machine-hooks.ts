import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { config } from '../config.js';
import { installHooks, type HookInstallReport } from './install.js';
import { newHookToken } from './token.js';

/**
 * The install the machine screen's button does, shared with the concierge's `install_machine_hooks`
 * (TER-1023) so both write the same files with the same fresh token. Only the token's hash is kept
 * here; the plain token lives in ~/.termhub/hook.env on the machine and is never returned or logged.
 */

/** Config dirs of the Claude accounts registered on the machine (CLAUDE_CONFIG_DIR): the hooks go there too. */
export async function claudeAccountDirs(repos: Repositories, machineId: string): Promise<string[]> {
  return (await repos.aiAccounts.list())
    .filter((a) => a.machine_id === machineId && a.provider === 'claude' && a.config_dir)
    .map((a) => a.config_dir as string);
}

/**
 * Installs (or reinstalls with a fresh token) the monitor hooks and records the install. Throws what
 * `installHooks` throws: an HttpError for the agent's own failures (offline, outdated, what the machine
 * reported), a plain Error with a pt-BR sentence for the ssh/local path.
 */
export async function installMachineHooksOn(repos: Repositories, machine: Machine): Promise<{ report: HookInstallReport; installed_at: string }> {
  const { token, hash } = newHookToken();
  const report = await installHooks(machine, token, config.hooksUrl, await claudeAccountDirs(repos, machine.id));
  const hook = await repos.machineHooks.upsert(machine.id, hash);
  return { report, installed_at: hook.installed_at };
}
