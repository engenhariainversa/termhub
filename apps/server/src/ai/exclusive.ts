import { recordEvent } from '../automation/events.js';
import { ControlError } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, AiProvider } from '../db/repositories/types.js';
import { msg } from '../i18n/index.js';

/**
 * TER-990: an AI account can be exclusive to one project (a client's or a company's login): it runs there
 * and nowhere else, whatever path starts, swaps, resumes or falls back to it. Every path asks `usableIn`;
 * a refused use is written to the exclusive project's automation events (`account_exclusive_blocked`) and
 * to the log, ids only.
 */

/** Which path tried to use the account (the audit's `path`). */
export type ExclusivePath = 'start_agent' | 'project_setup' | 'account_swap' | 'automation' | 'chat' | 'chat_host' | 'restart';

type Log = { warn: (obj: object, msg: string) => void };

/** Whether the account may run in that project (null: outside any project, like the account-wide chat). */
export function usableIn(account: Pick<AiAccount, 'exclusive_project'>, projectId: string | null): boolean {
  return !account.exclusive_project || account.exclusive_project.id === projectId;
}

/** The refusal every path answers with, in the caller's language. */
export function exclusiveError(account: Pick<AiAccount, 'label' | 'exclusive_project'>): ControlError {
  return new ControlError('ACCOUNT_EXCLUSIVE', msg('Conta exclusiva do projeto {{project}}: "{{account}}" não pode rodar em outro projeto', { project: account.exclusive_project?.name ?? '', account: account.label }));
}

/**
 * The account a run on `accountId` really uses: that row, or — with no account (`null`, the machine's own
 * login) — the machine's registered default login for the CLI (no config dir), whose exclusivity holds as
 * much as any other account's. Undefined when the default login is not registered.
 */
export function loginOf(accounts: AiAccount[], machineId: string, provider: AiProvider, accountId: string | null): AiAccount | undefined {
  if (accountId !== null) return accounts.find((a) => a.id === accountId);
  return accounts.find((a) => a.machine_id === machineId && a.provider === provider && a.config_dir === null);
}

/** Writes a refused use to the log and to the exclusive project's events. Never throws. */
export async function auditBlocked(
  repos: Partial<Pick<Repositories, 'automationEvents' | 'projects'>>,
  log: Log | undefined,
  account: Pick<AiAccount, 'id' | 'exclusive_project'>,
  attempt: { project_id: string | null; path: ExclusivePath; machine_id?: string | null; tab_id?: string | null },
): Promise<void> {
  const owner = account.exclusive_project;
  if (!owner) return;
  const ids = { accountId: account.id, exclusiveProjectId: owner.id, attemptedProjectId: attempt.project_id, path: attempt.path, machineId: attempt.machine_id ?? null, tabId: attempt.tab_id ?? null };
  (log ?? { warn: (o: object, m: string) => console.warn(m, o) }).warn(ids, 'exclusive account: use refused');
  if (!repos.automationEvents || !repos.projects) return;
  await recordEvent(repos as Repositories, {
    project_id: owner.id,
    kind: 'account_exclusive_blocked',
    payload: { account_id: account.id, attempted_project_id: attempt.project_id, path: attempt.path, machine_id: attempt.machine_id ?? null, tab_id: attempt.tab_id ?? null },
  }).catch(() => undefined);
}

/** Refuses (after the audit) a use of the account outside its exclusive project; nothing for any other account. */
export async function guardAccount(
  repos: Partial<Pick<Repositories, 'automationEvents' | 'projects'>>,
  log: Log | undefined,
  account: AiAccount,
  attempt: { project_id: string | null; path: ExclusivePath; machine_id?: string | null; tab_id?: string | null },
): Promise<void> {
  if (usableIn(account, attempt.project_id)) return;
  await auditBlocked(repos, log, account, attempt);
  throw exclusiveError(account);
}

/** Writes a change of the account's exclusivity to the events of the project it left and the one it joined. Never throws. */
export async function auditExclusiveChange(
  repos: Pick<Repositories, 'automationEvents' | 'projects'>,
  log: { info: (obj: object, msg: string) => void } | undefined,
  account: Pick<AiAccount, 'id'>,
  from: string | null,
  to: string | null,
  via: 'web' | 'mcp' | 'chat',
): Promise<void> {
  if (from === to) return;
  (log ?? { info: (o: object, m: string) => console.info(m, o) }).info({ accountId: account.id, from, to, via }, 'exclusive account: changed');
  const payload = { account_id: account.id, from_project_id: from, to_project_id: to, via };
  for (const project of new Set([from, to])) {
    if (project === null) continue;
    await recordEvent(repos as Repositories, { project_id: project, kind: 'account_exclusive_changed', payload }).catch(() => undefined);
  }
}
