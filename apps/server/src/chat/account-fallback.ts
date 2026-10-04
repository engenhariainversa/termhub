import { linkClaudeSession } from '../ai/claude-session.js';
import { getAccountUsage, type AiAccountUsage } from '../ai/index.js';
import { rankCandidates } from '../control/account-swap.js';
import { projectAccountsOn } from '../ai/project-accounts.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine } from '../db/repositories/types.js';

/**
 * When the account a chat runs on hits its usage limit, the turn is re-run on another Claude account of
 * the same machine (TER-588, spec 2026-09-30 chat usage limit §3). Nothing here is written to the
 * conversation: every run starts on the account it is configured for, and moves only when that one
 * answers with the limit.
 */

/** The machine's Claude accounts besides the one the run used (null: the machine's default login). */
async function otherAccounts(repos: Pick<Repositories, 'aiAccounts'>, machine: Machine, currentAccountId: string | null): Promise<AiAccount[]> {
  // Owner-scoped like the tab account swap: only accounts the machine's owner registered on it.
  const owned = await repos.aiAccounts.list(machine.owner_id);
  return owned.filter((a) => a.machine_id === machine.id && a.provider === 'claude' && a.id !== currentAccountId);
}

/**
 * The accounts to fall back to, best first: the machine's other Claude accounts not tried yet in this
 * run, with room left (under SWAP_MAX_UTILIZATION on a fresh reading; an unknown reading goes last).
 * `model`: what the run is on — a window that caps another model does not count (TER-837).
 * `projectId` is for TER-589, which orders a configured project's chat by the project's own priority.
 */
export async function fallbackCandidates(
  repos: Pick<Repositories, 'aiAccounts'> & Partial<Pick<Repositories, 'projectSetup' | 'projectMachines'>>,
  machine: Machine,
  currentAccountId: string | null,
  tried: ReadonlySet<string>,
  projectId: string | null,
  model: string | null = null,
): Promise<AiAccount[]> {
  const pool = (await otherAccounts(repos, machine, currentAccountId)).filter((a) => !tried.has(a.id));
  // A project that lists Claude accounts on this machine keeps its chat on them, in its order
  // (TER-589, spec 2026-09-30 project AI accounts §7.1); any other chat ranks by room, as before.
  let priority: string[] | undefined;
  if (projectId !== null && repos.projectSetup && repos.projectMachines) {
    const { listed } = await projectAccountsOn({ ...repos, projectSetup: repos.projectSetup, projectMachines: repos.projectMachines }, projectId, machine.owner_id, machine.id, 'claude');
    if (listed.length > 0) priority = listed.map((a) => a.id);
  }
  const usage = new Map<string, AiAccountUsage>();
  // getAccountUsage never rejects: a failed reading comes back as `ok: false` and ranks last
  await Promise.all(pool.map(async (a) => usage.set(a.id, await getAccountUsage(a, machine, true))));
  return rankCandidates(pool, usage, { explicit: false, priority, model });
}

/** Why no account could take over: there is none besides this one, or none has room left. */
export async function fallbackShortfall(repos: Pick<Repositories, 'aiAccounts'>, machine: Machine, currentAccountId: string | null): Promise<'no_other_account' | 'none_free'> {
  return (await otherAccounts(repos, machine, currentAccountId)).length === 0 ? 'no_other_account' : 'none_free';
}

/**
 * Makes the chat's CLI session resumable under `toConfigDir` (`claude.linkSession`, the same symlink the
 * tab swap makes). `sessionDir` is the run's `<config dir>/projects/<cwd slug>`, read from its `init`
 * frame: the server knows neither the machine's $HOME nor the runner's cwd. `resume`: linked (or the
 * link could not be attempted — a missing session then comes back as `missing_session` and is retried
 * fresh); `fresh`: nothing to move, start a new session there; `skip`: that account cannot take it.
 */
export async function linkChatSession(machine: Machine, input: { sessionDir: string; sessionId: string; toConfigDir: string | null }): Promise<'resume' | 'fresh' | 'skip'> {
  let status;
  try {
    status = await linkClaudeSession(machine, { transcriptPath: `${input.sessionDir}/${input.sessionId}.jsonl`, sessionId: input.sessionId, configDir: input.toConfigDir });
  } catch {
    return 'resume';
  }
  if (status === 'linked') return 'resume';
  // the same account under another name is as limited as the one that failed; a missing dir cannot run
  if (status === 'same_account' || status === 'no_config_dir') return 'skip';
  return 'fresh';
}

export interface FallbackPick {
  account: AiAccount;
  /** Resume the conversation's session there (false: a fresh session). */
  resume: boolean;
}

/**
 * The account the turn is re-run on, with its session moved there, or null when none is left. Every
 * account looked at is added to `tried`, so a run never tries one twice (no ping-pong between two
 * exhausted accounts).
 */
export async function pickFallback(
  repos: Pick<Repositories, 'aiAccounts'> & Partial<Pick<Repositories, 'projectSetup' | 'projectMachines'>>,
  input: { machine: Machine; currentAccountId: string | null; tried: Set<string>; projectId: string | null; sessionDir: string | null; sessionId: string | null; model?: string | null },
): Promise<FallbackPick | null> {
  const candidates = await fallbackCandidates(repos, input.machine, input.currentAccountId, input.tried, input.projectId, input.model ?? null);
  for (const account of candidates) {
    input.tried.add(account.id);
    if (!input.sessionId) return { account, resume: false };
    if (!input.sessionDir) return { account, resume: true };
    const moved = await linkChatSession(input.machine, { sessionDir: input.sessionDir, sessionId: input.sessionId, toConfigDir: account.config_dir });
    if (moved === 'skip') continue;
    return { account, resume: moved === 'resume' };
  }
  return null;
}
