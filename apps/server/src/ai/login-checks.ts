import type { FastifyBaseLogger } from 'fastify';
import { agents } from '../agent/registry.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiProvider } from '../db/repositories/types.js';
import { aiLogin, aiLoginSupported, mapBounded, type AiLoginService } from './login.js';

/** How often every account of an online agent machine is checked. */
export const LOGIN_CHECK_INTERVAL_MS = 10 * 60_000;
/** After an agent connects, its accounts are checked this long later (it settles first). */
const ONLINE_CHECK_DELAY_MS = 30_000;
/** The first pass waits this long plus a random share of it, so two colours booting together do not ask at once. */
const FIRST_CHECK_MS = 60_000;
const CHECK_CONCURRENCY = 4;

export type LoginRequiredPush = (userId: string, info: { accountId: string; machineName: string; provider: AiProvider }) => Promise<void>;

export interface LoginCheckDeps {
  repos: Pick<Repositories, 'aiAccounts' | 'machines'>;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  push?: LoginRequiredPush;
  service?: AiLoginService;
}

/**
 * The background login check (TER-1047): every account of an online agent machine with `ai_login` is
 * checked; when one is found logged out, the machine's owner gets one push, and no other until the login
 * is back. The "already told" set is in memory: after a restart an account still logged out is pushed once
 * more, which is the moment the warning is wanted anyway.
 */
export class LoginChecker {
  private readonly notified = new Set<string>();
  private running = false;

  constructor(private readonly deps: LoginCheckDeps) {}

  private get service(): AiLoginService {
    return this.deps.service ?? aiLogin;
  }

  /** One pass, over every machine or only `machineId`. Never throws; logs ids only. */
  async run(machineId?: string): Promise<void> {
    if (this.running && !machineId) return;
    if (!machineId) this.running = true;
    try {
      const machines = (await this.deps.repos.machines.list(null)).filter((m) => m.type === 'agent' && (!machineId || m.id === machineId));
      const byId = new Map(machines.map((m) => [m.id, m]));
      const accounts = (await this.deps.repos.aiAccounts.list(null)).filter((a) => aiLoginSupported(a, byId.get(a.machine_id)));
      await mapBounded(accounts, CHECK_CONCURRENCY, async (account) => {
        const machine = byId.get(account.machine_id)!;
        const state = await this.service.checkAccountLogin(account, machine);
        if (state === 'ok') this.notified.delete(account.id);
        if (state !== 'login_required' || this.notified.has(account.id) || !machine.owner_id) return;
        this.notified.add(account.id);
        this.deps.log.info({ accountId: account.id, machineId: machine.id }, 'ai login required');
        await this.deps.push?.(machine.owner_id, { accountId: account.id, machineName: machine.name, provider: account.provider }).catch((err: unknown) =>
          this.deps.log.warn({ accountId: account.id, code: (err as { code?: string }).code ?? 'ERROR' }, 'ai login push failed'),
        );
      });
    } catch (err) {
      this.deps.log.warn({ code: (err as { code?: string }).code ?? 'ERROR' }, 'ai login check failed');
    } finally {
      if (!machineId) this.running = false;
    }
  }
}

/** Starts the periodic check and the check after an agent connects; returns the stop. */
export function startAiLoginChecks(deps: LoginCheckDeps, opts: { intervalMs?: number } = {}): () => void {
  const checker = new LoginChecker(deps);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timer.unref();
    timers.add(timer);
  };
  const interval = setInterval(() => void checker.run(), opts.intervalMs ?? LOGIN_CHECK_INTERVAL_MS);
  interval.unref();
  later(FIRST_CHECK_MS + Math.floor(Math.random() * FIRST_CHECK_MS), () => void checker.run());
  const onOnline = (machineId: string) => later(ONLINE_CHECK_DELAY_MS, () => void checker.run(machineId));
  agents.on('online', onOnline);
  (deps.service ?? aiLogin).startSweeper();
  return () => {
    clearInterval(interval);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    agents.off('online', onOnline);
    (deps.service ?? aiLogin).stop();
  };
}
