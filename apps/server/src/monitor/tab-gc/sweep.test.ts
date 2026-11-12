import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../../db/repositories/index.js';
import type { GcTab } from '../../db/repositories/tab-gc.js';
import type { Machine } from '../../db/repositories/types.js';
import type { RoomReading } from '../../automation/machine-room.js';

const recordEvent = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../automation/events.js', () => ({ recordEvent: (...a: unknown[]) => recordEvent(...a) }));
vi.mock('../../control/terminals.js', () => ({ closeTab: vi.fn() }));
vi.mock('../../chat/agent-exited.js', () => ({ AGENT_EXITED_TEXT: 'Agente encerrado sem terminar o turno' }));

const { runTabGc } = await import('./sweep.js');

const HOUR = 60 * 60_000;
const MIN = 60_000;
const NOW = new Date('2026-11-11T12:00:00Z');
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

const gcTab = (over: Partial<GcTab> = {}): GcTab => ({
  id: 't1',
  project_id: 'p1',
  owner_id: 'u1',
  machine_id: 'm1',
  name: 'aba',
  tmux_session: 'th-t1',
  state: 'finished',
  state_tool: 'claude',
  state_text: null,
  state_at: at(30 * HOUR),
  rate_limited_at: null,
  agent_session_id: 's1',
  cwd: '/w/x',
  last_event_at: at(30 * HOUR),
  task: null,
  gc_pinned: false,
  gc_warned_at: null,
  gc_warned_state_at: null,
  gc_reset_at: null,
  ...over,
});

const PROMPT = '● Pronto.\n\n✻ Brewed for 3s\n\n────────────\n❯ \n────────────';

interface Opts {
  machine?: Partial<Machine>;
  machineLevel?: unknown;
  idleHours?: number | null;
  projectLevel?: unknown;
  userLevel?: unknown;
  online?: boolean;
  reachable?: boolean;
  sessions?: string[];
  flags?: { on: boolean; live: boolean };
  activeRun?: boolean;
  room?: RoomReading | null;
  machineTabs?: number;
  warn?: boolean;
}

function setup(tabs: GcTab[], o: Opts = {}) {
  recordEvent.mockClear();
  const tabGc = {
    listAgentTabs: vi.fn(async (f: { machineId?: string }) => (f.machineId ? Array.from({ length: o.machineTabs ?? tabs.length }) : tabs)),
    warn: vi.fn(async () => o.warn ?? true),
    clearWarning: vi.fn(async () => true),
    reset: vi.fn(async () => {}),
    archive: vi.fn(async (input: object) => ({ ...input, id: 'a1', collected_at: NOW.toISOString() })),
    userLevel: vi.fn(async () => o.userLevel ?? null),
    machineLevel: vi.fn(async () => ({ level: o.machineLevel ?? null, idle_hours: o.idleHours ?? null })),
  };
  const repos = {
    tabGc,
    tabs: {
      readLastAnswer: vi.fn(async () => ({ text: 'Pronto: PR aberto.', at: at(30 * HOUR), tool: 'claude', stale: false })),
      listEvents: vi.fn(async () => [{ meta: { event: 'Stop' } }]),
    },
    machines: { findById: vi.fn(async () => ({ id: 'm1', name: 'hulk', owner_id: 'u1', type: 'agent', ...o.machine }) as Machine) },
    projectSetup: { get: vi.fn(async () => ({ data: { tab_gc: o.projectLevel } })) },
    automationRuns: { activeByTab: vi.fn(async () => (o.activeRun ? { id: 'r1' } : null)) },
    users: { findById: vi.fn(async () => ({ id: 'u1' })) },
  } as unknown as Repositories;
  const closeTab = vi.fn(async () => {});
  const deps = {
    foreground: vi.fn(async () => 'busy' as const),
    capture: vi.fn(async () => PROMPT),
    isOnline: () => o.online ?? true,
    probe: vi.fn(async () => ({ reachable: o.reachable ?? true, sessions: new Set(o.sessions ?? tabs.map((t) => t.tmux_session)) })),
    room: () => o.room ?? null,
    closeTab,
    flags: vi.fn(async () => o.flags ?? { on: true, live: true }),
  };
  return { repos, deps, closeTab, tabGc };
}

const log = () => ({ info: vi.fn(), warn: vi.fn() });
const kinds = () => recordEvent.mock.calls.map((c) => (c[1] as { kind: string }).kind);
const payloadOf = (i = 0) => (recordEvent.mock.calls[i]![1] as { payload: Record<string, unknown> }).payload;

beforeEach(() => vi.clearAllMocks());

describe('runTabGc (TER-1171): grace period', () => {
  it('first warns a candidate, with when it closes, and does not close it yet', async () => {
    const { repos, deps, closeTab, tabGc } = setup([gcTab()]);
    const r = await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(r).toMatchObject({ warned: 1, collected: 0 });
    expect(r.items[0]).toMatchObject({ step: 'warn', reason: 'idle', rest_hours: 30, closes_at: new Date(NOW.getTime() + 30 * MIN).toISOString() });
    expect(tabGc.warn).toHaveBeenCalledWith('t1', NOW, new Date(at(30 * HOUR)));
    expect(closeTab).not.toHaveBeenCalled();
    expect(kinds()).toEqual(['tab_gc_warned']);
    expect(payloadOf()).toMatchObject({ tab_id: 't1', reason: 'idle', hours: 30, minutes: 30, dry_run: false });
  });

  it('waits while the grace period runs', async () => {
    const { repos, deps, closeTab } = setup([gcTab({ gc_warned_at: at(10 * MIN), gc_warned_state_at: at(30 * HOUR) })]);
    const r = await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(r.items[0]).toMatchObject({ step: 'warned', closes_at: new Date(NOW.getTime() + 20 * MIN).toISOString() });
    expect(closeTab).not.toHaveBeenCalled();
    expect(kinds()).toEqual([]);
  });

  it('collects once the grace period is over and nothing changed: archive with the last answer, close, event', async () => {
    const { repos, deps, closeTab, tabGc } = setup([gcTab({ gc_warned_at: at(31 * MIN), gc_warned_state_at: at(30 * HOUR), task: { id: 'c1', ref_number: 7, status: 'done' } })]);
    const r = await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(r).toMatchObject({ collected: 1 });
    expect(closeTab.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['t1']);
    expect(tabGc.archive).toHaveBeenCalledWith(expect.objectContaining({ tab_id: 't1', task_id: 'c1', reason: 'idle', last_answer: 'Pronto: PR aberto.', agent_session_id: 's1', cwd: '/w/x', machine_name: 'hulk' }));
    expect(kinds()).toEqual(['tab_collected']);
    expect(recordEvent.mock.calls[0]![1]).toMatchObject({ task_id: 'c1', payload: { archive_id: 'a1', dry_run: false, reason: 'idle' } });
  });

  it('drops the warning when the agent ran again during the grace period (tab reopened and used)', async () => {
    const { repos, deps, closeTab, tabGc } = setup([gcTab({ state: 'working', state_at: at(5 * MIN), gc_warned_at: at(20 * MIN), gc_warned_state_at: at(30 * HOUR) })]);
    const r = await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(r.items[0]).toMatchObject({ step: 'keep', reason: 'busy' });
    expect(tabGc.clearWarning).toHaveBeenCalledWith('t1');
    expect(closeTab).not.toHaveBeenCalled();
    expect(kinds()).toEqual(['tab_gc_kept']);
    expect(payloadOf()).toMatchObject({ why: 'activity' });
  });

  it('a warned tab pinned during the grace period is kept, and the feed says so', async () => {
    const { repos, deps, closeTab } = setup([gcTab({ gc_pinned: true, gc_warned_at: at(40 * MIN), gc_warned_state_at: at(30 * HOUR) })]);
    await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(closeTab).not.toHaveBeenCalled();
    expect(payloadOf()).toMatchObject({ why: 'pinned' });
  });

  it('is idempotent: a pass that loses the race to warn (the other colour) records nothing', async () => {
    const { repos, deps } = setup([gcTab()], { warn: false });
    const r = await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(r.items[0]!.step).toBe('warned');
    expect(kinds()).toEqual([]);
  });

  it('uses the configured grace period', async () => {
    const { repos, deps, closeTab } = setup([gcTab({ gc_warned_at: at(40 * MIN), gc_warned_state_at: at(30 * HOUR) })], { userLevel: { grace_minutes: 60 } });
    await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(closeTab).not.toHaveBeenCalled();
  });
});

describe('runTabGc (TER-1171): what is never closed', () => {
  it('keeps a tab whose automatic run is active, and one not at its prompt', async () => {
    const a = setup([gcTab()], { activeRun: true });
    expect((await runTabGc(a.repos, log() as never, { mode: 'live', now: NOW }, a.deps)).items[0]).toMatchObject({ step: 'keep', reason: 'run_active' });
    const b = setup([gcTab()]);
    b.deps.capture.mockResolvedValue('● Rodando\n\n✢ Catapulting… (14s · ↓ 145 tokens)\n\n────────────\n❯ \n────────────');
    expect((await runTabGc(b.repos, log() as never, { mode: 'live', now: NOW }, b.deps)).items[0]).toMatchObject({ step: 'keep', reason: 'not_quiet' });
    expect(kinds()).toEqual([]);
  });

  it('finished with its card in doing: kept', async () => {
    const { repos, deps } = setup([gcTab({ task: { id: 'c1', ref_number: 7, status: 'doing' }, state_at: at(300 * HOUR) })]);
    expect((await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps)).items[0]).toMatchObject({ step: 'keep', reason: 'card_in_progress' });
  });

  it('touches nothing on an offline machine, not even a tab whose session it cannot see', async () => {
    const { repos, deps, closeTab } = setup([gcTab({ state_at: at(300 * HOUR) })], { online: false, sessions: [] });
    const r = await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(r.items[0]).toMatchObject({ step: 'keep', reason: 'machine_offline' });
    expect(deps.probe).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('an unreachable ssh machine (probe failed) is left alone', async () => {
    const { repos, deps, closeTab } = setup([gcTab()], { machine: { type: 'ssh' }, reachable: false, sessions: [] });
    expect((await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps)).items[0]!.reason).toBe('machine_offline');
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('off at any level: kept (and an old warning goes)', async () => {
    const { repos, deps, tabGc } = setup([gcTab({ gc_warned_at: at(40 * MIN), gc_warned_state_at: at(30 * HOUR) })], { projectLevel: { enabled: false } });
    expect((await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps)).items[0]).toMatchObject({ step: 'keep', reason: 'disabled' });
    expect(tabGc.clearWarning).toHaveBeenCalled();
  });

  it('owners with the tab_gc flag off are skipped entirely', async () => {
    const { repos, deps, closeTab } = setup([gcTab()], { flags: { on: false, live: false } });
    const r = await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(r.items).toEqual([]);
    expect(deps.probe).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
  });
});

describe('runTabGc (TER-1171): session gone', () => {
  it('removes at once, without a warning, keeping the archive', async () => {
    const { repos, deps, closeTab, tabGc } = setup([gcTab({ state: 'working', state_at: at(MIN) })], { sessions: [] });
    const r = await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(r).toMatchObject({ removed: 1 });
    expect(closeTab).toHaveBeenCalled();
    expect(tabGc.archive).toHaveBeenCalledWith(expect.objectContaining({ reason: 'session_gone' }));
    expect(payloadOf()).toMatchObject({ reason: 'session_gone', dry_run: false });
  });

  it('in dry run is reported once per X, then quiet', async () => {
    const a = setup([gcTab()], { sessions: [], flags: { on: true, live: false } });
    await runTabGc(a.repos, log() as never, { mode: 'live', now: NOW }, a.deps);
    expect(a.closeTab).not.toHaveBeenCalled();
    expect(a.tabGc.reset).toHaveBeenCalledWith('t1', NOW);
    expect(payloadOf()).toMatchObject({ reason: 'session_gone', dry_run: true });
    const b = setup([gcTab({ gc_reset_at: at(HOUR) })], { sessions: [], flags: { on: true, live: false } });
    await runTabGc(b.repos, log() as never, { mode: 'live', now: NOW }, b.deps);
    expect(kinds()).toEqual([]);
  });
});

describe('runTabGc (TER-1171): dry run (tab_gc on, tab_gc_live off)', () => {
  it('marks nothing and closes nothing; records one would-be collection and restarts the clock', async () => {
    const { repos, deps, closeTab, tabGc } = setup([gcTab()], { flags: { on: true, live: false } });
    const r = await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(r.mode).toBe('live');
    expect(r.items[0]).toMatchObject({ step: 'collect', reason: 'idle' });
    expect(tabGc.warn).not.toHaveBeenCalled();
    expect(tabGc.archive).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
    expect(tabGc.reset).toHaveBeenCalledWith('t1', NOW);
    expect(kinds()).toEqual(['tab_collected']);
    expect(payloadOf()).toMatchObject({ dry_run: true, archive_id: null });
  });
});

describe('runTabGc (TER-1171): plan (list_gc_candidates, run_gc dry_run)', () => {
  it('writes nothing at all', async () => {
    const { repos, deps, closeTab, tabGc } = setup([gcTab(), gcTab({ id: 't2', tmux_session: 'th-t2', gc_warned_at: at(40 * MIN), gc_warned_state_at: at(30 * HOUR) }), gcTab({ id: 't3', tmux_session: 'th-gone' })], { sessions: ['th-t1', 'th-t2'], flags: { on: false, live: false } });
    const r = await runTabGc(repos, log() as never, { mode: 'plan', now: NOW }, deps);
    expect(r.items.map((i) => [i.tab_id, i.step])).toEqual([['t1', 'warn'], ['t2', 'collect'], ['t3', 'remove']]);
    expect(deps.flags).not.toHaveBeenCalled();
    for (const fn of [tabGc.warn, tabGc.clearWarning, tabGc.reset, tabGc.archive, closeTab]) expect(fn).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

describe('runTabGc (TER-1171): pressure', () => {
  it('over the machine cap, warns idle tabs from 2 h, at most 3 per pass, oldest first', async () => {
    const tabs = [1, 2, 3, 4].map((n) => gcTab({ id: `t${n}`, tmux_session: `th-t${n}`, state_at: at((10 - n) * HOUR), last_event_at: at((10 - n) * HOUR) }));
    const { repos, deps } = setup(tabs, { machineLevel: { max_agent_tabs: 2 }, machineTabs: 5 });
    const r = await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps);
    expect(r.items.map((i) => [i.tab_id, i.step, i.reason])).toEqual([
      ['t1', 'warn', 'over_cap'],
      ['t2', 'warn', 'over_cap'],
      ['t3', 'warn', 'over_cap'],
      ['t4', 'keep', 'recent'],
    ]);
  });

  it('no cap by default: many tabs on a machine are not collected early', async () => {
    const { repos, deps } = setup([gcTab({ state_at: at(5 * HOUR), last_event_at: at(5 * HOUR) })], { machineTabs: 80 });
    expect((await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps)).items[0]).toMatchObject({ step: 'keep', reason: 'recent' });
  });

  it('a machine short of room (TER-1138) collects early too', async () => {
    const room = { ok: false, limit: 'memory', at: at(MIN) } as unknown as RoomReading;
    const { repos, deps } = setup([gcTab({ state_at: at(3 * HOUR), last_event_at: at(3 * HOUR) })], { room });
    expect((await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps)).items[0]).toMatchObject({ step: 'warn', reason: 'no_room' });
  });

  it("follows the machine's TER-1138 hours as its X", async () => {
    const { repos, deps } = setup([gcTab({ state_at: at(7 * HOUR), last_event_at: at(7 * HOUR) })], { idleHours: 6 });
    expect((await runTabGc(repos, log() as never, { mode: 'live', now: NOW }, deps)).items[0]).toMatchObject({ step: 'warn', reason: 'idle' });
  });
});
