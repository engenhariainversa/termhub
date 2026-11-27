import { aiLogin, aiLoginSupported, mapBounded, type AiLoginState, type StartedLogin, type SubmittedLogin } from '../ai/login.js';
import { daysLeft, expiresSoon, warnDaysOf } from '../ai/login-expiry.js';
import { accountsInUse } from '../ai/account-use.js';
import { forgetAccountUsage } from '../ai/index.js';
import type { AiAccount, AiProvider, Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { msg } from '../i18n/index.js';
import { ControlError, type ControlContext } from './context.js';
import { sendInput } from './terminals.js';

/**
 * Redoing an AI CLI login (TER-1047): what the web routes, the app's routes and the MCP tools share. The
 * account goes through the scope (404 outside it), and only the machine's owner may start or continue a
 * flow — an admin viewing as someone else cannot, and an agent tab's token never can.
 */

const CHECK_CONCURRENCY = 4;
export const RESUME_MAX_TABS = 50;

export interface AiLoginStatusRow {
  account_id: string;
  label: string;
  provider: AiProvider;
  machine_id: string;
  machine_name: string | null;
  state: AiLoginState;
  checked_at: string | null;
  supported: boolean;
  /** TER-1079: when the CLI's login expires, as its own notice told; null = unknown */
  login_expires_at: string | null;
  /** still logged in, and expiring within the person's window (`warn_days`) */
  expires_soon: boolean;
  /** whole days left, rounded up; null when unknown */
  expires_in_days: number | null;
  /**
   * TER-1212: a project's Setup lists the account, or the chat runs on it (`accountsInUse`). The banners
   * leave an account nobody uses aside; Contas de IA still shows its state.
   */
  in_use: boolean;
  /** TER-1212: the person dismissed its "login expired" banner, and the login was not seen working since. */
  dismissed: boolean;
}

/** What the screens and the tools show of an account's coming expiry. A login already gone is not "soon". */
export function loginExpiryOf(account: Pick<AiAccount, 'id' | 'login_expires_at'>, now: Date, warnDays: number): Pick<AiLoginStatusRow, 'login_expires_at' | 'expires_soon' | 'expires_in_days'> {
  const gone = aiLogin.loginStatusOf(account.id).state === 'login_required';
  const days = gone ? null : daysLeft(account.login_expires_at, now);
  return { login_expires_at: days === null ? null : account.login_expires_at, expires_soon: !gone && expiresSoon(account.login_expires_at, now, warnDays), expires_in_days: days };
}

/** The account and its machine, when the caller is the machine's owner (a person, not an agent tab). */
async function ownAccount(ctx: ControlContext, accountId: string): Promise<{ account: AiAccount; machine: Machine }> {
  if (ctx.token?.tab) throw new ControlError('FORBIDDEN', msg('Só a pessoa refaz o login de uma conta de IA, nunca um agente numa aba'));
  const { account, machine } = await ctx.scoped.aiAccount(accountId);
  if (machine.owner_id !== ctx.scope.user.id) throw new HttpError(403, msg('Só a dona da máquina pode refazer o login'), 'FORBIDDEN');
  return { account, machine };
}

/** The login state of every account in scope; `refresh` asks the machines again (bounded). */
export async function aiLoginStatus(ctx: ControlContext, refresh: boolean): Promise<{ accounts: AiLoginStatusRow[]; warn_days: number }> {
  const [accounts, machines, warnDays] = await Promise.all([ctx.repos.aiAccounts.list(ctx.scope.ownerId), ctx.repos.machines.list(ctx.scope.ownerId), loginWarnDays(ctx)]);
  const byId = new Map(machines.map((m) => [m.id, m]));
  if (refresh) await mapBounded(accounts, CHECK_CONCURRENCY, (a) => aiLogin.checkAccountLogin(a, byId.get(a.machine_id), true));
  const now = new Date();
  const [inUse, working] = await Promise.all([accountsInUse(ctx.repos, accounts, machines), settleDismissals(ctx, accounts)]);
  return {
    warn_days: warnDays,
    accounts: accounts.map((a) => {
      const machine = byId.get(a.machine_id);
      return {
        in_use: inUse.has(a.id),
        dismissed: !!a.login_warning_dismissed_at && !working.has(a.id),
        account_id: a.id,
        label: a.label,
        provider: a.provider,
        machine_id: a.machine_id,
        machine_name: machine?.name ?? null,
        ...aiLogin.loginStatusOf(a.id),
        supported: aiLoginSupported(a, machine),
        ...loginExpiryOf(a, now, warnDays),
      };
    }),
  };
}

/**
 * A dismissed banner whose login is seen working again is re-armed (TER-1212): the next time that login
 * expires, the warning shows. Answers the accounts it re-armed; a failed write only waits for the next read.
 */
async function settleDismissals(ctx: ControlContext, accounts: AiAccount[]): Promise<Set<string>> {
  const working = accounts.filter((a) => a.login_warning_dismissed_at && aiLogin.loginStatusOf(a.id).state === 'ok').map((a) => a.id);
  await ctx.repos.aiAccounts.clearLoginWarningDismissal(working).catch(() => undefined);
  return new Set(working);
}

/** The person hides an account's "login expired" banner (TER-1212), on every screen, until the login works again. */
export async function dismissAiLoginWarning(ctx: ControlContext, input: { account_id: string }): Promise<{ dismissed: true }> {
  if (ctx.token?.tab) throw new ControlError('FORBIDDEN', msg('Só a pessoa dispensa o aviso de login de uma conta de IA, nunca um agente numa aba'));
  const { account, machine } = await ctx.scoped.aiAccount(input.account_id);
  await ctx.repos.aiAccounts.dismissLoginWarning(account.id, new Date());
  ctx.log?.info({ accountId: account.id, machineId: machine.id }, 'ai login warning dismissed');
  return { dismissed: true };
}

/**
 * Removes an AI account from termhub (TER-1212, the app's "Remover conta"; the web's Contas de IA has its
 * own route): only the record — the CLI's login on the machine stays as it is.
 */
export async function removeAiAccount(ctx: ControlContext, input: { account_id: string }): Promise<{ ok: true }> {
  if (ctx.token?.tab) throw new ControlError('FORBIDDEN', msg('Só a pessoa remove uma conta de IA, nunca um agente numa aba'));
  const { account, machine } = await ctx.scoped.aiAccount(input.account_id);
  await ctx.repos.aiAccounts.delete(account.id);
  forgetAccountUsage(account.id);
  aiLogin.forget(account.id);
  ctx.log?.info({ accountId: account.id, machineId: machine.id }, 'ai account removed');
  return { ok: true };
}

/** The caller's own window (their setting or the default): what "soon" means on their screens and tools. */
export async function loginWarnDays(ctx: ControlContext): Promise<number> {
  return warnDaysOf(await ctx.repos.users.aiLoginWarnDays(ctx.scope.user.id));
}

/** The person's own window, in days (0 = never warn). Their own setting only: not an agent tab's to change. */
export async function setLoginWarnDays(ctx: ControlContext, days: number): Promise<{ warn_days: number }> {
  if (ctx.token?.tab) throw new ControlError('FORBIDDEN', msg('Só a pessoa muda o aviso de login das contas de IA, nunca um agente numa aba'));
  const value = warnDaysOf(days);
  await ctx.repos.users.setAiLoginWarnDays(ctx.scope.user.id, value);
  return { warn_days: value };
}

export async function startAiLogin(ctx: ControlContext, input: { account_id: string }): Promise<StartedLogin> {
  const { account, machine } = await ownAccount(ctx, input.account_id);
  const started = await aiLogin.startLogin(ctx.repos, account, machine, ctx.scope.user.id);
  ctx.log?.info({ accountId: account.id, machineId: machine.id, loginId: started.login_id, loggedIn: started.logged_in }, started.logged_in ? 'ai login finished on the machine' : 'ai login started');
  return started;
}

/**
 * `account_id` given (the routes): the flow must be that account's. Without it (the MCP tool, which only
 * knows the login id) the flow's own account is checked the same way.
 */
export async function submitAiLogin(ctx: ControlContext, input: { login_id: string; code: string | null; account_id?: string }): Promise<SubmittedLogin> {
  const flow = aiLogin.flowOf(input.login_id, ctx.scope.user.id, input.account_id);
  await ownAccount(ctx, flow.accountId);
  const result = await aiLogin.submitLogin(ctx.repos, input.login_id, ctx.scope.user.id, input.code, flow.accountId);
  ctx.log?.info({ accountId: flow.accountId, machineId: flow.machineId, loginId: flow.loginId, ok: result.ok, stuck: result.stuck_tabs.length }, 'ai login submitted');
  return result;
}

/**
 * Ends the flow, then asks the machine again: the person may have closed the modal because they finished
 * the login in the machine's own browser (TER-1054), and the warning should go with it.
 */
export async function cancelAiLogin(ctx: ControlContext, input: { login_id: string; account_id: string }): Promise<{ cancelled: true }> {
  const { account, machine } = await ownAccount(ctx, input.account_id);
  await aiLogin.cancelLogin(input.login_id, ctx.scope.user.id, input.account_id);
  await aiLogin.checkAccountLogin(account, machine, 'force');
  return { cancelled: true };
}

/** Types `continue` into each of `tab_ids` that is still stuck on this account's login error; the rest are skipped. */
export async function resumeAiLoginTabs(ctx: ControlContext, input: { account_id: string; tab_ids: string[] }): Promise<{ resumed: string[] }> {
  const { account, machine } = await ownAccount(ctx, input.account_id);
  // Typing into a tab is a terminal write, whatever grant reached this route.
  if (!(await ctx.can('terminals', 'write'))) throw new HttpError(403, msg('Sem permissão para escrever nas abas'), 'FORBIDDEN');
  const wanted = new Set(input.tab_ids.slice(0, RESUME_MAX_TABS));
  if (wanted.size === 0) return { resumed: [] };
  const stuck = (await aiLogin.findStuckTabs(ctx.repos, account, machine)).filter((t) => wanted.has(t.id));
  const resumed: string[] = [];
  for (const tab of stuck) {
    try {
      await sendInput(ctx, { tab_id: tab.id, text: 'continue' });
      resumed.push(tab.id);
    } catch (err) {
      ctx.log?.warn({ accountId: account.id, tabId: tab.id, code: (err as { code?: string }).code ?? 'ERROR' }, 'ai login: resuming a tab failed');
    }
  }
  return { resumed };
}
