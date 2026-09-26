import type { FastifyBaseLogger } from 'fastify';
import { agents } from '../agent/registry.js';
import { linkClaudeSession } from '../ai/claude-session.js';
import { getAccountUsage, type AiAccountUsage } from '../ai/index.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import { applyState } from '../monitor/ingest.js';
import { sendKeyToSession, sendTextToSession } from '../terminal/session-ops.js';
import { RESUME_PROMPT, resumeLine } from './agents.js';
import { ControlError } from './context.js';
import { offline } from './screen.js';

/** An account whose fullest window is at this utilization (0..100) or more is not a candidate. */
export const SWAP_MAX_UTILIZATION = 90;
/** How long the waiting Claude gets to end after `/exit` (its SessionEnd hook turns the tab idle). */
export const EXIT_WAIT_MS = 15_000;
/** And after the two `C-c` that follow, before the swap gives up. */
export const EXIT_FORCE_WAIT_MS = 10_000;

export interface SwapResult {
  from: { id: string; label: string } | null;
  to: { id: string; label: string };
}

/** The fullest window of the account, 0..100; null when the usage could not be read. */
export function peakUtilization(u: AiAccountUsage | undefined): number | null {
  if (!u || !u.ok || u.windows.length === 0) return null;
  return Math.max(...u.windows.map((w) => w.utilization));
}

/**
 * Most room first (lowest peak); accounts at SWAP_MAX_UTILIZATION or more are dropped unless the person
 * picked one; unknown usage goes last. Stable: ties keep the list order.
 */
export function rankCandidates(accounts: AiAccount[], usage: Map<string, AiAccountUsage>, opts: { explicit: boolean }): AiAccount[] {
  const scored = accounts.map((a, i) => ({ a, i, peak: peakUtilization(usage.get(a.id)) }));
  return scored
    .filter((s) => opts.explicit || s.peak === null || s.peak < SWAP_MAX_UTILIZATION)
    .sort((x, y) => (x.peak === null ? 1 : 0) - (y.peak === null ? 1 : 0) || (x.peak ?? 0) - (y.peak ?? 0) || x.i - y.i)
    .map((s) => s.a);
}

/** Tabs with a swap running: one at a time per tab (in-process, like the monitor bus). */
const swapping = new Set<string>();

/** Resolves true once the tab reports `idle` (Claude's SessionEnd), false after `ms`. */
function waitUntilIdle(repos: Repositories, tabId: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(v);
    };
    const unsubscribe = monitorBus.subscribe((c) => {
      if (c.tab.id === tabId && c.tab.state === 'idle') finish(true);
    });
    const timer = setTimeout(() => finish(false), ms);
    // it may have gone idle between the caller's read and the subscription
    void repos.tabs.findById(tabId).then(
      (t) => {
        if (t?.state === 'idle') finish(true);
      },
      () => undefined,
    );
  });
}

/**
 * Moves the tab's Claude session to another Claude account of the same machine and resumes it there
 * (spec 2026-09-26 account swap §4.4). Nothing is typed into the tab before an account is linked, and
 * nothing on the machine is overwritten or deleted. Logs ids only.
 */
export async function swapAccount(
  repos: Repositories,
  log: FastifyBaseLogger,
  tab: Tab,
  machine: Machine,
  opts: { accountId?: string; auto: boolean },
): Promise<SwapResult> {
  if (tab.kind !== 'terminal' || !tab.tmux_session) throw new ControlError('NOT_A_TERMINAL', 'Esta aba não é um terminal');
  const session = tab.tmux_session;
  const sessionId = tab.agent_session_id;
  const transcriptPath = tab.agent_transcript_path;
  if (!sessionId || !transcriptPath) {
    throw new ControlError('NO_SESSION', 'O termhub não sabe qual sessão do Claude roda nesta aba (os hooks da máquina estão instalados?)');
  }
  if (machine.type === 'agent' && !agents.isOnline(machine.id)) throw offline();
  if (!machine.capabilities.includes('claude')) throw new ControlError('TOOL_MISSING', `claude não foi detectado em ${machine.name}`);
  if (swapping.has(tab.id)) throw new ControlError('SWAP_IN_PROGRESS', 'Já existe uma troca de conta em andamento nesta aba');
  swapping.add(tab.id);
  try {
    const owned = await repos.aiAccounts.list(machine.owner_id);
    const here = owned.filter((a) => a.machine_id === machine.id && a.provider === 'claude');
    const from = here.find((a) => a.id === tab.ai_account_id) ?? null;
    let pool: AiAccount[];
    if (opts.accountId) {
      const chosen = owned.find((a) => a.id === opts.accountId);
      if (!chosen) throw new ControlError('ACCOUNT_NOT_FOUND', 'Conta não encontrada');
      if (chosen.machine_id !== machine.id) throw new ControlError('ACCOUNT_OTHER_MACHINE', `A conta "${chosen.label}" é de outra máquina`);
      if (chosen.provider !== 'claude') throw new ControlError('PROVIDER_UNSUPPORTED', 'Só contas do Claude podem assumir esta sessão');
      if (chosen.id === tab.ai_account_id) throw new ControlError('SAME_ACCOUNT', 'Esta aba já roda nessa conta');
      pool = [chosen];
    } else {
      pool = here.filter((a) => a.id !== tab.ai_account_id);
    }
    // getAccountUsage never rejects: a failed reading comes back as `ok: false` and ranks last
    const usage = new Map<string, AiAccountUsage>();
    await Promise.all(pool.map(async (a) => usage.set(a.id, await getAccountUsage(a, machine, true))));
    const ranked = rankCandidates(pool, usage, { explicit: !!opts.accountId });

    // Link before touching the tab: a candidate that is the current account under another name
    // (same_account) or whose dir already holds something else (conflict) is skipped.
    let to: AiAccount | null = null;
    for (const candidate of ranked) {
      const status = await linkClaudeSession(machine, { transcriptPath, sessionId, configDir: candidate.config_dir });
      log.info({ tabId: tab.id, machineId: machine.id, accountId: candidate.id, status }, 'account swap: link');
      if (status === 'linked') {
        to = candidate;
        break;
      }
    }
    if (!to) throw new ControlError('NO_CANDIDATE', 'Nenhuma outra conta do Claude desta máquina tem limite disponível');

    // Claude waits for the reset on a usage limit (it does not exit): cancel that wait and leave.
    // Already idle means it ended on its own: the tab is at the shell and must not get these keys.
    const current = (await repos.tabs.findById(tab.id)) ?? tab;
    if (current.state !== 'idle') {
      await sendKeyToSession(machine, session, 'Escape');
      await sendTextToSession(machine, session, '/exit', true);
      if (!(await waitUntilIdle(repos, tab.id, EXIT_WAIT_MS))) {
        await sendKeyToSession(machine, session, 'C-c');
        await sendKeyToSession(machine, session, 'C-c');
        if (!(await waitUntilIdle(repos, tab.id, EXIT_FORCE_WAIT_MS))) {
          throw new ControlError('EXIT_TIMEOUT', 'O Claude desta aba não encerrou; veja a tela e tente de novo');
        }
      }
    }
    await sendTextToSession(machine, session, resumeLine(to.config_dir, sessionId, RESUME_PROMPT), true);

    const updated = (await repos.tabs.setAgentFields(tab.id, { ai_account_id: to.id, rate_limited_at: null })) ?? tab;
    const text = `${opts.auto ? 'Conta trocada automaticamente' : 'Conta trocada'}: ${from?.label ?? 'conta desconhecida'} → ${to.label}`;
    await applyState(repos, log, updated, 'claude', { kind: 'working', text, meta: { event: 'AccountSwap', from: from?.id ?? null, to: to.id, auto: opts.auto } });
    log.info({ tabId: tab.id, machineId: machine.id, from: from?.id ?? null, to: to.id, auto: opts.auto }, 'account swap: done');
    return { from: from && { id: from.id, label: from.label }, to: { id: to.id, label: to.label } };
  } finally {
    swapping.delete(tab.id);
  }
}

/**
 * Moves a tab's Claude to another account of the same machine after a usage limit (spec 2026-09-26
 * account swap). Still a no-op: monitor/ingest.ts calls this on every `rate_limit` StopFailure, and
 * the automatic trigger (machine opt-in, then `swapAccount`) lands in Task 6.
 */
export function autoSwapOnLimit(_repos: Repositories, _log: FastifyBaseLogger, _tab: Tab): void {}
