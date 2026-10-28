import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import type { TmuxProbe } from '../terminal/machine-exec.js';

const publishTabQuestions = vi.fn(async (..._a: unknown[]) => []);
const expireOrphanTabQuestions = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('./tab-questions.js', () => ({
  publishTabQuestions: (...a: unknown[]) => publishTabQuestions(...a),
  expireOrphanTabQuestions: (...a: unknown[]) => expireOrphanTabQuestions(...a),
}));

const { STUCK_GRACE_MS, STUCK_SWEEP_LIMIT, sweepStuckTabQuestions } = await import('./stuck-tab-questions.js');

const NOW = new Date('2026-10-28T10:00:00.000Z');
const card = (over: Partial<TabQuestion> = {}): TabQuestion => ({ id: 'q1', tab_id: 't1', status: 'open', kind: 'choice', user_id: 'u1', conversation_id: 'c1', ...over }) as TabQuestion;
const tab = (over: Partial<Tab> = {}): Tab => ({ id: 't1', project_id: 'p1', machine_id: 'm1', name: 'OPM-572 Stripe', tmux_session: 'th-t1', state: 'waiting_input', ...over }) as Tab;
const machine = (over: Partial<Machine> = {}): Machine => ({ id: 'm1', owner_id: 'u1', type: 'agent', ...over }) as Machine;
const log = () => ({ info: vi.fn(), warn: vi.fn() });
const reachable = (...sessions: string[]): TmuxProbe => ({ reachable: true, sessions: new Set(sessions) });

function setup(opts: { cards?: TabQuestion[]; tabs?: Tab[]; probe?: TmuxProbe; pane?: 'shell' | 'busy' | 'dead' | null; online?: boolean } = {}) {
  publishTabQuestions.mockClear();
  expireOrphanTabQuestions.mockClear();
  const tabs = opts.tabs ?? [tab()];
  const expireOne = vi.fn(async (id: string) => card({ id, status: 'expired', closed_at: NOW.toISOString() }));
  const repos = {
    tabQuestions: { listOpenQuestionsBefore: vi.fn(async () => opts.cards ?? [card()]), expireOne },
    tabs: { findById: vi.fn(async (id: string) => tabs.find((t) => t.id === id)) },
    machines: { findById: vi.fn(async () => machine()) },
  } as unknown as Repositories;
  const deps = {
    probe: vi.fn(async () => opts.probe ?? reachable('th-t1')),
    foreground: vi.fn(async () => (opts.pane === undefined ? 'busy' : opts.pane)),
    isOnline: () => opts.online ?? true,
  };
  return { repos, expireOne, deps };
}

describe('sweepStuckTabQuestions — a card no tab can answer any more (TER-1140)', () => {
  it('first closes the cards whose tab row is gone, then reads the open cards past the grace period', async () => {
    const { repos, deps } = setup({ cards: [] });
    await sweepStuckTabQuestions(repos, log() as never, NOW, deps);
    expect(expireOrphanTabQuestions).toHaveBeenCalledTimes(1);
    expect(repos.tabQuestions.listOpenQuestionsBefore).toHaveBeenCalledWith(new Date(NOW.getTime() - STUCK_GRACE_MS), STUCK_SWEEP_LIMIT);
  });

  it('a tab whose tmux session is gone: every open card of it closes as expired and every screen hears it', async () => {
    const { repos, expireOne, deps } = setup({ cards: [card(), card({ id: 'q2', kind: 'permission' })], probe: reachable('th-other') });
    const l = log();
    expect(await sweepStuckTabQuestions(repos, l as never, NOW, deps)).toBe(2);
    expect(expireOne.mock.calls.map((c) => c[0])).toEqual(['q1', 'q2']);
    expect(publishTabQuestions).toHaveBeenCalledWith(repos, 'tab_question_closed', [expect.objectContaining({ id: 'q1' }), expect.objectContaining({ id: 'q2' })]);
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', machineId: 'm1', why: 'session_gone', count: 2 }, 'stuck tab questions expired');
    expect(deps.foreground).not.toHaveBeenCalled();
  });

  it.each(['shell', 'dead'] as const)('the agent left its pane (%s in front): the card closes', async (pane) => {
    const { repos, expireOne, deps } = setup({ pane });
    expect(await sweepStuckTabQuestions(repos, log() as never, NOW, deps)).toBe(1);
    expect(deps.foreground).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'th-t1');
    expect(expireOne).toHaveBeenCalledWith('q1', NOW);
  });

  it('the agent still in front, or a pane it cannot read: the card stays', async () => {
    for (const pane of ['busy', null] as const) {
      const { repos, expireOne, deps } = setup({ pane });
      expect(await sweepStuckTabQuestions(repos, log() as never, NOW, deps)).toBe(0);
      expect(expireOne).not.toHaveBeenCalled();
    }
  });

  it('a machine that cannot be asked proves nothing: offline agent or unreachable probe close nothing', async () => {
    const offline = setup({ online: false, probe: reachable() });
    expect(await sweepStuckTabQuestions(offline.repos, log() as never, NOW, offline.deps)).toBe(0);
    expect(offline.deps.probe).not.toHaveBeenCalled();
    const unreachable = setup({ probe: { reachable: false, sessions: new Set(), cause: 'timeout' } });
    expect(await sweepStuckTabQuestions(unreachable.repos, log() as never, NOW, unreachable.deps)).toBe(0);
    expect(unreachable.expireOne).not.toHaveBeenCalled();
  });

  it('a tab with no tmux session, or gone since the orphan sweep, is left to the next pass', async () => {
    const { repos, expireOne, deps } = setup({ cards: [card(), card({ id: 'q2', tab_id: 'gone' })], tabs: [tab({ tmux_session: null })] });
    expect(await sweepStuckTabQuestions(repos, log() as never, NOW, deps)).toBe(0);
    expect(expireOne).not.toHaveBeenCalled();
  });

  it('asks each machine once per pass, and a card something else closed first is not announced', async () => {
    const { repos, expireOne, deps } = setup({ cards: [card(), card({ id: 'q2', tab_id: 't2' })], tabs: [tab(), tab({ id: 't2', tmux_session: 'th-t2' })], probe: reachable() });
    expireOne.mockResolvedValueOnce(undefined as never);
    expect(await sweepStuckTabQuestions(repos, log() as never, NOW, deps)).toBe(1);
    expect(deps.probe).toHaveBeenCalledTimes(1);
    expect(publishTabQuestions).toHaveBeenCalledTimes(1);
    expect(publishTabQuestions).toHaveBeenCalledWith(repos, 'tab_question_closed', [expect.objectContaining({ id: 'q2' })]);
  });

  it('never throws: a failed read is logged with its code only', async () => {
    const { repos, deps } = setup();
    (repos.tabQuestions.listOpenQuestionsBefore as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    const l = log();
    await expect(sweepStuckTabQuestions(repos, l as never, NOW, deps)).resolves.toBe(0);
    expect(l.warn).toHaveBeenCalledWith({ code: expect.any(String) }, 'stuck tab question sweep failed');
  });
});
