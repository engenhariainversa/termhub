import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { setupSchema } from '../setup/schema.js';
import { dayBounds, sendDueSummaries, summaryMessage } from './summary.js';

const setup = (o: object) => setupSchema.parse({ automation: { enabled: true, ...o } });

function fakes(o: { projects?: Array<{ id: string; owner: string; summary_hour: number | null }>; zone?: string | null; claimed?: Set<string>; cost?: number | null } = {}) {
  const projects = o.projects ?? [{ id: 'p1', owner: 'u1', summary_hour: 9 }];
  const claimed = o.claimed ?? new Set<string>();
  const lines: string[] = [];
  const claim = vi.fn(async (u: string, day: string) => {
    await Promise.resolve();
    const key = `${u}|${day}`;
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  });
  const repos = {
    projectSetup: { listWithAutomation: vi.fn(async () => projects.map((p) => ({ project_id: p.id, data: setup({ summary_hour: p.summary_hour }) }))) },
    projects: { findById: vi.fn(async (id: string) => ({ id, owner_id: projects.find((p) => p.id === id)?.owner })) },
    users: { timeZone: vi.fn(async () => o.zone ?? null), findById: vi.fn(async (id: string) => ({ id, locale: 'pt-BR' })) },
    automationSummaries: {
      claim,
      release: vi.fn(async (u: string, day: string) => void claimed.delete(`${u}|${day}`)),
      activity: vi.fn(async () => ({ cards: 3, merges: 2, deploys: 1 })),
      costOfDay: vi.fn(async () => (o.cost === undefined ? 1.5 : o.cost)),
      parkedRuns: vi.fn(async () => [{ task_id: 't1', reason: 'trust_prompt' }]),
      pendingCards: vi.fn(async () => [{ project_id: 'p1', number: 12 }]),
    },
    tasks: { findByIds: vi.fn(async () => [{ id: 't1', ref: 'TER-9' }]) },
    chat: {
      getOrCreateForUser: vi.fn(async () => ({ id: 'c1' })),
      addMessage: vi.fn(async (m: { text: string }) => (lines.push(m.text), { id: 'm', role: 'assistant', created_at: '', ...m })),
    },
  } as unknown as Repositories;
  const push = vi.fn(async () => {});
  return { repos, lines, claim, push };
}

const live = { draining: false };

describe('daily summary (TER-894)', () => {
  it('is sent once at summary_hour in the user zone, not before, and not twice', async () => {
    const f = fakes({ zone: 'America/Sao_Paulo' });
    const deps = { repos: f.repos, lifecycle: live, push: f.push };
    // 11:59 UTC = 08:59 in São Paulo (UTC-3)
    expect(await sendDueSummaries(deps, new Date('2026-10-05T11:59:00Z'))).toBe(0);
    expect(await sendDueSummaries(deps, new Date('2026-10-05T12:00:00Z'))).toBe(1);
    expect(await sendDueSummaries(deps, new Date('2026-10-05T12:05:00Z'))).toBe(0);
    expect(f.lines).toHaveLength(1);
    expect(f.push).toHaveBeenCalledTimes(1);
    // the next day it is sent again
    expect(await sendDueSummaries(deps, new Date('2026-10-06T12:00:00Z'))).toBe(1);
  });

  it('uses UTC when the zone is unknown or invalid', async () => {
    const unknown = fakes({ zone: null });
    expect(await sendDueSummaries({ repos: unknown.repos, lifecycle: live }, new Date('2026-10-05T08:59:00Z'))).toBe(0);
    expect(await sendDueSummaries({ repos: unknown.repos, lifecycle: live }, new Date('2026-10-05T09:00:00Z'))).toBe(1);
    const bad = fakes({ zone: 'Not/AZone' });
    expect(await sendDueSummaries({ repos: bad.repos, lifecycle: live }, new Date('2026-10-05T09:00:00Z'))).toBe(1);
  });

  it('summary_hour null on every project: nothing is read, nothing is sent', async () => {
    const f = fakes({ projects: [{ id: 'p1', owner: 'u1', summary_hour: null }] });
    expect(await sendDueSummaries({ repos: f.repos, lifecycle: live, push: f.push }, new Date('2026-10-05T23:00:00Z'))).toBe(0);
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.lines).toEqual([]);
    expect(f.push).not.toHaveBeenCalled();
  });

  it('one summary per user across projects, at the earliest hour', async () => {
    const f = fakes({ projects: [{ id: 'p1', owner: 'u1', summary_hour: 18 }, { id: 'p2', owner: 'u1', summary_hour: 8 }, { id: 'p3', owner: 'u1', summary_hour: null }] });
    const deps = { repos: f.repos, lifecycle: live };
    expect(await sendDueSummaries(deps, new Date('2026-10-05T07:59:00Z'))).toBe(0);
    expect(await sendDueSummaries(deps, new Date('2026-10-05T08:00:00Z'))).toBe(1);
    expect(await sendDueSummaries(deps, new Date('2026-10-05T18:00:00Z'))).toBe(0);
    expect(f.repos.automationSummaries.activity).toHaveBeenCalledWith(['p1', 'p2', 'p3'], expect.any(Date), expect.any(Date));
  });

  it('a draining colour sends nothing and claims nothing', async () => {
    const f = fakes();
    expect(await sendDueSummaries({ repos: f.repos, lifecycle: { draining: true } }, new Date('2026-10-05T12:00:00Z'))).toBe(0);
    expect(f.claim).not.toHaveBeenCalled();
  });

  it('two colours ticking together send it once', async () => {
    const claimed = new Set<string>();
    const a = fakes({ claimed });
    const b = fakes({ claimed });
    const now = new Date('2026-10-05T09:00:00Z');
    const sent = await Promise.all([sendDueSummaries({ repos: a.repos, lifecycle: live, push: a.push }, now), sendDueSummaries({ repos: b.repos, lifecycle: live, push: b.push }, now)]);
    expect(sent.reduce((x, y) => x + y, 0)).toBe(1);
    expect(a.lines.length + b.lines.length).toBe(1);
    expect(a.push.mock.calls.length + b.push.mock.calls.length).toBe(1);
  });

  it('gives the claim back when the chat message cannot be written, so the next tick retries', async () => {
    const f = fakes();
    (f.repos.chat.addMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    const log = { warn: vi.fn() };
    const deps = { repos: f.repos, lifecycle: live, log };
    const now = new Date('2026-10-05T09:00:00Z');
    expect(await sendDueSummaries(deps, now)).toBe(0);
    expect(log.warn).toHaveBeenCalled();
    expect(await sendDueSummaries(deps, now)).toBe(1);
  });

  it('the chat message carries what was done, what waits, and the cost, in pt-BR', async () => {
    const f = fakes();
    await sendDueSummaries({ repos: f.repos, lifecycle: live }, new Date('2026-10-05T09:00:00Z'));
    expect(f.lines[0]).toBe(
      [
        'Resumo do automático — 05/10/2026',
        'Feitos: 3 cards, 2 merges, 1 deploys',
        'Esperando você: TER-9 (O agente parou na confirmação de confiança da pasta; confirme na aba para continuar.); PR #12 (Merge esperando sua aprovação no chat)',
        'Custo estimado do dia: US$ 1.50',
      ].join('\n'),
    );
  });

  it('shows — when nothing was priced and "nada" when nothing waits; english on request', () => {
    const s = { day: '2026-10-05', cards: 0, merges: 0, deploys: 0, waiting: [], cost: null };
    expect(summaryMessage(s, 'pt-BR')).toContain('Esperando você: nada');
    expect(summaryMessage(s, 'pt-BR')).toContain('Custo estimado do dia: —');
    expect(summaryMessage(s, 'en')).toBe(['Automatic work summary — 10/05/2026', 'Done: 0 cards, 0 merges, 0 deploys', 'Waiting on you: nothing', 'Estimated cost of the day: —'].join('\n'));
  });

  it('the push text holds counts only', async () => {
    const f = fakes();
    await sendDueSummaries({ repos: f.repos, lifecycle: live, push: f.push }, new Date('2026-10-05T09:00:00Z'));
    const call = f.push.mock.calls[0] as unknown as [string, (l: 'pt-BR' | 'en') => { title: string; body: string }, Record<string, unknown>, string];
    expect(call[1]('pt-BR')).toEqual({ title: 'Resumo do automático — 05/10/2026', body: 'Feitos: 3 cards, 2 merges, 1 deploys\nEsperando você: 2' });
    expect(call[3]).toBe('summary:2026-10-05');
  });

  it('dayBounds: the local day in its zone', () => {
    expect(dayBounds('America/Sao_Paulo', '2026-10-05')).toEqual({ from: new Date('2026-10-05T03:00:00Z'), to: new Date('2026-10-06T03:00:00Z') });
    expect(dayBounds('UTC', '2026-10-05')).toEqual({ from: new Date('2026-10-05T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z') });
    expect(dayBounds('Asia/Tokyo', '2026-10-05').from).toEqual(new Date('2026-10-04T15:00:00Z'));
  });
});
