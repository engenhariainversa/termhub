import { getAccountUsage, type AiAccountUsage } from '../ai/index.js';
import { RESUME_PROMPT } from '../control/agents.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { Tab } from '../db/repositories/types.js';
import { recordEvent } from './events.js';
import { defaultType, mayType, noteTyped, type FollowerDeps } from './follower.js';
import { isPaused } from './pause.js';
import { serverMessage } from './prompts.js';

/** How long an account waits when its usage gives no reset ahead (spec D16). */
export const QUOTA_FALLBACK_MS = 60 * 60_000;
/** `automation_runs.waiting_reason` of a run parked on its account's usage limit. */
export const QUOTA_WAITING = 'quota';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const noopLog: Log = { info: () => {}, warn: () => {} };

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code.slice(0, 64) : 'INTERNAL';
}

/**
 * When an account at its limit is usable again (spec D16): with a full window (utilization 100) in the
 * reading, the latest reset of the full windows — an earlier reset of a window that still had room frees
 * nothing; otherwise the soonest reset still ahead. Unknown usage, or no reset ahead: one hour from now.
 */
export function resetAt(usage: AiAccountUsage | null, now: Date): Date {
  const ahead = (usage?.ok ? usage.windows : [])
    .map((w) => ({ full: w.utilization >= 100, at: w.resets_at ? Date.parse(w.resets_at) : NaN }))
    .filter((w) => Number.isFinite(w.at) && w.at > now.getTime());
  if (ahead.length === 0) return new Date(now.getTime() + QUOTA_FALLBACK_MS);
  const full = ahead.filter((w) => w.full);
  return new Date(full.length > 0 ? Math.max(...full.map((w) => w.at)) : Math.min(...ahead.map((w) => w.at)));
}

/** The account's usage now (refreshed); null when it cannot be read. Never throws. */
async function usageOf(deps: FollowerDeps, accountId: string): Promise<AiAccountUsage | null> {
  try {
    if (deps.accountUsage) return await deps.accountUsage(accountId);
    const account = await deps.repos.aiAccounts.findById(accountId);
    if (!account) return null;
    return await getAccountUsage(account, await deps.repos.machines.findById(account.machine_id), true);
  } catch {
    return null;
  }
}

/**
 * The automatic swap (`autoSwapOnLimit`, fire-and-forget) moved the tab to another account: the run takes
 * the tab's account (preflight F-12). True when the run's account changed.
 */
async function followSwap(deps: FollowerDeps, run: AutomationRun, tab: Tab, log: Log): Promise<boolean> {
  if (!tab.ai_account_id || tab.ai_account_id === run.account_id) return false;
  if (!(await deps.repos.automationRuns.update(run.id, run.claimed_by, { account_id: tab.ai_account_id }))) return false;
  log.info({ runId: run.id, tabId: tab.id, from: run.account_id, to: tab.ai_account_id }, 'automation: run follows the swapped account');
  return true;
}

/**
 * A run's tab stopped on a usage limit (spec D16). The account is marked exhausted until its reset (a mark
 * already in force is kept: another run hit it first), the run waits on `quota` and `quota_hit` is
 * recorded — once: a waiting run is not handed back here. When the automatic swap already moved the tab
 * to another account, the run takes that account and nothing else happens: the swap resumed the session
 * itself. Nothing is typed here.
 */
export async function onRateLimit(deps: FollowerDeps, seen: AutomationRun, tab: Tab): Promise<void> {
  const log = deps.log ?? noopLog;
  const { repos } = deps;
  // read again: a caller holding an older copy of a run that is already parked does nothing
  const run = await repos.automationRuns.findById(seen.id);
  if (run?.status !== 'running') return;
  // the swap writes the new account and clears the limit before the tab's state text changes
  if ((await followSwap(deps, run, tab, log)) && !tab.rate_limited_at) return;
  const accountId = tab.ai_account_id ?? run.account_id;
  const now = deps.now?.() ?? new Date();
  let until: Date | null = null;
  if (accountId && !(await repos.aiAccountExhaustions.activeIds(now)).has(accountId)) {
    until = resetAt(await usageOf(deps, accountId), now);
    await repos.aiAccountExhaustions.mark(accountId, until, 'rate_limit');
  }
  if (!(await repos.automationRuns.updateActive(run.id, run.claimed_by, { status: 'waiting', waiting_reason: QUOTA_WAITING }))) return;
  await recordEvent(repos, {
    project_id: run.project_id,
    task_id: run.task_id,
    run_id: run.id,
    kind: 'quota_hit',
    payload: { account_id: accountId, tab_id: tab.id, until: until?.toISOString() ?? null },
  }).catch((e: unknown) => log.warn({ runId: run.id, code: errorCode(e) }, 'automation: quota_hit not recorded'));
  log.info({ runId: run.id, tabId: tab.id, accountId, until: until?.toISOString() ?? null }, 'automation: run waits for the usage reset');
}

/** Whether the run's account is usable again: not marked exhausted (or, with no account, an hour after the limit). */
function cleared(run: AutomationRun, tab: Tab, exhausted: Set<string>, now: Date): boolean {
  if (run.account_id) return !exhausted.has(run.account_id);
  const since = tab.rate_limited_at ? Date.parse(tab.rate_limited_at) : NaN;
  return !Number.isFinite(since) || now.getTime() - since >= QUOTA_FALLBACK_MS;
}

/**
 * The dispatcher's tick (spec D16): every run this instance drives that waits on `quota`. A run whose tab
 * the swap moved to another account takes it and runs again, nothing typed. A run whose account is clear
 * again — never one still in `activeIds` — is resumed in its tab with the marked message, once, after the
 * same checks as any resume (automation on, card still tagged, not paused right before typing), and
 * `quota_reset` is recorded. A tab that already left the limit (a person typed, the agent exited) is not
 * typed into: the run just goes back to the follower.
 */
export async function resumeAfterReset(deps: FollowerDeps): Promise<void> {
  const log = deps.log ?? noopLog;
  const { repos } = deps;
  if (deps.lifecycle.draining) return;
  const waiting = (await repos.automationRuns.followedBy(deps.instance)).filter((r) => r.status === 'waiting' && r.waiting_reason === QUOTA_WAITING);
  if (waiting.length === 0) return;
  const now = deps.now?.() ?? new Date();
  const exhausted = await repos.aiAccountExhaustions.activeIds(now);
  for (const run of waiting) {
    try {
      if (!run.tab_id) continue;
      const tab = await repos.tabs.findById(run.tab_id);
      if (!tab) continue;
      if (await followSwap(deps, run, tab, log)) {
        await repos.automationRuns.updateActive(run.id, run.claimed_by, { status: 'running', waiting_reason: null });
        continue;
      }
      if (!cleared(run, tab, exhausted, now)) continue;
      const ready = await mayType(deps, run, log);
      if (!ready) continue;
      const typing = tab.state === 'waiting_input';
      // D24: the last check before anything is typed
      if (typing && (await isPaused(repos, ready.ctx.scope.ownerId, run.project_id))) continue;
      if (!(await repos.automationRuns.updateActive(run.id, run.claimed_by, { status: 'running', waiting_reason: null }))) continue;
      if (typing) {
        // the limit screen stays until the agent reacts: the follower must not read it as a new limit
        noteTyped(run.id, tab, now);
        await (deps.type ?? defaultType)(ready.ctx, tab.id, serverMessage(RESUME_PROMPT));
      }
      await recordEvent(repos, {
        project_id: run.project_id,
        task_id: run.task_id,
        run_id: run.id,
        kind: 'quota_reset',
        payload: { account_id: run.account_id, tab_id: tab.id, typed: typing },
      }).catch((e: unknown) => log.warn({ runId: run.id, code: errorCode(e) }, 'automation: quota_reset not recorded'));
      log.info({ runId: run.id, tabId: tab.id, accountId: run.account_id, typed: typing }, 'automation: run resumed after the usage reset');
    } catch (e) {
      log.warn({ runId: run.id, code: errorCode(e) }, 'automation: resume after the usage reset failed');
    }
  }
}
