import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { setupSchema } from '../setup/schema.js';
import { automationBus } from './events.js';
import { budgetReached, cardOverBudget, dailyBudget } from './budget.js';

const auto = (o: object) => setupSchema.parse({ automation: { enabled: true, ...o } }).automation;

/** The day's spend, the owner's zone and the events written; anything else the budget must not touch. */
function fakes(o: { spent?: number; zone?: string | null; cardCost?: number | null } = {}) {
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const lines: string[] = [];
  const costOfDay = vi.fn(async (_p: string, _day: string) => o.spent ?? 0);
  const ownerTimeZone = vi.fn(async () => o.zone ?? null);
  const totalsByTask = vi.fn(async (ids: string[]) => new Map(o.cardCost === undefined ? [] : [[ids[0]!, { tokens: 1, cost_usd: o.cardCost }]]));
  const repos = {
    tabUsage: { costOfDay, ownerTimeZone, totalsByTask },
    automationEvents: {
      existsForProject: vi.fn(async (_p: string, kind: string, match: Record<string, unknown>) => events.some((e) => e.kind === kind && Object.entries(match).every(([k, v]) => e.payload[k] === v))),
      insert: vi.fn(async (e: { kind: string; payload: Record<string, unknown> }) => (events.push(e), { ...e, id: 'e', created_at: '' })),
    },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    users: { findById: vi.fn(async () => ({ id: 'u1', locale: 'pt-BR' })) },
    chat: {
      findLatestActiveForProject: vi.fn(async () => ({ id: 'c1' })),
      getOrCreateForProject: vi.fn(async () => ({ id: 'c1' })),
      addMessage: vi.fn(async (m: { text: string }) => (lines.push(m.text), { id: 'm', role: 'assistant', created_at: '', ...m })),
    },
  } as unknown as Repositories;
  return { repos, events, lines, costOfDay, ownerTimeZone, totalsByTask };
}

describe('daily budget (TER-892)', () => {
  it('a null budget reads nothing and never blocks (M1)', async () => {
    const f = fakes({ spent: 9999 });
    expect(await dailyBudget(f.repos, 'p1', auto({}), new Date())).toBeNull();
    expect(await budgetReached(f.repos, 'p1', auto({}), new Date())).toBe(false);
    expect(f.costOfDay).not.toHaveBeenCalled();
    expect(f.ownerTimeZone).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });

  it('under 80 %: nothing. At 80 %: one warning (feed event and chat line) per day, still not reached', async () => {
    const f = fakes({ spent: 3 });
    const now = new Date('2026-10-05T12:00:00Z');
    expect(await budgetReached(f.repos, 'p1', auto({ daily_budget_usd: 10 }), now)).toBe(false);
    expect(f.events).toEqual([]);
    const g = fakes({ spent: 8 });
    expect(await budgetReached(g.repos, 'p1', auto({ daily_budget_usd: 10 }), now)).toBe(false);
    expect(await budgetReached(g.repos, 'p1', auto({ daily_budget_usd: 10 }), now)).toBe(false);
    expect(g.events).toEqual([{ kind: 'budget_warning', project_id: 'p1', task_id: null, run_id: null, payload: { day: '2026-10-05', spent_usd: 8, limit_usd: 10 } }]);
    expect(g.lines).toHaveLength(1);
    // the next day warns again
    await budgetReached(g.repos, 'p1', auto({ daily_budget_usd: 10 }), new Date('2026-10-06T12:00:00Z'));
    expect(g.events).toHaveLength(2);
  });

  it('reaching it blocks and records budget_hit once per day; the warning is not repeated after it', async () => {
    const f = fakes({ spent: 10 });
    const seen: string[] = [];
    const off = automationBus.subscribe((e) => seen.push(e.kind));
    const a = auto({ daily_budget_usd: 10 });
    const now = new Date('2026-10-05T12:00:00Z');
    expect(await budgetReached(f.repos, 'p1', a, now)).toBe(true);
    expect(await budgetReached(f.repos, 'p1', a, now)).toBe(true);
    off();
    expect(f.events.map((e) => e.kind)).toEqual(['budget_hit']);
    expect(seen).toEqual(['budget_hit']);
    expect(f.lines).toHaveLength(1);
  });

  it('the day is the owner\'s: midnight in their zone, UTC when unknown', async () => {
    const at = new Date('2026-10-06T01:30:00Z'); // still the 5th in São Paulo
    const sp = fakes({ zone: 'America/Sao_Paulo' });
    await dailyBudget(sp.repos, 'p1', auto({ daily_budget_usd: 10 }), at);
    expect(sp.costOfDay).toHaveBeenCalledWith('p1', '2026-10-05');
    const utc = fakes({ zone: null });
    await dailyBudget(utc.repos, 'p1', auto({ daily_budget_usd: 10 }), at);
    expect(utc.costOfDay).toHaveBeenCalledWith('p1', '2026-10-06');
    const bad = fakes({ zone: 'Not/AZone' });
    await dailyBudget(bad.repos, 'p1', auto({ daily_budget_usd: 10 }), at);
    expect(bad.costOfDay).toHaveBeenCalledWith('p1', '2026-10-06');
  });

  it('a new day with nothing spent runs again', async () => {
    const f = fakes({ spent: 0 });
    expect(await budgetReached(f.repos, 'p1', auto({ daily_budget_usd: 10 }), new Date())).toBe(false);
  });
});

describe('card budget (R8)', () => {
  it('off by default and reads nothing; on, it trips only when the estimate passes it', async () => {
    const f = fakes({ cardCost: 50 });
    expect(await cardOverBudget(f.repos, 't1', auto({}))).toBe(false);
    expect(f.totalsByTask).not.toHaveBeenCalled();
    expect(await cardOverBudget(f.repos, 't1', auto({ card_budget_usd: 50 }))).toBe(false);
    expect(await cardOverBudget(f.repos, 't1', auto({ card_budget_usd: 49.99 }))).toBe(true);
    expect(await cardOverBudget(fakes({}).repos, 't1', auto({ card_budget_usd: 1 }))).toBe(false);
  });
});
