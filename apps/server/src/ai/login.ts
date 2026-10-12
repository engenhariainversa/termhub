import { randomBytes } from 'node:crypto';
import { AI_LOGIN_HINTS } from '@termhub/machine-ops';
import { CAPABILITY_AI_LOGIN } from '@termhub/agent-protocol';
import { agentRpc, requireAiLoginCapable } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import { captureScreen } from '../agent/screen.js';
import { AI_LOGIN_SESSION_PREFIX } from '../terminal/machine-exec.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, AiProvider, Machine, Tab } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { msg } from '../i18n/index.js';
import { forgetAccountUsage } from './index.js';

/**
 * Redoing an AI CLI login from the web, the app or the chat (TER-1047, spec
 * 2026-10-08-ai-cli-login-modal-design). Everything here lives in this process's memory: the login state
 * of each account (`ok` / `login_required`, 5 min cache) and the open login flows (one hidden tmux session
 * `termhub-login-<loginId>` on the machine, 15 min). A deploy in the middle of a flow loses it; the person
 * starts again. The code the person pastes, the login URL and Codex's device code are never logged: only ids.
 */

export type AiLoginState = 'ok' | 'login_required' | 'unknown';

/** Providers whose CLI login the agent can drive. */
export const AI_LOGIN_PROVIDERS: readonly AiProvider[] = ['claude', 'chatgpt'];

export { AI_LOGIN_SESSION_PREFIX };
export const isAiLoginSession = (name: string): boolean => name.startsWith(AI_LOGIN_SESSION_PREFIX);

export const LOGIN_STATE_TTL_MS = 5 * 60_000;
/** A manual refresh still does not ask the machine more often than this. */
const MIN_REFRESH_MS = 15_000;
export const LOGIN_FLOW_TTL_MS = 15 * 60_000;
const FLOW_SWEEP_MS = 60_000;
/** Screen lines read from a tab to tell whether it is stuck on a login error. */
const STUCK_SCREEN_LINES = 40;
const STUCK_CONCURRENCY = 4;
/** What Claude Code and Codex print when their login is gone. */
export const STUCK_LOGIN_RE = /Please run \/login|Login expired|Not logged in|OAuth token (has )?expired|authentication_failed/i;

export interface LoginFlow {
  loginId: string;
  accountId: string;
  machineId: string;
  userId: string;
  provider: AiProvider;
  configDir: string | null;
  session: string;
  needsCode: boolean;
  expiresAt: number;
}

export interface StartedLogin {
  login_id: string;
  url: string;
  user_code: string | null;
  needs_code: boolean;
  expires_at: string;
}

export interface StuckTab {
  id: string;
  name: string;
  project_id: string;
}

export interface SubmittedLogin {
  ok: boolean;
  message: string | null;
  stuck_tabs: StuckTab[];
}

/** Runs `fn` over `items`, at most `limit` at a time. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The agent of this machine is online and can run `ai.login.*`, and the account's provider has a CLI login it drives. */
export function aiLoginSupported(account: Pick<AiAccount, 'provider'>, machine: Pick<Machine, 'id' | 'type'> | undefined): boolean {
  if (!machine || machine.type !== 'agent' || !AI_LOGIN_PROVIDERS.includes(account.provider)) return false;
  return agents.isOnline(machine.id) && (agents.capabilities(machine.id) ?? []).includes(CAPABILITY_AI_LOGIN);
}

const notFoundFlow = () => new HttpError(404, msg('Login não encontrado ou expirado'), 'LOGIN_NOT_FOUND');

export class AiLoginService {
  private readonly states = new Map<string, { state: 'ok' | 'login_required'; checked_at: number }>();
  private readonly flows = new Map<string, LoginFlow>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The last known login state of an account; `unknown` when it was never checked here. */
  loginStatusOf(accountId: string): { state: AiLoginState; checked_at: string | null } {
    const s = this.states.get(accountId);
    return s ? { state: s.state, checked_at: new Date(s.checked_at).toISOString() } : { state: 'unknown', checked_at: null };
  }

  /** Something else saw the login gone (a tab's `auth_required`, TER-1046): the same entry point. */
  markLoginRequired(accountId: string): void {
    this.states.set(accountId, { state: 'login_required', checked_at: this.now() });
  }

  /** The account is gone (deleted): its state and any open flow go too. */
  forget(accountId: string): void {
    this.states.delete(accountId);
    for (const flow of this.flows.values()) if (flow.accountId === accountId) this.drop(flow, true);
  }

  /**
   * Asks the machine whether the account's CLI is logged in (`ai.login.status`), cached LOGIN_STATE_TTL_MS
   * (`refresh`: MIN_REFRESH_MS). A machine that cannot answer (no agent, offline, outdated, a provider
   * without a CLI login) is never asked: the known state stays. A failed call keeps it too.
   */
  async checkAccountLogin(account: AiAccount, machine: Machine | undefined, refresh = false): Promise<AiLoginState> {
    const known = this.states.get(account.id);
    if (!machine || !aiLoginSupported(account, machine)) return known?.state ?? 'unknown';
    if (known && this.now() - known.checked_at < (refresh ? MIN_REFRESH_MS : LOGIN_STATE_TTL_MS)) return known.state;
    try {
      const r = await agents.rpc(machine.id, 'ai.login.status', { provider: account.provider, config_dir: account.config_dir });
      if (!r.supported) return known?.state ?? 'unknown';
      const state = r.logged_in ? 'ok' : 'login_required';
      this.states.set(account.id, { state, checked_at: this.now() });
      return state;
    } catch {
      return known?.state ?? 'unknown';
    }
  }

  /**
   * Starts the CLI's login in a hidden tmux session on the account's machine and answers what the person
   * needs to finish it in a browser. One flow per account: a new one cancels the previous.
   */
  async startLogin(account: AiAccount, machine: Machine, userId: string): Promise<StartedLogin> {
    if (machine.type !== 'agent') requireAiLoginCapable(machine); // 400 UNSUPPORTED_MACHINE
    if (!AI_LOGIN_PROVIDERS.includes(account.provider)) {
      throw new HttpError(
        400,
        msg('Refazer login pela tela só funciona com Claude e Codex. Faça o login na própria máquina: {{hint}}', { hint: AI_LOGIN_HINTS[account.provider] }),
        'UNSUPPORTED_PROVIDER',
      );
    }
    // A moving agent (a deploy) gets a few seconds to attach before the capability check reads it as offline.
    await agents.awaitAgent(machine);
    requireAiLoginCapable(machine);
    for (const flow of this.flows.values()) if (flow.accountId === account.id) this.drop(flow, true);
    this.startSweeper();

    const loginId = randomBytes(12).toString('hex');
    const session = `${AI_LOGIN_SESSION_PREFIX}${loginId}`;
    const r = await agentRpc(machine, 'ai.login.start', { provider: account.provider, config_dir: account.config_dir, session });
    const flow: LoginFlow = {
      loginId,
      accountId: account.id,
      machineId: machine.id,
      userId,
      provider: account.provider,
      configDir: account.config_dir,
      session,
      needsCode: r.needs_code,
      expiresAt: this.now() + LOGIN_FLOW_TTL_MS,
    };
    this.flows.set(loginId, flow);
    return { login_id: loginId, url: r.url, user_code: r.user_code, needs_code: r.needs_code, expires_at: new Date(flow.expiresAt).toISOString() };
  }

  /** The live flow `loginId` of this user (and, when given, of this account); 404 otherwise, expired included. */
  flowOf(loginId: string, userId: string, accountId?: string): LoginFlow {
    const flow = this.flows.get(loginId);
    if (!flow || flow.userId !== userId || (accountId !== undefined && flow.accountId !== accountId)) throw notFoundFlow();
    if (flow.expiresAt <= this.now()) {
      this.drop(flow, true);
      throw notFoundFlow();
    }
    return flow;
  }

  /**
   * Sends the pasted code (Claude) or just waits for the browser authorization (Codex, `code` null) and
   * answers whether the CLI is logged in now. On success the account's state becomes `ok`, its usage cache
   * is dropped and the answer lists the tabs still stuck on the login error. A Claude failure ends the flow
   * (the agent killed the session); a Codex timeout keeps it, so the person can try again.
   */
  async submitLogin(repos: Repositories, loginId: string, userId: string, code: string | null, accountId?: string): Promise<SubmittedLogin> {
    const flow = this.flowOf(loginId, userId, accountId);
    if (flow.needsCode && !code) throw new HttpError(400, msg('Cole o código mostrado na página de login'), 'CODE_REQUIRED');
    const [account, machine] = await Promise.all([repos.aiAccounts.findById(flow.accountId), repos.machines.findById(flow.machineId)]);
    if (!account || !machine) {
      this.drop(flow, false);
      throw notFoundFlow();
    }
    const r = await agentRpc(machine, 'ai.login.submit', { provider: flow.provider, config_dir: flow.configDir, session: flow.session, code: flow.needsCode ? code : null });
    if (!r.logged_in) {
      if (flow.provider === 'claude') this.flows.delete(flow.loginId);
      return { ok: false, message: r.message, stuck_tabs: [] };
    }
    this.flows.delete(flow.loginId);
    this.states.set(account.id, { state: 'ok', checked_at: this.now() });
    forgetAccountUsage(account.id);
    return { ok: true, message: null, stuck_tabs: await this.findStuckTabs(repos, account, machine) };
  }

  /** Ends the flow and kills its hidden session. */
  async cancelLogin(loginId: string, userId: string, accountId?: string): Promise<void> {
    const flow = this.flowOf(loginId, userId, accountId);
    this.flows.delete(flow.loginId);
    await this.killSession(flow);
  }

  /**
   * Terminal tabs running on this account (the tab's `ai_account_id`, or, for the machine's default login,
   * a tab of that machine with no account recorded) whose screen shows a login error. A tab that cannot be
   * read is skipped.
   */
  async findStuckTabs(repos: Repositories, account: AiAccount, machine: Machine): Promise<StuckTab[]> {
    const tabs = (await repos.tabs.listByMachine(account.machine_id)).filter(
      (t): t is Tab & { tmux_session: string } =>
        t.kind === 'terminal' && !!t.tmux_session && (t.ai_account_id === account.id || (account.config_dir === null && t.ai_account_id === null && t.machine_id === account.machine_id)),
    );
    const stuck = await mapBounded(tabs, STUCK_CONCURRENCY, async (t) => {
      try {
        return STUCK_LOGIN_RE.test(await captureScreen(machine, t.tmux_session, STUCK_SCREEN_LINES)) ? t : null;
      } catch {
        return null;
      }
    });
    return stuck.filter((t): t is NonNullable<typeof t> => t !== null).map((t) => ({ id: t.id, name: t.name, project_id: t.project_id }));
  }

  /** Every 60 s, flows past their 15 minutes are cancelled (their hidden session killed). */
  startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), FLOW_SWEEP_MS);
    this.sweeper.unref();
  }

  sweep(): void {
    const now = this.now();
    for (const flow of [...this.flows.values()]) if (flow.expiresAt <= now) this.drop(flow, true);
  }

  /** Stops the sweeper and forgets every flow and state (server close, tests). Sessions are left to expire on the machine. */
  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.flows.clear();
    this.states.clear();
  }

  /** Open flows (tests). */
  get openFlows(): number {
    return this.flows.size;
  }

  private drop(flow: LoginFlow, kill: boolean): void {
    this.flows.delete(flow.loginId);
    if (kill) void this.killSession(flow);
  }

  private async killSession(flow: LoginFlow): Promise<void> {
    try {
      await agents.rpc(flow.machineId, 'ai.login.cancel', { session: flow.session });
    } catch {
      // offline or already gone: nothing to clean up from here
    }
  }
}

/** The process's one service: routes, the MCP tools and the background check share it. */
export const aiLogin = new AiLoginService();
