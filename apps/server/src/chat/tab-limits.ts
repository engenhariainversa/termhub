import type { FastifyBaseLogger } from 'fastify';
import { getAccountUsage, type AiAccountUsage } from '../ai/index.js';
import { projectAccountsOn } from '../ai/project-accounts.js';
import { rankCandidates, swapAccount } from '../control/account-swap.js';
import { ControlError, type ControlContext } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TabLimitNotice, TabLimitPayload, TabLimitStatus } from '../db/repositories/tab-limit-notices.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { chatBus } from './bus.js';
import { failureLabel } from './service.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/** A usage-limit card as both clients render it: the row plus the tab's name at read time. */
export interface TabLimitView {
  id: string;
  tab_id: string;
  tab_name: string | null;
  payload: TabLimitPayload;
  status: TabLimitStatus;
  result: string | null;
  created_at: string;
  closed_at: string | null;
}

/** Names resolved owner-scoped, in one read: a tab the user cannot see names nothing. */
export async function describeTabLimits(repos: Pick<Repositories, 'tabs'>, rows: TabLimitNotice[], userId: string): Promise<TabLimitView[]> {
  const ids = [...new Set(rows.map((r) => r.tab_id))];
  const tabs = ids.length ? await repos.tabs.findByIdsForOwner(ids, userId) : [];
  const nameOf = new Map(tabs.map((t) => [t.id, t.name]));
  return rows.map((r) => ({ id: r.id, tab_id: r.tab_id, tab_name: nameOf.get(r.tab_id) ?? null, payload: r.payload, status: r.status, result: r.result, created_at: r.created_at, closed_at: r.closed_at }));
}

async function publish(repos: Pick<Repositories, 'tabs'>, type: 'tab_limit' | 'tab_limit_closed', rows: TabLimitNotice[]): Promise<TabLimitView[]> {
  const views: TabLimitView[] = [];
  for (const row of rows) {
    const [view] = await describeTabLimits(repos, [row], row.user_id);
    chatBus.publish({ type, user_id: row.user_id, conversation_id: row.conversation_id, notice: view });
    views.push(view);
  }
  return views;
}

/** When the fullest window of the account resets, when the reading says. */
function resetsAt(usage: AiAccountUsage | undefined): string | null {
  if (!usage?.ok || usage.windows.length === 0) return null;
  const fullest = usage.windows.reduce((a, b) => (b.utilization > a.utilization ? b : a));
  return fullest.resets_at ?? null;
}

/**
 * A project tab hit a usage limit on a machine that does not swap accounts by itself (spec 2026-09-30
 * project AI accounts §7.2, owner decision): a card in the project's most recently active conversation,
 * offering the project's other accounts on that machine that have room. Nothing for a project without
 * accounts there, for no other account with room, or twice for the same incident. Never throws; logs ids.
 */
export async function notifyLimitInChat(repos: Repositories, log: Log, tab: Tab, machine: Machine): Promise<void> {
  try {
    if (!tab.rate_limited_at) return;
    const owner = (await repos.projects.findById(tab.project_id))?.owner_id;
    const conversation = owner ? await repos.chat.findLatestActiveForProject(tab.project_id, owner) : undefined;
    if (!conversation) return;
    const [{ listed }, accounts] = await Promise.all([projectAccountsOn(repos, tab.project_id, machine.owner_id, machine.id, 'claude'), repos.aiAccounts.list(machine.owner_id)]);
    const others = listed.filter((a) => a.id !== tab.ai_account_id);
    if (others.length === 0) return;
    const current = accounts.find((a) => a.id === tab.ai_account_id && a.machine_id === machine.id) ?? null;
    const usage = new Map<string, AiAccountUsage>();
    await Promise.all([...others, ...(current ? [current] : [])].map(async (a) => usage.set(a.id, await getAccountUsage(a, machine))));
    const candidates = rankCandidates(others, usage, { explicit: false, priority: others.map((a) => a.id) });
    if (candidates.length === 0) return;
    const notice = await repos.tabLimitNotices.open({
      tab_id: tab.id,
      project_id: tab.project_id,
      conversation_id: conversation.id,
      limited_at: new Date(tab.rate_limited_at),
      payload: {
        account: current && { id: current.id, label: current.label },
        machine: { id: machine.id, name: machine.name },
        resets_at: current ? resetsAt(usage.get(current.id)) : null,
        candidates: candidates.map((a) => ({ id: a.id, label: a.label })),
      },
    });
    if (!notice) return;
    await publish(repos, 'tab_limit', [notice]);
    log.info({ tabId: tab.id, machineId: machine.id, noticeId: notice.id, candidates: candidates.length }, 'tab limit card opened');
  } catch (err) {
    log.warn({ tabId: tab.id, code: failureLabel(err) }, 'tab limit card failed');
  }
}

/** The tab's limit ended or the tab is gone: its open card closes as `expired`. Never throws. */
export async function expireTabLimits(repos: Repositories, log: Log, tabId: string): Promise<void> {
  try {
    await publish(repos, 'tab_limit_closed', await repos.tabLimitNotices.closeOpenForTab(tabId, 'expired'));
  } catch (err) {
    log.warn({ tabId, code: failureLabel(err) }, 'tab limit card expiry failed');
  }
}

/**
 * The person answered the card: an account swaps the tab to it (the manual swap, explicit), `null`
 * ("Esperar") dismisses it. A swap that fails leaves the card open and says why (409), so the person can
 * pick another account or wait.
 */
export async function answerTabLimit(ctx: ControlContext, log: FastifyBaseLogger, id: string, accountId: string | null): Promise<TabLimitView> {
  const notice = await ctx.repos.tabLimitNotices.findForUser(id, ctx.scope.user.id);
  if (!notice) throw notFound('Aviso não encontrado');
  if (notice.status !== 'open') throw conflict('Este aviso já foi respondido ou expirou');
  const closeAs = async (status: Exclude<TabLimitStatus, 'open'>, result: string | null = null) => {
    const closed = await ctx.repos.tabLimitNotices.close(notice.id, status, result);
    if (!closed) throw conflict('Este aviso já foi respondido ou expirou');
    return (await publish(ctx.repos, 'tab_limit_closed', [closed]))[0];
  };
  if (accountId === null) return closeAs('dismissed');
  if (!notice.payload.candidates.some((c) => c.id === accountId)) throw badRequest('Essa conta não está entre as opções do aviso');
  if (!(await ctx.can('terminals', 'update'))) throw new HttpError(403, 'Trocar a conta da aba precisa da permissão terminals:update na sua role', 'FORBIDDEN');
  const found = await ctx.scoped.tab(notice.tab_id).catch(() => null);
  if (!found) {
    await closeAs('expired');
    throw conflict('A aba deste aviso não existe mais');
  }
  try {
    await swapAccount(ctx.repos, log, found.tab, found.machine, { accountId, auto: false });
  } catch (e) {
    if (e instanceof ControlError) throw conflict(e.localized);
    throw e;
  }
  const swapped = await ctx.repos.tabLimitNotices.markSwapped(notice.id, accountId);
  if (!swapped) throw conflict('Este aviso já foi respondido ou expirou');
  return (await publish(ctx.repos, 'tab_limit_closed', [swapped]))[0];
}
