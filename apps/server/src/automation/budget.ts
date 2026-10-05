import type { Repositories } from '../db/repositories/index.js';
import { t } from '../i18n/index.js';
import type { ProjectAutomation } from '../setup/schema.js';
import { postAutomationLine } from './chat-line.js';
import { publishEvent } from './events.js';
import { dayIn } from './usage.js';

/** Spike R8: the early warning comes at this share of the daily budget. */
export const BUDGET_WARNING_SHARE = 0.8;

type Log = { warn: (o: object, m: string) => void };

export interface BudgetRepos {
  tabUsage: Pick<Repositories['tabUsage'], 'ownerTimeZone' | 'costOfDay'>;
  automationEvents: Pick<Repositories['automationEvents'], 'insertOnce'>;
}

export interface DailyBudget {
  /** `YYYY-MM-DD` in the owner's zone (UTC when unknown) */
  day: string;
  spent: number;
  limit: number;
  reached: boolean;
  warn: boolean;
}

/**
 * The project's estimate for the owner's day against `daily_budget_usd` (TER-892). Null when the budget is
 * off (the default, M1): nothing is read then, so a project without a budget behaves exactly as before.
 */
export async function dailyBudget(repos: BudgetRepos, projectId: string, automation: Pick<ProjectAutomation, 'daily_budget_usd'>, now: Date): Promise<DailyBudget | null> {
  const limit = automation.daily_budget_usd;
  if (limit === null || limit === undefined) return null;
  const day = dayIn(await repos.tabUsage.ownerTimeZone(projectId), now);
  const spent = await repos.tabUsage.costOfDay(projectId, day);
  return { day, spent, limit, reached: spent >= limit, warn: spent >= limit * BUDGET_WARNING_SHARE };
}

const usd = (n: number) => n.toFixed(2);

/**
 * The budget gate of a pass: true when no new start, resume or fixer/integrator run may begin (the turn in
 * progress finishes; merges go on, they cost nothing). The first look of the day that finds the budget
 * reached records `budget_hit`, and the first that finds 80 % of it `budget_warning` (a chat line and a feed
 * event, no push), each once per project and day: the day is in the event, and the lookup reads it back so
 * both colours and restarts agree. Never throws on the notices: they are courtesies.
 */
export async function budgetReached(repos: Repositories, projectId: string, automation: ProjectAutomation, now: Date, log?: Log): Promise<boolean> {
  const b = await dailyBudget(repos, projectId, automation, now);
  if (!b) return false;
  const kind = b.reached ? 'budget_hit' : b.warn ? 'budget_warning' : null;
  if (!kind) return false;
  try {
    // the claim is the unique index `automation_events_budget_once`: only the caller that inserts the row
    // (on either colour) publishes it and posts the line
    const claim = await repos.automationEvents.insertOnce({ project_id: projectId, kind, payload: { day: b.day, spent_usd: Number(usd(b.spent)), limit_usd: b.limit } });
    if (!claim) return b.reached;
    await publishEvent(repos, claim);
    await postAutomationLine(
      repos,
      projectId,
      (locale) =>
        b.reached
          ? t(locale, 'Orçamento diário do automático atingido (US$ {{spent}} de US$ {{limit}}): nada novo começa até amanhã', { spent: usd(b.spent), limit: usd(b.limit) })
          : t(locale, 'Gasto do automático em 80% do orçamento diário (US$ {{spent}} de US$ {{limit}})', { spent: usd(b.spent), limit: usd(b.limit) }),
      log,
    );
  } catch (e) {
    log?.warn({ projectId, err: e instanceof Error ? e.message : String(e) }, 'automation: budget notice not recorded');
  }
  return b.reached;
}

/** Whether the card's estimate passed `card_budget_usd` (R8). Off (null) reads nothing. */
export async function cardOverBudget(repos: Pick<Repositories, 'tabUsage'>, taskId: string | null, automation: Pick<ProjectAutomation, 'card_budget_usd'>): Promise<boolean> {
  const limit = automation.card_budget_usd;
  if (limit === null || limit === undefined || !taskId) return false;
  const spent = (await repos.tabUsage.totalsByTask([taskId])).get(taskId)?.cost_usd ?? 0;
  return spent > limit;
}
