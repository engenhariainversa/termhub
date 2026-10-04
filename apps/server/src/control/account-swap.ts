import type { FastifyBaseLogger } from 'fastify';
import { agents } from '../agent/registry.js';
import { linkClaudeSession } from '../ai/claude-session.js';
import { getAccountUsage, type AiAccountUsage } from '../ai/index.js';
import type { AiUsageWindow } from '../ai/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import { applyState } from '../monitor/ingest.js';
import { sendKeyToSession, sendTextToSession } from '../terminal/session-ops.js';
import { RESUME_PROMPT, resumeLine } from './agents.js';
import { projectAccountsOn } from '../ai/project-accounts.js';
import { notifyLimitInChat } from '../chat/tab-limits.js';
import { ControlError } from './context.js';
import { offline } from './screen.js';

/** An account whose fullest window is at this utilization (0..100) or more is not a candidate. */
export const SWAP_MAX_UTILIZATION = 90;
/** How long the waiting Claude gets to end after `/exit` (its SessionEnd hook turns the tab idle). */
export const EXIT_WAIT_MS = 15_000;
/** And after the two `C-c` that follow, before the swap gives up. */
export const EXIT_FORCE_WAIT_MS = 10_000;
/**
 * Between Escape and `/exit`: sent back to back, Claude's input parser can read `\x1b/` as Alt+/ and
 * then submit "exit" as a prompt.
 */
export const ESCAPE_PAUSE_MS = 400;
/** After SessionEnd turns the tab idle, Claude may still own the tty for a moment: let the shell take it back. */
export const RESUME_SETTLE_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SwapResult {
  from: { id: string; label: string } | null;
  to: { id: string; label: string };
}

/**
 * Whether a usage window limits a run on `model` (an alias or id, e.g. "opus", "claude-opus-5-5"). A window
 * that caps one model (the weekly Fable allowance) does not stop a run on another one; with the model
 * unknown (null: the CLI's own default) every window counts, as a full one may be the one it runs on.
 */
export function windowLimits(w: AiUsageWindow, model: string | null | undefined): boolean {
  return !w.model || !model || model.toLowerCase().includes(w.model);
}

/** The fullest window of the account that limits `model`, 0..100; null when the usage could not be read. */
export function peakUtilization(u: AiAccountUsage | undefined, model?: string | null): number | null {
  if (!u || !u.ok || u.windows.length === 0) return null;
  const windows = u.windows.filter((w) => windowLimits(w, model));
  return windows.length === 0 ? 0 : Math.max(...windows.map((w) => w.utilization));
}

/**
 * Most room first (lowest peak); accounts at SWAP_MAX_UTILIZATION or more are dropped unless the person
 * picked one; unknown usage goes last. Stable: ties keep the list order.
 *
 * With `priority` (the project's accounts, TER-589) the order is the project's, not the usage: only the
 * accounts it lists, in its order, the full ones still dropped and unknown usage kept in place — the owner
 * chose "the next one in the order", not "the emptiest".
 *
 * `model`: what the session runs on (TER-837) — a window capping another model is left out of the reading.
 */
export function rankCandidates(accounts: AiAccount[], usage: Map<string, AiAccountUsage>, opts: { explicit: boolean; priority?: string[]; model?: string | null }): AiAccount[] {
  const room = (a: AiAccount) => {
    const peak = peakUtilization(usage.get(a.id), opts.model);
    return opts.explicit || peak === null || peak < SWAP_MAX_UTILIZATION;
  };
  if (opts.priority) {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return opts.priority.map((id) => byId.get(id)).filter((a): a is AiAccount => !!a && room(a));
  }
  const scored = accounts.map((a, i) => ({ a, i, peak: peakUtilization(usage.get(a.id), opts.model) }));
  return scored
    .filter((s) => room(s.a))
    .sort((x, y) => (x.peak === null ? 1 : 0) - (y.peak === null ? 1 : 0) || (x.peak ?? 0) - (y.peak ?? 0) || x.i - y.i)
    .map((s) => s.a);
}

/**
 * What the tab's project says about swapping (TER-589): `priority` orders the candidate accounts (the
 * project's Claude accounts on the tab's machine, ids) and `model` is passed to the resumed session. A
 * project that lists none leaves `{}` or only its model: the ranking by free room, as before. Whether the
 * swap happens by itself is the machine's setting alone (owner decision 2026-09-30).
 */
export interface SwapPreferences {
  priority?: string[];
  model?: string | null;
}

export async function swapPreferences(repos: Repositories, tab: Tab, machine: Machine): Promise<SwapPreferences> {
  const { ai, listed } = await projectAccountsOn(repos, tab.project_id, machine.owner_id, machine.id, 'claude');
  return { ...(listed.length > 0 ? { priority: listed.map((a) => a.id) } : {}), ...(ai.models.claude ? { model: ai.models.claude } : {}) };
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
  // an agent moving between instances (a deploy) gets a few seconds to attach before it is called offline
  if (!(await agents.awaitAgent(machine))) throw offline();
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
    // The project's order and model (TER-589). An account the person picked is taken as is, listed or not.
    const prefs = await swapPreferences(repos, tab, machine);
    // getAccountUsage never rejects: a failed reading comes back as `ok: false` and ranks last
    const usage = new Map<string, AiAccountUsage>();
    await Promise.all(pool.map(async (a) => usage.set(a.id, await getAccountUsage(a, machine, true))));
    const ranked = rankCandidates(pool, usage, { explicit: !!opts.accountId, model: prefs.model, ...(opts.accountId ? {} : { priority: prefs.priority }) });

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
      // the transcript is the same for every candidate: no point trying the next one
      if (status === 'no_transcript') throw new ControlError('NO_TRANSCRIPT', 'O arquivo da sessão do Claude desta aba não foi encontrado na máquina');
    }
    if (!to) {
      throw new ControlError(
        'NO_CANDIDATE',
        ranked.length === 0
          ? 'Nenhuma outra conta do Claude desta máquina tem limite disponível'
          : 'Nenhuma outra conta do Claude desta máquina pôde assumir a sessão (mesma conta, pasta ausente ou conflito)',
      );
    }
    // built before the tab is touched: every check that can fail runs first (spec §5)
    // a tab started with its memory MCP keeps it: the config file is still on the machine while the
    // token lives (spec 2026-09-27 agent tab MCP D11); a failed lookup just resumes without it
    const hasTabMcp = await repos.apiTokens.hasLiveForTab(tab.id).catch(() => false);
    const line = resumeLine(to.config_dir, sessionId, RESUME_PROMPT, hasTabMcp ? tab.id : null, prefs.model);

    // Claude waits for the reset on a usage limit (it does not exit): cancel that wait and leave.
    // Already idle means it ended on its own: the tab is at the shell and must not get these keys.
    const current = (await repos.tabs.findById(tab.id)) ?? tab;
    if (current.state !== 'idle') {
      await sendKeyToSession(machine, session, 'Escape');
      await sleep(ESCAPE_PAUSE_MS);
      await sendTextToSession(machine, session, '/exit', true);
      if (!(await waitUntilIdle(repos, tab.id, EXIT_WAIT_MS))) {
        await sendKeyToSession(machine, session, 'C-c');
        await sendKeyToSession(machine, session, 'C-c');
        if (!(await waitUntilIdle(repos, tab.id, EXIT_FORCE_WAIT_MS))) {
          throw new ControlError('EXIT_TIMEOUT', 'O Claude desta aba não encerrou; veja a tela e tente de novo');
        }
      }
      await sleep(RESUME_SETTLE_MS);
      // Leaving a session whose worktree had no changes removes the worktree, and Claude Code moves the
      // transcript to the main repository's project dir (TER-587): the link made above now points
      // nowhere. The move is done before the SessionEnd hook fires, and that hook reports the new path,
      // so the tab already holds it; the script also looks a missing transcript up by session id.
      const exited = await repos.tabs.findById(tab.id);
      const movedTo = exited?.agent_session_id === sessionId ? exited.agent_transcript_path : null;
      const relinked = await linkClaudeSession(machine, { transcriptPath: movedTo ?? transcriptPath, sessionId, configDir: to.config_dir });
      log.info({ tabId: tab.id, machineId: machine.id, accountId: to.id, status: relinked }, 'account swap: relink after exit');
      if (relinked !== 'linked') {
        throw new ControlError('RELINK_FAILED', `O Claude saiu, mas a sessão não pôde ser preparada na conta ${to.label} (${relinked}). Retome a sessão na aba.`);
      }
    }
    // Recorded before the line is typed, so the resumed session's first hooks (or a fast StopFailure)
    // land after it and are not overwritten. Workspace trust is stored per account: the resumed Claude
    // may ask whether to trust the folder, and that answer belongs to the person — so the tab waits on
    // them until the resumed session's SessionStart (run only once trusted) moves it to working. Should
    // typing fail, the tab already names the account the linked session will be resumed under.
    const updated = (await repos.tabs.setAgentFields(tab.id, { ai_account_id: to.id, rate_limited_at: null })) ?? tab;
    const text = `${opts.auto ? 'Conta trocada automaticamente' : 'Conta trocada'}: ${from?.label ?? 'conta desconhecida'} → ${to.label}. Se o Claude pedir para confiar na pasta, confirme na aba.`;
    await applyState(repos, log, updated, 'claude', { kind: 'waiting_input', text, meta: { event: 'AccountSwap', from: from?.id ?? null, to: to.id, auto: opts.auto } });
    await sendTextToSession(machine, session, line, true);

    log.info({ tabId: tab.id, machineId: machine.id, from: from?.id ?? null, to: to.id, auto: opts.auto }, 'account swap: done');
    return { from: from && { id: from.id, label: from.label }, to: { id: to.id, label: to.label } };
  } finally {
    swapping.delete(tab.id);
  }
}

export const AUTO_SWAP_COOLDOWN_MS = 10 * 60_000;
/** Claude Code draws its "waiting for the reset" prompt right after the hook: let it settle first. */
export const AUTO_SWAP_DELAY_MS = 3_000;
/**
 * How many Claude logins the machine has: its registered Claude accounts, plus its default login when the
 * machine has claude and none of them is it (no config dir). The web's Troca automática counts the same.
 */
export function claudeLoginCount(machine: Machine, accounts: AiAccount[]): number {
  const here = accounts.filter((a) => a.machine_id === machine.id && a.provider === 'claude');
  const unregisteredDefault = machine.capabilities.includes('claude') && here.length > 0 && !here.some((a) => a.config_dir === null);
  return here.length + (unregisteredDefault ? 1 : 0);
}

/** When the last automatic swap of each tab was attempted. */
const lastAuto = new Map<string, number>();
/** Tabs with an automatic swap waiting for AUTO_SWAP_DELAY_MS: one per incident. */
const scheduled = new Set<string>();

/**
 * A tab hit a usage limit: when its machine wants it (the default), swap it by itself — at
 * most one attempt per tab per AUTO_SWAP_COOLDOWN_MS, so two exhausted accounts never ping-pong. The
 * cooldown counts from an attempt, not from a call that found the limit already over, and a second
 * StopFailure of the same incident (a queued prompt failing too) is skipped while the first call
 * waits. Fire-and-forget; a failure is written on the tab (the person still sees the limit) and never
 * thrown.
 */
export function autoSwapOnLimit(repos: Repositories, log: FastifyBaseLogger, tab: Tab): void {
  void (async () => {
    const machine = await repos.machines.findById(tab.machine_id);
    if (!machine) return;
    // Turned off on purpose: the project never overrides it; its chat gets a card offering the manual
    // swap instead (TER-589, owner decision 2026-09-30).
    if (!machine.claude_auto_swap) {
      await notifyLimitInChat(repos, log, tab, machine);
      return;
    }
    // On by default everywhere: a machine with a single Claude login has nowhere to go, and its tabs
    // must not get a failure notice on every limit.
    if (claudeLoginCount(machine, await repos.aiAccounts.list(machine.owner_id)) < 2) {
      log.info({ tabId: tab.id, machineId: machine.id }, 'account swap: auto skipped (one Claude login)');
      return;
    }
    if (scheduled.has(tab.id)) {
      log.info({ tabId: tab.id, machineId: machine.id }, 'account swap: auto skipped (already scheduled)');
      return;
    }
    const last = lastAuto.get(tab.id);
    if (last !== undefined && Date.now() - last < AUTO_SWAP_COOLDOWN_MS) {
      log.info({ tabId: tab.id, machineId: machine.id }, 'account swap: auto skipped (cooldown)');
      return;
    }
    scheduled.add(tab.id);
    let fresh: Tab | undefined;
    try {
      await new Promise((r) => setTimeout(r, AUTO_SWAP_DELAY_MS));
      // The snapshot is from the hook: during the delay the person may have swapped by hand, or the
      // account worked again (the limit is cleared). Only the same incident goes on.
      fresh = await repos.tabs.findById(tab.id);
    } finally {
      scheduled.delete(tab.id);
    }
    if (!fresh || !fresh.rate_limited_at || fresh.rate_limited_at !== tab.rate_limited_at) {
      log.info({ tabId: tab.id, machineId: machine.id }, 'account swap: auto skipped (limit no longer current)');
      return;
    }
    lastAuto.set(tab.id, Date.now());
    try {
      await swapAccount(repos, log, fresh, machine, { auto: true });
    } catch (e) {
      const code = e instanceof ControlError ? e.code : 'INTERNAL';
      if (code === 'SWAP_IN_PROGRESS') {
        log.info({ tabId: tab.id, machineId: machine.id }, 'account swap: auto skipped (swap in progress)');
        return;
      }
      const message = e instanceof Error ? e.message : 'erro desconhecido';
      log.warn({ tabId: tab.id, machineId: machine.id, code }, 'account swap: auto failed');
      const current = (await repos.tabs.findById(tab.id)) ?? fresh;
      await applyState(repos, log, current, 'claude', { kind: 'waiting_input', text: `Troca automática falhou: ${message}`, meta: { event: 'AccountSwapFailed', error: code } });
    }
  })().catch((e) => log.error({ tabId: tab.id, err: e instanceof Error ? e.message : 'unknown' }, 'account swap: auto crashed'));
}
