import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import type { RoomReading } from '../automation/machine-room.js';

const recordEvent = vi.fn(async () => {});
vi.mock('../automation/events.js', () => ({ recordEvent: (...a: unknown[]) => recordEvent(...(a as [])) }));
vi.mock('../control/terminals.js', () => ({ closeTab: vi.fn() }));
vi.mock('../chat/agent-exited.js', () => ({ AGENT_EXITED_TEXT: 'Agente encerrado sem terminar o turno' }));

const { IDLE_TAB_CLOSE_MIN_HOURS, NO_ROOM_CLOSE_PER_SWEEP, sweepIdleTabs } = await import('./idle-tabs.js');

const HOUR = 60 * 60_000;
const NOW = new Date('2026-10-28T12:00:00Z');
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();
const tab = (over: Partial<Tab> = {}): Tab =>
  ({ id: 't1', project_id: 'p1', machine_id: 'm1', name: 'aba', kind: 'terminal', tmux_session: 'th-t1', state: 'finished', state_tool: 'claude', state_text: null, state_at: ago(30), rate_limited_at: null, agent_session_id: 's1', ...over }) as Tab;
const machine = (over: Partial<Machine> = {}): Machine => ({ id: 'm1', name: 'hulk', owner_id: 'u1', type: 'agent', idle_tab_close_hours: 24, ...over }) as Machine;
const log = () => ({ info: vi.fn(), warn: vi.fn() });

const PROMPT = '● Pronto.\n\n✻ Brewed for 3s\n\n────────────\n❯ \n────────────';
const BUSY = '● Rodando\n\n✢ Catapulting… (14s · ↓ 145 tokens)\n\n────────────\n❯ \n────────────';

interface Opts {
  machine?: Machine;
  pane?: 'shell' | 'busy' | 'dead' | null;
  screen?: string;
  online?: boolean;
  activeRun?: boolean;
  answer?: { text: string; stale: boolean } | null;
  lastEvent?: string | null;
  room?: RoomReading | null;
}

function setup(tabs: Tab[], o: Opts = {}) {
  recordEvent.mockClear();
  const repos = {
    tabs: {
      listIdleOnClosingMachines: vi.fn(async () => tabs),
      readLastAnswer: vi.fn(async () => (o.answer === undefined ? { text: 'Pronto: PR aberto.', at: ago(30), tool: 'claude', stale: false } : o.answer && { at: ago(30), tool: 'claude', ...o.answer })),
      listEvents: vi.fn(async () => (o.lastEvent === null ? [] : [{ meta: { event: o.lastEvent ?? 'Stop' } }])),
    },
    machines: { findById: vi.fn(async () => o.machine ?? machine()) },
    automationRuns: { activeByTab: vi.fn(async () => (o.activeRun ? { id: 'r1' } : null)) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    users: { findById: vi.fn(async () => ({ id: 'u1' })) },
  } as unknown as Repositories;
  const closeTab = vi.fn(async () => {});
  const deps = {
    foreground: vi.fn(async () => (o.pane === undefined ? 'busy' : o.pane)),
    capture: vi.fn(async () => o.screen ?? PROMPT),
    isOnline: () => o.online ?? true,
    room: () => o.room ?? null,
    closeTab,
  };
  return { repos, deps, closeTab };
}

const closedIds = (closeTab: ReturnType<typeof vi.fn>) => closeTab.mock.calls.map((c) => c[1]);

describe('sweepIdleTabs (TER-1138)', () => {
  it('asks only for tabs at rest for at least the shortest setting', async () => {
    const { repos, deps } = setup([]);
    await sweepIdleTabs(repos, log() as never, NOW, deps);
    expect(repos.tabs.listIdleOnClosingMachines).toHaveBeenCalledWith(new Date(NOW.getTime() - IDLE_TAB_CLOSE_MIN_HOURS * HOUR));
  });

  it('closes a finished or idle Claude tab at its prompt past the machine setting, and records it in the feed', async () => {
    const { repos, deps, closeTab } = setup([tab(), tab({ id: 't2', state: 'idle' })]);
    const l = log();
    expect(await sweepIdleTabs(repos, l as never, NOW, deps)).toEqual({ closed: 2 });
    expect(closedIds(closeTab)).toEqual(['t1', 't2']);
    expect(recordEvent).toHaveBeenCalledWith(repos, {
      project_id: 'p1',
      kind: 'tab_auto_closed',
      payload: { tab_id: 't1', tab: 'aba', machine_id: 'm1', machine: 'hulk', tool: 'claude', state: 'finished', reason: 'idle', hours: 30, session_id: 's1' },
    });
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', machineId: 'm1', state: 'finished', tool: 'claude', reason: 'idle', hours: 30 }, 'monitor: idle tab closed');
  });

  it('keeps a tab younger than the setting', async () => {
    const { repos, deps, closeTab } = setup([tab({ state_at: ago(23) })]);
    await sweepIdleTabs(repos, log() as never, NOW, deps);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('every CLI: Codex, Cursor and Gemini tabs close on their last hook being a turn end, not a session end', async () => {
    for (const tool of ['codex', 'cursor', 'gemini']) {
      const { repos, deps, closeTab } = setup([tab({ state_tool: tool })]);
      await sweepIdleTabs(repos, log() as never, NOW, deps);
      expect(closedIds(closeTab)).toEqual(['t1']);
      expect(deps.capture).not.toHaveBeenCalled();
      const ended = setup([tab({ state_tool: tool })], { lastEvent: 'SessionEnd' });
      await sweepIdleTabs(ended.repos, log() as never, NOW, ended.deps);
      expect(ended.closeTab).not.toHaveBeenCalled();
    }
  });

  describe('never closes', () => {
    it('a tab working, waiting on a permission, blocked, logged out, on the trust dialog or on background work', async () => {
      for (const state of ['working', 'waiting_permission', 'blocked', 'auth_required', 'trust_prompt', 'waiting_background', 'error'] as const) {
        const { repos, deps, closeTab } = setup([tab({ state, state_at: ago(500) })]);
        await sweepIdleTabs(repos, log() as never, NOW, deps);
        expect(closeTab, state).not.toHaveBeenCalled();
      }
    });

    it('a real question: waiting for input whose last answer asks something, or none', async () => {
      for (const answer of [{ text: 'Qual banco você prefere, Postgres ou MySQL?', stale: false }, null, { text: 'Pronto.', stale: true }]) {
        const { repos, deps, closeTab } = setup([tab({ state: 'waiting_input', state_at: ago(500) })], { answer });
        await sweepIdleTabs(repos, log() as never, NOW, deps);
        expect(closeTab).not.toHaveBeenCalled();
      }
    });

    it('a tab with an active automatic run, or stopped on a usage limit', async () => {
      const run = setup([tab()], { activeRun: true });
      await sweepIdleTabs(run.repos, log() as never, NOW, run.deps);
      expect(run.closeTab).not.toHaveBeenCalled();
      const limited = setup([tab({ rate_limited_at: ago(30) })]);
      await sweepIdleTabs(limited.repos, log() as never, NOW, limited.deps);
      expect(limited.closeTab).not.toHaveBeenCalled();
    });

    it('a build or server in front: after the agent left, or a Claude tab whose screen is not its prompt', async () => {
      const exited = setup([tab({ state: 'idle', state_text: 'Agente encerrado sem terminar o turno' })], { pane: 'busy' });
      await sweepIdleTabs(exited.repos, log() as never, NOW, exited.deps);
      expect(exited.closeTab).not.toHaveBeenCalled();
      for (const screen of [BUSY, 'npm run dev\n  ready on http://localhost:3000']) {
        const other = setup([tab()], { screen });
        await sweepIdleTabs(other.repos, log() as never, NOW, other.deps);
        expect(other.closeTab).not.toHaveBeenCalled();
      }
      const unknown = setup([tab()], { pane: null });
      await sweepIdleTabs(unknown.repos, log() as never, NOW, unknown.deps);
      expect(unknown.closeTab).not.toHaveBeenCalled();
    });

    it('a tab of a machine that is offline or turned the setting off', async () => {
      const off = setup([tab()], { online: false });
      await sweepIdleTabs(off.repos, log() as never, NOW, off.deps);
      expect(off.closeTab).not.toHaveBeenCalled();
      const unset = setup([tab()], { machine: machine({ idle_tab_close_hours: null }) });
      await sweepIdleTabs(unset.repos, log() as never, NOW, unset.deps);
      expect(unset.closeTab).not.toHaveBeenCalled();
    });
  });

  it('the agent gone and the shell back at its prompt (or a dead pane): closed, nothing runs there', async () => {
    for (const pane of ['shell', 'dead'] as const) {
      const { repos, deps, closeTab } = setup([tab({ state: 'idle', state_text: 'Agente encerrado sem terminar o turno' })], { pane });
      await sweepIdleTabs(repos, log() as never, NOW, deps);
      expect(closedIds(closeTab)).toEqual(['t1']);
    }
  });

  it('a tab waiting for input with a report closes after three times the setting', async () => {
    const young = setup([tab({ state: 'waiting_input', state_at: ago(71) })]);
    await sweepIdleTabs(young.repos, log() as never, NOW, young.deps);
    expect(young.closeTab).not.toHaveBeenCalled();
    const old = setup([tab({ state: 'waiting_input', state_at: ago(72) })]);
    await sweepIdleTabs(old.repos, log() as never, NOW, old.deps);
    expect(closedIds(old.closeTab)).toEqual(['t1']);
  });

  describe('a machine without room', () => {
    const room = (over: Partial<RoomReading> = {}): RoomReading => ({ ok: false, limit: 'memory', mem_available_kb: 2 * 1024 * 1024, disk_free_kb: null, disk_mount: null, load1: 1, ncpu: 8, at: ago(0.1), ...over });
    const tabs = [3, 4, 5, 6, 7].map((h, i) => tab({ id: `t${i}`, state_at: ago(10 - i) })).concat(tab({ id: 'young', state_at: ago(1) }));

    it('closes the oldest tabs at rest before their time, a few per sweep, saying why', async () => {
      const { repos, deps, closeTab } = setup(tabs, { room: room() });
      await sweepIdleTabs(repos, log() as never, NOW, deps);
      expect(closedIds(closeTab)).toEqual(['t0', 't1', 't2']);
      expect(closeTab).toHaveBeenCalledTimes(NO_ROOM_CLOSE_PER_SWEEP);
      expect(recordEvent).toHaveBeenCalledWith(repos, expect.objectContaining({ payload: expect.objectContaining({ tab_id: 't0', reason: 'no_room', hours: 10 }) }));
    });

    it('a tab past its time still closes as idle, and does not use a no-room slot', async () => {
      const { repos, deps, closeTab } = setup([tab({ id: 'old', state_at: ago(30) }), ...tabs], { room: room({ limit: 'load' }) });
      await sweepIdleTabs(repos, log() as never, NOW, deps);
      expect(closedIds(closeTab)).toEqual(['old', 't0', 't1', 't2']);
    });

    it('not for a full disk (closing tabs frees no disk), a stale reading, or a machine with room', async () => {
      for (const r of [room({ limit: 'disk' }), room({ at: ago(1) }), room({ ok: true, limit: null })]) {
        const { repos, deps, closeTab } = setup(tabs, { room: r });
        await sweepIdleTabs(repos, log() as never, NOW, deps);
        expect(closeTab).not.toHaveBeenCalled();
      }
    });
  });

  it('one failing tab does not stop the sweep', async () => {
    const { repos, deps, closeTab } = setup([tab({ id: 'bad' }), tab({ id: 'ok' })]);
    closeTab.mockImplementationOnce(async () => {
      throw Object.assign(new Error('x'), { code: 'MACHINE_FAILED' });
    });
    const l = log();
    expect(await sweepIdleTabs(repos, l as never, NOW, deps)).toEqual({ closed: 1 });
    expect(l.warn).toHaveBeenCalledWith({ tabId: 'bad', code: 'MACHINE_FAILED' }, 'monitor: idle tab check failed');
  });
});
